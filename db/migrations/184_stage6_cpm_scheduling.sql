-- STAGE 6 — CPM SCHEDULING: the deterministic pass over the union graph
-- (docs/hierarchical-workflow-model.md §7.2, stage 6 of the serial rollout).
--
-- On top of the stage-1 graph (plan/plan_version/work_node/dependency, union_edge,
-- detect_cycles), the stage-3 durability plane (run/execution), and the stage-5 entity/lease
-- plane, this migration delivers the SCHEDULING pass: a forward/backward CPM over
-- union_edge that returns earliest/latest start/finish + slack + critical path for LEAVES
-- (atoms), with containers reporting their SUBTREE SPAN. Calendars (165's calendar table,
-- inherited via wn_effective_policy) are honoured when a node carries one.
--
-- DESIGN OF RECORD: docs/hierarchical-workflow-schema.sql §7.2 (two phases, kept separate)
-- and the invariant summary ("critical path runs through leaves and ignores the hierarchy;
-- containers report the span of their subtree, not a path role"). Departures are stage
-- boundaries or ZEEHIVE welds, named below:
--
--   • union_edge gains a `type` column (text: FS/SS/FF/SF). The view's expanded edges carry
--     their link type so the CPM pass can interpret `lag` correctly — an FS edge constrains
--     the successor's START from the predecessor's FINISH, an SS edge constrains START from
--     START, etc. sequence/data edges are finish-to-start. This is ADDITIVE: every existing
--     consumer (detect_cycles, the stage-1 suite) selects named columns and is untouched.
--
--   • The CPM pass is a READ model: `wn_cpm(p_version, p_start)` computes and RETURNS the
--     schedule. It NEVER writes work_node.earliest_*/latest_*/slack — those columns stay
--     inert, and no agent stores the pass back onto the plan (constraint, not style).
--
--   • Phase 2 (resource levelling) is OUT OF SCOPE by design. Any levelled output must be
--     labelled "feasible", never "optimal" — RCPSP is NP-hard, and the honest label is part
--     of the deliverable (design §7.2).
--
--   • The backward pass anchors at max(earliest_finish): the "project finish" is the latest
--     of the unconstrained earliest finishes. A caller that wants a deadline-anchored
--     schedule passes the deadline as p_start's offset — the DDL's `deadline` column is a
--     separate concern (a constraint, not the CPM's anchor).
--
--   • Calendars: wn_calendar_working_end / wn_calendar_working_start advance/subtract a
--     working-time duration across a calendar's working_hours (Mon-Fri 9-5 in the common
--     case). Cross-midnight windows (from > to) are NOT supported and the functions fall
--     back to continuous time for them; a window list is assumed to be per-day non-wrapping.
--     A node with no calendar (or a calendar with no windows) schedules in continuous time.
--
-- FORWARD-ONLY: every object is created idempotently (CREATE OR REPLACE). A second migrate
-- pass is a clean no-op. The DOWN thinking (never run in prod): DROP FUNCTION wn_cpm,
-- wn_calendar_working_start, wn_calendar_working_end, then restore the union_edge view from
-- migration 174 (the type column is additive and dropped with the view).

-- ── union_edge carries its link TYPE so the CPM pass can interpret lag ──────────
CREATE OR REPLACE VIEW union_edge AS
    -- (1) sibling order under 'sequence' — finish-to-start, no lag
    SELECT p.plan_version_id,
           lf.id  AS from_id,
           ff.id  AS to_id,
           'sequence'::text AS origin,
           '0'::interval    AS lag,
           'FS'::text       AS type
    FROM work_node p
    JOIN work_node a ON a.parent_id = p.id
    JOIN LATERAL (
        SELECT b.id, b.sibling_rank FROM work_node b
        WHERE b.parent_id = p.id AND b.sibling_rank > a.sibling_rank
        ORDER BY b.sibling_rank LIMIT 1
    ) nxt ON true
    CROSS JOIN LATERAL wn_last_leaves(a.id)  lf
    CROSS JOIN LATERAL wn_first_leaves(nxt.id) ff
    WHERE p.child_semantics = 'sequence'

    UNION ALL

    -- (2) explicit dependency rows, expanded per link type — the type rides along
    SELECT w.plan_version_id, e.from_leaf, e.to_leaf, 'dependency', d.lag, d.type::text
    FROM dependency d
    JOIN work_node w ON w.id = d.from_id
    CROSS JOIN LATERAL (
        SELECT lf.id AS from_leaf, tf.id AS to_leaf
        FROM (SELECT id FROM wn_last_leaves(d.from_id)  WHERE d.type IN ('FS','FF')
              UNION ALL
              SELECT id FROM wn_first_leaves(d.from_id) WHERE d.type IN ('SS','SF')) lf
        CROSS JOIN
             (SELECT id FROM wn_first_leaves(d.to_id) WHERE d.type IN ('FS','SS')
              UNION ALL
              SELECT id FROM wn_last_leaves(d.to_id)  WHERE d.type IN ('FF','SF')) tf
    ) e;
    -- (3) I14: every data edge implies precedence — lands with STAGE 2 (port/data_edge).
    --      Not referenced here: the tables do not exist until stage 2, and a view that
    --      names a missing table fails to build. When stage 2 lands it adds this branch
    --      (finish-to-start, no lag, type 'FS') to the same view.


-- ── calendar arithmetic ──────────────────────────────────────────────────────────
-- Advance a WORKING-TIME duration from p_start across a calendar's working_hours.
-- Returns p_start + duration in continuous time when there is no usable calendar
-- (NULL id, no row, empty window list, or a cross-midnight window). Working windows are
-- per-day non-wrapping: [{dow, from, to}] with from < to. dow follows Postgres
-- EXTRACT(DOW): 0=Sunday … 6=Saturday.
CREATE OR REPLACE FUNCTION wn_calendar_working_end(p_calendar uuid, p_start timestamptz, p_duration interval)
RETURNS timestamptz
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_cal record;
    v_remaining interval;
    v_t timestamptz;
    v_local timestamp;
    v_day date;
    v_windows jsonb;
    v_win jsonb;
    v_dow int;
    v_frm time; v_to time;
    v_ws timestamptz; v_we timestamptz;
    v_avail interval;
    v_holidays date[];
BEGIN
    IF p_calendar IS NULL OR p_duration IS NULL OR p_duration <= '0'::interval THEN
        RETURN p_start + COALESCE(p_duration, '0'::interval);
    END IF;
    SELECT * INTO v_cal FROM calendar WHERE id = p_calendar;
    IF v_cal IS NULL OR v_cal.working_hours IS NULL OR jsonb_array_length(v_cal.working_hours) = 0 THEN
        RETURN p_start + p_duration;
    END IF;
    v_windows := v_cal.working_hours;
    v_holidays := v_cal.holidays;
    v_remaining := p_duration;
    v_t := p_start;

    WHILE v_remaining > '0'::interval LOOP
        v_local := v_t AT TIME ZONE v_cal.timezone;
        v_day := v_local::date;
        v_dow := EXTRACT(DOW FROM v_local)::int;

        IF NOT (v_day = ANY(v_holidays)) THEN
            FOR v_win IN SELECT * FROM jsonb_array_elements(v_windows) LOOP
                IF (v_win->>'dow')::int <> v_dow THEN CONTINUE; END IF;
                v_frm := (v_win->>'from')::time;
                v_to  := (v_win->>'to')::time;
                v_ws := (v_day + v_frm) AT TIME ZONE v_cal.timezone;
                v_we := (v_day + v_to)  AT TIME ZONE v_cal.timezone;
                IF v_t < v_ws THEN v_t := v_ws; END IF;
                IF v_t >= v_we THEN CONTINUE; END IF;
                v_avail := v_we - v_t;
                IF v_avail >= v_remaining THEN
                    RETURN v_t + v_remaining;
                END IF;
                v_remaining := v_remaining - v_avail;
                v_t := v_we;
            END LOOP;
        END IF;

        -- move to the next day's first instant; its window clamps up to the window start
        v_t := (v_day + interval '1 day') AT TIME ZONE v_cal.timezone;
    END LOOP;
    RETURN v_t;
END;
$$;

-- The backward twin: the start time S such that working-duration(S → p_end) = p_duration.
-- Symmetric to wn_calendar_working_end; walks backwards through the same windows.
CREATE OR REPLACE FUNCTION wn_calendar_working_start(p_calendar uuid, p_end timestamptz, p_duration interval)
RETURNS timestamptz
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_cal record;
    v_remaining interval;
    v_t timestamptz;
    v_local timestamp;
    v_day date;
    v_windows jsonb;
    v_win jsonb;
    v_dow int;
    v_frm time; v_to time;
    v_ws timestamptz; v_we timestamptz;
    v_avail interval;
    v_holidays date[];
BEGIN
    IF p_calendar IS NULL OR p_duration IS NULL OR p_duration <= '0'::interval THEN
        RETURN p_end - COALESCE(p_duration, '0'::interval);
    END IF;
    SELECT * INTO v_cal FROM calendar WHERE id = p_calendar;
    IF v_cal IS NULL OR v_cal.working_hours IS NULL OR jsonb_array_length(v_cal.working_hours) = 0 THEN
        RETURN p_end - p_duration;
    END IF;
    v_windows := v_cal.working_hours;
    v_holidays := v_cal.holidays;
    v_remaining := p_duration;
    v_t := p_end;

    WHILE v_remaining > '0'::interval LOOP
        v_local := v_t AT TIME ZONE v_cal.timezone;
        v_day := v_local::date;
        v_dow := EXTRACT(DOW FROM v_local)::int;

        IF NOT (v_day = ANY(v_holidays)) THEN
            FOR v_win IN SELECT * FROM jsonb_array_elements(v_windows) LOOP
                IF (v_win->>'dow')::int <> v_dow THEN CONTINUE; END IF;
                v_frm := (v_win->>'from')::time;
                v_to  := (v_win->>'to')::time;
                v_ws := (v_day + v_frm) AT TIME ZONE v_cal.timezone;
                v_we := (v_day + v_to)  AT TIME ZONE v_cal.timezone;
                IF v_t > v_we THEN v_t := v_we; END IF;
                IF v_t <= v_ws THEN CONTINUE; END IF;
                v_avail := v_t - v_ws;
                IF v_avail >= v_remaining THEN
                    RETURN v_t - v_remaining;
                END IF;
                v_remaining := v_remaining - v_avail;
                v_t := v_ws;
            END LOOP;
        END IF;

        -- move to the previous day's final instant; its window clamps down to the window end
        v_t := ((v_day - 1)::timestamp + interval '23:59:59.999999') AT TIME ZONE v_cal.timezone;
    END LOOP;
    RETURN v_t;
END;
$$;


-- ── THE CPM PASS ─────────────────────────────────────────────────────────────────
-- Forward/backward pass over union_edge for one plan_version. Returns one row per
-- ATOM (leaf, or loop/map container whose body is contracted) with the full
-- earliest/latest/slack/critical schedule, plus one row per CONTAINER reporting its
-- SUBTREE SPAN (min earliest_start … max earliest_finish over the subtree's leaves,
-- and the matching latest bounds) and whether any leaf in the subtree is critical.
--
--   p_start — the project-start anchor for the forward pass (defaults to now()).
--
-- Never stores anything back onto work_node: this is the deterministic READ model.
CREATE OR REPLACE FUNCTION wn_cpm(p_version uuid, p_start timestamptz DEFAULT NULL)
RETURNS TABLE (
    node_id uuid, name text, kind node_kind, is_atom boolean, parent_id uuid,
    duration interval,
    earliest_start timestamptz, earliest_finish timestamptz,
    latest_start timestamptz, latest_finish timestamptz,
    slack interval, critical boolean
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_start timestamptz := COALESCE(p_start, now());
    v_atoms uuid[]; v_n int; v_i int; v_j int; v_k int;
    v_dur interval[];
    v_es timestamptz[]; v_ef timestamptz[];
    v_ls timestamptz[]; v_lf timestamptz[];
    v_indeg int[]; v_q int[]; v_top uuid[];
    v_qh int := 1; v_qt int := 0;
    v_edge record; v_node record; v_leaf record;
    v_proj_finish timestamptz;
    v_cal uuid;
    v_smin timestamptz; v_smax timestamptz;
    v_lmin timestamptz; v_lmax timestamptz;
    v_crit boolean;
BEGIN
    SELECT array_agg(w.id ORDER BY w.id)
      INTO v_atoms
      FROM work_node w
     WHERE w.plan_version_id = p_version AND wn_is_atom(w.id);
    IF v_atoms IS NULL OR array_length(v_atoms, 1) = 0 THEN RETURN; END IF;
    v_n := array_length(v_atoms, 1);

    FOR v_i IN 1..v_n LOOP
        v_dur[v_i] := wn_duration(v_atoms[v_i]);
        v_indeg[v_i] := 0;
    END LOOP;

    -- indegree over the union graph (atoms only; edges between atoms are all that matter)
    FOR v_edge IN SELECT ue.from_id, ue.to_id FROM union_edge ue WHERE ue.plan_version_id = p_version LOOP
        v_j := array_position(v_atoms, v_edge.to_id);
        IF v_j IS NOT NULL THEN v_indeg[v_j] := v_indeg[v_j] + 1; END IF;
    END LOOP;

    -- Kahn's algorithm for the topological order
    v_q := ARRAY[]::int[];
    FOR v_i IN 1..v_n LOOP
        IF v_indeg[v_i] = 0 THEN v_qt := v_qt + 1; v_q[v_qt] := v_i; END IF;
    END LOOP;
    v_top := ARRAY[]::uuid[];
    WHILE v_qh <= v_qt LOOP
        v_i := v_q[v_qh]; v_qh := v_qh + 1;
        v_top := array_append(v_top, v_atoms[v_i]);
        FOR v_edge IN SELECT ue.from_id, ue.to_id
                        FROM union_edge ue WHERE ue.plan_version_id = p_version AND ue.from_id = v_atoms[v_i] LOOP
            v_j := array_position(v_atoms, v_edge.to_id);
            IF v_j IS NOT NULL THEN
                v_indeg[v_j] := v_indeg[v_j] - 1;
                IF v_indeg[v_j] = 0 THEN v_qt := v_qt + 1; v_q[v_qt] := v_j; END IF;
            END IF;
        END LOOP;
    END LOOP;
    IF array_length(v_top, 1) < v_n THEN
        RAISE EXCEPTION 'wn_cpm: cycle in union graph for version %', p_version;
    END IF;

    -- FORWARD PASS — earliest start/finish, in topological order. A node's earliest start
    -- is the max over its predecessors (finish+lag for FS/FF, start+lag for SS/SF), at
    -- least the project start; its earliest finish adds its duration, spread across its
    -- effective calendar when it has one.
    FOR v_k IN 1..v_n LOOP
        v_i := array_position(v_atoms, v_top[v_k]);
        SELECT (wn_effective_policy(v_atoms[v_i])).calendar_id INTO v_cal;
        v_es[v_i] := v_start;
        FOR v_edge IN SELECT ue.from_id, ue.to_id, ue.type, ue.lag
                        FROM union_edge ue WHERE ue.plan_version_id = p_version AND ue.to_id = v_atoms[v_i] LOOP
            v_j := array_position(v_atoms, v_edge.from_id);
            IF v_j IS NOT NULL THEN
                IF v_edge.type IN ('FS','FF') THEN
                    IF v_ef[v_j] + v_edge.lag > v_es[v_i] THEN v_es[v_i] := v_ef[v_j] + v_edge.lag; END IF;
                ELSE
                    IF v_es[v_j] + v_edge.lag > v_es[v_i] THEN v_es[v_i] := v_es[v_j] + v_edge.lag; END IF;
                END IF;
            END IF;
        END LOOP;
        v_ef[v_i] := wn_calendar_working_end(v_cal, v_es[v_i], v_dur[v_i]);
    END LOOP;

    -- project finish = max earliest finish (unconstrained CPM; the "theoretical minimum")
    v_proj_finish := NULL;
    FOR v_i IN 1..v_n LOOP
        IF v_proj_finish IS NULL OR v_ef[v_i] > v_proj_finish THEN v_proj_finish := v_ef[v_i]; END IF;
    END LOOP;

    -- BACKWARD PASS — latest start/finish, in reverse topological order. A node's latest
    -- finish is the min over its successors (start-lag for FS/SS, finish-lag for FF/SF),
    -- at most the project finish; its latest start subtracts its duration.
    FOR v_k IN REVERSE v_n..1 LOOP
        v_i := array_position(v_atoms, v_top[v_k]);
        SELECT (wn_effective_policy(v_atoms[v_i])).calendar_id INTO v_cal;
        v_lf[v_i] := v_proj_finish;
        FOR v_edge IN SELECT ue.from_id, ue.to_id, ue.type, ue.lag
                        FROM union_edge ue WHERE ue.plan_version_id = p_version AND ue.from_id = v_atoms[v_i] LOOP
            v_j := array_position(v_atoms, v_edge.to_id);
            IF v_j IS NOT NULL THEN
                IF v_edge.type IN ('FS','SS') THEN
                    IF v_ls[v_j] - v_edge.lag < v_lf[v_i] THEN v_lf[v_i] := v_ls[v_j] - v_edge.lag; END IF;
                ELSE
                    IF v_lf[v_j] - v_edge.lag < v_lf[v_i] THEN v_lf[v_i] := v_lf[v_j] - v_edge.lag; END IF;
                END IF;
            END IF;
        END LOOP;
        v_ls[v_i] := wn_calendar_working_start(v_cal, v_lf[v_i], v_dur[v_i]);
    END LOOP;

    -- emit ATOMS — the schedule proper (leaves only; the critical path runs through leaves)
    FOR v_i IN 1..v_n LOOP
        SELECT w.name, w.kind, w.parent_id INTO name, kind, parent_id FROM work_node w WHERE w.id = v_atoms[v_i];
        node_id := v_atoms[v_i]; is_atom := true; duration := v_dur[v_i];
        earliest_start := v_es[v_i]; earliest_finish := v_ef[v_i];
        latest_start := v_ls[v_i]; latest_finish := v_lf[v_i];
        slack := v_ls[v_i] - v_es[v_i]; critical := (v_ls[v_i] = v_es[v_i]);
        RETURN NEXT;
    END LOOP;

    -- emit CONTAINERS — the subtree span (containers report span, not a path role)
    FOR v_node IN SELECT w.id, w.name, w.kind, w.parent_id FROM work_node w
                   WHERE w.plan_version_id = p_version AND NOT wn_is_atom(w.id) LOOP
        node_id := v_node.id; name := v_node.name; kind := v_node.kind; parent_id := v_node.parent_id;
        is_atom := false; duration := wn_duration(v_node.id);
        v_smin := NULL; v_smax := NULL; v_lmin := NULL; v_lmax := NULL; v_crit := false;
        FOR v_leaf IN SELECT d.id FROM work_node d
                       WHERE d.plan_version_id = p_version AND wn_is_atom(d.id) AND wn_is_ancestor_of(v_node.id, d.id) LOOP
            v_i := array_position(v_atoms, v_leaf.id);
            IF v_i IS NOT NULL THEN
                IF v_smin IS NULL OR v_es[v_i] < v_smin THEN v_smin := v_es[v_i]; END IF;
                IF v_smax IS NULL OR v_ef[v_i] > v_smax THEN v_smax := v_ef[v_i]; END IF;
                IF v_lmin IS NULL OR v_ls[v_i] < v_lmin THEN v_lmin := v_ls[v_i]; END IF;
                IF v_lmax IS NULL OR v_lf[v_i] > v_lmax THEN v_lmax := v_lf[v_i]; END IF;
                IF v_ls[v_i] = v_es[v_i] THEN v_crit := true; END IF;
            END IF;
        END LOOP;
        earliest_start := v_smin; earliest_finish := v_smax;
        latest_start := v_lmin; latest_finish := v_lmax;
        slack := NULL; critical := v_crit;
        RETURN NEXT;
    END LOOP;
END;
$$;

-- DURATIONS FROM EVIDENCE — an unestimated node no longer silently means "zero".
--
-- WHY: the gantt draws nothing when every duration is NULL. Measured on the live meta-DB
-- after rehab 1/4 backfilled the real work items: work_node.estimate is NULL on all 514
-- nodes, work_item.estimate_hours / starts_on / due_on are NULL on all 514 items, and
-- wn_cpm therefore returns every node critical with ONE distinct slack value — the absence
-- of a schedule, not a critical path. The plumbing is correct; the duration source is empty.
--
-- WHERE DURATION NOW COMES FROM (per node, in order — the rule is stated here so a made-up
-- number is traceable):
--
--   1. the node's explicit estimate (work_node.estimate). A 0 estimate is treated as "no
--      estimate" — a zero-length bar is meaningless to schedule against.
--   2. the MEASURED ACTUAL from closed executions on that node — AVG(finished_at - started_at)
--      over executions with both timestamps. An item that took 4 hours last time is the best
--      duration estimate anyone has, and it is free. The AVG is per node, so re-runs are
--      averaged rather than letting one outlier win.
--   3. the HONEST DEFAULT: one day per unestimated ACTION. Containers never take the default —
--      they roll up from children (sequence Σ / parallel max), so an epic is the sum of its
--      parts, never a flat day. The constant is deliberately stated here and nowhere else:
--      when the fleet's measured actuals say a task is typically not a day, change THIS line.
--
-- This is NOT a re-optimisation of wn_cpm (that card is 189, done and shipped). The
-- algorithm — compressed adjacency, topo order, forward/backward passes, the bottom-up
-- container rollup — is byte-identical to 189. The only change is the DURATION SOURCE for
-- atoms: 189 loaded `COALESCE(estimate,'0')` into v_dur, which is exactly the degenerate
-- case this card exists to fix. The atom-duration load now adds a bulk AVG over closed
-- executions (one GROUP BY, still set-based — no per-atom loop) and a COALESCE to the
-- default. Nodes WITH an estimate schedule exactly as before; the golden CPM fixture (all
-- estimates set) is byte-identical.
--
-- FORWARD-ONLY: CREATE OR REPLACE. A second migrate pass is a clean no-op.

-- ── wn_duration: the single source of a node's scheduling duration ────────────────
CREATE OR REPLACE FUNCTION wn_duration(p_node uuid)
RETURNS interval
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_kind node_kind; v_sem child_semantics;
    v_est interval;
    v_actual interval;
    v_total interval := '0';
BEGIN
    SELECT kind, child_semantics, estimate
      INTO v_kind, v_sem, v_est
    FROM work_node WHERE id = p_node;

    IF v_kind <> 'container' THEN
        -- ATOM: explicit estimate wins; then the measured actual from closed executions;
        -- then the honest default (a task takes a day).
        IF v_est IS NOT NULL AND v_est > '0'::interval THEN RETURN v_est; END IF;
        SELECT AVG(e.finished_at - e.started_at) INTO v_actual
          FROM execution e
         WHERE e.work_node_id = p_node
           AND e.started_at IS NOT NULL AND e.finished_at IS NOT NULL
           AND e.finished_at > e.started_at;
        IF v_actual IS NOT NULL THEN RETURN v_actual; END IF;
        RETURN '1 day'::interval;
    END IF;

    -- CONTAINER: roll up from children (sequence Σ / parallel max; freeform = planning
    -- upper bound = max). Children's durations already include the atom fallback.
    IF v_sem = 'sequence' THEN
        SELECT COALESCE(sum(wn_duration(w.id)), '0') INTO v_total
        FROM work_node w WHERE w.parent_id = p_node;
    ELSIF v_sem = 'parallel' THEN
        SELECT COALESCE(max(wn_duration(w.id)), '0') INTO v_total
        FROM work_node w WHERE w.parent_id = p_node;
    ELSE  -- freeform: CPM longest path is computed by the scheduler, not here
        SELECT COALESCE(max(wn_duration(w.id)), '0') INTO v_total
        FROM work_node w WHERE w.parent_id = p_node;
    END IF;

    RETURN v_total;
END;
$$;

-- ── wn_cpm: 189's function, with the atom-duration source changed ─────────────────
-- Replicated in full (CREATE OR REPLACE cannot edit one line of a function). The three
-- changes, each marked `-- 194 --`:
--   (1) atom estimates load as NULLIF(estimate,'0')  — a 0 estimate is "no estimate";
--   (2) a NEW bulk AVG over closed executions, aligned to v_atoms (one GROUP BY, set-based);
--   (3) v_dur fills as COALESCE(estimate, actual, '1 day').
-- Everything else is migration 189 verbatim.
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
    v_indeg int[]; v_q int[]; v_top int[];
    v_qh int := 1; v_qt int := 0;
    v_proj_finish timestamptz;
    v_cal uuid;
    -- atom metadata loaded in ONE query (parallel to v_atoms, same ORDER BY w.id)
    v_atom_name text[]; v_atom_kind node_kind[]; v_atom_parent uuid[]; v_atom_est interval[];
    v_atom_actual interval[];                    -- 194 -- measured actuals (aligned to v_atoms)
    -- compressed adjacency (built ONCE from a single set-based union_edge scan):
    --   successors of atom i:  v_sto[v_soff[i] .. v_soff[i+1]-1]
    --   predecessors of atom i: v_pto[v_poff[i] .. v_poff[i+1]-1]
    v_esrc int[]; v_edst int[]; v_etype text[]; v_elag interval[];
    v_psrc int[]; v_pdst int[]; v_ptype text[]; v_plag interval[];
    v_soff int[]; v_poff int[];
    v_en int; v_cur int; v_m int;
    v_has_cal boolean;
    -- container rollup accumulators (parallel to v_cont_*, filled by one bottom-up pass)
    v_cont_ids uuid[]; v_cont_name text[]; v_cont_kind node_kind[]; v_cont_parent uuid[];
    v_csmin timestamptz[]; v_csmax timestamptz[]; v_clmin timestamptz[]; v_clmax timestamptz[];
    v_ccrit boolean[];
    v_nc int; v_ci int; v_cp int;
    v_cur_id uuid; v_par uuid;
    v_node record;
BEGIN
    SELECT array_agg(w.id ORDER BY w.id),
           array_agg(w.name ORDER BY w.id),
           array_agg(w.kind ORDER BY w.id),
           array_agg(w.parent_id ORDER BY w.id),
           array_agg(NULLIF(w.estimate, '0'::interval) ORDER BY w.id)   -- 194 -- 0 ⇒ no estimate
      INTO v_atoms, v_atom_name, v_atom_kind, v_atom_parent, v_atom_est
      FROM work_node w
     WHERE w.plan_version_id = p_version AND w.kind <> 'container';
    IF v_atoms IS NULL OR array_length(v_atoms, 1) = 0 THEN RETURN; END IF;
    v_n := array_length(v_atoms, 1);

    -- 194 -- measured actuals from closed executions, in the SAME order as v_atoms
    -- (unnest preserves array order; array_agg ORDER BY id re-sorts to the same order).
    SELECT array_agg(x.actual ORDER BY x.id) INTO v_atom_actual
      FROM (
        SELECT w.id, e.actual
          FROM unnest(v_atoms) w(id)
          LEFT JOIN (
            SELECT e.work_node_id, AVG(e.finished_at - e.started_at) AS actual
              FROM execution e
             WHERE e.work_node_id = ANY(v_atoms)
               AND e.started_at IS NOT NULL AND e.finished_at IS NOT NULL
               AND e.finished_at > e.started_at
             GROUP BY e.work_node_id
          ) e ON e.work_node_id = w.id
      ) x;

    FOR v_i IN 1..v_n LOOP
        v_dur[v_i] := COALESCE(v_atom_est[v_i], v_atom_actual[v_i], '1 day'::interval);  -- 194 --
        v_indeg[v_i] := 0;
    END LOOP;

    -- Does ANY node in this version carry a calendar? If not, the per-atom
    -- wn_effective_policy() calls in the passes all return NULL calendar_id anyway, so a
    -- single EXISTS check replaces ~2n recursive ancestor walks (the common case).
    SELECT EXISTS (SELECT 1 FROM work_node w WHERE w.plan_version_id = p_version AND w.calendar_id IS NOT NULL)
      INTO v_has_cal;

    -- ── build the compressed adjacency list ONCE ────────────────────────────────────
    -- Successors: edges sorted by (from_pos, to_pos). The uuid→position mapping is a hash
    -- join over unnest(v_atoms) WITH ORDINALITY, NOT an O(n) array_position per edge.
    SELECT array_agg(a.pos ORDER BY a.pos, b.pos),
           array_agg(b.pos ORDER BY a.pos, b.pos),
           array_agg(ue.type ORDER BY a.pos, b.pos),
           array_agg(ue.lag ORDER BY a.pos, b.pos)
      INTO v_esrc, v_edst, v_etype, v_elag
      FROM union_edge ue
      JOIN unnest(v_atoms) WITH ORDINALITY a(id, pos) ON a.id = ue.from_id
      JOIN unnest(v_atoms) WITH ORDINALITY b(id, pos) ON b.id = ue.to_id
     WHERE ue.plan_version_id = p_version;
    -- Predecessors: the same edges sorted by (to_pos, from_pos).
    SELECT array_agg(b.pos ORDER BY b.pos, a.pos),
           array_agg(a.pos ORDER BY b.pos, a.pos),
           array_agg(ue.type ORDER BY b.pos, a.pos),
           array_agg(ue.lag ORDER BY b.pos, a.pos)
      INTO v_psrc, v_pdst, v_ptype, v_plag
      FROM union_edge ue
      JOIN unnest(v_atoms) WITH ORDINALITY a(id, pos) ON a.id = ue.from_id
      JOIN unnest(v_atoms) WITH ORDINALITY b(id, pos) ON b.id = ue.to_id
     WHERE ue.plan_version_id = p_version;

    v_en := array_length(v_esrc, 1);
    IF v_en IS NULL THEN v_en := 0; END IF;

    -- Successor offsets: v_soff[i] = first edge index whose source is atom i.
    v_soff[1] := 1;
    v_cur := 1;
    FOR v_m IN 1..v_en LOOP
        WHILE v_cur < v_esrc[v_m] LOOP
            v_soff[v_cur + 1] := v_m;
            v_cur := v_cur + 1;
        END LOOP;
    END LOOP;
    WHILE v_cur <= v_n LOOP
        v_soff[v_cur + 1] := v_en + 1;
        v_cur := v_cur + 1;
    END LOOP;
    -- Predecessor offsets: v_poff[i] = first edge index whose target is atom i.
    v_poff[1] := 1;
    v_cur := 1;
    FOR v_m IN 1..v_en LOOP
        WHILE v_cur < v_psrc[v_m] LOOP
            v_poff[v_cur + 1] := v_m;
            v_cur := v_cur + 1;
        END LOOP;
    END LOOP;
    WHILE v_cur <= v_n LOOP
        v_poff[v_cur + 1] := v_en + 1;
        v_cur := v_cur + 1;
    END LOOP;

    -- indegree over the union graph (atoms only; edges between atoms are all that matter)
    FOR v_i IN 1..v_n LOOP
        FOR v_m IN v_soff[v_i]..v_soff[v_i + 1] - 1 LOOP
            v_indeg[v_edst[v_m]] := v_indeg[v_edst[v_m]] + 1;
        END LOOP;
    END LOOP;

    -- Kahn's algorithm for the topological order. v_top stores atom POSITIONS (not uuids)
    -- so the forward/backward passes never re-derive them with array_position.
    v_q := ARRAY[]::int[];
    FOR v_i IN 1..v_n LOOP
        IF v_indeg[v_i] = 0 THEN v_qt := v_qt + 1; v_q[v_qt] := v_i; END IF;
    END LOOP;
    v_top := ARRAY[]::int[];
    WHILE v_qh <= v_qt LOOP
        v_i := v_q[v_qh]; v_qh := v_qh + 1;
        v_top := array_append(v_top, v_i);
        FOR v_m IN v_soff[v_i]..v_soff[v_i + 1] - 1 LOOP
            v_j := v_edst[v_m];
            v_indeg[v_j] := v_indeg[v_j] - 1;
            IF v_indeg[v_j] = 0 THEN v_qt := v_qt + 1; v_q[v_qt] := v_j; END IF;
        END LOOP;
    END LOOP;
    -- Cycle guard (TKT-162-79AE). array_length() on an EMPTY array is NULL, so the old
    -- `array_length(v_top, 1) < v_n` test silently passed for a graph whose nodes are ALL
    -- in cycles (no indegree-0 start) and the forward pass then read NULL v_top elements.
    -- COALESCE makes the fully-cyclic case raise the same exception as a partial cycle.
    IF COALESCE(array_length(v_top, 1), 0) < v_n THEN
        RAISE EXCEPTION 'wn_cpm: cycle in union graph for version %', p_version;
    END IF;

    -- FORWARD PASS — earliest start/finish, in topological order. A node's earliest start
    -- is the max over its predecessors (finish+lag for FS/FF, start+lag for SS/SF), at
    -- least the project start; its earliest finish adds its duration, spread across its
    -- effective calendar when it has one.
    FOR v_k IN 1..v_n LOOP
        v_i := v_top[v_k];
        IF v_has_cal THEN
            SELECT (wn_effective_policy(v_atoms[v_i])).calendar_id INTO v_cal;
        ELSE
            v_cal := NULL;
        END IF;
        v_es[v_i] := v_start;
        FOR v_m IN v_poff[v_i]..v_poff[v_i + 1] - 1 LOOP
            v_j := v_pdst[v_m];
            IF v_ptype[v_m] IN ('FS','FF') THEN
                IF v_ef[v_j] + v_plag[v_m] > v_es[v_i] THEN v_es[v_i] := v_ef[v_j] + v_plag[v_m]; END IF;
            ELSE
                IF v_es[v_j] + v_plag[v_m] > v_es[v_i] THEN v_es[v_i] := v_es[v_j] + v_plag[v_m]; END IF;
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
        v_i := v_top[v_k];
        IF v_has_cal THEN
            SELECT (wn_effective_policy(v_atoms[v_i])).calendar_id INTO v_cal;
        ELSE
            v_cal := NULL;
        END IF;
        v_lf[v_i] := v_proj_finish;
        FOR v_m IN v_soff[v_i]..v_soff[v_i + 1] - 1 LOOP
            v_j := v_edst[v_m];
            IF v_etype[v_m] IN ('FS','SS') THEN
                IF v_ls[v_j] - v_elag[v_m] < v_lf[v_i] THEN v_lf[v_i] := v_ls[v_j] - v_elag[v_m]; END IF;
            ELSE
                IF v_lf[v_j] - v_elag[v_m] < v_lf[v_i] THEN v_lf[v_i] := v_lf[v_j] - v_elag[v_m]; END IF;
            END IF;
        END LOOP;
        v_ls[v_i] := wn_calendar_working_start(v_cal, v_lf[v_i], v_dur[v_i]);
    END LOOP;

    -- emit ATOMS — the schedule proper (leaves only; the critical path runs through leaves)
    FOR v_i IN 1..v_n LOOP
        node_id := v_atoms[v_i]; name := v_atom_name[v_i]; kind := v_atom_kind[v_i]; parent_id := v_atom_parent[v_i];
        is_atom := true; duration := v_dur[v_i];
        earliest_start := v_es[v_i]; earliest_finish := v_ef[v_i];
        latest_start := v_ls[v_i]; latest_finish := v_lf[v_i];
        slack := v_ls[v_i] - v_es[v_i]; critical := (v_ls[v_i] = v_es[v_i]);
        RETURN NEXT;
    END LOOP;

    -- CONTAINER ROLLUP — one bottom-up pass. Load the containers in the same order the
    -- original emitted them (the same un-ordered query, so the row order is unchanged),
    -- then walk each atom UP its parent chain once, accumulating the subtree bounds
    -- into every container ancestor. This replaces the O(containers x atoms) loop with
    -- O(atoms x depth) parent walks and removes the per-pair wn_is_ancestor_of() calls.
    v_nc := 0;
    FOR v_node IN SELECT w.id, w.name, w.kind, w.parent_id FROM work_node w
                   WHERE w.plan_version_id = p_version AND w.kind = 'container' LOOP
        v_nc := v_nc + 1;
        v_cont_ids[v_nc] := v_node.id;
        v_cont_name[v_nc] := v_node.name;
        v_cont_kind[v_nc] := v_node.kind;
        v_cont_parent[v_nc] := v_node.parent_id;
    END LOOP;

    FOR v_i IN 1..v_n LOOP
        v_cur_id := v_atoms[v_i];
        LOOP
            SELECT w.parent_id INTO v_par FROM work_node w WHERE w.id = v_cur_id;
            EXIT WHEN v_par IS NULL;
            v_cp := array_position(v_cont_ids, v_par);
            IF v_cp IS NOT NULL THEN
                IF v_csmin[v_cp] IS NULL OR v_es[v_i] < v_csmin[v_cp] THEN v_csmin[v_cp] := v_es[v_i]; END IF;
                IF v_csmax[v_cp] IS NULL OR v_ef[v_i] > v_csmax[v_cp] THEN v_csmax[v_cp] := v_ef[v_i]; END IF;
                IF v_clmin[v_cp] IS NULL OR v_ls[v_i] < v_clmin[v_cp] THEN v_clmin[v_cp] := v_ls[v_i]; END IF;
                IF v_clmax[v_cp] IS NULL OR v_lf[v_i] > v_clmax[v_cp] THEN v_clmax[v_cp] := v_lf[v_i]; END IF;
                IF v_ls[v_i] = v_es[v_i] THEN v_ccrit[v_cp] := true; END IF;
            END IF;
            v_cur_id := v_par;
        END LOOP;
    END LOOP;

    -- emit CONTAINERS — the subtree span (containers report span, not a path role)
    FOR v_ci IN 1..v_nc LOOP
        node_id := v_cont_ids[v_ci]; name := v_cont_name[v_ci]; kind := v_cont_kind[v_ci]; parent_id := v_cont_parent[v_ci];
        is_atom := false; duration := wn_duration(v_cont_ids[v_ci]);
        earliest_start := v_csmin[v_ci]; earliest_finish := v_csmax[v_ci];
        latest_start := v_clmin[v_ci]; latest_finish := v_clmax[v_ci];
        slack := NULL; critical := COALESCE(v_ccrit[v_ci], false);
        RETURN NEXT;
    END LOOP;
END;
$$;

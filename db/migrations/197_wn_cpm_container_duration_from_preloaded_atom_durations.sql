-- WN_CPM CONTAINER DURATION FROM PRELOADED ATOM DURATIONS — remove the 194 container-loop
-- re-querying of per-atom executions.
--
-- WHY: migration 194 made wn_cpm's atom durations evidence-based (estimate → closed-execution
-- actual → 1-day default). It loaded those durations ONCE into v_dur (one bulk AVG over
-- executions). But the container EMIT loop still called wn_duration(container) per container,
-- and wn_duration's ATOM branch does its OWN per-atom execution SELECT — so a plan with N
-- unestimated atoms fired N redundant execution queries, re-deriving exactly what v_dur
-- already held. On a reproduced 354-node unestimated shape this is measurably faster after the
-- fix (~20ms of the ~100ms on a clean sandbox with 5000 execution rows; the golden test drops
-- from ~300ms to ~70-115ms). The work is REDUNDANT, not intrinsic: the duration the emit loop
-- wants is computable from the already-loaded v_dur.
--
-- NOT CLAIMED: that this explains the fleet meta-DB's 4.2-5.1s warm wn_cpm on the 355-node
-- omnibiz plan. That cost was NOT re-measured after this fix (a zee cannot reach the fleet
-- DB), and the fleet's execution table is 161 rows — thirty times SMALLER than the synthetic
-- 5000-row benchmark above — so table size does not explain the fleet's slowdown. The fleet's
-- remaining cost is an OPEN QUESTION, not settled here.
--
-- THE FIX: wn_duration_using(p_node, atom_ids, atom_durs) — the SAME recursive semantics as
-- wn_duration (atom → its preloaded duration; sequence → Σ children; parallel/freeform → max
-- children) but taking the atom durations as ARGUMENTS instead of re-querying executions. The
-- container emit loop passes v_atoms + v_dur, which it already has. Output is BYTE-IDENTICAL
-- to 194's: the values are the same, only the per-atom execution lookups are gone.
--
-- FORWARD-ONLY: CREATE OR REPLACE. A second migrate pass is a clean no-op. The golden CPM
-- fixture (all atoms estimated) must stay byte-identical — verified by
-- test/workflow-stage6-cpm-golden.test.mjs.

-- ── wn_duration_using: the duration a node WOULD have, given preloaded atom durations ──────
CREATE OR REPLACE FUNCTION wn_duration_using(p_node uuid, p_atom_ids uuid[], p_atom_durs interval[])
RETURNS interval
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_kind node_kind; v_sem child_semantics;
    v_pos int;
    v_child record;
    v_total interval := '0';
BEGIN
    SELECT kind, child_semantics INTO v_kind, v_sem FROM work_node WHERE id = p_node;

    IF v_kind <> 'container' THEN
        -- ATOM: the caller already computed its effective duration (v_dur) — just look it up.
        v_pos := array_position(p_atom_ids, p_node);
        IF v_pos IS NULL THEN RETURN '0'::interval; END IF;
        RETURN COALESCE(p_atom_durs[v_pos], '0'::interval);
    END IF;

    IF v_sem = 'sequence' THEN
        FOR v_child IN SELECT w.id FROM work_node w WHERE w.parent_id = p_node ORDER BY w.sibling_rank LOOP
            v_total := v_total + wn_duration_using(v_child.id, p_atom_ids, p_atom_durs);
        END LOOP;
    ELSIF v_sem = 'parallel' THEN
        FOR v_child IN SELECT w.id FROM work_node w WHERE w.parent_id = p_node ORDER BY w.sibling_rank LOOP
            v_total := GREATEST(v_total, wn_duration_using(v_child.id, p_atom_ids, p_atom_durs));
        END LOOP;
    ELSE  -- freeform: planning upper bound = max of children
        FOR v_child IN SELECT w.id FROM work_node w WHERE w.parent_id = p_node ORDER BY w.sibling_rank LOOP
            v_total := GREATEST(v_total, wn_duration_using(v_child.id, p_atom_ids, p_atom_durs));
        END LOOP;
    END IF;

    RETURN v_total;
END;
$$;

-- ── wn_cpm: 194's function, with the container-emit duration source changed ────────────────
-- Replicated in full (CREATE OR REPLACE cannot edit one line of a function). The single change,
-- marked `-- 197 --`: the container emit loop's `duration := wn_duration(...)` becomes
-- `duration := wn_duration_using(v_cont_ids[v_ci], v_atoms, v_dur)` — no per-atom execution
-- queries. Everything else is migration 194 verbatim.
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
    v_atom_actual interval[];
    -- compressed adjacency (built ONCE from a single set-based union_edge scan):
    v_esrc int[]; v_edst int[]; v_etype text[]; v_elag interval[];
    v_psrc int[]; v_pdst int[]; v_ptype text[]; v_plag interval[];
    v_soff int[]; v_poff int[];
    v_en int; v_cur int; v_m int;
    v_has_cal boolean;
    -- container rollup accumulators
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
           array_agg(NULLIF(w.estimate, '0'::interval) ORDER BY w.id)
      INTO v_atoms, v_atom_name, v_atom_kind, v_atom_parent, v_atom_est
      FROM work_node w
     WHERE w.plan_version_id = p_version AND w.kind <> 'container';
    IF v_atoms IS NULL OR array_length(v_atoms, 1) = 0 THEN RETURN; END IF;
    v_n := array_length(v_atoms, 1);

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
        v_dur[v_i] := COALESCE(v_atom_est[v_i], v_atom_actual[v_i], '1 day'::interval);
        v_indeg[v_i] := 0;
    END LOOP;

    SELECT EXISTS (SELECT 1 FROM work_node w WHERE w.plan_version_id = p_version AND w.calendar_id IS NOT NULL)
      INTO v_has_cal;

    SELECT array_agg(a.pos ORDER BY a.pos, b.pos),
           array_agg(b.pos ORDER BY a.pos, b.pos),
           array_agg(ue.type ORDER BY a.pos, b.pos),
           array_agg(ue.lag ORDER BY a.pos, b.pos)
      INTO v_esrc, v_edst, v_etype, v_elag
      FROM union_edge ue
      JOIN unnest(v_atoms) WITH ORDINALITY a(id, pos) ON a.id = ue.from_id
      JOIN unnest(v_atoms) WITH ORDINALITY b(id, pos) ON b.id = ue.to_id
     WHERE ue.plan_version_id = p_version;
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

    FOR v_i IN 1..v_n LOOP
        FOR v_m IN v_soff[v_i]..v_soff[v_i + 1] - 1 LOOP
            v_indeg[v_edst[v_m]] := v_indeg[v_edst[v_m]] + 1;
        END LOOP;
    END LOOP;

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
    IF COALESCE(array_length(v_top, 1), 0) < v_n THEN
        RAISE EXCEPTION 'wn_cpm: cycle in union graph for version %', p_version;
    END IF;

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

    v_proj_finish := NULL;
    FOR v_i IN 1..v_n LOOP
        IF v_proj_finish IS NULL OR v_ef[v_i] > v_proj_finish THEN v_proj_finish := v_ef[v_i]; END IF;
    END LOOP;

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

    FOR v_i IN 1..v_n LOOP
        node_id := v_atoms[v_i]; name := v_atom_name[v_i]; kind := v_atom_kind[v_i]; parent_id := v_atom_parent[v_i];
        is_atom := true; duration := v_dur[v_i];
        earliest_start := v_es[v_i]; earliest_finish := v_ef[v_i];
        latest_start := v_ls[v_i]; latest_finish := v_lf[v_i];
        slack := v_ls[v_i] - v_es[v_i]; critical := (v_ls[v_i] = v_es[v_i]);
        RETURN NEXT;
    END LOOP;

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
        is_atom := false; duration := wn_duration_using(v_cont_ids[v_ci], v_atoms, v_dur);  -- 197 --
        earliest_start := v_csmin[v_ci]; earliest_finish := v_csmax[v_ci];
        latest_start := v_clmin[v_ci]; latest_finish := v_clmax[v_ci];
        slack := NULL; critical := COALESCE(v_ccrit[v_ci], false);
        RETURN NEXT;
    END LOOP;
END;
$$;

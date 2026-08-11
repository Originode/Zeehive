-- OPTIMIZE wn_cpm — the CPM pass scales to the fleet's real plan sizes.
--
-- Why this migration exists (measured on the live meta-DB after rehab 1/4 backfilled the
-- real work items, and reproduced here on a sandbox):
--
--   Zeehive plan   157 nodes,  23 edges  ->  20,685 ms   (measured on the live meta-DB)
--   omnibiz plan   354 nodes, 320 edges  ->  TIMED OUT at 120,000 ms
--
--   sandbox repro (this migration's own numbers, same shape — 1 freeform root, 39 sequence
--   containers, largest 67 children, shallow tree, ~313 union edges):
--     157 nodes:   2,295 ms  before  ->    ~50 ms after   (~45x)
--     354 nodes:  10,720 ms  before  ->    ~60 ms after   (~180x)
--
-- THE COST WAS NOT union_edge (the whole view for both plans, 343 edges, is 676 ms).
-- It was inside wn_cpm's own loops:
--
--   1. THE VIEW WAS RE-EVALUATED ONCE PER NODE, THREE TIMES OVER. The topological
--      queue, the forward pass and the backward pass each sat inside a `FOR ... IN 1..v_n`
--      loop and each ran `SELECT ... FROM union_edge WHERE plan_version_id = p_version
--      AND from_id = <this node>`. union_edge is a plain VIEW, not a table — there is no
--      index to push that filter into, so Postgres rebuilt the entire view (CROSS JOIN
--      LATERAL wn_last_leaves()/wn_first_leaves() recursive descents and all) on every
--      iteration. That is ~3n full view builds: ~471 for Zeehive, ~1,062 for omnibiz.
--
--   2. THE ROLLUP WAS O(containers x atoms) WITH A RECURSIVE CALL PER PAIR. For every
--      non-atom node it looped every atom and called wn_is_ancestor_of(container, atom)
--      — tens of thousands of recursive ancestor walks to compute what one downward
--      pass over the tree already knows.
--
-- THE FIX (semantics-identical, output byte-identical):
--
--   a. The version's edges are materialised ONCE at the top of the function — a
--      compressed adjacency list (per-atom successor/predecessor offset ranges into flat
--      edge arrays) built by ONE set-based SQL statement (unnest(v_atoms) WITH ORDINALITY
--      joined to union_edge — a hash join, not an O(n) array_position per edge). All
--      three per-node view queries become O(1)-amortised array range scans: each pass
--      walks only the edges incident to the node. One view build instead of 3n.
--
--   b. The ancestor rollup is one bottom-up pass: each atom walks UP its parent chain
--      once, accumulating min(earliest_start)/max(earliest_finish)/min(latest_start)/
--      max(latest_finish) and the critical flag into every container ancestor, instead
--      of asking "is this container an ancestor of this atom" for every pair.
--
--   c. The two per-atom wn_effective_policy() calls in the forward/backward passes are
--      skipped when the version has no calendar anywhere (the overwhelmingly common case)
--      — a single EXISTS check replaces ~2n recursive ancestor walks.
--
--   d. Cycle guard hardened (TKT-162-79AE): array_length() on an EMPTY array is NULL, so
--      the old `array_length(v_top, 1) < v_n` test never fired for a graph whose nodes are
--      ALL in cycles (no indegree-0 start) — the function crashed reading NULL v_top
--      elements instead of raising. COALESCE(...,0) makes that case raise the same
--      'cycle in union graph' exception as a partial cycle.
--
-- The schedule it returns is IDENTICAL: the same atoms in the same order, the same
-- earliest/latest/slack/critical values, the same container spans. The Stage 6 test
-- (test/workflow-stage6.test.mjs) passes unchanged; the golden CPM harness
-- (test/workflow-stage6-cpm-golden.test.mjs) diffs the full wn_cpm output for a 354-node
-- plan byte-for-byte against a pre-change capture and asserts the runtime stays under a
-- second, so this cannot regress silently.
--
-- FORWARD-ONLY: CREATE OR REPLACE. A second migrate pass is a clean no-op.
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
           array_agg(COALESCE(w.estimate, '0'::interval) ORDER BY w.id)
      INTO v_atoms, v_atom_name, v_atom_kind, v_atom_parent, v_atom_est
      FROM work_node w
     WHERE w.plan_version_id = p_version AND w.kind <> 'container';
    IF v_atoms IS NULL OR array_length(v_atoms, 1) = 0 THEN RETURN; END IF;
    v_n := array_length(v_atoms, 1);

    FOR v_i IN 1..v_n LOOP
        v_dur[v_i] := v_atom_est[v_i];
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

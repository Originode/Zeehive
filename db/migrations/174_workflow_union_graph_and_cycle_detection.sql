-- HIERARCHICAL WORKFLOW MODEL — THE UNION GRAPH, CYCLE DETECTION, I5/I6.
--
-- Scheduling and cycle detection NEVER look at the dependency table alone.
-- Edges come from three sources:
--   1. sibling order under 'sequence'
--   2. explicit dependency rows
--   3. every data edge (I14)  — data plane lands in stage 2; not here yet.
--
-- Leaf expansion is NOT optional. Contracting each subtree to one vertex reports
-- false cycles. Counterexample: A = sequence[A1, A2], B = sequence[B1, B2],
-- edges A1->B1 and B2->A2. Contracted you see A->B and B->A, a cycle. Expanded
-- you see the path A1->B1->B2->A2, perfectly acyclic.
--
-- union_edge exposes the expanded edge set; detect_cycles walks it and returns
-- the offending edges; check_dependency_legality enforces I5 (an explicit
-- dependency is legal iff LCA(from,to).child_semantics = 'freeform') and I6
-- (neither endpoint may be an ancestor of the other).
--
-- Idempotent, additive, forward-only.

CREATE OR REPLACE VIEW union_edge AS
    -- (1) sibling order under 'sequence'
    SELECT p.plan_version_id,
           lf.id  AS from_id,
           ff.id  AS to_id,
           'sequence'::text AS origin,
           '0'::interval    AS lag
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

    -- (2) explicit dependency rows, expanded per link type
    SELECT w.plan_version_id, e.from_leaf, e.to_leaf, 'dependency', d.lag
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

-- Cycle detection over the union graph (I10). Returns offending edges.
CREATE OR REPLACE FUNCTION detect_cycles(p_version uuid)
RETURNS TABLE (from_id uuid, to_id uuid, path uuid[])
LANGUAGE sql STABLE AS $$
    WITH RECURSIVE e AS (
        SELECT ue.from_id, ue.to_id FROM union_edge ue
        WHERE ue.plan_version_id = p_version
    ),
    walk AS (
        SELECT e.from_id AS root, e.to_id AS node,
               ARRAY[e.from_id, e.to_id] AS path, false AS cyc
        FROM e
        UNION ALL
        SELECT w.root, e.to_id, w.path || e.to_id, e.to_id = ANY(w.path)
        FROM walk w JOIN e ON e.from_id = w.node
        WHERE NOT w.cyc AND array_length(w.path, 1) < 10000
    )
    SELECT path[array_length(path,1)-1], node, path
    FROM walk WHERE cyc;
$$;

-- I5: an explicit dependency is legal iff LCA(from, to).child_semantics = 'freeform'.
-- Under 'sequence' the edge is implied or contradicts rank; under 'parallel' it
-- contradicts parallelism; under 'choice'/'race' only one branch survives, so a
-- cross-branch edge is incoherent. Data edges are exempt — they carry their own
-- meaning and generate their own ordering.
-- I6: neither endpoint may be an ancestor of the other.
CREATE OR REPLACE FUNCTION check_dependency_legality()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_lca uuid; v_sem child_semantics;
BEGIN
    IF wn_is_ancestor_of(NEW.from_id, NEW.to_id)
       OR wn_is_ancestor_of(NEW.to_id, NEW.from_id) THEN
        RAISE EXCEPTION 'I6 violated: % and % are in an ancestor relationship',
            NEW.from_id, NEW.to_id;
    END IF;

    v_lca := wn_lca(NEW.from_id, NEW.to_id);
    IF v_lca IS NULL THEN
        RAISE EXCEPTION 'I5 violated: % and % share no common ancestor',
            NEW.from_id, NEW.to_id;
    END IF;

    SELECT child_semantics INTO v_sem FROM work_node WHERE id = v_lca;
    IF v_sem IS DISTINCT FROM 'freeform' THEN
        RAISE EXCEPTION
            'I5 violated: dependency %->% has LCA % with semantics %; only freeform permits explicit dependencies',
            NEW.from_id, NEW.to_id, v_lca, v_sem;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dependency_legality ON dependency;
CREATE TRIGGER dependency_legality
    BEFORE INSERT OR UPDATE ON dependency
    FOR EACH ROW EXECUTE FUNCTION check_dependency_legality();

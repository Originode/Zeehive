-- HIERARCHICAL WORKFLOW MODEL — TREE ALGEBRA.
--
-- The structural functions every later stage builds on: ancestors, lowest common
-- ancestor, ancestor test, atom test, and the entry/exit leaves of a subtree.
-- These are the reviewed artifact from docs/hierarchical-workflow-schema.sql,
-- trimmed to the stage-1 operator set. wn_is_atom defines an "atom" as any
-- non-container leaf; when loop/map arrive the definition extends to loop/map
-- containers (contracted to one vertex so repetition cannot make the union graph
-- cyclic). wn_first_leaves/wn_last_leaves return entry/exit leaves under each
-- operator — under 'sequence' only the first/last child can start/finish, under
-- every other operator any child may.
--
-- Idempotent, additive, forward-only (CREATE OR REPLACE).

-- Ancestors of a node, nearest first.
CREATE OR REPLACE FUNCTION wn_ancestors(p_node uuid)
RETURNS TABLE (id uuid, depth integer)
LANGUAGE sql STABLE AS $$
    WITH RECURSIVE up AS (
        SELECT w.parent_id AS id, 1 AS depth
        FROM work_node w WHERE w.id = p_node AND w.parent_id IS NOT NULL
        UNION ALL
        SELECT w.parent_id, up.depth + 1
        FROM up JOIN work_node w ON w.id = up.id
        WHERE w.parent_id IS NOT NULL
    )
    SELECT id, depth FROM up ORDER BY depth;
$$;

-- Lowest common ancestor. The basis of invariant I5.
CREATE OR REPLACE FUNCTION wn_lca(p_a uuid, p_b uuid)
RETURNS uuid
LANGUAGE sql STABLE AS $$
    WITH a AS (SELECT p_a AS id, 0 AS depth UNION ALL SELECT id, depth FROM wn_ancestors(p_a)),
         b AS (SELECT p_b AS id, 0 AS depth UNION ALL SELECT id, depth FROM wn_ancestors(p_b))
    SELECT a.id FROM a JOIN b ON a.id = b.id ORDER BY a.depth LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION wn_is_ancestor_of(p_maybe_ancestor uuid, p_node uuid)
RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM wn_ancestors(p_node) WHERE id = p_maybe_ancestor);
$$;

-- An "atom" is a vertex of the union graph: any leaf (non-container). Loop and
-- map containers join the definition in a later stage — a loop/map body is
-- contracted to a single vertex so that repetition does not make the graph
-- cyclic (the same trick structured programming used against goto).
CREATE OR REPLACE FUNCTION wn_is_atom(p_node uuid)
RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT kind <> 'container'
    FROM work_node WHERE id = p_node;
$$;

-- Entry leaves of a subtree. Under 'sequence' only the first child can start;
-- under every other operator any child may.
CREATE OR REPLACE FUNCTION wn_first_leaves(p_node uuid)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_sem child_semantics;
    v_child uuid;
BEGIN
    IF wn_is_atom(p_node) THEN
        RETURN QUERY SELECT p_node; RETURN;
    END IF;

    SELECT child_semantics INTO v_sem FROM work_node WHERE work_node.id = p_node;

    IF v_sem = 'sequence' THEN
        SELECT w.id INTO v_child FROM work_node w
        WHERE w.parent_id = p_node ORDER BY w.sibling_rank LIMIT 1;
        IF v_child IS NULL THEN RETURN QUERY SELECT p_node; RETURN; END IF;
        RETURN QUERY SELECT * FROM wn_first_leaves(v_child);
    ELSE
        FOR v_child IN
            SELECT w.id FROM work_node w WHERE w.parent_id = p_node ORDER BY w.sibling_rank
        LOOP
            RETURN QUERY SELECT * FROM wn_first_leaves(v_child);
        END LOOP;
    END IF;
END;
$$;

-- Exit leaves of a subtree. Under 'sequence' only the last child can finish;
-- under every other operator any child may.
CREATE OR REPLACE FUNCTION wn_last_leaves(p_node uuid)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_sem child_semantics;
    v_child uuid;
BEGIN
    IF wn_is_atom(p_node) THEN
        RETURN QUERY SELECT p_node; RETURN;
    END IF;

    SELECT child_semantics INTO v_sem FROM work_node WHERE work_node.id = p_node;

    IF v_sem = 'sequence' THEN
        SELECT w.id INTO v_child FROM work_node w
        WHERE w.parent_id = p_node ORDER BY w.sibling_rank DESC LIMIT 1;
        IF v_child IS NULL THEN RETURN QUERY SELECT p_node; RETURN; END IF;
        RETURN QUERY SELECT * FROM wn_last_leaves(v_child);
    ELSE
        FOR v_child IN
            SELECT w.id FROM work_node w WHERE w.parent_id = p_node ORDER BY w.sibling_rank
        LOOP
            RETURN QUERY SELECT * FROM wn_last_leaves(v_child);
        END LOOP;
    END IF;
END;
$$;

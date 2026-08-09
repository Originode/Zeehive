-- HIERARCHICAL WORKFLOW MODEL — POLICY INHERITANCE + DURATION ROLLUP.
--
-- wn_effective_policy resolves a node's effective policy by walking up to the
-- nearest ancestor that sets the field: configure once at the root, override at
-- three nodes, not at four hundred leaves. This is also the mechanism by which a
-- descendant inherits its plan's tenancy (the plan is bound to a ZEEHIVE project
-- at the root; the binding is lexical, exactly like retry/timeout).
--
-- wn_duration rolls a subtree's duration up per operator:
--   sequence  Σ children        parallel  max children
--   freeform  CPM longest path — computed by the scheduler, not here (max of
--             children is the planning upper bound).
-- Only the three stage-1 operators exist; choice/race/map/loop/try rollup
-- arrives with the stages that implement them.
--
-- Idempotent, additive, forward-only.

-- Policy inheritance: resolve by walking up to the nearest ancestor that sets
-- the field. calendar_id is inherited too (its FK lands with the calendar table).
CREATE OR REPLACE FUNCTION wn_effective_policy(p_node uuid)
RETURNS TABLE (retry_policy jsonb, timeout interval, on_error error_policy,
               priority integer, calendar_id uuid)
LANGUAGE sql STABLE AS $$
    WITH chain AS (
        SELECT p_node AS id, 0 AS depth
        UNION ALL SELECT id, depth FROM wn_ancestors(p_node)
    ),
    vals AS (
        SELECT w.*, c.depth FROM chain c JOIN work_node w ON w.id = c.id
    )
    SELECT
        (SELECT v.retry_policy FROM vals v WHERE v.retry_policy IS NOT NULL ORDER BY v.depth LIMIT 1),
        (SELECT v.timeout      FROM vals v WHERE v.timeout      IS NOT NULL ORDER BY v.depth LIMIT 1),
        (SELECT v.on_error     FROM vals v WHERE v.on_error     IS NOT NULL ORDER BY v.depth LIMIT 1),
        (SELECT v.priority     FROM vals v WHERE v.priority     IS NOT NULL ORDER BY v.depth LIMIT 1),
        (SELECT v.calendar_id  FROM vals v WHERE v.calendar_id  IS NOT NULL ORDER BY v.depth LIMIT 1);
$$;

-- Duration per operator:
--   sequence  Σ children        parallel  max children
--   freeform  longest path through children in the union graph (scheduler's
--             job; the planning upper bound is max of children)
CREATE OR REPLACE FUNCTION wn_duration(p_node uuid)
RETURNS interval
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_kind node_kind; v_sem child_semantics;
    v_est interval;
    v_total interval := '0';
BEGIN
    SELECT kind, child_semantics, estimate
      INTO v_kind, v_sem, v_est
    FROM work_node WHERE id = p_node;

    IF v_kind <> 'container' THEN
        RETURN COALESCE(v_est, '0'::interval);
    END IF;

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

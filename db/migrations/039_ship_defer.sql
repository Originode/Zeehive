-- SHIP DEFER — set a production ship request aside temporarily, without rejecting it.
--
-- The motivating shape (spec: "defer a shipment so other landings can accumulate for one big
-- ship"): several xells each land a SMALL incremental change and each asks to ship. Shipping every
-- one of them is a prod deploy per commit — noisy and needless. A human would rather let the
-- landings pile up on main and then make ONE combined ship. Defer is that "not now, keep it": the
-- request stops nagging as "awaiting your approval" and steps out of the landing-pad queue, but it
-- is NOT rejected — it can be RESUMED later, at which point it re-resolves to the current main tip
-- so the one ship that finally goes carries every landing made since it was deferred.
--
-- Modeled like dismissal (031): a nullable timestamp on the row, not a new enum value. A deferred
-- ship keeps status='pending' (so the one-open-ship-per-xell invariant still holds and a re-asking
-- zee still finds its existing request); deferred_at IS NOT NULL is simply the "set aside" bucket.
-- Resuming clears it. This sidesteps ALTER TYPE ... ADD VALUE entirely (it cannot run in the
-- per-migration transaction on older Postgres) and reuses every code path that already keys off
-- 'pending'.
ALTER TABLE ship_request
  ADD COLUMN IF NOT EXISTS deferred_at timestamptz,
  ADD COLUMN IF NOT EXISTS deferred_by text;

-- The pending index that drives "awaiting approval" scans should not surface a set-aside request.
CREATE INDEX IF NOT EXISTS ship_request_deferred_idx ON ship_request (project_id, requested_at DESC)
  WHERE status = 'pending' AND deferred_at IS NOT NULL;

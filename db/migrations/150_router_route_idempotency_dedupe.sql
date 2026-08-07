-- ROUTER ROUTE IDEMPOTENCY — one routing request per human action (the double-deploy fix).
--
-- SYMPTOM: a single "Route via router" action in the console sometimes produced TWO
-- 🧭 ROUTING REQUEST messages for the same prompt. The composer is fire-and-forget
-- (App.jsx runDispatch closes the modal and reports through a toast); a double-click on
-- the submit button, or Cmd+Enter landing while the click is still in the same tick, fires
-- `onDispatch` twice — and nothing on the server noticed, because routeRawPrompt had no
-- idempotency at all. Two messages to the router read as two prompts, and the router
-- dispatched a worker for each: one action, two deployments, and then a "stand down" spent
-- telling the duplicate to stop.
--
-- WHAT THIS MIGRATION ADDS: a per-request dedup key on the durable zee_message row. The
-- console sends a `client_request_id` (one per composition, stable across a double-submit);
-- the server stores it in zee_message.meta and REFUSES a second routing request that names a
-- key it has already recorded for the same project within the dedup window. The refusal is
-- LOUD (this codebase's style) — the second POST gets a named error, never a silent drop, so
-- a genuine re-send by a human is distinguishable from a double-submit.
--
-- The dedup key is a partial UNIQUE index, because "at most one active dedup record per
-- (project, client_request_id)" is exactly a uniqueness constraint — the trustworthy layer the
-- task asks for. A composite key (project_id, dedup key) keeps the scope per project, so two
-- projects sending the same client-generated key cannot collide.

-- ── the dedup ledger: one row per routing request, for the dedup window ──────────────
CREATE TABLE IF NOT EXISTS router_route_dedup (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  to_xell_id         uuid NOT NULL REFERENCES xell(id) ON DELETE CASCADE,
  client_request_id  text NOT NULL,
  message_id         uuid NOT NULL REFERENCES zee_message(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE router_route_dedup IS
  'Idempotency ledger for POST /api/router/route (150): the console sends a client_request_id per '
  'composition, and a second routing request that names one already recorded for the same project is '
  'refused LOUDLY instead of enqueuing a second 🧭 ROUTING REQUEST for the same human action. The row '
  'lives only as long as the dedup window (routeRawPrompt prunes older rows opportunistically).';

-- AT MOST ONE active dedup record per (project, client_request_id). The partial UNIQUE index is the
-- wall: two concurrent route calls with the same key race here, and postgres lets exactly one win.
CREATE UNIQUE INDEX IF NOT EXISTS router_route_dedup_project_key_uq
  ON router_route_dedup (project_id, client_request_id);

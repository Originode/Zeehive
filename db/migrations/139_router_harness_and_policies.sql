-- THE ROUTER — one zee per project whose whole job is the front door: accept a human's RAW
-- prompt, recompose it into a brief a zee can actually execute, and decide the dispatch
-- (provider, model, autonomy mode, harness) under an operator-tunable ROUTER POLICY.
--
-- Three pieces, one migration:
--
--   (1) harness.model_policy gains a `limit` knob — the maximum number of LIVE xells that may
--       wear a harness PER PROJECT. Enforced at assign time (lib/harness.js assignHarness), so
--       every path that hands out a persona (dispatch, swap, the console chip) hits one wall.
--       Sparse like every other policy field: absent = unlimited. Merged min-wins down the
--       parent chain (a child cannot widen a cap its parent set — same reasoning as the
--       allow-list intersection in 110).
--
--   (2) harness.router_policy — a jsonb of ROUTING KNOBS, the router's tunable behaviour:
--         provider_weights   {provider: n>=0} — relative share of dispatches per provider
--                            (0 = never pick it unless it is the fallback)
--         provider_schedule  {provider: {days:[0-6], hours:[start,end]}} — when a provider may
--                            be picked at all (UTC; absent = always)
--         max_concurrent     n — max worker zees the router keeps active at once; further
--                            routing requests wait until a slot frees
--         default_mode       1..5 — the autonomy a routed dispatch gets unless the prompt
--                            itself demands otherwise
--         rewrite            'concise' | 'structured' | 'verbatim' — how aggressively the raw
--                            prompt is recomposed
--         max_task_chars     n — target ceiling for the recomposed brief
--         fallback_provider  key — where a request lands when weights/schedule exclude
--                            everything else
--       Normalized/merged in lib/router-policy.js (leaf-wins, per-key for the maps); the
--       EFFECTIVE policy rides along with every routing request the console hands the router,
--       so turning a knob changes the NEXT request without a re-brief.
--
--   (3) the `router` harness itself — zee_type MANAGER, parent `manager`, model_policy
--       {"limit": 1}. A manager, deliberately, because the walls a router needs already exist
--       for managers and are STRUCTURAL, not prose:
--         • no land, no ship — the landgate declines a manager push without raising a request
--           (052), and every self verb refuses through refuseForManager;
--         • production READ-ONLY — the manager dispatch path minting a SELECT-only role;
--         • `zee sync` allowed — the router may roll its worktree forward to the xource's
--           current main, which is exactly the read-refresh it is permitted;
--         • `zee dispatch` — the router's output IS a dispatch, and the crew verbs give it
--           watch/converse over what it routed.
--       A new zee_type was rejected for 120's reason verbatim: types exist for REFUSALS, and
--       the router needs no refusal the manager type does not already have.
--
-- DB-owned end to end (080), guarded + idempotent like 120/138: the row is created only when
-- absent, bundle fields fill only when empty (a console edit is never clobbered), and a missing
-- `manager` parent refuses to mint rather than creating a router with no manual behind it.

ALTER TABLE harness ADD COLUMN IF NOT EXISTS router_policy jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN harness.router_policy IS
  'ROUTER KNOBS (139), meaningful on the router harness (key `router`) and its descendants: { provider_weights?: {provider: n}, provider_schedule?: {provider:{days:[0-6],hours:[start,end]}}, max_concurrent?, default_mode?, rewrite?, max_task_chars?, fallback_provider? }. Normalized by lib/router-policy.js; the effective (chain-merged) policy is attached to every routing request.';

COMMENT ON COLUMN harness.model_policy IS
  'Per-harness AI model policy: { allow_providers?, allow_models?, min_context?, max_context?, min_params?, max_params?, priorities?: {model: n}, default_model?, limit? }. Restricts what a zee wearing this harness may run on, and sets deployment priority per model (default 1; higher deploys first). Dispatch resolves this BEFORE spawn. `limit` (139) caps how many LIVE xells may wear this harness per project (absent = unlimited; min-wins down the parent chain) — enforced at assign time.';

-- ── the router harness (manager-type, parent `manager`, limit 1) ─────────────────────────────
DO $$
DECLARE
  parent uuid;
  b      jsonb;
BEGIN
  SELECT id INTO parent FROM harness WHERE key = 'manager';
  IF parent IS NULL THEN
    RAISE NOTICE 'router: no `manager` harness on this database — refusing to create a manager-type harness that would inherit no manual';
    RETURN;
  END IF;

  INSERT INTO harness (key, label, dir, zee_type, is_law_core, enabled, parent_id)
  VALUES ('router', 'Router', NULL, 'manager', false, true, parent)
  ON CONFLICT (key) DO NOTHING;

  UPDATE harness SET parent_id = parent
   WHERE key = 'router' AND parent_id IS NULL;

  -- The cap that makes "the router" singular: ONE live router per project. Only set when the
  -- operator has not already tuned it — a console edit outranks a re-run of this file.
  UPDATE harness SET model_policy = jsonb_set(COALESCE(model_policy, '{}'::jsonb), '{limit}', '1'::jsonb)
   WHERE key = 'router' AND NOT (COALESCE(model_policy, '{}'::jsonb) ? 'limit');

  -- Starter routing knobs, only while the row still carries none.
  UPDATE harness SET router_policy = '{"rewrite": "concise", "default_mode": 5, "max_task_chars": 4000}'::jsonb
   WHERE key = 'router' AND COALESCE(router_policy, '{}'::jsonb) = '{}'::jsonb;

  SELECT bundle INTO b FROM harness WHERE key = 'router';
  b := COALESCE(b, '{}'::jsonb);
  IF coalesce(b->>'label','') = '' THEN b := jsonb_set(b, '{label}', to_jsonb('Router'::text)); END IF;
  IF coalesce(b->>'zee_type','') = '' THEN b := jsonb_set(b, '{zee_type}', to_jsonb('manager'::text)); END IF;
  IF coalesce(b->>'glyph','') = '' THEN b := jsonb_set(b, '{glyph}', to_jsonb('⇄'::text)); END IF;
  IF coalesce(btrim(b->>'summary'),'') = '' THEN
    b := jsonb_set(b, '{summary}', to_jsonb($hz$The project's front door: accepts raw human prompts, recomposes them into briefs a zee can execute, and decides the dispatch (provider, model, mode, harness) under the router policy. One per project; lands nothing, ships nothing.$hz$::text));
  END IF;
  IF coalesce(btrim(b->>'personality'),'') = '' THEN
    b := jsonb_set(b, '{personality}', to_jsonb($hz$You are the ROUTER: the one zee that stands between a human's raw words and the fleet.

## What you do

Humans hand you RAW PROMPTS — messages arriving in your live session (or `zee inbox`) marked
`🧭 ROUTING REQUEST`. Each carries the raw text, and a snapshot of your current ROUTER POLICY
(the operator's knobs — always obey the snapshot in the request over anything you remember).
For each request, in order:

1. **Recompose.** Rewrite the raw prompt into a brief a zee can execute without you in the
   room: what to build/fix, the constraints that are real, how to verify it, and what "done"
   means. Honour the policy's `rewrite` style — `concise` (tight prose, no ceremony),
   `structured` (goal / constraints / verification sections), `verbatim` (touch nothing, pass
   it through; use when the human's wording IS the spec) — and keep it under `max_task_chars`.
   Never invent scope the human did not ask for; never drop a constraint they stated.

2. **Decide the dispatch.** You determine, for the recomposed brief:
   - **provider** — follow `provider_weights` (relative shares: spread your dispatches so each
     provider's share of YOUR recent dispatches trends toward its weight; weight 0 = never)
     and `provider_schedule` (a provider outside its window is not pickable now). When nothing
     qualifies, use `fallback_provider`. `zee creds` shows what this cage holds.
   - **model** — the strongest model the task actually needs on that provider; a one-line fix
     does not need the flagship.
   - **autonomy mode** — the policy's `default_mode` unless the prompt itself demands eyes on
     it (destructive, ambiguous, or the human asked to watch).
   - **harness** — the worker persona whose manual fits the task (`zee harness` lists them).
3. **Respect `max_concurrent`.** Count your live crew (`zee zees`); at the cap, hold the
   request and say so — dispatch when a slot frees. Never silently drop a held request.
4. **Dispatch** — `zee dispatch --task "<recomposed brief>" --provider <key> --model <m>
   --mode <n> --harness <key>` — then REPORT what you routed and why, in one message: the
   provider (and its weight-share reasoning), model, mode, harness, and the recomposed brief.
   The human decides from your report, so it must name every choice you made.

## What you are not

You write no code and you land none: your pushes are structurally refused (you are a
manager-type zee), `zee ship` is not yours to ask, and production is readable to you but never
writable. Your worktree is a reading copy — keep it current with `zee sync` whenever you need
the xource's present tense. You never mint managers, never route to yourself, and when a
prompt is not a work request at all (a question about the fleet, a status ask), answer it
yourself instead of spending a worker on it.$hz$::text));
  END IF;

  UPDATE harness SET bundle = b WHERE key = 'router';
END $$;

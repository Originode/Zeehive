-- THE OPERATOR'S PROVIDER PRIORITY SCHEME, ENCODED IN THE HARNESS ROWS.
--
-- The fleet has three ACTIVE providers — claude, deepseek, grok — and an operator scheme for them:
--   deepseek → the default for task deployments (worker harnesses: builders, fixers, testers, …)
--   claude   → managerial work: planning, routing, architecture
--   grok     → the in-between tier: well-scoped features, reviews
-- None of it was in the data. The full evaluation (every harness, its chain, its effective policy,
-- what was measured and what is deliberately NOT encoded) is docs/harness-model-policy-evaluation.md;
-- this header is the part you need to read the SQL.
--
-- WHAT WAS MEASURED, before this file:
--   • on a fresh database every harness carries model_policy '{}' (only `router` has {"limit":1}),
--     so EVERY zee — worker or manager, on every provider — resolves to `opus`: nobody chose it,
--     it is intake.js's code fallback DEFAULT_ZEE_MODEL. On deepseek and grok the adapter then
--     DROPS the claude alias (vendorModel(), lib/cxell-runtimes.js) and the vendor's own default
--     runs, while the zee row, the console and the cost-per-model telemetry all say `opus`.
--   • on the live database the operator's console edit sets zee-base.allow_models =
--     [deepseek-chat, deepseek-reasoner, fable, opus] — no grok model at all. Allow-lists INTERSECT
--     down the chain, so that is the WHOLE worker estate: an explicit `--model grok-4.5` on any
--     worker harness is refused by name, and a bare grok dispatch falls through to `opus` and is
--     recorded as `opus` while grok-4.5 runs.
--
-- WHY THIS IS `priorities` AND NOT `default_model` — the hazard that decides the shape:
--   `default_model` has NO provider dimension and outranks everything. Writing the scheme into it
--   ("workers default to deepseek-chat") resolves that string on every provider, and only claude
--   ALIASES are dropped by the other adapters — a foreign vendor id is passed straight through:
--     claude → `claude --bare … --model deepseek-chat`  → a dead turn on a model claude has not got
--     grok   → `grok -p … -m deepseek-chat`             → the grok CLI validates ids CLIENT-side and
--                                                          ends the turn ("unknown model id", 141)
--   `priorities` IS provider-aware (allowedModelsForProvider filters by the provider's own spec
--   rows), so each lane names ITS OWN model per provider — and what is recorded is what ran.
--
-- AND THE WART THAT COMES WITH IT: in resolveDispatchModel the mere EXISTENCE of priorities is a
-- "model preference", and a NAMED model always beats the '' (vendor-default) spec row. So the two
-- retired providers (kimi, openai) also stop resolving to '' — and without a number the pick would
-- be an alphabetical accident (kimi-for-coding, gpt-5.4-mini, by label sort). Each lane therefore
-- names ONE deliberate model for those two as well. Follow-up §6.2 of the doc: the resolver should
-- keep a provider's own default when the policy expresses no preference FOR THAT PROVIDER.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO:
--   • it adds NO refusal. Not one allowance is removed, no allow_providers list is created, no
--     bound is set. "deepseek is the DEFAULT for workers" is a statement about PROVIDER selection,
--     and the harness layer can only FORBID a provider (allow_providers), never prefer one —
--     decideDispatchProvider picks claude whenever a claude account is connected. Encoding it as a
--     restriction would refuse live, deliberate claude dispatches of worker harnesses. The honest
--     fix is a new `prefer_providers` knob (doc §6.1); until then the shares live where they CAN
--     be expressed: the router's own router_policy, below.
--   • it does not touch per-project harnesses (every statement is guarded `project_id IS NULL`),
--     `core` (the law layer carries no policy and is never consulted), or `hermes` (a root worker
--     harness with NO parent — it inherits nothing, and reaching it would mean copying the lane
--     into it; re-parenting is a structural change with its own evidence, doc §6.3).
--
-- FORM: guarded, surgical, idempotent on a fresh database and on one an operator has already
-- tuned. Priorities merge PER KEY with the existing object winning (`want || existing`), so a
-- number a human typed in the console survives; allow-lists are only ever UNIONED, and only where
-- a non-empty list already exists (creating one where there is none would be a NEW restriction);
-- every UPDATE re-runs to a no-op. The one thing removed is a `default_model` whose value is
-- exactly 'opus' on a lane ROOT — anchored on that exact value, because the lane priorities now
-- say the same thing per provider and say it truthfully (on claude the resolution is unchanged).

-- ── 1. THE WORKER LANE (`zee-base`) — deepseek is the everyday model ──────────────────────────
--   deepseek: deepseek-chat (fast, everyday coding) over deepseek-reasoner (kept for hard work)
--   grok:     grok-4.5 — the middle tier, now REACHABLE by name for every worker
--   claude:   opus, when a worker is deliberately dispatched on claude
--   kimi/openai (retired): one deliberate pick each, so the label sort does not decide
DO $mig$
DECLARE
  want jsonb := '{"deepseek-chat":5,"deepseek-reasoner":3,"grok-4.5":5,"opus":5,"k3":5,"gpt-5.6-terra":5}'::jsonb;
  n    int;
BEGIN
  UPDATE harness
     SET model_policy = jsonb_set(COALESCE(model_policy,'{}'::jsonb), '{priorities}',
                                  want || COALESCE(model_policy->'priorities','{}'::jsonb))
   WHERE key = 'zee-base' AND project_id IS NULL
     AND (want || COALESCE(model_policy->'priorities','{}'::jsonb))
         IS DISTINCT FROM COALESCE(model_policy->'priorities','{}'::jsonb);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '147: worker lane priorities on zee-base — % row(s) changed', n;
END $mig$;

-- ── 2. THE MANAGER LANE (`manager`) — claude, and the thinking model everywhere else ──────────
-- Planning, routing and architecture get the top tier of whatever provider they land on. Note
-- `fable` is NOT promoted: its own spec says "unproven on unattended zee work", and it stays
-- allowed (never removed) but never wins a bare dispatch.
DO $mig$
DECLARE
  want jsonb := '{"opus":9,"deepseek-reasoner":9,"deepseek-chat":3,"grok-4.5":9,"k3":9,"gpt-5.6-sol":9}'::jsonb;
  n    int;
BEGIN
  UPDATE harness
     SET model_policy = jsonb_set(COALESCE(model_policy,'{}'::jsonb), '{priorities}',
                                  want || COALESCE(model_policy->'priorities','{}'::jsonb))
   WHERE key = 'manager' AND project_id IS NULL
     AND (want || COALESCE(model_policy->'priorities','{}'::jsonb))
         IS DISTINCT FROM COALESCE(model_policy->'priorities','{}'::jsonb);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '147: manager lane priorities on manager — % row(s) changed', n;
END $mig$;

-- ── 3. THE TWO LEAVES THE SCHEME NAMES BY EXCEPTION ───────────────────────────────────────────
-- dev-architect is a WORKER whose work the scheme puts in the claude tier (architecture), and
-- dev-reviewer is the archetype of the middle tier (reviews). Leaf priorities are leaf-wins per
-- model key, so each of these overrides only the models it names and inherits the rest of the
-- worker lane. dev-reviewer on claude therefore resolves `sonnet`, not `opus` — that is the
-- scheme's middle tier applied to claude, and it is the one downgrade in this file.
DO $mig$
DECLARE
  r      record;
  n      int;
  wanted CONSTANT jsonb := jsonb_build_object(
    'dev-architect', '{"opus":9,"deepseek-reasoner":9,"deepseek-chat":1,"grok-4.5":9}'::jsonb,
    'dev-reviewer',  '{"grok-4.5":9,"sonnet":9,"opus":3,"deepseek-chat":9,"deepseek-reasoner":3}'::jsonb);
BEGIN
  FOR r IN SELECT * FROM jsonb_each(wanted) LOOP
    UPDATE harness
       SET model_policy = jsonb_set(COALESCE(model_policy,'{}'::jsonb), '{priorities}',
                                    r.value || COALESCE(model_policy->'priorities','{}'::jsonb))
     WHERE key = r.key AND project_id IS NULL
       AND (r.value || COALESCE(model_policy->'priorities','{}'::jsonb))
           IS DISTINCT FROM COALESCE(model_policy->'priorities','{}'::jsonb);
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE '147: leaf priorities on % — % row(s) changed', r.key, n;
  END LOOP;
END $mig$;

-- ── 4. GROK, REACHABLE BY NAME — additive union into the two LANE ROOTS ───────────────────────
-- Only where a non-empty allow_models already exists: an empty list means "no restriction", and
-- writing one would FORBID everything not named — the opposite of this file's contract. A leaf an
-- operator has restricted by hand is left exactly as they set it (the chain intersection still
-- applies to it), which is why this names the two roots rather than sweeping the estate.
DO $mig$
DECLARE
  r    record;
  cur  jsonb;
  add  text;
BEGIN
  FOR r IN SELECT key, model_policy FROM harness
            WHERE key IN ('zee-base','manager') AND project_id IS NULL LOOP
    -- COALESCE to a jsonb null, not left as SQL NULL: an absent key makes every comparison below
    -- NULL, and `IF NULL THEN` is false — the block would then do the right thing SILENTLY, which
    -- is how a guard stops being readable evidence that it ran.
    cur := COALESCE(r.model_policy->'allow_models', 'null'::jsonb);
    IF jsonb_typeof(cur) IS DISTINCT FROM 'array' OR jsonb_array_length(cur) = 0 THEN
      RAISE NOTICE '147: % has no allow_models restriction — grok is already allowed, nothing to union', r.key;
      CONTINUE;
    END IF;
    FOREACH add IN ARRAY ARRAY['grok-4.5'] LOOP
      IF NOT (cur @> to_jsonb(ARRAY[add])) THEN
        cur := cur || to_jsonb(ARRAY[add]);
        RAISE NOTICE '147: % allow_models += %', r.key, add;
      END IF;
    END LOOP;
    UPDATE harness SET model_policy = jsonb_set(model_policy, '{allow_models}', cur)
     WHERE key = r.key AND project_id IS NULL
       AND model_policy->'allow_models' IS DISTINCT FROM cur;
  END LOOP;
END $mig$;

-- ── 5. A LEGACY `default_model = 'opus'` ON A LANE ROOT ───────────────────────────────────────
-- Anchored on that EXACT value (the 110-era way of saying "flagship"), and only on the two lane
-- roots. It contradicts §1–3: default_model outranks priorities and carries no provider, so on
-- deepseek/grok it resolves `opus`, the alias is dropped and the row records a model that never
-- ran. On claude the resolution is unchanged (opus is the lane's own top priority there). Any
-- other value is a deliberate operator choice and is left alone, loudly.
DO $mig$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT key, model_policy->>'default_model' AS dm FROM harness
            WHERE key IN ('zee-base','manager') AND project_id IS NULL
              AND model_policy ? 'default_model' LOOP
    IF r.dm = 'opus' THEN
      UPDATE harness SET model_policy = model_policy - 'default_model'
       WHERE key = r.key AND project_id IS NULL;
      RAISE NOTICE '147: % default_model ''opus'' removed — the lane priorities now say it per provider', r.key;
    ELSE
      RAISE NOTICE '147: % keeps default_model "%" (not the 110-era anchor) — left to the operator', r.key, r.dm;
    END IF;
  END LOOP;
END $mig$;

-- ── 6. THE ROUTER'S SHARES — the one place a PROVIDER preference can be expressed today ───────
-- router_policy.provider_weights is the operator knob the router zee is briefed to obey, and it is
-- the only lever in the estate that can say "deepseek by default, grok in between, claude for the
-- managerial end" without forbidding anything. Seeded as the SHAPE of the scheme (6/3/1), not as a
-- measurement — retune it from what the router actually dispatches. Missing keys only: a weight an
-- operator has already tuned outranks this file.
DO $mig$
DECLARE
  n int;
BEGIN
  UPDATE harness
     SET router_policy = COALESCE(router_policy,'{}'::jsonb)
                      || (jsonb_build_object('provider_weights', '{"deepseek":6,"grok":3,"claude":1}'::jsonb,
                                             'fallback_provider', 'deepseek')
                          - ARRAY(SELECT jsonb_object_keys(COALESCE(router_policy,'{}'::jsonb))))
   WHERE key = 'router' AND project_id IS NULL
     AND NOT (COALESCE(router_policy,'{}'::jsonb) ?& ARRAY['provider_weights','fallback_provider']);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '147: router provider shares — % row(s) changed', n;
END $mig$;

-- ── 7. THE MANUAL STILL SAID THE CAGE RUNS "claude, codex or kimi" ────────────────────────────
-- Drift of exactly the class 115 fixed: the first paragraph of the manual is authoritative by its
-- own words, and a deepseek or grok zee opened it and read that it was something else. Anchored,
-- through harness_memory_put (house rule 9); an anchor that has moved is a NOTICE and a no-op.
DO $mig$
DECLARE
  txt text;
  old_cli text := 'an autonomous agent running your provider''s own coding CLI — `claude`,'
               || E'\n`codex` or `kimi`, whichever the dispatch resolved to — *inside* a per-xell container';
  new_cli text := 'an autonomous agent running your provider''s own coding CLI — `claude`,'
               || E'\n`codex`, `kimi` or `grok`, whichever the dispatch resolved to (a DeepSeek dispatch runs the'
               || E'\n`claude` CLI against DeepSeek''s own Anthropic-compatible endpoint) — *inside* a per-xell container';
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE '147: zee-base has no cxell-zee-manual.md — nothing to patch';
  ELSIF position(new_cli in txt) > 0 THEN
    RAISE NOTICE '147: the manual already names every CLI a cage resolves to — no-op';
  ELSIF position(old_cli in txt) = 0 THEN
    RAISE NOTICE '147: the CLI-list anchor has moved in cxell-zee-manual.md — left untouched (patch it by hand)';
  ELSE
    PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', replace(txt, old_cli, new_cli));
    RAISE NOTICE '147: cxell-zee-manual.md — the CLI list now names grok and deepseek';
  END IF;
END $mig$;

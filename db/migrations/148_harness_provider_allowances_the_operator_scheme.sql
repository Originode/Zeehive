-- THE PROVIDER ALLOWANCES: the operator's ruling, encoded as REFUSALS.
--
-- 147 encoded the three-provider scheme as far as data could express it WITHOUT forbidding
-- anything, and reported the gap it could not close (docs/harness-model-policy-evaluation.md, F6):
-- a harness row can FORBID a provider (allow_providers) but never PREFER one, so "deepseek is the
-- default for task deployments" stayed unencoded — decideDispatchProvider picks claude whenever a
-- claude account is connected.
--
-- The operator has now RULED on exactly that, and it settles the design:
--
--     "yes my intention is that a harness row can forbid a provider from wearing it.
--      the weights are only for those allowed providers."
--
-- So the persona IS the refusal, and the router's provider_weights (147) spread a choice only
-- across what the chosen harness already allows. This migration writes that ruling into the rows:
--
--   zee-base        → claude, deepseek, grok   the three ACTIVE providers. The worker root, so this
--                                              is where the retired vendors (openai, kimi) leave the
--                                              worker estate — allow-lists INTERSECT down the chain,
--                                              and the root must still allow every lane its
--                                              descendants need.
--   manager         → claude                   managerial work: planning, routing, the estate.
--                                              Inherited by dev-lead, master, queenzee-minister and
--                                              the router.
--   dev-builder     → deepseek                 the DEFAULT lane: task deployments.
--   dev-fixer       → deepseek
--   dev-tester      → deepseek
--   dev-scribe      → deepseek
--   dev-scout       → deepseek
--   dev-shipwright  → deepseek
--   dev-reviewer    → grok                     the middle tier: reviews.
--   dev-architect   → claude                   architecture is named in the managerial tier.
--
-- WHAT THIS CHANGES FOR A HUMAN, said plainly: a dispatch that names a provider the persona forbids
-- is now REFUSED at spawn with a sentence naming the persona ("harness "dev-builder" allows only
-- deepseek — a zee cannot run on provider "claude""), and the console's dispatch composer greys that
-- provider out with the same reason. It is enforced at DISPATCH/assign time only: a zee already
-- running is untouched, and no gate semantics move.
--
-- WHAT IT DELIBERATELY LEAVES ALONE:
--   • `trainer`, `teacher`, `zeetest` keep the root's three-provider allowance. The scheme names
--     "task deployments", "managerial work" and "the middle tier"; the estate personas (which judge
--     and edit harness text, and are workers by type) are none of those three, and a refusal
--     invented where the scheme is silent is a refusal nobody can defend. One line from the operator
--     settles it, and it is one console edit either way.
--   • `hermes` — a root worker harness with NO parent, so it inherits nothing and this scheme cannot
--     reach it without COPYING the root's list into it. Copy rot is how two versions of one rule
--     start; the fix is re-parenting, which changes what a hermes wearer is briefed with and needs
--     its own evidence (doc §6.3).
--   • `core` (the law layer carries no policy) and every per-project harness (`project_id IS NULL`
--     guards every statement — a project's personas belong to their project).
--   • Any row where a HUMAN has already set allow_providers: filled only where empty, and said out
--     loud when skipped. A console edit outranks this file.
--
-- FORM: guarded, idempotent, safe on a fresh database and on a tuned one; re-running is a no-op.

-- ── 1. THE ALLOWANCES ─────────────────────────────────────────────────────────────────────────
DO $mig$
DECLARE
  r      record;
  want   jsonb;
  n      int;
  lanes  CONSTANT jsonb := jsonb_build_object(
    'zee-base',       '["claude","deepseek","grok"]'::jsonb,
    'manager',        '["claude"]'::jsonb,
    'dev-builder',    '["deepseek"]'::jsonb,
    'dev-fixer',      '["deepseek"]'::jsonb,
    'dev-tester',     '["deepseek"]'::jsonb,
    'dev-scribe',     '["deepseek"]'::jsonb,
    'dev-scout',      '["deepseek"]'::jsonb,
    'dev-shipwright', '["deepseek"]'::jsonb,
    'dev-reviewer',   '["grok"]'::jsonb,
    'dev-architect',  '["claude"]'::jsonb);
BEGIN
  FOR r IN SELECT * FROM jsonb_each(lanes) LOOP
    want := r.value;
    -- fill ONLY where the row expresses no allowance of its own
    UPDATE harness
       SET model_policy = jsonb_set(COALESCE(model_policy,'{}'::jsonb), '{allow_providers}', want)
     WHERE key = r.key AND project_id IS NULL
       AND (jsonb_typeof(model_policy->'allow_providers') IS DISTINCT FROM 'array'
            OR jsonb_array_length(model_policy->'allow_providers') = 0);
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN
      PERFORM 1 FROM harness WHERE key = r.key AND project_id IS NULL;
      IF FOUND THEN
        RAISE NOTICE '148: % already carries its own allow_providers (%) — left to the operator',
          r.key, (SELECT model_policy->>'allow_providers' FROM harness WHERE key = r.key AND project_id IS NULL);
      ELSE
        RAISE NOTICE '148: no harness "%" on this database — skipped', r.key;
      END IF;
    ELSE
      RAISE NOTICE '148: % may now run on % only', r.key, want #>> '{}';
    END IF;
  END LOOP;
END $mig$;

-- ── 2. THE PRIORITIES THAT JUST DIED WITH THEM ────────────────────────────────────────────────
-- 147 named one deliberate model per provider, including the two retired vendors, because ANY
-- priorities switch every provider off its '' vendor default and the pick would otherwise be an
-- alphabetical accident. Now that a row forbids those providers outright, those entries can never
-- be read again — dead text a wearer's policy still carries. Dropped, but ONLY where the row's own
-- allow_providers proves the model unreachable: a priority whose model has no spec at all is left
-- alone (unknown is not dead), and nothing is dropped from a provider the row still allows.
DO $mig$
DECLARE
  r       record;
  keep    jsonb;
  dropped text[];
BEGIN
  FOR r IN SELECT id, key, model_policy FROM harness
            WHERE project_id IS NULL
              AND jsonb_typeof(model_policy->'allow_providers') = 'array'
              AND jsonb_array_length(model_policy->'allow_providers') > 0
              AND jsonb_typeof(model_policy->'priorities') = 'object' LOOP
    SELECT COALESCE(jsonb_object_agg(p.k, p.v) FILTER (WHERE p.alive), '{}'::jsonb),
           COALESCE(array_agg(p.k) FILTER (WHERE NOT p.alive), ARRAY[]::text[])
      INTO keep, dropped
      FROM (
        SELECT e.key AS k, e.value AS v,
               (NOT EXISTS (SELECT 1 FROM ai_model_spec s WHERE s.key = e.key AND s.enabled)
                OR EXISTS (SELECT 1 FROM ai_model_spec s
                            WHERE s.key = e.key AND s.enabled
                              AND r.model_policy->'allow_providers' @> to_jsonb(ARRAY[s.provider]))) AS alive
          FROM jsonb_each(COALESCE(r.model_policy->'priorities','{}'::jsonb)) e) p;
    IF COALESCE(array_length(dropped, 1), 0) > 0 THEN
      UPDATE harness SET model_policy = jsonb_set(model_policy, '{priorities}', keep) WHERE id = r.id;
      RAISE NOTICE '148: % — dropped priorities no allowed provider can reach: %',
        r.key, array_to_string(dropped, ', ');
    END IF;
  END LOOP;
END $mig$;

-- ── 3. THE ROUTER WAS BRIEFED TO CHOOSE A PROVIDER BY WEIGHT ALONE ────────────────────────────
-- Its persona (139) says "provider — follow provider_weights … and provider_schedule", which was
-- true while no harness forbade anything. After §1 it is prose this migration contradicts: a router
-- obeying it will hand a persona a provider its row refuses, and the dispatch dies at spawn with a
-- sentence about the harness. The operator's ruling in one clause: the harness decides, the weights
-- spread the choice AMONG WHAT IT ALLOWS. Anchored replace of that one bullet; an anchor that has
-- moved is a NOTICE and a no-op.
DO $mig$
DECLARE
  b   jsonb;
  txt text;
  old_p text := '   - **provider** — follow `provider_weights` (relative shares: spread your dispatches so each'
             || E'\n     provider''s share of YOUR recent dispatches trends toward its weight; weight 0 = never)'
             || E'\n     and `provider_schedule` (a provider outside its window is not pickable now). When nothing'
             || E'\n     qualifies, use `fallback_provider`. `zee creds` shows what this cage holds.';
  new_p text := '   - **provider** — the HARNESS decides first. A persona''s `allow_providers` is a REFUSAL, not'
             || E'\n     a hint: a dispatch naming a provider its harness forbids dies at spawn with a sentence'
             || E'\n     about the persona, so read the harness''s allowance before you weigh anything. Then'
             || E'\n     spread your choice AMONG WHAT IT ALLOWS — `provider_weights` (relative shares: each'
             || E'\n     provider''s share of YOUR recent dispatches trends toward its weight; weight 0 = never)'
             || E'\n     and `provider_schedule` (a provider outside its window is not pickable now). A persona'
             || E'\n     that allows exactly one provider has already decided, and the weights say nothing about'
             || E'\n     it. When nothing qualifies, use `fallback_provider` — and when the harness forbids that'
             || E'\n     too, pick from what it allows and SAY so in your report. `zee creds` shows what this'
             || E'\n     cage holds.';
BEGIN
  SELECT bundle INTO b FROM harness WHERE key = 'router' AND project_id IS NULL;
  IF b IS NULL THEN
    RAISE NOTICE '148: no router harness on this database — nothing to patch';
    RETURN;
  END IF;
  txt := COALESCE(b->>'personality', '');
  IF position(new_p in txt) > 0 THEN
    RAISE NOTICE '148: the router already reads the harness allowance first — no-op';
  ELSIF position(old_p in txt) = 0 THEN
    RAISE NOTICE '148: the router''s provider bullet has moved — left untouched (patch it by hand)';
  ELSE
    UPDATE harness SET bundle = jsonb_set(bundle, '{personality}', to_jsonb(replace(txt, old_p, new_p)))
     WHERE key = 'router' AND project_id IS NULL;
    RAISE NOTICE '148: the router now weighs providers only among the ones the harness allows';
  END IF;
END $mig$;

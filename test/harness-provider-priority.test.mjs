// THE OPERATOR'S 3-PROVIDER SCHEME, AS THE HARNESS ROWS ACTUALLY RESOLVE IT (migrations 147 + 148).
//
// The fleet runs three ACTIVE providers, and the operator's scheme for them is:
//   deepseek → the default for task deployments (builders, fixers, testers, scribes, scouts, …)
//   claude   → managerial work: planning, routing, architecture, the estate
//   grok     → the in-between tier: well-scoped features, reviews
// and the operator's ruling on HOW it binds: "a harness row can forbid a provider from wearing it.
// the weights are only for those allowed providers."
//
// So the persona is the REFUSAL (148: allow_providers per lane) and the model within a lane is a
// per-provider PRIORITY (147 — never `default_model`, which carries no provider and would send
// `--model deepseek-chat` to the claude and grok CLIs; the reasoning is 147's header and
// docs/harness-model-policy-evaluation.md).
//
// What this pins, all of it read back from a real database:
//   1. every lane's ALLOWANCE — the providers a wearer may run on, and the sentence naming the
//      persona when a dispatch names one it may not;
//   2. every lane's MODEL on each provider it allows — and that the resolved name is one that
//      provider actually offers (before this, every harness resolved `opus` everywhere and the
//      adapter silently ran something else, so the zee row and the cost telemetry both lied);
//   3. a lane can always name a model: no allowed provider is left with an empty model set;
//   4. TKT-97-BD32 still green — no allow-list names a model no provider carries, and an explicit
//      model the provider does not offer is still refused loudly;
//   5. the router is briefed to read the allowance BEFORE the weights (148 §3) — otherwise it
//      routes dispatches that die at spawn;
//   6. both migrations are IDEMPOTENT, and their guards hold over an operator's console edit.
//
// Needs DATABASE_URL. It RE-APPLIES 147 and 148 (that is check 6) and edits `zee-base`'s policy to
// simulate a console edit, restoring it in the finally — so run it against a throwaway db
// (`zee db-sandbox --migrate`), never against production.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { q, one, pool } from '../server/src/db/pool.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const M147 = 'db/migrations/147_provider_priority_scheme_in_harness_model_policies.sql';
const M148 = 'db/migrations/148_harness_provider_allowances_the_operator_scheme.sql';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

const { effectiveModelPolicy, resolveDispatchModel, allowedModelsForProvider, modelSpecs, modelSpecFor } =
  await import('../server/src/lib/model-policy.js');
const { normalizeRouterPolicy } = await import('../server/src/lib/router-policy.js');
const { decideDispatchProvider } = await import('../server/src/lib/provider-tokens.js');

const ALL = ['claude', 'deepseek', 'grok', 'openai', 'kimi'];   // every provider with a runtime
const harness = (key) => one(`SELECT * FROM harness WHERE key=$1 AND project_id IS NULL`, [key]);
const bare = (row, provider) =>
  resolveDispatchModel({ harnessRow: row, provider, requestedModel: null, fallbackModel: 'opus' })
    .then((r) => ({ model: r.model }), (e) => ({ refused: e.message }));

// THE SCHEME, as one table: which providers each persona may wear, and what a bare dispatch runs
// on each of them. Everything not listed under `on` must be REFUSED by name.
const SCHEME = {
  // the worker root — the three active providers, so every lane below it stays expressible
  'zee-base':       { on: { claude: 'opus', deepseek: 'deepseek-chat', grok: 'grok-4.5' } },
  'dev-base':       { on: { claude: 'opus', deepseek: 'deepseek-chat', grok: 'grok-4.5' } },
  // the DEFAULT lane: task deployments
  'dev-builder':    { on: { deepseek: 'deepseek-chat' } },
  'dev-fixer':      { on: { deepseek: 'deepseek-chat' } },
  'dev-tester':     { on: { deepseek: 'deepseek-chat' } },
  'dev-scribe':     { on: { deepseek: 'deepseek-chat' } },
  'dev-scout':      { on: { deepseek: 'deepseek-chat' } },
  'dev-shipwright': { on: { deepseek: 'deepseek-chat' } },
  // the middle tier
  'dev-reviewer':   { on: { grok: 'grok-4.5' } },
  // architecture is named in the managerial tier
  'dev-architect':  { on: { claude: 'opus' } },
  // the manager lane — planning, routing, the estate
  'manager':           { on: { claude: 'opus' } },
  'dev-lead':          { on: { claude: 'opus' } },
  'router':            { on: { claude: 'opus' } },
  'master':            { on: { claude: 'opus' } },
  'queenzee-minister': { on: { claude: 'opus' } },
  // the estate personas the scheme does not name: the root's allowance, deliberately unnarrowed
  'trainer':        { on: { claude: 'opus', deepseek: 'deepseek-chat', grok: 'grok-4.5' } },
  'teacher':        { on: { claude: 'opus', deepseek: 'deepseek-chat', grok: 'grok-4.5' } },
};

let savedZeeBase = null;
try {
  section('147 and 148 are in the ledger');
  const applied = await q(`SELECT filename FROM schema_migrations WHERE filename LIKE '147_%' OR filename LIKE '148_%'`);
  ok(applied.length === 2, `both migrations applied (${applied.length}/2 — if this fails: npm run db:migrate)`);

  // ── 1 + 2. the allowance, and the model inside it ──
  //
  // A LANE IS WHAT 148 WROTE **UNLESS A HUMAN HAS SET THEIR OWN** — and that is not a caveat, it is
  // the migration's contract: §1 fills allow_providers only where the row expresses none, so a
  // console edit outranks the file. This test asserting the scheme unconditionally would therefore
  // turn a RESPECTED operator edit into a red build, which is exactly the failure that earned this
  // comment: the live meta-DB carries `manager = [claude, deepseek]` (set by a human before 148),
  // 148 skipped it with a NOTICE, and a reflection that had only ever measured a FRESH database
  // reported "manager is claude-only" to the fleet as though it were true everywhere.
  //
  // So: where the effective allowance still IS the scheme, hold it to the scheme. Where a human has
  // overridden it, say so out loud and hold it to the INVARIANTS that must be true either way —
  // every allowed provider resolves to a model that provider actually offers, and every provider
  // outside the allowance is refused BY NAME.
  section('every lane: what it may wear, and what it runs there');
  let overrides = 0;
  for (const [key, want] of Object.entries(SCHEME)) {
    const row = await harness(key);
    if (!row) { ok(false, `${key} exists on this database`); continue; }
    const eff = await effectiveModelPolicy(row);
    const scheme = Object.keys(want.on);
    const allowed = eff.allow_providers.length ? eff.allow_providers : ALL;
    const isScheme = JSON.stringify([...allowed].sort()) === JSON.stringify([...scheme].sort());
    const got = [];
    let good = allowed.length > 0;
    for (const p of ALL) {
      const r = await bare(row, p);
      if (allowed.includes(p)) {
        // the scheme's model where the scheme's allowance stands; otherwise the invariant: a real
        // model this provider offers (never a claude alias the adapter would silently swap)
        if (isScheme ? r.model !== want.on[p] : !(await modelSpecFor(p, r.model))) good = false;
        got.push(`${p}→${r.model ?? 'REFUSED'}`);
      } else if (!r.refused || !r.refused.includes(`harness "${key}"`) || !/allows only/.test(r.refused)) {
        good = false;   // outside the allowance: refused, in a sentence that names the persona
      }
    }
    if (!isScheme) overrides++;
    ok(good, `${key.padEnd(18)} ${got.join('  ')}  ·  ${ALL.filter((p) => !allowed.includes(p)).join('/') || 'nothing'} refused by name`
       + (isScheme ? '' : `  ⟵ OPERATOR OVERRIDE (scheme said ${scheme.join('/')}) — 148 fills only where empty`));
  }
  ok(true, `${overrides} lane(s) carry a human's own allowance — the migration left them alone, by design`);

  // ── 3. no lane is a dead end ──
  section('every allowed provider can still name a model (no empty lane)');
  const fleet = await q(`SELECT * FROM harness WHERE project_id IS NULL AND enabled AND NOT is_law_core ORDER BY key`);
  for (const row of fleet) {
    const eff = await effectiveModelPolicy(row);
    const provs = eff.allow_providers.length ? eff.allow_providers : ALL;
    let good = true;
    for (const p of provs) {
      const models = await allowedModelsForProvider(eff, p);
      if (!models.filter((m) => m.key !== '').length) good = false;
    }
    ok(good, `${row.key}: allowed on [${provs.join(', ')}] and each one offers a named model`);
  }

  // ── 3b. the provider DECISION agrees with the persona (the picker and the spawn cannot differ) ──
  section('decideDispatchProvider obeys the persona');
  const accounts = [{ provider: 'claude' }, { provider: 'deepseek' }, { provider: 'grok' }];
  for (const key of ['dev-builder', 'dev-reviewer', 'dev-architect', 'manager']) {
    const eff = await effectiveModelPolicy(await harness(key));
    const d = decideDispatchProvider({ allowProviders: eff.allow_providers, accounts });
    ok(d.provider === eff.allow_providers[0],
       `${key}: a bare dispatch with all three accounts connected goes to ${d.provider} (${d.reason})`);
  }
  const explicit = decideDispatchProvider({ requested: 'claude', allowProviders: ['deepseek'], accounts });
  ok(explicit.provider === 'claude' && explicit.reason === 'requested',
     'an EXPLICIT provider is still an instruction — the refusal then names the harness at spawn');

  // ── 4. TKT-97-BD32 ──
  section('TKT-97-BD32 is still green');
  const specs = await modelSpecs({ enabledOnly: true });
  const anyProvider = new Set(specs.map((s) => s.key));
  for (const row of fleet) {
    const eff = await effectiveModelPolicy(row);
    const orphan = (eff.allow_models || []).filter((m) => !anyProvider.has(m));
    ok(orphan.length === 0, `${row.key}: every model in its effective allow-list has a spec (${orphan.join(', ') || 'none orphaned'})`);
  }
  const fableOnDeepseek = await resolveDispatchModel({
    harnessRow: await harness('zee-base'), provider: 'deepseek', requestedModel: 'fable', fallbackModel: null })
    .catch((e) => e.message);
  ok(/not offered by provider "deepseek"/.test(fableOnDeepseek),
     'an explicit claude-only model on deepseek is still REFUSED loudly (the refusal is the feature)');
  const grokByName = await resolveDispatchModel({
    harnessRow: await harness('dev-reviewer'), provider: 'grok', requestedModel: 'grok-4.5', fallbackModel: null })
    .catch((e) => e.message);
  ok(grokByName.model === 'grok-4.5', 'the middle tier can be dispatched on grok-4.5 BY NAME (the defect 147 fixed)');

  // ── 5. the router reads the allowance before the weights ──
  section('the router policy and the router persona agree with the ruling');
  const router = await harness('router');
  const rp = normalizeRouterPolicy(router?.router_policy);
  ok(rp.provider_weights?.deepseek > rp.provider_weights?.grok
     && rp.provider_weights?.grok > rp.provider_weights?.claude,
     `provider_weights order deepseek > grok > claude (${JSON.stringify(rp.provider_weights)})`);
  ok(rp.fallback_provider === 'deepseek', 'fallback_provider is deepseek — the default lane');
  ok(rp.rewrite === 'concise' && rp.default_mode === 5, "139's knobs survive (147/148 fill MISSING keys only)");
  const persona = router?.bundle?.personality || '';
  ok(/the HARNESS decides first/.test(persona) && /AMONG WHAT IT ALLOWS/.test(persona),
     'the router is briefed to read allow_providers BEFORE weighing anything');

  // ── 5b. the manual is true about the providers ──
  section('the manual is true about the providers');
  const manual = await one(`SELECT harness_memory_get('zee-base','cxell-zee-manual.md') AS t`);
  ok(/`codex`, `kimi` or `grok`/.test(manual?.t || ''), 'the CLI list names grok');
  ok((manual?.t || '').includes('zee db-sandbox'), 'and the rest of the manual is intact (no rebuilt memory array)');

  // ── 6. idempotent, and the guards are real ──
  section('re-applying 147 + 148 over a console edit');
  savedZeeBase = (await harness('zee-base')).model_policy;
  const edited = {
    ...savedZeeBase,
    priorities: { ...(savedZeeBase.priorities || {}), 'deepseek-chat': 42 },
    allow_providers: ['deepseek', 'grok'],                                  // an operator narrowing
    allow_models: ['deepseek-chat', 'deepseek-reasoner', 'fable', 'opus'],  // the live db's list
    default_model: 'deepseek-reasoner',
  };
  await q(`UPDATE harness SET model_policy=$1::jsonb WHERE key='zee-base' AND project_id IS NULL`,
          [JSON.stringify(edited)]);
  const sql147 = readFileSync(join(ROOT, M147), 'utf8');
  const sql148 = readFileSync(join(ROOT, M148), 'utf8');
  await q(sql147); await q(sql148);
  let after = (await harness('zee-base')).model_policy;
  ok(after.priorities['deepseek-chat'] === 42, "an operator's tuned priority is NOT clobbered");
  ok(JSON.stringify(after.allow_providers) === '["deepseek","grok"]',
     "an operator's OWN allow_providers is left exactly as they set it");
  ok((after.allow_models || []).includes('grok-4.5'), 'grok-4.5 is unioned into a non-empty allow-list');
  ok(['deepseek-chat', 'deepseek-reasoner', 'fable', 'opus'].every((m) => after.allow_models.includes(m)),
     '…and not one existing allowance is removed');
  ok(after.default_model === 'deepseek-reasoner', 'a default_model that is not the 110-era anchor is left to the operator');
  ok(!('opus' in after.priorities), '…while a priority no allowed provider can reach is dropped (opus, with claude forbidden)');
  const snapshot = JSON.stringify(after);
  await q(sql147); await q(sql148);
  after = (await harness('zee-base')).model_policy;
  ok(JSON.stringify(after) === snapshot, 'applying both a second time changes nothing (idempotent)');
} catch (e) {
  console.error('\n✗ FAIL — the test threw:', e.message);
  fail++;
} finally {
  if (savedZeeBase) {
    await q(`UPDATE harness SET model_policy=$1::jsonb WHERE key='zee-base' AND project_id IS NULL`,
            [JSON.stringify(savedZeeBase)]).catch(() => {});
  }
  await pool.end().catch(() => {});
}

console.log(fail ? `\n✗ ${fail} check(s) failed\n` : '\nAll checks passed\n');
process.exit(fail ? 1 : 0);

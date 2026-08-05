// MODEL POLICY + AI MODEL SPECS — migration 110, exercised against a real database.
//
// Two halves of one feature:
//   (A) ai_model_spec — the meta-DB registry of models the fleet can dispatch on, with the
//       parameters that matter for choosing one (context window, parameter count). Seeded by the
//       migration from today's code-default lists.
//   (B) harness.model_policy — per-harness RESTRICTION KNOBS (allow_providers / allow_models,
//       context & parameter bounds, per-model deployment priorities, default_model) enforced at
//       dispatch. A harness inherits policy from its parent chain exactly like persona/skills.
//
// The load-bearing contracts:
//   • a bare dispatch (no explicit model) resolves to the harness's default_model, else the
//     highest-priority ALLOWED model for the provider;
//   • an EXPLICIT model a policy forbids is REFUSED with a sentence naming the harness (never
//     silently run);
//   • restriction lists INTERSECT down the parent chain (a child cannot widen what its parent
//     forbids), scalars and priorities are leaf-wins;
//   • context/parameter bounds are measured against ai_model_spec — a model whose spec does not
//     fit is refused.
//
// Needs DATABASE_URL (this repo's .zeehive.env). If ai_model_spec is missing, your db is behind
// the ledger — run `npm run db:migrate` before reading a failure here as a bug.
import { q, one, pool } from '../server/src/db/pool.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const {
  normalizePolicy, mergePolicies, effectiveModelPolicy, modelSpecs, modelSpecFor,
  specInBounds, allowedModelsForProvider, resolveDispatchModel,
} = await import('../server/src/lib/model-policy.js');

const KEY = 'zz-model-policy-probe';          // throwaway harness row, deleted in the finally
const cleanupKeys = [];                        // every row this test creates, cleaned in the finally
let seq = 0;                                   // a fresh key per row so tests never collide
const mkHarness = async (policy, parent = null) => {
  seq++;
  const k = `${KEY}-${seq}`;
  const row = await one(
    `INSERT INTO harness (key, label, zee_type, parent_id, model_policy)
     VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING *`,
    [k, 'model policy probe', 'worker', parent?.id || null, JSON.stringify(policy)]);
  cleanupKeys.push(k);
  return row;
};

try {
  // ── 0. the migration is applied ──
  console.log('\n── the migration is in the schema ──');
  const cols = await q(`SELECT column_name FROM information_schema.columns
                         WHERE table_name='harness' AND column_name='model_policy'`);
  ok(cols.length === 1, 'harness.model_policy exists (if this fails, your db is behind the ledger)');
  const specs = await modelSpecs();
  ok(specs.length >= 15, `ai_model_spec is seeded (${specs.length} rows)`);
  ok(specs.some((s) => s.provider === 'claude' && s.key === 'opus' && s.is_default),
     'claude/opus is the seeded claude default');
  ok(specs.some((s) => s.provider === 'deepseek' && s.key === 'deepseek-reasoner'),
     'deepseek models are seeded');

  // ── 1. normalization is defensive ──
  console.log('\n── normalizePolicy — an operator-editable jsonb is read defensively ──');
  ok(JSON.stringify(normalizePolicy(null)) === JSON.stringify(normalizePolicy({})),
     'null and {} normalize the same (empty policy)');
  const n = normalizePolicy({ allow_providers: 'claude', allow_models: ['opus', 'opus'],
    min_context: '200000', max_params: '405', priorities: { opus: 5, sonnet: 'x' }, default_model: 'opus' });
  ok(JSON.stringify(n.allow_providers) === '[]', 'a non-array allow_providers degrades to empty');
  ok(JSON.stringify(n.allow_models) === '["opus"]', 'allow_models is deduplicated');
  ok(n.min_context === 200000 && n.max_params === 405, 'numeric strings are coerced to numbers');
  ok(n.priorities.opus === 5 && n.priorities.sonnet === 1, 'bad priority values degrade to 1');
  ok(n.default_model === 'opus', 'default_model is trimmed');

  // ── 2. merge: restriction lists INTERSECT, scalars leaf-win ──
  console.log('\n── mergePolicies — the inheritance contract ──');
  const merged = mergePolicies([
    { allow_providers: ['claude', 'deepseek'], allow_models: [], min_params: 10 },
    { allow_providers: ['claude'], allow_models: ['opus', 'sonnet'], max_params: 100 },
  ]);
  ok(JSON.stringify(merged.allow_providers) === '["claude"]',
     'two non-empty provider lists intersect (claude ∧ {claude,deepseek} = claude)');
  ok(JSON.stringify(merged.allow_models) === '["opus","sonnet"]',
     'an empty parent list adopts the child restriction');
  ok(merged.min_params === 10 && merged.max_params === 100,
     'scalar bounds are leaf-wins (min from root, max from child)');
  const noWiden = mergePolicies([
    { allow_providers: ['claude'], allow_models: ['opus'] },
    { allow_providers: ['claude', 'deepseek'] },
  ]);
  ok(JSON.stringify(noWiden.allow_providers) === '["claude"]'
     && JSON.stringify(noWiden.allow_models) === '["opus"]',
     'a child CANNOT widen a parent restriction (intersection, not union)');

  // ── 3. the dispatch resolution — explicit model refused when the policy forbids ──
  console.log('\n── resolveDispatchModel — the gate every spawn path funnels through ──');
  const row = await mkHarness({
    allow_providers: ['deepseek'],
    allow_models: ['deepseek-chat', 'deepseek-reasoner'],
    priorities: { 'deepseek-chat': 5, 'deepseek-reasoner': 1 },
    default_model: 'deepseek-reasoner',
  });
  const r = await resolveDispatchModel({ harnessRow: row, provider: 'deepseek', requestedModel: null, fallbackModel: 'opus' });
  ok(r.model === 'deepseek-reasoner', 'bare dispatch uses the policy default_model');
  const rExplicit = await resolveDispatchModel({ harnessRow: row, provider: 'deepseek', requestedModel: 'deepseek-chat', fallbackModel: null });
  ok(rExplicit.model === 'deepseek-chat', 'an explicit ALLOWED model passes');

  let threw = await resolveDispatchModel({ harnessRow: row, provider: 'claude', requestedModel: null, fallbackModel: 'opus' }).catch((e) => e.message);
  ok(/allows only deepseek/.test(threw), 'a provider outside allow_providers is refused');
  threw = await resolveDispatchModel({ harnessRow: row, provider: 'deepseek', requestedModel: 'opus', fallbackModel: null }).catch((e) => e.message);
  ok(/does not allow model/.test(threw), 'an explicit model outside allow_models is refused');

  // ── 4. priorities pick the model when there is no default ──
  console.log('\n── priorities — higher deploys first ──');
  const row2 = await mkHarness({
    allow_providers: ['deepseek'],
    allow_models: ['deepseek-chat', 'deepseek-reasoner'],
    priorities: { 'deepseek-chat': 9, 'deepseek-reasoner': 1 },
  });
  const r2 = await resolveDispatchModel({ harnessRow: row2, provider: 'deepseek', requestedModel: null, fallbackModel: 'opus' });
  ok(r2.model === 'deepseek-chat', 'bare dispatch picks the highest-priority allowed model');
  const allowed = await allowedModelsForProvider(row2.model_policy, 'deepseek');
  ok(allowed[0].key === 'deepseek-chat' && allowed[0].priority === 9, 'allowedModelsForProvider sorts by priority desc');

  // ── 5. context / parameter bounds against the spec ──
  console.log('\n── bounds — context_window and parameters are measured ──');
  await q(`UPDATE ai_model_spec SET context_window=200000, parameters=405 WHERE provider='claude' AND key='opus'`);
  await q(`UPDATE ai_model_spec SET context_window=1000000, parameters=1000 WHERE provider='claude' AND key='fable'`);
  const row3 = await mkHarness({ min_context: 500000 });
  const rOpus = await resolveDispatchModel({ harnessRow: row3, provider: 'claude', requestedModel: 'opus', fallbackModel: null })
    .catch((e) => e.message);
  ok(/does not fit the policy bounds/.test(rOpus),
     'opus (200k ctx) is refused by a min_context of 500k');
  const rFable = await resolveDispatchModel({ harnessRow: row3, provider: 'claude', requestedModel: 'fable', fallbackModel: null });
  ok(rFable.model === 'fable', 'fable (1M ctx) fits the same bound and passes');
  await q(`UPDATE ai_model_spec SET context_window=NULL, parameters=NULL WHERE provider='claude' AND key IN ('opus','fable')`);

  // ── 5b. an EXPLICIT model must be one the provider actually offers (TKT-97-BD32) ──
  // The regression this whole job exists for: `zee assign --model fable` on a project whose
  // provider resolved to deepseek silently ran deepseek-chat — fable IS in the harness's (inherited)
  // allow-list, so the allow_models check passed, but deepseek has no fable spec, so the bounds
  // check was skipped ("unknown spec → nothing to measure") and spawnCxell's effectiveModelFor
  // silently dropped the claude alias for the vendor default. An explicit model must be a real
  // model the provider offers — refused loudly by name, never substituted silently.
  console.log('\n── provider-model match — an explicit model the provider does not offer is refused by name ──');
  const rowM = await mkHarness({});   // no restriction at all — the exact dev-fixer shape
  const noFable = await resolveDispatchModel({ harnessRow: rowM, provider: 'deepseek', requestedModel: 'fable', fallbackModel: null })
    .catch((e) => e.message);
  ok(/not offered by provider "deepseek"/.test(noFable) && /fable/.test(noFable),
     'fable on deepseek is REFUSED by name (no deepseek/fable spec)');
  ok(/deepseek-chat/.test(noFable) && /deepseek-reasoner/.test(noFable),
     'and the refusal lists the models deepseek actually offers');
  const rFableClaude = await resolveDispatchModel({ harnessRow: rowM, provider: 'claude', requestedModel: 'fable', fallbackModel: null });
  ok(rFableClaude.model === 'fable', 'the SAME model on claude passes (claude/fable spec exists)');
  const rDs = await resolveDispatchModel({ harnessRow: rowM, provider: 'deepseek', requestedModel: 'deepseek-reasoner', fallbackModel: null });
  ok(rDs.model === 'deepseek-reasoner', 'a real deepseek model passes on deepseek');
  // the DEFAULT-selection path is deliberately untouched: a bare deepseek dispatch with a
  // claude-alias fallback still resolves to the fallback (the vendor adapter converts it later),
  // exactly as it did before this check existed.
  const rBareDs = await resolveDispatchModel({ harnessRow: rowM, provider: 'deepseek', requestedModel: null, fallbackModel: 'opus' });
  ok(rBareDs.model === 'opus', 'bare dispatch fallback is unchanged (default selection untouched)');

  // ── 6. inheritance: a child inherits its parent's restriction ──
  console.log('\n── inheritance — the effective policy walks the parent chain ──');
  const parent = await one(
    `INSERT INTO harness (key,label,zee_type,model_policy) VALUES ('zz-mp-parent','p','worker',$1::jsonb) RETURNING *`,
    [JSON.stringify({ allow_providers: ['deepseek'] })]);
  cleanupKeys.push('zz-mp-parent');
  const child = await one(
    `INSERT INTO harness (key,label,zee_type,parent_id,model_policy) VALUES ('zz-mp-child','c','worker',$1,$2::jsonb) RETURNING *`,
    [parent.id, JSON.stringify({ priorities: { 'deepseek-chat': 9 } })]);
  cleanupKeys.push('zz-mp-child');
  const eff = await effectiveModelPolicy(child);
  ok(JSON.stringify(eff.allow_providers) === '["deepseek"]', 'child inherits allow_providers from parent');
  ok(eff.priorities['deepseek-chat'] === 9, 'child keeps its own priorities');
  const rChild = await resolveDispatchModel({ harnessRow: child, provider: 'deepseek', requestedModel: null, fallbackModel: 'opus' });
  ok(rChild.model === 'deepseek-chat', 'inherited restriction + child priority resolve to deepseek-chat');

  // ── 6b. SPARSE STORAGE — the editor stores only overrides; omitted = inherit ──
  console.log('\n── sparse storage — a child stores only what it overrides ──');
  ok(JSON.stringify(normalizePolicy({ min_context: 5 })) === '{"min_context":5}',
     'a policy with one field stores only that field (absent keys mean inherit)');
  ok(JSON.stringify(normalizePolicy({ allow_providers: [] })) === '{"allow_providers":[]}',
     'an explicit empty allow_providers is STORED (no-narrow, distinct from inherit)');
  ok(JSON.stringify(normalizePolicy({})) === '{}',
     'an empty policy stores nothing (fully inherit)');
  // inheritedModelPolicy: what the EDITOR shows as the baseline for a child.
  const { inheritedModelPolicy } = await import('../server/src/lib/model-policy.js');
  const childInh = await inheritedModelPolicy(child);
  ok(JSON.stringify(childInh.allow_providers) === '["deepseek"]',
     'inheritedModelPolicy exposes the PARENT chain (the inherit baseline), not the child merged');
  const rootInh = await inheritedModelPolicy(parent);
  ok(JSON.stringify(rootInh) === '{"allow_providers":[],"allow_models":[],"min_context":null,"max_context":null,"min_params":null,"max_params":null,"priorities":{},"default_model":null,"limit":null}',
     'a root harness inherits an EMPTY baseline (incl. the 139 wearer limit, unset)');

  // ── 7. no harness / no policy = pass-through ──
  console.log('\n── no policy — the existing behaviour is unchanged ──');
  const rNone = await resolveDispatchModel({ harnessRow: null, provider: 'claude', requestedModel: 'sonnet', fallbackModel: 'opus' });
  ok(rNone.model === 'sonnet', 'an explicit model with no harness passes through');
  const rBare = await resolveDispatchModel({ harnessRow: null, provider: 'claude', requestedModel: null, fallbackModel: 'opus' });
  ok(rBare.model === 'opus', 'a bare dispatch with no policy uses the code fallback');

  // ── 8. a BARE dispatch on a non-claude provider does not trip the fallback ──
  // The code default (DEFAULT_ZEE_MODEL='opus') is a claude alias. When a deepseek-only harness
  // gets a bare dispatch, spawnHeadless passes model=null (no explicit pick), so resolveDispatchModel
  // must resolve from the policy — NOT treat the code fallback as an explicit claude alias that a
  // deepseek-only policy then refuses.
  console.log('\n── bare dispatch on a non-claude provider — the fallback is not a hard constraint ──');
  const row4 = await mkHarness({
    allow_providers: ['deepseek'],
    allow_models: ['deepseek-chat', 'deepseek-reasoner'],
    priorities: { 'deepseek-reasoner': 3, 'deepseek-chat': 1 },
  });
  const r4 = await resolveDispatchModel({ harnessRow: row4, provider: 'deepseek', requestedModel: null, fallbackModel: 'opus' });
  ok(r4.model === 'deepseek-reasoner', 'bare deepseek dispatch resolves to the policy highest-priority model, not the claude fallback');
  const r4b = await resolveDispatchModel({ harnessRow: row4, provider: 'claude', requestedModel: null, fallbackModel: 'opus' })
    .catch((e) => e.message);
  ok(/allows only deepseek/.test(r4b), 'a bare CLAUDE dispatch on a deepseek-only harness is still refused');

  // ── 9. a PROVIDER-only policy (no model preference) preserves the vendor default ──
  // A harness that restricts the provider but not the model must NOT pin a named model — the
  // vendor's own env-driven default (DEEPSEEK_DEFAULT_MODEL etc.) stays in charge, exactly as
  // it did before policies existed.
  console.log('\n── provider-only policy — the vendor default survives ──');
  const row5 = await mkHarness({ allow_providers: ['deepseek'] });
  const r5 = await resolveDispatchModel({ harnessRow: row5, provider: 'deepseek', requestedModel: null, fallbackModel: '' });
  ok(r5.model === '', 'a provider-only policy does not pin a named model — the vendor default survives');
  const r5b = await resolveDispatchModel({ harnessRow: row5, provider: 'deepseek', requestedModel: null, fallbackModel: 'opus' });
  ok(r5b.model === 'opus', 'with the code fallback passed, the provider-only policy still returns the fallback (a non-claude adapter drops it)');
} finally {
  for (const k of cleanupKeys) await q(`DELETE FROM harness WHERE key=$1`, [k]).catch(() => {});
  await q(`DELETE FROM harness WHERE key=$1`, [KEY]).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

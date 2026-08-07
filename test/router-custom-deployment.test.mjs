// CUSTOM DEPLOYMENT ON A ROUTING REQUEST — the human's explicit decision, carried to the router.
//
// The change this holds true: the console's composer may expand a "Custom deployment" panel (the
// same provider/model/mode/harness pickers a direct dispatch offers) and whatever it pins rides
// with the raw prompt as a DECISION, not a hint — the router uses those settings for the dispatch
// instead of deciding them itself. So routeRawPrompt now takes an optional
// `custom = { provider, model, mode, harness }` and renders it as its own block AFTER the prompt.
//
// What is asserted here, against a real database:
//
//   1. ABSENT — with no custom settings the request body is BYTE-FOR-BYTE what it always was
//      (marker · policy snapshot · optional schedule + hint lines · the raw prompt). This is the
//      compatibility test: the router's persona (fleet-owned) teaches that format and nothing here
//      may move it.
//   2. FULL — provider + model + mode + harness render in one CUSTOM DEPLOYMENT line, worded as a
//      decision ("the human configured this — use these settings"), clearly distinct from the
//      existing "a HINT, not a decision" wording, which still renders for the hint case.
//   3. PARTIAL — pinning only a provider renders only `provider=`; the router is told the rest is
//      still its call. (Partial pins are legal by design.)
//   4. REFUSALS — an unknown model, an unknown provider, an unknown harness, a model with no
//      provider and an out-of-range mode are each refused LOUDLY, naming what IS available. The
//      listings come from lib/dispatch-options.js — the very read model the composer's pickers are
//      built from — so a setting the picker offered can never be one this refuses, and a persona
//      whose policy forbids a provider makes pinning that provider a refusal too.
//   5. THE AUDIT ROW SURVIVES BOTH ENDS — zee_message.body is capped, and the custom block sits
//      after the prompt, so a long prompt used to be able to slice the human's decision off the
//      stored request. The prompt is what gives way instead (marked), head and tail both survive.
//
// Needs DATABASE_URL (a `zee db-sandbox` works). No agents spawned, no containers touched — the
// router xell is a plain row with no cage, so delivery is honestly "not delivered"; everything
// created is removed in the finally.
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.PROVISION_MODE = 'simulate';

const { q, one, pool } = await import('../server/src/db/pool.js');
const H = await import('../server/src/lib/harness.js');
const R = await import('../server/src/lib/router.js');
const { dispatchOptions } = await import('../server/src/lib/dispatch-options.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const throws = async (fn, re, m) => {
  try { await fn(); ok(false, `${m} (did not throw)`); }
  catch (e) { ok(re.test(e.message), `${m}\n      → ${String(e.message).slice(0, 180)}`); }
};

const tag = randomUUID().slice(0, 8);
const P = { name: `zt-rcd-${tag}` };
const keys = { worker: `zt-rcd-worker-${tag}`, pinned: `zt-rcd-pinned-${tag}` };
const BY = 'zt-custom-deployment';

async function cleanup() {
  for (const k of Object.values(keys)) await q(`DELETE FROM harness WHERE key=$1`, [k]).catch(() => {});
  if (P.id) await q(`DELETE FROM project WHERE id=$1`, [P.id]).catch(() => {});
}

// The body the composer's routing request had BEFORE this change, recomposed from the same status
// snapshot — so "unchanged" is asserted against the format, not against a copy of the new code.
const legacyBody = (st, prompt, hint = null) => [
  `🧭 ROUTING REQUEST from ${BY}`,
  '',
  `ROUTER POLICY (obey THIS snapshot over anything you remember): ${JSON.stringify(st.policy)}`,
  ...(st.scheduled_out.length
    ? [`Providers outside their schedule window right now (UTC): ${st.scheduled_out.join(', ')}`] : []),
  ...(hint
    ? [`The human opened the composer from the "${hint}" persona button — a HINT, not a decision; you pick the harness.`] : []),
  '',
  '── RAW PROMPT (recompose per your manual, then dispatch) ──',
  prompt,
].join('\n');

const bodyOf = async (routed) => (await one(`SELECT * FROM zee_message WHERE id=$1`, [routed.message_id]));

try {
  await cleanup();

  // ── fixtures: a project with two connected accounts, a worker persona, and a LIVE router ──
  P.id = (await one(`INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'master') RETURNING id`,
    [P.name, `/tmp/${P.name}`])).id;
  await q(`INSERT INTO pool_config (project_id) VALUES ($1)`, [P.id]);
  P.xource = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [P.id])).id;
  await q(`INSERT INTO provider_token (project_id, provider, token, token_hint, label)
           VALUES ($1,'claude',$2,'oat1','Claude A'), ($1,'openai',$3,'sk01','Codex A')`,
    [P.id, `sk-ant-oat01-${tag}`, `sk-${tag}`]);
  // A plain worker persona (pinnable), and one whose policy allows openai ONLY — the persona a
  // custom pin is judged against.
  await q(`INSERT INTO harness (key,label,bundle,model_policy,enabled,is_law_core,zee_type)
           VALUES ($1,$2,$3::jsonb,'{}'::jsonb,true,false,'worker'),
                  ($4,$5,$3::jsonb,'{"allow_providers":["openai"]}'::jsonb,true,false,'worker')`,
    [keys.worker, `RCD worker ${tag}`, JSON.stringify({ personality: 'w' }),
     keys.pinned, `RCD openai-only ${tag}`]);
  const routerXell = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, zee_type)
       VALUES ($1,$2,$3,$4,$5,'working',false,'manager') RETURNING *`,
    [P.id, P.xource, `zt-rcd-router-${tag}`, `spinoff/zt-rcd-router-${tag}`, `/tmp/zt-rcd-router-${tag}`]);
  await H.assignHarness(routerXell.id, 'router');

  // What this project can ACTUALLY offer — read from the same endpoint the composer's pickers use,
  // so the test pins a real provider/model instead of a guessed one.
  const opts = await dispatchOptions({ projectId: P.id, zeeType: 'worker' });
  const pick = opts.providers.find((p) => !p.blocked_reason && p.models.length);
  ok(!!pick, `the fixture project offers a pickable provider with models (${pick?.provider} · ${pick?.models?.length} model(s))`);
  const MODEL = pick.models[0].key;
  const st = await R.routerStatus(P.id);
  ok(st.present === true, 'the fixture router is live (routerStatus.present)');

  // ── 1. NO custom settings → the body is byte-for-byte what it always was ──
  console.log('\n── absent: the routing request format is unchanged ──');
  const plain = await R.routeRawPrompt({ project: P.id, prompt: 'make the header sticky', by: BY });
  const plainMsg = await bodyOf(plain);
  ok(plainMsg.body === legacyBody(st, 'make the header sticky'),
     'with no custom deployment the body is IDENTICAL to the pre-change format');
  ok(!/CUSTOM DEPLOYMENT/.test(plainMsg.body), '…and carries no CUSTOM DEPLOYMENT block at all');
  ok(plain.custom_deployment === null, 'the answer says nothing was pinned');
  ok(!plainMsg.meta?.custom_deployment, '…and the audit row\'s meta carries no custom_deployment');
  // an EMPTY object is the same as absent — the composer sends one when the panel was opened and
  // nothing was picked.
  const empty = await R.routeRawPrompt({ project: P.id, prompt: 'make the header sticky', by: BY,
                                         custom: { provider: '', model: null, mode: '', harness: '' } });
  ok((await bodyOf(empty)).body === legacyBody(st, 'make the header sticky'),
     'an EMPTY custom panel is the same as none (nothing pinned, same body)');
  // the HINT case is untouched by any of this
  const hinted = await R.routeRawPrompt({ project: P.id, prompt: 'ship it', by: BY, harness_hint: keys.worker });
  ok((await bodyOf(hinted)).body === legacyBody(st, 'ship it', keys.worker),
     'the persona-button HINT still renders in its own (unchanged) wording');

  // ── 2. FULL custom settings ──
  console.log('\n── full: provider + model + mode + harness, as a DECISION ──');
  const full = await R.routeRawPrompt({ project: P.id, prompt: 'rewrite the intake loop', by: BY,
    custom: { provider: pick.provider, model: MODEL, mode: 3, harness: keys.worker } });
  const fullBody = (await bodyOf(full)).body;
  const line = fullBody.split('\n').find((l) => l.startsWith('CUSTOM DEPLOYMENT')) || '';
  ok(/^CUSTOM DEPLOYMENT \(the human configured this — use these settings for the dispatch\): /.test(line),
     `the block is worded as a decision\n      → ${line}`);
  ok(line.includes(`provider=${pick.provider}`) && line.includes(`model=${MODEL}`)
     && line.includes('mode=3 (shell)') && line.includes(`harness=${keys.worker}`),
     'all four configured settings render on the one line');
  ok(fullBody.indexOf('CUSTOM DEPLOYMENT') > fullBody.indexOf('rewrite the intake loop'),
     'the block comes AFTER the raw prompt, and the prompt is still verbatim');
  ok(!/HINT, not a decision/.test(fullBody),
     'it is not confusable with the hint wording (no hint line here — none was sent)');
  ok(full.custom_deployment?.provider === pick.provider && full.custom_deployment?.mode === 3,
     'the answer echoes what was RESOLVED, for the console');
  ok((await bodyOf(full)).meta?.custom_deployment?.harness === keys.worker,
     'the audit row\'s meta records the resolved settings too');

  // ── 3. PARTIAL — only a provider pinned ──
  console.log('\n── partial: only what was configured is rendered ──');
  const partial = await R.routeRawPrompt({ project: P.id, prompt: 'tidy the css', by: BY,
    custom: { provider: pick.provider } });
  const pLine = (await bodyOf(partial)).body.split('\n').find((l) => l.startsWith('CUSTOM DEPLOYMENT')) || '';
  ok(pLine.endsWith(`provider=${pick.provider}`), `only the provider is rendered\n      → ${pLine}`);
  ok(!/model=|mode=|harness=/.test(pLine), 'no empty model/mode/harness is invented');
  ok(/still yours to decide under the policy/.test((await bodyOf(partial)).body),
     '…and the router is told the rest remains its call');
  const modeOnly = await R.routeRawPrompt({ project: P.id, prompt: 'have a look', by: BY,
    custom: { mode: 1 } });
  ok(/CUSTOM DEPLOYMENT.*mode=1 \(plan\)$/m.test((await bodyOf(modeOnly)).body),
     'a mode-only pin renders the mode alone, with the scale\'s own name for it');

  // ── 4. refusals — loud, naming what IS available ──
  console.log('\n── invalid combinations are refused, naming what is available ──');
  await throws(() => R.routeRawPrompt({ project: P.id, prompt: 'x', by: BY,
      custom: { provider: pick.provider, model: `nope-${tag}` } }),
    new RegExp(`unknown model "nope-${tag}" on ${pick.provider} — allowed here: .*${MODEL}`),
    'an unknown MODEL is refused, listing the models allowed on that provider');
  await throws(() => R.routeRawPrompt({ project: P.id, prompt: 'x', by: BY,
      custom: { provider: `nope-${tag}` } }),
    /unknown provider .* this project offers: .*claude/,
    'an unknown PROVIDER is refused, listing the project\'s providers');
  await throws(() => R.routeRawPrompt({ project: P.id, prompt: 'x', by: BY,
      custom: { harness: `nope-${tag}` } }),
    new RegExp(`unknown harness .* available: .*${keys.worker}`),
    'an unknown HARNESS is refused, listing the worker personas this project may wear');
  await throws(() => R.routeRawPrompt({ project: P.id, prompt: 'x', by: BY, custom: { model: MODEL } }),
    /a model is per provider — pin the provider too/,
    'a model with no provider is refused (model ids are a vendor\'s own)');
  await throws(() => R.routeRawPrompt({ project: P.id, prompt: 'x', by: BY, custom: { mode: 9 } }),
    /mode must be 1–5/, 'an out-of-range MODE is refused by the dispatch scale\'s own words');
  await throws(() => R.routeRawPrompt({ project: P.id, prompt: 'x', by: BY,
      custom: { harness: keys.pinned, provider: 'claude' } }),
    /cannot pin provider "claude": .*openai/,
    'a provider the PINNED persona\'s policy forbids is refused with that policy\'s reason');
  const after = await q(`SELECT count(*)::int AS n FROM zee_message WHERE project_id=$1`, [P.id]);
  ok(after[0].n === 6, `a refused request records NO routing request (6 stored, all accepted ones)`);

  // ── 5. the capped audit row keeps BOTH ends ──
  console.log('\n── the audit row is capped: the prompt gives way, not the decision ──');
  const long = `${'x'.repeat(R.AUDIT_BODY_MAX + 5000)} END-OF-PROMPT`;
  const big = await R.routeRawPrompt({ project: P.id, prompt: long, by: BY,
    custom: { provider: pick.provider, mode: 5 } });
  const bigBody = (await bodyOf(big)).body;
  ok(bigBody.length <= R.AUDIT_BODY_MAX, `the stored body respects the cap (${bigBody.length} ≤ ${R.AUDIT_BODY_MAX})`);
  ok(/^🧭 ROUTING REQUEST/.test(bigBody), 'the head survives');
  ok(/CUSTOM DEPLOYMENT.*provider=/.test(bigBody), 'the CUSTOM DEPLOYMENT block survives — it is not sliced off the end');
  ok(/prompt truncated in this audit row/.test(bigBody), 'and the cut is marked where the prompt gave way');
  ok(!/END-OF-PROMPT/.test(bigBody), '…which is where the prompt was cut, not the block after it');
  // The cap is the AUDIT ROW only: what is DELIVERED to the router is the composed body itself, and
  // auditBody leaves anything under the cap exactly as composed.
  ok(R.auditBody('HEAD', 'the prompt', '\nCUSTOM DEPLOYMENT (…): provider=claude')
     === 'HEAD\nthe prompt\n\nCUSTOM DEPLOYMENT (…): provider=claude',
     'under the cap auditBody changes nothing — the stored row and the delivered text are the same words');

  // ── 6. the console side, read from source (there is no DOM in this suite) ──
  // Same technique as manager-compose / harness-prompt-buttons: the composer's WIRING is asserted
  // by reading it, because the behaviour above can only be reached through it.
  console.log('\n── the composer wiring (web/src/Dispatch.jsx) ──');
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const disp = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web/src/Dispatch.jsx'), 'utf8');
  ok(/const \[customOpen, setCustomOpen\] = useState\(false\);/.test(disp),
     'the panel is COLLAPSED by default — the router deciding is still the norm');
  ok(/\{routerGate && liveRouter && !routerMode && \(\s*\n\s*<div className="disp-custom"/.test(disp),
     'and it exists only with a LIVE router (no router → the direct panel is the whole story)');
  ok(/\.\.\.\(customCount \? \{ custom \} : \{\}\),/.test(disp),
     'what is pinned rides on the via_router payload as `custom`, and NOTHING when nothing is pinned');
  ok(/getDispatchOptions\(\{ project: projectId, harness: cHarness, zeeType: 'worker' \}\)/.test(disp),
     'the pickers re-read /dispatch/options under the PINNED persona — they cannot offer what the server refuses');
  ok(/if \(cProv && \(!row \|\| row\.blocked_reason\)\) \{ setCProv\(null\); setCModel\(null\); return; \}/.test(disp),
     'a persona switch drops only the pins the new policy FORBIDS — a legal one survives it');
  for (const [what, re] of [
    ['persona', /data-testid=\{`custom-harness-\$\{h\.key\}`\}/],
    ['provider', /data-testid=\{`custom-provider-\$\{p\.provider\}`\}/],
    ['mode', /data-testid=\{`custom-mode-\$\{m\.mode\}`\}/],
    ['model', /data-testid=\{`custom-model-\$\{m\.key\}`\}/],
  ]) ok(re.test(disp), `the panel offers the ${what} picker the direct panel offers`);
  for (const unset of ['custom-harness-router', 'custom-provider-router', 'custom-mode-router', 'custom-model-router']) {
    ok(new RegExp(`data-testid="${unset}"`).test(disp),
       `…each with a "router decides" segment (${unset}) — a pin must be reversible`);
  }
  ok(/data-testid=\{`dispatch-provider-\$\{p\.provider\}`\}/.test(disp)
     && /data-testid=\{`dispatch-model-\$\{m\.key\}`\}/.test(disp)
     && /data-testid=\{`dispatch-mode-\$\{m\.mode\}`\}/.test(disp),
     'and the DIRECT panel keeps its own pickers, untouched');

  // ── 7. INSTANT DEPLOY — the second door when something is pinned ──
  // Custom pins used to travel only via the router. Instant deploy is the path that skips the
  // router ZEE and POSTs /api/xell/dispatch with those settings; Route via router is unchanged.
  // "Bypass" means the router zee only — server-side validation and harness provider-lanes stay.
  console.log('\n── Instant deploy (skip the router zee when custom is pinned) ──');
  ok(/data-testid="dispatch-instant"/.test(disp),
     'the footer has an Instant deploy button (data-testid=dispatch-instant)');
  ok(/wantsInstant/.test(disp) && /customCount > 0 \|\| prodDb/.test(disp),
     'Instant deploy renders when a live router is present AND (something is pinned OR LIVE PROD is on)');
  ok(/const instantDeploy = \(\) =>/.test(disp),
     'Instant deploy is its own handler, not a flag on the via-router submit');
  // The payload must be a DIRECT dispatch (no via_router) so App.jsx takes POST /api/xell/dispatch.
  const instantBody = disp.slice(disp.indexOf('const instantDeploy = () =>'),
                                 disp.indexOf('const submit = () =>'));
  ok(instantBody.length > 80, 'instantDeploy is a distinct block before submit');
  // The flag itself must not appear as a payload key. A comment may name it (to say we skip it);
  // the assertion is about the JSON the parent receives, not the prose around the call.
  ok(!/via_router\s*:/.test(instantBody),
     'Instant deploy never sets via_router: — that is the whole point of the button');
  ok(/instantDispatchOnce\(directPayload\(task,/.test(instantBody),
     'Instant deploy hands a direct-dispatch payload to onDispatch (through the one-shot door)');
  // THE IN-FLIGHT GUARD (150): every fire path goes through a one-shot `makeDoor` that refuses a
  // second call of the same door — the double-click that produced the double-deploy. Assert the
  // door exists and guards the two submit doors.
  ok(/const makeDoor = \(\) =>/.test(disp) && /fired = true/.test(disp),
     'the one-shot door guards every fire path');
  ok(/instantDispatchOnce = makeDoor\(\)/.test(disp) && /submitDispatchOnce = makeDoor\(\)/.test(disp),
     'Instant and Route each have their own one-shot door (a double-click fires onDispatch once)');
  // Route via router must still carry custom pins the way it always has.
  ok(/\.\.\.\(customCount \? \{ custom \} : \{\}\)/.test(disp) && /via_router:\s*true/.test(disp),
     'Route via router still carries custom pins on the routing request');
  // Cmd/Ctrl+Enter stays on the via-router path — Instant is the explicit second button only.
  ok(/onKeyDown[\s\S]{0,120}submit\(\)/.test(disp),
     '⌘/Ctrl+Enter still calls submit (via router), not instantDeploy');
  const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web/src/styles.css'), 'utf8');
  ok(/\.disp-submit\.disp-instant\b/.test(css),
     'Instant deploy has its own style (working-green) so it is not confused with Route via router');
} finally {
  await cleanup();
  await pool.end();
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nall good');
process.exit(fail ? 1 : 0);

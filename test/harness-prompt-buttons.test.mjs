// ONE PROMPT BUTTON PER HARNESS — and every choice under it derived from that persona.
//
// The flow this locks down (and the bug it closes): the console showed one "＋ prompt" button per
// connected AI ACCOUNT, and the persona (harness) was the LAST segmented control inside the
// composer. That puts the credential first and the manual last, and the two could contradict each
// other — open the composer from a Claude account button, pick a persona whose model policy allows
// only deepseek, and the spawn refused it (resolveDispatchModel) AFTER the whole prompt had been
// written. The harness is the consequential choice (it carries the manual, the skills and the model
// policy), so the harness is the button, and the composer derives the rest from it.
//
// Four halves, in the order a human meets them:
//
//   1. THE READ MODEL (server lib/dispatch-options.js), against the real meta-DB: a throwaway
//      project with two connected accounts and a persona whose policy allows one provider. What is
//      asserted is that the picker CANNOT offer what the spawn would refuse — the forbidden
//      provider comes back blocked with a reason, the allowed one comes back with exactly the
//      policy's models, and the marked default is the model resolveDispatchModel itself resolves.
//   2. THE AUTONOMY SCALE IS PROVIDER-DEPENDENT, and this is the honesty half: inside a cxell the
//      1–5 scale is NOT enforced (spawnCxell stores 'bypassPermissions' unconditionally and only
//      LOGS what was asked), so picking "1 · plan" for a Codex zee looked like read-only recon and
//      dispatched a zee that could do anything. modesForRuntime says so per runtime.
//   3. THE EFFECTIVE POLICY ON EVERY LISTED HARNESS (lib/harness.js), because a child that
//      inherits "claude only" declares nothing of its own and would render as unrestricted.
//   4. THE CONSOLE: WHICH BUTTONS THERE ARE is a pure function (web/src/promptButtons.js) and is
//      RUN here, not regexed — a persona with no usable provider is disabled *with a sentence*
//      rather than hidden, "core only" survives as its own button, and an empty persona is labelled
//      on the button itself. The wiring around it (the composer asking the options endpoint, the
//      click pinning the persona) is read from source, because this suite has no DOM.
//
// What is NOT covered here, and how it was covered instead: the composer's live behaviour — click a
// provider, watch the model list and the account list follow, submit and read the payload — needs a
// DOM, and this repo has no DOM test dependency. It was exercised during development by mounting
// the real component in jsdom with a stubbed fetch (providers/models/accounts/autonomy all derived,
// payload = persona + provider + exact account + policy-resolved model). If a DOM harness is ever
// added to this repo, that belongs here.
//
// Throwaway rows in the real meta-DB, torn down in a finally. (In a cxell whose DATABASE_URL
// carries no password the meta-DB half cannot run at all — it fails loudly rather than skipping,
// because a suite that goes quiet when it cannot reach its subject is worse than a red one.)
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// ── 2. the autonomy scale, annotated per runtime (pure — no database) ───────────────────────────
const { modesForRuntime } = await import('../server/src/lib/dispatch-options.js');
const { DISPATCH_MODES } = await import('../server/src/queenzee/intake.js');

console.log('\n── the autonomy scale means different things on different runtimes ──');
const sdkModes = modesForRuntime({ caged: false });
const cagedModes = modesForRuntime({ caged: true });
ok(sdkModes.length === Object.keys(DISPATCH_MODES).length,
   `the scale is the SERVER's scale, not a copy (${sdkModes.map((m) => m.key).join(', ')})`);
ok(sdkModes.every((m) => m.enforced && m.note === null),
   'on an SDK runtime every mode is enforced — the composer says nothing extra');
ok(cagedModes.filter((m) => m.enforced).map((m) => m.mode).join() === '5',
   'inside a cxell ONLY 5 (bypass) is enforced — that is what spawnCxell actually stores');
ok(cagedModes.filter((m) => !m.enforced).every((m) => /bypass/.test(m.note || '')),
   'and the other four carry the reason, so "1 · plan" can never read as read-only recon');
const spawnSrc = read('server/src/queenzee/intake.js');
ok(/VALUES \(\$1,'headless-spawn',\$2,'none','spawning','headless','cxell-cli',\$3,'bypassPermissions'/.test(spawnSrc),
   'sanity: the cxell spawn really does hard-code bypassPermissions (the fact this annotation reports)');

// ── 4. the console wiring (source-read: there is no browser in this suite) ──────────────────────
console.log('\n── the console: the button IS the persona ──');
const app = read('web/src/App.jsx');
const disp = read('web/src/Dispatch.jsx');
// WHICH buttons there are is a pure function, so RUN it rather than regex the JSX.
const { promptButtons, hasAnyAccount } = await import('../web/src/promptButtons.js');
const { emptyWarning } = await import('../web/src/harnessHealth.js');
const PROVIDERS = [
  { provider: 'claude', label: 'Claude', dispatch: true, accounts: [{ id: 'a1', paused: false }] },
  { provider: 'openai', label: 'ChatGPT Codex', dispatch: true, accounts: [{ id: 'o1', paused: true }] },
  { provider: 'github', label: 'GitHub', accounts: [{ id: 'g1', paused: false }] },
];
const HARNESSES = [
  { id: 'h1', key: 'hermes', label: 'Hermes', scope: 'global', effective_model_policy: { allow_providers: [] } },
  { id: 'h2', key: 'coder', label: 'Coder', scope: 'project', effective_model_policy: { allow_providers: ['openai'] } },
  { id: 'h3', key: 'hollow', label: 'Hollow', scope: 'global', bundle_empty: true, effective_model_policy: {} },
];
const btns = promptButtons(HARNESSES, PROVIDERS, { emptyWarning, defaultHarnessId: 'h3' });
ok(btns.map((b) => b.key).join() === 'hollow,hermes,coder,',
   'one button per WORKER persona — and no longer one per AI ACCOUNT (the credential is not the choice)');
ok(btns[0].key === 'hollow' && btns[0].isDefault,
   "the project's DEFAULT persona leads and is marked (it is what a bare dispatch attaches anyway)");
ok(btns.at(-1).key === '' && btns.at(-1).label === 'core only' && !btns.at(-1).blocked,
   '"core only" survives as its own button — a dispatch with no persona must not become impossible');
ok(!btns.find((b) => b.key === 'hermes').blocked,
   'an unrestricted persona runs on whatever the project has connected');
ok(/every openai account on this project is PAUSED/.test(btns.find((b) => b.key === 'coder').blocked),
   'a persona whose policy allows only a provider with no LIVE account is blocked, with the reason '
   + '(its one openai account is PAUSED — the spawn refuses that too)');
ok(btns.find((b) => b.key === 'hermes').runsOn.map((p) => p.provider).join() === 'claude',
   'and the button can say what it will actually run on (paused and non-dispatch providers excluded)');
// A PAUSE is not an absence — the button must not send a human to add a token they already have.
const paused = promptButtons(
  [{ id: 'h1', key: 'hermes', label: 'Hermes', effective_model_policy: {} }],
  [{ provider: 'claude', label: 'Claude', dispatch: true, accounts: [{ id: 'a1', paused: true }] }],
  { emptyWarning });
ok(/every AI provider account on this project is PAUSED/.test(paused[0].blocked),
   'an all-paused project says PAUSED (reversible, and the spawn refuses a paused account anyway) '
   + 'rather than "nothing is connected"');
ok(btns.find((b) => b.key === 'hollow').warn?.chip === '⚠ empty',
   'an EMPTY persona is labelled on its own button — the zee you dispatch is the one who pays for it');
ok(hasAnyAccount(PROVIDERS) && !hasAnyAccount([{ provider: 'github', accounts: [{ id: 'g' }] }]),
   'visibility is still the token store: no dispatchable account at all → "add provider" instead');
// …and the JSX really uses it (a pure function nothing calls is dead code).
ok(/promptButtons\(harnesses, providers,/.test(app) && /defaultHarnessId: fleet\.pool\?\.default_harness_id/.test(app) && /hasAnyAccount\(providers\)/.test(app),
   'App renders the buttons FROM that function');
ok(/getHarnesses\('worker', pid\)/.test(app) && /data-testid=\{`new-prompt-btn-\$\{b\.key \|\| 'core'\}`\}/.test(app),
   "built from THIS project's worker personas (054 + 084)");
ok(/disabled=\{!!b\.blocked\}/.test(app),
   'a blocked persona is DISABLED with the reason, not hidden (a control that vanishes reads as "it disappeared")');
// THE BADGE IS NOT IN THE BUTTON, and the button says only the name. A persona's face is what a
// human scans this row for, and shrunk inside a pill it reads as decoration; and "＋ prompt ·" was
// the same three words on every button, so the only word that differed had to compete with them.
ok(/className=\{`np-persona/.test(app) && /<ZeeAvatar harness=\{\{[^}]*\}\} size=\{30\} \/>/.test(app),
   "the persona's badge is the button's SIBLING, at a size you can actually read");
// the button's whole content, asserted where it is written: the label first, nothing before it
ok(/>\s*\n?\s*\{b\.label\}\{b\.scope === 'project'/.test(app),
   'and the button carries the persona NAME alone — no repeated "＋ prompt ·" prefix in front of it');
ok(/setShowDispatch\(\{ harness: b\.key \}\)/.test(app) && /<Dispatch[\s\S]{0,200}harness=\{showDispatch\.harness\}/.test(app),
   'and the click pins that persona on the composer');

console.log('\n── the composer: providers, models and autonomy all follow from it ──');
// Since 139 the same call serves the router-deploy sub-mode too (harness 'router', a manager-type
// zee), so the persona branch is the ternary's ELSE arm — the contract is unchanged: one call,
// derived from the persona, re-asked when it changes.
ok(/getDispatchOptions\(routerMode[\s\S]{0,220}\{ project: projectId, harness, zeeType: manager \? 'manager' : 'worker' \}\)/.test(disp),
   'the composer asks the server what THIS persona may dispatch (one call, the same policy the spawn enforces)');
ok(/\}, \[projectId, manager, harness, routerMode\]\);/.test(disp),
   'and re-asks when the persona changes (the manager picks its own in there; router-deploy flips to the router persona)');
ok(/data-testid=\{`dispatch-provider-\$\{p\.provider\}`\}/.test(disp) && /disabled=\{!!p\.blocked_reason\}/.test(disp),
   'providers render from that answer, a forbidden one disabled and carrying its reason');
ok(/const models = active\?\.models\?\.length/.test(disp) && /const modes = active\?\.modes\?\.length/.test(disp),
   'the MODEL list and the AUTONOMY list are both read off the SELECTED provider');
ok(/setModel\(def\)/.test(disp) && /setAcctId\(active\.accounts\.find\(\(a\) => !a\.paused\)\?\.id \|\| null\)/.test(disp),
   'switching provider re-decides the model and the account — neither may survive the switch');
ok(/data-testid="dispatch-mode-unenforced"/.test(disp),
   'and an unenforced autonomy mode is said out loud, not just styled');
ok(/if \(active\?\.blocked_reason\)/.test(disp),
   'submit refuses a blocked provider here rather than letting the spawn refuse it after the prompt is written');

// The policy sentence a human reads is a real function, so assert its behaviour rather than
// re-typing the words.
const { transformSync } = await import('esbuild');
const { writeFileSync, rmSync } = await import('node:fs');
// Node cannot load a raw .jsx, so the component is transformed beside itself — and so is every
// SIBLING component it imports (the composer wears <ZeeAvatar>, the provider coin), with the
// specifier rewritten to the compiled copy. Same helper shape as harness-authoring-ui.test.mjs.
const compiled = [];
const compile = (rel, name) => {
  const file = join(ROOT, 'web/src', `.${name}.test-build.mjs`);
  let code = transformSync(read(rel), { loader: 'jsx', format: 'esm', jsx: 'transform' }).code;
  code = code.replace(/(['"])\.\/([A-Za-z0-9_-]+)\.jsx\1/g, (_m, _q, dep) => {
    const depName = `${name}-${dep.toLowerCase()}`;
    compile(`web/src/${dep}.jsx`, depName);
    return `"./.${depName}.test-build.mjs"`;
  });
  writeFileSync(file, code);
  compiled.push(file);
  return `file://${file}`;
};
let policySummary;
try {
  ({ policySummary } = await import(compile('web/src/Dispatch.jsx', 'dispatchpb')));
} finally { for (const f of compiled) { try { rmSync(f); } catch { /* */ } } }
ok(/no model policy/.test(policySummary({})) && /no model policy/.test(policySummary(null)),
   'an unrestricted persona says so plainly');
const line = policySummary({ allow_providers: ['openai'], allow_models: ['gpt-5.6-sol'], default_model: 'gpt-5.6-sol' });
ok(/openai/.test(line) && /gpt-5\.6-sol/.test(line) && /enforced at dispatch/.test(line),
   `a restricted one names the restriction and that it is enforced ("${line}")`);

// ── 1 + 3. the read model, against the real meta-DB ─────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.log('\n(no DATABASE_URL — skipping the meta-DB half; the pure + source halves ran)');
  console.log(fail ? `\n${fail} FAILED` : '\nall good');
  process.exit(fail ? 1 : 0);
}
const { q, one, pool } = await import('../server/src/db/pool.js');
const { dispatchOptions } = await import('../server/src/lib/dispatch-options.js');
const { listHarnesses } = await import('../server/src/lib/harness.js');

const tag = randomUUID().slice(0, 8);
const parentKey = `zt-pb-parent-${tag}`;   // allows openai only
const childKey = `zt-pb-child-${tag}`;     // declares nothing — must INHERIT the restriction
let projId = null;
try {
  const parent = await one(
    `INSERT INTO harness (key,label,bundle,model_policy,enabled,is_law_core,zee_type)
     VALUES ($1,$2,$3::jsonb,$4::jsonb,true,false,'worker') RETURNING id`,
    [parentKey, `PB parent ${tag}`, JSON.stringify({ personality: 'p' }),
     JSON.stringify({ allow_providers: ['openai'], allow_models: ['gpt-5.6-sol', 'gpt-5.6-luna'],
                      priorities: { 'gpt-5.6-luna': 9 } })]);
  await q(`INSERT INTO harness (key,label,bundle,model_policy,enabled,is_law_core,zee_type,parent_id)
           VALUES ($1,$2,$3::jsonb,'{}'::jsonb,true,false,'worker',$4)`,
          [childKey, `PB child ${tag}`, JSON.stringify({ personality: 'c' }), parent.id]);

  projId = (await one(`INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`,
                      [`zt-pb-${tag}`, `/tmp/zt-pb-${tag}`])).id;
  await q(`INSERT INTO provider_token (project_id, provider, token, token_hint, label)
           VALUES ($1,'claude',$2,'oat1','Claude A'), ($1,'openai',$3,'sk01','Codex A')`,
          [projId, `sk-ant-oat01-${tag}`, `sk-${tag}`]);

  console.log('\n── what a persona may dispatch (the picker can never offer what the spawn refuses) ──');
  const o = await dispatchOptions({ projectId: projId, harness: childKey });
  const byProv = Object.fromEntries(o.providers.map((p) => [p.provider, p]));
  ok(!!byProv.claude?.blocked_reason && /openai/.test(byProv.claude.blocked_reason),
     `claude is blocked for a persona that INHERITS "openai only" ("${byProv.claude?.blocked_reason}")`);
  ok(!byProv.openai?.blocked_reason, 'openai is pickable — it is the one the policy allows');
  ok(o.default_provider === 'openai', 'and the composer opens on it (the same decision a bare dispatch makes)');
  ok(byProv.openai.models.map((m) => m.key).sort().join() === 'gpt-5.6-luna,gpt-5.6-sol',
     `only the policy's models are offered (${byProv.openai.models.map((m) => m.key).join(', ')})`);
  ok(byProv.openai.models[0].key === 'gpt-5.6-luna',
     'in DEPLOYMENT-PRIORITY order — the one a bare dispatch would pick is first');
  ok(byProv.openai.default_model === 'gpt-5.6-luna',
     'and the ·default the picker marks is what resolveDispatchModel itself resolves');
  ok(byProv.claude.models.length === 0, 'a blocked provider offers no models at all');
  ok(byProv.openai.modes.filter((m) => m.enforced).map((m) => m.mode).join() === '5',
     'the autonomy scale is annotated for the runtime that provider actually runs on (codex = a cxell)');

  console.log('\n── the same persona, with no policy at all ──');
  const bare = await dispatchOptions({ projectId: projId, harness: '' });   // '' = core only
  ok(bare.harness === null, "an explicit empty harness means CORE ONLY, not 'the default'");
  ok(bare.providers.every((p) => !p.blocked_reason), 'with no policy, every connected provider is pickable');
  ok(bare.providers.find((p) => p.provider === 'claude').default_model === 'opus',
     'and claude still defaults to Opus (DEFAULT_ZEE_MODEL — unchanged behaviour)');

  console.log('\n── every listed harness carries the policy a WEARER is subject to ──');
  const list = await listHarnesses({ zeeType: 'worker' });
  const child = list.find((h) => h.key === childKey);
  ok(JSON.stringify(child.model_policy) === '{}', "the child declares no policy of its own…");
  ok(child.effective_model_policy.allow_providers.join() === 'openai',
     '…but its EFFECTIVE policy carries the parent\'s restriction — what the button must render');
} catch (e) {
  console.error('\n✗ threw:', e?.stack || e?.message || e);
  fail++;
} finally {
  if (projId) await q(`DELETE FROM provider_token WHERE project_id=$1`, [projId]).catch(() => {});
  if (projId) await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  await q(`DELETE FROM harness WHERE key IN ($1,$2)`, [childKey, parentKey]).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);

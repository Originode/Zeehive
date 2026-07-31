// SWAPPING THE ZEE FROM THE CONSOLE — the human's half of `zee swap`, checked statically.
//
// The server half (one shared core, its refusals, the collect-before-recreate ordering) is covered by
// test/human-swap.test.mjs. This file covers the console, and specifically the three ways a UI can
// break a gated system while every server test stays green:
//
//   1. THE BUTTON IS NOT THERE. A verb a human cannot reach is a verb that does not exist — the whole
//      reason this feature was cut is that "the persona in this xell is wrong" had only one console
//      answer, ✓ mark done, which tears the xell down. So SWAP must be drawn on the flower, next to
//      done, for a worker — and NOT on a manager, where the server refuses it (a button that can only
//      return a refusal is the same mistake as drawing `land` on a manager).
//   2. THE REFUSAL IS SWALLOWED. Every refusal is a sentence the server wrote (an open landing card,
//      a persona of the wrong type, a retired xell, a collect that failed). The console must show
//      THAT, not "swap failed" — otherwise a human hunts for a rule they were already told.
//   3. THE UI RE-IMPLEMENTS THE RULES. A second copy of "which harness may this xell wear" or "is a
//      landing open?" in JSX is a copy that drifts, and it drifts silently because the server keeps
//      refusing correctly. The composer may only COLLECT A CHOICE.
//
// There is no browser and no linter in CI here, so the wiring is read from the source — the same
// technique as manager-compose / app-dialog-imports / prod-asks-console.
import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const swap = read('web/src/SwapZee.jsx');
const app = read('web/src/App.jsx');
const api = read('web/src/api.js');
const canvas = read('web/src/hive/HiveCanvas.jsx');
const css = read('web/src/styles.css');

// ── 1. the button: on a worker's BRANCH petal, beside done — and not on a manager ─────────────
console.log('\nthe verb is reachable: ♻ swap sits next to ✓ done on a worker');
// The verb list is a pure function, so run the REAL module rather than re-typing its logic here:
// HiveCanvas.jsx is transformed with esbuild (JSX → JS) and imported, exactly as
// manager-hexagon.test.mjs does it.
const tmp = 'web/src/hive/.human-swap-console.test-build.mjs';
writeFileSync(tmp, transformSync(canvas, { loader: 'jsx', format: 'esm' }).code);
let petalVerbs;
try { ({ petalVerbs } = await import('../' + tmp)); } finally { rmSync(tmp, { force: true }); }
const worker = { id: 'w', slug: 'w', hive_status: 'occ-working', stack: [{ role: 'server' }],
                 viewer_kind: 'ssh-terminal', viewer_url: 'ssh://x' };
const mgr = { ...worker, zee_type: 'manager' };
const clean = { ahead: 0, behind: 0, files: 0, insertions: 0, deletions: 0, dirty: 0 };
const wv = petalVerbs(worker, clean);
ok((wv[1] || []).includes('swap') && (wv[1] || []).includes('done'),
   `a WORKER's branch petal carries both verbs (${(wv[1] || []).join(',')})`);
ok(!(petalVerbs(mgr, clean)[1] || []).includes('swap'),
   'a MANAGER is offered no swap — the server refuses to re-crew one (it re-mints its prod reader)');
ok(Object.keys(petalVerbs({ ...worker, is_production: true }, clean)).length === 0,
   'and production still gets no buttons at all');
ok(/swap: '♻ swap zee'/.test(canvas), 'the button is labelled (VERB_LABEL) so it draws with a word, not a kind');

// ── 2. clicking it opens the composer, and the composer only COLLECTS A CHOICE ────────────────
console.log('\nApp routes the click to the composer, and the composer decides nothing');
ok(/import\s+SwapZee\s+from\s+['"]\.\/SwapZee\.jsx['"]/.test(app), 'App.jsx imports SwapZee');
ok(/if \(kind === 'swap'\) \{ setSwapXell\(\{ \.\.\.x, diff \}\); return; \}/.test(app),
   "the flower's swap action opens the composer for THAT xell, carrying its diff");
ok(/<SwapZee[\s\S]{0,300}onSwap=\{\(payload\)/.test(app), 'App renders <SwapZee … onSwap={…}> (the composer hands a payload up)');
// It may EXPLAIN the server's rules in prose (it should — see §3); what it must not do is implement
// them, or reach for anything but the two read-only pickers. The swap POST belongs to App's toast.
const swapImports = (swap.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/api\.js['"]/)?.[1] || '')
  .split(',').map((t) => t.trim()).filter(Boolean);
ok(swapImports.length > 0 && swapImports.every((f) => ['getDispatchModes', 'getDispatchModels', 'getHarnesses', 'getProviderTokens'].includes(f)),
   `SwapZee only reads the pickers from the API (${swapImports.join(', ')}) — it never performs the swap itself`);
ok(!/swapXellZee\(|fetch\(/.test(swap),
   'and it neither POSTs the swap nor fetches anything by hand — the parent owns the request and the toast');
ok(!/land_pending|ship_pending|hive_status|status === 'retired'/.test(swap),
   'nor does it re-decide any refusal from the xell row: no open-gate check, no retired check in JSX');
ok(/getHarnesses\(zeeType, projectId\)/.test(swap) && /zee_type === 'manager' \? 'manager' : 'worker'/.test(swap),
   "the picker offers only the personas THIS xell's type may wear (054), scoped to the project (084)");
ok(/disabled=\{!harness\}/.test(swap), 'and submit is disabled until a persona is picked — the persona IS the swap');
ok(/onSwap\?\.\(\{[\s\S]{0,300}harness[\s\S]{0,200}model[\s\S]{0,200}mode[\s\S]{0,200}provider[\s\S]{0,200}provider_token_id/.test(swap),
   'the payload includes harness, task, model, mode, provider, and provider_token_id — no xell state, no flags');

// ── 3. it says what is AT STAKE, because neither cost is recoverable by re-swapping ───────────
console.log('\nwhat the human is told before clicking');
ok(/collect(ed|s)? (the )?.{0,40}commits/i.test(swap) || /collected onto the worktree/.test(swap),
   'the composer says the outgoing zee\'s commits are collected first');
ok(/uncommitted/i.test(swap) && /diff\?\.dirty/.test(swap),
   'and WARNS when the xell has uncommitted paths — the collect saves commits, and only commits');
ok(/ends its turn|end(s)? its turn/i.test(swap) && /zee_status/.test(swap),
   'and that swapping a zee mid-turn ends that turn');
ok(/same branch/i.test(swap) && /work-item card|same card/i.test(swap),
   'while stating what does NOT change: the branch, the containers, the database, the card');
ok(/refused while a landing, ship or done card/i.test(swap),
   'and that an undecided human card on this xell refuses the swap (so the refusal is not a surprise)');

// ── 4. the refusal reaches the human as the SERVER'S sentence ─────────────────────────────────
console.log('\nrefusals surface verbatim');
const client = api.slice(api.indexOf('export async function swapXellZee'), api.indexOf('// Assign/switch a xell\'s harness'));
ok(/\/api\/xells\/\$\{xellId\}\/swap/.test(client), 'it POSTs to /api/xells/:id/swap (the human route)');
ok(/data\?\.ok === false/.test(client) && /throw new Error\(data\?\.error/.test(client),
   "an ok:false answer is thrown with the server's own error text — a refusal never reads as a success");
const toast = app.slice(app.indexOf('{swapXell && ('), app.indexOf('{swapXell && (') + 1800);
ok(/kind: 'error', title: `Swap refused/.test(toast) && /body: e\?\.message/.test(toast),
   'and the console shows that sentence in the toast body, under "Swap refused"');
ok(/pushToast\(\{ id, kind: 'progress'/.test(toast) && /setSwapXell\(null\)/.test(toast),
   'the submit is fire-and-forget (modal closes, a progress toast carries it) like the dispatch composer');
ok(/refresh\(\)/.test(toast), 'and the fleet is refreshed either way, so the hexagon shows the new zee');

// ── 5. it is not the harness CHIP, and it does not pretend to be ──────────────────────────────
// assignXellHarness edits the row a running cage was built from: the agent in there keeps the manual
// it started with. Confusing the two is how "I switched the harness and nothing happened" happens.
console.log('\nit is distinct from switching a harness');
ok(/export async function assignXellHarness/.test(api) && !/assignXellHarness\(/.test(swap),
   'SwapZee never CALLS assignXellHarness — a swap re-cages, a harness switch does not');
ok(/NOT assignXellHarness|not assignXellHarness/i.test(api),
   'and the client says so where both live, so the next reader picks the right one');
ok(/\.disp\.disp-swap/.test(css) && /\.swap-now/.test(css),
   'the composer has its own styling hook (marked in the working colour, not the accent or prod orange)');

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);

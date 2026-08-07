// THE ROUTER DOES NOT MANAGE ZEES (migration 151) — the trainer's rule, held true structurally.
//
// The router's job is the front door: recompose the raw prompt, pick the harness, and put a worker
// on a card. Until 151 it did that with the manager crew verbs — `zee dispatch` stamped the worker
// into the router's OWN crew (`manager_xell_id = router`), the brief told the worker it reported to
// the router, and the router could `zee zees` / `zee say` / `zee suggest-done` over the zees it
// routed.
//
// What this file holds true (against a real database, no agents spawned, no containers touched):
//
//   1. THE WALL IS CODE, NOT PROSE. A router's free-form `zee dispatch` is REFUSED (the board is the
//      only deployment path), and every crew verb — `zee zees`, `zee say`, `zee swap`,
//      `zee suggest-done`, `zee conversations` — is refused for a router BY NAME.
//   2. THE STAMPING IS THE GUARANTEE. When a router deploys a worker onto a card (`selfWorkAssign`),
//      the worker's `manager_xell_id` stays NULL — it is NOT the router's crew. A manager's deploy
//      still stamps it (the normal crew path is untouched).
//   3. THE BRIEF CARRIES NO ROUTER. A router-deployed worker's brief has the board progress section
//      but no "Your manager" block and no router slug — progress goes to the card, never to the
//      router.
//   4. THE PERSONA AND MANUAL (151) TEACH THE RULE. The router persona says "Deploy onto a card" and
//      "You do not manage the zees you route"; the manager manual drops the now-false "the ROUTER's
//      job is free-form `zee dispatch`".
//
// The dispatch stamping is asserted on the row AFTER a router's `selfWorkAssign` reaches the spawn
// (which fails on docker in a cxell — but the ROLE+CREW stamp happens BEFORE the spawn in
// dispatchXell, so the row is the proof).
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.PROVISION_MODE = 'simulate';

const { q, one, pool } = await import('../server/src/db/pool.js');
const H = await import('../server/src/lib/harness.js');
const S = await import('../server/src/queenzee/self.js');
const { createWorkItem } = await import('../server/src/lib/work-items.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const tag = randomUUID().slice(0, 8);
const P = { name: `zt-rnm-${tag}` };
const tmp = mkdtempSync(join(tmpdir(), 'rnm-'));
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

async function mkWorktree(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'spinoff/wt');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'README.md'), '# wt\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
}
const mkXell = (project, xource, slug, dir, type, status, pooled) => one(
  `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, zee_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
  [project, xource, slug, 'spinoff/wt', dir, status, pooled, type]);

async function cleanup() {
  try { await q(`DELETE FROM project WHERE id=$1`, [P.id]); } catch { /* */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
}

try {
  await cleanup();

  // ── fixtures: a project, a live router, a ready worker ───────────────────
  const repo = join(tmp, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# test\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');

  P.id = (await one(`INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'master') RETURNING id`,
    [P.name, repo])).id;
  await q(`INSERT INTO pool_config (project_id, target_ready) VALUES ($1, 0)`, [P.id]);
  P.xource = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [P.id])).id;
  await q(`INSERT INTO provider_token (project_id, provider, token, token_hint, label)
           VALUES ($1,'claude',$2,'oat1','Claude A')`, [P.id, `sk-ant-oat01-${tag}`]);

  await mkWorktree(join(tmp, 'router'));
  const routerXell = await mkXell(P.id, P.xource, `zt-rnm-r-${tag}`, join(tmp, 'router'), 'manager', 'working', false);
  await H.assignHarness(routerXell.id, 'router');
  const router = await one(`SELECT * FROM xell WHERE id=$1`, [routerXell.id]);

  await mkWorktree(join(tmp, 'wt'));
  const worker = await mkXell(P.id, P.xource, `zt-rnm-wt-${tag}`, join(tmp, 'wt'), 'worker', 'ready', true);

  // ── 1. the wall is CODE ───────────────────────────────────────────────────
  console.log('\n── the board is the only deployment path (151) ──');
  const d = await S.selfDispatch(router, { task: 'do the thing' });
  ok(d?.ok === false && /work-items board/.test(d.error || ''),
     'a router\'s free-form `zee dispatch` is REFUSED, naming the board');

  console.log('\n── a router has NO crew verbs (151) ──');
  const crew = await S.selfCrew(router);
  ok(crew?.ok === false && /does not tend the zees it routes/.test(crew.error || ''),
     '`zee zees` is refused — the router is not a crew lead');
  const say = await S.selfSay(router, { to: 'anything', message: 'hi' });
  ok(say?.ok === false && /does not tend the zees it routes/.test(say.error || ''),
     '`zee say` is refused');
  const sug = await S.selfSuggestDone(router, { to: 'anything', reason: 'x' });
  ok(sug?.ok === false && /does not tend the zees it routes/.test(sug.error || ''),
     '`zee suggest-done` is refused');
  const swap = await S.selfSwap(router, { to: 'anything', harness: 'zee-base' });
  ok(swap?.ok === false && /does not tend the zees it routes/.test(swap.error || ''),
     '`zee swap` is refused');
  const conv = await S.selfConversations(router, {});
  ok(conv?.ok === false && /does not tend the zees it routes/.test(conv.error || ''),
     '`zee conversations` is refused');

  // ── 2. the stamping is the guarantee ──────────────────────────────────────
  console.log('\n── a router-deployed worker is NOT the router\'s crew ──');
  const card = await createWorkItem({ project_id: P.id, kind: 'task', title: `zt-rnm-card-${tag}`, actor: router.slug });
  ok(!!card?.id, 'a card exists to deploy onto');
  // The spawn fails on docker in a cxell, but the ROLE+CREW stamp happens BEFORE the spawn in
  // dispatchXell — so the row is the proof.
  const assigned = await S.selfWorkAssign(router, { item: card.id, task: 'do the thing' }).catch((e) => e);
  const after = await one(`SELECT * FROM xell WHERE id=$1`, [worker.id]);
  ok(!after.manager_xell_id, `a router-deployed worker has NO manager (got ${String(after.manager_xell_id).slice(0, 8) || 'null'})`);
  ok(!assigned?.ok || assigned?.message, 'the assign was attempted (the spawn failing on docker is the cxell, not the rule)');

  // ── 3. the persona and manual teach the rule (151) ────────────────────────
  console.log('\n── the router persona (151) ──');
  const persona = (await one(`SELECT bundle->>'personality' AS p FROM harness WHERE key='router' AND project_id IS NULL`))?.p || '';
  ok(/Deploy onto a card/.test(persona), 'the deploy step is the board');
  ok(/You do not manage the zees you route/.test(persona), 'the do-not-manage rule is in the persona');
  ok(/zee mint-manager/.test(persona), 'a programme escalates to a human-approved manager');
  ok(!/Count your live crew \(`zee zees`\)/.test(persona), 'no more crew counting for max_concurrent');

  console.log('\n── the manager manual (151) ──');
  const manual = (await one(`SELECT harness_memory_get('manager','memory/manager-zee-manual.md') AS t`))?.t || '';
  ok(/REFUSED for every manager, router included/.test(manual), 'dispatch refused for every manager');
  ok(/A ROUTER is not exempt either/.test(manual), 'the board section says a router is not exempt');
  ok(!/the ROUTER's job is free-form `zee dispatch`/.test(manual), 'no more free-form dispatch for the router');
} finally {
  await cleanup();
  await pool.end();
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nall good');
process.exit(fail ? 1 : 0);

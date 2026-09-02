// A RENAME MUST NOT MINT A NEW PORT COLLISION (TKT-85 family).
//
// The pool mints a xell before any task exists, so a dispatch RENAMES it — and the rename
// recomputed the app-tier ports from the new slug's hash with nobody checking who held them. That
// is almost certainly where the live duplicates came from: the fleet's colliding pairs sit on
// task-named xells (…hand-me-a-self-contained-prompt-that-describ-9f6033 and a pooled xell both on
// :4824/:5324). A rename runs on EVERY dispatch, so leaving it on the formula would quietly undo
// the allocation provisioning now does.
//
// Driven for real: a fixture repo with real git worktrees, real container rows, the real
// renameXellForTask (which shells out to the real scripts/rename-xell.sh).
//
//   • a rename onto a slot ANOTHER xell holds allocates past it — rows and URLs, as a pair;
//   • a rename whose slot the xell ALREADY occupies keeps its ports: the rows being re-stamped
//     are not an obstacle to themselves, so a rename causes no needless port churn;
//   • and nothing lands on the holder's ports (which is what the formula did).
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PROVISION_MODE = 'simulate';
process.env.BUILD_MODE = 'simulate';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { renameXellForTask } = await import('../server/src/lib/rename-xell.js');

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const CTX = `renamealloc-${tag}`;
const SB = 33100, WB = 35200;         // far from every live project's ladder
const tmp = mkdtempSync(join(tmpdir(), `renamealloc-${tag}-`));
const repo = join(tmp, 'repo');
let projId = null;

const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
// A xell with a REAL worktree (the rename script moves it) and an app-tier pair, unbuilt so
// canRename allows the move.
const mkXell = async (slug, serverPort, webPort) => {
  git('worktree', 'add', '-q', join(repo, '.claude', 'worktrees', slug), '-b', `spinoff/${slug}`, 'main');
  const id = (await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled)
     VALUES ($1,(SELECT id FROM xource WHERE project_id=$1),$2,$3,$4,'ready',true) RETURNING id`,
    [projId, slug, `spinoff/${slug}`, join(repo, '.claude', 'worktrees', slug)])).id;
  for (const [role, port] of [['server', serverPort], ['webapp', webPort]]) {
    await q(
      `INSERT INTO container (project_id,role,tier,isolation,name,image_tag,docker_ctx,host,host_port,
          internal_port,url,compose_project,owner_xell_id,health)
       VALUES ($1,$2,'spinoff','per-xell',$3,$4,$5,'10.9.9.9',$6,$7,$8,$9,$10,'down')`,
      [projId, role, `renamealloc-${slug}-${role}`, `renamealloc-${role}:${slug}`, CTX, port,
       role === 'server' ? 3000 : 5173, `http://10.9.9.9:${port}`, `renamealloc-${slug}`, id]);
  }
  return id;
};
const portsOf = async (id) => Object.fromEntries((await q(
  `SELECT role, host_port, url FROM container WHERE owner_xell_id=$1 AND role IN ('server','webapp')`, [id]))
  .map((r) => [r.role, { port: Number(r.host_port), url: r.url }]));

try {
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git('config', 'user.email', 'zt@example.invalid'); git('config', 'user.name', 'zt');
  writeFileSync(join(repo, 'README'), 'fixture\n');
  git('add', '-A'); git('commit', '-qm', 'fixture');

  // port_slot_mod = 1: EVERY slug hashes to slot 0, so every rename wants the same pair — the
  // collision the formula used to write, made deterministic.
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch, port_server_base, port_web_base, port_slot_mod)
     VALUES ($1,$2,'main',$3,$4,1) RETURNING id`,
    [`zt-renamealloc-${tag}`, repo, SB, WB])).id;
  await q(`INSERT INTO xource (project_id, ref) VALUES ($1,'main')`, [projId]);
  await q(`INSERT INTO pool_config (project_id, target_ready) VALUES ($1,0)`, [projId]);

  const holder = await mkXell(`renamealloc-holder-${tag}`, SB, WB);          // owns the slot-0 pair
  const keeper = await mkXell(`renamealloc-keeper-${tag}`, SB + 1, WB + 1);  // already one slot up
  const mover = await mkXell(`renamealloc-mover-${tag}`, SB + 9, WB + 9);    // must find a new slot

  console.log('\n── a rename never lands on the pair another xell holds ──');
  const rMover = await renameXellForTask(mover, 'Nightly rota export');
  ok(rMover.renamed === true, `the rename itself still happens (${rMover.slug || rMover.reason})`);
  const mP = await portsOf(mover);
  ok(mP.server.port !== SB && mP.webapp.port !== WB,
     `the renamed xell did NOT take the holder's :${SB}/:${WB} (it has :${mP.server.port}/:${mP.webapp.port}) `
     + '— the formula would have handed it exactly those');
  ok(mP.server.port !== SB + 1 && mP.webapp.port !== WB + 1,
     `…nor the keeper's :${SB + 1}/:${WB + 1}`);
  ok(mP.server.port - SB === mP.webapp.port - WB,
     `…and its ports stay PAIRED on one slot (${mP.server.port - SB})`);
  ok(mP.server.url.endsWith(`:${mP.server.port}`) && mP.webapp.url.endsWith(`:${mP.webapp.port}`),
     `the URLs follow the ports (${mP.webapp.url})`);
  const hP = await portsOf(holder);
  ok(hP.server.port === SB && hP.webapp.port === WB, 'the holder is untouched — a rename moves one xell');

  console.log('\n── a rename onto the slot it already occupies keeps its ports (no churn) ──');
  const rKeeper = await renameXellForTask(keeper, 'Payroll cutoff banner');
  const kP = await portsOf(keeper);
  ok(rKeeper.renamed === true, `renamed (${rKeeper.slug || rKeeper.reason})`);
  ok(kP.server.port === SB + 1 && kP.webapp.port === WB + 1,
     `it kept :${kP.server.port}/:${kP.webapp.port} — the rows it is re-stamping are not an obstacle `
     + 'to themselves, so a rename does not walk the ladder for nothing');
} finally {
  await q(`DELETE FROM xell_uses_container WHERE xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [projId]).catch(() => {});
  await q(`DELETE FROM container WHERE project_id=$1`, [projId]).catch(() => {});
  await q(`DELETE FROM xell WHERE project_id=$1`, [projId]).catch(() => {});
  await q(`DELETE FROM pool_config WHERE project_id=$1`, [projId]).catch(() => {});
  await q(`DELETE FROM xource WHERE project_id=$1`, [projId]).catch(() => {});
  await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
  await pool.end();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);

// STALE-LANDING NUDGE test — proves a landing that can never land TELLS THE ZEE, instead of dying
// quietly in the log.
//
// A cxell zee's turn ENDS at `zee land`. If main then moves past its sha (another xell lands first),
// the approval can never fast-forward: the gate closes the row as 'stale' — honestly, and to nobody.
// The zee went on believing a human was still deciding, its work stranded on a branch that would
// never be asked about again. The recovery exists (`zee sync` → `zee land`), but only the zee can
// run it, and it was the one party that could not see the failure happen.
//
// Both death paths are exercised against a THROWAWAY postgres + REAL git repos:
//   • APPROVED → main moved → landApproved() closes it stale AND resumes the cxell session.
//   • PENDING  → main moved while a human was away → sweepStalePending() closes it stale AND
//                resumes the cxell session (no human click needed).
// Plus the no-cxell case: nothing to nudge → a TEND is raised so a human sees it.
//
// The only seam is `docker` (stubbed on PATH — its argv + stdin are what we ASSERT on). Everything
// else is the real code path.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { landApproved, sweepStalePending } = await import('../server/src/queenzee/landgate.js');
const { tendOpen } = await import('../server/src/lib/status.js');

const REPO_ROOT = process.cwd();
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const git = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The nudge is fire-and-forget — wait briefly for the fake docker to record the resume.
const DOCKER_LOG = join(mkdtempSync(join(tmpdir(), 'stale-log-')), 'docker.log');
process.env.DOCKER_LOG = DOCKER_LOG;
process.env.PATH = `${join(REPO_ROOT, 'test', '_bin')}:${process.env.PATH}`;
const readLog = () => (existsSync(DOCKER_LOG) ? readFileSync(DOCKER_LOG, 'utf8') : '');
const resetLog = () => { try { rmSync(DOCKER_LOG); } catch { /* first run */ } };
async function awaitResume() {
  let log = '';
  for (let i = 0; i < 30 && !/--resume/.test(log); i++) { await sleep(120); log = readLog(); }
  return log;
}

// ── a xource whose main MOVES PAST the sha a zee is trying to land ─────────────
const tmp = mkdtempSync(join(tmpdir(), 'land-stale-'));
const src = join(tmp, 'src');
git(tmp, ['init', '-q', '-b', 'main', 'src']);
git(src, ['config', 'user.email', 'test@zeehive.local']); git(src, ['config', 'user.name', 'test']);
writeFileSync(join(src, 'a.txt'), 'A\n'); git(src, ['add', '.']); git(src, ['commit', '-qm', 'A (base)']);
const shaA = git(src, ['rev-parse', 'HEAD']);

// the zee's branch: one commit on top of A. This is what it asked to land.
git(src, ['branch', 'spinoff/stale', shaA]);
git(src, ['checkout', '-q', 'spinoff/stale']);
writeFileSync(join(src, 'zee.txt'), 'zee work\n'); git(src, ['add', '.']); git(src, ['commit', '-qm', 'Z (zee work)']);
const shaZ = git(src, ['rev-parse', 'HEAD']);
git(src, ['checkout', '-q', 'main']);

// SOMEONE ELSE LANDS FIRST — main moves to a commit that is not on the zee's branch.
writeFileSync(join(src, 'b.txt'), 'B\n'); git(src, ['add', '.']); git(src, ['commit', '-qm', 'B (another xell landed first)']);
const shaB = git(src, ['rev-parse', 'HEAD']);

console.log('── the setup: main moved past the sha the zee asked to land ──');
ok(spawnSync('git', ['-C', src, 'merge-base', '--is-ancestor', shaB, shaZ]).status !== 0,
  `main (${shaB.slice(0, 8)}) is NOT an ancestor of the zee's sha (${shaZ.slice(0, 8)}) — it can never fast-forward`);

// ── seed the throwaway DB ─────────────────────────────────────────────────────
await q(`DELETE FROM project WHERE name='landstaletest'`);
const project = await one(
  `INSERT INTO project (name, repo_root, main_branch, auto_approve_land)
   VALUES ('landstaletest', $1, 'main', false) RETURNING *`, [src]);
const xource = await one(
  `INSERT INTO xource (project_id, ref, xell_id) VALUES ($1,'main',NULL) RETURNING *`, [project.id]);
const mkXell = (slug) => one(
  `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, head_commit, status, self_token_hash)
   VALUES ($1,$2,$3,'spinoff/stale',$4,$5,'working',$6) RETURNING *`,
  [project.id, xource.id, slug, join(tmp, `wt-${slug}`), shaA, `hash-${slug}`]);
// a LIVE CXELLD zee (entrypoint cxell-cli + an ssh-terminal cxell) — the only kind we can resume
const SID = '99999999-8888-7777-6666-555555555555';
const liveXell = await mkXell('stale-live');
await one(
  `INSERT INTO zee (xell_id, attach_mode, entrypoint, kind, viewer_kind, viewer_url,
                    claude_session_id, model, status)
   VALUES ($1,'headless-spawn','cxell-cli','headless','ssh-terminal','ssh://zee@127.0.0.1:22002',
           $2,'opus','idle') RETURNING id`, [liveXell.id, SID]);

const mkRequest = (xellId, status, sha = shaZ) => one(
  `INSERT INTO land_request (project_id, xell_id, ref, old_sha, new_sha, commits, status, decided_at, decided_by)
     VALUES ($1,$2,'refs/heads/main',$3,$4,'[]'::jsonb,$5::land_status,
             CASE WHEN $5::text='approved' THEN now() END, CASE WHEN $5::text='approved' THEN 'human@test' END)
   RETURNING *`, [project.id, xellId, shaA, sha, status]);

// ── 1. an APPROVED landing that main moved past → stale + NUDGE ───────────────
console.log('\n── approved landing goes stale → the zee is nudged to sync ──');
resetLog();
const approvedReq = await mkRequest(liveXell.id, 'approved');
const closed = await landApproved(approvedReq, 'human@test');
ok(closed?.stale === true, 'landApproved reports it stale rather than retrying a doomed push');
const row1 = await one(`SELECT * FROM land_request WHERE id=$1`, [approvedReq.id]);
ok(row1.status === 'stale', `the row is closed 'stale' (${row1.status})`);
ok(git(src, ['rev-parse', 'main']) === shaB, 'main did NOT move — nothing was force-landed to make it fit');

const log1 = await awaitResume();
ok(/exec/.test(log1) && /--resume/.test(log1), 'the queenzee ran `docker exec … claude … --resume` to re-invoke the zee');
ok(log1.includes(SID), `the resume targeted THIS cxell session id (${SID.slice(0, 8)}…)`);
ok(/went STALE/.test(log1), 'the prompt tells the zee its landing went STALE (not rejected, not landed)');
ok(/zee sync/.test(log1) && /zee land/.test(log1), 'the prompt gives the ONLY recovery: `zee sync`, then `zee land` again');
ok(/still on your branch/.test(log1), 'it says the commits are safe — a stale sha is not lost work');
ok(!/amend/.test(log1) || /do NOT amend/i.test(log1), 'it explicitly refuses the amend/force workaround');
ok(/stale:.*moved past/.test(String(row1.note || '')) && /nudged/.test(String(row1.note || '')),
  `the row records WHY it died and that the zee was told: "${String(row1.note || '').slice(0, 90)}…"`);
ok((await tendOpen(liveXell.id)) === false, 'no tend raised — the zee itself was reached, so no human is needed');

// ── 2. a PENDING landing main moved past → swept stale + NUDGE, no human click ─
console.log('\n── held landing dies while a human is away → swept + nudged ──');
resetLog();
const pendingReq = await mkRequest(liveXell.id, 'pending');
const swept = await sweepStalePending();
ok(swept.stale >= 1, `the sweep closed ${swept.stale} dead held request(s) (checked ${swept.checked})`);
const row2 = await one(`SELECT * FROM land_request WHERE id=$1`, [pendingReq.id]);
ok(row2.status === 'stale', `the held row is closed 'stale' (${row2.status}) — a human is no longer asked to approve the impossible`);
const log2 = await awaitResume();
ok(/went STALE/.test(log2) && /zee sync/.test(log2), 'the zee was nudged for the held request too — same sync-and-ask-again instruction');

ok(row2.decided_by === 'queenzee@stale',
  `the closer is named honestly (${row2.decided_by}) — the queenzee noticed, no human decided it`);

// A row that CAN still fast-forward must be left completely alone.
const goodReq = await mkRequest(liveXell.id, 'pending', git(src, ['rev-parse', 'main']));
await sweepStalePending();
ok((await one(`SELECT status FROM land_request WHERE id=$1`, [goodReq.id])).status === 'pending',
  'a landable held request is untouched by the sweep — only proven non-fast-forwards are closed');

// ── 3. THE NUDGE ITSELF FAILS TO DELIVER → tend + an honest receipt ───────────
// The resume is fire-and-forget, so "we started one" is all the delivery layer can return. For a
// stale landing that is not good enough: it is the zee's only way to learn, so a resume that never
// starts (docker gone, cxell torn down between the SELECT and the exec) must reach a human — and
// must not leave a receipt claiming the zee was told. Reproduced exactly as it happens in the wild,
// by taking `docker` off PATH (→ spawn ENOENT) for this one close.
console.log('\n── the resume cannot even start → a human is flagged, and the receipt says so ──');
{
  const savedPath = process.env.PATH;
  process.env.PATH = '/nonexistent';                       // no docker → the nudge cannot spawn
  const req3 = await mkRequest(liveXell.id, 'approved');
  await landApproved(req3, 'human@test');
  let tended = false;
  for (let i = 0; i < 30 && !tended; i++) { await sleep(120); tended = await tendOpen(liveXell.id); }
  process.env.PATH = savedPath;
  ok(tended === true, 'an undeliverable nudge raises a TEND — the zee never heard, so a human must');
  const row3 = await one(`SELECT * FROM land_request WHERE id=$1`, [req3.id]);
  ok(row3.status === 'stale', `the row is still closed 'stale' (${row3.status}) — the landing is dead either way`);
  ok(/could NOT be nudged/.test(String(row3.note || '')),
    `the receipt says the zee was NOT reached, not that it was: "${String(row3.note || '').slice(0, 80)}…"`);
}

// ── 4. NOBODY HOME: no live cxell to nudge → raise a tend for a human ─────────
console.log('\n── no live cxell to nudge → a human is flagged instead ──');
const orphan = await mkXell('stale-orphan');   // no zee row at all
const orphanReq = await mkRequest(orphan.id, 'approved');
await landApproved(orphanReq, 'human@test');
ok((await one(`SELECT status FROM land_request WHERE id=$1`, [orphanReq.id])).status === 'stale',
  'the row still closes stale when there is no zee to tell');
ok((await tendOpen(orphan.id)) === true,
  'a TEND is raised — an unreachable zee means a stale landing must reach a HUMAN, not vanish');

// ── done ──────────────────────────────────────────────────────────────────────
await pool.end().catch(() => {});
console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);

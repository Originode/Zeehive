// SHIP-PAYLOAD test (ticket #65) — the card WARNS that a deploy carries every landing on main and
// never says which; this is the payload named. The commits between the last SHIPPED commit for the
// target and the one being deployed, each with who landed it and what it was for.
//
// The payload is computed from REAL git + REAL landing rows: a real xource with real commits, real
// land_request rows built from pushedCommits() (the SAME helper the landgate uses), real work_item
// + ticket rows, and real ship_request rows. Nothing is fabricated at the sha level.
//
//   • A1 — the payload between a previous shipped sha and the ship under test: 3 commits from 2
//     xells, each attributed to the LANDING that carried it (not the commit author), with its xell,
//     landed_at and work item/ticket.
//   • A2 — "yours": the requesting xell's own commits are counted.
//   • A3 — the same range, scoped by SITE: a ship to a different site starts from that site's own
//     last shipped sha (the default-site ship is not its "before").
//   • B1 — first ship to a target: no previous shipped sha → a note, not a crash.
//   • B2 — the read DEGRADES, never blocks: a repo that cannot resolve the range returns
//     { ok:false } (the card says "could not be read"), and a DB read that THROWS is absorbed by
//     the outer try/catch the same way — an advisory panel must never refuse a ship.
//   • C1 — listShipRequests attaches the payload to every open ship row (the console path).
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required — run against a throwaway db (zee db-sandbox --migrate)'); process.exit(2); }

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

const client = new pg.Client({ connectionString: url });
const tmp = mkdtempSync(join(tmpdir(), 'ship-payload-'));
const PID = '00000000-0000-4000-8000-00000000f511';
const XOURCE = '00000000-0000-4000-8000-00000000f522';
const XELL_A = '00000000-0000-4000-8000-00000000f533';
const XELL_B = '00000000-0000-4000-8000-00000000f544';
const XELL_C = '00000000-0000-4000-8000-00000000f555';
const XELL_D = '00000000-0000-4000-8000-00000000f566';

async function cleanup() {
  try { await client.query(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
}

// Land `n` commits from a worktree onto main and return the real land_request row (status=landed),
// exactly the shape the landgate would have written — same pushedCommits() helper, same columns.
async function landFrom(repo, wt, xellId, n, prefix) {
  const oldSha = git(repo, 'rev-parse', 'main');
  for (let i = 1; i <= n; i++) {
    writeFileSync(join(wt, `${prefix}${i}.txt`), `${prefix}${i}\n`);
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', `${prefix}${i}: landed by ${prefix} (${prefix}${i})`);
  }
  git(repo, 'merge', '-q', '--ff-only', git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'));
  const newSha = git(repo, 'rev-parse', 'main');
  const { pushedCommits } = await import('../server/src/queenzee/landgate.js');
  const commits = pushedCommits(repo, oldSha, newSha);
  const row = await client.query(
    `INSERT INTO land_request (project_id, xell_id, ref, old_sha, new_sha, commits, stat,
        status, decided_at, decided_by, landed_at)
     VALUES ($1,$2,'refs/heads/main',$3,$4,$5::jsonb,$6::jsonb,'landed',now(),'auto-approve@policy',now())
     RETURNING *`,
    [PID, xellId, oldSha, newSha, JSON.stringify(commits), JSON.stringify({ commits: commits.length })]);
  return row.rows[0];
}

await client.connect();
try {
  await client.query(`DELETE FROM project WHERE id=$1`, [PID]).catch(() => {});
  const { computeShipPayload, shipPayloadSummary } = await import('../server/src/queenzee/ship-payload.js');
  const { listShipRequests } = await import('../server/src/queenzee/shipgate.js');

  // ── a real xource with real main ───────────────────────────────────────────
  const repo = join(tmp, 'xource'); mkdirSync(repo);
  git(tmp, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.email', 'test@zeehive');
  git(repo, 'config', 'user.name', 'ship-payload-test');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
  const baseSha = git(repo, 'rev-parse', 'HEAD');

  // xell worktrees are created LAZILY, each forking from the CURRENT main tip at that xell's turn
  // (a real worktree forked from base could not fast-forward after main moved — same as reality).
  const mkWt = (name, branch) => {
    const wt = join(tmp, name);
    git(repo, 'worktree', 'add', '-q', '-b', branch, wt, git(repo, 'rev-parse', 'main'));
    git(wt, 'config', 'user.email', 'xell@xell.zeehive.local');
    git(wt, 'config', 'user.name', 'xell');
    return wt;
  };

  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'ship-payload-test',$2,'main')`, [PID, repo]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'main')`, [XOURCE, PID]);
  const mkXell = (id, slug, branch, wt) => client.query(
    `INSERT INTO xell (id, project_id, xource_id, slug, branch, worktree_path, status)
       VALUES ($1,$2,$3,$4,$5,$6,'working')`, [id, PID, XOURCE, slug, branch, wt]);
  await mkXell(XELL_A, 'payload-a', 'spinoff/a', join(tmp, 'wt-a'));
  await mkXell(XELL_B, 'payload-b', 'spinoff/b', join(tmp, 'wt-b'));
  await mkXell(XELL_C, 'payload-c', 'spinoff/c', join(tmp, 'wt-c'));
  await mkXell(XELL_D, 'payload-d', 'spinoff/d', join(tmp, 'wt-d'));

  // work items + tickets for attribution
  const wiA = await client.query(
    `INSERT INTO work_item (project_id, kind, title, xell_id) VALUES ($1,'task','A lands the widget',$2) RETURNING id`, [PID, XELL_A]);
  const tA = await client.query(
    `INSERT INTO ticket (project_id, title, kind) VALUES ($1,'A ticket','feature') RETURNING id`, [PID]);
  await client.query(`UPDATE work_item SET ticket_id=$1 WHERE id=$2`, [tA.rows[0].id, wiA.rows[0].id]);
  const wiB = await client.query(
    `INSERT INTO work_item (project_id, kind, title, xell_id) VALUES ($1,'task','B fixes the gizmo',$2) RETURNING id`, [PID, XELL_B]);
  const tB = await client.query(
    `INSERT INTO ticket (project_id, title, kind) VALUES ($1,'B ticket','bug') RETURNING id`, [PID]);
  await client.query(`UPDATE work_item SET ticket_id=$1 WHERE id=$2`, [tB.rows[0].id, wiB.rows[0].id]);
  const wiC = await client.query(
    `INSERT INTO work_item (project_id, kind, title, xell_id) VALUES ($1,'task','C ships the payload',$2) RETURNING id`, [PID, XELL_C]);
  const tC = await client.query(
    `INSERT INTO ticket (project_id, title, kind) VALUES ($1,'C ticket','feature') RETURNING id`, [PID]);
  await client.query(`UPDATE work_item SET ticket_id=$1 WHERE id=$2`, [tC.rows[0].id, wiC.rows[0].id]);
  const wiD = await client.query(
    `INSERT INTO work_item (project_id, kind, title, xell_id) VALUES ($1,'task','D polishes the trim',$2) RETURNING id`, [PID, XELL_D]);

  // ── build the history: two landings BEFORE the last shipped sha, two AFTER ──
  const wtA = mkWt('wt-a', 'spinoff/a');
  await landFrom(repo, wtA, XELL_A, 2, 'a');   // tip T1 — BEFORE the last ship
  const wtB = mkWt('wt-b', 'spinoff/b');
  await landFrom(repo, wtB, XELL_B, 1, 'b');   // tip T2 — BEFORE the last ship
  const tipT2 = git(repo, 'rev-parse', 'main');
  // the PREVIOUS SHIPPED ship for this target sits at T2 — the payload's "from"
  await client.query(
    `INSERT INTO ship_request (project_id, xell_id, commit, reason, status, requested_at, decided_at, decided_by, finished_at)
       VALUES ($1,$2,$3,'previous ship','shipped',now()-interval '2 hours',now()-interval '2 hours','human@console',now()-interval '2 hours')`,
    [PID, XELL_A, tipT2]);
  const lastShipped = await client.query(
    `INSERT INTO ship_request (project_id, xell_id, commit, reason, status, requested_at, decided_at, decided_by, finished_at)
       VALUES ($1,$2,$3,'the ship under test','pending',now(),NULL,NULL,NULL)
       RETURNING *`, [PID, XELL_C, 'pending-commit-placeholder']);

  // two MORE landings land, then the ship is aimed at the NEW tip (what requestShip would resolve)
  const wtC = mkWt('wt-c', 'spinoff/c');
  await landFrom(repo, wtC, XELL_C, 2, 'c');   // tip T3 — C's work, AFTER the last ship
  const wtD = mkWt('wt-d', 'spinoff/d');
  await landFrom(repo, wtD, XELL_D, 1, 'd');   // tip T4 — D's work, AFTER the last ship
  const tipT4 = git(repo, 'rev-parse', 'main');
  await client.query(`UPDATE ship_request SET commit=$1 WHERE id=$2`, [tipT4, lastShipped.rows[0].id]);

  const project = (await client.query(`SELECT * FROM project WHERE id=$1`, [PID])).rows[0];
  const shipRow = (await client.query(`SELECT * FROM ship_request WHERE id=$1`, [lastShipped.rows[0].id])).rows[0];

  // ── A1: the payload names the commits between the last shipped sha and this one ──
  console.log('\n── A: the payload between the last shipped sha and the ship under test ──');
  const p = await computeShipPayload(project, shipRow);
  ok(p.ok === true, `A1: payload computed (${p.ok})`);
  ok(p.from === tipT2, `A1: 'from' is the last shipped sha for the target (${String(p.from).slice(0, 8)})`);
  ok(p.to === tipT4, `A1: 'to' is the ship's commit (${String(p.to).slice(0, 8)})`);
  ok(p.commits.length === 3, `A1: 3 commits in the range, got ${p.commits.length}`);
  const cSubjects = p.commits.map((c) => c.subject);
  ok(cSubjects.some((s) => /^c1:/.test(s)) && cSubjects.some((s) => /^c2:/.test(s)) && cSubjects.some((s) => /^d1:/.test(s)),
     'A1: the payload contains C1, C2 (the requester) and D1 (another xell) — the c and d landings');
  ok(!cSubjects.some((s) => /^[ab]/.test(s)), 'A1: the a/b commits (before the last ship) are NOT in the payload');

  const cCommit = p.commits.find((c) => /^c1:/.test(c.subject));
  const dCommit = p.commits.find((c) => /^d1:/.test(c.subject));
  ok(cCommit.xell_slug === 'payload-c', `A1: C1 is attributed to the xell that LANDED it (payload-c), not the commit author`);
  ok(cCommit.landed_at, 'A1: C1 carries when it landed (landed_at)');
  ok(cCommit.ticket && cCommit.ticket.number > 0 && cCommit.work_item?.title === 'C ships the payload',
     `A1: C1 carries its xell's work item + ticket (${cCommit.work_item?.title})`);
  ok(dCommit.xell_slug === 'payload-d', `A1: D1 is attributed to payload-d`);
  ok(dCommit.work_item?.title === 'D polishes the trim', 'A1: D1 carries D\'s work item');

  // ── A1b: the review gate annotation (ticket #79) — every carried commit carries its review state ──
  console.log('\n── A1b: the review-state annotation ──');
  ok(p.commits.every((c) => c.reviewed === false) && p.commits.every((c) => Array.isArray(c.reviews)),
     `A1b: with no review recorded, every commit is reviewed:false with an empty reviews list`);
  ok(p.summary.unread === 3 && p.summary.unknown === 0 && p.summary.review_error === null,
     `A1b: the summary counts 3 unread, 0 unknown (got unread=${p.summary.unread}, unknown=${p.summary.unknown})`);
  // record a review for C1 → it flips to reviewed:true and unread drops to 2
  await client.query(
    `INSERT INTO review (project_id, xell_id, reviewer, commit_sha, verdict, findings_count, report)
       VALUES ($1,$2,'payload-reviewer',$3,'clean',0,NULL)`, [PID, XELL_C, cCommit.sha]);
  const p2 = await computeShipPayload(project, shipRow);
  const cCommit2 = p2.commits.find((c) => /^c1:/.test(c.subject));
  ok(cCommit2.reviewed === true && cCommit2.reviews?.length === 1
     && cCommit2.reviews[0].reviewer === 'payload-reviewer',
     'A1b: a recorded review flips that commit to reviewed:true with the review row attached');
  ok(p2.summary.unread === 2, `A1b: unread drops to 2 (got ${p2.summary.unread})`);
  const phrase2 = shipPayloadSummary(p2, 'payload-c');
  ok(/2 unread/.test(phrase2), `A1b: the summary phrase names the remaining unread (${phrase2})`);

  // ── A2: the one-line summary counts yours ──
  console.log('\n── A2: the summary ──');
  const s = p.summary;
  ok(s.commits === 3 && s.xells === 2 && s.yours === 2,
     `A2: summary = 3 commits from 2 xells, 2 yours (got ${s.commits}/${s.xells}/${s.yours})`);
  const phrase = shipPayloadSummary(p, 'payload-c');
  ok(phrase.includes('3 commits from 2 xells') && phrase.includes("2 are payload-c's"),
     `A2: the phrase names the count and yours (${phrase})`);

  // ── A3: site scoping — a ship to a DIFFERENT site starts from that site's own last shipped ──
  console.log('\n── A3: target scoping (site) ──');
  const otherSite = await client.query(
    `INSERT INTO deploy_site (project_id, key, tier, is_default, docker_ctx) VALUES ($1,'vps','prod',false,'vps-ctx') RETURNING id`, [PID]);
  const siteShip = await client.query(
    `INSERT INTO ship_request (project_id, xell_id, site_id, commit, reason, status)
       VALUES ($1,$2,$3,$4,'ship to the vps site','pending') RETURNING *`,
    [PID, XELL_A, otherSite.rows[0].id, tipT4]);
  const pSite = await computeShipPayload(project, siteShip.rows[0]);
  // No ship has ever completed to the vps site → the site-scoped lookup finds NO previous ship,
  // even though the default site has one — the payload says "first ship to this target".
  ok(pSite.ok === true && pSite.note && /first ship to this target/.test(pSite.note),
     `A3: a different site has no previous shipped sha of its own → '${pSite.note?.slice(0, 50)}…'`);

  // ── B1: re-ship of the SAME sha as the last shipped → nothing new (a note, not a crash) ──
  console.log('\n── B: degrade, never block ──');
  const sameShip = await client.query(
    `INSERT INTO ship_request (project_id, xell_id, commit, reason, status)
       VALUES ($1,$2,$3,'re-ship of the same sha','pending') RETURNING *`,
    [PID, XELL_D, tipT2]);
  const pSame = await computeShipPayload(project, sameShip.rows[0]);
  ok(pSame.ok === true && /nothing new since the last ship/.test(pSame.note || ''),
     `B1: a re-ship of the same sha → "nothing new", not a crash (${pSame.note?.slice(0, 50)}…)`);
  ok(pSame.commits.length === 0, 'B1: …and an empty list, not a fabricated one');

  // ── B2: the read degrades — an unresolvable repo → ok:false, never a throw, never a lie ──
  const broken = await computeShipPayload({ id: PID, repo_root: join(tmp, 'does-not-exist') }, shipRow);
  ok(broken.ok === false && broken.error, `B2: an unresolvable repo → { ok:false, error } (${broken.error?.slice(0, 40)}…)`);

  // ── B3: a garbage commit degrades to ok:false, never throws ──
  let threw = false;
  try { await computeShipPayload(project, { ...shipRow, commit: 'not-a-sha' }); } catch (e) { threw = true; }
  ok(!threw, 'B3: computeShipPayload never THROWS for a garbage commit (it degrades)');
  const pGarbage = await computeShipPayload(project, { ...shipRow, commit: 'not-a-sha' });
  ok(pGarbage.ok === false, `B3: …and returns ok:false, not a first-ship lie (ok=${pGarbage.ok}, err=${pGarbage.error?.slice(0, 40)}…)`);

  // ── C1: listShipRequests attaches the payload to every open ship row (the console path) ──
  console.log('\n── C: the console path ──');
  const open = await listShipRequests(PID);
  const ours = open.find((r) => r.id === shipRow.id);
  ok(ours && ours.payload && ours.payload.ok === true, 'C1: listShipRequests carries the payload on the open ship');
  ok(ours.payload.commits.length === 3, `C1: …with the 3 commits (got ${ours.payload.commits?.length})`);
  const siteOurs = open.find((r) => r.id === siteShip.rows[0].id);
  ok(siteOurs && siteOurs.payload && /first ship/.test(siteOurs.payload.note || ''),
     'C1: the site-scoped ship carries ITS OWN payload note (not the default site\'s)');

  // ── C2: the zee's own answer (selfShip) names the payload too, so the CLI and the card agree ──
  console.log('\n── C2: the CLI answer a zee gets ──');
  await client.query(
    `INSERT INTO zee (id, xell_id, name, status, kind, entrypoint, attach_mode, model)
       VALUES ($1,$2,'payload-zee','working','headless','headless-sdk','headless-spawn','test')`,
    ['00000000-0000-4000-8000-00000000f600', XELL_C]);
  const { selfShip } = await import('../server/src/queenzee/self.js');
  const answer = await selfShip({ id: XELL_C, project_id: PID, slug: 'payload-c' }, { reason: 'ship the payload' });
  ok(answer.ok === true && /Ship REQUESTED/.test(answer.message), 'C2: the zee gets the ship REQUESTED answer');
  ok(/PAYLOAD: 3 commits from 2 xells/.test(answer.message), `C2: …and the answer NAMES the payload (${answer.message.match(/PAYLOAD: [^.]*/)?.[0]})`);
  ok(/2 are payload-c's/.test(answer.message), 'C2: …including how many are the requester\'s own');
} finally {
  await cleanup();
  await client.end();
  const { pool } = await import('../server/src/db/pool.js');
  await pool.end().catch(() => {});
}

console.log(`\n${fail === 0 ? 'ALL PASSED ✓' : `${fail} FAILURE(S) ✗`}`);
process.exit(fail === 0 ? 0 : 1);

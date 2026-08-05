// IS SOMEBODY ALREADY IN THIS WORK? — ticket #33, against real xells with real branches.
//
// THE FAILURE IT CLOSES: two zees built the same migration-number guard, on the ticket about two zees
// taking the same migration number, in the same hour. Neither could see the other; the manager who
// dispatched the second could not either, because the board shows zees deployed THROUGH the work tracker
// and a zee dispatched outside it is invisible on it. git caught it only because both authors happened to
// create the same test FILENAME — one different name and two parallel guards would have landed.
//
// WHAT IS ASSERTED, and the order matters: it must SPEAK when two zees are in one place, be SILENT
// otherwise, never speak about a xell that is gone, and never be able to stop a dispatch. The last one is
// the constraint that outranks the feature — a coordination hint that can block work is worse than the
// problem it reports — so it is tested by breaking the things it depends on (no repo, dead branch, a
// project that does not exist) and checking the answer is fewer warnings rather than a throw.
//
// AND WHAT IS ALREADY DONE (ticket #64). The live scan above reads the FLEET, which only knows who is
// still holding the work: a xell that finished, landed and was reaped is in none of those queries. A
// manager read a lagging status row, believed the reviewer on the item was inert, and cut a fresh
// worker for seven findings that were already on main — one whole xell to re-prove finished work. So
// the same block also reports the LAND LEDGER, keyed three ways: this work item (through the ledger's
// own `assigned` events, which survive the unassign that clears `work_item.xell_id`), its ticket, and
// the files a recent landing actually changed. Asserted here: that it speaks for a RETIRED xell, that
// an ASK is never counted as a landing, that the path scan stays windowed and capped, and the exact
// one-line wording a manager reads.
//
// Real git repos and real xell rows, because the whole point is what a BRANCH has actually changed. The
// cost of that is measured here too, since the check sits in the dispatch path.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const git = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
};

const PORT = 47983;
const API = `http://127.0.0.1:${PORT}`;
let server = null;

const { q, one, pool } = await import('../server/src/db/pool.js');
const { pathsIn, ticketRefsIn, changedFiles, overlapForBrief, overlapNote } =
  await import('../server/src/lib/work-overlap.js');

// ── the two pure readers ─────────────────────────────────────────────────────
console.log('\n── what a brief NAMES ──');
ok(pathsIn('touch server/src/db/migrate.js and web/src/hive/HiveCanvas.jsx please').sort().join(',')
   === 'server/src/db/migrate.js,web/src/hive/HiveCanvas.jsx',
   'paths are read out of prose');
ok(pathsIn('the honeycomb is a canvas and the manager is a persona').length === 0,
   'and prose that names no file produces none — a false warning teaches a manager to ignore the true one');
ok(pathsIn('see `server/src/db/migrate.js`, then test/land-queue.test.mjs.').sort().join(',')
   === 'server/src/db/migrate.js,test/land-queue.test.mjs',
   'trailing punctuation and backticks do not become part of a path');
ok(pathsIn('node_modules/pg/index.js and /etc/passwd').length === 0,
   'and only this repo\'s own top-level directories count');

console.log('\n── which TICKET it is about ──');
ok(ticketRefsIn('TKT-24-BC1A: highlight a manager\'s crew').join() === '24', 'TKT-24-BC1A → 24');
ok(ticketRefsIn('TICKET #9, the half that needs no human decision').join() === '9', '"TICKET #9" → 9');
ok(ticketRefsIn('ticket 11 and TKT-33').join() === '11,33', 'both forms, deduped and sorted');
ok(ticketRefsIn('see #9 above, line #33').length === 0,
   'a BARE #9 is NOT a ticket reference — it is a PR, a line number and a heading as often as a ticket');
ok(ticketRefsIn(null).length === 0 && pathsIn(undefined).length === 0, 'and both tolerate nothing at all');

// ── a real project, three real branches ──────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'overlap-'));
const src = join(tmp, 'src');
git(tmp, ['init', '-q', '-b', 'main', 'src']);
git(src, ['config', 'user.email', 't@t']); git(src, ['config', 'user.name', 't']);
mkdirSync(join(src, 'server', 'src', 'db'), { recursive: true });
mkdirSync(join(src, 'web', 'src'), { recursive: true });
writeFileSync(join(src, 'server', 'src', 'db', 'migrate.js'), 'base\n');
writeFileSync(join(src, 'web', 'src', 'App.jsx'), 'base\n');
git(src, ['add', '-A']); git(src, ['commit', '-qm', 'base']);
const base = git(src, ['rev-parse', 'HEAD']);
// alpha CHANGED the migration runner; bravo changed the console; chuck changed nothing yet.
const branchWith = (name, file, text) => {
  git(src, ['checkout', '-q', '-b', `spinoff/${name}`, base]);
  writeFileSync(join(src, file), text);
  git(src, ['add', '-A']); git(src, ['commit', '-qm', `${name} work`]);
  git(src, ['checkout', '-q', 'main']);
};
branchWith('ov-alpha', 'server/src/db/migrate.js', 'alpha touched this\n');
branchWith('ov-bravo', 'web/src/App.jsx', 'bravo touched this\n');
git(src, ['branch', 'spinoff/ov-chuck', base]);       // briefed, nothing written yet
git(src, ['branch', 'spinoff/ov-ghost', base]);
git(src, ['branch', 'spinoff/ov-asking', base]);

await q(`DELETE FROM project WHERE name='overlaptest'`);
const project = await one(
  `INSERT INTO project (name, repo_root, main_branch) VALUES ('overlaptest',$1,'main') RETURNING *`, [src]);
const xource = await one(
  `INSERT INTO xource (project_id, ref) VALUES ($1,'main') RETURNING *`, [project.id]);
// distinct worktree_paths because the column is UNIQUE — and this check never reads them: it asks the
// XOURCE about each xell's BRANCH, which is where the work actually is (a worktree can be mid-teardown,
// on a machine that is gone, or not yet cut).
const mkXell = (slug, status = 'working') => one(
  `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, head_commit)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
  [project.id, xource.id, slug, `spinoff/${slug}`, join(tmp, `wt-${slug}`), status, base]);
const brief = (xellId, text) => one(
  `INSERT INTO task (xell_id, project_id, prompt_text, status) VALUES ($1,$2,$3,'working') RETURNING id`,
  [xellId, project.id, text]);

try {
  const alpha = await mkXell('ov-alpha');
  const bravo = await mkXell('ov-bravo');
  const chuck = await mkXell('ov-chuck');
  const ghost = await mkXell('ov-ghost', 'retired');
  await brief(alpha.id, 'TICKET #9 — make server/src/db/migrate.js refuse a duplicate number.');
  await brief(bravo.id, 'Ticket 24: the crew highlight in web/src/App.jsx.');
  await brief(chuck.id, 'TKT-33-AAAA — warn at dispatch. Touch server/src/lib/work-overlap.js.');
  await brief(ghost.id, 'TICKET #9 — the same guard, but this xell is RETIRED.');

  console.log('\n── the branch reader, on real branches ──');
  ok((changedFiles(src, 'main', 'spinoff/ov-alpha') || []).join() === 'server/src/db/migrate.js',
     'it reads the files a branch actually changed');
  ok((changedFiles(src, 'main', 'spinoff/ov-chuck') || []).length === 0,
     'a branch that has changed nothing yet reports nothing (it is still IN the work — the brief covers that)');
  ok(changedFiles(src, 'main', 'spinoff/nope') === null && changedFiles('/nonexistent', 'main', 'x') === null,
     'and a branch or repo it cannot read answers null rather than throwing — a hole, reported as one');

  console.log('\n── it SPEAKS when two zees are in one place ──');
  const byPath = await overlapForBrief({ projectId: project.id,
    brief: 'Harden server/src/db/migrate.js — refuse two files sharing a number.' });
  ok(byPath.warnings.some((w) => w.kind === 'path' && w.xell_slug === 'ov-alpha'),
     'a path another live xell has CHANGED is named, with the xell');
  ok(byPath.warnings.find((w) => w.xell_slug === 'ov-alpha').via === 'changed on its branch',
     'and it says the overlap is a fact about the branch, not a guess from prose');
  const byTicket = await overlapForBrief({ projectId: project.id,
    brief: 'TKT-9-ZZZZ: pick this up from a completely different module.' });
  ok(byTicket.warnings.some((w) => w.kind === 'ticket' && w.xell_slug === 'ov-alpha' && w.tickets.join() === '9'),
     'and a shared TICKET is caught even when no path is named — the case paths miss');
  ok(byTicket.warnings.find((w) => w.xell_slug === 'ov-alpha').via === 'its brief',
     'via its BRIEF, which is how a dispatch made outside the work tracker is seen at all');
  const both = await overlapForBrief({ projectId: project.id,
    brief: 'TICKET #9 in server/src/db/migrate.js' });
  ok(both.warnings.filter((w) => w.xell_slug === 'ov-alpha').length === 2,
     'both keys fire independently, so one xell can be flagged twice for two reasons');
  const note = overlapNote(both);
  ok(/ov-alpha/.test(note) && /ticket 9/.test(note) && /server\/src\/db\/migrate\.js/.test(note),
     'the note names the xell, the ticket and the path');
  ok(/INFORMATION, not a refusal/.test(note) && /carry on knowingly/.test(note),
     'and says plainly that it is advisory, with the three things a manager can do about it');
  const briefOnly = await overlapForBrief({ projectId: project.id,
    brief: 'Work in server/src/lib/work-overlap.js on the dispatch warning.' });
  ok(briefOnly.warnings.some((w) => w.xell_slug === 'ov-chuck' && w.via === 'named in its brief'),
     'a xell that has written NOTHING yet is still in the work — its brief is read too');

  console.log('\n── it is SILENT otherwise ──');
  const clean = await overlapForBrief({ projectId: project.id,
    brief: 'Rewrite docs/deploy-topology-spec.md and touch nothing else.' });
  ok(clean.warnings.length === 0, 'a dispatch nobody else is near says nothing at all');
  const vague = await overlapForBrief({ projectId: project.id,
    brief: 'Make the honeycomb prettier and the wires nicer.' });
  ok(vague.warnings.length === 0 && vague.checked.paths.length === 0,
     'and a brief that names no path and no ticket is not guessed at');
  const self = await overlapForBrief({ projectId: project.id,
    brief: 'TICKET #9 — server/src/db/migrate.js', excludeXellId: alpha.id });
  ok(!self.warnings.some((w) => w.xell_slug === 'ov-alpha'),
     'and a caller can exclude itself, so a manager re-briefing its own worker is not warned about it');

  console.log('\n── a RETIRED xell is never in the work ──');
  const all = await overlapForBrief({ projectId: project.id, brief: 'TICKET #9 — server/src/db/migrate.js' });
  ok(!all.warnings.some((w) => w.xell_slug === 'ov-ghost'),
     'the retired xell shares the ticket AND the branch, and raises nothing');
  await q(`UPDATE xell SET status='husk' WHERE id=$1`, [ghost.id]);
  ok(!(await overlapForBrief({ projectId: project.id, brief: 'TICKET #9' })).warnings
       .some((w) => w.xell_slug === 'ov-ghost'), 'nor does a husk');
  await q(`UPDATE xell SET status='working' WHERE id=$1`, [ghost.id]);
  ok((await overlapForBrief({ projectId: project.id, brief: 'TICKET #9' })).warnings
       .some((w) => w.xell_slug === 'ov-ghost'), '…and the SAME xell alive again does raise one');
  await q(`UPDATE xell SET status='retired' WHERE id=$1`, [ghost.id]);

  console.log('\n── it cannot block, fail, or slow a dispatch ──');
  const noRepo = await one(
    `INSERT INTO project (name, repo_root, main_branch) VALUES ('overlaptest-norepo','/nonexistent','main')
     RETURNING *`);
  const r1 = await overlapForBrief({ projectId: noRepo.id, brief: 'server/src/db/migrate.js' });
  ok(Array.isArray(r1.warnings), 'a project whose repo is gone answers an object, not an exception');
  const r2 = await overlapForBrief({ projectId: '00000000-0000-4000-8000-000000000000',
    brief: 'server/src/db/migrate.js' });
  ok(r2.warnings.length === 0, 'a project that does not exist answers no warnings');
  const r3 = await overlapForBrief({});
  ok(r3.warnings.length === 0, 'and no project at all is not an error either');
  ok(overlapNote({ warnings: [] }) === null && overlapNote(null) === null,
     'no warnings → no note, so a clean dispatch reads exactly as it always has');
  const degraded = await overlapForBrief({ projectId: project.id,
    brief: 'server/src/db/migrate.js', gitTimeoutMs: 1, budgetMs: 0 });
  ok(Array.isArray(degraded.degraded),
     'and a check that runs out of time REPORTS the shortfall rather than pretending to be complete');
  ok(overlapNote({ warnings: [{ kind: 'path', xell_slug: 'x', paths: ['a/b'], via: 'x' }],
                   degraded: ['could not read y'] }).includes('may be short, never long'),
     'the note says which direction a partial answer errs in — short, never long');

  // ── WHAT HAS ALREADY LANDED ON THIS WORK (#64) ─────────────────────────────
  // The half the live scan structurally cannot answer: a xell that finished, landed and was reaped is
  // in none of the queries above. A manager read a lagging status row, believed the reviewer on the
  // item was inert, and cut a fresh worker for seven findings that were already on main. So: a REAL
  // ticket, a REAL work item, a REAL retired xell, and a REAL landed row in the ledger.
  console.log('\n── what has already LANDED on this work ──');
  // main moves on, exactly as a landing moves it — and the landing touches a file a later brief names.
  mkdirSync(join(src, 'server', 'src', 'lib'), { recursive: true });
  writeFileSync(join(src, 'server', 'src', 'lib', 'work-overlap.js'), 'the seven findings, fixed\n');
  git(src, ['add', '-A']); git(src, ['commit', '-qm', 'fix the seven review findings']);
  const landedSha = git(src, ['rev-parse', 'HEAD']);

  const ticket = await one(
    `INSERT INTO ticket (project_id, title, kind) VALUES ($1,'the seven review findings','bug') RETURNING *`,
    [project.id]);
  const item = await one(
    `INSERT INTO work_item (project_id, kind, title, status, ticket_id)
       VALUES ($1,'task','fix the seven review findings','done',$2) RETURNING *`,
    [project.id, ticket.id]);
  // THE REVIEWER: it did the work, it landed, it was reaped — and it was UNASSIGNED off the card on
  // the way out, so `work_item.xell_id` is null and the `assigned` ledger entry is the only surviving
  // link. That is the durable one, and it is the one this check has to read.
  const reviewer = await mkXell('ov-reviewer', 'retired');
  await brief(reviewer.id, `TKT-${ticket.number} — fix the seven findings from the review.`);
  await q(`INSERT INTO work_item_event (work_item_id, kind, actor, detail)
             VALUES ($1,'assigned','manager', jsonb_build_object('xell_id',$2::text,'xell_slug','ov-reviewer'))`,
          [item.id, reviewer.id]);
  const landed = (xellId, sha, minutesAgo, subject) => q(
    `INSERT INTO land_request (project_id, xell_id, ref, old_sha, new_sha, status, commits,
                               decided_at, decided_by, landed_at)
       VALUES ($1,$2,'refs/heads/main',$3,$4,'landed',$5,
               now() - ($6 * INTERVAL '1 minute'), 'human@console', now() - ($6 * INTERVAL '1 minute'))`,
    [project.id, xellId, base, sha, JSON.stringify([{ short: sha.slice(0, 8), subject, author: 'zee' }]), minutesAgo]);
  await landed(reviewer.id, landedSha, 41, 'fix the seven review findings');

  const onItem = await overlapForBrief({ projectId: project.id, brief: '', workItemId: item.id });
  const w = onItem.warnings.find((x) => x.kind === 'landed');
  ok(!!w && w.sha === landedSha,
     'a landing by the zee that was on THIS work item is reported, keyed on the item alone');
  ok(!!w && w.via === 'work item' && /THIS work item/.test(w.detail),
     'and it says WHY it is being shown — the tracker links it to this very card');
  ok(!!w && w.xell_slug === 'ov-reviewer',
     'named with the xell that produced it, though that xell is RETIRED — the case the live scan cannot see');
  ok(!!w && /min ago/.test(w.ago) && w.subject === 'fix the seven review findings',
     `and WHEN, in words a manager can act on (${w?.ago}) plus the commit subject`);
  ok(onItem.warnings.every((x) => x.kind !== 'ticket' && x.kind !== 'path'),
     'a brief that names nothing still checks the item — the early return does not swallow it');

  const byTicketNo = await overlapForBrief({ projectId: project.id,
    brief: `TKT-${ticket.number}-ZZZZ: a second pass over the review findings.` });
  ok(byTicketNo.warnings.some((x) => x.kind === 'landed' && x.sha === landedSha && x.via === 'ticket'),
     'the TICKET alone finds it too — a re-cut that names the ticket and no item');

  // THE DISPATCH THAT NEVER WENT THROUGH THE TRACKER: on no card at all, its brief is the only link.
  const stray = await mkXell('ov-stray', 'retired');
  await brief(stray.id, `TKT-${ticket.number} — the same findings, dispatched outside the board.`);
  writeFileSync(join(src, 'web', 'src', 'App.jsx'), 'stray landing\n');
  git(src, ['add', '-A']); git(src, ['commit', '-qm', 'stray landing']);
  const straySha = git(src, ['rev-parse', 'HEAD']);
  await landed(stray.id, straySha, 90, 'stray landing');
  const byBrief = await overlapForBrief({ projectId: project.id, brief: `ticket ${ticket.number}: another look` });
  ok(byBrief.warnings.some((x) => x.kind === 'landed' && x.sha === straySha && x.via === 'its brief'),
     'a landing from a xell on NO card is found through its own brief — the gap the board cannot close');

  const landedPath = await overlapForBrief({ projectId: project.id,
    brief: 'Extend server/src/lib/work-overlap.js with the landed half.' });
  const wp = landedPath.warnings.find((x) => x.kind === 'landed-path');
  ok(!!wp && wp.sha === landedSha && wp.paths.includes('server/src/lib/work-overlap.js'),
     'a landing that CHANGED a file this brief names is reported, with the file');
  ok(!!wp && wp.xell_slug === 'ov-reviewer' && /ago/.test(wp.ago),
     'with the xell it came from and when — the same one line');

  console.log('\n── an ASK is not a landing, and silence is still the normal answer ──');
  const asking = await mkXell('ov-asking');
  await brief(asking.id, `TKT-${ticket.number} — asked to land, not landed.`);
  await q(`INSERT INTO land_request (project_id, xell_id, ref, old_sha, new_sha, status)
             VALUES ($1,$2,'refs/heads/main',$3,$4,'pending')`, [project.id, asking.id, base, landedSha]);
  const asks = await overlapForBrief({ projectId: project.id, brief: `TKT-${ticket.number}` });
  ok(!asks.warnings.some((x) => x.kind === 'landed' && x.xell_slug === 'ov-asking'),
     'a PENDING land request is an ask a human has not answered — it is never reported as landed');
  const quiet = await overlapForBrief({ projectId: project.id,
    brief: 'Rewrite docs/deploy-topology-spec.md and touch nothing else.' });
  ok(!quiet.warnings.some((x) => x.kind === 'landed' || x.kind === 'landed-path'),
     'and work nothing has landed on says nothing at all');
  const stale = await overlapForBrief({ projectId: project.id,
    brief: 'Extend server/src/lib/work-overlap.js.', landedWindowDays: 0 });
  ok(!stale.warnings.some((x) => x.kind === 'landed-path'),
     'the path scan is WINDOWED — there is no unbounded walk back through the ledger');
  // …and CAPPED. Seven more landings on the same ticket, then put the fixture back: a manager making a
  // decision wants a handful, newest first, not a changelog.
  for (let i = 0; i < 7; i++) await landed(reviewer.id, `f${i}`.padEnd(40, '0'), i + 1, `noise ${i}`);
  const many = await overlapForBrief({ projectId: project.id, brief: '', workItemId: item.id });
  const capped = many.warnings.filter((x) => x.kind === 'landed');
  ok(capped.length === 5, `the block names at most a handful (${capped.length} of 8)`);
  ok(capped[0].sha === 'f0'.padEnd(40, '0') && capped[4].sha === 'f4'.padEnd(40, '0'),
     'and they are the MOST RECENT ones, newest first');
  await q(`DELETE FROM land_request WHERE project_id=$1 AND new_sha LIKE 'f_0%'`, [project.id]);

  console.log('\n── the line a manager actually reads ──');
  const landedNote = overlapNote(await overlapForBrief({ projectId: project.id,
    brief: `TKT-${ticket.number} — another pass over server/src/lib/work-overlap.js`, workItemId: item.id }));
  console.log(landedNote.split('\n').map((l) => `      ${l}`).join('\n'));
  ok(/landing\(s\) on main are already in this work/.test(landedNote)
     && /INFORMATION, not a refusal/.test(landedNote),
     'the note says landings are already in this work, and that it is not a refusal');
  ok(new RegExp(`${landedSha.slice(0, 8)} landed \\d+ min ago from ov-reviewer, linked to`).test(landedNote),
     'in one actionable line: <sha> landed <when> from <xell>, <why>');
  ok(/git show <sha>/.test(landedNote) && /revert, a second pass, a review/.test(landedNote),
     'and it names what to do about it — read the sha, then decide, including deliberately re-cutting it');

  console.log('\n── what it costs, measured ──');
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) {
    await overlapForBrief({ projectId: project.id, brief: 'TICKET #9 — server/src/db/migrate.js and web/src/App.jsx' });
  }
  const per = (Date.now() - t0) / 5;
  ok(per < 400, `${per.toFixed(0)}ms per check across 4 live xells (one git diff each) — dispatch spawns a container, so this is noise`);

  console.log('\n── wired where a decision is made, and nowhere a worker can reach ──');
  const { readFileSync } = await import('node:fs');
  const selfSrc = readFileSync('server/src/queenzee/self.js', 'utf8');
  const disp = selfSrc.slice(selfSrc.indexOf('export async function selfDispatch'),
                             selfSrc.indexOf('export async function selfSay'));
  ok(/overlapForBrief\(\{ projectId: xell\.project_id, brief: text, excludeXellId: xell\.id,\s*workItemId: work_item_id \|\| null \}\)/.test(disp),
     'the MANAGER\'s dispatch verb reads it, and passes the ITEM when it is a deploy onto a card (#64)');
  ok(disp.indexOf('overlapForBrief') < disp.indexOf('dispatchXell({'),
     'BEFORE the dispatch, so the answer describes the fleet as it was when the decision was made');
  ok(!/if \(overlap[\s\S]{0,40}return/.test(disp) && /ok: true, \.\.\.out, overlap/.test(disp),
     'and nothing branches on it — it rides along in the answer, it does not gate the verb');
  const workerVerbs = ['selfStatus', 'selfWork', 'selfLand', 'selfShip', 'selfReport', 'selfInbox'];
  for (const v of workerVerbs) {
    const i = selfSrc.indexOf(`export async function ${v}(`);
    const body = i < 0 ? '' : selfSrc.slice(i, selfSrc.indexOf('\nexport ', i + 10));
    ok(!/overlapForBrief/.test(body), `${v} does not call it — a worker's reach does not widen for a convenience`);
  }
  const routes = readFileSync('server/src/api/routes.js', 'utf8');
  ok(/router\.post\('\/xell\/dispatch\/overlap'/.test(routes),
     'a PREFLIGHT route exists for the human surface — the answer before the button, not in the receipt');
  const dlg = readFileSync('web/src/Dispatch.jsx', 'utf8');
  ok(/dispatchOverlap\(\{ project: projectId, task \}\)/.test(dlg) && /setTimeout\(/.test(dlg),
     'and the console dispatch dialog actually CALLS it, debounced (a route nobody calls is dead code)');
  ok(/data-testid="dispatch-overlap"/.test(dlg) && !/disabled=\{[^}]*overlap/.test(dlg),
     'it renders the warning and does NOT disable the dispatch button anywhere');
  ok(/if \(manager\) return;/.test(dlg),
     'and a MANAGER\'s programme is not checked — it names the whole project by design, so it would warn about everything');

  // ── over real HTTP, as a real manager's own token ─────────────────────────
  // The source assertions above prove the wiring; this proves the ANSWER. The manager in the failure
  // this closes did not read a library — it read the JSON that came back from its own `zee dispatch`,
  // and what matters is that the landed warning is IN it, in the words it can act on.
  console.log('\n── over real HTTP, as the manager\'s own token ──');
  const express = (await import('express')).default;
  const http = await import('node:http');
  const { router: apiRouter } = await import('../server/src/api/routes.js');
  const { mintXellToken } = await import('../server/src/lib/xell-token.js');
  const mgr = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, zee_type, head_commit)
       VALUES ($1,$2,'ov-mgr','spinoff/ov-mgr',$3,'working','manager',$4) RETURNING *`,
    [project.id, xource.id, join(tmp, 'wt-ov-mgr'), base]);
  // A manager's free-form `zee dispatch` is the ROUTER's verb (the board is the manager's deployment
  // path); this test exercises the dispatch's overlap read, so the xell wears the router harness.
  await q(`UPDATE xell SET harness_id=(SELECT id FROM harness WHERE key='router') WHERE id=$1`, [mgr.id]);
  // A xell already in the READY pool: the dispatch must reach its overlap read, and a dry pool would
  // send it down the provision path instead — which in a test runner (no docker) fails before it gets
  // there, and would be a green test of nothing.
  git(src, ['worktree', 'add', '-q', '-b', 'spinoff/ov-ready', join(tmp, 'wt-ov-ready'), base]);
  await q(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, ready_at, head_commit)
       VALUES ($1,$2,'ov-ready','spinoff/ov-ready',$3,'ready',true, now(), $4)`,
    [project.id, xource.id, join(tmp, 'wt-ov-ready'), base]);
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  server = http.createServer(app);
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const token = await mintXellToken(mgr.id);

  const answer = await (await fetch(`${API}/api/xell/self/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ task: `TKT-${ticket.number} — fix the seven review findings again.` }),
  })).json();
  const httpLanded = (answer.overlap?.warnings || []).filter((x) => x.kind === 'landed');
  ok(httpLanded.some((x) => x.sha === landedSha),
     `the dispatch answer carries the landing over HTTP (${httpLanded.length} landed warning(s))`);
  ok(httpLanded.every((x) => typeof x.short === 'string' && typeof x.ago === 'string'),
     'with the short sha and the age serialised as strings an agent can print');
  // The SENTENCE, not just the fields: a manager reads the note, and it must be on the answer whether
  // the spawn behind it succeeded or not (this runner has no provider token, so it did not).
  const said = answer.overlap?.note || '';
  ok(/landing\(s\) on main are already in this work/.test(said),
     'and the manager READS it as a sentence on the answer, not only as fields it must know to look at');
  ok(new RegExp(`${landedSha.slice(0, 8)} landed .* from ov-reviewer`).test(said),
     `the exact line: ${said.split('\n').find((l) => l.includes(landedSha.slice(0, 8))) || '(missing)'}`);
  ok(answer.ok === true ? /landing\(s\) on main/.test(answer.message || '') : /landing\(s\) on main/.test(answer.warning || ''),
     `and a dispatch that FAILED to spawn still says it — the overlap is a fact about the work, not about the attempt`);
  // …and the constraint that outranks the feature, asserted where it can actually be broken: this
  // dispatch was NOT refused by the warning. (Whether the spawn itself succeeds is not this check's
  // business — a test runner has no docker — so what is asserted is that nothing about the overlap
  // stopped it, and that the warning survives either outcome.)
  ok(!/overlap|already landed/i.test(answer.error || ''),
     `the warning is never the reason a dispatch does not happen (${answer.ok === true ? 'dispatched' : `dispatch outcome: ${String(answer.error).slice(0, 60)}`})`);

  const preflight = await (await fetch(`${API}/api/xell/dispatch/overlap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: project.id, task: `TKT-${ticket.number} — another pass` }),
  })).json();
  ok((preflight.warnings || []).some((x) => x.kind === 'landed' && x.sha === landedSha)
     && /landing\(s\) on main/.test(preflight.note || ''),
     'and the human PREFLIGHT route answers the same thing before the button is pressed');
} catch (e) {
  console.error('\n✗ threw:', e?.stack || e?.message || e);
  fail++;
} finally {
  await q(`DELETE FROM project WHERE name IN ('overlaptest','overlaptest-norepo')`).catch(() => {});
  try { server?.close(); } catch { /* */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  await pool.end().catch(() => {});
}

console.log(fail ? `\n✗ ${fail} FAILED` : '\n✓ a dispatch into work somebody is already in — or has already LANDED — says so, and can still happen');
process.exit(fail ? 1 : 0);

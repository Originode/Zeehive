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
  ok(/overlapForBrief\(\{ projectId: xell\.project_id, brief: text, excludeXellId: xell\.id \}\)/.test(disp),
     'the MANAGER\'s dispatch verb reads it (requireManager guards that verb, so no worker can)');
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
} catch (e) {
  console.error('\n✗ threw:', e?.stack || e?.message || e);
  fail++;
} finally {
  await q(`DELETE FROM project WHERE name IN ('overlaptest','overlaptest-norepo')`).catch(() => {});
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  await pool.end().catch(() => {});
}

console.log(fail ? `\n✗ ${fail} FAILED` : '\n✓ a dispatch into work somebody is already in says so, and can still happen');
process.exit(fail ? 1 : 0);

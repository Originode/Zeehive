// ON SYNC AND ON LAND, TELL A ZEE WHICH SIBLING LANDINGS TOUCHED THE FILES IT HAS TOUCHED (#77).
//
// The gap this closes: three workers landed changes to nudge.js inside four hours and only their own
// diligence in reading each other's commits kept it coherent. Git had nothing to say — a clean merge
// is the absence of overlapping lines, not agreement. TKT-64 built the read model for the DISPATCH
// side (recent landings touching named paths); this is the other end: the same landed-path machinery,
// keyed on the ZEE'S OWN changed-file set (its branch vs the base), rendered as a NOTE (never a block)
// into the `zee sync` and `zee land` answers.
//
// What is asserted, and the property that outranks the feature: it must SPEAK when a sibling landing
// touched a file this zee changed, be SILENT when nothing did, never speak about the zee's OWN landing,
// and never be able to fail a sync or a land. The last one is tested by breaking the things it depends
// on (no repo, dead branch, a project that does not exist) and checking the answer is fewer warnings
// rather than a throw — the exact property 2f5ec28 verified on the board's deploy path and the brief
// verifies on this one: read the catch, and check that no caller branches on the result.
//
// The pre-change tree is asserted SOURCE-FIRST (the exports and the wiring must exist) so that a tree
// without this feature fails with clean, specific FAIL lines — "the sibling scan is not exported",
// "selfSync does not read it" — rather than a TypeError that looks like a broken test. The behaviour
// half then proves the read itself against real branches and a real landed ledger.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
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
const workOverlap = await import('../server/src/lib/work-overlap.js');
const { changedFiles, overlapForChangedFiles, siblingOverlapNote, siblingOverlapForXell } = workOverlap;

// ── SOURCE-FIRST: the feature exists on this tree ────────────────────────────
// These fail with a specific name on the pre-change tree (a missing export, a missing wire) instead
// of crashing the test with a TypeError — the "red that proves nothing" the brief warns about.
console.log('\n── the feature exists on this tree ──');
const libSrc = readFileSync('server/src/lib/work-overlap.js', 'utf8');
ok(/export async function overlapForChangedFiles/.test(libSrc),
   'work-overlap.js exports the sibling scan (overlapForChangedFiles)');
ok(/export function siblingOverlapNote/.test(libSrc), 'and the note a zee reads (siblingOverlapNote)');
ok(/export async function siblingOverlapForXell/.test(libSrc),
   'and the xell entry point (siblingOverlapForXell)');
ok(/SELECT l\.id, l\.new_sha, l\.old_sha, l\.landed_at, l\.commits/.test(libSrc),
   'recentLandings reads the commits column so a warning can name the sibling\'s subject');
if (typeof overlapForChangedFiles !== 'function' || typeof siblingOverlapNote !== 'function'
    || typeof siblingOverlapForXell !== 'function') {
  ok(false, 'the exports above are missing — skipping the behaviour half on this tree');
} else {
  // ── a real project, a real branch, a real landed sibling ─────────────────
  const tmp = mkdtempSync(join(tmpdir(), 'sibling-overlap-'));
  const src = join(tmp, 'src');
  git(tmp, ['init', '-q', '-b', 'main', 'src']);
  git(src, ['config', 'user.email', 't@t']); git(src, ['config', 'user.name', 't']);
  mkdirSync(join(src, 'server', 'src', 'db'), { recursive: true });
  mkdirSync(join(src, 'server', 'src', 'queenzee'), { recursive: true });
  writeFileSync(join(src, 'server', 'src', 'db', 'migrate.js'), 'base\n');
  writeFileSync(join(src, 'server', 'src', 'queenzee', 'nudge.js'), 'base\n');
  git(src, ['add', '-A']); git(src, ['commit', '-qm', 'base']);
  const base = git(src, ['rev-parse', 'HEAD']);

  // THE SIBLING LANDING — main moves: a landing touches nudge.js (the file our zee will also touch).
  writeFileSync(join(src, 'server', 'src', 'queenzee', 'nudge.js'), 'sibling changed this\n');
  git(src, ['add', '-A']); git(src, ['commit', '-qm', 'sibling: extend the resume path']);
  const siblingSha = git(src, ['rev-parse', 'HEAD']);

  // THE ZEE'S BRANCH — cut from base, changed nudge.js (semantic overlap with the sibling landing).
  git(src, ['checkout', '-q', '-b', 'spinoff/sib-zee', base]);
  writeFileSync(join(src, 'server', 'src', 'queenzee', 'nudge.js'), 'zee changed this\n');
  git(src, ['add', '-A']); git(src, ['commit', '-qm', 'zee: extend the resume path']);
  git(src, ['checkout', '-q', 'main']);

  await q(`DELETE FROM project WHERE name='siblingoverlaptest'`);
  const project = await one(
    `INSERT INTO project (name, repo_root, main_branch) VALUES ('siblingoverlaptest',$1,'main') RETURNING *`, [src]);
  const xource = await one(
    `INSERT INTO xource (project_id, ref) VALUES ($1,'main') RETURNING *`, [project.id]);
  const mkXell = (slug, branch, createdAt = null) => one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, head_commit
       ${createdAt ? ', created_at' : ''})
     VALUES ($1,$2,$3,$4,$5,'working',$6${createdAt ? `, $7` : ''}) RETURNING *`,
    createdAt
      ? [project.id, xource.id, slug, branch, join(tmp, `wt-${slug}`), base, createdAt]
      : [project.id, xource.id, slug, branch, join(tmp, `wt-${slug}`), base]);
  const landed = (xellId, sha, minutesAgo, subject, oldSha = base) => q(
    `INSERT INTO land_request (project_id, xell_id, ref, old_sha, new_sha, status, commits,
                               decided_at, decided_by, landed_at)
       VALUES ($1,$2,'refs/heads/main',$3,$4,'landed',$5,
               now() - ($6 * INTERVAL '1 minute'), 'human@console', now() - ($6 * INTERVAL '1 minute'))`,
    [project.id, xellId, oldSha, sha, JSON.stringify([{ short: sha.slice(0, 8), subject, author: 'zee' }]), minutesAgo]);

  try {
    // The zee (our subject) was cut TWO days ago — so the "since it was cut" window is 2 days.
    const zee = await mkXell('sib-zee', 'spinoff/sib-zee', new Date(Date.now() - 2 * 86400000));
    // A retired xell that produced the sibling landing (the landing's xell can be retired — the ledger
    // is the fact; the live scan is the half that needs liveness).
    const siblingXell = await mkXell('sib-sibling', 'spinoff/sib-sibling', new Date(Date.now() - 10 * 86400000));
    await landed(siblingXell.id, siblingSha, 41, 'sibling: extend the resume path');

    console.log('\n── the branch reader, reused on the zee itself ──');
    ok((changedFiles(src, 'main', 'spinoff/sib-zee') || []).join() === 'server/src/queenzee/nudge.js',
       'it reads the files the zee\'s branch actually changed vs base');
    ok((changedFiles(src, base, siblingSha) || []).join() === 'server/src/queenzee/nudge.js',
       'and the files a landing changed (the same path — the semantic collision this closes)');

    console.log('\n── it SPEAKS when a sibling landing touched a file this zee changed ──');
    const overlap = await overlapForChangedFiles({ projectId: project.id, repoRoot: src,
      base: 'main', branch: 'spinoff/sib-zee', excludeXellId: zee.id, landedWindowDays: 14 });
    const w = overlap.warnings.find((x) => x.kind === 'sibling-landing');
    ok(!!w && w.sha === siblingSha, 'a landing that changed a file the zee changed is reported, with the sha');
    ok(!!w && w.paths.includes('server/src/queenzee/nudge.js'), 'naming the shared file');
    ok(!!w && w.xell_slug === 'sib-sibling' && /ago/.test(w.ago), 'with the xell it came from and when');
    ok(!!w && w.subject === 'sibling: extend the resume path', 'and the commit subject a zee can act on');
    ok(overlap.checked.paths.includes('server/src/queenzee/nudge.js'), 'and the checked paths are the zee\'s own');

    console.log('\n── the NOTE a zee reads, in its own voice ──');
    const note = siblingOverlapNote(overlap);
    console.log(note.split('\n').map((l) => `      ${l}`).join('\n'));
    ok(/landing\(s\) on main touched files YOU have changed/.test(note), 'it speaks to the zee about ITS files');
    ok(/INFORMATION, not a block/.test(note), 'and says plainly that it is a note, never a block');
    ok(/git show <sha>/.test(note) && /extend it rather than fight it/.test(note),
       'and names what to do — read the sibling\'s commit, extend it rather than fight it');
    ok(new RegExp(`${siblingSha.slice(0, 8)} landed .* from sib-sibling — changed server/src/queenzee/nudge\\.js`).test(note),
       'in one actionable line: <sha> landed <when> from <xell> — changed <file>');

    console.log('\n── it is SILENT when no sibling touched the zee\'s files ──');
    git(src, ['checkout', '-q', '-b', 'spinoff/sib-other', base]);
    writeFileSync(join(src, 'server', 'src', 'db', 'migrate.js'), 'other zee changed this\n');
    git(src, ['add', '-A']); git(src, ['commit', '-qm', 'other zee work']);
    git(src, ['checkout', '-q', 'main']);
    const other = await overlapForChangedFiles({ projectId: project.id, repoRoot: src,
      base: 'main', branch: 'spinoff/sib-other', excludeXellId: zee.id, landedWindowDays: 14 });
    ok(other.warnings.length === 0, 'a sibling landing on nudge.js says nothing about a zee that changed migrate.js');
    ok(siblingOverlapNote(other) === null, 'and no warnings → no note, so a clean sync/land reads as it always has');
    git(src, ['branch', 'spinoff/sib-nothing', base]);
    const nothing = await overlapForChangedFiles({ projectId: project.id, repoRoot: src,
      base: 'main', branch: 'spinoff/sib-nothing', excludeXellId: zee.id, landedWindowDays: 14 });
    ok(nothing.warnings.length === 0 && nothing.checked.paths.length === 0,
       'a branch that changed nothing has no file set to warn about');

    console.log('\n── it never warns about the zee\'s OWN landing ──');
    writeFileSync(join(src, 'server', 'src', 'queenzee', 'nudge.js'), 'own landing\n');
    git(src, ['add', '-A']); git(src, ['commit', '-qm', 'zee: own landing on nudge']);
    const ownSha = git(src, ['rev-parse', 'HEAD']);
    await landed(zee.id, ownSha, 20, 'zee: own landing on nudge');
    const self = await overlapForChangedFiles({ projectId: project.id, repoRoot: src,
      base: 'main', branch: 'spinoff/sib-zee', excludeXellId: zee.id, landedWindowDays: 14 });
    ok(!self.warnings.some((x) => x.xell_id === zee.id),
       'the zee\'s own landing is not a sibling — it already knows it landed it');

    console.log('\n── the window is bounded ("since it was cut") ──');
    writeFileSync(join(src, 'server', 'src', 'queenzee', 'nudge.js'), 'old landing\n');
    git(src, ['add', '-A']); git(src, ['commit', '-qm', 'old landing on nudge']);
    const oldSha = git(src, ['rev-parse', 'HEAD']);
    await landed(siblingXell.id, oldSha, 60 * 24 * 5, 'old landing on nudge'); // 5 days ago — outside the window
    const windowed = await overlapForChangedFiles({ projectId: project.id, repoRoot: src,
      base: 'main', branch: 'spinoff/sib-zee', excludeXellId: zee.id, landedWindowDays: 1 });
    ok(!windowed.warnings.some((x) => x.sha === oldSha),
       'a landing before the window is not reported — the ledger walk is bounded');

    console.log('\n── it cannot fail a sync or a land ──');
    const noRepo = await one(
      `INSERT INTO project (name, repo_root, main_branch) VALUES ('siblingoverlap-norepo','/nonexistent','main')
       RETURNING *`);
    const r1 = await overlapForChangedFiles({ projectId: noRepo.id, repoRoot: '/nonexistent',
      base: 'main', branch: 'spinoff/sib-zee', excludeXellId: zee.id });
    ok(Array.isArray(r1.warnings), 'a project whose repo is gone answers an object, not an exception');
    const r2 = await overlapForChangedFiles({ projectId: '00000000-0000-4000-8000-000000000000',
      repoRoot: src, base: 'main', branch: 'spinoff/sib-zee' });
    ok(r2.warnings.length === 0, 'a project that does not exist answers no warnings');
    const r3 = await overlapForChangedFiles({});
    ok(r3.warnings.length === 0, 'and no project at all is not an error either');
    const r4 = await overlapForChangedFiles({ projectId: project.id, repoRoot: src,
      base: 'main', branch: 'spinoff/no-such-branch', excludeXellId: zee.id, landedWindowDays: 14 });
    ok(r4.warnings.length === 0, 'a dead branch contributes nothing — a hole, reported as fewer warnings');
    const viaApi = await siblingOverlapForXell(zee);
    ok(viaApi === null || (viaApi && Array.isArray(viaApi.warnings)),
       'siblingOverlapForXell answers an object or null, never a throw');
    ok((await siblingOverlapForXell(null)) === null, 'and a null xell is null — the caller path can never blow up');
  } catch (e) {
    console.error('\n✗ threw:', e?.stack || e?.message || e);
    fail++;
  } finally {
    await q(`DELETE FROM project WHERE name IN ('siblingoverlaptest','siblingoverlap-norepo')`).catch(() => {});
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  }
}

// ── WIRED into `zee sync` and `zee land`, advisory by construction ──────────
// These read the caller's SOURCE, so on the pre-change tree they are the behavioural red that names
// the missing wire rather than a crash.
console.log('\n── wired into `zee sync` and `zee land`, advisory by construction ──');
const selfSrc = readFileSync('server/src/queenzee/self.js', 'utf8');
const land = selfSrc.slice(selfSrc.indexOf('export async function selfLand('),
                           selfSrc.indexOf('// ── POST /api/xell/self/land/withdraw'));
ok(/const \{ siblingOverlapForXell \} = await import\('\.\.\/lib\/work-overlap\.js'\)/.test(land)
   && /const sibling = await siblingOverlapForXell\(xell\)/.test(land),
   'selfLand reads it, best-effort, from the xell');
ok(/const withNote = \(msg\) => \(sibling\?\.note \? `\$\{msg\}\\n\\n\$\{sibling\.note\}` : msg\)/.test(land),
   'and has a single withNote() — the note can only ever APPEND a line to a message');
ok(!/if \(\s*sibling/.test(land), 'and nothing branches on the result to change the land\'s decision');
ok(/message: withNote\(`LANDED on/.test(land) && /message: withNote\(`HOLDING at/.test(land)
   && /message: withNote\(`Landing REQUESTED/.test(land),
   'the note rides in the LANDED, HOLDING and HELD messages — the outcomes a landing actually reports');
const sync = selfSrc.slice(selfSrc.indexOf('export async function selfSync('),
                           selfSrc.indexOf('// ── POST /api/xell/self/catchup'));
ok(/const \{ siblingOverlapForXell \} = await import\('\.\.\/lib\/work-overlap\.js'\)/.test(sync)
   && /const sibling = await siblingOverlapForXell\(xell\)/.test(sync),
   'selfSync reads it too, before the merge (so the conflict case names the siblings to read)');
ok(/if \(!heal\.ok\) return \{ \.\.\.heal, message: heal\.message \? withNote\(heal\.message\) : heal\.message/.test(sync),
   'and even a CONFLICT return carries the note — the case where it is the most useful');
ok(/message: withNote\(note\)/.test(sync), 'and the clean-sync message carries it too');
ok(!/if \(\s*sibling/.test(sync), 'and nothing branches on the result to change the sync\'s decision');

await pool.end().catch(() => {});
console.log(fail ? `\n✗ ${fail} FAILED` : '\n✓ a sync/land tells the zee which sibling landings touched its files — and is never allowed to block');
process.exit(fail ? 1 : 0);

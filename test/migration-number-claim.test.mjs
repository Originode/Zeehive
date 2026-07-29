// `zee migration-number` — the half of ticket #9 that stops the collision happening.
//
// The lint next door (test/migration-numbers.test.mjs) refuses a duplicate that has already been
// written. This is the verb that means a zee never writes one: a cxell zee reads db/migrations/ in its
// OWN worktree, which knows what is LANDED and what IT wrote and nothing about the siblings writing
// migrations on branches it cannot see — six numbers were claimed twice or more exactly that way (038,
// 066, 079, 082, 085, and 086 by three xells in one evening). Only the queenzee can see main AND
// every live xell's worktree, so it hands the number out and RECORDS the claim — which is what makes
// two asks seconds apart answer differently.
//
// Exercised for real, against DATABASE_URL: a temp git repo standing in for the xource (with two
// files already claiming 085, because that is the history), two real git worktrees, one of them
// holding an UNLANDED 086 that git has never seen, and throwaway project/xource/xell rows — deleted
// in the finally, whatever happens (house rule 1). No docker, no network, no prod.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { q, one, pool } from '../server/src/db/pool.js';
import { claimMigrationNumber, liveClaims, numberOf, formatNumber, suggestFilename,
         worktreeMigrationFiles, landedMigrationFiles } from '../server/src/lib/migration-numbers.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const PROJECT = 'migrationnumbertest';
const tmp = mkdtempSync(join(tmpdir(), 'mig-number-'));
let project = null;

try {
  // ── the xource: db/migrations already carrying a DUPLICATE 085 (the real history) ────────────
  const src = join(tmp, 'src');
  mkdirSync(join(src, 'db', 'migrations'), { recursive: true });
  git(tmp, ['init', '-q', '-b', 'main', 'src']);
  git(src, ['config', 'user.email', 'test@zeehive.local']);
  git(src, ['config', 'user.name', 'test']);
  for (const f of ['001_init.sql', '084_x.sql', '085_a.sql', '085_b.sql']) {
    writeFileSync(join(src, 'db', 'migrations', f), '-- fixture\nSELECT 1;\n');
  }
  git(src, ['add', '.']); git(src, ['commit', '-qm', 'landed ledger']);
  const shaMain = git(src, ['rev-parse', 'HEAD']);

  const wtA = join(tmp, 'wt-alpha');
  const wtB = join(tmp, 'wt-bravo');
  git(src, ['worktree', 'add', '-q', '-b', 'spinoff/alpha', wtA, shaMain]);
  git(src, ['worktree', 'add', '-q', '-b', 'spinoff/bravo', wtB, shaMain]);
  // bravo has WRITTEN 086 and not landed it — not committed either, which is the worst case: git
  // cannot see it from anywhere, and only reading the worktree finds it.
  writeFileSync(join(wtB, 'db', 'migrations', '086_bravo_unlanded.sql'), '-- fixture\nSELECT 1;\n');

  console.log('\n── the readers ──');
  ok(numberOf('086_bravo_unlanded.sql') === 86 && numberOf('db/migrations/003_x.sql') === 3,
     'a number is read off the filename, path or not');
  ok(numberOf('README.md') === null && numberOf('seed.sql') === null, 'and an unnumbered file has none');
  ok(formatNumber(87) === '087' && formatNumber(1) === '001', 'numbers are padded to three digits');
  ok(suggestFilename(87, 'add claims table') === 'db/migrations/087_add_claims_table.sql',
     'a name becomes a legal NNN_snake_case.sql path');
  ok(suggestFilename(87, '087_Add Claims-Table.sql') === 'db/migrations/087_add_claims_table.sql',
     'and a pasted filename is normalised rather than doubled up');
  ok(suggestFilename(87, null) === null, 'no name → no filename invented');
  ok(landedMigrationFiles(src, shaMain).length === 4, 'the landed list comes out of the commit (4 files)');
  ok((worktreeMigrationFiles(wtB) || []).includes('086_bravo_unlanded.sql'),
     "a worktree's own unlanded migration is visible (the sibling a zee cannot see)");
  ok(worktreeMigrationFiles(join(tmp, 'no-such-worktree')) === null,
     'an unreadable worktree is null, not a throw — it must never refuse a number');

  // ── throwaway rows: one project, two LIVE xells ───────────────────────────────────────────────
  await q(`DELETE FROM project WHERE name=$1`, [PROJECT]);
  project = await one(
    `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'main') RETURNING *`, [PROJECT, src]);
  const xource = await one(
    `INSERT INTO xource (project_id, ref) VALUES ($1,'main') RETURNING *`, [project.id]);
  const mkXell = (slug, branch, wt) => one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, head_commit, status)
     VALUES ($1,$2,$3,$4,$5,$6,'working') RETURNING *`,
    [project.id, xource.id, slug, branch, wt, shaMain]);
  const alpha = await mkXell('mignum-alpha', 'spinoff/alpha', wtA);
  const bravo = await mkXell('mignum-bravo', 'spinoff/bravo', wtB);

  console.log('\n── the first ask: past the landed max, and past the sibling nobody can see ──');
  const a1 = await claimMigrationNumber(project, alpha, { name: 'add claims table' });
  ok(a1.landed.max === 85 && a1.landed.count === 4,
     `it read the landed ledger: 4 files, max 085 (got ${a1.landed.count}, ${formatNumber(a1.landed.max)})`);
  ok(a1.number === 87,
     `alpha is handed 087 — 086 is bravo's unlanded file, which alpha's own worktree cannot show it (got ${a1.prefix})`);
  ok(a1.filename === 'db/migrations/087_add_claims_table.sql', `with a filename to create: ${a1.filename}`);
  ok(a1.worktrees.some((w) => w.xell_slug === 'mignum-bravo' && w.max === 86),
     'and it says WHERE that came from — bravo\'s worktree, holding 086');

  console.log('\n── two zees asking within the same second get DIFFERENT numbers ──');
  const b1 = await claimMigrationNumber(project, bravo, { name: 'bravo second' });
  ok(b1.number === 88, `bravo is handed 088, not 087 — alpha's claim is recorded (got ${b1.prefix})`);
  ok(b1.claims.some((c) => c.number === 87 && c.xell_slug === 'mignum-alpha'),
     'and bravo is told who holds 087, so a human reading the answer can see the queue');

  // The real race: both asks in flight at once. Without the per-project advisory lock both read the
  // same max and both get the same number, which is the bug in one function call.
  const [r1, r2, r3] = await Promise.all([
    claimMigrationNumber(project, alpha, { again: true }),
    claimMigrationNumber(project, bravo, { again: true }),
    claimMigrationNumber(project, alpha, { again: true }),
  ]);
  const raced = [r1.number, r2.number, r3.number];
  ok(new Set(raced).size === 3, `three CONCURRENT asks got three different numbers: ${raced.join(', ')}`);
  ok(Math.min(...raced) === 89 && Math.max(...raced) === 91, `consecutive from 089: ${raced.sort().join(', ')}`);

  console.log('\n── asking twice is not a second number (the re-run case) ──');
  const again = await claimMigrationNumber(project, alpha, { name: 'add claims table' });
  ok(again.reused === true, 'a repeat ask is answered from the claim alpha already holds');
  ok(again.number === Math.max(r1.number, r3.number),
     `and it is alpha's OWN latest number (${again.prefix}), not the next one — being told 092 after writing 091 is the collision`);
  const fresh = await claimMigrationNumber(project, alpha, { again: true });
  ok(fresh.number === 92 && fresh.reused === false,
     `--again is the way through for a second migration in one landing (${fresh.prefix})`);

  console.log('\n── a claim stops counting when the xell is retired ──');
  await q(`UPDATE xell SET status='retired', retired_at=now() WHERE id=$1`, [bravo.id]);
  const afterRetire = await liveClaims(project.id);
  ok(!afterRetire.some((c) => c.xell_slug === 'mignum-bravo'),
     `bravo's claims no longer count (${afterRetire.length} live claim(s) left, all alpha's)`);
  // Alpha's own claims still stand, so the next number is still past them — a retirement frees the
  // number, it does not renumber anybody.
  const afterA = await claimMigrationNumber(project, alpha, { again: true });
  ok(afterA.number === 93, `and alpha keeps counting up from its own highest claim (${afterA.prefix})`);
  ok(!afterA.worktrees.some((w) => w.xell_slug === 'mignum-bravo'),
     "a retired xell's worktree is not scanned either (it is being torn down)");

  console.log('\n── an EXPIRED claim releases its number ──');
  await q(`UPDATE migration_number_claim SET expires_at = now() - interval '1 day' WHERE project_id=$1`,
          [project.id]);
  ok((await liveClaims(project.id)).length === 0, 'every claim has lapsed');
  const lapsed = await claimMigrationNumber(project, alpha, {});
  ok(lapsed.number === 86,
     `the numbers go back into circulation — 086, straight after the landed max (085), because bravo is`
     + ` retired so its unlanded 086 no longer counts either (got ${lapsed.prefix})`);
  ok(lapsed.reused === false, 'and a lapsed claim is not "the claim you already hold"');

  console.log('\n── an unreadable sibling worktree is reported, never fatal ──');
  await q(`UPDATE xell SET status='working' WHERE id=$1`, [bravo.id]);
  await q(`UPDATE xell SET worktree_path=$2 WHERE id=$1`, [bravo.id, join(tmp, 'gone')]);
  const tolerant = await claimMigrationNumber(project, alpha, { again: true });
  ok(tolerant.number >= 87, `a number is still handed out (${tolerant.prefix})`);
  ok(tolerant.worktrees.some((w) => w.xell_slug === 'mignum-bravo' && w.readable === false),
     'and the hole in the answer is named rather than hidden');
} finally {
  if (project) await q(`DELETE FROM project WHERE id=$1`, [project.id]);   // cascades claims + xells
  await q(`DELETE FROM project WHERE name=$1`, [PROJECT]);
  rmSync(tmp, { recursive: true, force: true });
  await pool.end().catch(() => {});
}

console.log(`\n${fail === 0 ? 'ALL PASSED ✓' : `${fail} FAILURE(S) ✗`}`);
process.exit(fail === 0 ? 0 : 1);

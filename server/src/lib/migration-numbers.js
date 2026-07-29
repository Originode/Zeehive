// WHICH MIGRATION NUMBER IS FREE? — the half of ticket #9 a caged zee cannot answer for itself.
//
// db/migrations/ IS the ledger (CLAUDE.md §4) and its only ordering is the FILENAME, so the number
// in front of a migration is its apply order. A cxell zee picks that number by reading the folder in
// its OWN worktree, which contains what is landed plus what IT has written — and nothing about the
// four siblings writing migrations at the same hour on branches it cannot see. So two files claim one
// number, git shows no conflict (they never touch each other), and postgres applies them in whatever
// order a string sort gives two names that were meant to be identical. Five times: 038, 066, 079,
// 082, 085.
//
// The queenzee is the only party that CAN see all of it, so this is where the answer belongs. Three
// sources, unioned:
//   1. LANDED — db/migrations at the project's main (ship_ref, else main_branch), read out of git the
//      way seedgate reads a seed file: from the commit, never from a working tree.
//   2. EVERY LIVE XELL'S WORKTREE — the numbers siblings have already written but not landed. This is
//      the source a zee can't reach and the one that actually collided, and it works whether or not
//      the sibling ever asked for a number.
//   3. CLAIMS — recorded here, so two zees asking within the same second get different answers even
//      though neither has written a file yet.
//
// ADVISORY, NOT A GATE. It hands out a number; it does not police a landing (the lint in
// test/migration-numbers.test.mjs does that, and it is what fails the build if a duplicate lands
// anyway). A zee that never asks is not blocked, and a claim that is never used costs nothing but a
// hole in the numbering — which the ledger does not care about, because it only needs uniqueness and
// rough order.
//
// CLAIMS EXPIRE (CLAIM_TTL_DAYS), and a retired xell's claim stops counting immediately. A claim is a
// courtesy hold, not a reservation: most xells live hours, and a zee that dies mid-task must not push
// every future number up forever. The TTL is deliberately far longer than a xell's life so an
// expiring claim can never race a zee that is still working on the file.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pool, q } from '../db/pool.js';
import { cleanGitEnv, headCommit } from './git.js';
import { logline } from './logbus.js';

// The ONE directory the numbers live in — hardcoded like seedgate's SEED_DIR, and for the same
// reason: it is a property of the repo's layout, not a per-call argument to be got wrong.
export const MIGRATIONS_DIR = 'db/migrations';
export const CLAIM_TTL_DAYS = 7;

// PERMISSIVE on purpose (the lint is where strictness belongs): anything that leads with digits and
// an underscore is counted, so an oddly-named file still occupies its number here.
export function numberOf(filename) {
  const base = String(filename || '').replace(/^.*[\\/]/, '');
  const m = /^(\d+)_.*\.sql$/i.exec(base);
  return m ? Number(m[1]) : null;
}

export const numbersIn = (files) => [...new Set((files || []).map(numberOf).filter((n) => n != null))];
export const highest = (numbers) => (numbers.length ? Math.max(...numbers) : 0);
// Three digits is what every landed file uses; a repo that ever passes 999 keeps sorting correctly
// because the digits grow at the front of the same collation.
export const formatNumber = (n) => String(n).padStart(3, '0');

const git = (repoRoot, args) => spawnSync('git', ['-C', repoRoot, ...args],
  { encoding: 'utf8', timeout: 20000, windowsHide: true, env: cleanGitEnv() });

// Every migration file that exists AT `sha` — from git, so the list is exactly what the landed
// commit carries (a working tree here would be the pre-landing code the landing gate leaves behind).
export function landedMigrationFiles(repoRoot, sha) {
  const r = git(repoRoot, ['ls-tree', '-r', '--name-only', sha, '--', MIGRATIONS_DIR]);
  if (r.status !== 0) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.sql'));
}

// What one xell's worktree holds right now. Tolerant by design: a worktree can be mid-teardown, on a
// machine that is gone, or simply have no migrations dir — none of which is a reason to refuse a
// number. An unreadable worktree contributes nothing and is reported as such.
export function worktreeMigrationFiles(worktreePath) {
  if (!worktreePath) return null;
  try { return readdirSync(join(worktreePath, MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')); }
  catch { return null; }
}

// `--name "add claims table"` → 087_add_claims_table.sql. The name is the zee's; this only makes it a
// legal filename (the lint requires NNN_snake_case.sql).
export function suggestFilename(number, name) {
  const slug = String(name || '').toLowerCase().replace(/\.sql$/, '')
    .replace(/^\d+_/, '')                 // a zee that pasted a whole filename meant the name half
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug ? `${MIGRATIONS_DIR}/${formatNumber(number)}_${slug}.sql` : null;
}

const claimRow = (c) => ({
  number: c.number, prefix: formatNumber(c.number), xell_slug: c.xell_slug,
  filename: c.filename, claimed_at: c.claimed_at, expires_at: c.expires_at,
});

// The claims still worth honouring: not expired, and not held by a xell that has been reaped.
const LIVE_CLAIMS = `SELECT c.*, x.status AS xell_status FROM migration_number_claim c
    LEFT JOIN xell x ON x.id = c.xell_id
   WHERE c.project_id = $1 AND c.expires_at > now()
     AND (x.id IS NULL OR x.status <> 'retired')
   ORDER BY c.number`;

export async function liveClaims(projectId) {
  return (await q(LIVE_CLAIMS, [projectId])).map(claimRow);
}

// HAND OUT (and record) the next free number for `xell`'s project.
//   reuse:  a xell that asks twice gets its OWN live claim back, because the common repeat is a zee
//           re-running the command — handing it 087 after it has already written 086 is the bug this
//           verb exists to prevent. `again: true` is how a zee that genuinely needs a SECOND
//           migration in one landing gets one (seedgate's "you already have an open request", with a
//           way through).
//   locked: the whole read-then-insert runs under a per-project advisory lock, so two asks in the
//           same second cannot both read the same max. The lock is transaction-scoped — it is
//           released by COMMIT/ROLLBACK, including on a crash, so nothing can wedge it.
export async function claimMigrationNumber(project, xell, { name = null, again = false } = {}) {
  const ref = project.ship_ref || project.main_branch || 'main';
  const commit = headCommit(project.repo_root, ref);
  const landedFiles = commit ? landedMigrationFiles(project.repo_root, commit) : [];
  const landed = numbersIn(landedFiles);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('migration_number_claim:' || $1::text))`, [project.id]);

    const claims = (await client.query(LIVE_CLAIMS, [project.id])).rows;
    const mine = claims.filter((c) => c.xell_id === xell.id);
    if (mine.length && !again) {
      await client.query('COMMIT');
      const c = mine[mine.length - 1];
      return { ok: true, reused: true, number: c.number, prefix: formatNumber(c.number),
               filename: c.filename, dir: MIGRATIONS_DIR,
               landed: { ref, commit, count: landedFiles.length, max: highest(landed) },
               worktrees: null,   // not scanned: the answer is the claim you already hold
               claims: claims.map(claimRow), claim: claimRow(c) };
    }

    // Every live xell's worktree, including this one — the source the asking zee cannot see.
    const xells = (await client.query(
      `SELECT id, slug, worktree_path FROM xell
         WHERE project_id=$1 AND status <> 'retired' AND worktree_path IS NOT NULL
         ORDER BY created_at`, [project.id])).rows;
    const scanned = xells.map((x) => {
      const files = worktreeMigrationFiles(x.worktree_path);
      const nums = files ? numbersIn(files) : [];
      return { xell_slug: x.slug, readable: files != null, count: nums.length, max: highest(nums), numbers: nums };
    });
    // What the zee is shown: every worktree that CONTRIBUTED, plus every one that could not be read —
    // an unreadable sibling is a hole in the answer, so it is reported rather than silently dropped.
    const worktrees = scanned.filter((w) => w.count || !w.readable).map(({ numbers, ...w }) => w);

    const taken = new Set([...landed, ...scanned.flatMap((w) => w.numbers), ...claims.map((c) => c.number)]);
    const number = highest([...taken]) + 1;
    const filename = suggestFilename(number, name);

    const { rows: [claim] } = await client.query(
      `INSERT INTO migration_number_claim
         (project_id, xell_id, xell_slug, number, filename, expires_at)
       VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval) RETURNING *`,
      [project.id, xell.id, xell.slug, number, filename, String(CLAIM_TTL_DAYS)]);
    await client.query('COMMIT');
    logline('migrations', `${xell.slug} claimed migration number ${formatNumber(number)}`
      + `${filename ? ` (${filename})` : ''} — landed max ${formatNumber(highest(landed))}, `
      + `${claims.length} other live claim(s)`);
    return { ok: true, reused: false, number, prefix: formatNumber(number), filename, dir: MIGRATIONS_DIR,
             landed: { ref, commit, count: landedFiles.length, max: highest(landed) },
             worktrees, claims: claims.map(claimRow), claim: claimRow(claim) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

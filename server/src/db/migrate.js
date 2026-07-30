// Minimal forward-only migration runner.
// Applies db/migrations/*.sql in filename order, each in its own transaction,
// tracked in schema_migrations. Safe to re-run — already-applied files are skipped.
// Callable at BOOT (spec §6.3: meta-DB migrations ride the self-ship — the restart IS the
// deploy, so the new process must bring its own schema up before serving) and as the
// `npm run db:migrate` CLI, which additionally closes the pool so the script exits.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pool } from './pool.js';
import { config } from '../config.js';
// one parse of "what number is this file", shared with the allocator and the lint's own reasoning
import { numberOf } from '../lib/migration-numbers.js';

const migrationsDir = resolve(config.repoRoot, 'db', 'migrations');

// ── the runtime half of ticket #9's guard ─────────────────────────────────────
// Pure, and it takes the applied set as an argument, so what a boot would refuse can be asserted without
// a database. `numberOf` is imported from lib/migration-numbers.js rather than re-written: that module is
// where "what number is this file" already lives, and a second copy of the parse is how two answers to
// one question start.
export function duplicatePrefixesSplitByLedger(files = [], applied = new Set()) {
  const byNumber = new Map();
  for (const f of files) {
    const n = numberOf(f);
    if (n == null) continue;
    if (!byNumber.has(n)) byNumber.set(n, []);
    byNumber.get(n).push(f);
  }
  const out = [];
  for (const [number, group] of [...byNumber.entries()].sort((a, b) => a[0] - b[0])) {
    if (group.length < 2) continue;
    const sorted = [...group].sort();
    const done = sorted.filter((f) => applied.has(f));
    const todo = sorted.filter((f) => !applied.has(f));
    if (done.length && todo.length) out.push({ number, applied: done, unapplied: todo });
  }
  return out;
}

// What a human reads. It names both sides of the split, because which file is already in is the whole
// point: that one's position is fixed, so the fix can only be the other one.
export function splitPrefixRefusal(groups = []) {
  const lines = ['Refusing to migrate: a migration number this database has already used is claimed by a'
    + ' file it has never applied.', ''];
  for (const g of groups) {
    lines.push(`  ${String(g.number).padStart(3, '0')}:`);
    for (const f of g.applied) lines.push(`    ${f}   ← already applied here`);
    for (const f of g.unapplied) lines.push(`    ${f}   ← NEW, not applied`);
  }
  lines.push('',
    'Filename order IS apply order, so these two were never sequenced by anyone — and the applied one',
    'cannot move: schema_migrations keys on the FILENAME, so renaming it would make it look new and run',
    'it a second time. NOTHING HAS BEEN APPLIED by this run.',
    '',
    '  • Renumber the NEW file to a free number, content unchanged, and get that number from the',
    '    queenzee: `zee migration-number` sees what is landed AND what every live xell has claimed,',
    '    which your own worktree cannot (server/src/lib/migration-numbers.js).',
    '  • test/migration-numbers.test.mjs is the same rule at landing time, with the whole tree in view.',
    '',
    'MIGRATE_ALLOW_DUPLICATE_NUMBERS=true migrates anyway — for a human who has decided the order is',
    'fine. It does not make it fine.');
  return lines.join('\n');
}

export async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const applied = new Set(
      (await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename)
    );

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    // A NUMBER THIS DATABASE HAS ALREADY USED, claimed by a file it has never seen (#9). Filename order
    // IS apply order, so two files sharing a prefix are sequenced by a string comparison between two
    // authors who each believed theirs was next — and the ledger keys on FILENAME with no checksum, so
    // nothing about that is illegal or noticed. `zee migration-number` is what stops it happening
    // (lib/migration-numbers.js) and test/migration-numbers.test.mjs fails the build when one lands
    // anyway; this is the third layer, for the case neither covers: a collision landed by somebody else
    // arriving at an established database, where the sibling has ALREADY applied and its order can no
    // longer be chosen.
    //
    // THE LEDGER IS THE RECORD — deliberately, so this carries no grandfather list to drift out of step
    // with the lint's. It refuses only a SPLIT group: some of that number applied here, some not. Every
    // other shape is left alone on purpose. All applied → history, settled, nothing to decide. None
    // applied → a virgin database or a restored snapshot, where the seven landed collisions must still
    // migrate exactly as they always have; the lint owns that case, with the whole tree in view.
    const split = duplicatePrefixesSplitByLedger(files, applied);
    if (split.length && process.env.MIGRATE_ALLOW_DUPLICATE_NUMBERS !== 'true') {
      throw new Error(splitPrefixRefusal(split));
    }
    if (split.length) {
      console.log('[migrate] MIGRATE_ALLOW_DUPLICATE_NUMBERS=true — applying a duplicate number anyway: '
        + split.map((g) => g.number).join(', '));
    }

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(resolve(migrationsDir, file), 'utf8');
      process.stdout.write(`→ applying ${file} ... `);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log('ok');
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.log('FAILED');
        throw err;
      }
    }
    console.log(count ? `Applied ${count} migration(s).` : 'Already up to date.');
    return count;
  } finally {
    client.release();
  }
}

// CLI entry (`node server/src/db/migrate.js`) — boot callers import runMigrations instead.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href || fileURLToPath(import.meta.url) === resolve(process.argv[1] || '')) {
  runMigrations()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

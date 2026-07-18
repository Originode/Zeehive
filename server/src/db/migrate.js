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

const migrationsDir = resolve(config.repoRoot, 'db', 'migrations');

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

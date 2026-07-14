// Minimal forward-only migration runner.
// Applies db/migrations/*.sql in filename order, each in its own transaction,
// tracked in schema_migrations. Safe to re-run — already-applied files are skipped.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from './pool.js';
import { config } from '../config.js';

const migrationsDir = resolve(config.repoRoot, 'db', 'migrations');

async function run() {
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
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

// PROD-GUARD SCHEMA BLOCK — proves the prod guard lets a prod-db xell READ+WRITE rows but
// HARD-BLOCKS schema changes (DDL). Runs the REAL hook (hooks/prod-guard.mjs) exactly as the
// harness would: JSON on stdin, decision on stdout. The one seam is the queenzee HTTP surface the
// hook curls (db-access): a fake `curl` on PATH returns "this cwd owns the prod db" — the shape
// server/src/lib/xell-db.js's dbAccessForCwd returns for a --db shared-prod xell.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROD_DB = 'omnibiz_db_prod';
const CWD = 'D:/Repos/OmniBiz/omnibiz/.claude/worktrees/data-fix-abc123'; // looks like a xell worktree
const HOOK = join(process.cwd(), 'hooks', 'prod-guard.mjs');

// Fake curl: whatever the hook asks db-access, answer "allowed, owns PROD_DB".
const bin = mkdtempSync(join(tmpdir(), 'pg-bin-'));
const answer = JSON.stringify({ allowed: true, db_container: PROD_DB, db_containers: [PROD_DB],
  xell: { slug: 'data-fix', db_coupling: 'db-shared-prod' } });
writeFileSync(join(bin, 'curl'), `#!/bin/sh\ncat <<'JSON'\n${answer}\nJSON\n`);
chmodSync(join(bin, 'curl'), 0o755);
const PATH2 = `${bin}:${process.env.PATH}`;

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

function run(command) {
  const payload = JSON.stringify({ cwd: CWD, tool_name: 'Bash', tool_input: { command } });
  const r = spawnSync(process.execPath, [HOOK], { input: payload, encoding: 'utf8',
    env: { ...process.env, PATH: PATH2, ZEEHIVE_API: 'http://stub.invalid' } });
  const out = (r.stdout || '').trim();
  if (!out) return { allowed: true, reason: null };
  const j = JSON.parse(out);
  return { allowed: j.hookSpecificOutput?.permissionDecision !== 'deny',
           reason: j.hookSpecificOutput?.permissionDecisionReason || '' };
}

const exec = (sql, flag = '-c') =>
  `docker --context mardale-prod exec ${PROD_DB} psql -U omnibiz -d omnibiz ${flag} "${sql}"`;

console.log('prod-guard: DATA is allowed on the assigned prod db');
ok(run(exec('SELECT count(*) FROM orders')).allowed, 'SELECT (read) allowed');
ok(run(exec("UPDATE orders SET status='paid' WHERE id=7")).allowed, 'UPDATE (row write) allowed');
ok(run(exec("INSERT INTO note(body) VALUES ('x')")).allowed, 'INSERT (row write) allowed');
ok(run(exec('DELETE FROM note WHERE id=3')).allowed, 'DELETE (row write) allowed');

console.log('prod-guard: SCHEMA CHANGES are hard-blocked');
const isSchema = (sql) => { const r = run(exec(sql)); return !r.allowed && /SCHEMA CHANGES/i.test(r.reason); };
ok(isSchema('DROP TABLE orders'),                   'DROP denied');
ok(isSchema('ALTER TABLE orders ADD COLUMN x int'), 'ALTER denied');
ok(isSchema('CREATE TABLE t(id int)'),              'CREATE denied');
ok(isSchema('TRUNCATE orders'),                     'TRUNCATE denied');
ok(isSchema('GRANT ALL ON orders TO bob'),          'GRANT denied');
ok(isSchema('REINDEX TABLE orders'),                'REINDEX denied');
ok(isSchema("SELECT 1; DROP TABLE orders"),         'DDL hidden after a SELECT denied');

console.log('prod-guard: SQL the guard cannot SEE is refused (could hide DDL)');
const isOpaque = (cmd) => { const r = run(cmd); return !r.allowed && /NOT VISIBLE|SCHEMA CHANGES/i.test(r.reason); };
ok(isOpaque(exec('/tmp/fix.sql', '-f')),            'psql -f (file) refused');
ok(isOpaque(`docker --context mardale-prod exec ${PROD_DB} sh -c "psql -c 'UPDATE t SET a=1'"`), 'sh -c wrapper refused');
ok(isOpaque(`docker --context mardale-prod exec -i ${PROD_DB} psql < /tmp/fix.sql`), 'stdin redirect refused');

console.log('prod-guard: unrelated commands are untouched');
ok(run(`docker --context mardale-prod exec ${PROD_DB} pg_dump omnibiz`).allowed, 'pg_dump (read) allowed');
ok(run('echo hello').allowed, 'non-prod command allowed');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);

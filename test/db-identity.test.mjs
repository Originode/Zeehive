// DB-LEVEL IDENTITY for "is this DSN the managing meta-DB" (card d56fd7da).
//
// sameDatabase() used to compare host:port+dbname STRINGS, so a 10.x published address and
// meta-db:5432 — the SAME postgres under two host spellings — read as different, and the INPROC
// projection keyed off db_coupling === 'db-shared-dev' (a NAME, not an identity). That name-keyed
// rule misfired for any non-Zeehive project carrying the coupling, and missed the db-prod-readonly
// alias path. The replacement compares a DB-LEVEL identity: the cluster's system_identifier
// (pg_control_system()) paired with current_database(), so host aliases compare equal and genuinely
// different databases compare different.
//
// This file pins the replacement against a REAL postgres — the cage's own `zee db-sandbox` — never
// the shared dev db, db-shared-prod, db-prod-readonly or the managing meta-DB. The sandbox is
// reached through different host spellings (127.0.0.1 vs localhost) for the alias case, and a
// second database inside it gives the genuinely-different negative case.
//
//   1. sameDatabaseIdentity(127.0.0.1, localhost) === true   — host aliases, same physical database.
//   2. sameDatabaseIdentity(sandbox, second-db) === false    — genuinely different database.
//   3. Degraded path: unreachable / unparseable DSN → null (sameDatabaseIdentity) and false
//      (sameDatabase). Unmeasurable must never mean "yes" — a false "same" is what lets a foreign
//      DB be taken for the managing meta-DB.
//   4. sameDatabase() boolean wrapper: true only when the identity check is TRUE.
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = resolve(ROOT, 'scripts', 'zee');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// ── start the sandbox and read its DSN ────────────────────────────────────────────────────────
const start = spawnSync(process.execPath, [CLI, 'db-sandbox'], {
  encoding: 'utf8', timeout: 10 * 60 * 1000,
});
let json = null;
try { json = JSON.parse(start.stdout); } catch { /* reported below */ }
if (!json?.dsn) {
  console.error('could not start `zee db-sandbox` — this test needs a real throwaway postgres.');
  console.error(start.stdout || start.stderr || '(no output)');
  process.exit(2);
}
const DSN = json.dsn;   // postgresql://postgres@127.0.0.1:<port>/postgres
const PORT = json.port;

// Set DATABASE_URL BEFORE importing anything that reads config, so config.databaseUrl IS the sandbox.
process.env.DATABASE_URL = DSN;
process.env.PROVISION_MODE = 'simulate';
process.env.BUILD_MODE = 'simulate';
process.env.TKB_NOTIFY = '0';

const { readDbIdentity, sameDatabaseIdentity, sameDatabase } =
  await import('../server/src/lib/provision.js');
const { config } = await import('../server/src/config.js');

try {
  // The DSN the sandbox printed must be what config resolved (sanity: the test is meaningful).
  ok(config.databaseUrl === DSN, `config.databaseUrl is the sandbox DSN (${config.databaseUrl})`);

  // ── 1. host aliases → the SAME database ──────────────────────────────────────────────────────
  console.log('\n── host aliases are the same physical database ──');
  const localhostDsn = `postgresql://postgres@localhost:${PORT}/postgres`;
  const sameAlias = await sameDatabaseIdentity(DSN, localhostDsn);
  ok(sameAlias === true,
     `sameDatabaseIdentity(127.0.0.1, localhost) === true (got ${sameAlias}) — a 10.x published `
     + 'address and meta-db:5432 are this case');
  ok(await sameDatabase(DSN, localhostDsn) === true,
     'and the sameDatabase() boolean wrapper agrees (true)');

  // The identity really is read from the server, not parsed out of the URL strings: the two DSNs
  // share no host string, so only a server-level identity could make this true.
  const idA = await readDbIdentity(DSN);
  const idB = await readDbIdentity(localhostDsn);
  ok(!!idA && !!idB
     && idA.systemIdentifier === idB.systemIdentifier
     && idA.databaseName === idB.databaseName,
     `both DSNs report the same cluster system_identifier + database (${idA?.systemIdentifier} / ${idB?.systemIdentifier})`);

  // ── 2. a genuinely different database → FALSE ────────────────────────────────────────────────
  console.log('\n── a second database in the same cluster is NOT the same database ──');
  const OTHER = `db_identity_other_${Date.now().toString(36)}`;
  const admin = new (await import('pg')).default.Client({ connectionString: DSN });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${OTHER}`);
  } finally {
    await admin.end().catch(() => {});
  }
  const otherDsn = `postgresql://postgres@127.0.0.1:${PORT}/${OTHER}`;
  const sameClusterDiffDb = await sameDatabaseIdentity(DSN, otherDsn);
  ok(sameClusterDiffDb === false,
     `sameDatabaseIdentity(sandbox, second-db) === false (got ${sameClusterDiffDb}) — same cluster, different database`);
  ok(await sameDatabase(DSN, otherDsn) === false,
     'and sameDatabase() boolean wrapper agrees (false)');
  const idOther = await readDbIdentity(otherDsn);
  ok(!!idOther && idOther.systemIdentifier === idA?.systemIdentifier && idOther.databaseName === OTHER,
     `the second database shares the cluster system_identifier but has its own name (${idOther?.databaseName}) — `
     + 'the pairing is what makes "same database", not "same cluster"');

  // ── 3. degraded path: unmeasurable must never mean "yes" ────────────────────────────────────
  console.log('\n── the degraded path refuses to say "yes" ──');
  const unreachable = 'postgresql://postgres@127.0.0.1:1/nope';   // nothing listens on port 1
  const unkUnreachable = await sameDatabaseIdentity(DSN, unreachable);
  ok(unkUnreachable === null,
     `sameDatabaseIdentity(..., unreachable) === null (got ${unkUnreachable}) — unmeasurable`);
  ok(await sameDatabase(DSN, unreachable) === false,
     'and the boolean wrapper reads unmeasurable as false — never "yes"');
  const unkGarbage = await sameDatabaseIdentity(DSN, 'not a postgres url at all');
  ok(unkGarbage === null, 'unparseable DSN also → null');
  ok(await readDbIdentity(null) === null, 'readDbIdentity(null) → null');

  // ── 4. a different CLUSTER would also be different (system_identifier differs) ─────────────
  // The sandbox has only one cluster, so we cannot prove this here with a second server cheaply;
  // the same-cluster different-database case above is the card's required negative. The pairing
  // (system_identifier + database name) is what makes cross-cluster DSNs different by construction.
  console.log('\n── identity shape ──');
  ok(!!idA?.systemIdentifier && typeof idA.systemIdentifier === 'string',
     `system_identifier is read as a string (${idA?.systemIdentifier}) — comparable across DSNs`);
  ok(idA?.databaseName === 'postgres', `current_database() is the sandbox's db (${idA?.databaseName})`);
} finally {
  // Nothing to tear down: the sandbox is throwaway and the second database dies with the cage.
  // We deliberately do NOT stop the sandbox — other tests / the zee may be using it.
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

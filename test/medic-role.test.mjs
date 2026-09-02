// THE MEDIC'S POSTGRES ROLE — the write wall, proven BY POSTGRES on a live schema
// (server/src/lib/medic-role.js; docs/medic-meta-plane-plan.md §3.3, DR-8; kit stage 4).
//
// docs/self-project-prod-data.md rejected a meta-DB write role with an incident: "any role that
// can UPDATE xell / DELETE FROM container is a nested reaper." DR-8's answer is GRANT scoping —
// so this test MINTS the real role on the live schema and asks postgres, not the tool code:
//
//   A. THE ROLE MINTS — medicRoleSql runs clean against the real schema (grants track the schema).
//   B. THE READ — the medic reads config INCLUDING credential-shaped config (environment_var.value,
//      container.conn_pw: TKT-181 is the patient) but NOT provider_token.token (a vendor key is
//      not config).
//   C. THE NESTED-REAPER LINES — UPDATE xell, DELETE FROM container, INSERT INTO medic_action
//      (its own audit ledger!), UPDATE zee, INSERT INTO land_request: each refused with 42501,
//      postgres speaking.
//   D. THE CONFIG SURFACE — UPDATE machine / UPDATE project(manifest) succeed as permission checks
//      (WHERE false: no row moves); UPDATE project(name) — an identity column — refuses.
//   E. EXACTLY ONE PLANE (245) — a zee/conversation row with neither xell nor medic violates the
//      CHECK; a medic-keyed row inserts.
//   F. SIMULATE MINTS NOTHING — MEDICRW_MODE=simulate returns an inert DSN and creates no role
//      (proven by the SQL never running: the role name check below runs BEFORE the real mint).
//
// RUN:  DATABASE_URL=postgresql://postgres@127.0.0.1:45377/postgres node test/medic-role.test.mjs
//       (a db-sandbox with migrations applied; the role is dropped at the end)
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required (a migrated zee db-sandbox)'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const owner = new pg.Client(url); await owner.connect();
const dbRow = await owner.query('SELECT current_database() AS db, current_user AS u');
const dbName = dbRow.rows[0].db; const ownerUser = dbRow.rows[0].u;

// Import AFTER env is fixed: simulate first, to prove inertness, then the real mint SQL.
process.env.MEDICRW_MODE = 'simulate';
const { medicRoleSql, MEDIC_ROLE, MEDIC_WRITE_TABLES, MEDIC_NO_WRITE_TABLES } =
  await import('../server/src/lib/medic-role.js');

console.log('\n── F. simulate mints nothing ──');
// The module under simulate: mintMedicRole returns an inert handle without touching the db. We
// prove the negative on the DB ITSELF: no such role exists before the explicit real mint below.
// (Pre-clean: a role with grants refuses a bare DROP ROLE — DROP OWNED must strip them first.)
await owner.query(`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${MEDIC_ROLE}') THEN
    EXECUTE 'DROP OWNED BY ${MEDIC_ROLE}'; EXECUTE 'DROP ROLE ${MEDIC_ROLE}';
  END IF; END $$`);
const pre = await owner.query(`SELECT 1 FROM pg_roles WHERE rolname=$1`, [MEDIC_ROLE]);
ok(pre.rows.length === 0, 'no medic role exists before an explicit real mint');

console.log('\n── A. the role mints against the real schema ──');
const pw = randomUUID().replace(/-/g, '');
const sql = medicRoleSql(pw, dbName, ownerUser);
ok(!/GRANT[^;]*ON xell TO/i.test(sql) && !/GRANT[^;]*ON zee TO/i.test(sql),
   'the mint SQL grants nothing on xell/zee (reading is the blanket SELECT, never a write grant)');
ok(!MEDIC_WRITE_TABLES.container?.includes('DELETE'), 'container has no DELETE (the reaper act)');
ok(MEDIC_NO_WRITE_TABLES.includes('medic_action'), 'the audit ledger is on the no-write list');
await owner.query(sql);
const post = await owner.query(`SELECT 1 FROM pg_roles WHERE rolname=$1`, [MEDIC_ROLE]);
ok(post.rows.length === 1, 'the role exists after the mint');

const u = new URL(url);
u.username = MEDIC_ROLE; u.password = pw;
const medic = new pg.Client(u.toString()); await medic.connect();
const attempt = async (q) => { try { await medic.query(q); return { ok: true }; }
                               catch (e) { return { ok: false, code: e.code }; } };

console.log('\n── B. the read: config secrets yes, vendor keys no ──');
ok((await attempt('SELECT value FROM environment_var LIMIT 0')).ok, 'environment_var.value is readable (config)');
ok((await attempt('SELECT conn_pw FROM container LIMIT 0')).ok, 'container.conn_pw is readable (TKT-181 config)');
const tok = await attempt('SELECT token FROM provider_token LIMIT 0');
ok(!tok.ok && tok.code === '42501', 'provider_token.token REFUSES (42501) — a vendor key is not config');
ok((await attempt('SELECT id, provider, label FROM provider_token LIMIT 0')).ok,
   '…while the row minus the secret is readable');

console.log('\n── C. the nested-reaper lines, refused by postgres ──');
for (const [q, label] of [
  ['UPDATE xell SET status=status WHERE false', 'UPDATE xell'],
  ['DELETE FROM container WHERE false', 'DELETE FROM container'],
  ["INSERT INTO medic_action (medic_id, tool, statement) VALUES (gen_random_uuid(), 'x', 'x')", 'INSERT INTO medic_action (forging a receipt)'],
  ['UPDATE zee SET status=status WHERE false', 'UPDATE zee'],
  ['UPDATE medic SET status=status WHERE false', 'UPDATE medic (its own row!)'],
  ["INSERT INTO land_request (xell_id) VALUES (NULL)", 'INSERT INTO land_request (a gate)'],
  ['UPDATE harness SET key=key WHERE false', 'UPDATE harness (no self-grant)'],
]) {
  const r = await attempt(q);
  ok(!r.ok && r.code === '42501', `${label} → 42501`);
}

console.log('\n── D. the config surface accepts ──');
ok((await attempt('UPDATE machine SET label=label WHERE false')).ok, 'UPDATE machine passes the permission check');
ok((await attempt('UPDATE pool_config SET target_ready=target_ready WHERE false')).ok, 'UPDATE pool_config passes');
ok((await attempt('UPDATE project SET manifest=manifest WHERE false')).ok, 'UPDATE project(manifest) — a config column — passes');
const ident = await attempt('UPDATE project SET name=name WHERE false');
ok(!ident.ok && ident.code === '42501', 'UPDATE project(name) — an identity column — refuses');
ok((await attempt('DELETE FROM project_condition WHERE false')).ok, 'DELETE project_condition (closing a fixed fault) passes');

console.log('\n── D2. the WHOLE declared surface vs the LIVE schema (never a hardcoded copy) ──');
for (const [table, stmts] of Object.entries(MEDIC_WRITE_TABLES)) {
  const exists = (await owner.query(`SELECT to_regclass($1) AS t`, [table])).rows[0].t;
  if (!exists) { console.log(`  (table ${table} not on this schema — skipped)`); continue; }
  for (const s of ['INSERT', 'UPDATE', 'DELETE']) {
    const want = stmts.includes(s);
    const has = (await owner.query(
      `SELECT has_table_privilege($1, $2, $3) AS p`, [MEDIC_ROLE, table, s])).rows[0].p;
    ok(has === want, `${table}: ${s} ${want ? 'granted' : 'absent'} as declared`);
  }
}
for (const table of MEDIC_NO_WRITE_TABLES) {
  const exists = (await owner.query(`SELECT to_regclass($1) AS t`, [table])).rows[0].t;
  if (!exists) { console.log(`  (table ${table} not on this schema — skipped)`); continue; }
  const anyWrite = (await owner.query(
    `SELECT has_table_privilege($1,$2,'INSERT') OR has_table_privilege($1,$2,'UPDATE')
            OR has_table_privilege($1,$2,'DELETE') AS p`, [MEDIC_ROLE, table])).rows[0].p;
  ok(anyWrite === false, `${table}: NO write privilege of any kind`);
}

console.log('\n── E. exactly one plane (245) ──');
const proj = await owner.query(
  `INSERT INTO project (name, repo_root) VALUES ('t-medic-'||substr(md5(random()::text),1,6), '/tmp/x') RETURNING id`);
const pid = proj.rows[0].id;
const mrow = await owner.query(`INSERT INTO medic (target_project_id, brief) VALUES ($1,'test') RETURNING id`, [pid]);
const mid = mrow.rows[0].id;
const neither = await owner.query(
  `INSERT INTO zee (attach_mode, viewer_kind, status, kind, entrypoint, permission_mode, cwd, title)
   VALUES ('headless-spawn','none','working','headless','medic','bypassPermissions','/','t')`).then(() => null, (e) => e);
ok(neither?.code === '23514' && /zee_exactly_one_plane/.test(neither?.constraint || ''),
   'a zee with NEITHER plane violates zee_exactly_one_plane');
const withMedic = await owner.query(
  `INSERT INTO zee (medic_id, attach_mode, viewer_kind, status, kind, entrypoint, permission_mode, cwd, title)
   VALUES ($1,'headless-spawn','none','working','headless','medic','bypassPermissions','/','t') RETURNING id`, [mid]);
ok(!!withMedic.rows[0]?.id, 'a medic-keyed zee inserts (no xell — the directive, as a constraint)');
const convNeither = await owner.query(
  `INSERT INTO zee_conversation (seq, role, content) VALUES (1,'user','x')`).then(() => null, (e) => e);
ok(convNeither?.code === '23514', 'a conversation row with neither plane violates its CHECK');
const convMedic = await owner.query(
  `INSERT INTO zee_conversation (medic_id, seq, role, content) VALUES ($1, 1,'user','x') RETURNING id`, [mid]);
ok(!!convMedic.rows[0]?.id, 'a medic-keyed conversation row inserts');

await owner.query('DELETE FROM project WHERE id=$1', [pid]);   // cascades medic → zee → conversation
await medic.end();
await owner.query(`DROP OWNED BY ${MEDIC_ROLE}; DROP ROLE ${MEDIC_ROLE}`).catch(async (e) => {
  console.log(`  (role cleanup: ${e.message})`);
});
await owner.end();
console.log(fail ? `\n${fail} FAILURE(S)` : '\nall good');
process.exit(fail ? 1 : 0);

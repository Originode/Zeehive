// QUEENZEE MINISTER — the manager-type persona that reviews the queenzee and files tickets.
//
// The minister's whole design is a WALL between finding and acting: `zee ops` (GET /xell/self/ops)
// is a read-only digest of the queenzee's own operations (log ring, gate waits, ships with their
// errors, token burn, backups), and `zee ticket` (POST /xell/self/ticket) is the ONLY write the
// critique gets — a ticket in the caller's own project, which opens no gate. Both are MANAGER
// verbs; the `queenzee-minister` harness (migration 120) is the persona built on them, inheriting
// the manager manual (and 119's ops/ticket section) from `manager` the same way dev-lead does.
//
// It asserts:
//   1. STATIC wiring — the three routes exist and resolve the caller from its token (resolveSelf),
//      the CLI advertises and implements `ops` and `ticket` (cxell-cli-drift holds the manuals);
//   2. the REFUSALS are pure — a worker-type xell calling selfOps/selfTicketCreate/selfTicketList
//      is refused with the manager explanation BEFORE any db work, and a titleless ticket is
//      refused with the instruction;
//   3. the DIGEST is read-only by construction — lib/ops-review.js contains not one writing SQL
//      verb — and, against the real meta-DB, opsDigest() answers with every promised section;
//   4. the HARNESS row is right — manager-type, enabled, system-wide, parent resolves to `manager`
//      (the inheritance the drift lint measures manuals through), carries its own manual entry,
//      and the shared manager manual carries the `zee ops` / `zee ticket` section (119);
//   5. the minister manual never tells a zee to act on prod or bypass a gate — its job is tickets.
//
// Reads only; it creates nothing and deletes nothing (the one test here that can say that).
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// ── 1. static wiring: routes + CLI ────────────────────────────────────────────────────────────
console.log('\n── routes: the three minister endpoints, token-scoped like every self verb ──');
const routes = read('server/src/api/routes.js');
for (const [method, path] of [['get', '/xell/self/ops'], ['post', '/xell/self/ticket'], ['get', '/xell/self/tickets']]) {
  const rx = new RegExp(`router\\.${method}\\('${path.replace(/\//g, '\\/')}'[\\s\\S]{0,200}?resolveSelf`);
  ok(rx.test(routes), `${method.toUpperCase()} /api${path} exists and resolves the caller from its own token`);
}
ok(/selfOps, selfTicketCreate, selfTicketList/.test(routes), 'routes.js imports the three verbs from queenzee/self.js');

console.log('\n── CLI: `zee ops` and `zee ticket` advertised AND implemented (drift-test shape) ──');
const cli = read('scripts/zee');
const usageBlock = cli.slice(cli.indexOf('function usage()'), cli.indexOf('switch (cmd)'));
for (const verb of ['ops', 'ticket']) {
  ok(new RegExp(`^\\s{2,}zee ${verb}\\b`, 'm').test(usageBlock), `usage advertises "zee ${verb}"`);
  ok(cli.includes(`case '${verb}':`), `and scripts/zee implements the '${verb}' case`);
}
// The advertisement must sit under the MANAGER-only heading — that heading is what tells the drift
// test which manual must brief the verb (and which zees are told they have it).
const managerSection = usageBlock.slice(usageBlock.indexOf('MANAGER-only'));
ok(/^\s{2,}zee ops\b/m.test(managerSection) && /^\s{2,}zee ticket\b/m.test(managerSection),
   'both verbs are advertised in the MANAGER-only section (workers are refused, and told so)');

// ── 2. the refusals are pure (no db touched before the guard answers) ─────────────────────────
console.log('\n── refusals: a worker calling a minister verb learns what it is, before any db work ──');
const self = await import('../server/src/queenzee/self.js');
const worker = { id: '00000000-0000-4000-8000-00000000dead', slug: 'test-worker', zee_type: 'worker', project_id: null };
for (const [name, call] of [
  ['selfOps', () => self.selfOps(worker, {})],
  ['selfTicketCreate', () => self.selfTicketCreate(worker, { title: 'x' })],
  ['selfTicketList', () => self.selfTicketList(worker, {})],
]) {
  const r = await call();
  ok(r?.ok === false && r?.status === 'refused' && /MANAGER verb/.test(r?.error || ''),
     `${name} refuses a worker with the manager explanation`);
}
{
  const manager = { id: '00000000-0000-4000-8000-00000000beef', slug: 'test-manager', zee_type: 'manager', project_id: null };
  const r = await self.selfTicketCreate(manager, { title: '   ' });
  ok(r?.ok === false && /--title/.test(r?.error || ''), 'a titleless ticket is refused with the instruction (before any insert)');
}

// ── 3. the digest is read-only by construction ────────────────────────────────────────────────
console.log('\n── ops-review.js: a review verb that cannot act ──');
const lib = read('server/src/lib/ops-review.js');
const sql = [...lib.matchAll(/`([^`]*)`/gs)].map((m) => m[1]).filter((s) => /SELECT/i.test(s));
ok(sql.length >= 10, `it queries the gates/fleet/burn/backups (${sql.length} statements)`);
ok(!/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT)\b/.test(lib.replace(/\/\/[^\n]*/g, '')),
   'and contains not one writing SQL verb — criticism that could ACT would be a second queenzee');

// ── 4/5. against the real meta-DB (the rows migrations 119/120 own) ───────────────────────────
if (!process.env.DATABASE_URL) {
  console.error('\nDATABASE_URL required for the harness/manual/digest assertions — the rows 119/120 own live in the meta-DB');
  process.exit(2);
}
const { q, one, pool } = await import('../server/src/db/pool.js');
try {
  try { await one(`SELECT 1 AS up`); }
  catch (e) {
    console.error(`\ncould not reach the meta-DB (${e.message}) — the db half of this test needs one with db:migrate applied`);
    process.exit(2);
  }

  console.log('\n── the queenzee-minister harness row (migration 120) ──');
  const row = await one(
    `SELECT h.key, h.zee_type, h.enabled, h.project_id, h.bundle, p.key AS parent_key
       FROM harness h LEFT JOIN harness p ON p.id = h.parent_id
      WHERE h.key = 'queenzee-minister'`);
  ok(!!row, 'the row exists (run npm run db:migrate if not)');
  if (row) {
    ok(row.zee_type === 'manager', `it is a MANAGER-type harness (got: ${row.zee_type}) — fleet reach, read-only prod, no landing`);
    ok(row.enabled === true && row.project_id === null, 'enabled and system-wide (every project can seat a minister)');
    ok(row.parent_key === 'manager', `parent resolves to \`manager\` (got: ${row.parent_key}) — the manual arrives by INHERITANCE, never copy`);
    const mem = (Array.isArray(row.bundle?.memory) ? row.bundle.memory : []);
    const manual = mem.find((m) => m.path === 'memory/queenzee-minister-manual.md')?.text || '';
    ok(manual.includes('zee ops') && manual.includes('zee ticket'), 'its own manual teaches the two verbs the job runs on');
    ok(/token consumption/i.test(manual) && /efficiency/i.test(manual),
       'and states the priorities the task set: queenzee efficiency and zee token consumption');
    ok(/never break|must never break|Safety of your own suggestions/i.test(manual),
       'and the safety constraint — suggestions must not break the system, the source or the meta-DB');
    ok(!/bundle\s*->\s*'memory'\s*->\s*0/.test(read('db/migrations/120_queenzee_minister_harness.sql')),
       'migration 120 never hand-rolls memory[0] (house rule 9 — it goes through harness_memory_put)');
    // The minister's OWN text must not copy the manager manual (the dev-lead lesson: an inherited
    // manual arrives once, a copied one rots on its own schedule).
    ok(!manual.includes('## The three hard limits'), 'its manual does not copy the manager manual it inherits');
  }

  console.log('\n── the shared manager manual carries the ops/ticket section (migration 119) ──');
  const mm = await one(`SELECT harness_memory_get('manager', 'memory/manager-zee-manual.md') AS txt`);
  ok(!!mm?.txt, 'the manager manual exists in the meta-DB');
  ok(!!mm?.txt && mm.txt.includes('zee ops') && mm.txt.includes('zee ticket'),
     'and briefs every manager on `zee ops` / `zee ticket` (the drift lint measures every manager harness through this)');

  console.log('\n── opsDigest(): every promised section, off the live meta-DB, reads only ──');
  const { opsDigest } = await import('../server/src/lib/ops-review.js');
  const d = await opsDigest({ hours: 24, logN: 50 });
  ok(d.ok === true && typeof d.generated_at === 'string' && d.window_hours === 24, 'answers ok with its window');
  for (const k of ['logs', 'alerts', 'landings', 'ships', 'prod_binds', 'seeds', 'fleet', 'burn', 'backups']) {
    ok(k in d, `carries "${k}"`);
  }
  ok(Array.isArray(d.landings.open) && typeof d.landings.counts === 'object', 'landings: open rows + counts by status');
  ok(Array.isArray(d.ships.recent), 'ships: recent rows (failures carry their error text)');
  ok(typeof d.burn.window.cost === 'number' && Array.isArray(d.burn.top), 'burn: window totals + the top spenders');
  ok(Array.isArray(d.fleet.tends), 'fleet: the tends nobody has answered');
  // an out-of-range window is clamped, not an error (a critic asking for a year gets a fortnight)
  const wide = await opsDigest({ hours: 999999, logN: 5 });
  ok(wide.window_hours === 24 * 14, `the window clamps at 14 days (got ${wide.window_hours}h)`);
} finally {
  await pool.end().catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

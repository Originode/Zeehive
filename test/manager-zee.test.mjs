// MANAGER ZEES — integration test for the fleet's middle layer.
//
// Stands up an ISOLATED throwaway project in the real meta DB (its own git repo, a manager xell and
// two worker xells) and exercises the whole manager layer without spawning a single agent:
//
//   1. the SCHEMA's impossibilities: a manager cannot be managed, a worker cannot report to a
//      worker, nothing manages itself, production is never a manager (052's guard trigger);
//   2. ZERO PUSH: the landgate DECLINES a manager's push and raises NO land_request (so there is
//      nothing a human could approve), xellgit refuses every git write verb for a manager, and
//      `zee land` refuses with the explanation;
//   3. the crew read model: who reports to whom, what each worker is waiting on;
//   4. messages: manager → worker, worker → manager, unread/read, and the post-ship REFLECTION kind;
//   5. scoping: a manager can only reach ITS OWN crew, and a worker gets a real explanation (not a
//      404) when it calls a manager verb;
//   6. done suggestions: raised → visible as occ-doneSuggest → a human decides; a manager can
//      neither suggest itself done nor approve its own suggestion;
//   7. prod is READ-ONLY: the SQL minted for a manager grants SELECT and nothing else, and the
//      binding/rules a manager is briefed with say so;
//   8. the manager harness parses, carries its OWN manual, and materializes into a cxell.
//
// Everything it creates is torn down in a finally, whatever happens.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.PRODRO_MODE = 'simulate';      // never touch a real database
process.env.TKB_NOTIFY = '0';              // no desk pings from a test

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

const client = new pg.Client({ connectionString: url });
const tmp = mkdtempSync(join(tmpdir(), 'mgrzee-'));
const PID = '00000000-0000-4000-8000-00000000d111';
const ids = { xource: '00000000-0000-4000-8000-00000000d222' };

async function cleanup({ files = false } = {}) {
  try { await client.query(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* */ }
  if (files) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } }
}

try {
  await client.connect();
  await cleanup();

  // ── a real repo: master, a manager branch with a commit on it, and two worker branches ──
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# manager test\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');

  const mgrWt = join(tmp, 'mgr');
  git(repo, 'worktree', 'add', '-q', '-b', 'spinoff/mgr', mgrWt, 'master');
  writeFileSync(join(mgrWt, 'notes.md'), 'a manager should never be writing this\n');
  git(mgrWt, 'add', '-A'); git(mgrWt, 'commit', '-qm', 'manager commit');
  const mgrHead = git(mgrWt, 'rev-parse', 'HEAD');

  const w1Wt = join(tmp, 'w1');
  git(repo, 'worktree', 'add', '-q', '-b', 'spinoff/w1', w1Wt, 'master');
  const w2Wt = join(tmp, 'w2');
  git(repo, 'worktree', 'add', '-q', '-b', 'spinoff/w2', w2Wt, 'master');

  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,'mgrzee-test',$2,'master','mgrtest','postgres')`, [PID, repo]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [ids.xource, PID]);

  const mkXell = async (slug, branch, wt, extra = '') => (await client.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled ${extra ? ', ' + extra.split('=')[0] : ''})
       VALUES ($1,$2,$3,$4,$5,'working',false ${extra ? `, '${extra.split('=')[1]}'` : ''}) RETURNING *`,
    [PID, ids.xource, slug, branch, wt])).rows[0];

  const mgr = await mkXell('mgr', 'spinoff/mgr', mgrWt, "zee_type=manager");
  const w1 = await mkXell('w1', 'spinoff/w1', w1Wt);
  const w2 = await mkXell('w2', 'spinoff/w2', w2Wt);
  await client.query(`UPDATE xell SET manager_xell_id=$1 WHERE id IN ($2,$3)`, [mgr.id, w1.id, w2.id]);
  // re-read the worker rows: the verbs take a xell ROW, and manager_xell_id is what makes a worker
  // able to report back — a stale row is exactly the "no manager" case, which we test separately.
  const reread = async (x) => (await client.query(`SELECT * FROM xell WHERE id=$1`, [x.id])).rows[0];
  Object.assign(w1, await reread(w1));
  Object.assign(w2, await reread(w2));

  const managers = await import('../server/src/lib/managers.js');
  const { hiveStatus } = await import('../server/src/lib/hive-status.js');
  const { checkPush } = await import('../server/src/queenzee/landgate.js');
  const { readonlyRoleSql, roRoleName, readonlyDsn } = await import('../server/src/lib/prod-readonly.js');

  // ── 1. the schema's impossibilities ──────────────────────────────────────
  const refuses = async (sql, params, what) => {
    try { await client.query(sql, params); ok(false, `${what} is refused by the DB`); }
    catch (e) { ok(/manager|itself|production/i.test(e.message), `${what} is refused by the DB (${e.message.split('\n')[0].slice(0, 70)})`); }
  };
  await refuses(`UPDATE xell SET manager_xell_id=$1 WHERE id=$1`, [mgr.id], 'a xell managing itself');
  await refuses(`UPDATE xell SET zee_type='manager' WHERE id=$1`, [w1.id], 'a MANAGED xell becoming a manager');
  await refuses(`UPDATE xell SET manager_xell_id=$1 WHERE id=$2`, [w1.id, w2.id], 'a worker reporting to a WORKER');
  ok(true, 'a manager may hold a crew (the rows above were created)');

  // ── 2. ZERO PUSH to the xource ───────────────────────────────────────────
  const before = (await client.query(`SELECT count(*)::int n FROM land_request WHERE project_id=$1`, [PID])).rows[0].n;
  const pushed = await checkPush({ projectId: PID, ref: 'refs/heads/master', oldSha: null, newSha: mgrHead });
  const after = (await client.query(`SELECT count(*)::int n FROM land_request WHERE project_id=$1`, [PID])).rows[0].n;
  ok(pushed.allow === false && pushed.reason === 'manager-no-push',
     `the landgate DECLINES a manager's push (reason: ${pushed.reason})`);
  ok(pushed.request === null && after === before,
     'and raises NO land_request — there is nothing a human could approve');

  const { pushToXource, requestPullIn, pullFromXource } = await import('../server/src/queenzee/xellgit.js');
  for (const [fn, name] of [[pushToXource, 'pushToXource'], [requestPullIn, 'requestPullIn'], [pullFromXource, 'pullFromXource']]) {
    try { await fn(mgr.id); ok(false, `${name} refuses a manager xell`); }
    catch (e) { ok(/MANAGER xell/.test(e.message), `${name} refuses a manager xell`); }
  }
  const { selfLand, selfProdRequest } = await import('../server/src/queenzee/self.js');
  const landed = await selfLand(mgr);
  ok(landed.ok === false && landed.refused === 'land' && /zero push/.test(landed.error),
     '`zee land` refuses a manager, with the explanation and the alternative (dispatch a worker)');
  const askedProd = await selfProdRequest(mgr, { reason: 'give me writes' });
  ok(askedProd.ok === false && /READ-ONLY/.test(askedProd.error),
     '`zee prod` refuses a manager: it may not escalate its own read-only prod access');

  // a WORKER is unaffected by any of it
  const workerLand = await selfLand(w1);
  ok(workerLand.refused === undefined, 'a worker is NOT refused by the manager guard (it lands normally)');

  // ── 3. the crew read model ───────────────────────────────────────────────
  const crew = await managers.crewFor(mgr.id);
  ok(crew.length === 2 && crew.map((c) => c.slug).sort().join(',') === 'w1,w2', 'the crew lists both workers');
  ok(crew.every((c) => c.hive_status && c.hive_status_label), 'each worker carries its hive status for the manager to read');
  ok((await managers.crewFor(w1.id)).length === 0, 'a worker has no crew of its own');
  ok((await managers.workerOf(mgr.id, 'w1'))?.id === w1.id, 'a manager resolves its own worker by slug');
  ok((await managers.workerOf(w1.id, 'w2')) == null, 'a worker cannot resolve someone else\'s crew member');

  // ── 4. messages both ways ────────────────────────────────────────────────
  const sent = await managers.postMessage({ from: mgr, to: w1, body: 'scope it to the console only', kind: 'directive' });
  ok(sent.ok === true && sent.message.kind === 'directive', 'a manager can message a worker');
  ok(sent.delivered === false && /no cxell zee/.test(sent.delivery?.reason || ''),
     'with no live cxell the message is STORED and the failure reported honestly (not silently dropped)');
  const back = await managers.postMessage({ from: w1, to: mgr, body: 'shipped; two things to fix', kind: 'reflection' });
  ok(back.message.kind === 'reflection', 'a worker can send its post-ship REFLECTION to its manager');

  const box = await managers.inboxFor(mgr.id);
  ok(box.length === 1 && box[0].from === 'w1' && box[0].kind === 'reflection', 'the manager\'s inbox holds the reflection');
  ok((await managers.inboxFor(mgr.id)).length === 0, 'reading marks read — an inbox does not nag twice');
  ok((await managers.inboxFor(mgr.id, { all: true })).length === 1, '--all still shows the history');

  // the CONSOLE read model is the whole conversation, and it marks NOTHING read — a human auditing
  // the manager⇄worker history must not clear an agent's unread flags
  const hist = await managers.messagesForXell(w1.id);
  ok(hist.length === 2, 'messagesForXell returns both sides of the conversation (directive in, reflection out)');
  ok(hist.some((m) => m.kind === 'directive' && m.from === 'mgr' && m.to === 'w1' && /scope it to the console/.test(m.body)),
     'the worker side shows the DIRECTIVE its manager sent it');
  ok(hist.some((m) => m.kind === 'reflection' && m.from === 'w1' && m.to === 'mgr'),
     'and the report the worker sent back');
  ok(hist.every((m) => m.from_xell_id && m.to_xell_id), 'every row carries both endpoint ids for the UI to draw direction');
  const mgrHist = await managers.messagesForXell(mgr.id);
  ok(mgrHist.length === 2, 'the manager sees the same conversation from its side');
  // the console read must not have consumed the agent's unread inbox: w1's directive is still unread
  const w1box = await managers.inboxFor(w1.id);
  ok(w1box.length === 1 && w1box[0].kind === 'directive' && w1box[0].was_unread === true,
     'a console read does NOT mark the worker\'s unread directive read (its own `zee inbox` still sees it)');

  // ── 5. scoping + the worker-calls-a-manager-verb explanation ─────────────
  const { selfCrew, selfSay, selfSuggestDone, selfDispatch, selfReport } = await import('../server/src/queenzee/self.js');
  const denied = await selfCrew(w1);
  ok(denied.ok === false && /MANAGER verb/.test(denied.error) && /zee report/.test(denied.error),
     'a worker calling a manager verb is told what it is, and what it CAN do instead');
  const stranger = await selfSay(mgr, { to: 'somebody-else', message: 'hi' });
  ok(stranger.ok === false && /no worker/.test(stranger.error), 'a manager cannot message a xell outside its crew');
  const selfDispatchMgr = await selfDispatch(mgr, { task: 'make me another boss', harness: 'manager' });
  ok(selfDispatchMgr.ok === false && /work-items board/.test(selfDispatchMgr.error)
     && /zee assign/.test(selfDispatchMgr.error),
     'a manager\'s free-form `zee dispatch` is REFUSED — deploying must go through the work-items board (`zee assign`)');
  const noTask = await selfDispatch(mgr, {});
  ok(noTask.ok === false && /--task/.test(noTask.error), 'a dispatch without a brief is refused');
  const reported = await selfReport(w2, { message: 'blocked on a decision' });
  ok(reported.ok === true && reported.addressed === true, 'a worker reports to its manager with `zee report`');

  // ── 6. done suggestions ──────────────────────────────────────────────────
  const selfSug = await managers.suggestDone({ manager: mgr, target: mgr }).catch((e) => e);
  ok(selfSug instanceof Error && /itself/i.test(selfSug.message), 'a manager cannot suggest ITSELF done');
  const sug = await managers.suggestDone({ manager: mgr, target: w1, reason: 'landed and shipped' });
  ok(sug.ok === true && sug.suggestion.status === 'pending', 'a done suggestion is raised, pending a human');
  const dupe = await managers.suggestDone({ manager: mgr, target: w1, reason: 'again' });
  ok(dupe.suggestion.id === sug.suggestion.id, 'a second suggestion for the same xell returns the open one');
  ok(hiveStatus({ status: 'working', zee_status: 'working' }, { doneSuggested: true }) === 'occ-doneSuggest',
     'a pending suggestion shows as occ-doneSuggest on the target\'s hexagon');
  ok(hiveStatus({ status: 'working' }, { doneSuggested: true, landPending: true }) === 'occ-landRequest',
     'a held landing still outranks a manager\'s suggestion');
  const open = await managers.listDoneSuggestions(PID);
  ok(open.length === 1 && open[0].live_target_slug === 'w1' && open[0].live_manager_slug === 'mgr',
     'the console lists the open suggestion with both slugs resolved');

  // there is NO zee path to the decision: it is a human API only
  const routes = await import('node:fs').then((fs) => fs.readFileSync('server/src/api/routes.js', 'utf8'));
  ok(!/xell\/self\/(approve-done|decide-done)/.test(routes),
     'there is no /xell/self/ route that DECIDES a done suggestion (only a human API)');

  const rejected = await managers.decideDoneSuggestion(sug.suggestion.id, 'rejected', 'test@human');
  ok(rejected.status === 'rejected', 'a human can reject it, and the xell keeps working');
  const told = await managers.inboxFor(mgr.id);
  ok(told.some((m) => /REJECTED/.test(m.body)), 'the manager is TOLD the decision (it lands in its inbox)');
  ok(told.some((m) => m.from === 'w2' && /blocked on a decision/.test(m.body)),
     'and the worker\'s own report is in there too (one inbox, every sender)');

  // ── 7. production, read-only ─────────────────────────────────────────────
  const role = roRoleName('mgr-xell');
  const sql = readonlyRoleSql(role, 'pw', 'proddb', 'owner');
  ok(/GRANT SELECT ON ALL TABLES/.test(sql) && /default_transaction_read_only = on/.test(sql),
     'the minted role is granted SELECT and forced read-only at the session level');
  ok(!/GRANT (INSERT|UPDATE|DELETE|ALL)/.test(sql) && /NOSUPERUSER NOCREATEDB NOCREATEROLE/.test(sql),
     'it is granted no write privilege of any kind, and cannot create roles or databases');
  ok(/REVOKE CREATE ON SCHEMA public/.test(sql), 'it cannot create objects in the schema either');
  ok(readonlyDsn({ host: '10.0.0.5', port: 5432, role, password: 'p/w', dbName: 'proddb' })
       .includes('10.0.0.5:5432/proddb'), 'the DSN points at the prod db\'s recorded address');
  ok(readonlyDsn({ host: null, port: null, role, password: 'p', dbName: 'd' }) === null,
     'a prod db row with no reachable address yields NO dsn (the bind fails closed)');
  const { DB_MODES } = await import('../server/src/lib/xell-db.js');
  ok('db-prod-readonly' in DB_MODES, 'db-prod-readonly is a real coupling the attach path knows');

  // A project with NO production registered (this test project) must still be able to hold managers —
  // reading prod is a capability, not the definition of the role. It is skipped LOUDLY, not faked.
  const { bindManagerToProdReadonly } = await import('../server/src/lib/manager-spawn.js');
  const noProd = await bindManagerToProdReadonly(mgr.id);
  ok(noProd.bound === false && /no prod db/.test(noProd.reason || ''),
     'with no production registered the bind is SKIPPED (a manager is still a manager)');
  const still = (await client.query(`SELECT db_coupling, prod_ro_dsn FROM xell WHERE id=$1`, [mgr.id])).rows[0];
  ok(still.db_coupling !== 'db-prod-readonly' && still.prod_ro_dsn === null,
     'and nothing is left pointing at a production that does not exist');

  // ── 8. the manager harness carries its OWN manual — FROM THE META-DB ─────
  // The row is the harness (migration 080): there is no harnesses/manager/ text to parse, and this
  // used to read the folder. What must hold is unchanged — a manager is briefed with a manual of its
  // own, not the worker one with extras.
  const hrow = (await client.query(
    `SELECT h.zee_type, h.parent_id, h.dir, harness_memory_get('manager','memory/manager-zee-manual.md') AS manual
       FROM harness h WHERE h.key='manager'`)).rows[0];
  ok(!!hrow, 'the manager harness row exists');
  ok(hrow.dir === null, 'and it is DB-owned — nothing on disk can project over its text');
  const manual = { text: hrow.manual || '' };
  ok(manual.text.length > 3000, `it carries a manual of its own, in the row (${manual.text.length} chars)`);
  for (const must of ['zee dispatch', 'zee suggest-done', 'ZERO push access', 'READ-ONLY', 'LOOPHOLES']) {
    ok(manual.text.includes(must), `the manual states: ${must}`);
  }
  ok(hrow.parent_id === null, 'it does NOT inherit the worker manual (a manager has different doors)');
  ok(hrow.zee_type === 'manager', 'the row DECLARES the zee type it is for');

  // ── 9. TYPE vs HARNESS: the two axes, and the rule between them ──────────
  const H = await import('../server/src/lib/harness.js');
  ok(H.harnessFitsType('worker', 'worker') && H.harnessFitsType('manager', 'manager'),
     'a harness fits a xell of its own type');
  ok(!H.harnessFitsType('manager', 'worker') && !H.harnessFitsType('worker', 'manager'),
     'and never one of the other type');
  ok(H.harnessFitsType('any', 'worker') && H.harnessFitsType('any', 'manager'),
     "the law layer ('any') fits both — it is the manual every zee gets");

  const offered = await H.listHarnesses({ zeeType: 'worker' });
  ok(!offered.some((x) => x.key === 'manager'), 'a WORKER picker is never offered the manager harness');
  ok(offered.some((x) => x.zee_type === 'worker'), 'but it is offered the worker ones');
  const mgrOffered = await H.listHarnesses({ zeeType: 'manager' });
  ok(mgrOffered.some((x) => x.key === 'manager') && !mgrOffered.some((x) => x.zee_type === 'worker'),
     'and a MANAGER picker is offered manager harnesses only');

  // assigning across types is refused — with a sentence, not a postgres exception
  const mgrHarness = await client.query(`SELECT id FROM harness WHERE key='manager'`);
  const wrong = await H.assignHarness(w2.id, 'manager').catch((e) => e);
  ok(wrong instanceof Error && /is for manager zees/.test(wrong.message),
     `assigning a manager harness to a WORKER is refused: "${String(wrong.message).slice(0, 60)}…"`);
  const wrong2 = await H.assignHarness(mgr.id, 'zee-base').catch((e) => e);
  ok(wrong2 instanceof Error && /is for worker zees/.test(wrong2.message),
     'and a worker harness on a MANAGER is refused too');
  const right = await H.assignHarness(mgr.id, 'manager');
  ok(right.harness?.key === 'manager', 'the manager harness assigns to a manager xell');

  // the DB is the wall, not the assign path: a direct UPDATE is refused as well
  try {
    await client.query(`UPDATE xell SET harness_id=$2 WHERE id=$1`, [w2.id, mgrHarness.rows[0].id]);
    ok(false, 'a direct UPDATE bypassing the assign path is refused by the DB');
  } catch (e) {
    ok(/is for manager zees/.test(e.message), 'a direct UPDATE bypassing the assign path is refused by the DB');
  }
  // and a xell wearing a harness cannot be retyped out from under it
  try {
    await client.query(`UPDATE xell SET zee_type='worker' WHERE id=$1`, [mgr.id]);
    ok(false, 'a manager wearing the manager harness cannot be flipped to worker');
  } catch (e) {
    ok(/is for manager zees/.test(e.message), 'a manager wearing the manager harness cannot be flipped to worker');
  }
  // nor can the harness be retyped while worn
  try {
    await client.query(`UPDATE harness SET zee_type='worker' WHERE key='manager'`);
    ok(false, 'the harness cannot be retyped while a manager wears it');
  } catch (e) {
    ok(/cannot retype harness/.test(e.message), `the harness cannot be retyped while a manager wears it`);
  }
  // cross-type INHERITANCE is the quiet version of the same bug — also refused
  try {
    await client.query(`UPDATE harness SET parent_id=(SELECT id FROM harness WHERE key='zee-base') WHERE key='manager'`);
    ok(false, 'a manager harness cannot inherit a worker harness');
  } catch (e) {
    ok(/only inherit within its own/.test(e.message), 'a manager harness cannot inherit a worker harness (it would merge the worker manual in)');
  }
  await H.assignHarness(mgr.id, null);   // leave it clean for the teardown

  // ── the briefing a manager is actually given ─────────────────────────────
  const intake = await import('node:fs').then((fs) => fs.readFileSync('server/src/queenzee/intake.js', 'utf8'));
  ok(/You are a MANAGER zee: you coordinate other zees/.test(intake), 'the binding RULES name the manager type');
  ok(/NEVER dispatch a worker in a way that gives it reach beyond its own xell/.test(intake),
     'the binding RULES carry the anti-loophole law');
  ok(/SHIPPING is NOT blocked for you/.test(intake), 'the binding RULES say shipping is not blocked');
  // ── 9. the honeycomb SEATS a crew next to its manager ───────────────────
  // The layout lives in a .jsx module (React imports, no DOM here), so the seating functions are
  // lifted OUT of the real source text and run — testing what actually ships rather than a copy.
  {
    const src = readFileSync('web/src/hive/HiveCanvas.jsx', 'utf8');
    const grab = (name, kind = 'function') => {
      const start = src.indexOf(`${kind} ${name}(`);
      if (start < 0) throw new Error(`${name} not found in HiveCanvas.jsx`);
      // Skip the PARAMETER list before hunting the body brace — seatXells destructures its options
      // (`{ reserved, pinned } = {}`), so "the first { after the name" is a parameter, not the body.
      let i = src.indexOf('(', start), pdepth = 0;
      for (; i < src.length; i++) {
        if (src[i] === '(') pdepth++;
        else if (src[i] === ')' && --pdepth === 0) { i++; break; }
      }
      i = src.indexOf('{', i);
      let depth = 0;
      for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
      }
      throw new Error(`could not bracket-match ${name}`);
    };
    const mod = [
      "const cellKey = (row, col) => row + ',' + col;",
      grab('cellNeighbors'), grab('cellsAround'), grab('seatXells', 'export function').replace('export ', ''),
      'return seatXells;',
    ].join('\n');
    // eslint-disable-next-line no-new-func
    const seatXells = new Function(mod)();

    const mgrA = { id: 'A', zee_type: 'manager' }, mgrB = { id: 'B', zee_type: 'manager' };
    const crewA = [1, 2, 3, 4].map((n) => ({ id: `a${n}`, zee_type: 'worker', manager_xell_id: 'A' }));
    const crewB = [1, 2].map((n) => ({ id: `b${n}`, zee_type: 'worker', manager_xell_id: 'B' }));
    const loners = [1, 2, 3].map((n) => ({ id: `x${n}`, zee_type: 'worker' }));
    const list = [...loners.slice(0, 1), mgrA, ...crewB, mgrB, ...crewA, ...loners.slice(1)];
    const cells = seatXells(list, 5);

    const dist = (p1, p2) => {                       // odd-r offset → cube distance
      const cube = ([r, c]) => { const x = c - (r - (r & 1)) / 2; return [x, r, -x - r]; };
      const [ax, ay, az] = cube(p1), [bx, by, bz] = cube(p2);
      return Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz));
    };
    const seats = Object.values(cells).map((c) => c.join(','));
    ok(new Set(seats).size === list.length, 'every xell gets its own cell (no two share a hexagon)');
    ok(crewA.every((w) => dist(cells[w.id], cells.A) <= 2),
       "a manager's whole crew is seated within two rings of it");
    // At the grid's CORNER only two of the six neighbour cells exist, so the rest of the crew
    // correctly spills to the next ring. Away from the edge, a crew of four should all touch it.
    const mid = seatXells(list, 5, { pinned: { A: [2, 2] } });
    ok(crewA.every((w) => dist(mid[w.id], mid.A) === 1),
       'seated away from the edge, a crew of four are all DIRECT neighbours of their manager');
    ok(crewA.filter((w) => dist(cells[w.id], cells.A) === 1).length === 2,
       'at the grid corner it fills the two neighbour cells that exist and spills to the next ring');
    ok(crewB.every((w) => dist(cells[w.id], cells.B) === 1), "a second manager's crew clusters around IT, not A");
    ok(crewB.every((w) => dist(cells[w.id], cells.A) > 1), "and not around the other manager");

    // the no-managers case must be byte-for-byte the old reading-order layout
    const plain = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: String(n), zee_type: 'worker' }));
    const flat = seatXells(plain, 3);
    ok(plain.every((x, i) => flat[x.id][0] === Math.floor(i / 3) && flat[x.id][1] === i % 3),
       'with no managers the seating is exactly the old row-major reading order');

    // the flower's petals are respected: a pinned/reserved cell is never handed to someone else
    const reserved = new Set(['0,1', '1,1']);
    const withFlower = seatXells(plain, 3, { reserved, pinned: { 1: [0, 0] } });
    ok(withFlower['1'].join(',') === '0,0', 'a pinned xell keeps its cell (the expanded flower)');
    ok(!Object.entries(withFlower).some(([id, c]) => id !== '1' && reserved.has(c.join(','))),
       'nobody is seated on a reserved (petal) cell');
  }

} finally {
  await cleanup({ files: true });
  await client.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);

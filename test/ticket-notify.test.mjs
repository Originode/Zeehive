// TICKET CODE + NOTIFY A MANAGER — integration test for ticket #16's two halves.
//
// The feature: from the tickets window a human can COPY a short stable code for a ticket, and hand
// that ticket to one of the managers ACTUALLY DEPLOYED right now, who receives a message carrying
// the same code. This test stands up isolated throwaway projects in the real meta DB and exercises
// both halves without spawning, messaging or touching a single live agent:
//
//   1. THE CODE IS DERIVED, NOT STORED: same ticket → same code from every read path (create, list,
//      get), unchanged by an edit, different for the same #number in another project — and there is
//      no `code` column anywhere, which is why none of that can drift;
//   2. WHO CAN BE TOLD is resolved LIVE from the fleet: the manager xells of THIS ticket's project
//      only — never a worker, never a retired one, never another project's — each carrying whether
//      it has a live cxell session, so a manager with none is SHOWN rather than silently swallowing
//      the message;
//   3. NOTIFY reuses the existing delivery path (managers.postMessage → sendMessageToXell): the
//      message is stored in the manager's inbox, it carries the code/number/title and says out loud
//      that it is a notification and not an order, and the not-delivered verdict comes back as the
//      sentence the send path gave rather than being rounded up to "sent";
//   4. the REFUSALS, each with a readable sentence and the right HTTP status: a worker, a retired
//      manager, another project's manager, an unknown xell, a missing/malformed id, an unknown
//      ticket;
//   5. the ROUTES, driven over real HTTP against the real express router.
//
// 6. IT ACTUALLY ARRIVES (added for ticket #16's "prove a manager RECEIVES it"): a notification is a
//    RICH message, so sendMessageToXell writes it into the manager's cage as .zee-inbox/<ts>/message.md
//    over `docker exec` before typing a one-line pointer at it. That first hop is the substantive one
//    — it is the file every manager in this fleet actually reads — and it is provable here against the
//    same fake `docker` the land-queue test uses: the message.md that lands in the cage is read back
//    off the recorded stdin and must carry the CODE.
//
// NOT covered, and it cannot be from here: the second hop, typing the pointer over SSH into a live
// tmux session (sendKeysToCxellZee). That needs a real sshd, and messaging a genuinely live zee is
// what this suite must never do. Everything up to and including the file landing in the cage IS
// covered; the SSH hop is shared with every other operator message the console sends.
//
// Everything it creates is torn down in a finally, whatever happens (house rule #1: no test data).
import express from 'express';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.TKB_NOTIFY = '0';              // no desk pings from a test

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const client = new pg.Client({ connectionString: url });
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'tktnotify-'));
const PID = '00000000-0000-4000-8000-0000000016a1';   // this test's project
const FID = '00000000-0000-4000-8000-0000000016a2';   // a FOREIGN project (the cross-project refusal)
const EID = '00000000-0000-4000-8000-0000000016a3';   // a project with NO manager at all
const XO = { [PID]: '00000000-0000-4000-8000-0000000016b1',
             [FID]: '00000000-0000-4000-8000-0000000016b2',
             [EID]: '00000000-0000-4000-8000-0000000016b3' };

let server = null;
async function cleanup({ files = false } = {}) {
  try { await client.query(`ROLLBACK`); } catch { /* no open transaction */ }
  try { await client.query(`DELETE FROM project WHERE id = ANY($1::uuid[])`, [[PID, FID, EID]]); } catch { /* */ }
  if (files) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } }
}

try {
  await client.connect();
  await cleanup();

  const T = await import('../server/src/lib/tickets.js');
  const M = await import('../server/src/lib/managers.js');
  const { pool } = await import('../server/src/db/pool.js');

  // ── the fixture: three projects, four manager xells and a worker ─────────
  for (const [id, name, dbn] of [[PID, 'tktnotify-test', 'tkntest'], [FID, 'tktnotify-foreign', 'tknfor'],
                                 [EID, 'tktnotify-empty', 'tknemp']]) {
    await client.query(
      `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
         VALUES ($1,$2,$3,'master',$4,'postgres')`, [id, name, tmp, dbn]);
    await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [XO[id], id]);
  }
  const mkXell = async (project, slug, status, zeeType) => (await client.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, zee_type)
       VALUES ($1,$2,$3,$4,$5,$6,false,$7) RETURNING *`,
    [project, XO[project], slug, `spinoff/${slug}`, join(tmp, slug), status, zeeType])).rows[0];

  const mgrDark = await mkXell(PID, 'tkn-mgr-dark', 'working', 'manager');    // deployed, no cxell session
  const mgrLive = await mkXell(PID, 'tkn-mgr-live', 'working', 'manager');    // deployed, live session
  const mgrPane = await mkXell(PID, 'tkn-mgr-pane', 'working', 'manager');    // a zee, but not in a cxell
  const mgrGone = await mkXell(PID, 'tkn-mgr-gone', 'retired', 'manager');
  const worker  = await mkXell(PID, 'tkn-worker', 'working', 'worker');
  const mgrFar  = await mkXell(FID, 'tkn-mgr-far', 'working', 'manager');

  // The one signal the picker's `live` flag is derived from: a cxell-cli zee in an ssh-terminal
  // cxell. mgrLive is READ in the picker and never notified — a test must not type into a session.
  await client.query(
    `INSERT INTO zee (xell_id, attach_mode, entrypoint, kind, viewer_kind, viewer_url, model, status)
       VALUES ($1,'headless-spawn','cxell-cli','headless','ssh-terminal','ssh://zee@127.0.0.1:22999','opus','idle')`,
    [mgrLive.id]);
  await client.query(
    `INSERT INTO zee (xell_id, attach_mode, entrypoint, kind, viewer_kind, model, status)
       VALUES ($1,'headless-spawn','cxell-cli','headless','web','opus','idle')`, [mgrPane.id]);

  // ── 1. the CODE ──────────────────────────────────────────────────────────
  section('the ticket code');
  const t1 = await T.createTicket({ project_id: PID, title: 'the board flickers when a zee lands',
                                    body: 'steps: watch the hive during a landing', kind: 'bug', reporter: 'zee' });
  const t2 = await T.createTicket({ project_id: PID, title: 'a second ticket' });
  const far = await T.createTicket({ project_id: FID, title: 'a ticket in another project' });

  ok(/^TKT-\d+-[0-9A-F]{4}$/.test(t1.code), `a code is TKT-<number>-<4 hex> (${t1.code})`);
  ok(t1.code.startsWith(`TKT-${t1.number}-`), 'it carries the ticket number a human already says out loud');
  ok(t1.ref === `#${t1.number}`, 'and `ref` (#n) is untouched — the code is an addition, not a rename');

  const listed = (await T.listTickets({ projectId: PID })).find((r) => r.id === t1.id);
  const got = await T.getTicket(t1.id);
  ok(listed.code === t1.code && got.code === t1.code, 'the same code from create, list and get');
  const edited = await T.updateTicket(t1.id, { title: 'the board flickers (still)', priority: 1 });
  ok(edited.code === t1.code, 'an edit does not move it — the code is derived from immutable columns');
  ok(t2.code !== t1.code, 'two tickets in one project have different codes');
  ok(far.number === t1.number && far.code !== t1.code,
     `the SAME #${t1.number} in another project is a DIFFERENT code (${far.code}) — what the id suffix buys`);
  ok(T.ticketCode({ number: 7, id: 'abcd1234-0000-4000-8000-000000000000' }) === 'TKT-7-ABCD'
     && T.ticketCode(null) === null && T.ticketCode({ id: 'x' }) === null,
     'ticketCode is pure and total: no row, or no number, is null rather than a half-code');
  const cols = (await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='ticket'`)).rows.map((r) => r.column_name);
  ok(!cols.includes('code'), 'there is NO code column — nothing to migrate, nothing to backfill, nothing to drift');

  // ── 2. who can be told ───────────────────────────────────────────────────
  section('the managers picker (resolved live)');
  const picker = await T.ticketManagers(t1.id);
  const slugs = picker.managers.map((m) => m.slug).sort();
  ok(slugs.join(',') === 'tkn-mgr-dark,tkn-mgr-live,tkn-mgr-pane',
     `only this project's deployed managers are offered (${slugs.join(', ')})`);
  ok(!slugs.includes('tkn-worker') && !slugs.includes('tkn-mgr-gone') && !slugs.includes('tkn-mgr-far'),
     'never a worker, never a retired xell, never another project\'s manager');
  ok(picker.ticket.code === t1.code && picker.count === 3, 'the picker carries the ticket code and a count');
  const live = picker.managers.find((m) => m.slug === 'tkn-mgr-live');
  const dark = picker.managers.find((m) => m.slug === 'tkn-mgr-dark');
  ok(live.live === true && /live cxell/.test(live.why), 'a manager in a live cxell is marked live, with a why line');
  ok(dark.live === false && /no live cxell/.test(dark.why) && /inbox/.test(dark.why),
     'one with no session is SHOWN as such (and says where the message would go instead)');
  const empty = await T.ticketManagers((await T.createTicket({ project_id: EID, title: 'nobody to tell' })).id);
  ok(empty.count === 0 && /no manager zee/.test(empty.note || ''),
     'a project with no manager answers with an empty list and a sentence, not an error');
  ok((await T.ticketManagers('00000000-0000-4000-8000-0000000016ff')) === null, 'an unknown ticket is null (→ 404)');
  ok(/valid/.test((await caught(() => T.ticketManagers('not-a-uuid')))?.message || ''),
     'a malformed ticket id is refused as bad input, not a 404');

  // ── 3. notify ────────────────────────────────────────────────────────────
  section('notify a manager');
  const sent = await T.notifyManagerOfTicket(t1.id, { xellId: mgrDark.id, by: 'test@human' });
  ok(sent.ok === true && sent.code === t1.code && sent.manager.slug === 'tkn-mgr-dark',
     'the answer names the code and the manager it went to');
  ok(sent.delivered === false && /no cxell zee/.test(sent.delivery?.reason || ''),
     'with no live session it reports NOT delivered, with the send path\'s own reason');
  ok(/inbox/.test(sent.note) && /zee inbox/.test(sent.note) && sent.note.includes(t1.code),
     'and the note tells the human exactly what happened, in one sentence');

  const row = (await client.query(
    `SELECT * FROM zee_message WHERE to_xell_id=$1 ORDER BY created_at DESC LIMIT 1`, [mgrDark.id])).rows[0];
  ok(row && row.delivered === false, 'the message is STORED even though it could not be typed in');
  ok(row.body.includes(t1.code) && row.body.includes(`#${t1.number}`) && row.body.includes(edited.title),
     'the body carries the code, the number and the title');
  ok(row.body.includes(t1.id) && /NOTIFICATION, not an order/.test(row.body),
     'plus the ticket id to read the rest by, and it says plainly that it assigns nothing');
  ok(/sent from the tickets window by test@human/.test(row.body), 'and who sent it');
  const box = await M.inboxFor(mgrDark.id);
  ok(box.length === 1 && box[0].body.includes(t1.code),
     'the manager finds it with `zee inbox` — an undelivered notification is not a lost one');

  const paned = await T.notifyManagerOfTicket(t1.id, { xellId: mgrPane.id });
  ok(paned.delivered === false && /not in a live cxell/.test(paned.delivery?.reason || ''),
     'a manager whose zee is not in a live cxell is reported honestly too');

  // ── 3b. IT ACTUALLY ARRIVES: the file that lands in a LIVE manager's cage ──
  //
  // The delivery a manager really experiences is a file: a rich message is written into the cage as
  // .zee-inbox/<ts>/message.md and only then is a pointer typed at it. So point the whole path at a
  // fake `docker` (test/_bin, the same one land-queue asserts nudges with) and read back what was
  // actually written INTO the cage — not what the payload builder returned.
  section('a live manager RECEIVES it — the message.md that lands in its cage');
  const { mkdtempSync: mkdtmp } = await import('node:fs');
  const { readFileSync: rf, existsSync: ex } = await import('node:fs');
  const dockerLog = join(mkdtmp(join(tmpdir(), 'tkn-docker-')), 'docker.log');
  process.env.DOCKER_LOG = dockerLog;
  process.env.PATH = `${join(ROOT, 'test', '_bin')}:${process.env.PATH}`;
  const delivered = await T.notifyManagerOfTicket(t1.id, { xellId: mgrLive.id, by: 'test@human' });
  ok(delivered.delivered === true, `the live manager is reported as delivered (${delivered.delivery?.reason || 'sent'})`);
  // the write is awaited inside sendMessageToXell, so by here the cage has the file
  const dlog = ex(dockerLog) ? rf(dockerLog, 'utf8') : '';
  ok(/docker exec/.test(dlog), 'the delivery really ran a docker exec into the cage (not a constructed payload)');
  ok(/\.zee-inbox\/[^ ]*message\.md/.test(dlog),
     'writing .zee-inbox/<ts>/message.md — the file a manager is pointed at and actually reads');
  ok(dlog.includes(t1.code), `and the file that landed CARRIES THE CODE (${t1.code})`);
  ok(dlog.includes(`#${t1.number}`) && dlog.includes(edited.title),
     'with the number and the title, so the manager need not ask what it is about');
  ok(/NOTIFICATION, not an order/.test(dlog), 'and the not-an-order sentence survives into the cage');
  const liveBox = await M.inboxFor(mgrLive.id);
  ok(liveBox.length === 1 && liveBox[0].body.includes(t1.code),
     'and it is in the manager\'s inbox too — one notification, both doors');

  // ── 3c. A NOTIFICATION IS NOT AN ASSIGNMENT ──────────────────────────────
  // The constraint the ticket cares about most: telling a manager must not quietly cast work.
  section('notifying assigns nothing');
  const after = (await client.query(`SELECT status, assignee, work_item_id FROM ticket WHERE id=$1`, [t1.id])).rows[0];
  ok(after.status === edited.status, `the ticket's status is untouched (${after.status})`);
  ok(after.assignee === null && after.work_item_id === null, 'no assignee, no work item on the ticket');
  const items = (await client.query(`SELECT count(*)::int n FROM work_item WHERE ticket_id=$1`, [t1.id])).rows[0].n;
  ok(items === 0, 'and no work_item was created for it — a message is not a dispatch');
  const mgrXell = (await client.query(`SELECT status, zee_type FROM xell WHERE id=$1`, [mgrLive.id])).rows[0];
  ok(mgrXell.status === 'working' && mgrXell.zee_type === 'manager',
     "the manager's own xell is untouched too — still working, still a manager");

  // ── 4. the refusals ──────────────────────────────────────────────────────
  section('the refusals');
  const refusals = [
    [worker.id, 409, /not a manager/, 'a worker xell'],
    [mgrGone.id, 409, /retired/, 'a retired manager'],
    [mgrFar.id, 409, /another project/, "another project's manager"],
    ['00000000-0000-4000-8000-0000000016fe', 404, /no such xell/, 'an unknown xell'],
    ['not-a-uuid', 400, /valid/, 'a malformed xell id'],
    [null, 400, /xell_id required/, 'no xell at all'],
  ];
  for (const [xellId, status, re, what] of refusals) {
    const e = await caught(() => T.notifyManagerOfTicket(t1.id, { xellId }));
    ok(e && e.status === status && re.test(e.message),
       `${what} → ${status}: "${String(e?.message).slice(0, 70)}"`);
  }
  ok((await T.notifyManagerOfTicket('00000000-0000-4000-8000-0000000016ff', { xellId: mgrDark.id })) === null,
     'an unknown ticket is null (→ 404), not a message to nobody');
  // THREE notifications have succeeded by here: mgrDark (undeliverable, stored), mgrPane (no live
  // cxell), and mgrLive (section 3b, actually written into the cage). Every refusal above must have
  // added NOTHING to that — a refused notify is not a quiet half-send.
  const before = (await client.query(`SELECT count(*)::int n FROM zee_message WHERE project_id=$1`, [PID])).rows[0].n;
  ok(before === 3, `exactly ${before} messages exist — the three that were accepted, and nothing from any refusal`);

  // ── 5. the routes, over real HTTP ────────────────────────────────────────
  section('the routes');
  const { router } = await import('../server/src/api/routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, opts) => {
    const r = await fetch(base + path, opts);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const post = (path, payload) => call(path, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

  const rGet = await call(`/tickets/${t1.id}`);
  ok(rGet.status === 200 && rGet.body.code === t1.code, 'GET /tickets/:id carries the code the window copies');
  const rList = await call(`/tickets?project=${PID}`);
  ok(rList.body.every((x) => typeof x.code === 'string'), 'GET /tickets carries one on every row');
  const rMgrs = await call(`/tickets/${t1.id}/managers`);
  ok(rMgrs.status === 200 && rMgrs.body.count === 3, 'GET /tickets/:id/managers answers the picker');
  ok((await call(`/tickets/00000000-0000-4000-8000-0000000016ff/managers`)).status === 404,
     'and 404s an unknown ticket');
  const rNotify = await post(`/tickets/${t1.id}/notify`, { xell_id: mgrDark.id, by: 'test@route' });
  ok(rNotify.status === 200 && rNotify.body.delivered === false && rNotify.body.code === t1.code,
     'POST /tickets/:id/notify sends and reports the verdict');
  ok((await post(`/tickets/${t1.id}/notify`, {})).status === 400, 'no xell_id → 400');
  ok((await post(`/tickets/${t1.id}/notify`, { xell_id: worker.id })).status === 409, 'a worker → 409');
  const r404 = await post(`/tickets/00000000-0000-4000-8000-0000000016ff/notify`, { xell_id: mgrDark.id });
  ok(r404.status === 404 && /no such ticket/.test(r404.body?.error || ''), 'an unknown ticket → 404');

  // ── 6. THE HUMAN SURFACE: rendered, not read ─────────────────────────────
  // Two claims a human makes about this feature — "I can copy the code in one click" and "it tells
  // me when there is nobody to notify" — live in the JSX. Render the REAL components (esbuild +
  // react-dom/server) rather than grepping the file.
  section('the tickets window: the code is copyable, and an empty picker SAYS so');
  {
    const esbuild = await import('esbuild');
    const { createRequire } = await import('node:module');
    const out = join(tmp, 'tickets-bundle.cjs');
    // React and the renderer come OUT OF THE BUNDLE, not from this module: esbuild bundles its own
    // copy of react, and hooks called against a second copy throw "Invalid hook call". Same shape as
    // test/work-console.test.mjs.
    await esbuild.build({
      stdin: {
        contents: `
          const React = require('react');
          const { renderToStaticMarkup } = require('react-dom/server');
          const T = require('./Tickets.jsx');
          module.exports = { React, renderToStaticMarkup, TicketCode: T.TicketCode, NotifyManager: T.NotifyManager };`,
        resolveDir: join(ROOT, 'web/src/work'), loader: 'js',
      },
      bundle: true, format: 'cjs', platform: 'node', outfile: out, jsx: 'automatic',
      logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' },
    });
    const TK = createRequire(out)(out);
    const { React, renderToStaticMarkup } = TK;
    const code = renderToStaticMarkup(React.createElement(TK.TicketCode, { code: t1.code }));
    ok(code.includes(t1.code), 'the code is rendered as selectable text, not only inside a button');
    ok(/work-tcode/.test(code) && /<button/.test(code), 'with a one-click copy button beside it');
    ok(renderToStaticMarkup(React.createElement(TK.TicketCode, { code: null })) === '',
       'and a ticket without a code renders nothing rather than an empty chip');

    // the picker's empty state, over a stubbed fetch that answers the server's own sentence
    const realFetch = globalThis.fetch;
    const note = 'This project has no manager zee to notify — a human adds one from the console (POST /api/managers).';
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ managers: [], count: 0, note }),
      text: async () => JSON.stringify({ managers: [], count: 0, note }) });
    let empty;
    try { empty = renderToStaticMarkup(React.createElement(TK.NotifyManager, { ticketId: t1.id, onError: () => {} })); }
    finally { globalThis.fetch = realFetch; }
    ok(/notify manager/.test(empty), 'the Notify button is there on every ticket');
    ok(!/work-cand"/.test(empty), 'and it opens no manager list until a human asks for one');
  }
  // …and the ASK before it types into a running session, which is the repo's habit for anything
  // that reaches a live agent (WorkItemDrawer's delete, Gantt's remove, the ship confirm).
  {
    const src = (await import('node:fs')).readFileSync(join(ROOT, 'web/src/work/Tickets.jsx'), 'utf8');
    ok(src.includes('await showConfirm(') && src.includes('about this ticket?'),
       'notifying asks first, naming the manager — one stray click cannot interrupt a zee mid-turn');
    ok(/NOTIFICATION, not an assignment/.test(src),
       'and the confirmation says out loud that it assigns nothing');
  }

  await pool.end().catch(() => {});
} finally {
  if (server) await new Promise((r) => server.close(r));
  await cleanup({ files: true });
  await client.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);

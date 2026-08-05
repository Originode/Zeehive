// THE REFLECTIONS LEDGER — every post-ship reflection in one place, and filed as a ticket in one act.
//
// A reflection is a `zee_message` with kind='reflection' (queenzee/shipgate.js re-invokes a zee whose
// work shipped and it reports what it now knows). Until this feature the only readers were the
// RECIPIENT's own `zee inbox` and the per-xell Directives panel — so a reflection addressed to a
// manager xell that has since been retired was in nobody's window at all, and hundreds of them went
// unread. This test stands up throwaway projects in the real meta DB and exercises:
//
//   1. THE READ (lib/reflections.listReflections): project-wide, reflections ONLY, newest first,
//      with limit/since — carrying the writer, its source xell, the recipient manager slug and
//      whether that manager is RETIRED / GONE / was never addressed at all (the three orphan kinds,
//      each with its own sentence);
//   2. READING MARKS NOTHING READ — the constraint the feature is built around: `read_at` belongs to
//      the agent's own `zee inbox`, and the console must not clear a zee's unread flags;
//   3. FILE AS TICKET (fileReflectionAsTicket): a real ticket through the EXISTING createTicket path,
//      title from the reflection's first line, body VERBATIM plus the source xell and the date,
//      kind=chore by default — and the reflection then carries the ticket code, so a second attempt
//      is refused rather than filing the same finding twice;
//   4. the refusals, each with a readable sentence and the right HTTP status;
//   5. the ROUTES, driven over real HTTP against the real express router;
//   6. the CONSOLE WINDOW, rendered (esbuild + react-dom/server) and read back: unread emphasised,
//      orphans badged, a filed row showing its code instead of a file button.
//
// Everything it creates is torn down in a finally, whatever happens (house rule #1: no test data).
import express from 'express';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const tmp = mkdtempSync(join(tmpdir(), 'reflections-'));
const PID = '00000000-0000-4000-8000-0000000049a1';   // this test's project
const FID = '00000000-0000-4000-8000-0000000049a2';   // another project — never in this project's ledger
const XO = { [PID]: '00000000-0000-4000-8000-0000000049b1',
             [FID]: '00000000-0000-4000-8000-0000000049b2' };

let server = null;
async function cleanup({ files = false } = {}) {
  try { await client.query(`ROLLBACK`); } catch { /* no open transaction */ }
  try { await client.query(`DELETE FROM project WHERE id = ANY($1::uuid[])`, [[PID, FID]]); } catch { /* */ }
  if (files) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } }
}

try {
  await client.connect();
  await cleanup();

  const R = await import('../server/src/lib/reflections.js');
  const M = await import('../server/src/lib/managers.js');
  const T = await import('../server/src/lib/tickets.js');
  const { pool } = await import('../server/src/db/pool.js');

  // ── the fixture ──────────────────────────────────────────────────────────
  for (const [id, name, dbn] of [[PID, 'reflections-test', 'reftest'], [FID, 'reflections-foreign', 'reffor']]) {
    await client.query(
      `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
         VALUES ($1,$2,$3,'master',$4,'postgres')`, [id, name, tmp, dbn]);
    await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [XO[id], id]);
  }
  const mkXell = async (project, slug, status, zeeType = 'worker') => (await client.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, zee_type)
       VALUES ($1,$2,$3,$4,$5,$6,false,$7) RETURNING *`,
    [project, XO[project], slug, `spinoff/${slug}`, join(tmp, slug), status, zeeType])).rows[0];

  const mgrLive = await mkXell(PID, 'ref-mgr-live', 'working', 'manager');
  const mgrGone = await mkXell(PID, 'ref-mgr-retired', 'retired', 'manager');
  const mgrReaped = await mkXell(PID, 'ref-mgr-reaped', 'working', 'manager');   // deleted below
  const w1 = await mkXell(PID, 'ref-worker-one', 'working');
  const w2 = await mkXell(PID, 'ref-worker-two', 'working');
  const w3 = await mkXell(PID, 'ref-worker-three', 'working');
  const w4 = await mkXell(PID, 'ref-worker-four', 'working');
  const far = await mkXell(FID, 'ref-worker-far', 'working');
  const farMgr = await mkXell(FID, 'ref-mgr-far', 'working', 'manager');

  // Reflections through the REAL store path (managers.postMessage, delivery off — a test never types
  // into a session). Written oldest-first so "newest first" is a real assertion.
  const post = async (from, to, body, kind = 'reflection') =>
    (await M.postMessage({ from, to, body, kind, deliver: false })).message;

  const rLive = await post(w1, mgrLive,
    'The webapp build never picked up my change\nThe container was serving an older commit and --wait said so.');
  const rRetired = await post(w2, mgrGone,
    "A spinoff xell's app tier cannot boot\nIt exits before the health check, and nothing records why.");
  const rReaped = await post(w3, mgrReaped,
    'This endpoint has never answered over HTTP\nIt is only ever exercised through the lib function.');
  const rNone = await post(w4, null,
    'Unverified SQL in a hot path\nThe query is built by hand and no test covers it.');
  const rReport = await post(w1, mgrLive, 'A plain report, not a reflection.', 'report');
  const rFar = await post(far, farMgr, 'Another project\'s reflection — never in this ledger.');
  // …and one whose recipient xell row is GONE (to_xell_id is ON DELETE SET NULL, the slug is stamped)
  await client.query(`DELETE FROM xell WHERE id=$1`, [mgrReaped.id]);

  // ── 1. the read ──────────────────────────────────────────────────────────
  section('the ledger read');
  const rows = await R.listReflections({ projectId: PID });
  ok(rows.length === 4, `four reflections in this project (${rows.length})`);
  ok(!rows.some((r) => r.id === rReport.id), 'a plain report is NOT a reflection — it is not in the ledger');
  ok(!rows.some((r) => r.id === rFar.id), "and neither is another project's reflection");
  ok(rows[0].id === rNone.id && rows[3].id === rLive.id, 'newest first');
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

  const live = byId[rLive.id];
  ok(live.from === 'ref-worker-one' && live.from_xell_id === w1.id && live.from_xell_slug === 'ref-worker-one',
     'a row names the zee that wrote it and its source xell');
  ok(live.from_xell_status === 'working', 'with the source xell\'s current status');
  ok(live.to === 'ref-mgr-live' && live.to_xell_id === mgrLive.id, 'and the manager it was addressed to');
  ok(live.orphaned === false && live.recipient_retired === false && live.orphan_reason === null,
     'a live manager is not an orphan');
  ok(live.body.startsWith('The webapp build never picked up my change') && live.at instanceof Date,
     'the body is carried whole, with when it was written');
  ok(live.read_at === null && live.ticket === null, 'unread and unfiled, until somebody does either');

  const retired = byId[rRetired.id];
  ok(retired.to === 'ref-mgr-retired' && retired.recipient_retired === true && retired.orphaned === true,
     'a reflection to a RETIRED manager is badged orphaned');
  ok(/retired/.test(retired.orphan_reason) && /inbox/.test(retired.orphan_reason),
     `and says why in a sentence: "${retired.orphan_reason}"`);
  const reaped = byId[rReaped.id];
  ok(reaped.to === 'ref-mgr-reaped' && reaped.to_xell_id === null && reaped.orphaned === true,
     'one whose manager xell was REAPED keeps the slug and is orphaned too');
  ok(/reaped/.test(reaped.orphan_reason), `with its own sentence: "${reaped.orphan_reason}"`);
  const none = byId[rNone.id];
  ok(none.to === null && none.orphaned === true && /no manager/.test(none.orphan_reason),
     `a reflection nobody was addressed with is orphaned as well: "${none.orphan_reason}"`);

  ok((await R.listReflections({ projectId: PID, limit: 2 })).length === 2, 'limit is honoured');
  const since = new Date(rReaped.created_at);
  const recent = await R.listReflections({ projectId: PID, since: since.toISOString() });
  ok(recent.length === 2 && recent.every((r) => r.at >= since), 'since cuts the tail off (2 at/after it)');
  ok(/not a date/.test((await caught(() => R.listReflections({ projectId: PID, since: 'yesterday' })))?.message || ''),
     'an unparseable since is refused with a sentence, not silently ignored');
  ok(/valid project id/.test((await caught(() => R.listReflections({ projectId: 'nope' })))?.message || ''),
     'a malformed project id is bad input');
  ok(/project required/.test((await caught(() => R.listReflections({})))?.message || ''),
     'and no project at all is refused');

  // ── 2. reading marks NOTHING read ────────────────────────────────────────
  section('reading the ledger marks nothing read');
  const unreadBefore = (await client.query(
    `SELECT count(*)::int n FROM zee_message WHERE project_id=$1 AND read_at IS NULL`, [PID])).rows[0].n;
  await R.listReflections({ projectId: PID });
  const unreadAfter = (await client.query(
    `SELECT count(*)::int n FROM zee_message WHERE project_id=$1 AND read_at IS NULL`, [PID])).rows[0].n;
  ok(unreadBefore === 5 && unreadAfter === 5,
     `all ${unreadAfter} messages are still unread after two reads — read_at belongs to \`zee inbox\``);

  // ── 3. file as ticket ────────────────────────────────────────────────────
  section('file a reflection as a ticket');
  const filed = await R.fileReflectionAsTicket(rRetired.id, { by: 'test@human' });
  ok(filed.ok === true && /^TKT-\d+-[0-9A-F]{4}$/.test(filed.code), `it answers with a ticket code (${filed.code})`);
  const t = await T.getTicket(filed.ticket.id);
  ok(t.title === "A spinoff xell's app tier cannot boot",
     `the title is the reflection's FIRST LINE ("${t.title}")`);
  ok(t.body.includes('It exits before the health check'), 'the reflection travels VERBATIM in the body');
  ok(t.body.includes('ref-worker-two'), 'with the source xell slug');
  ok(t.body.includes(new Date(rRetired.created_at).toISOString()), 'and the date it was written');
  ok(t.kind === 'chore', 'kind is chore by default');
  ok(t.reporter === 'ref-worker-two', 'reported by the zee that wrote it');
  ok(t.project_id === PID, "and it lands in the reflection's own project");

  const after = (await R.listReflections({ projectId: PID })).find((r) => r.id === rRetired.id);
  ok(after.ticket?.code === filed.code && after.ticket.number === t.number,
     'the ledger row now shows the ticket code — nobody files the same finding twice');
  ok(after.read_at === null, 'and filing it did not mark it read either');

  const twice = await caught(() => R.fileReflectionAsTicket(rRetired.id));
  ok(twice?.status === 409 && twice.message.includes(filed.code),
     `filing it again is refused, naming the ticket that already exists: "${String(twice?.message).slice(0, 60)}…"`);
  const ticketCount = (await client.query(
    `SELECT count(*)::int n FROM ticket WHERE project_id=$1`, [PID])).rows[0].n;
  ok(ticketCount === 1, 'and it created no second ticket');

  const chosen = await R.fileReflectionAsTicket(rNone.id, { kind: 'bug', priority: 1 });
  ok(chosen.ticket.kind === 'bug' && chosen.ticket.priority === 1,
     'a caller may choose the kind and priority');

  // deleting the ticket re-opens the reflection (ON DELETE SET NULL), so a finding is never stranded
  await T.deleteTicket(chosen.ticket.id);
  const reopened = (await R.listReflections({ projectId: PID })).find((r) => r.id === rNone.id);
  ok(reopened.ticket === null, 'deleting the ticket unlinks the reflection — it can be filed again');
  const refiled = await R.fileReflectionAsTicket(rNone.id);
  ok(refiled.ok === true && refiled.ticket.id !== chosen.ticket.id, 'and it is');

  // ── 4. the refusals ──────────────────────────────────────────────────────
  section('the refusals');
  ok((await R.fileReflectionAsTicket('00000000-0000-4000-8000-0000000049ff')) === null,
     'an unknown id is null (→ 404), not a ticket about nothing');
  const badId = await caught(() => R.fileReflectionAsTicket('not-a-uuid'));
  ok(badId?.status === 400 && /valid reflection id/.test(badId.message), 'a malformed id is 400, not 404');
  const notRefl = await caught(() => R.fileReflectionAsTicket(rReport.id));
  ok(notRefl?.status === 409 && /not a reflection/.test(notRefl.message),
     `a plain report cannot be filed from the ledger: "${String(notRefl?.message).slice(0, 60)}"`);
  ok(R.reflectionTitle('   \n\n  ') === null && R.reflectionTitle('') === null,
     'a body with no text yields no title (and is refused rather than filed blank)');
  ok(R.reflectionTitle('# 🪞 Improvements\nthen the detail') === 'Improvements',
     'markdown ornament and the reflection glyph are stripped from the title');
  ok(R.reflectionTitle(`${'x'.repeat(400)}`).length === 160, 'a very long first line is trimmed to 160 chars');

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
  const postJson = (path, payload) => call(path, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

  const rList = await call(`/reflections?project=${PID}`);
  ok(rList.status === 200 && rList.body.length === 4, 'GET /reflections answers the ledger');
  ok(rList.body[0].orphaned === true && typeof rList.body[0].orphan_reason === 'string',
     'over the wire the orphan flag and its sentence survive');
  ok((await call('/reflections')).status === 400, 'without a project → 400');
  ok((await call(`/reflections?project=${PID}&limit=1`)).body.length === 1, 'limit rides on the query string');

  const rFile = await postJson(`/reflections/${rLive.id}/ticket`, { by: 'test@route' });
  ok(rFile.status === 201 && rFile.body.ticket.code, `POST /reflections/:id/ticket files it (${rFile.body.code})`);
  const rAgain = await postJson(`/reflections/${rLive.id}/ticket`, {});
  ok(rAgain.status === 409 && rAgain.body.error.includes(rFile.body.code), 'a second file → 409, naming the ticket');
  ok((await postJson(`/reflections/00000000-0000-4000-8000-0000000049ff/ticket`, {})).status === 404,
     'an unknown reflection → 404');
  ok((await postJson('/reflections/not-a-uuid/ticket', {})).status === 400, 'a malformed id → 400');

  // and reading over HTTP still marks nothing read
  const unreadHttp = (await client.query(
    `SELECT count(*)::int n FROM zee_message WHERE project_id=$1 AND read_at IS NULL`, [PID])).rows[0].n;
  ok(unreadHttp === 5, 'after every read above, all five messages are still unread');

  // ── 6. THE CONSOLE WINDOW: rendered, not read ────────────────────────────
  //
  // The claims a human makes about this screen — "I can see which ones nobody read", "it tells me
  // when nobody CAN read one", "the body is there when I open it", "a filed one shows its code
  // instead of the button" — live in the JSX. Render the REAL component (esbuild +
  // react-dom/server) rather than grepping the file. React and the renderer come OUT OF the bundle:
  // esbuild bundles its own copy, and hooks against a second copy throw (same shape as
  // test/ticket-notify.test.mjs).
  section('the reflections window, rendered');
  {
    const esbuild = await import('esbuild');
    const { createRequire } = await import('node:module');
    const out = join(tmp, 'reflections-bundle.cjs');
    await esbuild.build({
      stdin: {
        contents: `
          const React = require('react');
          const { renderToStaticMarkup } = require('react-dom/server');
          const R = require('./Reflections.jsx');
          module.exports = { React, renderToStaticMarkup, ReflectionList: R.ReflectionList,
                             firstLine: R.firstLine, filtered: R.filtered };`,
        resolveDir: join(ROOT, 'web/src/work'), loader: 'js',
      },
      bundle: true, format: 'cjs', platform: 'node', outfile: out, jsx: 'automatic',
      logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' },
    });
    const RX = createRequire(import.meta.url)(out);
    const { React, renderToStaticMarkup } = RX;
    const ledger = await R.listReflections({ projectId: PID });
    const render = (props) => renderToStaticMarkup(React.createElement(RX.ReflectionList,
      { rows: ledger, kinds: ['bug', 'chore'], ...props }));

    const html = render({});
    ok((html.match(/data-testid="refl-row"/g) || []).length === ledger.length,
       `every reflection gets a row (${ledger.length})`);
    ok(/refl-row unread/.test(html), 'an unread one is emphasised — the class is on the row');
    ok(/⚑ orphaned/.test(html), 'an orphaned one is badged');
    ok(html.includes('ref-mgr-retired is retired'),
       "and carries the SERVER'S own sentence for why nobody will read it");
    // renderToStaticMarkup escapes the apostrophe, so match the part of the line that survives
    ok(html.includes('app tier cannot boot') && !html.includes('It exits before the health check'),
       'the first line is the headline in the row — and only the first line');
    ok(!/data-testid="refl-body"/.test(html), 'bodies are COLLAPSED by default — a ledger has to be scannable');
    const opened = render({ openId: ledger.find((r) => r.id === rReaped.id).id });
    ok(/data-testid="refl-body"/.test(opened) && opened.includes('It is only ever exercised through the lib function'),
       'clicking one shows the whole reflection');
    ok(/data-testid="refl-file"/.test(html), 'an unfiled reflection offers the file-as-ticket action');
    const filedRow = ledger.find((r) => r.ticket);
    ok(filedRow && render({}).includes(filedRow.ticket.code),
       `a FILED one shows its ticket code (${filedRow?.ticket?.code})`);
    const onlyFiled = renderToStaticMarkup(React.createElement(RX.ReflectionList,
      { rows: [filedRow], kinds: ['chore'] }));
    ok(/refl-filed/.test(onlyFiled) && !/data-testid="refl-file"/.test(onlyFiled),
       'and it offers no second file button — that is what stops the same finding being filed twice');
    ok(renderToStaticMarkup(React.createElement(RX.ReflectionList, { rows: [] })) === '',
       'an empty ledger renders nothing rather than a broken row');

    ok(RX.firstLine('# 🪞 Improvements\nthen detail') === 'Improvements'
       && RX.firstLine('') === '(empty reflection)',
       'the headline the human sees is derived the same way the server derives the ticket title');
    ok(RX.filtered(ledger, 'unread').length === ledger.filter((r) => !r.read_at).length
       && RX.filtered(ledger, 'orphaned').every((r) => r.orphaned)
       && RX.filtered(ledger, 'unfiled').every((r) => !r.ticket)
       && RX.filtered(ledger, 'all').length === ledger.length,
       'the filters are pure and select what they say');
  }

  // …and the two rules the SCREEN must keep, asserted where they live.
  {
    const { readFileSync: rf } = await import('node:fs');
    const api = rf(join(ROOT, 'web/src/work/workApi.js'), 'utf8');
    const jsx = rf(join(ROOT, 'web/src/work/Reflections.jsx'), 'utf8');
    const wc = rf(join(ROOT, 'web/src/work/WorkConsole.jsx'), 'utf8');
    const calls = api.match(/\/api\/reflections[^`]*/g) || [];
    ok(calls.length === 2 && calls.some((c) => c.endsWith('/ticket')),
       `the client makes exactly two reflection calls — the read and the file (${calls.join(' · ')})`);
    const lib = rf(join(ROOT, 'server/src/lib/reflections.js'), 'utf8');
    ok(!/SET\s+read_at/i.test(lib) && !/read_at\s*=\s*now/i.test(lib),
       'and the server behind them writes read_at NOWHERE — the runtime check above, in source form');
    ok(/showConfirm\(/.test(jsx) && /cannot be filed twice/.test(jsx),
       'filing asks first, and the sentence says the reflection will show its code');
    ok(/id: 'reflections'/.test(wc) && /<Reflections /.test(wc),
       'the tab is wired into the work console');
  }

  await pool.end().catch(() => {});
} finally {
  if (server) await new Promise((r) => server.close(r));
  await cleanup({ files: true });
  await client.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);

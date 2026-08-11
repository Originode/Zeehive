// THE EXTERNAL TICKETING API (migration 190) — a deployed project files, monitors and updates its
// own tickets, with the evidence attached.
//
// The feature: omnibiz runs on somebody else's server, holds a per-project key, and POSTs to
// /api/ext/v1/tickets. What lands is an ORDINARY ticket on the omnibiz board in ZEEHIVE, which a
// zee then breaks down and works on; the integration watches the same ticket move. This test
// stands up two isolated throwaway projects in the database it is pointed at and drives the whole
// surface over real HTTP against the real express router:
//
//   1. THE KEY: minted once with the plaintext returned exactly once, listed masked afterwards,
//      and revocable. A key that filed tickets refuses to be DELETED (the board must keep being
//      able to say where those tickets came from) and is revoked instead;
//   2. THE DOOR: no key → 401, a string that is not a key → 401, an unknown key → 401, a REVOKED
//      key → 401, a live key without the scope → 403, and a body that names a project → 400 (it is
//      refused rather than ignored, because a caller that thinks it chose a project will one day
//      be surprised);
//   3. FILING: the ticket is a real `ticket` row in the KEY's project — provenance stamped
//      (source, external_ref, api_key_id), numbered by the same trigger, visible to the console's
//      own read models;
//   4. IDEMPOTENCY: the same external_ref POSTed twice is ONE ticket (200 + deduped), a different
//      ref is a second one, and a POST with no ref says out loud that it is not idempotent;
//   5. ATTACHMENTS: a png (base64) and a json/xml/txt log (utf8 text) ride in with the ticket and
//      come back out of the download route BYTE-IDENTICAL with a matching sha256; the refusals —
//      an unaccepted content type, an oversize file, invalid base64, an empty one — are each named,
//      and a rejected attachment never costs the caller its ticket;
//   6. MONITORING: GET by uuid, by code (TKT-n-xxxx) and by #number, carrying comments, attachment
//      metadata and what the FLEET is doing (the work items a breakdown created, with progress);
//   7. UPDATING: the reporter owns the intake (title/body/priority/labels/kind/external_url) and
//      may cancel and reopen — and may NOT set `working`/`done` or reassign, each refused with a
//      sentence that says where that belongs instead;
//   8. ISOLATION: a key reaches ONLY its own project — another project's ticket is a 404 by id, by
//      number and by attachment, never a read;
//   9. THE CONSOLE SIDE: GET /tickets/:id carries the attachment metadata (never the bytes), the
//      download and delete routes work, and the same rows are what the external caller wrote.
//
// Everything it creates is torn down in a finally, whatever happens (house rule #1: no test data).
//
//   DATABASE_URL=… node test/ticket-api-external.test.mjs
//
// In a cxell that is `zee db-sandbox --migrate`'s DSN — this test WRITES, so never point it at a
// database whose rows matter.
import express from 'express';
import http from 'node:http';
import { createHash } from 'node:crypto';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

const client = new pg.Client({ connectionString: url });
const PID = '00000000-0000-4000-8000-000000019001';   // "the deployed project" (omnibiz stand-in)
const OTHER = '00000000-0000-4000-8000-000000019002'; // a second project the key must never reach

// a real 1x1 png, so the round trip is over bytes a caller would actually send
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const LOG_TEXT = '2026-08-11T05:00:00Z ERROR OrderService: payment gateway timeout\n  at pay (order.js:42)\n';
const XML_TEXT = '<?xml version="1.0"?><report><fault code="504">gateway timeout</fault></report>';

let server = null;

async function cleanup() {
  try { await client.query(`DELETE FROM project WHERE id = ANY($1::uuid[])`, [[PID, OTHER]]); } catch { /* */ }
}

try {
  await client.connect();
  await cleanup();
  await client.query(`INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'ticket-api-test','/tmp/ticket-api-test','master')`, [PID]);
  await client.query(`INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'ticket-api-other','/tmp/ticket-api-other','master')`, [OTHER]);

  const { router } = await import('../server/src/api/routes.js');
  const { pool } = await import('../server/src/db/pool.js');
  const app = express();
  app.use(express.json({ limit: '30mb' }));
  app.use('/api', router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const call = async (path, { method = 'GET', key = null, body = null, raw = false } = {}) => {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (key) headers.Authorization = `Bearer ${key}`;
    const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (raw) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), headers: r.headers };
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // ── 1: the key ───────────────────────────────────────────────────────────
  section('the key: minted once, masked ever after, revocable');
  const minted = await call(`/projects/${PID}/api-keys`, { method: 'POST',
    body: { label: 'omnibiz helpdesk', by: 'test@console' } });
  const KEY = minted.body?.key;
  ok(minted.status === 201 && typeof KEY === 'string' && KEY.startsWith('zhk_') && KEY.length > 40,
     `POST /projects/:id/api-keys mints a key (${String(KEY).slice(0, 8)}…)`);
  const listed = await call(`/projects/${PID}/api-keys`);
  ok(listed.status === 200 && listed.body.length === 1 && !('key' in listed.body[0])
     && !('key_hash' in listed.body[0]) && /^zhk_.+…/.test(listed.body[0].key_hint),
     'the list carries the HINT and never the key or its hash');
  const stored = (await client.query(`SELECT key_hash FROM project_api_key WHERE project_id=$1`, [PID])).rows[0];
  ok(stored.key_hash === createHash('sha256').update(KEY).digest('hex'),
     'only the sha256 hash is stored — the plaintext exists nowhere in the database');
  const readOnly = await call(`/projects/${PID}/api-keys`, { method: 'POST',
    body: { label: 'read-only monitor', scopes: ['tickets:read'] } });
  const RKEY = readOnly.body?.key;
  ok(readOnly.status === 201 && readOnly.body.scopes.join() === 'tickets:read', 'scopes are per key');
  const badScope = await call(`/projects/${PID}/api-keys`, { method: 'POST',
    body: { label: 'nope', scopes: ['tickets:destroy'] } });
  ok(badScope.status === 400 && /unknown scope/.test(badScope.body.error), 'an unknown scope → 400');
  const noLabel = await call(`/projects/${PID}/api-keys`, { method: 'POST', body: {} });
  ok(noLabel.status === 400 && /label required/.test(noLabel.body.error), 'a key with no label → 400');
  const otherMint = await call(`/projects/${OTHER}/api-keys`, { method: 'POST', body: { label: 'other side' } });
  const OKEY = otherMint.body?.key;

  // ── 2: the door ──────────────────────────────────────────────────────────
  section('the door: every refusal says WHICH');
  const noKey = await call('/ext/v1/whoami');
  ok(noKey.status === 401 && /no API key/.test(noKey.body.error), 'no key → 401');
  const notAKey = await call('/ext/v1/whoami', { key: 'hunter2' });
  ok(notAKey.status === 401 && /start with "zhk_"/.test(notAKey.body.error), 'not a key shape → 401 saying so');
  const unknown = await call('/ext/v1/whoami', { key: `zhk_${'a'.repeat(64)}` });
  ok(unknown.status === 401 && /identifies no project/.test(unknown.body.error), 'unknown key → 401');
  const who = await call('/ext/v1/whoami', { key: KEY });
  ok(who.status === 200 && who.body.project.id === PID && who.body.key.label === 'omnibiz helpdesk'
     && who.body.attachments.max_attachment_bytes === 10 * 1024 * 1024
     && who.body.settable_statuses.join() === 'queued,cancelled',
     'whoami names the project the key files into, its scopes and the limits');
  const wrongScope = await call('/ext/v1/tickets', { method: 'POST', key: RKEY, body: { title: 'nope' } });
  ok(wrongScope.status === 403 && /tickets:write/.test(wrongScope.body.error),
     'a read-only key filing a ticket → 403 naming the missing scope');
  const namedProject = await call('/ext/v1/tickets', { method: 'POST', key: KEY,
    body: { title: 'x', project: OTHER } });
  ok(namedProject.status === 400 && /do not send a project/.test(namedProject.body.error),
     'a body that names a project → 400 (refused, not ignored)');
  const limits = await call('/ext/v1/limits');
  ok(limits.status === 200 && limits.body.attachments.content_types.includes('application/json'),
     'GET /ext/v1/limits answers without a key at all');

  // ── 3 + 5: filing, with the evidence ─────────────────────────────────────
  section('filing a ticket with its evidence');
  const filed = await call('/ext/v1/tickets', { method: 'POST', key: KEY, body: {
    title: 'Checkout 504s on payment', body: 'Every third order fails at the gateway.',
    kind: 'bug', priority: 1, external_ref: 'OMNI-4471', external_url: 'https://omnibiz.example/desk/4471',
    reporter: 'desk@omnibiz', labels: ['checkout', 'p1'],
    attachments: [
      { filename: 'screenshot.png', content_base64: PNG_B64 },
      { filename: 'order-service.log', text: LOG_TEXT },
      { filename: 'gateway.xml', content_type: 'text/xml', text: XML_TEXT },
      { filename: 'core.dump', content_type: 'application/octet-stream', text: 'nope' },
    ],
  } });
  ok(filed.status === 201 && filed.body.code?.startsWith('TKT-') && filed.body.status === 'queued'
     && filed.body.priority === 1 && filed.body.deduped === false,
     `POST files it: ${filed.body.code} — ${filed.body.title}`);
  ok(filed.body.attachments.length === 3 && filed.body.attachments_rejected?.length === 1
     && /not an accepted attachment type/.test(filed.body.attachments_rejected[0].error),
     'three attachments stored, the octet-stream named as rejected — and the TICKET still exists');
  const kinds = filed.body.attachments.map((a) => `${a.filename}:${a.kind}`).sort().join(' ');
  ok(kinds === 'gateway.xml:data order-service.log:log screenshot.png:image',
     `each attachment carries its class — ${kinds}`);
  const row = (await client.query(
    `SELECT t.*, k.label FROM ticket t JOIN project_api_key k ON k.id=t.api_key_id WHERE t.id=$1`,
    [filed.body.id])).rows[0];
  ok(row.project_id === PID && row.source === 'api:omnibiz helpdesk' && row.external_ref === 'OMNI-4471'
     && row.label === 'omnibiz helpdesk' && row.number >= 1,
     'the row is an ORDINARY ticket in the key\'s project, provenance stamped');

  // ── 4: idempotency ───────────────────────────────────────────────────────
  section('a retry is the same ticket');
  const retry = await call('/ext/v1/tickets', { method: 'POST', key: KEY, body: {
    title: 'Checkout 504s on payment', external_ref: 'OMNI-4471' } });
  ok(retry.status === 200 && retry.body.deduped === true && retry.body.id === filed.body.id,
     'the same external_ref → 200 + deduped, the SAME ticket id');
  const second = await call('/ext/v1/tickets', { method: 'POST', key: KEY, body: {
    title: 'Search returns 500 for empty query', external_ref: 'OMNI-4472', kind: 'bug' } });
  ok(second.status === 201 && second.body.id !== filed.body.id, 'a different ref → a second ticket');
  const noRef = await call('/ext/v1/tickets', { method: 'POST', key: KEY, body: { title: 'no ref here' } });
  ok(noRef.status === 201 && /NOT idempotent/.test(noRef.body.note || ''),
     'no external_ref → filed, with a note saying a retry would duplicate it');
  const counted = (await client.query(`SELECT count(*)::int n FROM ticket WHERE project_id=$1`, [PID])).rows[0].n;
  ok(counted === 3, `exactly ${counted} tickets exist — the retry filed nothing`);
  const preset = await call('/ext/v1/tickets', { method: 'POST', key: KEY,
    body: { title: 'x', status: 'working' } });
  ok(preset.status === 409 && /always starts queued/.test(preset.body.error),
     'a caller cannot file a ticket already "working" → 409');

  // ── 5b: the bytes come back byte-identical ───────────────────────────────
  section('the evidence round-trips');
  const png = filed.body.attachments.find((a) => a.kind === 'image');
  const dl = await call(png.download_url.replace('/api', ''), { key: KEY, raw: true });
  const sent = Buffer.from(PNG_B64, 'base64');
  ok(dl.status === 200 && dl.buf.equals(sent), `the png comes back byte-identical (${dl.buf.length} bytes)`);
  ok(dl.headers.get('content-type') === 'image/png'
     && /^attachment;/.test(dl.headers.get('content-disposition') || '')
     && dl.headers.get('x-content-type-options') === 'nosniff',
     'served as a DOWNLOAD with nosniff — never inline in this origin');
  ok(dl.headers.get('x-attachment-sha256') === createHash('sha256').update(sent).digest('hex')
     && png.sha256 === createHash('sha256').update(sent).digest('hex'),
     'the sha256 the API reported is the sha256 of what came back');
  const logDl = await call(`/ext/v1/tickets/${filed.body.id}/attachments/`
    + `${filed.body.attachments.find((a) => a.kind === 'log').id}`, { key: KEY, raw: true });
  ok(logDl.buf.toString('utf8') === LOG_TEXT, 'a text log round-trips through `text` unchanged');

  section('attachment refusals');
  const tooBig = await call(`/ext/v1/tickets/${filed.body.id}/attachments`, { method: 'POST', key: KEY,
    body: { filename: 'huge.log', text: 'x'.repeat(10 * 1024 * 1024 + 1) } });
  ok(tooBig.status === 409 && /the limit is 10485760/.test(tooBig.body.error), 'an 11 MB log → 409 naming the cap');
  const notB64 = await call(`/ext/v1/tickets/${filed.body.id}/attachments`, { method: 'POST', key: KEY,
    body: { filename: 'x.png', content_base64: 'this is not base64!!' } });
  ok(notB64.status === 400 && /not valid base64/.test(notB64.body.error),
     'raw text in content_base64 → refused, not silently corrupted');
  const empty = await call(`/ext/v1/tickets/${filed.body.id}/attachments`, { method: 'POST', key: KEY,
    body: { filename: 'x.txt', text: '' } });
  ok(empty.status === 400 && /empty/.test(empty.body.error), 'an empty attachment → 400');
  const noType = await call(`/ext/v1/tickets/${filed.body.id}/attachments`, { method: 'POST', key: KEY,
    body: { filename: 'mystery', text: 'hi' } });
  ok(noType.status === 400 && /content_type/.test(noType.body.error), 'no type and no known extension → 400');

  // ── 6: monitoring ────────────────────────────────────────────────────────
  section('monitoring: by id, by code, by number — and what the fleet is doing');
  const T = await import('../server/src/lib/tickets.js');
  await T.breakdownTicket(filed.body.id, { actor: 'test', items: [
    { title: 'Reproduce the gateway timeout', kind: 'activity', ref: 'act' },
    { title: 'Add a retry with backoff', kind: 'task', parent_id: 'act' },
  ] });
  await client.query(`UPDATE work_item SET status='working', progress=40 WHERE ticket_id=$1 AND kind='task'`,
                     [filed.body.id]);
  for (const [handle, what] of [[filed.body.id, 'uuid'], [filed.body.code, 'code'], [`#${row.number}`, 'ref']]) {
    const got = await call(`/ext/v1/tickets/${encodeURIComponent(handle)}`, { key: KEY });
    ok(got.status === 200 && got.body.id === filed.body.id, `GET by ${what} (${handle}) finds it`);
  }
  const mon = (await call(`/ext/v1/tickets/${filed.body.id}`, { key: KEY })).body;
  ok(mon.work.count === 2 && mon.work.open === 2
     && mon.work.items.some((w) => w.status === 'working' && w.progress === 40),
     'the answer says what the FLEET is doing — items, statuses and progress');
  ok(mon.status === 'assigned' && mon.attachments.length === 3 && mon.attachments[0].download_url.startsWith('/api/ext/v1/'),
     'and the ticket itself moved out of queued when a zee broke it down');
  ok(!('api_key_id' in mon) && !('xell_id' in mon) && !JSON.stringify(mon).includes('xell'),
     'the external shape carries no internal identifiers');
  const list = await call('/ext/v1/tickets?kind=bug', { key: KEY });
  ok(list.status === 200 && list.body.count === 3 && list.body.tickets.every((t) => t.kind === 'bug')
     && !('comments' in list.body.tickets[0]) && !('attachments' in list.body.tickets[0]),
     'the list filters, and carries no comment/attachment payloads');
  const byRef = await call('/ext/v1/tickets?external_ref=OMNI-4472', { key: KEY });
  ok(byRef.body.count === 1 && byRef.body.tickets[0].external_ref === 'OMNI-4472',
     'a caller can find its ticket by ITS OWN id');
  const missing = await call(`/ext/v1/tickets/${encodeURIComponent('#9999')}`, { key: KEY });
  ok(missing.status === 404, 'a number that names nothing → 404');

  // ── 7: updating, and the conversation ────────────────────────────────────
  section('the reporter owns the intake, the fleet owns the work');
  const patched = await call(`/ext/v1/tickets/${filed.body.id}`, { method: 'PATCH', key: KEY,
    body: { priority: 2, labels: ['checkout'], body: 'Now one order in five.',
            external_url: 'https://omnibiz.example/desk/4471?tab=logs' } });
  ok(patched.status === 200 && patched.body.priority === 2 && patched.body.body === 'Now one order in five.'
     && patched.body.external_url.endsWith('tab=logs'), 'PATCH updates what the reporter reported');
  const claimWorking = await call(`/ext/v1/tickets/${filed.body.id}`, { method: 'PATCH', key: KEY,
    body: { status: 'working' } });
  ok(claimWorking.status === 409 && /only the fleet makes it/.test(claimWorking.body.error),
     'a helpdesk cannot declare the ticket "working" → 409');
  const claimAssignee = await call(`/ext/v1/tickets/${filed.body.id}`, { method: 'PATCH', key: KEY,
    body: { assignee: 'somebody' } });
  ok(claimAssignee.status === 409 && /not yours to set from outside/.test(claimAssignee.body.error),
     'nor set an assignee → 409 saying what it may edit');
  const cancelled = await call(`/ext/v1/tickets/${second.body.id}`, { method: 'PATCH', key: KEY,
    body: { status: 'cancelled' } });
  ok(cancelled.status === 200 && cancelled.body.status === 'cancelled' && cancelled.body.closed_at,
     'it MAY withdraw what it filed');
  const reopened = await call(`/ext/v1/tickets/${second.body.id}`, { method: 'PATCH', key: KEY,
    body: { status: 'queued' } });
  ok(reopened.body.status === 'queued' && !reopened.body.closed_at, 'and reopen it');

  const commented = await call(`/ext/v1/tickets/${filed.body.id}/comments`, { method: 'POST', key: KEY,
    body: { author: 'desk@omnibiz', body: 'Customer sent the har file.',
            attachments: [{ filename: 'session.har', text: '{"log":{"entries":[]}}' }] } });
  ok(commented.status === 201 && commented.body.attachments.length === 1, 'a comment can carry evidence');
  const stamped = (await client.query(
    `SELECT comment_id FROM ticket_attachment WHERE id=$1`, [commented.body.attachments[0].id])).rows[0];
  ok(stamped.comment_id === commented.body.comment.id, 'that evidence is stamped with ITS comment');
  const after = (await call(`/ext/v1/tickets/${filed.body.id}`, { key: KEY })).body;
  ok(after.comments.length === 1 && after.attachments.length === 4, 'and both show up on the next read');

  // ── 8: isolation ─────────────────────────────────────────────────────────
  section('a key reaches only its own project');
  const theirs = await call('/ext/v1/tickets', { method: 'POST', key: OKEY,
    body: { title: 'their own ticket', external_ref: 'OTHER-1' } });
  ok(theirs.status === 201 && theirs.body.id !== filed.body.id, 'the other project files its own');
  const reach = await call(`/ext/v1/tickets/${theirs.body.id}`, { key: KEY });
  ok(reach.status === 404, 'our key cannot READ their ticket by id → 404 (not 403 — no probing)');
  const reachPatch = await call(`/ext/v1/tickets/${theirs.body.id}`, { method: 'PATCH', key: KEY,
    body: { priority: 5 } });
  ok(reachPatch.status === 404, 'nor patch it');
  const theirList = await call('/ext/v1/tickets', { key: OKEY });
  ok(theirList.body.count === 1, 'and a list is only ever its own project\'s');
  const crossAttach = await call(`/ext/v1/tickets/${filed.body.id}/attachments/${png.id}`, { key: OKEY });
  ok(crossAttach.status === 404, 'an attachment of another project\'s ticket is a 404');
  const revoked = await call(`/projects/${PID}/api-keys/${readOnly.body.id}/revoke`, { method: 'POST', body: {} });
  ok(revoked.status === 200 && revoked.body.revoked === true, 'a key can be revoked');
  const afterRevoke = await call('/ext/v1/whoami', { key: RKEY });
  ok(afterRevoke.status === 401 && /revoked/.test(afterRevoke.body.error), 'and stops working immediately');
  const delUsed = await call(`/projects/${PID}/api-keys/${minted.body.id}`, { method: 'DELETE' });
  ok(delUsed.status === 409 && /revoke it instead/.test(delUsed.body.error),
     'a key that FILED tickets refuses to be deleted');

  // ── 9: the console side ──────────────────────────────────────────────────
  section('the console reads the same rows');
  const consoleGet = await call(`/tickets/${filed.body.id}`);
  ok(consoleGet.status === 200 && consoleGet.body.attachments.length === 4
     && !('content' in consoleGet.body.attachments[0]) && consoleGet.body.source === 'api:omnibiz helpdesk'
     && consoleGet.body.external_ref === 'OMNI-4471',
     'GET /tickets/:id carries the attachment METADATA and the provenance, never the bytes');
  const consoleDl = await call(`/tickets/${filed.body.id}/attachments/${png.id}`, { raw: true });
  ok(consoleDl.status === 200 && consoleDl.buf.equals(sent), 'the console download serves the same bytes');
  const consoleUp = await call(`/tickets/${filed.body.id}/attachments`, { method: 'POST',
    body: { filename: 'triage.txt', text: 'reproduced on staging', uploaded_by: 'mark@console' } });
  ok(consoleUp.status === 201 && consoleUp.body.source === 'console', 'a human can attach from the console too');
  const consoleDel = await call(`/tickets/${filed.body.id}/attachments/${consoleUp.body.id}`, { method: 'DELETE' });
  ok(consoleDel.status === 200 && consoleDel.body.ok, 'and delete one');
  const left = (await client.query(
    `SELECT count(*)::int n FROM ticket_attachment WHERE ticket_id=$1`, [filed.body.id])).rows[0].n;
  ok(left === 4, `${left} attachments remain — the deleted one is gone, the rest untouched`);

  await pool.end().catch(() => {});
} catch (err) {
  console.error('\n✗ FAIL (threw):', err?.stack || err);
  fail++;
} finally {
  if (server) await new Promise((r) => server.close(r));
  await cleanup();
  await client.end().catch(() => {});
}

console.log(fail ? `\n✗ ${fail} failure(s)` : '\n✓ all good');
process.exit(fail ? 1 : 0);

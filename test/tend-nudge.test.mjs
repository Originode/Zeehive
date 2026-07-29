// THE TEND NUDGE — an ANSWERED ask must not dangle unnoticed (ticket #18).
//
// THE FAILURE THIS PINS: a zee raised a tend at 17:09 asking a human a question; the human answered
// it at 17:10 (a zee_message arrived); the tend stayed up for the best part of an hour — because
// answering a zee's ask and lowering the flag it raised are two separate acts, and neither party
// did the second one. An open tend outranks awaiting-done in the hive derivation, so the
// already-answered ask sat on the console next to real tends, teaching humans to skim.
//
// THE MECHANISM (a sentence in the manual demonstrably did not work — the zee that wrote "always
// check if your tend is still relevant" into the manual is the zee that left one dangling): when a
// zee runs a self verb while its tend is OPEN and a zee_message to it arrived SINCE the tend was
// raised (created_at > tendState.at), the verb's answer carries ONE line on a stable field,
// `tend_nudge` — naming the age of the ask and the fact of the reply. NOTHING is auto-cleared: a
// tend is the zee's own statement, and only the zee (or its own working ping) lowers it.
//
// Exercised against the real lib + self verbs on the throwaway DATABASE_URL: an isolated project /
// xell / zee is stood up, tends raised with the real setTend, replies inserted as real zee_message
// rows, and everything torn down in the finally.
import pg from 'pg';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
const client = new pg.Client({ connectionString: url });

const PID = '00000000-0000-4000-8000-000000dd1001';
const XOID = '00000000-0000-4000-8000-000000dd1002';
const XID = '00000000-0000-4000-8000-000000dd1003';

async function cleanup() {
  try {
    await client.query(`DELETE FROM session_event WHERE xell_id=$1`, [XID]);
    await client.query(`DELETE FROM project WHERE id=$1`, [PID]);
  } catch { /* */ }
}

// Shift ALL of the xell's session events back by `mins` minutes — the tend just raised becomes
// `mins` old while every event keeps its relative order (tendState is latest-event-wins, so
// backdating only one row could push it behind an earlier clear). Lets "a reply since" and the
// age line be asserted without sleeping in the test.
const backdateEvents = (mins) => client.query(
  `UPDATE session_event SET ts = ts - ($2 || ' minutes')::interval WHERE xell_id=$1`, [XID, mins]);

const reply = (body, { at = 'now()', from = 'swift-ridge-mgr' } = {}) => client.query(
  `INSERT INTO zee_message (project_id, from_slug, to_xell_id, to_slug, kind, body, created_at)
     VALUES ($1, $2, $3, 'tendnudge-x', 'message', $4, ${at})`, [PID, from, XID, body]);

try {
  await client.connect();
  await cleanup();
  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'tendnudge-test','/tmp/tendnudge','master')`, [PID]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [XOID, PID]);
  await client.query(
    `INSERT INTO xell (id, project_id, xource_id, slug, branch, worktree_path, status, is_pooled)
       VALUES ($1,$2,$3,'tendnudge-x','spinoff/tendnudge-x','/tmp/tendnudge-x','claimed',false)`, [XID, PID, XOID]);
  await client.query(
    `INSERT INTO zee (xell_id, attach_mode, status) VALUES ($1,'headless-spawn','working')`, [XID]);
  const xellRow = async () => (await client.query(`SELECT * FROM xell WHERE id=$1`, [XID])).rows[0];

  const { setTend, tendState, tendNudge } = await import('../server/src/lib/status.js');
  const { selfStatus, selfWorking, selfTend, selfInbox } = await import('../server/src/queenzee/self.js');

  // ── (c) no tend at all → nothing to say ──
  console.log('\n── no tend → no nudge ──');
  ok(await tendNudge(XID) === null, 'tendNudge is null when the xell has never tended');
  await reply('a message with no tend open at all');
  ok(await tendNudge(XID) === null, '…and a message alone (no open tend) says nothing');
  ok((await selfStatus(await xellRow())).tend_nudge === null, '`zee status` carries tend_nudge: null');
  await client.query(`DELETE FROM zee_message WHERE to_xell_id=$1`, [XID]);

  // ── (b) open tend, NO later message → no nudge ──
  console.log('\n── open tend, no reply since → no nudge ──');
  await setTend(XID, true, { reason: 'is the orders table prod-only? which db should I migrate?' });
  await backdateEvents(10);
  ok((await tendState(XID)).open === true, 'the tend is open');
  ok(await tendNudge(XID) === null, 'no reply since it was raised → nudge is null');

  // ── (d) a message from BEFORE the tend was raised does not count as a reply ──
  console.log('\n── a message BEFORE the tend is not a reply to it ──');
  await reply('old directive from before the ask', { at: `now() - interval '30 minutes'` });
  ok(await tendNudge(XID) === null, 'a zee_message older than the tend does not trigger the nudge');
  ok((await selfStatus(await xellRow())).tend_nudge === null, '`zee status` still carries null');

  // ── (a) open tend + a reply SINCE → the one-line nudge ──
  console.log('\n── open tend + reply since → the nudge ──');
  await reply('answered: orders is prod-only, migrate nothing — use the lookup view');
  const line = await tendNudge(XID);
  ok(typeof line === 'string' && line.length > 0, `the nudge is a non-empty line ("${line}")`);
  ok(/still open/i.test(line), 'it says the tend is still open');
  ok(/raised 10 min ago/.test(line), 'it names the AGE of the ask (10 min, computed from tendState.at)');
  ok(/reply since/.test(line) && /swift-ridge-mgr/.test(line), 'it names the reply (and who it came from)');
  ok(/`zee tend --clear`/.test(line), 'and shows the exact verb to lower it');

  // ── the verbs a zee reads next carry it, on the stable field ──
  console.log('\n── `zee status` / `zee inbox` carry it; nothing is auto-cleared by reading ──');
  const st = await selfStatus(await xellRow());
  ok(st.tend_nudge === line, '`zee status` carries the same line on tend_nudge');
  ok(st.tend.open === true && /orders table/.test(st.tend.reason), 'the tend field itself is UNCHANGED (open, same reason)');
  ok((await tendState(XID)).open === true, 'reading status did NOT clear the tend — only the zee lowers its own statement');
  const inbox = await selfInbox(await xellRow(), { all: true });
  ok(typeof inbox.tend_nudge === 'string' && /still open/.test(inbox.tend_nudge),
     '`zee inbox` — the verb where the zee reads the reply — nudges too');
  ok((await tendState(XID)).open === true, 'and reading the inbox did not clear it either');

  // ── `zee working` nudges as well — computed BEFORE its own auto-clear ──
  console.log('\n── `zee working` nudges (before its auto-clear lowers the tend) ──');
  const w = await selfWorking(await xellRow(), { note: 'still at it' });
  ok(w.ok === true && typeof w.tend_nudge === 'string' && /reply since/.test(w.tend_nudge),
     'the working response carries the nudge (the reply would otherwise go unnoticed forever)');
  ok((await tendState(XID)).open === false,
     '…and the working ping then auto-cleared the tend, exactly as before (behaviour unchanged)');
  ok(await tendNudge(XID) === null, 'once the tend is down, the nudge is null again');

  // ── clearing by hand also silences it ──
  console.log('\n── `zee tend --clear` silences it ──');
  await setTend(XID, true, { reason: 'second ask' });
  await backdateEvents(5);
  await reply('second answer');
  ok(await tendNudge(XID) !== null, 'raised again + replied again → nudge is back');
  const cleared = await selfTend(await xellRow(), { clear: true });
  ok(cleared.ok === true && cleared.tend === false, '`zee tend --clear` lowers it');
  ok(await tendNudge(XID) === null, 'and the nudge is gone with it');
  ok((await selfStatus(await xellRow())).tend_nudge === null, '`zee status` is back to null');

  // ── age wording: old asks read in hours ──
  console.log('\n── an hours-old ask reads in hours ──');
  await setTend(XID, true, { reason: 'third ask, long forgotten' });
  await backdateEvents(180);
  await reply('a very late answer');
  const old = await tendNudge(XID);
  ok(/raised 3 h ago/.test(old), `an ask 180 min old reads "3 h" (${old})`);

  console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
} catch (e) {
  console.error('\n✗ threw:', e.stack || e.message);
  fail++;
} finally {
  await cleanup();
  try { await client.end(); } catch { /* */ }
}
process.exit(fail ? 1 : 0);

// A HUMAN-APPROVED "done?" THAT THE REAP REFUSED — the click that silently did nothing.
//
// THE DEFECT (found live: five of one manager's crew, status='failed', in one hour):
//   1. decideDoneSuggestion() flipped the row out of 'pending' BEFORE the reap, and stamped it
//      'failed' when the reap refused. listDoneSuggestions() only shows 'pending', so the card
//      vanished from the console, the worker was still alive, and the human believed they had
//      closed it.
//   2. the MANAGER — which raised the suggestion — was told nothing (a rejection messages it; a
//      refused approval did not).
//   3. reapXell()'s liveness test ORed the zee's OWN status with the monitor's cli_active flag.
//      For a cxell zee cli_active is a broad `pgrep claude|codex|kimi` INSIDE the cage, and
//      zee-attach.sh leaves `claude --resume` sitting in the pane for the life of the container
//      once anyone has talked to that zee. So the NORMAL end state of every cxell job — turn over
//      (status 'idle'), a resting interactive session in the pane — read as ACTIVE, and the
//      refusal said so in its own contradictory words: "its zee is still idle (monitor confirms it
//      is really active)".
//
// WHAT THIS FENCES
//   A. a refused reap does NOT consume the suggestion: it stays a card, carries the reason, and the
//      manager gets a message;
//   B. a zee that FINISHED and is sitting idle in an attached cxell is reapable — approving closes
//      the xell (this is the case that failed five times);
//   C. a genuinely MID-TURN zee (its own status says working) is STILL refused — the guard that
//      house rule 2 was paid for is intact — and force:true still gets through it;
//   D. the refusal message names WHICH signal decided and when it last saw activity.
//
// Isolated throwaway project in the real meta DB; PROVISION_MODE=simulate so the reap retires rows
// and touches no machine. Everything it creates is torn down in a finally, whatever happens.
import { readFileSync } from 'node:fs';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.PROVISION_MODE = 'simulate';   // never tear down a real machine
process.env.PRODRO_MODE = 'simulate';
process.env.TKB_NOTIFY = '0';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const client = new pg.Client({ connectionString: url });
const PID = '00000000-0000-4000-8000-0000000d5111';
const XID = '00000000-0000-4000-8000-0000000d5222';

const cleanup = async () => {
  try { await client.query(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* */ }
};

try {
  await client.connect();
  await cleanup();

  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,'donesug-test','/nonexistent/donesug','master','donesugtest','postgres')`, [PID]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [XID, PID]);

  // No worktree_path: in simulate nothing on disk is touched anyway, and a null path keeps the
  // teardown script out of the picture entirely.
  const mkXell = async (slug, extra = {}) => (await client.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status, is_pooled, zee_type, manager_xell_id)
       VALUES ($1,$2,$3,$4,'working',false,$5,$6) RETURNING *`,
    [PID, XID, slug, `spinoff/${slug}`, extra.zee_type || 'worker', extra.manager || null])).rows[0];

  // A zee in the state the argument turns on. `cli_active` is the monitor's flag; `status` is the
  // zee's own.
  const mkZee = async (xell, status, cliActive) => (await client.query(
    `INSERT INTO zee (xell_id, attach_mode, status, kind, entrypoint, cli_active, monitor_source,
                      last_monitor_at, last_event_at, last_stop_reason, viewer_kind)
       VALUES ($1,'headless-spawn',$2,'cxell','cxell-cli',$3,'cxell-pgrep',now(),now(),$4,'none')
     RETURNING *`,
    [xell.id, status, cliActive, status === 'idle' ? 'end_turn' : null])).rows[0];

  const mkTask = async (xell) => (await client.query(
    `INSERT INTO task (project_id, xell_id, prompt_text, status) VALUES ($1,$2,'do the thing','working')
     RETURNING *`, [PID, xell.id])).rows[0];

  const mgr = await mkXell('dsmgr', { zee_type: 'manager' });
  const wBusy = await mkXell('dsbusy', { manager: mgr.id });   // genuinely MID-TURN
  const wDone = await mkXell('dsdone', { manager: mgr.id });   // finished, idle, cxell attached
  const wFin = await mkXell('dsfin', { manager: mgr.id });     // ditto — closed through the human path
  await mkZee(wBusy, 'working', true);
  await mkZee(wDone, 'idle', true);
  await mkZee(wFin, 'idle', true);
  await mkTask(wBusy); await mkTask(wDone); await mkTask(wFin);

  const managers = await import('../server/src/lib/managers.js');
  const { reapXell } = await import('../server/src/queenzee/reaper.js');

  const openFor = async (xellId) => (await client.query(
    `SELECT * FROM done_suggestion WHERE target_xell_id=$1 AND status='pending' AND dismissed_at IS NULL`,
    [xellId])).rows;
  const xellStatus = async (id) => (await client.query(`SELECT status FROM xell WHERE id=$1`, [id])).rows[0].status;

  // ── C. the guard itself: mid-turn vs finished-and-attached ────────────────
  console.log('\n── the liveness test ──');
  const busyReap = await reapXell(wBusy.id, 'test');
  ok(busyReap.ok === false && busyReap.active === true,
     'a zee whose OWN status says working is refused (house rule 2 — the guard is intact)');
  ok(/status/i.test(busyReap.error || '') && !/still idle/.test(busyReap.error || ''),
     `the refusal names the signal that decided it: ${String(busyReap.error).slice(0, 120)}`);
  ok(/last (seen|activity)/i.test(busyReap.error || ''),
     'and says when it last saw activity');
  ok(await xellStatus(wBusy.id) === 'working', 'and the busy xell is untouched');

  const doneReap = await reapXell(wDone.id, 'test');
  ok(doneReap.ok === true,
     'a zee that FINISHED its turn and sits idle in an ATTACHED cxell is NOT "working" — it reaps '
     + `(got: ${doneReap.ok ? 'ok' : doneReap.error})`);
  ok(await xellStatus(wDone.id) === 'retired', 'and that xell is actually closed');

  // ── A. a refused reap must not consume the suggestion ─────────────────────
  console.log('\n── an approval the reap refuses ──');
  const sug = await managers.suggestDone({ manager: mgr, target: wBusy, reason: 'looks finished to me' });
  ok(sug.suggestion.status === 'pending', 'the manager raises a done suggestion');
  await managers.inboxFor(mgr.id);  // drain, so the next read is only what THIS decision produced

  const decided = await managers.decideDoneSuggestion(sug.suggestion.id, 'approved', 'test@human');
  ok(decided.ok === false && decided.refused === true,
     'the human approves, the reap refuses — and the answer SAYS it did not happen');
  const still = await openFor(wBusy.id);
  ok(still.length === 1 && still[0].id === sug.suggestion.id,
     'the suggestion is STILL A CARD (back to pending, not stamped failed and hidden)');
  ok(/ACTIVE/.test(JSON.stringify(still[0]?.result || {})),
     'and it carries the refusal reason for the human to read');
  ok((await managers.listDoneSuggestions(PID)).some((r) => r.id === sug.suggestion.id),
     'the console still lists it among the open suggestions');
  ok(await xellStatus(wBusy.id) === 'working', 'the worker is untouched and still working');

  // ── B. the manager is told, the same way a rejection tells it ─────────────
  const box = await managers.inboxFor(mgr.id);
  ok(box.some((m) => /could not|refused|not closed/i.test(m.body) && /dsbusy/.test(m.body)),
     `the MANAGER is told its suggestion was approved but the xell could not be closed (${box.length} message(s))`);

  // ── the second approval, forced, gets through ─────────────────────────────
  const forced = await managers.decideDoneSuggestion(sug.suggestion.id, 'approved', 'test@human', { force: true });
  ok(forced?.status === 'approved' && forced?.result?.ok === true,
     'the same card can be approved again WITH force — and that one goes through');
  ok(await xellStatus(wBusy.id) === 'retired', 'the forced approval really did close it');
  ok((await openFor(wBusy.id)).length === 0, 'and the card is consumed once it actually worked');

  // ── the whole point: an approval on a FINISHED worker actually closes it ───
  console.log('\n── an approval that succeeds (the normal end of every job) ──');
  const finSug = await managers.suggestDone({ manager: mgr, target: wFin, reason: 'landed; nothing left' });
  await managers.inboxFor(mgr.id);
  const finDone = await managers.decideDoneSuggestion(finSug.suggestion.id, 'approved', 'test@human');
  ok(finDone.status === 'approved' && finDone.refused !== true && finDone.result?.ok === true,
     'a human approving a finished-but-attached worker closes it — no force, no card left behind');
  ok(await xellStatus(wFin.id) === 'retired', 'the xell is retired');
  ok((await client.query(`SELECT status FROM task WHERE xell_id=$1`, [wFin.id])).rows[0].status === 'done',
     'its task is marked done');
  ok((await openFor(wFin.id)).length === 0, 'and the suggestion is consumed (it was actually carried out)');
  ok((await managers.inboxFor(mgr.id)).some((m) => /CONFIRMED/.test(m.body) && /dsfin/.test(m.body)),
     'the manager is told it was confirmed — unchanged from today');

  // ── a rejection is untouched by any of this ───────────────────────────────
  const rej = await managers.suggestDone({ manager: mgr, target: wBusy, reason: 'maybe?' });
  ok(rej.suggestion.id !== sug.suggestion.id, 'a fresh suggestion can be raised for a reaped xell\'s slug');
  const rejected = await managers.decideDoneSuggestion(rej.suggestion.id, 'rejected', 'test@human');
  ok(rejected.status === 'rejected' && rejected.refused !== true,
     'REJECT still decides immediately and consumes the card');

  // ── the console shows the refusal on the card it kept ─────────────────────
  // Static, because the server half is worthless if the human still sees nothing: the card is back
  // on their screen carrying `result.refused`, and it has to SAY so.
  console.log('\n── the console card ──');
  const card = readFileSync('web/src/Manager.jsx', 'utf8');
  ok(/result\?\.refused/.test(card), 'DoneSuggestionCard reads the refusal off the suggestion it kept');
  ok(/r\?\.refused/.test(card), 'and an approval answered with refused:true is surfaced as an error, not a success');

  console.log(fail ? `\n${fail} check(s) FAILED` : '\nall checks passed');
} catch (err) {
  console.error('\nTEST ERROR:', err);
  fail++;
} finally {
  await cleanup();
  await client.end().catch(() => {});
}
process.exit(fail ? 1 : 0);

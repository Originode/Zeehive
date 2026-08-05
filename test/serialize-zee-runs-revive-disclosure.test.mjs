// TWO RUNS OF ONE ZEE CANNOT ACT AS ONE IDENTITY, AND A REVIVED RUN IS TOLD WHAT ITS
// PREDECESSORS DID (TKT-114).
//
// The incident, 2026-08-05T02:49-03:10Z: a manager's session was killed three times by provider 429s
// and auto-revived. Each revived run woke, re-read the same fleet state, and re-decided the same
// question — with no visibility of what the previous run had already SAID or DONE (defect A), and
// nothing stopping two runs of the same session from being live at once (defect B). Measured
// consequences in eleven minutes: ten messages from one manager to one worker (STOP, sibling warning,
// STAND DOWN, "you are both on this", WITHDRAW, RE-ARMED, evidence, HOLD, STAND DOWN, GO); a `zee
// assign` replayed that spawned two workers 40s apart; and a worker's cage grew two commits no run
// of its session ever authored (bare `commit` in the reflog, no Edit/Write in the transcript).
//
// WHAT IS FENCED HERE:
//   A. THE SINGLE-WRITER LOCK (defect B): a turn-start CLAIMS the zee row atomically — the second of
//      two concurrent claims for one zee is refused with a legible reason, never silently interleaved.
//      Proved at three depths: the claim function itself (sequential + concurrent), the resume path
//      (a second nudgeXellForTurnDeath while the first turn is in flight is refused), and the
//      interactive-turn door (a `zee turn --start` against a working zee records nothing).
//   B. THE PREDECESSOR-ACTION DIGEST (defect A): a revived zee's briefing carries a digest of what
//      earlier runs of this zee did — messages sent, workers dispatched, done suggestions, work-item
//      ops — synthesized from the meta-DB ledgers the transcript never shows. Proved at two depths:
//      the digest function against seeded ledger rows, and the real revive loop putting the digest
//      into the resume prompt.
//
// Everything it creates is deleted in a finally, whatever happens.
process.env.PROVISION_MODE = 'real';   // read once at import: the real queenzee resumes real cages
process.env.TKB_NOTIFY = '0';

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { claimZeeTurn, markZeeTurn } = await import('../server/src/lib/turn-record.js');
const { predecessorActionDigest } = await import('../server/src/lib/predecessor-digest.js');

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

const { q, one, pool } = await import('../server/src/db/pool.js');
const { recentLogs } = await import('../server/src/lib/logbus.js');
const { setPaused, forgetPauseCache } = await import('../server/src/lib/fleet-pause.js');
const revive = await import('../server/src/queenzee/revive.js');
const { selfTurn } = await import('../server/src/queenzee/self.js');

// The `docker` seam: the shared fake on PATH records argv + stdin (the resume prompt) to $DOCKER_LOG.
const DOCKER_LOG = join(process.env.TMPDIR || '/tmp', `tkt114-docker-${process.pid}.log`);
process.env.DOCKER_LOG = DOCKER_LOG;
process.env.PATH = `${join(ROOT, 'test', '_bin')}:${process.env.PATH}`;
const dockerLog = () => (existsSync(DOCKER_LOG) ? readFileSync(DOCKER_LOG, 'utf8') : '');
const logs = (n = 80) => recentLogs(n).map((l) => `${l.scope}: ${l.msg}`).join('\n');

const PID = '00000000-0000-4000-8000-0000000f1141';
const cleanup = async () => {
  try { await setPaused(false, { by: 'tkt114-test' }); forgetPauseCache(); } catch { /* no row */ }
  try { await q(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* already gone */ }
  try { if (existsSync(DOCKER_LOG)) unlinkSync(DOCKER_LOG); } catch { /* fine */ }
};

try {
  await cleanup();
  await q(`INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'tkt114',$2,'main')`, [PID, ROOT]);
  await q(`INSERT INTO provider_token (project_id, provider, token, token_hint, label) VALUES ($1,'claude','sk-fake','sk-…ake','mark-personal')`, [PID]);
  const xource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'main') RETURNING *`, [PID]);
  const rt = await one(`SELECT id FROM agent_runtime WHERE key='claude-code-cxell'`);
  let n = 0;
  const mkXell = async (slug, status = 'working', over = {}) => one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, self_token_hash, zee_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [PID, xource.id, slug, `spinoff/${slug}`, `/tmp/tkt114/${slug}`, status, `hash-${slug}`, over.zeeType ?? 'worker']);
  const mkZee = async (xellId, over = {}) => one(
    `INSERT INTO zee (xell_id, attach_mode, entrypoint, kind, runtime_id, viewer_kind, viewer_url,
                      claude_session_id, model, status, last_stop_reason, decommissioned_at)
     VALUES ($1,'headless-spawn','cxell-cli','headless',$2,$3,$4,$5,'opus',$6,$7,$8) RETURNING *`,
    [xellId, rt?.id || null, over.viewerKind ?? 'ssh-terminal',
     over.viewerUrl ?? 'ssh://zee@127.0.0.1:2222',
     over.sid ?? `00000000-0000-4000-8000-00000000000${++n}`,
     over.status ?? 'errored', over.stopReason ?? null, over.decommissionedAt ?? null]);

  // ── A. THE SINGLE-WRITER LOCK ───────────────────────────────────────────────────────────────
  console.log('\n── A1. the claim itself: a second turn-start for one zee is refused ──');
  const xa = await mkXell('tkt114-lock');
  const za = await mkZee(xa.id, { status: 'idle' });
  const first = await claimZeeTurn(za.id, 'resumed turn');
  ok(!!first && first.status === 'working', 'the first claim wins and marks the zee working');
  const second = await claimZeeTurn(za.id, 'resumed turn again');
  ok(second === null, 'the second claim is REFUSED (null) — a turn is already in flight');
  const ra = await one(`SELECT status FROM zee WHERE id=$1`, [za.id]);
  ok(ra.status === 'working', 'and the row still says working — the lock was not released by the refusal');
  const still = await claimZeeTurn(za.id, 'still refused');
  ok(still === null, 'and it stays refused until the turn ends');

  // The lock is released by the normal turn end.
  await markZeeTurn(za.id, 'idle', 'end_turn');
  const after = await claimZeeTurn(za.id, 'next turn');
  ok(!!after && after.status === 'working', 'the lock is released by the turn END (markZeeTurn idle)');

  console.log('\n── A2. the claim is ATOMIC: two concurrent turn-starts, exactly one wins ──');
  const xa2 = await mkXell('tkt114-race');
  const za2 = await mkZee(xa2.id, { status: 'idle' });
  const [r1, r2] = await Promise.all([
    claimZeeTurn(za2.id, 'runner a'),
    claimZeeTurn(za2.id, 'runner b'),
  ]);
  const winners = [r1, r2].filter(Boolean).length;
  ok(winners === 1, `two concurrent claims for one zee → exactly one winner (got ${winners})`);
  const racedRow = await one(`SELECT status, last_stop_reason FROM zee WHERE id=$1`, [za2.id]);
  ok(racedRow.status === 'working' && /runner (a|b)/.test(racedRow.last_stop_reason),
     `the winner is on the row (status=working, "${racedRow.last_stop_reason}")`);
  await markZeeTurn(za2.id, 'idle', 'end_turn');

  console.log('\n── A3. the RESUME PATH refuses a second resume while the first turn is in flight ──');
  // Slow the fake docker's stdin read so the first resume's exec is still running (holding the lock)
  // when the second resume is attempted — the exact "ten resumes in eleven minutes" shape, but two.
  process.env.DOCKER_FAKE_SLOW_STDIN_MS = '500';
  const xa3 = await mkXell('tkt114-double-resume');
  const za3 = await mkZee(xa3.id, { stopReason: 'API Error: 429 rate_limit_error' });
  await revive.noteTurnDeath({ zeeId: za3.id, xellId: xa3.id, slug: xa3.slug,
                               reason: 'API Error: 429 rate_limit_error' });
  await q(`UPDATE zee SET revive_next_at = now() - interval '1 minute' WHERE id=$1`, [za3.id]);
  // First revive — fires, claims the turn, starts the (slow) resume.
  const tick1 = await revive.reviveTick();
  ok(tick1.revived === 1, `the first revive fires and claims the turn (${JSON.stringify(tick1)})`);
  await sleep(100);   // let the claim land and the exec start (still sleeping, lock held)
  // Second revive — while the first turn is STILL in flight. Must be refused, not interleaved.
  const before2 = dockerLog().length;
  await q(`UPDATE zee SET revive_next_at = now() - interval '1 minute' WHERE id=$1`, [za3.id]);
  const tick2 = await revive.reviveTick();
  ok(tick2.revived === 0, `the second revive tick finds nothing delivered (${JSON.stringify(tick2)})`);
  ok(/REFUSED: a turn is ALREADY in flight/.test(logs()),
     'the queenzee log says WHY it was refused — a second run of a live session is not silently interleaved');
  await sleep(150);
  const dl3 = dockerLog();
  ok(dl3.length === before2 || dl3.split('--resume').length - 1 === 1,
     'and NO second --resume exec was started — one run, one session, one turn');
  delete process.env.DOCKER_FAKE_SLOW_STDIN_MS;
  // let the first (slow) resume finish and release the lock so cleanup is clean
  await sleep(700);

  console.log('\n── A4. the INTERACTIVE door: `zee turn --start` against a working zee records nothing ──');
  const xa4 = await mkXell('tkt114-interactive');
  const za4 = await mkZee(xa4.id, { status: 'working' });
  await q(`UPDATE zee SET last_stop_reason='landing approved' WHERE id=$1`, [za4.id]);
  const turnStart = await selfTurn(xa4, { state: 'start' });
  ok(turnStart.ok === true && turnStart.recorded === false && turnStart.zee_status === 'working',
     'a start while a turn is in flight is refused and records nothing (belt to --bare firing no hooks)');
  const turnRow = await one(`SELECT status, last_stop_reason FROM zee WHERE id=$1`, [za4.id]);
  ok(turnRow.status === 'working' && turnRow.last_stop_reason === 'landing approved',
     'and the queenzee-started turn is NOT written over');

  // ── B. THE PREDECESSOR-ACTION DIGEST ─────────────────────────────────────────────────────────
  console.log('\n── B1. the digest function: what earlier runs did, from the ledgers ──');
  const xb = await mkXell('tkt114-manager', 'working', { zeeType: 'manager' });   // the revived manager
  const zb = await mkZee(xb.id, { status: 'idle' });
  // A worker it dispatched (xell.manager_xell_id stamps the manager).
  const worker = await mkXell('tkt114-worker', 'working');
  await q(`UPDATE xell SET manager_xell_id=$1 WHERE id=$2`, [xb.id, worker.id]);
  // A message it sent (zee_message.from_xell_id).
  await q(`INSERT INTO zee_message (project_id, from_xell_id, from_slug, to_xell_id, to_slug, kind, body)
           VALUES ($1,$2,$3,$4,$5,'directive','please land the langfuse fix now')`,
          [PID, xb.id, xb.slug, worker.id, worker.slug]);
  // A done suggestion it raised (done_suggestion.manager_xell_id).
  await q(`INSERT INTO done_suggestion (project_id, manager_xell_id, manager_slug, target_xell_id, target_slug, reason)
           VALUES ($1,$2,$3,$4,$5,'produced nothing')`,
          [PID, xb.id, xb.slug, worker.id, worker.slug]);
  // A work-item op (work_item_event.actor = the manager's slug). Need a work_item row to join to.
  const root = await one(`SELECT id FROM work_item WHERE project_id=$1 AND kind='project'`, [PID]);
  const wi = await one(
    `INSERT INTO work_item (project_id, parent_id, kind, title, status, path, depth)
     VALUES ($1,$2,'task','Serialise runs','assigned','',$3) RETURNING *`,
    [PID, root?.id ?? null, root ? 1 : 0]);
  await q(`INSERT INTO work_item_event (work_item_id, kind, from_status, to_status, actor)
           VALUES ($1,'assigned','queued','assigned',$2)`, [wi.id, xb.slug]);

  const digest = await predecessorActionDigest({ xellId: xb.id, xellSlug: xb.slug, since: zb.created_at });
  ok(!!digest && digest.includes('WHAT EARLIER RUNS OF YOURS DID'),
     'the digest opens by telling the revived run that these actions are NOT in its transcript');
  ok(!!digest && digest.includes('sent a directive to tkt114-worker'),
     'it lists the message this manager sent (from the durable zee_message ledger)');
  ok(!!digest && digest.includes('dispatched a worker into tkt114-worker'),
     'it lists the worker this manager dispatched (xell.manager_xell_id)');
  ok(!!digest && digest.includes('suggested tkt114-worker is done'),
     'it lists the done suggestion this manager raised (done_suggestion)');
  ok(!!digest && digest.includes('work item assigned on "Serialise runs"'),
     'it lists the work-item op (work_item_event.actor = this xell)');
  ok(!!digest && digest.includes('please land the langfuse fix now'),
     'and it quotes the message body so the revived run does not have to guess what it said');

  // A zee with NO ledger activity gets no digest block — the revive is not padded with an empty
  // section (a worker with no reports, no dispatches, nothing).
  const xb2 = await mkXell('tkt114-silent');
  const zb2 = await mkZee(xb2.id, { status: 'idle' });
  const emptyDigest = await predecessorActionDigest({ xellId: xb2.id, xellSlug: xb2.slug, since: zb2.created_at });
  ok(emptyDigest === null, 'a zee with no previous-run actions gets NO digest block (null, not an empty section)');

  console.log('\n── B2. the REAL REVIVE puts the digest into the resume prompt ──');
  const xb3 = await mkXell('tkt114-revive-digest', 'working', { zeeType: 'manager' });
  const zb3 = await mkZee(xb3.id, { stopReason: 'API Error: 429 rate_limit_error' });
  // Give THIS zee a couple of ledgered actions from "an earlier run".
  const worker3 = await mkXell('tkt114-revive-worker', 'working');
  await q(`UPDATE xell SET manager_xell_id=$1 WHERE id=$2`, [xb3.id, worker3.id]);
  await q(`INSERT INTO zee_message (project_id, from_xell_id, from_slug, to_xell_id, to_slug, kind, body)
           VALUES ($1,$2,$3,$4,$5,'message','the worker said it is blocked on a 401')`,
          [PID, xb3.id, xb3.slug, worker3.id, worker3.slug]);
  await revive.noteTurnDeath({ zeeId: zb3.id, xellId: xb3.id, slug: xb3.slug,
                               reason: 'API Error: 429 rate_limit_error' });
  await q(`UPDATE zee SET revive_next_at = now() - interval '1 minute' WHERE id=$1`, [zb3.id]);
  // Fresh docker log so the wait below can only match THIS zee's prompt, not A3's leftovers.
  try { if (existsSync(DOCKER_LOG)) unlinkSync(DOCKER_LOG); } catch { /* fine */ }
  const tick3 = await revive.reviveTick();
  ok(tick3.revived === 1, 'the revive fires');
  // The resume exec is fire-and-forget: nudgeCxell returns the instant it starts, and the fake docker
  // writes the prompt (stdin) asynchronously. Wait for THIS zee's prompt to land before asserting on it.
  const waitFor = async (fn, ms = 4000) => {
    for (let i = 0; i < ms / 100; i++) { if (await fn()) return true; await sleep(100); }
    return false;
  };
  ok(await waitFor(() => dockerLog().includes('CUT SHORT BY A PROVIDER ERROR')), 'the revive prompt reaches the cage');
  const dl = dockerLog();
  ok(/CUT SHORT BY A PROVIDER ERROR/.test(dl), 'the standard revive text is still there');
  ok(dl.includes('WHAT EARLIER RUNS OF YOURS DID'),
     'the digest is appended to the revive prompt — the revived run is TOLD what its predecessors did');
  ok(dl.includes('sent a message to tkt114-revive-worker')
     && dl.includes('dispatched a worker into tkt114-revive-worker'),
     'and the digest lists THIS zee\'s ledgered actions in the prompt it actually receives');
} finally {
  await cleanup();
  await pool.end().catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);

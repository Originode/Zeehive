// A TURN THE PROVIDER KILLED IS NOT A ZEE THAT FAILED — revive one, raise a human for the other.
//
// MEASURED (the live meta-DB, 2026-08-04). Of 279 zees, ~43 ended their LAST turn on a provider or
// infrastructure error rather than on a decision of their own: 429 x20, 529 x9, connection-closed
// x4, 401 x6, org/model x4, and 7 whose whole message was 'error'. The rate-limit/overload cohort
// died at $0.06–$0.43 — on the FIRST turn, after the xell, its containers and its database had been
// provisioned and paid for in full, with the task never started. Six of the 401 zees never landed
// anything, ever, and nobody was ever told which account was dead. Nothing retried, classified or
// reported any of it: intake.js wrote status='errored' and stopped there.
//
// WHAT IS FENCED HERE:
//   A. the CLASSIFICATION, in a table (lib/turn-death.js — pure, the shape of decideMessageDelivery),
//      including the trap that decides its order: an exhausted balance arrives as HTTP 429;
//   B. the POLICY, in a table: three attempts at 5/15/45 for a transient death, a human for a
//      terminal one at the first, and a human at the fourth;
//   C. the REAL loop against a throwaway postgres and the cxell's docker seam — a transient zee is
//      resumed with NO human involved, the log says which attempt it was, and the resume carries a
//      prompt that says the PROVIDER cut the turn and to re-orient with `zee status`;
//   D. a TERMINAL zee is never resumed at any interval, and its xell shows a tend naming the account
//      and quoting the provider verbatim;
//   E. the rules that must not move: never twice in flight, never under a pause (held, not dropped),
//      never a decommissioned zee or a retired xell, and a revived turn that dies AGAIN climbs the
//      ladder instead of being filed as a clean 'end_turn'.
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

// ── A. THE CLASSIFICATION (pure — no database, no container) ──────────────────────────────────
const { classifyTurnDeath, decideRevive, resumeTurnDeath,
        REVIVE_BACKOFF_MIN, MAX_REVIVE_ATTEMPTS } = await import('../server/src/lib/turn-death.js');

const c = (t) => classifyTurnDeath(t);

console.log('\n── A. what killed this turn ──');
for (const [msg, signal] of [
  ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit"}}', '429'],
  ['Claude AI usage limit reached — too many requests', '429'],
  ['API Error: 529 {"type":"overloaded_error"}', '529'],
  ['Error: connection closed before a complete response was received', 'closed'],
  ['read ECONNRESET', 'closed'],
  ['API Error: 503 Service Unavailable', '5xx'],
  ['docker exec timed out after 1200000ms', 'timeout'],
]) ok(c(msg).kind === 'transient' && c(msg).signal === signal,
     `TRANSIENT/${signal}: ${JSON.stringify(msg.slice(0, 52))} → ${c(msg).kind}/${c(msg).signal}`);

for (const [msg, signal] of [
  ['API Error: 401 {"type":"authentication_error","message":"invalid x-api-key"}', 'auth'],
  ['Invalid API key · Please run /login', 'auth'],
  ['401 Unauthorized: Missing bearer or basic authentication in header', 'auth'],
  // xAI's own wording for a bad key, as the grok CLI reports it — and it comes back as HTTP 400,
  // so the 401 alternatives above do not see it (measured against api.x.ai, 2026-08-04)
  ['API error (status 400 Bad Request): invalid-argument: Incorrect API key provided. '
   + 'You can obtain an API key from https://console.x.ai.', 'auth'],
  ['Your organization has been disabled', 'account'],
  ['404 model_not_found: the model `opus-9` does not exist', 'model'],
  ['Your credit balance is too low to access the Anthropic API', 'credit'],
]) ok(c(msg).kind === 'terminal' && c(msg).signal === signal,
     `TERMINAL/${signal}: ${JSON.stringify(msg.slice(0, 52))} → ${c(msg).kind}/${c(msg).signal}`);

ok(c('429 You exceeded your current quota, please check your plan and billing details').kind === 'terminal',
   'THE TRAP THAT DECIDES THE ORDER: an EXHAUSTED BALANCE arrives as HTTP 429, so terminal is asked '
   + 'first — matching 429 first would put a dead account on a ladder that can only fail and never '
   + 'raise the human who could top it up');
ok(c('error').kind === 'unknown' && c('').kind === 'unknown' && c(null).kind === 'unknown',
   "the 7 zees whose whole message was 'error' stay UNKNOWN — a guess either way is worse than silence");

console.log('\n── B. what that death deserves ──');
const dec = (over = {}) => decideRevive({ kind: 'transient', attempts: 0, ...over });
ok(REVIVE_BACKOFF_MIN.join(',') === '5,15,45' && MAX_REVIVE_ATTEMPTS === 3,
   'the ladder is 5/15/45 minutes and its LENGTH is the attempt cap (three, then a human)');
for (let i = 0; i < 3; i++) {
  ok(dec({ attempts: i }).action === 'revive' && dec({ attempts: i }).delayMinutes === REVIVE_BACKOFF_MIN[i],
     `attempt ${i + 1} of a transient death → revive, in ${REVIVE_BACKOFF_MIN[i]} minute(s)`);
}
ok(dec({ attempts: 3 }).action === 'tend',
   'the FOURTH death stops and raises a human — three provider deaths in ~65 minutes is not a busy provider');
ok(dec({ kind: 'terminal' }).action === 'tend' && dec({ kind: 'terminal', attempts: 0 }).delayMinutes === null,
   'a TERMINAL death raises a human at the FIRST one and is never scheduled');
ok(dec({ kind: 'unknown' }).action === 'none', 'an unknown death does nothing at all');
ok(dec({ decommissioned: true }).action === 'none' && dec({ xellStatus: 'retired' }).action === 'none'
   && dec({ xellStatus: 'tearing-down' }).action === 'none',
   'a decommissioned zee, a retired xell and a tearing-down one are never revived (asked FIRST — '
   + 'viewer_kind is not cleared with any of them)');
ok(dec({ resumable: false }).action === 'none' && dec({ kind: 'terminal', resumable: false }).action === 'tend',
   'a death with no session to resume (a cage that never got built) is left alone — but a TERMINAL '
   + 'one still gets its human, which is the 401-at-spawn case');

// The exec's stdout is parsed ONCE, by the adapter that produced it (lib/cxell-runtimes.js
// resultFrom — asserted in test/resumed-turn-accounting.test.mjs, which is the other caller of it),
// and this function is handed the RESULT EVENT. It used to re-scan `out` for claude-shaped JSON
// itself, beside a second adapter-aware reader written for the burn ledger a day later; a codex or
// kimi turn — neither of which prints claude's result event — was read wrongly by one of the two.
console.log('\n── B2. did a RESUMED turn die? (policy only — the parse happens once, elsewhere) ──');
const RES = (o) => ({ type: 'result', ...o });
ok(resumeTurnDeath({ code: 0, result: RES({ is_error: false, result: 'done' }) }) === null,
   'a clean result event is not a death');
ok(resumeTurnDeath({ code: 0, result: RES({ is_error: true, result: 'API Error: 429' }) })?.message === 'API Error: 429',
   'an is_error result IS a death, and it carries the CLI\'s own message');
ok(resumeTurnDeath({ code: 1, result: RES({ is_error: false, result: 'done' }) }) === null,
   'a turn that SPOKE and did not die is not a death, whatever the exit code says afterwards');
ok(resumeTurnDeath({ code: 0, out: 'not json\n' }) === null, 'noise with nothing parsed out of it is not a death');
ok(resumeTurnDeath({ code: 1, err: 'API Error: 529 overloaded' })?.message === 'API Error: 529 overloaded',
   'a run that died before printing a result falls back to the streams');
ok(resumeTurnDeath({ code: 1, err: '', out: '' }) === null, 'an exit code alone says nothing to classify');

// ── C/D/E. THE REAL LOOP (throwaway postgres + the cxell docker seam) ─────────────────────────
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

const { q, one, pool } = await import('../server/src/db/pool.js');
const { recentLogs } = await import('../server/src/lib/logbus.js');
const { setPaused, forgetPauseCache } = await import('../server/src/lib/fleet-pause.js');
const { tendState } = await import('../server/src/lib/status.js');
const revive = await import('../server/src/queenzee/revive.js');

// The `docker` seam: the shared fake on PATH records argv + stdin (the resume prompt) to $DOCKER_LOG.
const DOCKER_LOG = join(process.env.TMPDIR || '/tmp', `revive-docker-${process.pid}.log`);
process.env.DOCKER_LOG = DOCKER_LOG;
process.env.PATH = `${join(ROOT, 'test', '_bin')}:${process.env.PATH}`;
const dockerLog = () => (existsSync(DOCKER_LOG) ? readFileSync(DOCKER_LOG, 'utf8') : '');
const logs = (n = 60) => recentLogs(n).map((l) => `${l.scope}: ${l.msg}`).join('\n');

const PID = '00000000-0000-4000-8000-0000000f5901';
const cleanup = async () => {
  try { await setPaused(false, { by: 'revive-test' }); forgetPauseCache(); } catch { /* no row */ }
  try { await q(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* already gone */ }
  try { if (existsSync(DOCKER_LOG)) unlinkSync(DOCKER_LOG); } catch { /* fine */ }
};
const waitFor = async (fn, ms = 6000) => {
  for (let i = 0; i < ms / 100; i++) { if (await fn()) return true; await sleep(100); }
  return false;
};

try {
  await cleanup();
  await q(`INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'revive',$2,'main')`, [PID, ROOT]);
  await q(`INSERT INTO provider_token (project_id, provider, token, token_hint, label) VALUES ($1,'claude','sk-fake','sk-…ake','mark-personal')`, [PID]);
  const xource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'main') RETURNING *`, [PID]);
  const rt = await one(`SELECT id FROM agent_runtime WHERE key='claude-code-cxell'`);
  let n = 0;
  const mkXell = async (slug, status = 'working') => one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, self_token_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [PID, xource.id, slug, `spinoff/${slug}`, `/tmp/revive/${slug}`, status, `hash-${slug}`]);
  const mkZee = async (xellId, over = {}) => one(
    `INSERT INTO zee (xell_id, attach_mode, entrypoint, kind, runtime_id, viewer_kind, viewer_url,
                      claude_session_id, model, status, last_stop_reason, decommissioned_at)
     VALUES ($1,'headless-spawn','cxell-cli','headless',$2,$3,$4,$5,'opus',$6,$7,$8) RETURNING *`,
    [xellId, rt?.id || null, over.viewerKind ?? 'ssh-terminal',
     over.viewerUrl ?? 'ssh://zee@127.0.0.1:2222',
     over.sid ?? `00000000-0000-4000-8000-00000000000${++n}`,
     over.status ?? 'errored', over.stopReason ?? null, over.decommissionedAt ?? null]);
  const due = (zeeId) => q(`UPDATE zee SET revive_next_at = now() - interval '1 minute' WHERE id=$1`, [zeeId]);
  const row = (zeeId) => one(`SELECT * FROM zee WHERE id=$1`, [zeeId]);

  // ── C. THE REPORTED CASE: a first turn killed by a 429 ───────────────────────────────────────
  console.log('\n── C. a 429 on the first turn: scheduled, then revived with no human ──');
  const x1 = await mkXell('revive-429');
  const z1 = await mkZee(x1.id, { stopReason: 'API Error: 429 rate_limit_error' });
  const before1 = dockerLog().length;
  const noted = await revive.noteTurnDeath({ zeeId: z1.id, xellId: x1.id, slug: x1.slug,
                                             reason: 'API Error: 429 {"type":"rate_limit_error"}' });
  ok(noted.kind === 'transient' && noted.scheduled === true && noted.in_minutes === 5,
     `the death is filed as transient and SCHEDULED five minutes out (${JSON.stringify(noted)})`);
  const r1 = await row(z1.id);
  ok(r1.revive_class === 'transient' && r1.revive_signal === '429' && r1.revive_attempts === 0,
     'the zee row carries the classification and has spent no attempt yet');
  ok(r1.revive_next_at && new Date(r1.revive_next_at) > new Date(Date.now() + 4 * 60000),
     'revive_next_at is in the FUTURE — the backoff is real, not a same-tick retry');
  ok((await tendState(x1.id)).open === false, 'and NO human was raised: this one is the queenzee\'s to fix');
  await sleep(150);
  ok(dockerLog().length === before1, 'nothing was resumed yet — the ladder waits');
  const ev1 = await one(`SELECT raw FROM session_event WHERE zee_id=$1 AND hook_event_name='turn-death'`, [z1.id]);
  ok(ev1?.raw?.signal === '429' && ev1?.raw?.action === 'revive' && ev1?.raw?.delay_minutes === 5,
     'and the attempt is answerable in SQL afterwards (session_event turn-death carries kind/signal/action/delay)');

  await due(z1.id);
  const tick1 = await revive.reviveTick();
  ok(tick1.revived === 1, `the loop revived it with NO human involved (${JSON.stringify(tick1)})`);
  ok(await waitFor(() => /--resume/.test(dockerLog())),
     'the queenzee ran `docker exec … --resume` on the cage — the SAME machinery a landing approval uses');
  const dl = dockerLog();
  ok(dl.includes(r1.claude_session_id), 'the resume targeted THIS zee\'s session (the same session, not a new one)');
  ok(/CUT SHORT BY A PROVIDER ERROR/.test(dl) && /NOTHING OF YOURS FAILED/.test(dl),
     'the prompt says the PROVIDER cut the turn, not the zee — an agent resumed with no explanation '
     + 'goes hunting for a failure of its own that is not there');
  ok(/attempt 1 of 3/.test(dl), 'it says which attempt this is, so the zee knows the ladder is finite');
  ok(/`zee status`/.test(dl) && /Re-orient BEFORE you act/.test(dl),
     'and it sends the zee to `zee status` first — time has passed and a decision may have arrived');
  ok(/429/.test(dl), 'the provider\'s own words are quoted, so the zee is not guessing at what happened');
  const r1b = await row(z1.id);
  ok(r1b.revive_attempts === 1 && r1b.revive_next_at === null && r1b.revived_at,
     'the attempt is SPENT on the row (attempts 1, nothing due, revived_at stamped)');
  ok(/revive: .*REVIVING — attempt 1 of 3 after a 429 death/.test(logs()),
     'and the queenzee log says which attempt it was, in one line');
  const ev1b = await one(`SELECT raw FROM session_event WHERE zee_id=$1 AND hook_event_name='zee-revive'`, [z1.id]);
  ok(ev1b?.raw?.attempt === 1, 'the attempt is recorded as an event too (so the revival RATE is a GROUP BY)');

  // ── E1. never twice in flight for one zee ────────────────────────────────────────────────────
  console.log('\n── E1. one revive at a time, and never a spent schedule twice ──');
  const beforeE1 = dockerLog().length;
  const tick2 = await revive.reviveTick();
  ok(tick2.due === 0 && tick2.revived === 0, 'a second tick finds nothing due — the claim consumed the schedule');
  await sleep(150);
  ok(dockerLog().length === beforeE1, 'and it resumed nothing a second time');

  // ── D. TERMINAL: never resumed, and the human is told which account ──────────────────────────
  console.log('\n── D. a 401 is never revived — it raises a human naming the account ──');
  const x2 = await mkXell('revive-401');
  const z2 = await mkZee(x2.id);
  const beforeD = dockerLog().length;
  const verbatim = 'API Error: 401 {"type":"authentication_error","message":"invalid x-api-key"}';
  const noted2 = await revive.noteTurnDeath({ zeeId: z2.id, xellId: x2.id, slug: x2.slug, reason: verbatim });
  ok(noted2.kind === 'terminal' && noted2.tended === true && !noted2.scheduled,
     'a terminal death raises a human and schedules NOTHING');
  const t2 = await tendState(x2.id);
  ok(t2.open === true, 'the xell shows a TEND — the state a human sees on the hexagon');
  ok(/claude account "mark-personal"/.test(t2.full || t2.reason || ''),
     `it names the provider and the ACCOUNT a human has to go and fix (${(t2.full || '').slice(0, 90)}…)`);
  ok((t2.full || '').includes('invalid x-api-key'),
     'and quotes the provider VERBATIM — six 401 zees died without anyone ever being told this');
  ok((await row(z2.id)).revive_next_at === null, 'nothing is scheduled for it, at any interval');
  await revive.reviveTick();
  await sleep(150);
  ok(dockerLog().length === beforeD, 'and the loop resumes it NEVER — not now, not in five minutes');

  // ── E2. the FOURTH death stops and hands over ────────────────────────────────────────────────
  console.log('\n── E2. three attempts, then a human ──');
  const x3 = await mkXell('revive-spent');
  const z3 = await mkZee(x3.id);
  await q(`UPDATE zee SET revive_attempts = 3 WHERE id=$1`, [z3.id]);
  const noted3 = await revive.noteTurnDeath({ zeeId: z3.id, xellId: x3.id, slug: x3.slug,
                                              reason: 'API Error: 529 overloaded' });
  ok(noted3.tended === true && !noted3.scheduled, 'a fourth transient death is NOT a fourth retry');
  const t3 = await tendState(x3.id);
  ok(t3.open === true && /spent all 3 automatic revives/.test(t3.full || ''),
     'the human is told how many times it died and that the automatic path is exhausted');
  ok(/commits are on its branch/.test(t3.full || ''),
     '…and that nothing is wrong with the work, so the tend is actionable rather than alarming');

  // ── E3. a PAUSE holds a revive, it does not drop it ──────────────────────────────────────────
  console.log('\n── E3. paused: held, not dropped ──');
  const x4 = await mkXell('revive-paused');
  const z4 = await mkZee(x4.id, { stopReason: 'API Error: 529 overloaded' });
  await revive.noteTurnDeath({ zeeId: z4.id, xellId: x4.id, slug: x4.slug, reason: 'API Error: 529 overloaded' });
  await due(z4.id);
  await setPaused(true, { by: 'revive-test@console', reason: 'rate limit' });
  forgetPauseCache();
  const beforeE3 = dockerLog().length;
  const tickP = await revive.reviveTick();
  ok(tickP.revived === 0, 'a paused fleet revives nobody — a revive is a TURN, and a pause a loop can undo is not a pause');
  await sleep(150);
  ok(dockerLog().length === beforeE3, 'and nothing was exec\'d into the cage');
  ok(/revive is DUE but the fleet\/project\/xell is PAUSED — held/.test(logs()),
     'the sweep refuses it BEFORE claiming the attempt, and says so once (the nudge\'s own pause guard '
     + 'is the backstop behind this, not the only defence)');
  const r4 = await row(z4.id);
  ok(r4.revive_next_at !== null && r4.revive_attempts === 0,
     'the schedule SURVIVES the pause and no attempt was spent — it is held, not dropped');
  await setPaused(false, { by: 'revive-test@console' });
  forgetPauseCache();
  const tickU = await revive.reviveTick();
  ok(tickU.revived === 1, 'and play lets the same schedule through, unchanged');

  // ── E4. nothing starts a turn on a zee that is gone ──────────────────────────────────────────
  console.log('\n── E4. decommissioned / retired: never revived ──');
  const x5 = await mkXell('revive-dead');
  const z5 = await mkZee(x5.id, { decommissionedAt: new Date().toISOString() });
  const noted5 = await revive.noteTurnDeath({ zeeId: z5.id, xellId: x5.id, slug: x5.slug, reason: 'API Error: 429' });
  ok(noted5.scheduled === false && !noted5.tended, 'a DECOMMISSIONED zee is not scheduled and not tended');
  const x6 = await mkXell('revive-retired', 'retired');
  const z6 = await mkZee(x6.id);
  const noted6 = await revive.noteTurnDeath({ zeeId: z6.id, xellId: x6.id, slug: x6.slug, reason: 'API Error: 429' });
  ok(noted6.scheduled === false, 'and neither is a zee in a RETIRED xell — the cage is gone');
  await q(`UPDATE zee SET revive_next_at = now() - interval '1 minute' WHERE id = ANY($1)`, [[z5.id, z6.id]]);
  const beforeE4 = dockerLog().length;
  await revive.reviveTick();
  await sleep(150);
  ok(dockerLog().length === beforeE4,
     'and even a schedule left on such a row (from before it died) is skipped by the sweep itself');

  // ── E5. a REVIVED turn that dies again climbs the ladder ─────────────────────────────────────
  console.log('\n── E5. the second death of the same zee ──');
  const x7 = await mkXell('revive-again');
  const z7 = await mkZee(x7.id, { stopReason: 'API Error: 429' });
  await revive.noteTurnDeath({ zeeId: z7.id, xellId: x7.id, slug: x7.slug, reason: 'API Error: 429' });
  await due(z7.id);
  process.env.DOCKER_FAKE_STREAM_JSON = JSON.stringify({ type: 'result', is_error: true, result: 'API Error: 529 {"type":"overloaded_error"}' });
  await revive.reviveTick();
  ok(await waitFor(async () => (await row(z7.id)).revive_signal === '529', 8000),
     'the resumed turn died on a 529 of its own, and the queenzee SAW it (a resume that dies is not an end_turn)');
  const r7 = await row(z7.id);
  ok(r7.revive_attempts === 1 && r7.revive_next_at
     && new Date(r7.revive_next_at) > new Date(Date.now() + 14 * 60000),
     'so attempt 2 is scheduled at the NEXT rung of the ladder (15 minutes), not the first one again');
  ok(r7.status === 'errored',
     "…and the row says 'errored' rather than a clean 'idle'/end_turn — the read models must not "
     + 'show a zee that finished when the provider killed it');
  delete process.env.DOCKER_FAKE_STREAM_JSON;

  // ── E6. a resume that cannot be delivered gives the attempt back ─────────────────────────────
  console.log('\n── E6. an undeliverable revive does not burn an attempt ──');
  const x8 = await mkXell('revive-gone');
  const z8 = await mkZee(x8.id, { viewerKind: 'none' });   // the cxell is torn down
  await revive.noteTurnDeath({ zeeId: z8.id, xellId: x8.id, slug: x8.slug, reason: 'API Error: 429' });
  await due(z8.id);
  await revive.reviveTick();
  const r8 = await row(z8.id);
  ok(r8.revive_attempts === 0 && r8.revive_next_at,
     'a revive that could not even start is given back (attempts 0) and re-scheduled — an unreachable '
     + 'cage must not spend one of the three tries the zee is owed');
} finally {
  await cleanup();
  await pool.end().catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);

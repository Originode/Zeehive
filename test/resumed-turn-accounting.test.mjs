// EVERY TURN IS ACCOUNTED FOR — including the ones the queenzee STARTS (TKT-60).
//
// MEASURED (a manager's crew, 2026-08-03) and the sequel to TKT-57. A reviewer's turn had ENDED;
// its manager sent the next instruction; the queenzee RESUMED the session and the zee worked — it
// landed two more commits. Its row went on reading $5.05, the cost of the turn it was SPAWNED with,
// because the only place a turn's cost is ever written was queenzee/intake.js, at the end of a
// SPAWN. The manager read that row, concluded the worker was idle, and spent a redundant xell.
//
// TKT-57 fixed the STATUS half (the row now says 'working' while a resumed turn runs). This is the
// ACCOUNTING half: nudgeCxellZee already gets the vendor's whole result stream back and every
// adapter already carries the parser for it — nothing consumed it. So a finished resume now reads
// its own final `result` event and books what it burned, exactly the way intake books a spawn.
//
// WHAT IS FENCED HERE:
//   A. usageFrom — the reader, moved beside the event contract (lib/cxell-runtimes.js).
//   B. a RESUMED turn ADDS its cost and tokens to the zee row, on top of the turns already on it.
//      Adding is the point: intake writes the FIRST turn onto a fresh row, a resume is turn N — a
//      row that is overwritten says "the last turn only", which is the same lie as "the first turn
//      only" facing the other way. Taken with the turn held open (DOCKER_FAKE_SLOW_STDIN_MS), so
//      the mid-flight row is inspected too, the way test/message-to-a-finished-zee.test.mjs does.
//   C. NO DOUBLE COUNT and no lost turns: two resumes charge twice, once each.
//   D. the OTHER continuations are the same shared delivery — a landing-approved nudge is charged
//      like a message, and so (by construction) are the stale, clearance, reflection and
//      fleet-resume nudges.
//   E. the boring cases: a turn that prints no result event books nothing and still ends cleanly; a
//      resume that could not RUN charges nothing at all; an errored result is still charged (the
//      tokens were spent whether or not the turn ended well).
//
// Everything it creates is deleted in a finally, whatever happens.
process.env.PROVISION_MODE = 'real';   // read once at import: the real queenzee resumes real cages
process.env.TKB_NOTIFY = '0';

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── A. THE READER (pure — no database, no container) ──────────────────────────────────────────
const { usageFrom } = await import('../server/src/lib/cxell-runtimes.js');
console.log('\n── A. usageFrom: what one turn burned, off the vendor result event ──');
const u = usageFrom({ type: 'result', total_cost_usd: 1.25,
                      usage: { input_tokens: 11, output_tokens: 22,
                               cache_read_input_tokens: 33, cache_creation_input_tokens: 44 } });
ok(u.cost === 1.25 && u.input === 11 && u.output === 22 && u.cacheRead === 33 && u.cacheWrite === 44,
   'the claude result shape reads back whole (cost + four token counters)');
const z = usageFrom(null);
ok(z.cost === 0 && z.input === 0 && z.output === 0,
   'a missing result is zeros, not NaN — a turn with nothing to read must not poison a numeric column');

// …and the ONE parser that produces that result from a finished exec's stdout. It is one parser
// because it was nearly three: the burn ledger needed the result event and lib/turn-death.js needed
// it a day later, each having written its own reader — one adapter-aware, one scanning stdout for
// claude-shaped JSON, which reads a codex or kimi turn (whose adapters SYNTHESIZE the event on
// close) wrongly.
const { resultFrom, adapterFor } = await import('../server/src/lib/cxell-runtimes.js');
const claude = adapterFor('claude-code-cxell');
const line = (o) => `${JSON.stringify({ type: 'result', ...o })}\n`;
console.log('\n── A2. resultFrom: the vendor\'s final result event, parsed once ──');
ok(resultFrom(claude, { code: 0, out: line({ is_error: false, total_cost_usd: 2 }) })?.total_cost_usd === 2,
   'the claude stream\'s result event comes back whole');
ok(resultFrom(claude, { code: 0, out: `${line({ result: 'first', total_cost_usd: 1 })}${line({ result: 'last', total_cost_usd: 2 })}` })?.result === 'last',
   'the LAST result event wins — a resumed session can emit more than one');
ok(resultFrom(claude, { code: 0, out: 'not json\nalso not json\n' }) === null,
   'noise on the stream parses to nothing, rather than to a shape nobody can trust');
ok(resultFrom(claude, { code: 0, out: '' }) === null && resultFrom(null, { out: line({}) }) === null,
   'no output — or no adapter to read it with — is null, not a throw');
const kimiDied = resultFrom(adapterFor('kimi-code-cxell'), { code: 1, out: '', err: 'provider.auth_error: 401' });
ok(kimiDied?.is_error === true && /401/.test(kimiDied.result || ''),
   'and a runtime that prints NO result event still ends in one (kimi\'s adapter synthesizes it on '
   + 'close) — the case a claude-shaped scan could not see at all');

// ── B..F. THE REAL PATH (throwaway postgres + the docker seam) ────────────────────────────────
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

const { q, one, pool } = await import('../server/src/db/pool.js');
const nudge = await import('../server/src/queenzee/nudge.js');

// The `docker` seam: the shared fake on PATH records argv + stdin and prints the result event the
// turn is supposed to have ended with (DOCKER_FAKE_STREAM_JSON).
const DOCKER_LOG = join(process.env.TMPDIR || '/tmp', `turnacct-docker-${process.pid}.log`);
process.env.DOCKER_LOG = DOCKER_LOG;
process.env.PATH = `${join(ROOT, 'test', '_bin')}:${process.env.PATH}`;
const dockerLog = () => (existsSync(DOCKER_LOG) ? readFileSync(DOCKER_LOG, 'utf8') : '');

// A claude turn that cost real money, as its own CLI reports it.
const RESULT = (over = {}) => JSON.stringify({
  type: 'result', is_error: false, result: 'done', total_cost_usd: 1.25,
  usage: { input_tokens: 1200, output_tokens: 340,
           cache_read_input_tokens: 90000, cache_creation_input_tokens: 5000 },
  ...over,
});
const TURN_COST = 1.25, TURN_TOK = 1200 + 340 + 90000 + 5000;

const PID = '00000000-0000-4000-8000-0000000f6001';
const SID = 'ffffffff-6000-4222-8333-444444444444';
const cleanup = async () => {
  try { await q(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* already gone */ }
};

const waitFor = async (fn, ms = 15000) => {
  for (let i = 0; i < ms / 100; i++) { if (await fn()) return true; await sleep(100); }
  return false;
};
const burnOf = async (zeeId) => one(
  `SELECT status, last_stop_reason, cost_usd::float8 AS cost, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens FROM zee WHERE id=$1`, [zeeId]);
const tokensOf = (r) => Number(r.input_tokens) + Number(r.output_tokens)
  + Number(r.cache_read_tokens) + Number(r.cache_write_tokens);
const idle = (zeeId) => waitFor(async () => (await one(`SELECT status FROM zee WHERE id=$1`, [zeeId]))?.status === 'idle');

try {
  await cleanup();
  await q(`INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'turnacct',$2,'main')`, [PID, ROOT]);
  const xource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'main') RETURNING *`, [PID]);
  const mkXell = async (slug, status = 'working') => one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, self_token_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [PID, xource.id, slug, `spinoff/${slug}`, `/tmp/turnacct/${slug}`, status, `hash-${slug}`]);
  const rt = await one(`SELECT id FROM agent_runtime WHERE key='claude-code-cxell'`);
  // A zee that has ALREADY spent a spawned turn — the reported row, to the cent.
  const mkZee = async (xellId, over = {}) => one(
    `INSERT INTO zee (xell_id, attach_mode, entrypoint, kind, runtime_id, viewer_kind, viewer_url,
                      claude_session_id, model, status, last_stop_reason,
                      cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
     VALUES ($1,'headless-spawn','cxell-cli','headless',$2,'ssh-terminal','ssh://zee@127.0.0.1:1',
             $3,'opus',$4,'end_turn',$5,$6,$7,$8,$9) RETURNING *`,
    [xellId, rt?.id || null, over.sid ?? SID, over.status ?? 'idle',
     over.cost ?? 5.05, over.input ?? 100, over.output ?? 200, over.cacheRead ?? 300, over.cacheWrite ?? 400]);

  // ── B. THE REPORTED ROW: a message resumes it, and the money moves ──────────────────────────
  console.log('\n── B. a resumed turn is charged to the zee that ran it ──');
  const x1 = await mkXell('turnacct-messaged');
  const z1 = await mkZee(x1.id);
  const before = await burnOf(z1.id);
  ok(before.cost === 5.05 && tokensOf(before) === 1000,
     'the row starts at the spawned turn it has already spent ($5.05) — the state the manager read');

  process.env.DOCKER_FAKE_STREAM_JSON = RESULT();
  process.env.DOCKER_FAKE_SLOW_STDIN_MS = '2000';    // hold the turn open, deterministically
  const r1 = await nudge.sendMessageToXell(x1.id, { text: 'one more thing: also update the docs',
                                                    by: 'manager-zee-be2f57' });
  ok(r1.delivery === 'resumed', 'the message RESUMED the finished zee (the delivery under test)');
  const mid = await burnOf(z1.id);
  ok(mid.status === 'working' && mid.cost === 5.05,
     'MID-FLIGHT the row says working and still reads the old cost — nothing is charged before the '
     + 'turn reports what it burned (TKT-57\'s status half is untouched)');

  ok(await idle(z1.id), 'the resumed turn ends and the row returns to idle');
  const after = await burnOf(z1.id);
  ok(after.cost === 5.05 + TURN_COST,
     `THE FIX: the resumed turn's $${TURN_COST} is ADDED — the row reads $${5.05 + TURN_COST} (got $${after.cost}), `
     + 'not the $5.05 a manager read while two more commits were being landed');
  ok(tokensOf(after) === 1000 + TURN_TOK,
     `and its tokens too — ${1000 + TURN_TOK} (got ${tokensOf(after)}), input/output/cache-read/cache-write each`);
  ok(Number(after.input_tokens) === 100 + 1200 && Number(after.cache_read_tokens) === 300 + 90000,
     'every counter separately, not one lump — the dashboard reads them apart');
  ok(after.last_stop_reason === 'end_turn', "…and the turn still ends 'end_turn' (TKT-57's contract)");
  delete process.env.DOCKER_FAKE_SLOW_STDIN_MS;

  // ── C. TWICE IS TWICE, AND NEVER MORE ───────────────────────────────────────────────────────
  console.log('\n── C. a second resume charges a second turn ──');
  await nudge.nudgeXellAfterLand(x1.id, { by: 'human@console' });
  ok(await waitFor(async () => (await burnOf(z1.id)).cost === 5.05 + 2 * TURN_COST),
     `two resumes = two turns: $${(5.05 + 2 * TURN_COST).toFixed(2)} (each turn counted ONCE — intake books a `
     + 'spawn, this books a resume, and no turn goes through both)');
  await idle(z1.id);

  // ── D. THE SIBLINGS: one shared delivery, so every continuation is charged ───────────────────
  console.log('\n── D. the landing-approved nudge is charged the same way ──');
  const x2 = await mkXell('turnacct-landed');
  const z2 = await mkZee(x2.id, { sid: '99999999-6000-4222-8333-444444444444', cost: 0,
                                  input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  await nudge.nudgeXellAfterLand(x2.id, { by: 'human@console' });
  ok(await waitFor(async () => (await burnOf(z2.id)).cost === TURN_COST),
     'a LANDING-APPROVED continuation costs money and now says so (so do the stale, clearance, '
     + 'reflection and fleet-resume nudges: they are the same shared resume)');
  ok(await idle(z2.id), 'and that turn ends idle too');

  // ── E. THE BORING CASES ─────────────────────────────────────────────────────────────────────
  console.log('\n── E. no result, a dead exec, an errored turn ──');
  const x3 = await mkXell('turnacct-silent');
  const z3 = await mkZee(x3.id, { sid: '88888888-6000-4222-8333-444444444444' });
  delete process.env.DOCKER_FAKE_STREAM_JSON;          // a turn that prints no result event at all
  await nudge.nudgeXellAfterLand(x3.id, { by: 'human@console' });
  ok(await idle(z3.id), 'a turn that reports nothing still ends the turn (idle)');
  const silent = await burnOf(z3.id);
  ok(silent.cost === 5.05 && tokensOf(silent) === 1000,
     'and books NOTHING — an unreadable turn must not invent a figure, and must not wipe the row either');

  const x4 = await mkXell('turnacct-deadcage');
  const z4 = await mkZee(x4.id, { sid: '77777777-6000-4222-8333-444444444444' });
  delete process.env.DOCKER_FAKE_STREAM_JSON;
  process.env.DOCKER_FAKE_EXEC_EXIT = '7';             // the resume never runs: no output at all
  await nudge.nudgeXellAfterLand(x4.id, { by: 'human@console' });
  ok(await waitFor(async () => /could not run/.test((await burnOf(z4.id)).last_stop_reason || '')),
     'a resume that could not RUN is recorded as such (TKT-57)');
  const dead = await burnOf(z4.id);
  ok(dead.cost === 5.05 && tokensOf(dead) === 1000,
     '…and is charged NOTHING — a turn that never started spent nothing');

  // …but an exec that DIED AFTER THE TURN SPOKE is not the same thing, and it used to be treated as
  // if it were: the CLI's own result event is on the rejection (dk attaches both streams to err.dk),
  // so the tokens it reports were really spent.
  const x4b = await mkXell('turnacct-spoke-then-died');
  const z4b = await mkZee(x4b.id, { sid: '44444444-6000-4222-8333-444444444444', cost: 0,
                                    input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  process.env.DOCKER_FAKE_STREAM_JSON = RESULT();      // printed, THEN the exec exits non-zero
  await nudge.nudgeXellAfterLand(x4b.id, { by: 'human@console' });
  ok(await waitFor(async () => (await burnOf(z4b.id)).cost === TURN_COST),
     'a resume whose exec died AFTER the turn reported its usage is still charged — "the exec exited '
     + 'non-zero" is not "nothing ran"');
  delete process.env.DOCKER_FAKE_EXEC_EXIT;

  const x5 = await mkXell('turnacct-errored');
  const z5 = await mkZee(x5.id, { sid: '66666666-6000-4222-8333-444444444444', cost: 0,
                                  input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  process.env.DOCKER_FAKE_STREAM_JSON = RESULT({ is_error: true, result: 'rate limited (429)' });
  await nudge.nudgeXellAfterLand(x5.id, { by: 'human@console' });
  ok(await waitFor(async () => (await burnOf(z5.id)).cost === TURN_COST),
     'a turn that ENDED IN AN ERROR is still charged — the tokens were spent either way, and a row '
     + 'that forgets a 429\'s spend understates the burn exactly as this ticket does');
  const errored = await burnOf(z5.id);
  ok(errored.status === 'errored' && /rate limited/.test(errored.last_stop_reason || ''),
     '…and the DEATH is still recorded as a death (the revive ladder\'s own read — the burn is booked '
     + 'in the same statement, not instead of it)');
} finally {
  await cleanup();
  await pool.end().catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);

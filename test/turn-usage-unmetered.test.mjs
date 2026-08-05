// AN UNMETERED TURN IS RECORDED AS UNMETERED, NEVER AS SILENT ZEROS (TKT-99-1390 / TKT-101-C2C6).
//
// ESTABLISHED. Zee 4bd8bcf0 ran 45 minutes of real turns (00:16-01:01Z: 3 work_item_event comments,
// 4 zee_message rows, 5 commits measured from inside the cage) yet its row read cost_usd=0,
// input_tokens=0, output_tokens=0, last_stop_reason=NULL — empty telemetry that reads exactly like
// "never ran", and that already produced one wrong ticket (TKT-98, retracted by TKT-100). TKT-100
// quantified it fleet-wide (opus worst, fable clean) and TKT-101-C2C6 narrowed the mechanism: the
// Langfuse trace and the zee row read the SAME result.usage, so the hole is where result.usage is
// PRODUCED — a turn whose provider/runtime result carries no usage/cost books a silent zero.
//
// WHAT IS FENCED HERE:
//   A. usageFrom tells the caller whether it actually SAW usage data (`metered`), instead of folding
//      "provider reported nothing" into the same all-zero shape as "measured zero". A kimi-shaped
//      result (the adapter SYNTHESIZES it on close, no usage, no cost) is unmetered; a claude result
//      with total_cost_usd is metered; a codex result with tokens but no cost is still metered (the
//      tokens are real).
//   B. turnStopReason appends the marker ' (usage unreported)' to whatever the turn actually ended
//      as — idempotently, and to an ERROR message too, without changing its classification.
//   C. markZeeTurn (the ONE shared turn writer for spawned/resumed/interactive turns) records the
//      marker for an unmetered burn instead of a plain 'end_turn' beside zeros, and ADDS zero rather
//      than erasing a row that already carries earlier turns' burn.
//   D. the marker does not change how a dead turn reads: 'errored' + marker still classifies as the
//      same terminal/transient death the bare error did.
//
// Everything it creates is deleted in a finally, whatever happens.
import { usageFrom, resultFrom, adapterFor } from '../server/src/lib/cxell-runtimes.js';
import { turnStopReason, markZeeTurn } from '../server/src/lib/turn-record.js';
import { classifyStopReason } from '../server/src/lib/delivery-telemetry.js';
import { classifyTurnDeath } from '../server/src/lib/turn-death.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// ── A. THE READER TELLS CALLERS WHETHER IT SAW ANYTHING ────────────────────────────────────────
console.log('\n── A. usageFrom: metered vs silent zeros ──');
const claude = usageFrom({ type: 'result', is_error: false, result: 'done', total_cost_usd: 1.25,
                           usage: { input_tokens: 1200, output_tokens: 340,
                                    cache_read_input_tokens: 90000, cache_creation_input_tokens: 5000 } });
ok(claude.metered === true && claude.cost === 1.25 && claude.input === 1200,
   'a claude result with cost + usage is METERED (the healthy path)');
const kimi = usageFrom({ type: 'result', is_error: false, result: 'done' });
ok(kimi.metered === false && kimi.cost === 0 && kimi.input === 0,
   'a kimi-shaped result (synthesized on close, NO usage, NO cost) is UNMETERED — not a silent zero');
const codex = usageFrom({ type: 'result', is_error: false, result: 'done',
                          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 } });
ok(codex.metered === true && codex.cost === 0 && codex.input === 100,
   'a codex result with tokens but no cost is METERED — the tokens are real even if $ is not reported');
ok(usageFrom(null).metered === false && usageFrom({ usage: {} }).metered === false,
   'no result / an empty usage object is UNMETERED — never "measured zero"');
// And the parse of a real exec output (resultFrom) carries the same flag through to the burn reader.
const parsed = resultFrom(adapterFor('claude-code-cxell'),
  { code: 0, out: `${JSON.stringify({ type: 'result', is_error: false, result: 'x' })}\n` });
ok(usageFrom(parsed).metered === false,
   "a parsed claude result with NO usage stays unmetered — the CLI didn't report it");
const parsedCost = resultFrom(adapterFor('claude-code-cxell'),
  { code: 0, out: `${JSON.stringify({ type: 'result', is_error: false, result: 'x', total_cost_usd: 0.5 })}\n` });
ok(usageFrom(parsedCost).metered === true && usageFrom(parsedCost).cost === 0.5,
   'a parsed claude result WITH cost is metered (the flag rides the parse)');

// ── B. THE MARKER: appended, idempotently, and to an error without changing its class ───────────
console.log('\n── B. turnStopReason: the "usage unreported" marker ──');
ok(turnStopReason('end_turn', true) === 'end_turn', 'a metered turn keeps its plain end');
ok(turnStopReason('end_turn', false) === 'end_turn (usage unreported)',
   'an unmetered turn gets the explicit marker on the stop reason');
ok(turnStopReason('end_turn (usage unreported)', false) === 'end_turn (usage unreported)',
   'applying the marker twice is idempotent (a resumed turn may pass the reason back)');
ok(turnStopReason('API Error: 429 rate_limit_error', false) === 'API Error: 429 rate_limit_error (usage unreported)',
   'an unmetered ERROR turn carries the marker on the error text');
ok(classifyTurnDeath('API Error: 429 rate_limit_error (usage unreported)').signal === '429'
   && classifyStopReason('API Error: 429 rate_limit_error (usage unreported)') === 'transient',
   '…and the suffix changes NO classifier — a 429 is still a transient 429 with the marker on it');

// ── C..D. THE ROW: markZeeTurn books the marker, never a silent zero ───────────────────────────
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
const { q, one, pool } = await import('../server/src/db/pool.js');

const PID = '00000000-0000-4000-8000-0000000fb001';
const cleanup = async () => {
  try { await q(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* already gone */ }
};

try {
  await cleanup();
  await q(`INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'unmetered',$2,'main')`, [PID, '/tmp']);
  const xource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'main') RETURNING *`, [PID]);
  const mkXell = async (slug) => one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, source_coupling, db_coupling, status, worktree_path)
     VALUES ($1,$2,$3,'spinoff/repro','sparse-overlay','db-shared-dev','working','/tmp/unmetered/'||$3) RETURNING *`,
    [PID, xource.id, slug]);
  const mkZee = async (xellId, over = {}) => one(
    `INSERT INTO zee (xell_id, attach_mode, entrypoint, kind, status, model, cost_usd,
                      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
     VALUES ($1,'headless-spawn','cxell-cli','headless','working','opus',
             $2,$3,$4,$5,$6) RETURNING *`,
    [xellId, over.cost ?? 5.05, over.input ?? 100, over.output ?? 200,
     over.cacheRead ?? 300, over.cacheWrite ?? 400]);
  const burnOf = async (id) => one(
    `SELECT status, last_stop_reason, cost_usd::float8 AS cost, input_tokens, output_tokens FROM zee WHERE id=$1`, [id]);

  console.log('\n── C. a METERED turn still books plainly, and ADDS to the row ──');
  const x1 = await mkXell('unmetered-metered');
  const z1 = await mkZee(x1.id);
  const meteredBurn = usageFrom({ type: 'result', is_error: false, result: 'done', total_cost_usd: 1.25,
                                  usage: { input_tokens: 1200, output_tokens: 340 } });
  await markZeeTurn(z1.id, 'idle', 'end_turn', meteredBurn);
  const m = await burnOf(z1.id);
  ok(m.last_stop_reason === 'end_turn', 'a metered turn still ends plain "end_turn"');
  ok(m.cost === 5.05 + 1.25 && Number(m.input_tokens) === 100 + 1200,
     `…and ADDS its burn to the row ($${m.cost}, ${m.input_tokens} in) — the lifetime-burn contract`);

  console.log('\n── D. an UNMETERED turn is marked, never a silent zero, and never erases the row ──');
  const x2 = await mkXell('unmetered-silent');
  const z2 = await mkZee(x2.id);
  // The kimi-shaped turn: it ran (status working) and ended, but its result carries no usage.
  await markZeeTurn(z2.id, 'idle', 'end_turn', usageFrom({ type: 'result', is_error: false, result: 'done' }));
  const s = await burnOf(z2.id);
  ok(s.last_stop_reason === 'end_turn (usage unreported)',
     "THE FIX: an unmetered turn ends 'end_turn (usage unreported)' — the exact row that used to read "
     + "'end_turn' beside zeros and pass for 'never ran' (got " + JSON.stringify(s.last_stop_reason) + ')');
  ok(s.cost === 5.05 && Number(s.input_tokens) === 100,
     '…and the existing burn is PRESERVED, not overwritten with a claimed measured zero');
  ok(s.status === 'idle', '…and the turn still ends (idle) — the TKT-57 contract is untouched');

  // An unmetered turn that DIED still carries the marker on the death, and still reads as that death.
  console.log('\n── D2. an unmetered DEATH is marked and still classifies ──');
  const x3 = await mkXell('unmetered-dead');
  const z3 = await mkZee(x3.id, { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  await markZeeTurn(z3.id, 'errored', 'API Error: 429 rate_limit_error', usageFrom({ type: 'result', is_error: true, result: 'API Error: 429 rate_limit_error' }));
  const d = await burnOf(z3.id);
  ok(/API Error: 429 rate_limit_error \(usage unreported\)/.test(d.last_stop_reason || ''),
     'an unmetered death keeps the marker on the error text');
  ok(classifyTurnDeath(d.last_stop_reason).signal === '429'
     && classifyStopReason(d.last_stop_reason) === 'transient',
     '…and still classifies as the transient 429 it was — the revive ladder is not fooled by the suffix');
} finally {
  await cleanup();
  await pool.end().catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);

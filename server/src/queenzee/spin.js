// THE SPIN DETECTOR LOOP — end a turn that is burning tokens on a poll loop, and tell its manager.
//
// Every OPEN turn (zee_turn status='started' behind a zee that is mid-turn) is judged against the
// gateway ledger the queenzee already writes (llm_gateway_request, 154): calls and tokens per
// turn_id are one query. When lib/spin-detector.js says the turn is repetition-without-progress
// (same path, similar payload sizes, no intervening working/report/land), this loop ENDS the turn —
// books the end, records why, interrupts the CLI so it stops burning, and reports to the xell's
// manager (or raises a tend when there is none). It NEVER reaps the zee: the cage, the branch, the
// commits and the containers all stay, for a human/manager to decide.
//
// RULES IT MUST NOT BREAK (the same shape as queenzee/revive.js — a sweep that writes OTHER zees'
// rows):
//   – never in a nested queenzee: PROVISION_MODE decides, exactly as it does for the reviver. A
//     nested queenzee's meta-DB is a CLONE of the fleet's, so every open turn in it belongs to
//     somebody else — ending one would be sabotaging a live zee.
//   – never a decommissioned zee, and never a retired / tearing-down / husk xell (the sweep WHERE).
//   – never under a fleet pause (a paused zee has no turn in flight to spin; the WHERE excludes it
//     because a paused turn's zee is idle).
//   – a turn is judged once: the sweep only selects status='started', and ending it flips that.
//
// Cheap to remove: the whole feature is this loop + lib/spin-detector.js + migration 158. Delete
// all three and the gateway ledger, the turn rows and the manager messages are untouched.
import { q, one } from '../db/pool.js';
import { logline } from '../lib/logbus.js';
import { interruptCxellZee } from '../lib/cxell.js';
import { detectSpin, spinConfigFor, lastProgressAtForTurn, endSpinningTurn } from '../lib/spin-detector.js';

// Same switch every other real-side-effect module reads. A spin end writes rows and (in real mode)
// interrupts a CLI in a cage named off a fleet row — in a NESTED queenzee that row is another zee's
// live cage. See startSpinDetector().
const PROVISION_MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';
const TICK_MS = Number(process.env.SPIN_DETECTOR_TICK_MS) || 60000;

// The turn's burn off the ledger, as the usageFrom() shape endSpinningTurn expects. Returns a plain
// object of Numbers. Never throws (a burn probe must not fail the sweep).
async function ledgerBurnForTurn(turnId) {
  try {
    const rows = await q(
      `SELECT COALESCE(SUM(input_tokens),0)::bigint AS input,
              COALESCE(SUM(output_tokens),0)::bigint AS output,
              COALESCE(SUM(cache_read_tokens),0)::bigint AS cache_read,
              COALESCE(SUM(cache_write_tokens),0)::bigint AS cache_write,
              COALESCE(SUM(cost_usd),0)::numeric AS cost
         FROM llm_gateway_request WHERE turn_id=$1`, [turnId]);
    const r = rows[0] || {};
    return { cost: Number(r.cost || 0), input: Number(r.input || 0), output: Number(r.output || 0),
             cacheRead: Number(r.cache_read || 0), cacheWrite: Number(r.cache_write || 0) };
  } catch (e) {
    logline('spin', `ledgerBurnForTurn failed (${String(e.message).slice(0, 120)})`);
    return { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }
}

// One sweep: judge every open turn, end the ones that are spinning. Returns the number ended.
export async function spinTick() {
  const turns = await q(
    `SELECT t.id AS turn_id, t.zee_id, t.xell_id, t.started_at, t.kind,
            z.status AS zee_status, z.entrypoint,
            x.slug, x.project_id, x.harness_id, x.manager_xell_id, x.status AS xell_status
       FROM zee_turn t
       JOIN zee z ON z.id = t.zee_id
       JOIN xell x ON x.id = t.xell_id
      WHERE t.status = 'started'
        AND z.status IN ('spawning','online','working')
        AND x.status NOT IN ('retired','tearing-down','husk')`);
  if (!turns.length) return { checked: 0, ended: 0 };

  let ended = 0;
  for (const t of turns) {
    try {
      // The turn's gateway calls — the one query the card promised. No calls → nothing to judge.
      const requests = await q(
        `SELECT path, total_tokens, requested_at FROM llm_gateway_request
          WHERE turn_id=$1 ORDER BY requested_at ASC`, [t.turn_id]);
      if (!requests?.length) continue;

      const cfg = await spinConfigFor({ projectId: t.project_id, harnessId: t.harness_id });
      if (!cfg.enabled) continue;

      const lastProgressAt = await lastProgressAtForTurn({
        xellId: t.xell_id, startedAt: t.started_at,
      });
      const verdict = detectSpin({ requests, lastProgressAt, cfg });
      if (!verdict.spinning) continue;

      // SPIN. End it, record why, tell the manager, and stop the CLI (not a reap).
      const manager = t.manager_xell_id
        ? await one(`SELECT * FROM xell WHERE id=$1 AND status <> 'retired'`, [t.manager_xell_id]).catch(() => null)
        : null;
      const outcome = await endSpinningTurn({
        turn: { id: t.turn_id },
        zee: { id: t.zee_id },
        xell: { id: t.xell_id, slug: t.slug, project_id: t.project_id },
        burn: await ledgerBurnForTurn(t.turn_id),
        evidence: { windowCalls: verdict.windowCalls, windowTokens: verdict.windowTokens,
                    maxSizeRatio: verdict.maxSizeRatio, samePath: verdict.samePath },
        manager, by: 'spin-detector',
      });

      if (PROVISION_MODE === 'real' && t.slug) {
        try {
          const r = await interruptCxellZee({ slug: t.slug });
          outcome.interrupted = r.stopped;
          logline('spin', r.idle
            ? `${t.slug}: spin-ended, but no CLI was in flight to interrupt`
            : `${t.slug}: spinning CLI interrupted (${r.how}) — cage left up, not reaped`);
        } catch (e) {
          logline('spin', `${t.slug}: could not interrupt the spinning CLI (${String(e.message).slice(0, 120)}) `
            + '— the turn is booked ended and the manager told; the CLI may still be burning');
        }
      }

      ended++;
      logline('spin', `${t.slug}: SPIN detected — turn ${String(t.turn_id).slice(0, 8)} ENDED `
        + `(${verdict.windowCalls} calls / ${verdict.windowTokens} tokens, max/min ${verdict.maxSizeRatio.toFixed(2)}, `
        + `${manager ? `manager ${manager.slug} notified` : 'tend raised (no manager)'}, `
        + `interrupted=${outcome.interrupted === true ? 'yes' : 'no'})`);
    } catch (e) {
      logline('spin', `turn ${String(t.turn_id).slice(0, 8)} could not be judged (${String(e.message).slice(0, 140)})`);
    }
  }
  return { checked: turns.length, ended };
}

export function startSpinDetector() {
  if (process.env.SPIN_DETECTOR_ENABLED === 'false') {
    console.log('[queenzee] spin detector DISABLED (SPIN_DETECTOR_ENABLED=false)');
    return null;
  }
  // A NESTED QUEENZEE MUST NOT END A REAL ZEE'S TURN. Its meta-DB is a CLONE of the fleet's, so
  // every open turn in it is somebody else's, and ending one would book a fake end on a live zee.
  // Same gate as the reviver: refuse to start the loop at all rather than risk it.
  if (PROVISION_MODE !== 'real') {
    console.log('[queenzee] spin detector DISABLED — PROVISION_MODE=simulate (this queenzee models the fleet)');
    return null;
  }
  const tick = () => spinTick().catch((e) => console.error('[spin] tick:', e.message));
  tick();
  setInterval(tick, TICK_MS);
  console.log(`[queenzee] spin detector started (${TICK_MS}ms) — ends turns that repeat gateway calls without progress`);
  return true;
}

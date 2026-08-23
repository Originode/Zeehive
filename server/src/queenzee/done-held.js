// HELD-DONE REAPER — applies a done approval the human made while the xell was mid-turn.
//
// A human (or the auto-done policy) approving a done suggestion whose target is mid-turn cannot be
// carried out: reapXell refuses (never tear down a live turn). The decision is not thrown away — it
// is recorded as 'approved-held' (managers.js refuseApproval, ticket #75) and THIS loop applies it
// the moment the turn ends.
//
// reapXell already answers "is a turn in flight?" (reaper.js midTurnVerdict), so the loop is just a
// periodic re-attempt: each tick asks applyHeldDoneSuggestion() for every held row. The apply path
// is the SAME one the human's approve click takes (markTaskDone / reapXell), so a held decision and
// a fresh one close a xell identically. A row that is still mid-turn stays 'approved-held' and is
// re-checked next tick; the manager is told once at hold time and once at apply time, never per tick.
//
// Same shape as queenzee/worksync.js: a pure-script tick, loud in the log, disabled with
// DONE_HELD_ENABLED=false, and every failure isolated per row so one bad row cannot stop the sweep.
import { q } from '../db/pool.js';
import { logline } from '../lib/logbus.js';
import { applyHeldDoneSuggestion } from '../lib/managers.js';

// One sweep: re-attempt every 'approved-held' suggestion whose target still exists. Returns a
// summary so a caller (or a test) can assert on it without reading the log.
export async function heldDoneTick() {
  const held = await q(
    `SELECT ds.id, ds.target_slug, ds.manager_slug
       FROM done_suggestion ds
       JOIN xell x ON x.id = ds.target_xell_id
      WHERE ds.status = 'approved-held' AND ds.dismissed_at IS NULL
        AND x.status <> 'retired'
      ORDER BY ds.decided_at ASC NULLS LAST, ds.requested_at ASC
      LIMIT 25`);
  if (!held.length) return { scanned: 0, applied: 0, held: 0 };

  let applied = 0, still = 0;
  for (const h of held) {
    try {
      const r = await applyHeldDoneSuggestion(h.id);
      if (r?.applied) applied++;
      else still++;
    } catch (e) {
      logline('done-held', `held suggestion for ${h.target_slug} could not be applied: ${e.message}`);
      still++;
    }
  }
  if (applied) logline('done-held', `applied ${applied}/${held.length} held done approval(s)`);
  return { scanned: held.length, applied, held: still };
}

export function startHeldDoneReaper() {
  if (process.env.DONE_HELD_ENABLED === 'false') {
    console.log('[queenzee] held-done reaper DISABLED (DONE_HELD_ENABLED=false)');
    return null;
  }
  const interval = Number(process.env.DONE_HELD_INTERVAL_MS) || 15000;
  console.log(`[queenzee] held-done reaper started (${interval}ms)`);
  const tick = () => heldDoneTick().catch((e) => console.error('[done-held]', e.message));
  setTimeout(tick, 5000);   // let the API and the first fleet reads settle
  return setInterval(tick, interval);
}

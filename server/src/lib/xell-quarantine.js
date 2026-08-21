// QUARANTINE A XELL AFTER CONSECUTIVE TURN DEATHS (ticket #81).
//
// THE INCIDENT (the card this ticket was cut from): three zees died in a row on one xell — ~$14
// burned, 468 lines never landed — and every recovery path (swap, re-dispatch) happily started
// another agent in the same unhealthy cage, because nothing had ever counted how many times a CAGE
// had killed its zee. The zee row is replaced on every swap, so the streak has to live on the XELL:
// it is the cage that is sick, not any one agent in it.
//
// THE COUNTER. `xell.consecutive_deaths` (migration 216) is the streak of consecutive turn DEATHS
// on the cage. A death is a turn the classifier (lib/turn-death.js) filed as anything but 'none' —
// transient/terminal/unknown, i.e. a turn that did NOT end on a decision of the zee's. A healthy end
// RESETS it to 0 (resetXellConsecutiveDeaths, called from intake.js the moment a turn closes
// 'ended'), because the cage demonstrably carried a zee through a full turn. A fleet-pause leaves it
// UNCHANGED: a pause neither proves the cage healthy nor is it a death, and allowing it to reset the
// streak would let a pause launder a death run.
//
// THE THRESHOLD. QUARANTINE_AFTER_DEATHS = 2. One death is every-day provider weather (a 429 here,
// a killed process there) and does not name the cage. Two in a row means the cage has now killed two
// consecutive agents — the exact pattern of the incident — and the odds that a third will be different
// are not worth the burn and the unlanded work. Three (the incident's own count) is too late by one:
// the card's own cost accounting says the second death is already ~$14 down with 468 lines at risk.
//
// ONCE QUARANTINED, the xell is refused by EVERY spawn/recovery path (dispatch, claim, swap, revive,
// pool pick) until a human decides between rescuing the branch and reaping the cage. The refusal is
// loud, and the quarantine is NEVER silent: the moment it fires, a tend is raised naming the count,
// the last death, and the crew read model's landings + diff — the unlanded work a human must see
// before choosing. Clearing it is an explicit human act (clearXellQuarantine / the console's
// "rescue" action), which is the "rescue the branch" arm; reapXell is the "reap the cage" arm.
import { existsSync } from 'node:fs';
import { q, one } from '../db/pool.js';
import { logline } from './logbus.js';
import { setTend } from './status.js';
import { worktreeDiff } from './git.js';
import { cxellDiff } from './cxell.js';

// 2 is defensible — see the header. The incident (3 deaths) is the upper bound: quarantining at 3
// would have let the SAME xell burn a third agent and risk the same 468 lines the card was cut over.
export const QUARANTINE_AFTER_DEATHS = 2;

// Pure — the verdict. Kept separate from the DB write so a test (and a console "what if") can ask
// "does this streak fire?" without touching the fleet.
export function decideXellQuarantine({ consecutive_deaths = 0 } = {}) {
  const count = Math.max(0, Number(consecutive_deaths) || 0);
  return { quarantine: count >= QUARANTINE_AFTER_DEATHS, count };
}

// Pure — the refusal sentence every guard returns. `xell` is a row that may or may not be
// quarantined; returns null (carry on) when it is not.
export function xellQuarantineRefusal(xell = {}) {
  if (!xell?.quarantined_at) return null;
  const n = xell.quarantine_deaths || QUARANTINE_AFTER_DEATHS;
  return `${xell.slug || 'this xell'} is QUARANTINED after ${n} consecutive turn deaths`
    + ` — it will NOT be given another agent until a human decides between rescuing the branch`
    + ` (clear the quarantine, then re-dispatch) and reaping the cage (its worktree + branch are deleted).`
    + (xell.quarantine_reason ? ` ${xell.quarantine_reason}` : '');
}

// ── the unlanded-work brief the card is REQUIRED to show ─────────────────────────────────────────
// The same read model crewFor (lib/managers.js) gives a manager: the land ledger (what reached
// main) + the source diff (what has not), asked of the cxell first (a caged zee commits in its
// private clone; the host worktree stays frozen until a land/build collects it) and the host
// worktree second. null (not silently 0) when neither can be measured.
export async function quarantineBrief(xellId) {
  const row = await one(
    `SELECT x.id, x.slug, x.worktree_path, x.head_commit, p.main_branch
       FROM xell x JOIN project p ON p.id = x.project_id
      WHERE x.id = $1`, [xellId]).catch(() => null);
  if (!row) return { landings: null, diff: null };
  const [lands, d] = await Promise.all([
    one(`SELECT count(*)::int AS n, max(new_sha) AS last_sha, max(landed_at) AS last_at
           FROM land_request WHERE xell_id=$1 AND status='landed'`, [xellId]).catch(() => null),
    (async () => {
      let diff = null;
      if (row.head_commit) {
        diff = await cxellDiff({ ctx: 'default', slug: row.slug, base: row.head_commit }).catch(() => null);
        if (diff) diff.source = 'cxell';
      }
      if (!diff && row.worktree_path && existsSync(row.worktree_path)) {
        diff = await worktreeDiff(row.worktree_path, row.main_branch || 'main').catch(() => null);
        if (diff) diff.source = 'worktree';
      }
      return diff;
    })(),
  ]);
  return {
    landings: { count: lands?.n || 0, last_sha: lands?.last_sha || null, landed_at: lands?.last_at || null },
    diff: d ? { ahead: d.ahead || 0, dirty: d.dirty || 0, files: d.files || 0,
                insertions: d.insertions || 0, deletions: d.deletions || 0,
                head: d.head || null, source: d.source } : null,
  };
}

// The human sentence a quarantined xell's tend carries: the count, what died, and — because the
// card's whole point is "show what is unlanded before anyone reaps it" — what has and has not landed.
export function quarantineTendReason({ slug, count, death = {}, reason = '', brief = null } = {}) {
  const landed = brief?.landings?.count ?? 0;
  const d = brief?.diff;
  const unlanded = d
    ? (d.files > 0
        ? `${d.ahead} commit(s) ahead, ${d.files} file(s), +${d.insertions}/−${d.deletions}`
        : (d.dirty > 0
            ? `${d.dirty} dirty file(s), no committed diff against source`
            : 'no unlanded diff against source (the work may already be landed)'))
    : 'unlanded work could NOT be measured (its cage/worktree is gone)';
  const diedOn = death.signal || death.kind || 'a turn death';
  const quoted = String(reason || '').replace(/\s+/g, ' ').slice(0, 240);
  return `${slug} is QUARANTINED after ${count} consecutive turn deaths (last: ${diedOn}). `
    + `What has NOT landed: ${landed} landing(s), ${unlanded}. `
    + `No new agent will be fed into it until a human decides — REAP it (worktree + branch deleted) or `
    + `RESCUE the branch (clear the quarantine, then re-dispatch).`
    + (quoted ? ` The last death said: "${quoted}".` : '');
}

// Called from noteTurnDeath (revive.js) the moment a turn death is filed. Best-effort and NEVER
// throws (it hangs off the same completion handler noteTurnDeath hangs off — the zee's turn ending
// must not depend on this bookkeeping succeeding). Returns { count, quarantined, already, slug }.
//
// When the streak crosses the threshold it ALSO stamps the quarantine columns and raises the tend —
// so the caller does not need to remember that a crossing is a quarantine; bump IS the quarantine.
export async function bumpXellConsecutiveDeaths({ xellId, death = {}, reason = '', source = 'turn' } = {}) {
  if (!xellId) return { count: 0, quarantined: false, already: false, slug: null };
  try {
    const row = await one(
      `UPDATE xell SET consecutive_deaths = consecutive_deaths + 1
        WHERE id = $1
        RETURNING consecutive_deaths, quarantined_at, quarantine_deaths, slug`, [xellId]);
    if (!row) return { count: 0, quarantined: false, already: false, slug: null };
    const { quarantine, count } = decideXellQuarantine({ consecutive_deaths: row.consecutive_deaths });
    if (!quarantine) {
      logline('quarantine', `${row.slug}: turn death #${count} (${death.signal || death.kind}) — `
        + `${QUARANTINE_AFTER_DEATHS - count} more before the cage is quarantined`);
      return { count, quarantined: false, already: false, slug: row.slug };
    }
    // Already quarantined: a late death (a resumed turn dying after the threshold) updates the count
    // but must not re-stamp or re-tend — the human already has the card.
    if (row.quarantined_at) {
      logline('quarantine', `${row.slug}: turn death #${count} (${death.signal || death.kind}) — already QUARANTINED`);
      return { count, quarantined: true, already: true, slug: row.slug };
    }
    const brief = await quarantineBrief(xellId).catch(() => null);
    const why = quarantineTendReason({ slug: row.slug, count, death, reason, brief });
    // The conditional stamp (quarantined_at IS NULL) makes the quarantine a one-shot even if two
    // deaths race the same tick; only the winner raises the tend.
    const stamped = await one(
      `UPDATE xell SET quarantined_at = now(), quarantine_deaths = $2, quarantine_reason = $3
        WHERE id = $1 AND quarantined_at IS NULL RETURNING id`, [xellId, count, why]).catch(() => null);
    if (stamped) {
      await setTend(xellId, true, { reason: why, source: 'queenzee' }).catch(() => {});
      logline('quarantine', `${row.slug}: QUARANTINED after ${count} consecutive turn deaths `
        + `(${death.signal || death.kind}) — a human must decide between rescue and reap: ${why}`);
    }
    return { count, quarantined: true, already: false, slug: row.slug };
  } catch (e) {
    logline('quarantine', `could not bump consecutive deaths for xell ${String(xellId).slice(0, 8)} `
      + `(${String(e.message).slice(0, 140)})`);
    return { count: 0, quarantined: false, already: false, slug: null };
  }
}

// Called on a healthy turn end — intake.js the moment a turn closes 'ended' (a real end_turn, or a
// spin-detector end, which is a deliberate non-death: the turn row says 'ended', the zee goes idle,
// so the cage demonstrably did not kill the agent and the streak is honestly broken). Does NOT clear
// an existing quarantine — that is the human's explicit rescue call — because a cage that killed two
// agents does not become un-quarantined by a turn that somehow ended cleanly after the fact.
export async function resetXellConsecutiveDeaths(xellId) {
  if (!xellId) return;
  try {
    await one(`UPDATE xell SET consecutive_deaths = 0 WHERE id = $1`, [xellId]);
  } catch (e) {
    logline('quarantine', `could not reset consecutive deaths for xell ${String(xellId).slice(0, 8)} `
      + `(${String(e.message).slice(0, 140)})`);
  }
}

// THE HUMAN'S RESCUE ARM. Explicitly clears a quarantine so a fresh agent can be dispatched into the
// cage. Returns { ok, cleared, was_quarantined, slug }.
export async function clearXellQuarantine(xellId, { by = 'human@console' } = {}) {
  if (!xellId) return { ok: false, error: 'xellId required' };
  try {
    // Read the OLD stamp first: RETURNING would give the post-UPDATE row (quarantined_at already
    // NULL), so it could never tell us whether a quarantine actually existed to clear.
    const before = await one(`SELECT slug, quarantined_at FROM xell WHERE id=$1`, [xellId]).catch(() => null);
    if (!before) return { ok: false, error: 'xell not found' };
    const was = !!before.quarantined_at;
    await one(
      `UPDATE xell
          SET quarantined_at = NULL, quarantine_reason = NULL, quarantine_deaths = NULL,
              consecutive_deaths = 0
        WHERE id = $1`, [xellId]);
    if (was) {
      await setTend(xellId, false, { reason: `quarantine cleared by ${by} — the cage may take an agent again`, source: 'queenzee' }).catch(() => {});
      logline('quarantine', `${before.slug}: QUARANTINE CLEARED by ${by} — the cage may take an agent again`);
    }
    return { ok: true, cleared: was, was_quarantined: was, slug: before.slug };
  } catch (e) {
    logline('quarantine', `could not clear the quarantine of xell ${String(xellId).slice(0, 8)} `
      + `(${String(e.message).slice(0, 140)})`);
    return { ok: false, error: e.message };
  }
}

export default {
  QUARANTINE_AFTER_DEATHS, decideXellQuarantine, xellQuarantineRefusal, quarantineBrief,
  quarantineTendReason, bumpXellConsecutiveDeaths, resetXellConsecutiveDeaths, clearXellQuarantine,
};

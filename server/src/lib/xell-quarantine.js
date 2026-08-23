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
// WHAT THE COUNTER READS FROM — and the blind-death audit beside it. `consecutive_deaths` is fed
// ONLY through noteTurnDeath (revive.js), the classifier's choke point. That is deliberate: it is
// the only signal whose RESET is tied to actual turn outcomes, and where the death policy already
// lives. But it is not the whole truth, and saying "the cage has N deaths" off it alone would
// UNDERCOUNT by exactly the paths that write status='errored' without ever reaching the classifier
// (a separate defect — the headless stream catch, the headless spawn timeout, a cxell build/spawn
// failure, a remote spawn failure, the langchain driver). Those are the ugly ones: a cage that dies
// at SPAWN twice in a row is the precise case quarantine exists for. So the QUARANTINE TRIGGER is
// the union of the classified streak and a ledger-derived BLIND count (xellBlindDeathCount): errored
// exits since the last clean turn/unquarantine that have NO turn-death event — the only durable
// record those paths leave. The card always says how many of its count were classified and how many
// were seen only via the ledger, so the number never looks more complete than it is. Why not
// recompute the whole streak from zee rows instead? A zee row hosts MANY turns (the revive ladder:
// three deaths on one row), a swap retires only live-status zees, and revive_class_source is the
// provenance of CLASSIFICATION, not a death ledger — the bypassed rows are source NULL, the same
// value a healthy finish has. A recompute would trade a known undercount for a different, hidden one.
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
//
// `classified` and `blind` name WHERE the deaths were seen, so the number never looks more complete
// than it is (the counter's known limit): classified deaths went through the classifier's choke
// point (noteTurnDeath); blind ones were errored exits the classifier never saw — counted only via
// the ledger (zee_turn/zee status), which is all those paths leave. `count` is their sum, the thing
// the threshold is judged on.
export function quarantineTendReason({ slug, count, classified = count, blind = 0, death = {}, reason = '', brief = null } = {}) {
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
  const provenance = blind > 0
    ? ` (${classified} via the classifier, ${blind} seen only via the ledger — those deaths never reached the classifier)`
    : ' (all via the classifier)';
  const quoted = String(reason || '').replace(/\s+/g, ' ').slice(0, 240);
  return `${slug} is QUARANTINED after ${count} consecutive turn deaths (last: ${diedOn})${provenance}. `
    + `What has NOT landed: ${landed} landing(s), ${unlanded}. `
    + `No new agent will be fed into it until a human decides — REAP it (worktree + branch deleted) or `
    + `RESCUE the branch (clear the quarantine, then re-dispatch).`
    + (quoted ? ` The last death said: "${quoted}".` : '');
}

// THE BLIND-DEATH AUDIT — the counter's other half (see the header).
//
// Where a death bypasses the classifier (noteTurnDeath), the classified streak cannot see it — and
// a counter that read only noteTurnDeath would let a cage die at SPAWN twice in a row without ever
// firing, the exact quarantine the incident demands. Those paths still leave durable records: an
// errored zee_turn (intake.js's headless stream catch) or an errored zee with no turn at all (the
// spawn/build/remote failures, the langchain driver). This counts those errored exits since the last
// RESET POINT — a clean 'ended' turn, a 'none'-classified death, or a quarantine clear (all three
// are exactly what resets the classified streak, so the two counters share one window and move
// together). An exit that HAS a turn-death event is the classified streak's business; this counts
// only the ones the classifier never saw, so the two never double-count.
//
// ⚠ THE SOURCE OF TRUTH FOR "THIS TURN DIED" IS `status='errored'` — the EXPLICIT death signal the
// turn machinery writes (intake.js endTurn(status:'errored'), the zee row's status='errored'). It is
// NEVER `ended_at IS NULL` or `status='started'` as a proxy for a bad ending. The live meta-DB leaks
// OPEN zee_turn rows — 104 with ended_at IS NULL / status='started' as of 2026-08-21, most on
// already-'retired' xells, some open for weeks — and that is PURE BOOKKEEPING RESIDUE, not death
// evidence: a turn that never ended is not a turn that died. 'errored' is only ever written ON
// PURPOSE, by the code that closed a turn on a death, so it is the one status no leak produces. Do
// not "simplify" this query to count non-ended turns — it would quarantine healthy xells.
//
// `exceptZeeId` is the zee a death is CURRENTLY being classified for (noteTurnDeath → bump): its
// errored rows already exist (intake writes them before the classifier runs) but its turn-death
// event is not written yet, so without the exclusion the audit would count the in-flight death as
// blind and double it into a premature quarantine. Excluding the whole zee is safe — a blind death
// schedules no revive and ends the zee, so a zee being classified now hosts no earlier blind deaths
// worth counting.
//
// NEVER THROWS, best-effort like the rest of this file.
export async function xellBlindDeathCount(xellId, { exceptZeeId = null } = {}) {
  if (!xellId) return { blind: 0, reset: null };
  try {
    const row = await one(`
      WITH reset AS (
        SELECT GREATEST(
          COALESCE((SELECT MAX(t.ended_at) FROM zee_turn t WHERE t.xell_id = $1 AND t.status = 'ended'),
                   '-infinity'::timestamptz),
          COALESCE((SELECT MAX(se.ts) FROM session_event se
                     WHERE se.xell_id = $1 AND se.hook_event_name = 'turn-death' AND se.stop_reason = 'none'),
                   '-infinity'::timestamptz),
          COALESCE((SELECT MAX(se.ts) FROM session_event se
                     WHERE se.xell_id = $1 AND se.hook_event_name = 'tend-clear'
                       AND se.raw->>'reason' ILIKE 'quarantine cleared%'),
                   '-infinity'::timestamptz)
        ) AS ts
      )
      SELECT
        (SELECT count(*)::int FROM zee_turn t
          WHERE t.xell_id = $1 AND t.status = 'errored' AND t.ended_at > (SELECT ts FROM reset)
            AND t.zee_id IS DISTINCT FROM $2
            AND NOT EXISTS (SELECT 1 FROM session_event se
                             WHERE se.turn_id = t.id AND se.hook_event_name = 'turn-death'))
        + (SELECT count(*)::int FROM zee z
          WHERE z.xell_id = $1 AND z.status = 'errored' AND z.created_at > (SELECT ts FROM reset)
            AND z.id IS DISTINCT FROM $2
            AND NOT EXISTS (SELECT 1 FROM zee_turn t WHERE t.zee_id = z.id AND t.status = 'errored')
            AND NOT EXISTS (SELECT 1 FROM session_event se
                             WHERE se.zee_id = z.id AND se.hook_event_name = 'turn-death'))
        AS blind,
        (SELECT ts FROM reset) AS reset
    `, [xellId, exceptZeeId || null]).catch(() => null);
    return { blind: row?.blind || 0, reset: row?.reset || null };
  } catch (e) {
    logline('quarantine', `could not audit blind deaths for xell ${String(xellId).slice(0, 8)} `
      + `(${String(e.message).slice(0, 140)})`);
    return { blind: 0, reset: null };
  }
}

// THE ONE place a quarantine actually gets STAMPED — the conditional UPDATE (quarantined_at IS
// NULL) makes it a one-shot even if two writers race the same tick, and only the winner raises the
// tend. Shared by bumpXellConsecutiveDeaths (a classified death crossed the threshold) and
// quarantineFromBlindAudit (the pool sweep saw the cage die blindly). Never throws.
async function stampQuarantine({ xellId, slug, count, classified = count, blind = 0,
                                 death = {}, reason = '', source = 'turn' }) {
  const brief = await quarantineBrief(xellId).catch(() => null);
  const why = quarantineTendReason({ slug, count, classified, blind, death, reason, brief });
  const stamped = await one(
    `UPDATE xell SET quarantined_at = now(), quarantine_deaths = $2, quarantine_reason = $3
      WHERE id = $1 AND quarantined_at IS NULL RETURNING id`, [xellId, count, why]).catch(() => null);
  if (stamped) {
    await setTend(xellId, true, { reason: why, source: 'queenzee' }).catch(() => {});
    logline('quarantine', `${slug}: QUARANTINED after ${count} consecutive turn deaths `
      + `(${death.signal || death.kind}${blind ? `, ${blind} via the ledger` : ''}) — a human must decide `
      + `between rescue and reap: ${why}`);
  }
  return !!stamped;
}

// Called from noteTurnDeath (revive.js) the moment a turn death is filed. Best-effort and NEVER
// throws (it hangs off the same completion handler noteTurnDeath hangs off — the zee's turn ending
// must not depend on this bookkeeping succeeding). Returns { count, quarantined, already, slug }.
//
// When the streak crosses the threshold it ALSO stamps the quarantine columns and raises the tend —
// so the caller does not need to remember that a crossing is a quarantine; bump IS the quarantine.
// The threshold is judged on the UNION of the classified streak and the blind audit: a cage with
// one classified death and one blind death has killed two agents even though the classifier only
// saw one of them.
// `zeeId` is the zee whose death is being filed — passed through as the audit's exceptZeeId so the
// in-flight death (already written 'errored' by intake, but its turn-death event not yet recorded)
// is not double-counted as a blind death.
export async function bumpXellConsecutiveDeaths({ xellId, zeeId = null, death = {}, reason = '', source = 'turn' } = {}) {
  if (!xellId) return { count: 0, quarantined: false, already: false, slug: null };
  try {
    const row = await one(
      `UPDATE xell SET consecutive_deaths = consecutive_deaths + 1
        WHERE id = $1
        RETURNING consecutive_deaths, quarantined_at, quarantine_deaths, slug`, [xellId]);
    if (!row) return { count: 0, quarantined: false, already: false, slug: null };
    const { blind } = await xellBlindDeathCount(xellId, { exceptZeeId: zeeId });
    const count = row.consecutive_deaths + blind;
    const { quarantine } = decideXellQuarantine({ consecutive_deaths: count });
    if (!quarantine) {
      logline('quarantine', `${row.slug}: turn death #${row.consecutive_deaths} (${death.signal || death.kind})`
        + (blind ? ` + ${blind} blind via the ledger` : '')
        + ` — ${Math.max(QUARANTINE_AFTER_DEATHS - count, 0)} more before the cage is quarantined`);
      return { count, quarantined: false, already: false, slug: row.slug };
    }
    // Already quarantined: a late death (a resumed turn dying after the threshold) updates the count
    // but must not re-stamp or re-tend — the human already has the card.
    if (row.quarantined_at) {
      logline('quarantine', `${row.slug}: turn death #${count} (${death.signal || death.kind}) — already QUARANTINED`);
      return { count, quarantined: true, already: true, slug: row.slug };
    }
    const stamped = await stampQuarantine({ xellId, slug: row.slug, count,
      classified: row.consecutive_deaths, blind, death, reason, source });
    return { count, quarantined: stamped || true, already: false, slug: row.slug };
  } catch (e) {
    logline('quarantine', `could not bump consecutive deaths for xell ${String(xellId).slice(0, 8)} `
      + `(${String(e.message).slice(0, 140)})`);
    return { count: 0, quarantined: false, already: false, slug: null };
  }
}

// THE ALL-BLIND ARM — the pool sweep calls this on the xells it can see (the ready list), because a
// cage that dies at SPAWN twice in a row is released back to 'ready' and the classified streak never
// moves for it: noteTurnDeath is never called on those paths. This is what makes "a quarantine that
// silently never fires" impossible — it sums the classified streak with the blind audit and stamps
// the quarantine when the union crosses the threshold. A quarantined xell is left alone (already).
// Returns { quarantine, count, blind, already, slug }.
export async function quarantineFromBlindAudit(xellId) {
  if (!xellId) return { quarantine: false, count: 0, blind: 0, already: false, slug: null };
  try {
    const row = await one(
      `SELECT slug, consecutive_deaths, quarantined_at FROM xell WHERE id=$1`, [xellId]);
    if (!row) return { quarantine: false, count: 0, blind: 0, already: false, slug: null };
    if (row.quarantined_at) return { quarantine: true, count: 0, blind: 0, already: true, slug: row.slug };
    const { blind } = await xellBlindDeathCount(xellId);
    const classified = row.consecutive_deaths || 0;
    const count = classified + blind;
    if (!decideXellQuarantine({ consecutive_deaths: count }).quarantine) {
      return { quarantine: false, count, blind, already: false, slug: row.slug };
    }
    const stamped = await stampQuarantine({ xellId, slug: row.slug, count, classified, blind,
      death: { signal: 'ledger', kind: 'unknown' },
      reason: `repeated errored exits that never reached the turn-death classifier — seen only via `
              + `the zee/zee_turn ledger`, source: 'pool' });
    return { quarantine: stamped || true, count, blind, already: false, slug: row.slug };
  } catch (e) {
    logline('quarantine', `could not quarantine from the blind-death audit for xell `
      + `${String(xellId).slice(0, 8)} (${String(e.message).slice(0, 140)})`);
    return { quarantine: false, count: 0, blind: 0, already: false, slug: null };
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
  xellBlindDeathCount, quarantineFromBlindAudit,
};

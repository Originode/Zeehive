// SHIP DIRECTION — a ship may never roll PRODUCTION BACKWARDS.
//
// THE INCIDENT (2026-08-23). A ship requested at 16:26 for commit eed2ffb8 was approved at 17:15 —
// 49 minutes later. In that window two NEWER ships completed (e708af96 at 16:42, fd5a3855 at 17:08).
// A ship's target is resolved ONCE, at REQUEST time, and never re-checked, so when the old request
// finally ran it reset the checkout to its 16:26-era sha and rebuilt from it: production went back
// to code OLDER than what it was already running, silently reverting both newer ships (the compose
// gateway port publish and the landed probe/fallback code). Nothing noticed. The only signal was a
// human saying "it broke again".
//
// THE GUARD. Before the deploy touches anything, ask ONE question: is the target an ancestor of what
// production already runs? If it is — and it is not the same commit — that deploy is a revert nobody
// asked for. Refuse it, loudly, with a named cause.
//
// PURE — no git, no db, no fleet. The caller gathers the facts (what is live, whether the target is
// an ancestor of it, how far behind) and this decides. That is what makes the incident replayable in
// a table test, and it is the same split as ship-failure.js: the queenzee does the I/O, the verdict
// is a function.
//
// THE DIRECTION OF SAFETY, and it is the opposite of the advisory reads around it (ship-payload,
// ship-preflight, docsOnlySinceDeployed): those degrade to "let it through" because the cost of a
// wrong no is a blocked ship. Here a REFUSAL must be DEFINITE — it stops a deploy a human approved —
// so only a KNOWN-ancestor target is refused. Every unknowable case (no deployed sha on record, an
// unreadable ancestry, a missing commit) resolves to `unknown` and lets the ship proceed: the guard
// must never become a new way for prod to be unshippable.
//
// AND IT NEVER RETARGETS. Advancing the target to main's tip would deploy code nobody approved,
// which is a worse bug than the one this fixes. A refused ship is re-requested by a human, at a new
// sha, through the same gate.

// The one cause this refusal reports on the ship_request row (see lib/ship-failure.js, which carries
// it in SHIP_FAILURE_CAUSES so the console renders it like any other classified failure).
export const SHIP_BEHIND_LIVE_CAUSE = 'ship-behind-live';

// Every direction the verdict can name. 'unknown' is a first-class answer, never a silent 'forward'.
export const SHIP_DIRECTIONS = ['forward', 'already-live', 'behind-live', 'unknown'];

const short = (sha) => (sha ? String(sha).slice(0, 8) : '(none)');

// Decide whether a ship may proceed, from facts the caller measured:
//   target            — the sha this ship would deploy (ship_request.commit)
//   deployed          — the sha production is running for this target (the last SHIPPED request for
//                       the same project + site; null when nothing has ever shipped)
//   isAncestor        — is `target` an ancestor of `deployed`? true / false / null when it could not
//                       be read (an unreadable repo, a missing commit). null is NOT false.
//   behind            — how many commits `deployed` is ahead of `target` (null when uncountable);
//                       used only to make the refusal readable.
// Returns { allowed, direction, reason, target, deployed, behind }. `reason` is always a sentence a
// human can act on — for the allowed cases it is the log line, for the refusal it is what lands on
// the card and in the zee's report.
export function shipDirectionVerdict({ target = null, deployed = null, isAncestor = null,
                                       behind = null } = {}) {
  const base = { target, deployed, behind };
  if (!target) {
    return { ...base, allowed: true, direction: 'unknown',
      reason: 'the ship has no commit recorded — direction cannot be checked, so the deploy is not blocked here' };
  }
  if (!deployed) {
    return { ...base, allowed: true, direction: 'unknown',
      reason: 'no completed ship on record for this target — nothing to be behind of' };
  }
  if (target === deployed) {
    return { ...base, allowed: true, direction: 'already-live',
      reason: `${short(target)} is ALREADY LIVE — production runs this exact commit; this deploy rebuilds it` };
  }
  if (isAncestor === null) {
    return { ...base, allowed: true, direction: 'unknown',
      reason: `could not compare ${short(target)} with the deployed ${short(deployed)} — ancestry unreadable, `
        + 'so the direction guard does not refuse (it only ever refuses on a DEFINITE backwards move)' };
  }
  if (isAncestor === true) {
    const behindTxt = Number.isFinite(behind) && behind > 0
      ? `${behind} commit${behind === 1 ? '' : 's'} behind` : 'behind';
    return { ...base, allowed: false, direction: 'behind-live',
      reason: `REFUSED: this ship would roll PRODUCTION BACKWARDS. Its target ${short(target)} is an `
        + `ancestor of what production already runs (${short(deployed)}) — ${behindTxt}. Deploying it `
        + 'would revert every landing shipped since, silently. NOTHING was deployed and production is '
        + 'untouched. The target is never advanced automatically (that would deploy code nobody '
        + `approved): re-request the ship at the current main tip and have a human approve THAT sha. `
        + 'If production really must go back, land a revert on main and ship that — forward only.' };
  }
  return { ...base, allowed: true, direction: 'forward',
    reason: `${short(target)} is not behind the deployed ${short(deployed)} — forward ship` };
}

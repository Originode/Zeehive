// NUDGE A CXELLD ZEE AFTER ITS LANDING LANDS — the async-continuation half of the cxell-zee land
// loop. A headless cxell zee's turn ENDS the moment it calls `zee land`; the human then approves
// (maybe minutes or hours later), and nothing tells the zee. Before this, the zee simply stopped:
// its work sat landed on main and the ship/done steps never happened without a human re-invoking it.
//
// The PRIMARY fix is here: when a landing raised by a CXELLD zee lands (landgate's landApproved),
// the queenzee RESUMES that zee's claude session with a short prompt — "your landing is on main,
// continue: ship if appropriate, then propose done". `zee land --wait` is the backup signal; this
// nudge is what makes the workflow continue with NO human in the loop.
//
// Only CXELLD zees are nudged (entrypoint 'cxell-cli' with a live 'ssh-terminal' cxell). Best-effort
// and logged: a dead or torn-down cxell just logs and moves on — a landing must never fail because a
// cxell is unreachable.
import { one } from '../db/pool.js';
import { logline } from '../lib/logbus.js';
import { cxellName, nudgeCxellZee, sendKeysToCxellZee, writeFileIntoCxell } from '../lib/cxell.js';
import { adapterFor, usageFrom, resultFrom } from '../lib/cxell-runtimes.js';
import { decideMessageDelivery } from '../lib/zee-turn.js';
import { resumeTurnDeath } from '../lib/turn-death.js';
import { predecessorActionDigest } from '../lib/predecessor-digest.js';
// The one writer of a turn boundary on the zee row — shared with intake's spawn and the cage's own
// interactive report (lib/turn-record.js says why it is not lib/status.js setZeeStatus). claimZeeTurn
// is the TURN LOCK half of the same module: a resume must CLAIM the turn atomically (refusing if one
// is already in flight) instead of blindly marking 'working' over a live session (TKT-114-B).
import { markZeeTurn, claimZeeTurn } from '../lib/turn-record.js';
import { startTurn, endTurn, lastAssistantText, turnBudgetWarningMessage } from '../lib/turn-ledger.js';
import { tokenForSpawn } from '../lib/provider-tokens.js';
import { setTend } from '../lib/status.js';
import { broadcast } from '../lib/events.js';
import { fleetPaused, PAUSED_REASON, noteHeldNudge } from '../lib/fleet-pause.js';

// Same switch every other real-side-effect module reads (landgate, xellgit, harness, reaper, the
// .zeehive.env reconcile): 'real' touches machines, anything else models. A nudge is a
// `docker exec cxell_<slug>` that RESUMES an agent's session, and the slug comes off a fleet row —
// which, in a NESTED queenzee, is another zee's live cage. See nudgeCxell() for the guard itself.
const PROVISION_MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

// ── ONE-SHOT WEARERS (migration 149) ─────────────────────────────────────────────────────────
//
// `harness.one_shot` is a PERSONA setting, like enable_reflection (112): every queenzee-started turn
// for a wearer runs in a fresh session rather than resuming the last one, so context — and the bill
// for re-sending it — does not accumulate over a cage's life. The router ships with it ON.
//
// Inherited, exactly like every other harness setting: a project's own router persona descends from
// `router` and must not lose the economics by existing. So the chain is walked and ANY layer saying
// one_shot makes the wearer one-shot.
async function harnessIsOneShot(xellId) {
  try {
    const x = await one(`SELECT harness_id FROM xell WHERE id=$1`, [xellId]);
    let cur = x?.harness_id
      ? await one(`SELECT id, one_shot, parent_id FROM harness WHERE id=$1 AND enabled`, [x.harness_id])
      : null;
    let hops = 0;
    while (cur && hops++ < 32) {
      if (cur.one_shot === true) return true;
      cur = cur.parent_id ? await one(`SELECT id, one_shot, parent_id FROM harness WHERE id=$1 AND enabled`, [cur.parent_id]) : null;
    }
  } catch { /* a database that has not run 149 has no such column — resume as before */ }
  return false;
}

// What a fresh session must be told before it can act. Deliberately SHORT and a POINTER: the persona,
// its memory and the project manual are already files in the cage (the queenzee injects them at
// spawn), so re-sending them every turn would spend exactly what one-shot exists to save.
const oneShotPreamble = () => [
  '⟲ FRESH SESSION — your harness is ONE-SHOT, so this turn starts with no memory of any previous one.',
  'That is deliberate and nothing has gone wrong. Before you act, read (they are already in your cage):',
  '  • .zeehive/harness/PERSONA.md      — who you are and what you may do',
  '  • .zeehive/harness/memory/         — your manual and notes, including the cxell-zee manual',
  '  • CLAUDE.md / AGENTS.md at /work/repo — how this project works',
  'Take every fact about the fleet from the verbs, never from memory: `zee status`, `zee zees`,',
  '`zee work --board`, `zee inbox`. Anything that must outlive this turn belongs in a work item, a',
  'dispatch brief or a report — not in your head.',
  '',
].join('\n');

const CONTINUE_PROMPT =
  'Your landing was APPROVED and is now on main — the queenzee moved the ref, nothing is left for you '
  + 'to re-push. Continue the job from here:\n'
  + '  1. If this work should go to production, run `zee ship` (add `--targets server webapp` if only some '
  + 'tiers changed). It is refused unless landed — which it now is.\n'
  + '  2. If more work remains, keep going and `zee land` again when the next chunk is ready.\n'
  + '  3. When you are satisfied the whole job is complete, run `zee done --summary "…"`.\n'
  + 'Do NOT try to re-run `zee land` for the work that just landed; it is done. Pick the next step and act.';

// A STALE LANDING is the other end of the same loop, and it was the SILENT one. An approval is
// bound to one exact sha; if main moves past that sha before it lands (another xell landed first,
// a human pushed by hand), it can never fast-forward and the gate closes the row as 'stale'. That
// was recorded honestly — in the log, in the row, on the pad — and told NOBODY. The zee's turn had
// already ended at `zee land`, so it sat there believing a human was still deciding: no nudge, no
// second request, work stranded on a branch nobody would ever be asked to approve again.
//
// So a stale landing nudges too, with the ONE recovery that actually works from inside a cxell:
// `zee sync` (the queenzee merges current main into the branch — `git fetch`/`git rebase main`
// cannot work in the cage) and then `zee land` again, which raises a FRESH request on the new sha.
// Deliberately explicit that this is not a failure of the work and not something to route around:
// the sha is dead, the commits are not.
const STALE_PROMPT = (ref, sha, tip) => [
  `Your landing did NOT land — it went STALE${sha ? ` (${String(sha).slice(0, 8)})` : ''}. While your push was waiting,`,
  `${ref ? ref.replace('refs/heads/', '') : 'main'} moved on${tip ? ` (it is now at ${String(tip).slice(0, 8)})` : ''} — someone else landed first — so the sha a human`,
  'approved can no longer fast-forward, and the gate binds an approval to ONE exact sha. Nothing is lost:',
  'every commit is still on your branch and nothing was rewritten. The sha is dead, your work is not.',
  '',
  'Get back on top of main and ask again — two steps, in this order:',
  '  1. `zee sync` — the queenzee delivers current main INTO your cxell and MERGES it into your branch.',
  '     This is the ONLY way to catch up in here (`git fetch` / `git rebase main` cannot work — your cage',
  '     has no main ref). If it reports a genuine CONFLICT the merge is left in progress for YOU: resolve',
  '     the files, `git add` them, `git commit`. If the merge touched your change, re-verify it',
  '     (`zee build <role> --wait`, in the BACKGROUND).',
  '  2. `zee land` — pushes your NEW sha and raises a FRESH request for a human. A new decision on new',
  '     content is expected, not a setback.',
  '',
  'Do NOT re-run the old push, do NOT amend/force to dodge the gate, and do NOT touch origin. If the sync',
  'conflicts in a way you cannot honestly resolve, stop and raise it: `zee tend --reason "…"`.',
].join('\n');

// Tell the zee its landing died so it can sync and ask again. Called by the land gate the moment a
// row is closed as 'stale' — from an approval that could no longer fast-forward, or from the sweep
// that closes held requests main has already moved past. Best-effort and NEVER throws: closing a
// dead row must not depend on a cxell being reachable.
//
// If there is no live cxell to nudge (the zee finished, or its container is gone) the landing would
// go unheard entirely — so we raise a TEND instead: "needs a human in the console". A stale landing
// with nobody listening is exactly the state that must not be silent.
export async function nudgeXellForStaleLanding(xellId, { sha = null, ref = null, tip = null, requestId = null, by = 'queenzee', mode = PROVISION_MODE } = {}) {
  const short = sha ? String(sha).slice(0, 8) : 'a landing';
  const r = await nudgeCxell(xellId, {
    by, mode, prompt: STALE_PROMPT(ref, sha, tip), why: 'landing went stale',
    log: (slug, sid) => `${slug}: landing ${short} went STALE — resuming cxell session ${sid} to `
      + '`zee sync` and land again',
    // Delivery is fire-and-forget, so "we started a resume" is all nudgeCxell can honestly return.
    // For most nudges that is fine. Not this one: it is the zee's ONLY way to learn its landing
    // died, so a delivery that never even starts (docker gone, cxell torn down between the SELECT
    // and the exec) must degrade to a HUMAN rather than to silence — and the receipt must stop
    // claiming the zee was told.
    onFail: (e) => staleNudgeUndelivered(xellId, { short, requestId, why: e.message })
      .catch(() => {}),
  });
  if (r?.nudged) return r;
  // A dry-run nudge is not an UNDELIVERED one: nothing was attempted, because this queenzee is not
  // allowed to reach the cage at all. Raising a tend here would summon a human to a xell that is not
  // this instance's, over a landing it is only modelling.
  // A PAUSED fleet is the same shape for the same reason: nothing was attempted, and the human who
  // pressed pause is the last person who needs a "needs you" chip about it. The recovery is not lost
  // — the play prompt sends every resumed zee to `zee status`, which is where a dead sha is reported.
  if (r?.dry_run || r?.paused) return r;
  const tended = await staleNudgeUndelivered(xellId, { short, requestId, why: r?.reason || r?.error || 'no live cxell' });
  return { ...r, ...tended };
}

// CLEARED FOR LANDING — the third message in this loop, and the one that makes a QUEUE possible.
//
// When a zee pushes while another xell's landing is still open on the ref, its push is not raised as
// a second card: it enters the holding pattern (067). That is only humane if somebody calls it back.
// A cxell zee's turn ends at `zee land`, so a holder that is never told the runway freed is a zee
// that waits forever on a card that was never on a human's screen.
//
// So the tower resumes it, with the SAME two steps as the stale recovery — for the same reason: the
// ref has usually just moved (the xell ahead landed), so its sha is behind main, and `zee sync` is
// the only way to catch up inside a cage. Deliberately explicit that clearance is NOT approval:
// nothing of this zee's has been read by a human yet, and the fresh push is what raises the card.
const CLEARED_PROMPT = (ref, sha, reason) => [
  `The runway is CLEAR — you are next to land on ${ref ? ref.replace('refs/heads/', '') : 'main'}.`,
  `While you were holding, the landing ahead of you finished${reason ? ` (${reason})` : ''}, so nothing is in front of`,
  'you any more. Your push was never dropped and never rejected: it waited in a holding pattern so that a',
  'human only ever had ONE landing to decide on this ref, which is what stops two zees racing and one of',
  'them going stale.',
  '',
  'Take the runway — two steps, in this order:',
  `  1. \`zee sync\` — the xell ahead of you probably just landed, so ${ref ? ref.replace('refs/heads/', '') : 'main'} has moved and your sha is`,
  '     behind it. `zee sync` delivers current main INTO your cxell and MERGES it into your branch (in a cage',
  '     `git fetch` / `git rebase main` cannot work). If it reports a genuine CONFLICT the merge is left in',
  '     progress for YOU: resolve the files, `git add` them, `git commit`. If the merge touched your change,',
  '     re-verify it (`zee build <role> --wait`, in the BACKGROUND).',
  '  2. `zee land` — pushes your sha and raises a FRESH request for a human. THIS is the card they read.',
  '',
  'Being cleared is NOT an approval: nobody has looked at your commits yet, and nothing lands until they do.',
  'Do not amend/force to dodge the gate, and do not touch origin. If the sync conflicts in a way you cannot',
  'honestly resolve, stop and raise it: `zee tend --reason "…"`.',
].join('\n');

// Call a holder onto the runway. Same contract as the stale nudge — best-effort, NEVER throws, and a
// zee that cannot be reached becomes a TEND rather than silence, because a clearance nobody hears is
// a zee stranded in a pattern with no card and no way to know.
export async function nudgeXellForClearedRunway(xellId, { sha = null, ref = null, reason = null, requestId = null, by = 'queenzee', mode = PROVISION_MODE } = {}) {
  const short = sha ? String(sha).slice(0, 8) : 'a landing';
  const r = await nudgeCxell(xellId, {
    by, mode, prompt: CLEARED_PROMPT(ref, sha, reason), why: 'runway cleared',
    log: (slug, sid) => `${slug}: CLEARED to land ${short} — resuming cxell session ${sid} to `
      + '`zee sync` and land',
    onFail: (e) => clearanceUndelivered(xellId, { short, requestId, why: e.message }).catch(() => {}),
  });
  if (r?.nudged) return r;
  // A dry-run nudge is not an UNDELIVERED one: nothing was attempted, because this queenzee is not
  // allowed to reach the cage at all. Raising a tend here would summon a human to a xell that is not
  // this instance's, over a landing it is only modelling.
  // …and a PAUSED fleet, for the same reason (see the stale-landing note above): nothing was
  // attempted, so there is nothing to summon a human about.
  if (r?.dry_run || r?.paused) return r;
  const tended = await clearanceUndelivered(xellId, { short, requestId, why: r?.reason || r?.error || 'no live cxell' });
  return { ...r, ...tended };
}

// THE RE-CALL — a clearance that was DELIVERED and then died with the session (#11).
//
// The clearance above is fire-and-forget: `nudged: true` means the resume STARTED, not that the zee
// lived long enough to act. If its session ends first the row truthfully says it was nudged, the row is
// out of the pattern (clearRunway only walks `cleared_at IS NULL`), and nothing ever returns to it —
// the zee waits forever for a clearance it already had.
//
// So it is called ONCE more, and this prompt is deliberately NOT the clearance prompt. By now the
// runway has very likely been taken by the next holder (the tower moved on within a tick), so telling
// this zee "the runway is CLEAR, you are next" would be a lie. What is true either way is the recovery:
// sync, push, and take whatever the gate gives you — the runway or a fresh place in the pattern.
const RECALL_PROMPT = (ref, sha, min) => [
  `You were CLEARED to land${sha ? ` ${String(sha).slice(0, 8)}` : ''} on ${ref ? ref.replace('refs/heads/', '') : 'main'} and never came back.`,
  `The tower resumed your session about ${min} minute(s) ago with the go-around and no push has arrived since,`,
  'so this is a RE-CALL: the first one was most likely lost with a session that ended before it could act.',
  'Nothing about your work is wrong and nothing was rejected — your commits are exactly where you left them.',
  '',
  'Take it now — two steps, in this order:',
  `  1. \`zee sync\` — ${ref ? ref.replace('refs/heads/', '') : 'main'} has moved since you were queued. The queenzee delivers current main INTO`,
  '     your cxell and MERGES it into your branch (in a cage `git fetch` / `git rebase main` cannot work). A',
  '     genuine CONFLICT is left in progress for YOU: resolve the files, `git add`, `git commit`. If the merge',
  '     touched your change, re-verify it (`zee build <role> --wait`, in the BACKGROUND).',
  '  2. `zee land` — pushes your sha and raises a FRESH request for a human.',
  '',
  'The runway may have been taken while you were quiet. If your push goes back into the HOLDING PATTERN that is',
  'normal and nothing is wrong: you are told your position and called again when it frees. Being cleared was',
  'never an approval — nobody has read your commits yet, and nothing lands until a human decides this sha.',
  'This is the LAST automatic call: if nothing arrives after it, a human is raised instead.',
].join('\n');

// Re-call a holder whose clearance went unheard. Same contract as every nudge here: best-effort, never
// throws, and an undeliverable one degrades to a TEND rather than to silence — the case this whole
// mechanism exists to end.
export async function nudgeXellForLostClearance(xellId, { sha = null, ref = null, minutes = null, requestId = null, by = 'queenzee', mode = PROVISION_MODE } = {}) {
  const short = sha ? String(sha).slice(0, 8) : 'a landing';
  const r = await nudgeCxell(xellId, {
    by, mode, prompt: RECALL_PROMPT(ref, sha, minutes ?? '?'), why: 'clearance went unanswered',
    log: (slug, sid) => `${slug}: RE-CALLED to land ${short} — the clearance went unanswered, resuming `
      + `cxell session ${sid} to \`zee sync\` and land`,
    onFail: (e) => clearanceUndelivered(xellId, { short, requestId, why: e.message }).catch(() => {}),
  });
  if (r?.nudged || r?.dry_run || r?.paused) return r;
  const tended = await clearanceUndelivered(xellId, { short, requestId, why: r?.reason || r?.error || 'no live cxell' });
  return { ...r, ...tended };
}

// …and the end of the automatic path: two clearances, no push. Hand it to a human with the whole story,
// because the one thing this state does not need is another retry — the zee is not slow, it is gone or
// it is ignoring the tower, and both are a human's call. Never tends a xell that is already gone.
export async function tendForSilentClearance(xellId, { sha = null, ref = null, minutes = null, requestId = null } = {}) {
  const short = sha ? String(sha).slice(0, 8) : 'a landing';
  const branch = ref ? String(ref).replace('refs/heads/', '') : 'main';
  const xell = await one(`SELECT slug, status FROM xell WHERE id=$1`, [xellId]).catch(() => null);
  if (!xell || xell.status === 'retired') return { tended: false };
  const reason = `Cleared to land ${short} on ${branch} and never came back — re-called once, still silent `
    + `after ~${minutes ?? '?'} minute(s). Its commits are unlanded and no card exists for them: check whether `
    + 'the zee\'s session is alive, then have it `zee sync` and `zee land` (or mark it done).';
  await setTend(xellId, true, { reason, source: 'queenzee' }).catch(() => {});
  if (requestId) {
    await one(`UPDATE land_request SET note=$2 WHERE id=$1 RETURNING id`,
      [requestId, `runway clear, then silence: ${reason}`]).catch(() => {});
  }
  logline('nudge',
    `${xell.slug}: cleared to land ${short} and never re-pushed (re-called once) — raised a tend for a human`);
  return { tended: true, reason };
}

// The go-around: nobody was home when the runway freed. Raise "needs a human in the console" and
// correct the receipt, exactly as a stale landing does — the queue then calls the NEXT holder, so
// one unreachable zee never leaves the runway standing empty.
async function clearanceUndelivered(xellId, { short, requestId = null, why = 'unknown' } = {}) {
  const xell = await one(`SELECT slug, status FROM xell WHERE id=$1`, [xellId]).catch(() => null);
  if (!xell || xell.status === 'retired') return { tended: false };
  const reason = `The runway is clear and this xell is next to land ${short}, but its zee could NOT be nudged `
    + `(${why}) — so nothing has synced or re-pushed, and the landing is waiting on a human.`;
  await setTend(xellId, true, { reason, source: 'queenzee' }).catch(() => {});
  if (requestId) {
    await one(`UPDATE land_request SET note=$2 WHERE id=$1 RETURNING id`,
      [requestId, `runway clear: ${reason}`]).catch(() => {});
  }
  logline('nudge', `${xell.slug}: cleared to land ${short} but the zee could NOT be reached (${why}) — raised a tend for a human`);
  return { tended: true, reason };
}

// Nobody heard it. Raise "needs a human in the console" and correct the request's receipt, which
// until this ran said the zee had been nudged. Never throws; never tends a xell that is already
// gone (there is no zee left to come back to it, and a tend on a corpse is just noise).
async function staleNudgeUndelivered(xellId, { short, requestId = null, why = 'unknown' } = {}) {
  const xell = await one(`SELECT slug, status FROM xell WHERE id=$1`, [xellId]).catch(() => null);
  if (!xell || xell.status === 'retired') return { tended: false };
  const reason = `Landing ${short} went STALE — main moved past it, so it can never land. The zee could NOT be `
    + `nudged (${why}), so nothing has synced and re-requested it.`;
  await setTend(xellId, true, { reason, source: 'queenzee' }).catch(() => {});
  if (requestId) {
    await one(`UPDATE land_request SET note=$2 WHERE id=$1 RETURNING id`,
      [requestId, `stale: ${reason}`]).catch(() => {});
  }
  logline('nudge', `${xell.slug}: landing ${short} went STALE and the zee could NOT be reached (${why}) — raised a tend for a human`);
  return { tended: true, reason };
}

// THE REFLECTION STAGE — what a worker does AFTER its work is live in production.
//
// A ship used to be the end of a zee's story: the containers swapped, the card went quiet, and
// everything the zee learned on the way — the workaround it had to leave in, the test it could not
// write, the bug it saw in passing — died with the cxell. The one moment a worker knows the most
// about a change is right after it ships, and nobody was asking.
//
// So the queenzee re-invokes the shipping zee with a REFLECTION prompt: review what actually shipped
// and report improvements and errors to its MANAGER (`zee report --kind reflection`), which lands in
// the manager's inbox and is delivered into its live session. A worker with no manager still writes
// the reflection — it is recorded for the humans in the console instead of being lost.
//
// It is a prompt, not a gate: it opens nothing, blocks nothing, and a dead cxell simply logs.
const REFLECT_PROMPT = (commit, managerSlug) => [
  `Your work SHIPPED to production${commit ? ` (${String(commit).slice(0, 8)})` : ''}. Before you stop, do the REFLECTION pass —`,
  'this is a required stage, and it is the most valuable thing you will write today, because right now',
  'you know more about this change than anyone else ever will.',
  '',
  'Review what actually shipped (your diff, what you had to work around, what you could not verify), then',
  'report — honestly, specifically, no reassurance:',
  '  1. IMPROVEMENTS — what should be done better next time, in this code or in how the job was set up.',
  '  2. ERRORS / RISKS — anything you know is wrong, fragile, or unverified in what just went live,',
  '     including things outside your task that you noticed on the way. Say it even if it is your own',
  '     mistake: an unreported flaw in production is far more expensive than an admitted one.',
  '  3. FOLLOW-UPS — the concrete next tasks you would cut, in priority order.',
  '',
  managerSlug
    ? `Send it with \`zee report --kind reflection --message "…"\` — it goes to your MANAGER (${managerSlug}),`
      + ' who decides what becomes the next task. Keep it under ~25 lines and lead with anything broken.'
    : 'Send it with `zee report --kind reflection --message "…"`. You have no manager zee, so it is recorded'
      + ' for the humans in the console. Keep it under ~25 lines and lead with anything broken.',
  '',
  'If you find something genuinely broken in production, ALSO raise it now: `zee tend --reason "…"`.',
  'Do not deploy, do not touch prod, and do not start fixing it in this xell without being asked —',
  'reflect, report, and let a human or your manager decide what happens next.',
].join('\n');

// Ask the zee that just shipped to reflect. Called by the ship gate on a SUCCESSFUL ship only —
// there is nothing to reflect on when nothing went live (a failed ship is a build problem the human
// is already looking at). Best-effort, never throws: a ship must never fail because a cxell is gone.
export async function nudgeXellForReflection(xellId, { commit = null, by = 'queenzee', mode = PROVISION_MODE } = {}) {
  const mgr = await one(
    `SELECT m.slug FROM xell x JOIN xell m ON m.id = x.manager_xell_id WHERE x.id=$1`, [xellId])
    .catch(() => null);
  return nudgeCxell(xellId, {
    by, mode, prompt: REFLECT_PROMPT(commit, mgr?.slug || null), why: 'post-ship reflection',
    log: (slug, sid) => `${slug}: shipped — resuming cxell session ${sid} for the REFLECTION pass`
      + `${mgr?.slug ? ` (reports to ${mgr.slug})` : ''}`,
  });
}

// PLAY — the other half of the pause button (queenzee/pause.js does the fan-out).
//
// A paused zee was SIGINT'd mid-turn: its tool call stopped in flight, its transcript ends in the
// middle of a thought, and nothing in the session says why. Left to work it out, an agent's most
// reasonable reading is that something FAILED — a build died, a request was rejected, it crashed —
// and the recovery it would then attempt (re-running a land, re-asking a gate, chasing a phantom
// error) is worse than the pause was. So the prompt says, in order: nothing of yours failed, here is
// what could genuinely have changed while you were stopped, and `zee status` is how you find out
// rather than by guessing.
//
// It deliberately does NOT re-issue the specific continuation the zee might have missed (a landing
// approved, a runway cleared, a stale sha, a ship to reflect on). Those nudges were HELD while the
// flag was up, and re-deriving each of them per xell here would be a second, divergent copy of four
// different prompts. `zee status` is the one authoritative answer to all of them — it reports the
// landing state, the ship state, the tend, the inbox — so the prompt points there and says what to do
// with each outcome.
const RESUMED_PROMPT = (min, why) => [
  'RESUMED — a human pressed PLAY. The whole fleet was PAUSED'
    + (min != null ? ` about ${min} minute(s) ago` : '')
    + (why ? ` (reason given: ${why})` : '') + ', which interrupted every zee mid-turn, managers included.',
  '',
  'That interrupt was a SIGINT to your turn and NOTHING ELSE. Read that carefully before you react:',
  'nothing of yours failed, nothing was rejected, no gate moved and no work was lost. Your commits are',
  'exactly where you left them; a landing or ship you had already asked for is still asked for. If your',
  'last turn stopped in the middle of a tool call, that is the pause and not a crash — do not go hunting',
  'for the error.',
  '',
  'Pick up where you were, in this order:',
  '  1. `zee status` — the authoritative answer to "what happened while I was stopped?". Decisions kept',
  '     arriving while the fleet was still: your landing may have been APPROVED (then carry on: ship if',
  '     this work ships, else keep going), gone STALE or been CLEARED for the runway (then `zee sync`,',
  '     resolve any conflict, and `zee land` again). It also carries your tend, your ship state and your',
  '     inbox — and a message somebody sent you during the pause was REFUSED rather than queued, so ask',
  '     for it again if you were expecting one.',
  '  2. `zee work` if you are on a work item — re-read it rather than trusting your memory of it.',
  '  3. Re-verify ONLY what the interrupt actually cut: if a `zee build … --wait` was in flight, run it',
  '     again (in the BACKGROUND). A test run that was killed mid-way proves nothing either way.',
  '  4. Then continue the job.',
  '',
  'Do NOT re-raise a request you had already made (check `zee status` first — a second card from you is',
  'noise a human has to disambiguate), and do NOT `zee tend` about having been paused: a human did it',
  'deliberately and has just undone it.',
].join('\n');

// Call one zee back after a pause. Same contract as every nudge here — fire-and-forget, best-effort,
// NEVER throws. `allowWhilePaused` because this IS the unpause: the fan-out clears the flag first, but
// saying so at the call site is what stops a future refactor from making play un-pressable.
export async function nudgeXellForFleetResume(xellId, { minutes = null, reason = null, by = 'human@console', mode = PROVISION_MODE } = {}) {
  return nudgeCxell(xellId, {
    by, mode, allowWhilePaused: true, prompt: RESUMED_PROMPT(minutes, reason), why: 'fleet resumed',
    log: (slug, sid) => `${slug}: fleet RESUMED by ${by} — resuming cxell session ${sid} to continue`,
  });
}

// THE REVIVE — a turn that the PROVIDER cut, not the zee (queenzee/revive.js owns the policy).
//
// A 429 or a 529 ends a headless run mid-thought and intake files it as 'errored'. The session, the
// cage, the branch and the database are all intact; the only thing that went wrong is that the API
// said no. Measured across 279 zees, ~43 died that way and 29 of those on a rate limit or an
// overload — most of them on their FIRST turn, at $0.06–$0.43, with the whole xell already paid for.
//
// So the queenzee resumes them, and the prompt has one job beyond "carry on": tell the agent WHY it
// is running again. An agent resumed with no explanation reads its own truncated transcript as a
// failure of its own and starts hunting for it — the same reason the fleet-resume prompt opens the
// way it does. It also says which attempt this is, because the ladder is finite (three, then a
// human) and a zee that knows that does not burn its turn re-triggering the thing that killed it.
const REVIVE_PROMPT = (signal, message, attempt, max, minutes) => [
  'RESUMED — your last turn did NOT end, it was CUT SHORT BY A PROVIDER ERROR'
    + (minutes != null ? ` about ${minutes} minute(s) ago` : '') + '.',
  `The provider answered ${signal ? `${signal}: ` : ''}"${String(message || '').replace(/\s+/g, ' ').slice(0, 300)}"`,
  'and the run died there. Read that carefully before you react: NOTHING OF YOURS FAILED. You were not',
  'rejected, no gate moved, no build broke and nothing was reverted — the API refused mid-turn, which is',
  'why your transcript stops in the middle of a thought. Your commits are exactly where you left them.',
  '',
  `The queenzee revived you automatically (attempt ${attempt} of ${max}, no human involved).`,
  '',
  'Re-orient BEFORE you act — time has passed and you must not trust your memory of the fleet\'s state:',
  '  1. `zee status` — the authoritative answer to "where do I stand?": your task, and whether a landing,',
  '     a ship or a done proposal of yours is pending a human. A decision may have arrived while you were dead.',
  '  2. `zee work` if you are on a work item — re-read it rather than recalling it.',
  '  3. `git log --oneline -5` and `git status` in your worktree — what you had actually committed before',
  '     the error, which is usually more (or less) than you remember.',
  '',
  'Then CONTINUE the job from there. Do not redo work that is already committed, do not re-raise a request',
  '`zee status` shows is already open, and do not `zee tend` about the provider error — it is handled, and',
  `if the same error kills this turn too the queenzee will try again${attempt < max ? '' : ' no more times'} and then raise a human itself.`,
].join('\n');

// Revive one zee whose turn a provider error killed. Same contract as every nudge here: best-effort,
// fire-and-forget, NEVER throws — the caller (revive.js) decides what an undelivered revive means.
// `prompt` overrides the standard turn-death text — used by the credential-injection path, whose
// "revive" was approved by a human (the standard text says "no human involved", which would be a lie).
//
// The DISCLOSURE (TKT-114-A): whatever the prompt, a digest of what earlier runs of this zee did —
// messages sent, workers dispatched, done suggestions, work-item ops, all already in the meta-DB
// ledgers — is appended, so a revived run is told what its predecessors said and did instead of
// re-deciding the same question blind. Best-effort: a digest that cannot be built (a ledger read
// fails, no zee row) must not sink the revive.
//
// `why` is what the turn is RECORDED as (the log line and last_stop_reason, via claimZeeTurn): the
// default names a provider error because that is what almost every revive is, but a host-restart
// revive passes its own — a zee row that says "provider error cut the turn" after a machine reboot
// is the same lie as the prompt, written where a human greps.
export async function nudgeXellForTurnDeath(xellId, { signal = null, message = '', attempt = 1,
                                                      max = 3, minutes = null, by = 'queenzee',
                                                      mode = PROVISION_MODE, prompt = null,
                                                      why = 'provider error cut the turn' } = {}) {
  let briefing = prompt || REVIVE_PROMPT(signal, message, attempt, max, minutes);
  try {
    const zee = await one(
      `SELECT z.id, z.xell_id, z.created_at, x.slug
         FROM zee z JOIN xell x ON x.id = z.xell_id
        WHERE z.xell_id = $1 AND z.entrypoint = 'cxell-cli'
        ORDER BY z.created_at DESC LIMIT 1`, [xellId]);
    if (zee) {
      const digest = await predecessorActionDigest({
        xellId: zee.xell_id, xellSlug: zee.slug, since: zee.created_at });
      if (digest) briefing += `\n${digest}`;
    }
  } catch (e) {
    logline('nudge', `xell ${String(xellId).slice(0, 8)}: could not build the predecessor-action digest `
      + `(${String(e.message).slice(0, 120)}) — reviving without it`);
  }
  return nudgeCxell(xellId, {
    by, mode, prompt: briefing, why,
    log: (slug, sid) => `${slug}: REVIVING after a ${signal || 'provider'} death — resuming cxell session `
      + `${sid} (attempt ${attempt}/${max})`,
  });
}

// An OPERATOR-initiated nudge: poke the running zee for a status update, WITHOUT changing anything.
// The word the operator wants the agent to actually SEE, typed into the live session as-is.
const STATUS_KEYS = 'status?';

// Nudge THIS xell's live cxell zee for a status update. It does NOT fork a second headless claude
// (that reply never reached anyone — the reason nudging "did not work"); it TYPES `status?` straight
// into the live interactive session over SSH, exactly as if the operator typed it in the dashboard
// terminal, so the agent's answer appears where the operator is looking. Returns the same
// { nudged, reason?/error? } shape so the route/UI can tell the operator whether there was a live zee
// to reach. NEVER throws.
export async function nudgeXellForStatus(xellId, { by = 'human' } = {}) {
  return nudgeCxellByKeys(xellId, { by, text: STATUS_KEYS, why: 'status update' });
}

// Re-invoke the cxell zee that owns this xell, if one is live. NEVER throws.
export async function nudgeXellAfterLand(xellId, { by = 'human', mode = PROVISION_MODE } = {}) {
  return nudgeCxell(xellId, { by, mode, prompt: CONTINUE_PROMPT,
    why: 'landing approved', log: (slug, sid) => `${slug}: landing approved by ${by} — resuming cxell session ${sid} to continue` });
}

// The prompt a message becomes when the zee's turn has already ENDED and the queenzee RESUMES its
// session to hand it over. Deliberately says why a session woke up: an agent that finds itself
// running again with no explanation reads it as a failure and goes hunting for one (the same reason
// the fleet-resume prompt opens the way it does). The message itself is quoted whole — this path has
// no 300-character line to fit into, so nothing is truncated on the way in.
const MESSAGE_PROMPT = ({ by, body, files = [], bodyPath = null }) => [
  `📨 A MESSAGE ARRIVED FOR YOU${by ? ` — from ${by}` : ''}. Your last turn had already ENDED, so the queenzee`,
  'RESUMED this session to hand it to you. Nothing of yours failed and no gate moved: this is somebody',
  'talking to you, not a decision about your work.',
  '',
  '──────── the message ────────',
  body || '(no text — see the attachments below)',
  '─────────────────────────────',
  ...(bodyPath ? ['', `The full text is also in your cage at ${bodyPath}.`] : []),
  ...(files.length ? ['', `Attachment(s) written into your cage — open them by path: ${files.join(', ')}`] : []),
  '',
  'Treat it as an INSTRUCTION from whoever sent it: it may re-task you, answer something you asked, or',
  'correct work you have already done. Time has passed since your last turn, so before you act on',
  'anything that depends on your state, re-read it rather than trusting your memory — `zee status`',
  '(landing/ship/tend), and `zee work` if you are on a work item. Then do the work in THIS turn.',
  'If you disagree with it, or it cannot be done, say so (`zee report` to your manager, or',
  '`zee tend --reason "…"`) rather than stopping silently.',
].join('\n');

// SEND A COMPOSED OPERATOR MESSAGE to this xell's live cxell zee — the "proper message" path behind
// the flower's 📨 button, a manager's `zee say` and the Hermes inbound bridge, all three of which
// come through here. THREE deliveries, decided from the zee's own state by decideMessageDelivery()
// (lib/zee-turn.js — pure, and table-tested in test/message-to-a-finished-zee.test.mjs):
//
//   • RESUMED — the turn has ENDED, so the message becomes the prompt of a resumed session. The
//     keystroke path did reach a finished zee (measured), but through a TUI inside the cage that
//     nothing in the fleet can observe — so the restart was INVISIBLE, which cost a manager an
//     entire duplicate xell. A resume is a turn the queenzee starts, records and watches end.
//   • QUEUED  — the zee is MID-TURN: the cage stores the message and zee-attach.sh types it into the
//     session the moment the turn ends.
//   • TYPED   — an interactive session is what is there to talk to (a runtime that cannot re-invoke
//     a finished session, or no session id captured), so the keystrokes go in as they always did.
//
// Anything richer than short single-line text — any attachment, or multi-line / long text — is still
// written into the cxell as real files under `.zee-inbox/<ts>/` (files verbatim, the body as
// `message.md`) whichever delivery follows: a prompt cannot carry an image, and Claude opens an
// image from a path. Delivery is fire-and-forget and best-effort — this NEVER throws; it returns
// { sent, delivery, reason?/error? } so the route/UI/manager can report which of the three happened.
//
// `messageId` is the DURABLE zee_message row this delivery belongs to (lib/managers.js postMessage
// writes one for every manager⇄worker message; the console's 📨 button and the Hermes bridge have
// none and pass nothing). Because delivery is fire-and-forget, `sent: true` means the delivery
// STARTED — and the row was then stamped delivered=true and left that way forever, even when the
// resume died on the way out or the cage's SSH door never answered. The zee row is corrected in
// that case; the message row was not, so a manager's own history said a worker had been told
// something it never heard. Given the id, a failed delivery corrects its own record (see
// messageUndelivered).
export async function sendMessageToXell(xellId, { text = '', attachments = [], by = 'human',
                                                  mode = PROVISION_MODE, messageId = null } = {}) {
  try {
    const body = String(text || '').trim();
    const atts = (Array.isArray(attachments) ? attachments : []).filter((i) => i && i.data);
    if (!body && !atts.length) return { sent: false, delivery: 'none', reason: 'empty message (no text or attachments)' };
    // PAUSED: refused, and refused HONESTLY. This is the door the 📨 button, the Hermes inbound
    // bridge and a manager's `zee say` all come through, and every one of them ends in a message
    // TYPED into a session — i.e. a zee starting a turn. Queueing it into the cage instead would be
    // worse than refusing: the drainer types it the moment a session takes the pane, so a "queued"
    // message would restart the very zee the operator just stopped, minutes later, with nothing on
    // screen to explain it. The sender is told, and can re-send after pressing play.
    if (await fleetPaused()) return { sent: false, delivery: 'none', paused: true, reason: PAUSED_REASON };

    const zee = await one(
      `SELECT z.id, z.claude_session_id, z.viewer_kind, z.viewer_url, z.status, z.decommissioned_at,
              x.slug, x.status AS xell_status, rt.key AS runtime_key
         FROM zee z JOIN xell x ON x.id = z.xell_id
         LEFT JOIN agent_runtime rt ON rt.id = z.runtime_id
        WHERE z.xell_id = $1 AND z.entrypoint = 'cxell-cli'
        ORDER BY z.created_at DESC LIMIT 1`, [xellId]);
    // The zee's runtime dialect decides whether a finished session can be re-invoked at all:
    // claude/codex resume by session id, kimi by workdir (--continue). An unknown runtime key throws
    // rather than guessing, and here that only means "cannot resume" — the keystroke path still runs.
    let adapter = null;
    try { adapter = zee ? adapterFor(zee.runtime_key) : null; } catch { /* unknown runtime → no resume */ }
    const verdict = decideMessageDelivery({
      present: !!zee,
      status: zee?.status,
      viewerKind: zee?.viewer_kind,
      decommissioned: !!zee?.decommissioned_at,
      xellStatus: zee?.xell_status,
      runtimeResumable: !!adapter?.resumable,
      sessionResumable: !!adapter && (!adapter.needsSid || !!zee?.claude_session_id),
    });
    if (verdict.delivery === 'none') return { sent: false, delivery: 'none', reason: verdict.reason };

    let sshPort;
    try { sshPort = Number(new URL(zee.viewer_url).port); } catch { /* handled below */ }
    // Only the keystroke deliveries dial the cage's SSH door; a resume goes in over docker exec, so
    // a zee with no viewer port is no longer unreachable just because it cannot be typed at.
    if (!sshPort && verdict.delivery !== 'resumed') {
      return { sent: false, delivery: 'none', reason: 'cxell has no SSH port to reach (viewer_url missing/invalid)' };
    }

    // Rich message → hand it over as files; plain short text → type it inline.
    const rich = atts.length > 0 || body.includes('\n') || body.length > 300;
    let typed = body;
    let bodyPath = null;
    const written = [];

    const failed = [];
    if (rich) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const dir = `.zee-inbox/${ts}`;
      for (let i = 0; i < atts.length; i++) {
        const b64 = String(atts[i].data).replace(/^data:[^,]*,/, '');
        const rel = `${dir}/${attachmentFileName(atts[i].name, atts[i].type, i + 1)}`;
        try { written.push((await writeFileIntoCxell({ slug: zee.slug, relPath: rel, base64: b64 })).path); }
        catch (e) { failed.push(atts[i].name || rel); logline('message', `${zee.slug}: could not write attachment ${rel} (${String(e.message).slice(0, 120)})`); }
      }
      // Every attachment failed to land — don't type a pointer to files that aren't there and don't
      // report a clean send. The operator needs to know the attachments did NOT reach the zee (this is the
      // "attach file fails silently" case: writes threw, yet the UI showed success).
      if (atts.length && !written.length) {
        return { sent: false, delivery: 'none', failed,
                 reason: `could not deliver ${atts.length} attachment(s) into the cxell — ${failed.join(', ')}` };
      }
      const md = ['# Operator message', `_sent ${new Date().toISOString()} by ${by}_`, '',
        body || '(no text — see attachments)', '',
        ...(written.length ? [`## Attachments (${written.length})`, ...written.map((p) => `- ${p}`)] : []),
        ...(failed.length ? ['', `> ⚠ ${failed.length} attachment(s) could not be delivered: ${failed.join(', ')}`] : [])].join('\n');
      bodyPath = `${dir}/message.md`;
      try { bodyPath = (await writeFileIntoCxell({ slug: zee.slug, relPath: bodyPath, text: md })).path; }
      catch (e) { logline('message', `${zee.slug}: could not write message body (${String(e.message).slice(0, 120)})`); }
      typed = `📨 New operator message — please read ${bodyPath}`
        + (written.length ? ` and view the ${written.length} attached file(s): ${written.join(', ')}` : '')
        + (body ? `. Summary: ${body.replace(/\s+/g, ' ').slice(0, 160)}` : '');
    }

    // ── RESUMED: the turn has ENDED, so hand the message over as a PROMPT ───────────────────────
    // Through nudgeCxell, the same shared delivery every landing/clearance/reflection continuation
    // uses — which is where the PROVISION_MODE guard lives. That guard matters here for the same
    // reason it does there: a NESTED queenzee walks a CLONE of the meta-DB, so `cxell_<slug>` off
    // one of those rows is another zee's live cage. When it refuses, this reports `sent:false` with
    // the dry-run reason rather than falling back to keystrokes: falling back would type the message
    // into the very dead drop this whole change exists to stop claiming as delivered.
    if (verdict.delivery === 'resumed') {
      logline('message', `${zee.slug}: operator message by ${by} — ${rich ? `${written.length} file(s) to .zee-inbox, ` : ''}`
        + `its turn has ENDED, so RESUMING its cxell session with the message as the prompt`);
      const r = await nudgeCxell(xellId, {
        by, mode, why: `message from ${by}`,
        prompt: MESSAGE_PROMPT({ by, body, files: written, bodyPath }),
        log: (slug, sid) => `${slug}: message from ${by} — resuming cxell session ${sid} to act on it`,
        // The resume STARTED is all this call can honestly report; if the exec then dies, the zee
        // row is put back and this puts the message's own receipt back with it.
        onFail: (e) => messageUndelivered(messageId, zee.slug,
          `the resumed session died on the way out — ${String(e.message).slice(0, 120)}`).catch(() => {}),
      });
      if (!r?.nudged) {
        return { sent: false, delivery: 'none', rich, attachments: written, ...(failed.length ? { failed } : {}),
                 ...(r?.dry_run ? { dry_run: true } : {}), ...(r?.paused ? { paused: true } : {}),
                 reason: r?.reason || r?.error || 'the cxell session could not be resumed' };
      }
      return { sent: true, delivery: 'resumed', delivery_reason: verdict.reason,
               zee_id: zee.id, session: zee.claude_session_id, rich, attachments: written,
               ...(failed.length ? { failed } : {}) };
    }

    logline('message', `${zee.slug}: operator message by ${by} — ${rich ? `${written.length} file(s) to .zee-inbox, ` : ''}typing into live cxell session over SSH (:${sshPort})`);
    // Fire and forget: opening SSH, resuming the TUI and typing can take several seconds.
    // The answer now distinguishes TYPED from QUEUED (the zee was mid-turn, so the pane was its
    // read-only feed and the message waits in the cage for zee-attach.sh to type it in when the
    // turn ends). Say which — this line used to claim delivery for messages that reached nobody.
    sendKeysToCxellZee({ sshPort, slug: zee.slug, text: typed, sessionId: zee.claude_session_id })
      .then((r) => logline('message', r?.delivery === 'queued'
        ? `${zee.slug}: the zee is MID-TURN — operator message QUEUED in the cxell; it is typed into its session when the turn ends`
        : `${zee.slug}: delivered operator message to the live session`))
      .catch((e) => {
        logline('message', `${zee.slug}: could not type into the cxell (${String(e.message).slice(0, 160)}) — cxell/session may be down; no retry`);
        // …and the same correction as the resume path above: the keystrokes are just as
        // fire-and-forget, so a message whose SSH door never answered must stop reading as delivered.
        messageUndelivered(messageId, zee.slug,
          `the cxell session could not be typed into — ${String(e.message).slice(0, 120)}`).catch(() => {});
      });

    // The cage's own verdict (typed vs queued) arrives asynchronously above; the ANSWER carries the
    // one decided from the zee's state, so a caller is never told "delivered" for all three.
    return { sent: true, delivery: verdict.delivery, delivery_reason: verdict.reason,
             zee_id: zee.id, session: zee.claude_session_id, rich, attachments: written,
             ...(failed.length ? { failed } : {}) };
  } catch (e) {
    logline('message', `message for xell ${String(xellId).slice(0, 8)} failed: ${String(e.message).slice(0, 160)}`);
    return { sent: false, delivery: 'none', error: e.message };
  }
}

// ── TURN-BUDGET WARNING — tell a zee its turn is approaching the vendor ceiling ─────────────────
// The ONE message a zee gets when its turn's running token total crosses TURN_BUDGET_WARNING_TOKENS
// (~12M, a named constant in lib/turn-ledger.js). Delivered through the SAME channel as every other
// operator message (sendMessageToXell) — exactly the shape the card asks for (sendMessageToXell,
// not nudgeCxell, which REFUSES a mid-turn zee by design). Best-effort by contract, and never ends
// a turn: the vendor's ceiling does that, and this warning exists so a zee lands what it has first.
//
// THE HONEST SHAPE OF THE DELIVERY (do not let this rot into a claim that a zee "was warned"):
// the warning fires MID-TURN by definition, and mid-turn delivery is QUEUED by zee-turn.js:77
// (MID_TURN_STATUSES includes 'working') — the talk queue drains only when the turn ends (cxell.js
// cxellTalkCommand / zee-attach.sh). So a turn that DIES at the ceiling will NOT receive this before
// dying: it waits in the queue and reaches the RESUMED zee after the death — RECOVERY, not
// PREVENTION, until a mid-turn channel exists. The verdict this returns (delivery: 'queued' in that
// case) is recorded on the turn row by warnTurnBudget, so the data says how often the warning was
// actually deliverable in time.
export async function nudgeXellForTurnBudget(xellId, { tokens = 0, by = 'queenzee', mode = PROVISION_MODE } = {}) {
  return sendMessageToXell(xellId, { text: turnBudgetWarningMessage(tokens), by, mode });
}

// A DELIVERY THAT FAILED MUST CORRECT ITS OWN RECORD (TKT-60) — the same rule staleNudgeUndelivered
// and clearanceUndelivered already apply to a land_request's note, one table over.
//
// Every delivery here is fire-and-forget: `sent: true` says the resume STARTED or the keystrokes
// were handed to SSH, never that either survived. When the exec dies, the ZEE row is corrected
// (nudgeCxell's failure branch puts it back to idle with the reason) — but the zee_message row was
// written delivered=true a moment earlier and nothing ever went back to it. So the durable record of
// a conversation, which is exactly what a manager re-reads when a worker seems unresponsive, said
// the worker had been told something it never heard.
//
// It only ever DOWNGRADES a receipt, it keeps whatever the original delivery recorded (the `||`
// merge, so the first attempt's shape survives beside the correction), and it is a no-op without an
// id — the console's 📨 button and the Hermes bridge write no row, and there is nothing to correct.
// Never throws: this is already a failure path.
async function messageUndelivered(messageId, slug = null, why = 'unknown') {
  if (!messageId) return { corrected: false };
  try {
    const row = await one(
      `UPDATE zee_message
          SET delivered = false,
              delivery = COALESCE(delivery, '{}'::jsonb) || $2::jsonb
        WHERE id = $1 RETURNING *`,
      [messageId, JSON.stringify({ sent: false, delivery: 'none', undelivered: true, reason: why })]);
    if (!row) return { corrected: false };
    broadcast('zee-message', { id: row.id, to_xell_id: row.to_xell_id, from_xell_id: row.from_xell_id, kind: row.kind });
    logline('message', `${slug || row.to_slug || 'a zee'}: message ${String(row.id).slice(0, 8)} was NOT delivered `
      + `after all (${why}) — the receipt is corrected; it is still in the durable inbox (\`zee inbox\`)`);
    return { corrected: true, reason: why };
  } catch (e) {
    logline('message', `could not correct the receipt on message ${String(messageId).slice(0, 8)} (${String(e.message).slice(0, 120)})`);
    return { corrected: false };
  }
}

// Pick a sane file extension for an attachment from its name, else its mime type, else none.
function msgFileExt(name = '', type = '') {
  const m = String(name).match(/\.([A-Za-z0-9]{1,5})$/);
  if (m) return `.${m[1].toLowerCase()}`;
  const sub = String(type).split('/')[1];
  if (sub) return `.${sub.replace('jpeg', 'jpg').replace('svg+xml', 'svg').replace(/[^a-z0-9]/gi, '')}`;
  return '';
}

// The filename an attachment lands under in `.zee-inbox/<ts>/` — the caller's own name when it is a
// sane one, else a generic `attachment-<n>` + an extension inferred from the mime type. Preserving
// the real name matters now that any file type can be attached: a zee told to read `orders.csv`
// should find `orders.csv`, not `image-3.csv`.
function attachmentFileName(name = '', type = '', n = 1) {
  const clean = String(name || '')
    .replace(/[^A-Za-z0-9._-]/g, '_')       // kill path separators and shell-hostile chars
    .replace(/^\.+/, '')                     // no leading dots (hidden files / traversal)
    .slice(0, 80);
  if (clean && clean !== '.') return clean;
  return `attachment-${n}${msgFileExt(name, type)}`;
}

// STATUS delivery: resolve this xell's live cxell zee and TYPE `text` into the interactive session
// it is running, over SSH (the same inbound door + fleet key the dashboard terminal uses). This is
// the literal "send the word to the AI" path — the agent receives the keystrokes in the session the
// operator watches, and its reply shows up there rather than in a headless log. Fire-and-forget
// (typing + the reply can take a beat), best-effort, NEVER throws.
async function nudgeCxellByKeys(xellId, { by = 'human', text, why = 'nudge' } = {}) {
  try {
    // A keystroke is the OTHER way to start a turn — typed into the pane, the zee answers. So it is
    // gated by the pause exactly like a session resume; a pause that a `status?` poke can undo is
    // not a pause. Reported, not swallowed: the caller says so in the UI.
    if (await fleetPaused()) return { nudged: false, paused: true, reason: PAUSED_REASON };
    const zee = await one(
      `SELECT z.id, z.claude_session_id, z.viewer_kind, z.viewer_url, x.slug
         FROM zee z JOIN xell x ON x.id = z.xell_id
        WHERE z.xell_id = $1 AND z.entrypoint = 'cxell-cli'
        ORDER BY z.created_at DESC LIMIT 1`, [xellId]);
    if (!zee) return { nudged: false, reason: 'no cxell zee for this xell (nothing to nudge)' };
    // A LIVE cxell has an ssh-terminal viewer; a torn-down one does not.
    if (zee.viewer_kind !== 'ssh-terminal') return { nudged: false, reason: `zee is not in a live cxell (viewer_kind=${zee.viewer_kind})` };
    let sshPort;
    try { sshPort = Number(new URL(zee.viewer_url).port); } catch { /* below */ }
    if (!sshPort) return { nudged: false, reason: 'cxell has no SSH port to reach (viewer_url missing/invalid)' };

    logline('nudge', `${zee.slug}: ${why} by ${by} — typing ${JSON.stringify(text)} into the live cxell session over SSH (:${sshPort})`);
    // Fire and forget: opening SSH, starting the TUI if needed, and typing can take several seconds;
    // do NOT block the caller (the flower's button) on it.
    sendKeysToCxellZee({ sshPort, slug: zee.slug, text, sessionId: zee.claude_session_id })
      .then((r) => logline('nudge', r?.delivery === 'queued'
        ? `${zee.slug}: the zee is MID-TURN — ${JSON.stringify(text)} QUEUED in the cxell; typed in when the turn ends`
        : `${zee.slug}: sent ${JSON.stringify(text)} to the live session`))
      .catch((e) => logline('nudge', `${zee.slug}: could not type into the cxell (${String(e.message).slice(0, 160)}) — cxell/session may be down; no retry`));

    return { nudged: true, zee_id: zee.id, session: zee.claude_session_id, sent: text, via: 'ssh-send-keys' };
  } catch (e) {
    logline('nudge', `status nudge for xell ${String(xellId).slice(0, 8)} failed: ${String(e.message).slice(0, 160)}`);
    return { nudged: false, error: e.message };
  }
}


// File a resumed turn's death with the reviver, which decides what it deserves (another attempt on
// the ladder, or a human). Imported DYNAMICALLY and only on this path: revive.js calls back into
// nudgeXellForTurnDeath above, and a static pair of imports would be a module cycle — the same
// reason, and the same shape, as fleet-pause.js reaching status.js for recordEvent. Never throws:
// this is already the failure path.
async function reportTurnDeath({ zeeId, xellId, slug, reason, code = null, err = '', result = null }) {
  try {
    const { noteTurnDeath } = await import('./revive.js');
    await noteTurnDeath({ zeeId, xellId, slug, reason, code, err, result, source: 'resumed turn' });
  } catch (e) {
    logline('nudge', `${slug}: could not file the resumed turn's death (${String(e.message).slice(0, 120)})`);
  }
}

// The shared delivery: resolve this xell's live cxell zee and resume its claude session with
// `prompt`. Fire-and-forget (the turn can run for minutes), best-effort, NEVER throws.
//
// `allowWhilePaused` exists for exactly ONE caller — the fleet PLAY fan-out, which is itself the act
// of unpausing (queenzee/pause.js). Everything else must be refused while the fleet is paused: this
// function's whole job is to START A TURN, and a pause that any queenzee loop can undo on its next
// tick is not a pause. See the `paused` handling in the callers above: they treat it like `dry_run`
// (report it, raise NOTHING) rather than as an undelivered nudge, because a paused fleet must not
// spray tends at a human who is deliberately holding the fleet still.
async function nudgeCxell(xellId, { by = 'human', prompt, why = 'nudge', log, onFail = null,
                                    mode = PROVISION_MODE, allowWhilePaused = false } = {}) {
  try {
    if (!allowWhilePaused && await fleetPaused()) {
      // RECORDED, not discarded: a zee waiting on a landing is between turns, so the pause never
      // interrupted it and would not call it back — yet the decision a human just made during the
      // pause reaches it only through this nudge. See noteHeldNudge for the two zees that stranded.
      await noteHeldNudge(xellId, why);
      logline('nudge', `xell ${String(xellId).slice(0, 8)}: ${why} — HELD, ${PAUSED_REASON} `
        + '(recorded: play will resume this zee, and `zee status` is where it reads what changed)');
      return { nudged: false, paused: true, held: true, reason: PAUSED_REASON };
    }
    const zee = await one(
      `SELECT z.id, z.claude_session_id, z.viewer_kind, z.entrypoint, z.model, z.status,
              x.slug, x.project_id, x.execution_id, x.quarantined_at, rt.key AS runtime_key
         FROM zee z JOIN xell x ON x.id = z.xell_id
         LEFT JOIN agent_runtime rt ON rt.id = z.runtime_id
        WHERE z.xell_id = $1 AND z.entrypoint = 'cxell-cli'
        ORDER BY z.created_at DESC LIMIT 1`, [xellId]);
    if (!zee) return { nudged: false, reason: 'no cxell zee for this xell (nothing to nudge)' };
    // A QUARANTINED cage is not nudged (ticket #81): a nudge is a TURN, and the quarantine's whole
    // point is that no recovery path starts another turn in the cage until a human decides. This is
    // the shared delivery every nudge caller funnels through — landing approved, stale landing,
    // runway cleared, fleet resume, a console nudge — so refusing here is the one refusal that holds
    // for all of them. (reviveTick refuses the same way; the ladder entry stays so a rescue resumes it.)
    if (zee.quarantined_at) {
      logline('nudge', `${zee.slug}: ${why} by ${by} — NOT delivered, the xell is QUARANTINED `
        + '(no new turn in the cage until a human decides between rescue and reap)');
      return { nudged: false, quarantine: true, reason: 'xell is quarantined' };
    }
    // A LIVE cxell has an ssh-terminal viewer; a torn-down one does not.
    if (zee.viewer_kind !== 'ssh-terminal') return { nudged: false, reason: `zee is not in a live cxell (viewer_kind=${zee.viewer_kind})` };
    // The zee's own runtime dialect: claude/codex resume by session id, kimi by workdir
    // (--continue) — so only the id-keyed runtimes refuse when no session id was captured.
    const adapter = adapterFor(zee.runtime_key);
    if (!adapter.resumable) return { nudged: false, reason: `runtime ${adapter.key} cannot resume a headless session` };

    // ONE-SHOT HARNESSES (149). A persona may declare that its wearer gets a FRESH session every
    // turn instead of resuming the last one — the router does, because it is the fleet's
    // most-invoked agent and re-sending a transcript it does not need is the largest avoidable
    // cost in the hive. For those wearers this turn carries no history at all, so:
    //   • the session id is NOT passed (no --resume/-c), and the needsSid refusal below does not
    //     apply — there is deliberately nothing to resume, which is not the same as "cannot";
    //   • the prompt gets a short RE-ORIENTATION preamble, because a fresh session remembers
    //     neither its persona nor that it is one-shot. It names the files the queenzee already
    //     injected into the cage (the persona, its memory, the project manual) rather than
    //     re-sending them, which is the whole economy of the thing.
    const oneShot = await harnessIsOneShot(xellId);
    if (!oneShot && adapter.needsSid && !zee.claude_session_id) {
      return { nudged: false, reason: 'cxell zee has no session id to resume' };
    }

    // Fallback token only — nudgeCxellZee prefers the tokens already in the cxell's /etc/environment
    // so a running `zee … --wait` poll keeps its identity.
    const token = await tokenForSpawn(zee.project_id, adapter.provider).then((a) => a?.token).catch(() => null);

    const sid = String(zee.claude_session_id || 'latest').slice(0, 8);
    // A NESTED QUEENZEE MUST NOT RESUME A REAL ZEE'S SESSION. Every caller of this helper is a
    // LANDING or SHIP outcome (landed · went stale · runway cleared · shipped, so reflect), and the
    // xell it is answering came out of a CLONE of the meta-DB — so in a nested queenzee the cage
    // below is another zee's, mid-task, and the prompt is a lie about work it never did. Report the
    // cage it would have resumed and exec nothing; the real queenzee still nudges (mode='real').
    if (mode !== 'real') {
      logline('nudge',
        `${zee.slug}: ${why} — NOT delivered. PROVISION_MODE=simulate: this queenzee models the fleet, it `
        + `does not resume sessions in a real cxell. Would have resumed ${cxellName(zee.slug)} (session ${sid}).`);
      return { nudged: false, dry_run: true, zee_id: zee.id,
        reason: 'PROVISION_MODE=simulate — this queenzee models the fleet; no cxell session was resumed' };
    }
    logline('nudge', oneShot
      ? `${zee.slug}: ${why} by ${by} — ONE-SHOT harness: starting a FRESH session (no resume of ${sid})`
      : (log ? log(zee.slug, sid) : `${zee.slug}: ${why} by ${by} — resuming cxell session ${sid}`));
    // THE TURN IS NOW REAL — say so on the zee row BEFORE the exec, so nothing can observe the gap.
    // And claim it, not just mark it: the claim is the single-writer lock that refuses a second
    // resume while this one is in flight (TKT-114-B). Two runs of one zee acting as one identity was
    // the integrity incident — ten resumes in eleven minutes, two commits a worker never authored.
    const claimed = await claimZeeTurn(zee.id, why);
    if (!claimed) {
      logline('nudge', `${zee.slug}: ${why} — REFUSED: a turn is ALREADY in flight for this zee `
        + `(status=${zee.status}); not resuming a session that is already running (TKT-114-B)`);
      return { nudged: false, refused: 'turn-in-flight', zee_id: zee.id, session: sid,
               reason: `a turn is already in flight for this zee (status=${zee.status}) — refusing to `
                 + 'resume the same session twice (single-writer lock per zee)' };
    }
    const startedAt = new Date();
    // PER-TURN LEDGER: a resume is its own turn (kind='resume'), distinct from the spawn that
    // created the session. Best-effort. execution_id rides along from the xell binding (the weld).
    const turn = await startTurn({ zee, xell: { id: xellId, slug: zee.slug, project_id: zee.project_id },
                                   kind: 'resume', sessionId: zee.claude_session_id, model: zee.model,
                                   executionId: zee.execution_id });
    // Fire and forget: the continuation turn can run for minutes; do NOT block the caller on it.
    nudgeCxellZee({
      ctx: 'default', name: cxellName(zee.slug),
      // one-shot: no session to resume, and the prompt says so up front (see harnessIsOneShot)
      sessionId: oneShot ? null : zee.claude_session_id,
      prompt: oneShot ? oneShotPreamble() + prompt : prompt,
      model: zee.model, adapter, token,
    })
      .then(async (r) => {
        // What this turn actually cost, off the vendor's own final result event (cxell.js parses it
        // with the adapter that produced it). A turn that printed no result — or a runtime whose
        // parser could not find one — books zero rather than losing the row's other columns.
        const burn = usageFrom(r?.result);
        const tok = burn.input + burn.output + burn.cacheRead + burn.cacheWrite;
        logline('nudge', `${zee.slug}: nudge session exited (code ${r?.code ?? '?'}, ${tok} tok, $${burn.cost})`);
        // A RESUMED TURN CAN DIE THE WAY A SPAWNED ONE DOES — and if nobody notices, the revive
        // ladder is a lie: it promises three attempts and then a human, and neither the second
        // attempt nor the human is reachable when attempt one's death is filed as 'end_turn'. The
        // exec's own stdout is the CLI's stream-json, so the same final `result` event intake.js
        // reads off a spawned turn is right here (lib/turn-death.js resumeTurnDeath).
        const death = resumeTurnDeath(r || {});
        // The BURN is booked either way, in the one statement that ends the turn: a turn that died
        // on a 429 still spent everything it spent up to the 429, and a row that forgets that is the
        // same understatement this ticket exists to end.
        const row = await markZeeTurn(zee.id, death ? 'errored' : 'idle',
                                      death ? death.message.slice(0, 200) : 'end_turn', burn);
        // PER-TURN LEDGER: close the resumed turn with its own burn + summary.
        await endTurn(turn?.id, {
          status: death ? 'errored' : 'ended',
          burn, stopReason: death ? death.message.slice(0, 200) : 'end_turn',
          summary: lastAssistantText(r?.result),
        });
        if (death) return reportTurnDeath({ zeeId: zee.id, xellId, slug: zee.slug, reason: death.message,
                                            code: r?.code ?? null, err: r?.err ?? '', result: r?.result ?? null });
        return row;
      // The failure handler is the SECOND argument of this `then`, not a `.catch` after it, and that
      // is load-bearing: a `.catch` would also catch anything the success handler above threw, and
      // then report a turn that ran as one that "could not run" — putting the row back and, worse,
      // firing onFail (a stale landing raises a TEND from there) and filing a turn death that never
      // happened. It answers for the EXEC only.
      }, async (e) => {
        logline('nudge', `${zee.slug}: nudge could not run (${String(e.message).slice(0, 160)}) — cxell may be down; no retry`);
        // The exec that REJECTED may still have said what it did: dk() attaches both streams to
        // `err.dk`, so the same one parser reads the same final result event off it (resultFrom).
        // Two things then follow, and neither used to happen on this path:
        //   • a turn that SPOKE before the exec died spent tokens, and they are charged — "the exec
        //     exited non-zero" is not "nothing ran". Nothing at all on the streams still books zero.
        //   • a resume that died on a 429 is a turn DEATH, not an unreachable cage, and belongs on
        //     the revive ladder rather than in a log line.
        const dk = e?.dk || { code: 1, err: e?.message || '' };
        const result = resultFrom(adapter, dk);
        // Put the row back where it was rather than leaving a zee 'working' on a turn that never
        // started — a stuck 'working' is the same lie as a stuck 'idle', and it also blocks a reap.
        markZeeTurn(zee.id, zee.status === 'working' ? 'working' : 'idle',
                    `${why}: resume could not run — ${String(e.message).slice(0, 120)}`,
                    usageFrom(result)).catch(() => {});
        const death = resumeTurnDeath({ ...dk, result });
        // PER-TURN LEDGER: close the failed resume — errored if it died on a provider/infra error,
        // else just 'ended' (the exec never started, but the row must not sit 'started' forever).
        await endTurn(turn?.id, {
          status: death ? 'errored' : 'ended',
          burn: usageFrom(result),
          stopReason: `${why}: resume could not run — ${String(e.message).slice(0, 120)}`,
        }).catch(() => {});
        if (death) reportTurnDeath({ zeeId: zee.id, xellId, slug: zee.slug, reason: death.message,
                                     code: dk?.code ?? null, err: dk?.err ?? '', result }).catch(() => {});
        // The caller may need to KNOW the message never arrived (a stale landing has no other way
        // to reach its zee). Best-effort by construction: this is already the failure path.
        try { onFail?.(e); } catch { /* a failing handler must not become an unhandled rejection */ }
      })
      // …and a bookkeeping step that threw is still not allowed to become an unhandled rejection.
      .catch((e) => logline('nudge', `${zee.slug}: could not record the finished turn (${String(e.message).slice(0, 120)})`));

    return { nudged: true, zee_id: zee.id, session: zee.claude_session_id, prompt };
  } catch (e) {
    logline('nudge', `nudge for xell ${String(xellId).slice(0, 8)} failed: ${String(e.message).slice(0, 160)}`);
    return { nudged: false, error: e.message };
  }
}

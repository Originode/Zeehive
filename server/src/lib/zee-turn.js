// WHAT STATE IS THIS ZEE'S TURN IN — and what delivery does that state deserve?
//
// Two questions with one answer, kept in a dependency-free leaf so both can be decided in a table
// rather than in the middle of an SSH call. `zee.status` is the queenzee's OWN record of the turn:
// intake writes 'working' when it starts the headless run and 'idle' + last_stop_reason='end_turn'
// when that run returns, and for a cxell zee that is the whole lifecycle (no hooks in the cage, and
// the passive poller skips entrypoint='cxell-cli'). It is NOT `cli_active` — that probe means an
// agent is ATTACHED, which stays true for the life of the container once anyone opens the terminal.

// A turn is IN FLIGHT in these three, and only these three. Lives here rather than in reaper.js so
// the reap guard (reaper.midTurnVerdict) and the message router below cannot drift apart: they are
// the same question — "is a headless run going on in that cage right now?" — asked by two callers.
export const MID_TURN_STATUSES = ['spawning', 'online', 'working'];

// ── WHICH DELIVERY A MESSAGE TO THIS ZEE DESERVES ────────────────────────────────────────────────
//
// WHAT WAS MEASURED (a manager's crew, 2026-08-03), and what it did NOT show. A manager sent its
// next instruction to a worker whose turn had ENDED (status 'idle', last_stop_reason 'end_turn') and
// which had proposed done. `zee say` answered "Delivered into <slug>'s live session". The zee looked
// inert — so the manager spent a whole second xell redoing the work, with a worker holding none of
// the context. The meta-DB timeline says the message DID arrive and DID restart it: the keystrokes
// went into the cage, tmux started zee-attach.sh, the interactive session took the pane, and that
// xell landed a commit eight minutes later. **The delivery was not the defect; the SILENCE was** —
// nothing in the fleet's state moved while that turn ran (see nudge.js markZeeTurn).
//
// So why route on state at all? Because only ONE of the three deliveries starts a turn the queenzee
// can SEE. The keystroke path hands the turn to a TUI inside the cage, where no hook, no poller and
// no pgrep can tell a generating session from one sitting at its prompt (reaper.js says so, in those
// words, as a KNOWN GAP) — so a message delivered that way is unobservable BY CONSTRUCTION, and the
// manager's instrument cannot be fixed without moving the turn to a door the queenzee owns. It also
// removes two guesses that path takes on a finished zee: that a tmux session exists or can be
// created, and that `claude --resume` has its prompt box up within the six seconds before the
// keystrokes are sent.
//
// So the state decides, in this order — and each step is a claim:
//
//   1. NOTHING TO MESSAGE. No cxell zee row: unchanged refusal.
//   2. A DECOMMISSIONED ZEE IS NOT RESUMED. `decommissioned_at` is the FACT the reaper writes when
//      it stops a zee (its status keeps whatever it ended in — see reaper.js), and viewer_kind is
//      NOT cleared with it, so this must be asked BEFORE "is the cxell live?" or a reaped zee reads
//      as reachable. A message must never start a turn on a zee somebody has retired.
//   3. …AND NEITHER IS A ZEE IN A RETIRED XELL, for the same reason one layer up: the cage is gone.
//   4. NO LIVE CXELL. A torn-down cage has no ssh-terminal viewer: unchanged refusal, and it still
//      says which viewer_kind it saw, because "not delivered" without a why sends a human hunting.
//   5. MID-TURN → QUEUED. The pane is the headless run's read-only feed; the cage stores the message
//      and types it in when the turn ends. This is a real delivery and it must keep working: it is
//      the whole point of the talk queue.
//   6. TURN ENDED → RESUMED. The message becomes the prompt of a resumed session — the same door a
//      landing approval comes through, and the only one whose turn the queenzee starts, records and
//      watches end.
//   7. …UNLESS THE SESSION CANNOT BE RE-INVOKED (a runtime with no resume verb, or no session id
//      captured), in which case the keystroke path is the only door left: TYPED into the interactive
//      session zee-attach.sh puts in the pane. Best-effort by contract, and reported as what it is.
//
// Returns { delivery: 'resumed' | 'queued' | 'typed' | 'none', reason } — the reason is a sentence,
// and on 'none' it is the refusal a human/manager reads.
export function decideMessageDelivery({
  present = false,
  status = null,
  viewerKind = null,
  decommissioned = false,
  xellStatus = null,
  runtimeResumable = false,
  sessionResumable = false,
} = {}) {
  if (!present) return { delivery: 'none', reason: 'no cxell zee for this xell (nothing to message)' };
  if (decommissioned) {
    return { delivery: 'none',
             reason: 'this zee has been decommissioned — there is no session left to resume or type into' };
  }
  if (xellStatus === 'retired') {
    return { delivery: 'none', reason: 'this xell has been retired — its cxell is gone' };
  }
  if (viewerKind !== 'ssh-terminal') {
    return { delivery: 'none', reason: `zee is not in a live cxell (viewer_kind=${viewerKind})` };
  }
  if (MID_TURN_STATUSES.includes(status)) {
    return { delivery: 'queued',
             reason: 'the zee is MID-TURN — its pane is a read-only feed, so the message is queued in '
               + 'the cxell and typed into its session the moment the turn ends' };
  }
  if (!runtimeResumable) {
    return { delivery: 'typed',
             reason: 'the turn has ended but this runtime cannot re-invoke a finished session — typing '
               + 'into the interactive session in its pane instead' };
  }
  if (!sessionResumable) {
    return { delivery: 'typed',
             reason: 'the turn has ended but no session id was captured for this zee — typing into the '
               + 'interactive session in its pane instead' };
  }
  return { delivery: 'resumed',
           reason: 'the zee\'s turn has ENDED — resuming its session with the message as the prompt' };
}

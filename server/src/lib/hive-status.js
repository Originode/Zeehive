// SINGLE SOURCE OF TRUTH for a xell's DISPLAY status — the vocabulary shown on each hive hexagon.
//
// The DB `xell_status` enum (provisioning/ready/claimed/working/idle/awaiting-done/tearing-down/…)
// records the raw LIFECYCLE. This projects that lifecycle — plus the live gate/attention SIGNALS the
// row alone can't hold — onto the operator-facing vocabulary, grouped by phase:
//
//   vac-*   the xell is VACANT (a pool xell no zee is on):  provisioning · ready · dirty
//   occ-*   a zee OCCUPIES it:  claimed · working · idle · tendRequest · landRequest ·
//           shipRequest · doneRequest · done
//   live-*  it IS production:  protected · unprotected
//
// Pure and dependency-free so the server read model (fleet.js, self.js) and the web palette
// (web/src/hive/status.js) agree on the exact same keys. The web maps these keys to colour.

// key → { label (pill text), group }. Listing order is priority/reading order within a group.
export const HIVE_STATUS = {
  'vac-provisioning': { label: 'provisioning', group: 'vac' },
  'vac-ready':        { label: 'ready',        group: 'vac' },
  'vac-dirty':        { label: 'dirty',        group: 'vac' },
  'occ-claimed':      { label: 'claimed',      group: 'occ' },
  'occ-working':      { label: 'working',      group: 'occ' },
  'occ-idle':         { label: 'idle',         group: 'occ' },
  'occ-tendRequest':  { label: 'tend?',        group: 'occ' },
  'occ-landRequest':  { label: 'land?',        group: 'occ' },
  'occ-shipRequest':  { label: 'ship?',        group: 'occ' },
  // The two PROD-DATA asks. Both are held gates a human must answer, exactly like land/ship —
  // `prod?` grants the live production DATABASE to the xell, `seed?` has the queenzee run a landed
  // seed file against production on the zee's behalf (the narrow version of the same need).
  'occ-prodRequest':  { label: 'prod?',        group: 'occ' },
  'occ-seedRequest':  { label: 'seed?',        group: 'occ' },
  // A MANAGER zee suggested THIS xell is finished. It is a held decision like the others — a human
  // confirms (with a typed confirmation) and that confirmation is what reaps the cxell — but it was
  // raised by another agent rather than by this xell's own zee, hence its own key.
  'occ-doneSuggest':  { label: 'done?',        group: 'occ' },
  'occ-landHint':     { label: 'land?',        group: 'occ' },
  'occ-shipHint':     { label: 'ship?',        group: 'occ' },
  // QUEUED FOR THE RUNWAY (067). Deliberately NOT `land?`: nobody is being asked anything. Another
  // xell's landing is open on the ref, so this zee's push is in the holding pattern with a position
  // and will be cleared by a nudge when the runway frees. Showing it as a held landing would put a
  // question on a human's screen that has no card and no button behind it.
  'occ-landHolding':  { label: 'holding',      group: 'occ' },
  // STOPPED BY THE OPERATOR — a human pressed pause and the queenzee SIGINT'd this zee's turn
  // (lib/fleet-pause.js, queenzee/pause.js). Its own word for the same reason `holding` has one: a
  // paused zee is quiet, and without this it renders `idle`, which is indistinguishable from a zee
  // that finished — so a human scanning the hive during a pause cannot tell what they actually
  // stopped, and after a play cannot tell what came back.
  'occ-paused':       { label: 'paused',       group: 'occ' },
  'occ-doneRequest':  { label: 'done?',        group: 'occ' },
  'occ-done':         { label: 'done',         group: 'occ' },
  'live-protected':   { label: 'protected',    group: 'live' },
  'live-unprotected': { label: 'unprotected',  group: 'live' },
};

export const HIVE_STATUS_KEYS = Object.keys(HIVE_STATUS);
export function hiveLabel(key) { return HIVE_STATUS[key]?.label || key || '—'; }
export function hiveGroup(key) { return HIVE_STATUS[key]?.group || null; }

// Derive the display status for one xell. `x` is a fleet/self xell row; `sig` carries the live
// SIGNALS the row itself doesn't hold — whether a land/ship request is pending a human, whether the
// zee raised a tend (needs-attention) ping, and whether production's shields are down (a deploy is
// touching it). Precedence within an occupied xell puts HUMAN-ACTIONABLE requests above plain
// activity, because those are what a human scanning the hive is looking for.
export function hiveStatus(x, sig = {}) {
  const {
    landPending = false, shipPending = false, tendPending = false, prodUnprotected = false,
    landHint = false, shipHint = false, prodBindPending = false, seedPending = false,
    doneSuggested = false, landHolding = false, paused = false,
  } = sig;

  // ── production ──
  if (x.is_production) return prodUnprotected ? 'live-unprotected' : 'live-protected';

  const s = x.status;

  // ── terminal / housekeeping (these outrank everything: they describe where the xell IS going) ──
  //
  // NOTE what is NOT here any more: 'awaiting-done'. It used to sit on this line, above every
  // signal, and that was a category error with a real cost — a zee that proposes done and is then
  // handed more work had every later signal MASKED behind a stale done card: an open tend, a held
  // landing, a pending ship button. It happened to a manager zee whose tend said "approve the urgent
  // ship" and stayed invisible for about seven hours, and a second zee independently worked out the
  // trap and routed around it by refusing to propose done while its ship was pending. A rule a zee
  // has to remember and route around is a design flaw, not a discipline problem. So:
  //
  //   'tearing-down' is a FACT — a human already confirmed, the queenzee is reaping, and nothing
  //   the zee wants can change it. Showing anything else would invite action on a xell that is
  //   disappearing. It keeps outranking everything.
  //
  //   'awaiting-done' is a REQUEST — the zee ASKING to be finished. That makes it a sibling of
  //   land?/ship?/tend?, not of tearing-down, and it is the WEAKEST of them: nothing is blocked
  //   while it waits, and it is the one ask whose wrong answer is destructive (confirming it reaps
  //   the cxell). Every other signal is either more urgent or is something the human needs to see
  //   BEFORE answering it — unlanded commits especially. So it now ranks just above plain activity,
  //   below the gates, tend, a manager's done-suggestion and the readiness hints. See the occupied
  //   block below.
  if (s === 'tearing-down')              return 'occ-done';          // a human confirmed; reaping
  if (s === 'error' || s === 'husk')     return 'vac-dirty';         // needs queenzee housekeeping

  // RETIRED: the xell is GONE — reaped, worktree and containers removed, zee decommissioned. There
  // is no hive word for it because the hive never draws one: every caller here filters
  // `status <> 'retired'` before asking (fleet.js, managers.crewFor), and self.js only ever asks
  // about a live xell it is running inside. So this is a GUARD, not a new state, and it changes no
  // existing behaviour — nothing that calls this function today can reach this line.
  //
  // It exists because the fallback at the bottom of this function ("an occupied-but-unclassified
  // row reads as claimed rather than blank") was speaking for retired rows too, and that answer is
  // a lie rather than a safe default: a caller that did NOT pre-filter got 'occ-claimed' for a xell
  // reaped weeks ago. lib/work-items.js resolves xells by id — it inherits no such filter — so a
  // board card reported a live zee on work whose agent no longer existed. Answering null says the
  // only true thing: this row has no place on the hive. hiveLabel(null) is already '—'.
  if (s === 'retired')                   return null;

  // ── vacant pool xells (no zee has claimed them yet) ──
  if (s === 'provisioning')              return 'vac-provisioning';
  if (s === 'ready')                     return 'vac-ready';

  // ── occupied: a zee is on it. Human-actionable requests first, then live activity. ──
  if (shipPending)                       return 'occ-shipRequest';
  if (landPending)                       return 'occ-landRequest';
  // Prod-DATA asks rank with the other held gates and ABOVE tend: like a landing, the zee is blocked
  // until a human answers, and unlike a tend there is a specific decision (and a button) waiting.
  // Seed first — it is the narrow, reviewable one, so when a zee has asked for both, the cheaper
  // decision is the one the hexagon puts in front of you.
  if (seedPending)                       return 'occ-seedRequest';
  if (prodBindPending)                   return 'occ-prodRequest';
  if (tendPending)                       return 'occ-tendRequest';
  // A manager's "this one looks finished" — a real decision waiting on a human, below the gates that
  // BLOCK the zee (it keeps working meanwhile) and above the readiness hints.
  if (doneSuggested)                     return 'occ-doneSuggest';
  // Readiness HINTS rank below the real held requests and tend (those are firmer asks), but above
  // live activity — a "this looks ready" prompt should be visible even while the zee keeps polishing.
  if (shipHint)                          return 'occ-shipHint';
  if (landHint)                          return 'occ-landHint';
  // The zee's OWN done proposal — deliberately the last human-actionable signal (see the note
  // above). It outranks only plain activity. Below the hints on purpose: the manual already warns
  // that proposing done "masks your own land? button and invites a human to tear you down with work
  // still only on your branch" — with this order that hazard cannot happen, because a xell with
  // unlanded commits shows land? until the work is landed, and only then reads done?. The proposal
  // is never lost: `awaiting_done` is its own field on the read models, so the console's done card
  // does not depend on this key.
  if (s === 'awaiting-done')             return 'occ-doneRequest';

  // HOLDING for the runway — below every ask, above plain activity, and that placement is the whole
  // argument. It asks a human for NOTHING, so it must never outrank something that does (a tend
  // behind a queued landing is still the thing to act on). But it outranks working/idle because it
  // is the only thing on the screen that ANSWERS "why has this zee gone quiet with commits it wants
  // to land?" — without it, a queued zee is indistinguishable from an idle one, which is exactly the
  // invisibility this protocol would otherwise introduce.
  if (landHolding)                       return 'occ-landHolding';

  // PAUSED — below every ask and below holding, above plain activity, and the placement is the same
  // argument as `holding` made: it asks a human for NOTHING (the human who caused it is the one
  // reading the screen), so it must never cover something that does. A held landing still needs
  // deciding while the fleet is still, and a tend raised before the pause is still the thing to act
  // on. But it outranks working/idle, because it is the only thing that answers "why has this zee
  // gone quiet?" — and answering that with `idle` is how an operator loses track of what their own
  // pause stopped.
  if (paused)                            return 'occ-paused';

  // WORKING is decided by the ZEE'S OWN STATUS, and by nothing else.
  //
  // `cli_active` used to be ORed in here and it does not mean what the name suggests. It is
  // monitor.js's probe, and for a cxell zee that probe is a BROAD `pgrep claude|codex|kimi` inside
  // the cage (AGENT_PROC_PATTERN). The container is kept after the turn so commits stay
  // collectible, and the moment anyone opens the zee's terminal or sends it a message, zee-attach.sh
  // leaves `claude --resume` sitting in the pane for the life of that container. So the flag goes
  // true on the first attach and NEVER goes false again: it observes ATTACHMENT, not work.
  //
  // ORing it made the normal end state of every cxell job — turn returned, zee idle, a resting
  // session in the pane — render `working` forever, and a manager watching its crew read five
  // finished workers as busy for a whole session. The zee's own status is the queenzee's own record
  // of the turn ('working' when it starts the run, 'idle' + end_turn when it returns), so it is both
  // the honest signal and the only one that can ever go back down.
  //
  // This is DISPLAY only. What may be reaped is decided by reaper.midTurnVerdict(), which is a
  // separate guard with its own force gate — nothing here widens it.
  const working = x.zee_status === 'working' || s === 'working';
  if (working)                           return 'occ-working';
  if (s === 'claimed')                   return 'occ-claimed';
  if (s === 'idle')                      return 'occ-idle';

  // An occupied-but-unclassified row reads as claimed rather than blank.
  return 'occ-claimed';
}

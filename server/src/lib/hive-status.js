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
  'occ-landHint':     { label: 'land?',        group: 'occ' },
  'occ-shipHint':     { label: 'ship?',        group: 'occ' },
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
    landHint = false, shipHint = false,
  } = sig;

  // ── production ──
  if (x.is_production) return prodUnprotected ? 'live-unprotected' : 'live-protected';

  const s = x.status;

  // ── terminal / housekeeping (these outrank everything: they describe where the xell IS going) ──
  if (s === 'awaiting-done')             return 'occ-doneRequest';   // the zee proposed done
  if (s === 'tearing-down')              return 'occ-done';          // a human confirmed; reaping
  if (s === 'error' || s === 'husk')     return 'vac-dirty';         // needs queenzee housekeeping

  // ── vacant pool xells (no zee has claimed them yet) ──
  if (s === 'provisioning')              return 'vac-provisioning';
  if (s === 'ready')                     return 'vac-ready';

  // ── occupied: a zee is on it. Human-actionable requests first, then live activity. ──
  if (shipPending)                       return 'occ-shipRequest';
  if (landPending)                       return 'occ-landRequest';
  if (tendPending)                       return 'occ-tendRequest';
  // Readiness HINTS rank below the real held requests and tend (those are firmer asks), but above
  // live activity — a "this looks ready" prompt should be visible even while the zee keeps polishing.
  if (shipHint)                          return 'occ-shipHint';
  if (landHint)                          return 'occ-landHint';

  const working = x.zee_status === 'working' || x.cli_active === true || s === 'working';
  if (working)                           return 'occ-working';
  if (s === 'claimed')                   return 'occ-claimed';
  if (s === 'idle')                      return 'occ-idle';

  // An occupied-but-unclassified row reads as claimed rather than blank.
  return 'occ-claimed';
}

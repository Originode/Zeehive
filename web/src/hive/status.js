// RENDER-side mirror of server/src/lib/hive-status.js: the COLOUR each hive status key paints with.
// The server computes `x.hive_status` (the key) and `x.hive_status_label` (the pill text) — so this
// file only owns the palette. Keep the keys in lockstep with hive-status.js.
//
// The palette is a TEMPERATURE scale keyed to how HOT (active / urgent / irreversible) a xell is, so
// a human scanning the hive reads urgency straight off the colour, coldest → hottest:
//
//   violet  provisioning   — being born, no activity yet (coldest)
//   blue    ready/claimed  — pooled or just taken, nothing happening
//   green   working        — live work, healthy
//   yellow  needs attention — idle / tend / dirty: a human should look
//   orange  production      — live, shields up
//   red     land / ship / unprotected — main or prod is being TOUCHED (hottest)
//
// The `occ-*Hint`/`occ-*Request` keys stay within their family (a hint is a softer ask than a held
// request, so it is a lighter tint of the same hue). `hiveHeat` below exposes the same ordering as a
// 0..1 scalar so the canvas can also darken cold hexes and brighten hot ones.
export const HIVE_COLORS = {
  // ── cold ──────────────────────────────────────────────────────────────────
  'vac-provisioning': '#8b5cf6',   // violet — coldest: no zee, still being provisioned
  'occ-claimed':      '#7c83f5',   // blue-violet — a zee took it but isn't working yet
  'vac-ready':        '#5b8cff',   // blue — pooled, idle, ready to claim
  'occ-doneRequest':  '#3bc6c0',   // teal — winding down (done proposed)
  'occ-done':         '#6fcf97',   // cool green — reaping
  'occ-working':      '#35c46b',   // green — live work
  // ── warm: needs a human's eyes ──────────────────────────────────────────────
  'vac-dirty':        '#cd9a4a',   // dull amber — needs queenzee housekeeping
  'occ-idle':         '#e0a53b',   // amber — a zee gone quiet
  'occ-tendRequest':  '#f2c518',   // yellow — "I need a human"
  // The ENVIRONMENT is wrong under a running zee (env reconcile refused; the xell kept its old
  // .zeehive.env). Magenta, and the only magenta on the scale, because it belongs to no family
  // above: it is not the zee asking (yellow) and not main/prod being touched (red) — it is the
  // ground the zee is standing on being wrong, and it should not read as either.
  'occ-envAlert':     '#e05fd0',   // magenta — the xell's environment could not be reconciled
  'occ-doneSuggest':  '#3bb0c6',   // cyan — a MANAGER zee suggested this xell is finished (a human confirms)
  // Deliberately COOL, and deliberately not the land? red: a queued landing asks a human for
  // NOTHING. It is a waiting state that explains a quiet zee, so it should read as "parked", not
  // as another thing on fire.
  'occ-landHolding':  '#6f8fbf',   // slate blue — queued for the runway, nothing to decide
  // STOPPED BY THE OPERATOR (the pause button). Grey on purpose, and the only grey on the scale: a
  // paused zee is not warm (nothing is happening) and not cold (it is mid-job, not pooled) — it is
  // OUT. Reading a paused fleet should look like a screen that has been switched off, not like a
  // hive with something wrong in it.
  'occ-paused':       '#8b93a1',   // grey — interrupted by a human; nothing to decide, nothing wrong
  // ── hot: something irreversible is being touched ────────────────────────────
  'occ-landHint':     '#ef8f6a',   // soft red-orange — land looks ready (a softer ask)
  'occ-shipHint':     '#f2a06a',   // soft orange — ship looks ready
  'live-protected':   '#f0913b',   // orange — production, shields up
  'occ-seedRequest':  '#e0563f',   // red-orange — a zee asked the queenzee to write DATA to prod
  'occ-prodRequest':  '#d9455f',   // crimson — a zee asked to be handed the LIVE prod database
  'occ-mintRequest':  '#e34b5e',   // red-rose — a router asked a human for ANOTHER manager (held decision)
  'occ-landRequest':  '#e5554e',   // red — a landing is held (main is being touched)
  'occ-shipRequest':  '#ef5a3c',   // red-orange — a ship is held (prod is being touched)
  'live-unprotected': '#e5554e',   // red — prod shields down / a deploy is touching it
};

// The same cold→hot ordering as a 0..1 heat scalar. The canvas reads this to keep the palette's
// promise physically: a COLD hex sits darker (a fainter wash of its colour) and a HOT one glows
// brighter — so "no activity" recedes and "being touched" jumps out even before you read the hue.
export const HIVE_HEAT = {
  'vac-provisioning': 0.00,
  'occ-claimed':      0.12,
  'vac-ready':        0.20,
  'occ-doneRequest':  0.26,
  'occ-done':         0.28,
  'occ-working':      0.40,
  'vac-dirty':        0.58,
  'occ-idle':         0.62,
  'occ-tendRequest':  0.72,
  // Hotter than tend, cooler than a held land/ship: nothing irreversible is happening right now,
  // but a live zee is running on an environment the queenzee itself refused to write.
  'occ-envAlert':     0.90,
  'occ-doneSuggest':  0.30,
  'occ-landHolding':  0.34,
  'occ-paused':       0.10,        // coldest of the occupied keys: deliberately stopped, so it recedes
  'occ-landHint':     0.80,
  'occ-shipHint':     0.82,
  'live-protected':   0.86,
  'occ-seedRequest':  1.00,
  'occ-prodRequest':  1.00,
  'occ-mintRequest':  1.00,
  'occ-landRequest':  1.00,
  'occ-shipRequest':  1.00,
  'live-unprotected': 1.00,
};
export function hiveHeat(key) { return key in HIVE_HEAT ? HIVE_HEAT[key] : 0.4; }

// Fallback labels, in case an older server payload lacks hive_status_label. Server-supplied
// `hive_status_label` is preferred wherever a xell row is in hand.
export const HIVE_LABELS = {
  'vac-provisioning': 'provisioning',
  'vac-ready':        'ready',
  'vac-dirty':        'dirty',
  'occ-claimed':      'claimed',
  'occ-working':      'working',
  'occ-idle':         'idle',
  'occ-paused':       'paused',
  'occ-tendRequest':  'tend?',
  'occ-envAlert':     'env!',
  'occ-landRequest':  'land?',
  'occ-shipRequest':  'ship?',
  'occ-prodRequest':  'prod?',
  'occ-seedRequest':  'seed?',
  'occ-mintRequest':  'manager?',
  'occ-landHint':     'land?',
  'occ-shipHint':     'ship?',
  'occ-landHolding':  'holding',
  'occ-doneRequest':  'done?',
  'occ-doneSuggest':  'done?',
  'occ-done':         'done',
  'live-protected':   'protected',
  'live-unprotected': 'unprotected',
};

export function hiveColor(key, fallback) { return HIVE_COLORS[key] || fallback || '#8b97a8'; }
export function hiveStatusLabel(x) {
  return x?.hive_status_label || HIVE_LABELS[x?.hive_status] || x?.status || '—';
}

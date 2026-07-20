// RENDER-side mirror of server/src/lib/hive-status.js: the COLOUR each hive status key paints with.
// The server computes `x.hive_status` (the key) and `x.hive_status_label` (the pill text) — so this
// file only owns the palette. Keep the keys in lockstep with hive-status.js.
//
//   vac-*   vacant pool xell (blue = pooled/idle, amber = needs housekeeping)
//   occ-*   a zee is on it (green = live work; the *Request keys are tinted by URGENCY so a human
//           scanning the hive spots what needs them — pink tend, gold ship, teal done…)
//   live-*  production (gold shield = protected; red = shields down / a deploy is touching it)
export const HIVE_COLORS = {
  'vac-provisioning': '#5b8cff',
  'vac-ready':        '#5b8cff',
  'vac-dirty':        '#d98c5f',
  'occ-claimed':      '#9b8cff',
  'occ-working':      '#35c46b',
  'occ-idle':         '#e0a53b',
  'occ-tendRequest':  '#e26fae',
  'occ-landRequest':  '#7b9cff',
  'occ-shipRequest':  '#f2c14e',
  'occ-doneRequest':  '#3bc6c0',
  'occ-done':         '#8bd98c',
  'live-protected':   '#f2c14e',
  'live-unprotected': '#e5554e',
};

// Fallback labels, in case an older server payload lacks hive_status_label. Server-supplied
// `hive_status_label` is preferred wherever a xell row is in hand.
export const HIVE_LABELS = {
  'vac-provisioning': 'provisioning',
  'vac-ready':        'ready',
  'vac-dirty':        'dirty',
  'occ-claimed':      'claimed',
  'occ-working':      'working',
  'occ-idle':         'idle',
  'occ-tendRequest':  'tend?',
  'occ-landRequest':  'land?',
  'occ-shipRequest':  'ship?',
  'occ-doneRequest':  'done?',
  'occ-done':         'done',
  'live-protected':   'protected',
  'live-unprotected': 'unprotected',
};

export function hiveColor(key, fallback) { return HIVE_COLORS[key] || fallback || '#8b97a8'; }
export function hiveStatusLabel(x) {
  return x?.hive_status_label || HIVE_LABELS[x?.hive_status] || x?.status || '—';
}

// THE GATEWAY'S OWN 502 UPSTREAM-FAILURE MARKER — the one string that proves the gateway itself
// ANSWERED.
//
// The gateway proxy (lib/gateway.js) writes "gateway upstream unreachable: <err>" as the 502 body
// when the UPSTREAM provider fails to answer (a dead vendor, a bad upstream URL, a DNS failure on
// the provider's host). A message carrying this prefix therefore PROVES the gateway was reachable —
// it produced an HTTP 502 — so the turn-death classifier (lib/turn-death.js) treats it as an
// UPSTREAM/vendor failure, never a dead gateway, whether or not the err names an address.
//
// Defined HERE, in a dependency-free leaf, so BOTH the gateway's error path and the classifier read
// the SAME constant — the two can never drift (a classifier retyping this string would silently
// start claiming the gateway's own answers as OUR outage the day the wording changed).
export const GATEWAY_UPSTREAM_UNREACHABLE_PREFIX = 'gateway upstream unreachable';

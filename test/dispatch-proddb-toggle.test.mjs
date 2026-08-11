// PRODUCTION DB ACCESS TOGGLE IN THE PROMPT WINDOW.
//
// The bug this guards: the Production DB access toggle lived inside the DIRECT-dispatch controls
// block (`{(!routerGate || routerMode) && (…)}`). The day the router gate shipped, every project
// with a live router stopped showing that block for a worker prompt — so the toggle vanished from
// the "+ prompt" window on the common path. A human who needed LIVE PROD had no switch to flip.
//
// The fix: the toggle lives OUTSIDE the router-hidden controls (it is a human decision about the
// xell, not a router knob). With a live router, turning it on opens Instant deploy (the only door
// that can apply `db: 'db-shared-prod'` — selfDispatch refuses every db choice from a manager, and
// the router is one). Route via router is disabled when LIVE PROD is on, rather than silently
// dropping the flag.
//
// No browser, no DB. Same static-source technique as manager-compose / router-custom-deployment.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const disp = read('web/src/Dispatch.jsx');

console.log('\n── the toggle is in the prompt window, outside the router-hidden knobs ──');
ok(/data-testid="dispatch-proddb-on"/.test(disp) && /data-testid="dispatch-proddb-off"/.test(disp),
   'the composer still has the LIVE PROD on/off segments');
ok(/data-testid="dispatch-proddb-block"/.test(disp),
   'the Production DB block has its own testid (so it is a distinct surface, not nested in the knobs)');

// The block must NOT sit inside the router-gate-hidden controls. Extract the router-hidden
// controls region and assert the proddb-on testid is absent from it; then assert the proddb block
// is gated only on !routerMode (visible for worker prompts with a live router).
const gateOpen = disp.indexOf('{(!routerGate || routerMode) && (');
ok(gateOpen > 0, 'the router-gate-hidden controls region still exists');
// Find the matching close of that region by the next top-level ")}" after the disp-controls that
// ends with the visual-verification field — the proddb block comment names the bug it closes.
const proddbBlock = disp.indexOf('data-testid="dispatch-proddb-block"');
ok(proddbBlock > gateOpen, 'the proddb block appears after the router-gate open');
const hiddenSlice = disp.slice(gateOpen, proddbBlock);
ok(!/data-testid="dispatch-proddb-on"/.test(hiddenSlice),
   'the LIVE PROD toggle is NOT inside the router-hidden controls slice');
ok(/\{!routerMode && \(\s*\n\s*<div className="disp-controls" data-testid="dispatch-proddb-block"/.test(disp),
   'the proddb block renders whenever we are not in router-deploy mode (live router does not hide it)');

console.log('\n── payload + Instant door honour the toggle ──');
ok(/\.\.\.\(prodDb \? \{ db: 'db-shared-prod' \} : \{\}\)/.test(disp),
   'directPayload still sends db: \'db-shared-prod\' when the toggle is on');
ok(/wantsInstant/.test(disp) && /customCount > 0 \|\| prodDb/.test(disp),
   'LIVE PROD alone opens Instant deploy (no custom pin required)');
ok(/data-testid="instant-preview-db"/.test(disp) && /db=LIVE PROD/.test(disp),
   'Instant preview names db=LIVE PROD when the toggle is on');
ok(/LIVE PROD cannot go through the router/.test(disp),
   'Route via router refuses (or is disabled) when LIVE PROD is on — no silent drop');
ok(/routerGate && liveRouter && prodDb/.test(disp),
   'the Route button is disabled specifically when LIVE PROD is on with a live router');

console.log('\n── manager variant is unchanged ──');
ok(/data-testid="manager-proddb-note"/.test(disp),
   'a manager still gets the read-only FACT, not a toggle');
ok(/\{!manager && prodDb &&/.test(disp),
   'the LIVE-PROD warning banner still never renders for a manager');

console.log(fail ? `\n✗ ${fail} check(s) failed\n` : '\nAll checks passed\n');
process.exit(fail ? 1 : 0);

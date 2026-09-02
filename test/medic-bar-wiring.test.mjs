// MEDIC DISPATCH ON THE NEEDS-YOU BAR — the CONSOLE side, checked statically (the prod-asks-console
// model: no linter and no browser in CI, so the wiring is asserted by reading the source).
//
// The failure this guards is the "where is the medic button" bug: a project whose pool stopped
// filling (a PROVISION-INFRA card, or a hand-written blocker) often has NO waiting xell — the fill
// just stops — so the one line that says who is waiting on you said NOTHING, and the ⛑ was only on
// the Project-setup conditions tab nobody opens while a project is halted. #18 wires it into the
// bar itself. Three contracts must hold or the bar is silently dead again:
//
//   1. App.jsx renders <NeedsYouBar> WITH the blockers payload and a dispatch handler (an import
//      nothing renders is the old bug; a prop nothing passes is the same bug one layer down);
//   2. ONE eligibility predicate — the bar's chip excludes only the rolling CODE fact
//      ("main does not build since …"), the SAME rule as the ProjectSetup row button. Two copies of
//      the rule drifting apart is exactly how the button reappears in one place and not the other;
//   3. the ⛑ button's styles exist (an unstyled button on the one line that cannot scroll is a
//      button nobody sees as one).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const app = read('web/src/App.jsx');
const setup = read('web/src/ProjectSetup.jsx');
const css = read('web/src/styles.css');

console.log('\n── App.jsx imports the dispatcher and RENDERS the bar with the blockers payload ──');
const imp = app.match(/import\s+([^;]*?)\s+from\s+['"]\.\/api\.js['"]/);
ok(!!imp && /dispatchMedic/.test(imp[1]), 'App.jsx imports dispatchMedic from ./api.js');
ok(/<NeedsYouBar[\s\S]*?blockers=\{projectBlockers\}/.test(app),
   'App.jsx renders <NeedsYouBar> with blockers={projectBlockers}');
ok(/<NeedsYouBar[\s\S]*?onDispatchMedic=\{handleDispatchMedic\}/.test(app),
   '…and an onDispatchMedic handler (a prop nothing passes is the old bug one layer down)');
ok(/handleDispatchMedic\s*=\s*useCallback[\s\S]*?await\s+dispatchMedic\(/.test(app),
   'the handler actually calls the API seam');

console.log('\n── ONE eligibility predicate across the two ⛑ surfaces ──');
ok(app.includes("startsWith('main does not build since')"),
   'the bar filters conditions by the CODE-fact prefix');
ok(setup.includes("body.startsWith('main does not build since')"),
   'the ProjectSetup row button uses the SAME predicate');
// They must name the SAME literal — count occurrences across both surfaces of the full prefix.
const both = (app + setup).match(/'main does not build since'/g) || [];
ok(both.length >= 2, `both surfaces exclude exactly the rolling CODE fact (the literal appears ${both.length}× across the two)`);

console.log('\n── the ⛑ is styled on the bar (an unstyled control on the one line that cannot scroll) ──');
ok(/\.needsyou \.ny-chip\.proj/.test(css), '.needsyou .ny-chip.proj is styled (the blocker chip reads as a blocker)');
ok(/\.ny-blocker\s*\{/.test(css) && /\.ny-blocker-body\s*\{/.test(css), 'the opened blocker rows are styled');
ok(/\.needsyou \.pill/.test(css), '.needsyou .pill is styled (the ⛑ button)');

// ── THE EMERGENCY GATE (the follow-up directive, 2026-09-02) ─────────────────────────────────────
// "do not fill the panel with tickets... the point of medic is emergency response. so a dispatch
// button should only show when a zee is being blocked." The gate is ONE server-computed fact
// (fleet.medic_emergency: live zees with a failing db preflight / failing proof / INFRA-classed
// build failure) and BOTH surfaces must read it — a conditions list alone must render NO medic
// button anywhere. These assertions are what keep the always-on ticket wall from growing back.
console.log('\n── the ⛑ renders ONLY during a medic emergency (a zee is being blocked) ──');
const fleetSrc = read('server/src/lib/fleet.js');
ok(/medic_emergency/.test(fleetSrc) && /last_build_error_class === 'infra'/.test(fleetSrc)
   && /preflight_error/.test(fleetSrc) && /proof_error/.test(fleetSrc),
   'fleet.js computes medic_emergency from live-zee xells with infra evidence (preflight/proof/infra build)');
ok(/medic_emergency,/.test(fleetSrc), 'the fleet snapshot carries medic_emergency');
ok(/fleet\.medic_emergency/.test(app), 'App.jsx reads fleet.medic_emergency');
ok(/medicEmergency\.length > 0 && blockers\.length > 0 &&/.test(app),
   'the bar CHIP is gated on the emergency (never on the conditions list alone)');
ok(/blockersOpen && medicEmergency\.length > 0 &&/.test(app),
   'the opened dispatch panel is gated on the emergency too');
ok(/<NeedsYouBar[\s\S]*?medicEmergency=\{medicEmergency\}/.test(app),
   'App.jsx passes medicEmergency into the bar');
ok(/<ProjectSetup[\s\S]*?medicEmergency=\{medicEmergency\}/.test(app),
   'App.jsx passes medicEmergency into ProjectSetup');
ok(/const showMedic = medicEmergency\.length > 0 &&/.test(setup),
   'the ProjectSetup row button is gated on the SAME emergency fact');
ok(/medic-gate-note/.test(setup),
   'the conditions editor SAYS why the button is absent (a human who saw it yesterday will hunt for it)');

console.log(fail ? `\n${fail} FAILURE(S)\n` : '\nall good\n');
process.exit(fail ? 1 : 0);

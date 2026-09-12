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
//      button nobody sees as one);
//   4. the auto_dispatch_medic toggle (255) exists in the console AND its dispatch path is the SAME
//      seam the button drives — a policy on a parallel path is the thing that card forbids.
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
ok(!!imp && /dispatchMedicFromCall/.test(imp[1]),
   'App.jsx imports dispatchMedicFromCall from ./api.js (the CALLED-zee dispatch seam, medic_call 251)');
ok(/<NeedsYouBar[\s\S]*?blockers=\{projectBlockers\}/.test(app),
   'App.jsx renders <NeedsYouBar> with blockers={projectBlockers}');
ok(/<NeedsYouBar[\s\S]*?onDispatchMedic=\{handleDispatchMedic\}/.test(app),
   '…and an onDispatchMedic handler (a prop nothing passes is the old bug one layer down)');
ok(/handleDispatchMedic\s*=\s*useCallback[\s\S]*?await\s+dispatchMedic\(/.test(app),
   'the handler actually calls the API seam');
ok(/<NeedsYouBar[\s\S]*?onDispatchCall=\{handleDispatchCall\}/.test(app),
   'the bar ALSO gets an onDispatchCall handler for CALLED zees (medic_call 251)');
ok(/handleDispatchCall\s*=\s*useCallback[\s\S]*?await\s+dispatchMedicFromCall\(/.test(app),
   'the CALLED-call handler actually calls the dispatchMedicFromCall API seam');
ok(/<MedicBay[\s\S]*?calls=\{calledCalls\}/.test(app),
   'App.jsx passes the CALLED calls into the Medic Bay (its header names them)');

console.log('\n── the DISMISS seams are imported and wired (a human can say NO to all three ask-places) ──');
ok(!!imp && /dismissMedicCall/.test(imp[1]),
   'App.jsx imports dismissMedicCall from ./api.js (a CALLED zee is declined, not hidden)');
ok(!!imp && /dismissMedicSuggestion/.test(imp[1]) && /undoMedicDismissal/.test(imp[1]),
   'App.jsx imports dismissMedicSuggestion + undoMedicDismissal (the rowless suggestions and their way back)');
ok(/<NeedsYouBar[\s\S]*?medicDismissals=\{medicDismissals\}/.test(app),
   'App.jsx passes medicDismissals into the bar (the muted "N dismissed · UNDO" line)');
ok(/<NeedsYouBar[\s\S]*?onDismissMedicCall=\{handleDismissMedicCall\}/.test(app)
   && /<NeedsYouBar[\s\S]*?onDismissMedicSuggestion=\{handleDismissMedicSuggestion\}/.test(app)
   && /<NeedsYouBar[\s\S]*?onUndoMedicDismissal=\{handleUndoMedicDismissal\}/.test(app),
   'the bar gets all three dismiss handlers (call decline, suggestion dismiss, undo)');
ok(/<ProjectSetup[\s\S]*?medicDismissals=\{medicDismissals\}/.test(app)
   && /<ProjectSetup[\s\S]*?onDismissMedicSuggestion=\{handleDismissMedicSuggestion\}/.test(app)
   && /<ProjectSetup[\s\S]*?onUndoMedicDismissal=\{handleUndoMedicDismissal\}/.test(app),
   'ProjectSetup gets the dismiss props too (its conditions rows carry the same ⛑ buttons)');
ok(/onDismissMedicCall={handleDismissMedicCall}/.test(app)
   && /await dismissMedicCall\(/.test(app)
   && /A note is required/.test(app),
   'the CALL dismiss handler prompts for a REQUIRED note and calls the decline seam');
ok(/medicDismissals={medicDismissals}/.test(setup)
   && /medicEmergency={medicEmergency}/.test(setup)
   && /onDismissMedicSuggestion=\{onDismissMedicSuggestion\}/.test(setup)
   && /onUndoMedicDismissal=\{onUndoMedicDismissal\}/.test(setup),
   'ProjectSetup threads the medic payload + dismiss handlers down to the conditions editor');
ok(/ConditionsSection\([^)]*medicDismissals/.test(setup),
   'ConditionsSection accepts medicDismissals (the latent missing-prop bug is closed: medicEmergency reaches the rows)');
ok(/ny-dismissed/.test(app) && /ny-dismissed/.test(setup) && /ny-dismissed/.test(css),
   'the muted "N dismissed · UNDO" line renders on BOTH the bar and the conditions editor, and is styled');
ok(/✕ Decline/.test(app), 'a CALLED card carries a "✕ Decline" control beside its ⛑ Dispatch button');

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
ok(/source: 'called'/.test(fleetSrc) && /FROM medic_call/.test(fleetSrc)
   && /byXell\.set\(c\.xell_id/.test(fleetSrc),
   'fleet.js FOLDS medic_call rows (251) into medic_emergency as source:"called", superseding the infra row for the same xell');
ok(/fleet\.medic_emergency/.test(app), 'App.jsx reads fleet.medic_emergency');
ok(/medicEmergency\.length > 0 && \(blockers\.length > 0 \|\| calledCalls\.length > 0\) &&/.test(app),
   'the bar CHIP is gated on the emergency (a condition blocker OR a zee CALLED in — never on a list alone)');
ok(/const calledCalls = medicEmergency\.filter\(\(e\) => e\.source === 'called'\)/.test(app),
   'App.jsx derives calledCalls from medicEmergency (source==="called", the medic_call fold-in)');
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

console.log('\n── the SERVER carries the dismissal surface (fleet + role wall + routes) ──');
const routesSrc = read('server/src/api/routes.js');
const roleSrc = read('server/src/lib/medic-role.js');
const dismissLib = read('server/src/lib/medic-dismissals.js');
ok(/medic_dismissals: active/.test(fleetSrc),
   'the fleet snapshot returns medic_dismissals (the muted UNDO line\'s payload)');
ok(/medic_dismissal/.test(fleetSrc) && /fingerprintMedicText/.test(fleetSrc),
   'fleet.js filters dismissed infra rows and condition cards by fingerprint');
ok(/'medic_dismissal'/.test(roleSrc),
   'the medic role gets NO write on medic_dismissal (MEDIC_NO_WRITE_TABLES — a HUMAN\'s verb on the owner pool)');
ok(/router\.post\('\/medic-calls\/:callId\/dismiss'/.test(routesSrc)
   && /router\.post\('\/medic-dismissals'/.test(routesSrc)
   && /router\.delete\('\/medic-dismissals\/:id'/.test(routesSrc),
   'routes.js exposes the three dismissal routes (call decline, suggestion store, undo)');
ok(/export function fingerprintMedicText/.test(dismissLib)
   && /ON CONFLICT \(project_id, target_kind, target_id, fingerprint\)/.test(dismissLib),
   'medic-dismissals.js fingerprints the shown text and upserts per target (no timers — the fingerprint IS the expiry)');

console.log('\n── the auto_dispatch_medic policy (255): console toggle + ONE dispatch seam ──');
ok(/field="auto_dispatch_medic"/.test(app) && /label="medics"/.test(app),
   'App.jsx renders the auto_dispatch_medic switch beside the other auto-* policies');
ok(/field === 'auto_dispatch_medic'[\s\S]{0,400}showConfirm/.test(app),
   'enabling it asks for confirmation — it dispatches with no human click (the same treatment ships/seeds/done get)');
ok(/dispatchMedicCall\(call/.test(routesSrc),
   'the console dispatch route drives the SHARED dispatchMedicCall seam (the policy cannot take a parallel path)');

console.log(fail ? `\n${fail} FAILURE(S)\n` : '\nall good\n');
process.exit(fail ? 1 : 0);

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

console.log(fail ? `\n${fail} FAILURE(S)\n` : '\nall good\n');
process.exit(fail ? 1 : 0);

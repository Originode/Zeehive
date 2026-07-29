// A REFUSED SHIP MUST NOT DISAPPEAR.
//
// The bug this pins, reported by an operator as "some ship requests seem to be missing… xells
// insist they have ship requests… but i see zero": they were never raised. requestShip REFUSES a
// ship whose work is not landed (or whose worktree is dirty, or whose ship ref will not resolve)
// and writes no ship_request row — so there is nothing to render. The refusal came back HTTP 200
// with `{ok:false}` and the cxell CLI printed that JSON and exited 0, so a refusal was shaped
// exactly like a success; the only trace on the queenzee side was one line in an in-memory ring
// buffer, gone at the next restart. Zees relayed "your approval is pending" for asks that did not
// exist, and no human could disprove it.
//
// Three properties are pinned here, all reachable without a browser or a DB: the zee is told NO in
// terms it cannot relay as YES, the human can SEE the refused ask, and an open request can no
// longer be hidden from the human while still blocking the zee.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// ── 1. the CLI: ok:false is a FAILED command ──
console.log('\n── the cxell CLI cannot print a refusal as a success ──');
const cli = read('scripts/zee');
const outFn = cli.slice(cli.indexOf('function out('), cli.indexOf('function usage('));
ok(/j\.ok === false/.test(outFn), 'out() inspects ok:false — an HTTP 200 that says "no" is still a no');
ok(/DID NOT HAPPEN/.test(outFn), 'and says, in words, that the thing did not happen');
ok(/process\.exit\(1\)/.test(outFn), 'and exits 1, so `zee x && …` and exit-code nudges tell the truth');
ok(/refused/.test(outFn) && /NOTHING was raised/.test(outFn),
   'a REFUSED request is spelled out: nothing was raised, nothing is awaiting a human');
const shipCase = cli.slice(cli.indexOf("case 'ship': {"), cli.indexOf("case 'hint-land':"));
ok(/ship request \$\{String\(q\.id\)/.test(shipCase),
   'a raised ship prints its request id + commit — the one sentence a zee will relay');
ok(/out\(r, 'ship'\)/.test(shipCase), 'and the refusal path still runs through out()');

// ── 2. the queenzee RECORDS a refusal (no DDL: it rides session_event like tend/hints) ──
console.log('\n── a refusal is recorded, not just logged ──');
const status = read('server/src/lib/status.js');
ok(/export async function setShipRefusal/.test(status), 'setShipRefusal exists');
ok(/export async function clearShipRefusal/.test(status), 'and is clearable (a real request supersedes it)');
ok(/export async function shipRefusalState/.test(status), 'and readable (latest-event-wins)');
ok(/'ship-refused'/.test(status) && /'ship-refused-clear'/.test(status),
   'both events ride session_event — the shared schema stays frozen, no migration needed');

const gate = read('server/src/queenzee/shipgate.js');
ok(/const refuse = async \(why\)/.test(gate), 'requestShip refuses through ONE path…');
ok(/await setShipRefusal\(xellId, why/.test(gate), '…which records the refusal on the xell');
ok(/refused: true/.test(gate), '…and marks the answer refused:true');
ok(/NO request was raised/.test(gate), '…in words the zee cannot honestly relay as "pending"');
ok(/catch \(e\) \{ return refuse\(e\.message\); \}/.test(gate),
   'the ship-ref failure takes the same path (it used to return a bare ok:false and vanish)');
ok(/await clearShipRefusal\(xellId, \{ zeeId \}\);/.test(gate),
   'raising a real request clears the refusal — the panel must not keep nagging about history');

// the dirty-tree refusal names what is dirty: "3 uncommitted file(s)" sent zees hunting for work
// they had not done, since the queenzee writes files into a worktree too.
ok(/dirty\.files\.join\(', '\)/.test(gate), 'a dirty worktree refusal NAMES the files');
ok(/return \{ count: lines\.length, files \}/.test(gate), 'gitDirty returns both the count and the names');

// ── 3. the human can SEE it ──
console.log('\n── the console shows the ask that never became a card ──');
const fleet = read('server/src/lib/fleet.js');
ok(/ship-refused/.test(fleet) && /ship_refused: shipRefused/.test(fleet),
   'the fleet read model carries refused asks for the project');
ok(/interval '24 hours'/.test(fleet), 'bounded in time — a refusal a zee moved on from does not haunt the panel');
ok(/DISTINCT ON \(se\.xell_id\)/.test(fleet), 'latest event per xell, so a cleared refusal disappears');

const ship = read('web/src/Ship.jsx');
ok(/function RefusedAsks/.test(ship), 'the production panel renders them');
ok(/data-testid="ship-refused"/.test(ship), 'with a testid');
ok(/!open\.length && !prodLock && !refused\?\.length/.test(ship),
   'and the panel renders for refusals ALONE — an empty panel was the wrong answer to "did anyone ask?"');
ok(/nothing here to approve/.test(ship), 'labelled as evidence, not as a decision');
const app = read('web/src/App.jsx');
ok(/refused=\{fleet\.ship_refused\}/.test(app), 'App wires the fleet field into the panel');
const css = read('web/src/styles.css');
ok(/\.ship-refused\s*\{/.test(css) && /\.ship-refused-row\s*\{/.test(css), 'styled (no unstyled class)');

// ── 4. an OPEN request can no longer be invisible ──
console.log('\n── a dismissed ask cannot block a zee behind a filter no human sees ──');
ok(/UPDATE ship_request SET dismissed_at=NULL/.test(gate),
   'asking again UN-dismisses an open request instead of answering "you already have one" forever');
ok(/dismiss only clears the receipt of a/.test(gate),
   'and dismissing a still-open ship is refused — Reject or Defer decide an ask; dismiss hides one');
ok(/if \(e\.code !== '23505'\) throw e;/.test(gate),
   'the one-open-ship unique index answers with the winning request, not a raw constraint error');

const self = read('server/src/queenzee/self.js');
ok(/ship_refused: shipRefused\.refused/.test(self), '`zee status` echoes the zee\'s own refusal back');
ok(/dismissed: !!ship\.dismissed_at/.test(self)
   && /&& !ship\.deferred_at && !ship\.dismissed_at/.test(self),
   'and a dismissed request no longer reads as "pending" to the zee');
ok(/Ship REQUESTED \(ship_request/.test(self),
   'selfShip states the request id + sha on success — the unambiguous half of the same fix');

// ── 5. the manual (it is the zee's only instruction) ──
console.log('\n── the manual ──');
const mig = read('db/migrations/066_manual_ship_refusal.sql');
ok(/A REFUSED ship is not a quiet ship/.test(mig), 'the manual patch teaches that a refusal raises NOTHING');
ok(/THEN RETURN; END IF;/.test(mig), 'guarded — re-running it changes nothing');
ok(/ship_request id and commit/.test(mig), 'and gives the zee the test for "do I actually have one?"');

console.log(fail ? `\n${fail} FAILURE(S)\n` : '\nall good\n');
process.exit(fail ? 1 : 0);

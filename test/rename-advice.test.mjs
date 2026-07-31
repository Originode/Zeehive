// "RENUMBER IT" IS ONLY SAFE ADVICE ABOUT A FILE NOBODY HAS RUN — ticket #35.
//
// The duplicate-number guards landed today and told authors to renumber. Twenty minutes later somebody
// did: 090_restore_report.sql became 095_restore_report.sql, and one database ran the SAME migration at
// 00:11 and again at 00:14, because `schema_migrations` keys on the FILENAME and stores no checksum — a
// renamed file is a new migration to the ledger. It was harmless only because that body happened to be
// `ADD COLUMN IF NOT EXISTS`. An INSERT, a DROP, or an unguarded harness-memory edit would have applied
// twice for real, and the guard would have been the thing that suggested it.
//
// So the advice must name a FILE, and the ledger is what decides which: between two colliding files the
// one to move is the one no database has run. Where BOTH have applied there is no safe rename and the
// only honest answer is to say so and suggest nothing — a wrong suggestion there double-applies for
// somebody else, which is worse than a settled collision.
//
// BOTH CASES ARE CONSTRUCTED HERE, and the messages read back, because the deliverable is what a human
// is told. The two guards share one rule (server/src/db/rename-advice.js) so they cannot drift into
// giving different advice about the same pair — the failure mode this crew has paid for repeatedly.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { renameAdvice, RERUN_WARNING } = await import('../server/src/db/rename-advice.js');
const { splitPrefixRefusal, duplicatePrefixesSplitByLedger } = await import('../server/src/db/migrate.js');

// ── CASE 1: one applied, one not — name the one that is free to move ─────────
console.log('\n── one of them has applied: the OTHER one moves ──');
const pair = ['086_already_ran.sql', '086_brand_new.sql'];
const a1 = renameAdvice(pair, new Set(['086_already_ran.sql']));
ok(a1.move === '086_brand_new.sql', `it names the unapplied file as the one to rename (${a1.move})`);
ok(/Rename 086_brand_new\.sql/.test(a1.advice), 'in the sentence, not just in a field');
ok(/Do NOT rename 086_already_ran\.sql/.test(a1.advice),
   'and names the one that must NOT move — the choice is the valuable half of the advice');
ok(a1.advice.includes(RERUN_WARNING), 'with the reason attached: renaming an applied migration re-runs it');
ok(!a1.blocked && !a1.unknown, 'this case has a safe answer, and says so');
// the direction that would have caused tonight's double-apply
const wrong = renameAdvice(pair, new Set(['086_brand_new.sql']));
ok(wrong.move === '086_already_ran.sql',
   'and the advice FOLLOWS the ledger rather than the filename — swap which one is applied and the answer swaps');

// ── CASE 2: both applied — refuse to suggest a rename at all ────────────────
console.log('\n── both have applied: no safe rename exists, so none is suggested ──');
const a2 = renameAdvice(pair, new Set(pair));
ok(a2.move === null && a2.blocked === true, 'it suggests NOTHING and says it is blocked');
ok(/NONE of them is safe to rename/.test(a2.advice), 'in plain words');
ok(!/Rename 086/.test(a2.advice), 'and the word "rename" is never attached to a filename here');
ok(a2.advice.includes(RERUN_WARNING), 'the reason is still given — a human deciding needs it most here');
ok(/repair is forward/.test(a2.advice) && /grandfather list/.test(a2.advice),
   'and it names the forward repair (record it as history) instead of leaving a dead end');
const triple = renameAdvice(['086_a.sql', '086_b.sql', '086_c.sql'], new Set(['086_a.sql', '086_b.sql']));
ok(triple.move === '086_c.sql' && triple.applied.length === 2,
   'a THREE-way collision with two applied still names the free one (086 really was claimed three ways today)');

// ── CASE 3: both LANDED ON MAIN — it is history, so record it, do not rename ─
// The live case that arrived while this was being written: master briefly carried two 087s. The zee that
// found it deliberately did NOT renumber, because both were applied in its database — and the fleet-wide
// version of that fact is the one that settles it. A rename here cannot fix an order that every follower
// of main has already run; it can only re-run one of them for all of them.
console.log('\n── both are LANDED ON MAIN: history, so RECORD it ──');
const a5 = renameAdvice(pair, new Set(pair), new Set(pair));
ok(a5.grandfather === true && a5.blocked === true && a5.move === null,
   'it advises no rename at all and flags the pair as history');
ok(/LANDED ON MAIN/.test(a5.advice) && /this collision is HISTORY/.test(a5.advice),
   'and says why in those words');
ok(a5.advice.includes('grandfather list in test/migration-numbers.test.mjs'),
   'it names the record to add the pair to');
ok(/delete the line the moment it stops describing a real duplicate/.test(a5.advice),
   'and warns about the rot my own 090 line demonstrated twenty minutes after I wrote it');
ok(a5.advice.includes(RERUN_WARNING), 'the re-run warning is still the reason');
// …and the distinction that makes this useful: a sibling's UNLANDED file is not history
const a6 = renameAdvice(pair, new Set(['086_already_ran.sql']), new Set(['086_already_ran.sql']));
ok(a6.grandfather === false && a6.move === '086_brand_new.sql',
   'a file that exists only on another XELL\'s branch is NOT history — that one is still the one to move');
const a7 = renameAdvice(pair, new Set(), new Set(['086_already_ran.sql']));
ok(a7.move === '086_brand_new.sql' && /not on main either/.test(a7.advice),
   'and with nothing applied here, it still prefers the file main has never seen');
ok(renameAdvice(pair, new Set(pair), null).grandfather === false,
   'main not readable → it does NOT claim history; it falls back to the ledger alone');

// ── CASE 4: no ledger at all — say so rather than guess ─────────────────────
console.log('\n── no ledger readable: the honest answer is "I cannot tell" ──');
const a3 = renameAdvice(pair, null);
ok(a3.unknown === true && a3.move === null, 'null is not "nothing is applied" — it is "nobody could tell me"');
ok(/UNKNOWN/.test(a3.advice) && /schema_migrations/.test(a3.advice),
   'it says what it does not know and how to find out');
ok(a3.advice.includes(RERUN_WARNING), 'and still carries the warning, which is the part that was missing tonight');
const a4 = renameAdvice(pair, new Set());
ok(a4.move === '086_already_ran.sql' && !a4.unknown && !a4.blocked,
   'an EMPTY ledger is a different answer again: nothing applied here, so anything can move');
ok(/If one of them HAS\s*\n?\s*landed, other databases have run it/.test(a4.advice)
   || /other databases have run it/.test(a4.advice),
   'and it warns that "nothing applied HERE" is not "nothing applied anywhere"');
ok(renameAdvice(['086_only.sql'], new Set()).advice === null,
   'and one file is not a collision, so there is no advice to give');

// ── the runtime refusal says the same thing ─────────────────────────────────
console.log('\n── the runner’s refusal carries the same advice, from the same rule ──');
const msg = splitPrefixRefusal([{ number: 86, applied: ['086_already_ran.sql'], unapplied: ['086_brand_new.sql'] }]);
ok(/Rename 086_brand_new\.sql/.test(msg), 'it names the file to move');
ok(/Do NOT rename 086_already_ran\.sql/.test(msg), 'and the one not to');
ok(msg.includes(RERUN_WARNING), 'and the re-run warning, verbatim');
ok(/zee migration-number/.test(msg), 'while still pointing at the verb that avoids the collision entirely');
const hist = splitPrefixRefusal(
  [{ number: 87, applied: ['087_a.sql', '087_b.sql'], unapplied: ['087_c.sql'] }],
  new Set(['087_a.sql', '087_b.sql', '087_c.sql']));
ok(/LANDED ON MAIN/.test(hist) && !/Rename 087_c.sql/.test(hist),
   'and when main carries them all, the RUNNER stops suggesting a rename too');
const runner = readFileSync(join(ROOT, 'server/src/db/migrate.js'), 'utf8');
ok(/import \{ renameAdvice, RERUN_WARNING \} from '\.\/rename-advice\.js'/.test(runner),
   'the runner imports the rule rather than restating it');
ok(!/renaming it would make it look new/.test(runner),
   'and its old hand-written version of the warning is gone — one wording, one place');
ok(runner.includes('splitPrefixRefusal(split, landedMigrationNames(config.repoRoot))'),
   'it reads main only when there is something to refuse — a clean migrate spends nothing on it');

// ── the LINT says the same thing, and can still run without a database ──────
console.log('\n── the lint gives the same advice, informed by the ledger when there is one ──');
const lint = readFileSync(join(ROOT, 'test/migration-numbers.test.mjs'), 'utf8');
ok(/import \{ renameAdvice, RERUN_WARNING \} from '\.\.\/server\/src\/db\/rename-advice\.js'/.test(lint),
   'the lint imports the same rule — the two guards cannot drift into different advice');
ok(lint.includes('const FIX = (files) => {') && lint.includes('renameAdvice(files, applied, landed)'),
   'and its fix line is now a function of the FILES, the ledger and main — not one fixed sentence');
ok(/if \(!process\.env\.DATABASE_URL\) return null;/.test(lint) && /catch \{ return null; \}/.test(lint),
   'the ledger read is opportunistic: no DATABASE_URL, or an unreachable one, answers null');
ok(lint.includes('rename advice:') && lint.includes('no database readable') && lint.includes('main not readable'),
   'and the lint SAYS which sources it had, so an author knows whether the advice was informed');
ok(!/RENUMBER it before landing/.test(lint),
   'the old blind "RENUMBER it" instruction is gone');
ok(lint.includes('const landed = await readLanded();') && lint.includes('ls-tree'),
   'and the lint reads what MAIN carries too, so it can tell a settled collision from a fixable one');
ok(lint.includes('adv.grandfather ? adv.advice'),
   'a HISTORY collision is told to record itself, not to fetch a fresh number it cannot use');

// ── and the guard still fires on what it caught today ───────────────────────
console.log('\n── the duplicate refusal itself is untouched ──');
const files = ['085_a.sql', '086_x.sql', '086_y.sql', '087_c.sql'];
ok(duplicatePrefixesSplitByLedger(files, new Set(['085_a.sql', '086_x.sql'])).length === 1,
   'a split number is still refused (the check the advice hangs off is unchanged)');
ok(duplicatePrefixesSplitByLedger(files, new Set()).length === 0
   && duplicatePrefixesSplitByLedger(files, new Set(files)).length === 0,
   'and a virgin database and a fully-applied one are still both left alone');

console.log(fail ? `\n✗ ${fail} FAILED` : '\n✓ the guards name the file that is safe to move, and refuse to guess when none is');
process.exit(fail ? 1 : 0);

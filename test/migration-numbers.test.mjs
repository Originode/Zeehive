// TWO MIGRATIONS, ONE NUMBER — the lint half of ticket #9's guard.
//
// Migrations apply in FILENAME order, so a shared numeric prefix makes the sequence a coin-toss between
// two authors who each believed theirs was next. It happened three times in one day with zees working in
// parallel, and the third time both files patched the SAME manual — where order is the entire question.
//
// WHY IT IS INVISIBLE, and therefore why a guard is worth having: the ledger keys on filename
// (schema_migrations.filename, PRIMARY KEY, no checksum), so duplicates are legal and each author's own
// database has already applied their own file. The ordering question never arises there. Only a run from
// EMPTY exercises the real order — and only if somebody happens to do one.
//
// TWO PLACES, DECIDED WITH A REASON rather than by default:
//   • THIS LINT is the primary. A collision is CREATED at landing time, by a filename, and this is the
//     check that sits there — it costs nothing at boot, it names the fix, and it fails for the zee that
//     is actually holding the file.
//   • THE RUNTIME REFUSAL (migrate.js) is the backstop, because the zee that lands a collision is not
//     always the one that runs the suite, and a fresh clone can boot straight into it. It fires BEFORE
//     anything is applied, so it cannot leave a half-migrated database.
// Neither PREVENTS the collision — nothing here coordinates two zees reaching for 089. They convert a
// silent ordering hazard into an obvious failure the moment the two files meet.
//
// It is NOT a numbering scheme: timestamps / an allocator / leaving it alone is a human's open decision
// on #9, and a duplicate guard is correct under all of them.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const DIR = join(ROOT, 'db', 'migrations');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { KNOWN_DUPLICATES, numberOf, duplicateGroups, newDuplicates, duplicateRefusal,
        assertUniqueMigrationNumbers } = await import('../server/src/db/migration-numbers.js');

const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

// ── 1. THE TREE: no collision that history has not already accepted ──────────
console.log('\n── the migrations folder as it stands ──');
const fresh = newDuplicates(files);
ok(fresh.length === 0,
   fresh.length ? `NEW duplicate number(s):\n${duplicateRefusal(fresh)}` : 'no migration number collides that is not already recorded history');
ok(files.length > 80, `the lint is looking at the real folder (${files.length} migrations)`);
ok(files.every((f) => numberOf(f)), 'every migration filename carries a numeric prefix (the thing being checked)');

// ── 2. THE RECORD matches reality, in both directions ────────────────────────
// A record that drifts is worse than none: too narrow and the guard blocks a green tree, too wide and it
// silently blesses a collision landed later. So it must equal the duplicates in the folder exactly.
console.log('\n── KNOWN_DUPLICATES is a record of history, and it is accurate ──');
const actual = duplicateGroups(files);
ok(actual.length === Object.keys(KNOWN_DUPLICATES).length,
   `every duplicated number in the tree is recorded, and nothing is recorded that is not duplicated (${actual.length})`);
for (const g of actual) {
  const rec = KNOWN_DUPLICATES[g.number];
  ok(!!rec && [...rec].sort().join('|') === g.files.join('|'),
     `${g.number} is recorded by exact filename set (${g.files.join(', ')})`);
}
ok(Object.isFrozen(KNOWN_DUPLICATES), 'and the record is frozen — nothing mutates it at runtime to pass a check');

// ── 3. THE GUARD FIRES — proved on synthetic input, not by trusting the tree ──
console.log('\n── a NEW collision is refused ──');
const collide = ['001_a.sql', '089_alpha_thing.sql', '089_bravo_thing.sql'];
let threw = null;
try { assertUniqueMigrationNumbers(collide, { known: {} }); } catch (e) { threw = e; }
ok(!!threw, 'two files sharing 089 throw rather than migrate');
ok(/089_alpha_thing\.sql/.test(threw?.message || '') && /089_bravo_thing\.sql/.test(threw?.message || ''),
   'the message names BOTH files');
ok(/FILENAME order/.test(threw?.message || '') && /NOTHING HAS BEEN APPLIED/.test(threw?.message || ''),
   'says why it matters and that nothing was applied');
ok(/Renumber the file that has NOT applied/.test(threw?.message || ''),
   'says what to do');
ok(/NEVER renumber a file that has already applied/.test(threw?.message || '')
   && /keys on the\n?\s*FILENAME/.test(threw?.message || ''),
   'and warns about the trap, with the reason: the ledger keys on the filename, so a rename re-runs it');
ok(/MIGRATE_ALLOW_DUPLICATE_NUMBERS=true/.test(threw?.message || ''),
   'and names the escape hatch for a human recovering something live');
ok(!/001_a\.sql/.test(threw?.message || ''), 'and says nothing about the files that are fine');

console.log('\n── history is tolerated, and is NOT a licence for that number ──');
const historical = ['088_manager_manual_harness_key.sql', '088_manager_manual_scratch_resolution.sql'];
ok(assertUniqueMigrationNumbers(historical).refused.length === 0,
   'the recorded 088 pair migrates exactly as it does today');
const thirdOn088 = [...historical, '088_someone_elses_idea.sql'];
let threw3 = null;
try { assertUniqueMigrationNumbers(thirdOn088); } catch (e) { threw3 = e; }
ok(!!threw3, 'a THIRD file on that number is refused — the record is a filename SET, not a wildcard');
ok(/088_someone_elses_idea\.sql\s+← new/.test(threw3?.message || '')
   && /already recorded history/.test(threw3?.message || ''),
   'and the message separates the newcomer from the two that are history');
ok(assertUniqueMigrationNumbers(['089_a.sql', '089_b.sql'], { known: {}, allow: true }).allowed === true,
   'the escape hatch really lets a run through (and reports that it did)');

console.log('\n── the folder itself passes the runner’s own call ──');
ok(assertUniqueMigrationNumbers(files).refused.length === 0,
   'so a fresh clone and a virgin database both migrate cleanly, duplicates and all');
ok(!!numberOf('086_land_clearance_silence.sql') && numberOf('notanumber.sql') === null,
   'numberOf reads the prefix and tolerates a file that has none');

// ── 4. THE RUNNER checks BEFORE it applies anything ──────────────────────────
console.log('\n── where the runtime guard sits ──');
const runner = readFileSync(join(ROOT, 'server/src/db/migrate.js'), 'utf8');
ok(/import \{ assertUniqueMigrationNumbers \} from '\.\/migration-numbers\.js'/.test(runner),
   'migrate.js uses the same rule this lint does — one implementation, not two');
const callAt = runner.indexOf('assertUniqueMigrationNumbers(files)');
const applyAt = runner.indexOf('for (const file of files)');
ok(callAt > 0 && applyAt > 0 && callAt < applyAt,
   'and calls it BEFORE the apply loop, so a refusal cannot leave a half-migrated database');
ok(!/KNOWN_DUPLICATES/.test(runner),
   'the runner carries no copy of the record — it asks the module (the drift this repo keeps paying for)');

console.log(fail ? `\n✗ ${fail} FAILED` : '\n✓ a new migration number collision is refused; the old ones are history and still work');
process.exit(fail ? 1 : 0);

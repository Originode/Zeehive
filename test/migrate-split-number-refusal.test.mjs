// A NUMBER THIS DATABASE HAS ALREADY USED, claimed by a file it has never applied — the runtime layer
// of ticket #9's guard, and the one case the other two layers cannot cover.
//
// The three layers, and why this one exists:
//   1. `zee migration-number` (server/src/lib/migration-numbers.js) — the queenzee hands out a number,
//      because it can see landed main AND every live xell's worktree. It PREVENTS the collision, and it
//      is advisory: a zee that never asks is not blocked.
//   2. test/migration-numbers.test.mjs — the lint. If a duplicate lands anyway the build says so, with
//      the whole tree in view and the landed collisions grandfathered by name.
//   3. THIS — the runner refusing at migrate time. It catches what neither can: a collision landed by
//      SOMEBODY ELSE arriving at an established database. That zee did not run this repo's suite, and
//      the sibling file has ALREADY applied here, so its position is fixed and postgres is about to
//      sequence the newcomer against it by string comparison.
//
// THE LEDGER IS THE RECORD, deliberately: this layer holds no grandfather list, so it cannot drift out
// of step with the lint's. It refuses exactly one shape — a number SPLIT across applied and unapplied —
// and leaves every other shape alone:
//   • all applied  → history, settled, order already decided everywhere. Nothing to say.
//   • none applied → a virgin database or a restored snapshot, where the seven landed collisions must
//     migrate exactly as they always have. Refusing there would break `zee db-catchup` and every fresh
//     clone; the lint owns that case.
//
// It prevents nothing on its own. It converts a silent ordering hazard into a loud one at the moment a
// database is asked to act on it.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { duplicatePrefixesSplitByLedger: split, splitPrefixRefusal } =
  await import('../server/src/db/migrate.js');

// ── the rule, as data (no database needed — the applied set is an argument) ───
console.log('\n── the one shape it refuses ──');
const FILES = ['085_a.sql', '086_first.sql', '086_second.sql', '087_c.sql'];
const s1 = split(FILES, new Set(['085_a.sql', '086_first.sql']));
ok(s1.length === 1 && s1[0].number === 86, 'a number split across applied and unapplied is refused');
ok(s1[0].applied.join() === '086_first.sql' && s1[0].unapplied.join() === '086_second.sql',
   'and both sides are named — which one is already in decides what can still be fixed');

console.log('\n── the shapes it deliberately leaves alone ──');
ok(split(FILES, new Set()).length === 0,
   'a VIRGIN database (nothing applied) migrates — the landed collisions must still run as they always have');
ok(split(FILES, new Set(['085_a.sql'])).length === 0,
   'and so does a restored SNAPSHOT that predates the whole pair (both unapplied → not this layer\'s call)');
ok(split(FILES, new Set(FILES)).length === 0,
   'a fully-applied duplicate is history: settled everywhere, nothing to decide');
ok(split(['086_only.sql'], new Set()).length === 0, 'a number carried by ONE file is not a collision');
ok(split([], new Set()).length === 0 && split(undefined, undefined).length === 0,
   'and it tolerates an empty (or absent) folder');

console.log('\n── it holds no record of its own ──');
const runner = readFileSync(join(ROOT, 'server/src/db/migrate.js'), 'utf8');
// checked by looking for the DATA a list would need — a filename — rather than for the word, since the
// runner's own comment explains that it deliberately has none
ok(!/\d{3}_[a-z0-9_]+\.sql/.test(runner),
   'the runner names no migration FILE anywhere: it carries no grandfather list, so there is nothing to drift');
ok(/import \{ numberOf \} from '\.\.\/lib\/migration-numbers\.js'/.test(runner),
   'and it parses the number with the allocator\'s own function, not a second copy of the regex');
const realFiles = readdirSync(join(ROOT, 'db', 'migrations')).filter((f) => f.endsWith('.sql'));
ok(split(realFiles, new Set(realFiles)).length === 0
   && split(realFiles, new Set()).length === 0,
   `the real folder (${realFiles.length} files, 7 duplicated numbers) is refused in NEITHER of those states`);

// ── the refusal a human reads ────────────────────────────────────────────────
console.log('\n── what it says when it fires ──');
const msg = splitPrefixRefusal(s1);
ok(/086_first\.sql\s+← already applied here/.test(msg) && /086_second\.sql\s+← NEW, not applied/.test(msg),
   'it separates the file that is already in from the one that is not');
ok(/NOTHING HAS BEEN APPLIED by this run/.test(msg),
   'it says nothing was applied — because it is thrown before the loop, not during it');
ok(/renaming it would make it look new and run\s*\n?\s*it a second time/.test(msg),
   'it warns why the APPLIED file cannot be the one renamed (the ledger keys on filename)');
ok(/`zee migration-number`/.test(msg) && /every live xell has claimed/.test(msg),
   'it points at the verb that prevents the collision rather than just complaining');
ok(/test\/migration-numbers\.test\.mjs/.test(msg), 'and names the lint, so the three layers read as one idea');
ok(/MIGRATE_ALLOW_DUPLICATE_NUMBERS=true/.test(msg) && /It does not make it fine/.test(msg),
   'the escape hatch is named, and is honest about what it does not do');

console.log('\n── where it sits in the runner ──');
const callAt = runner.indexOf('duplicatePrefixesSplitByLedger(files, applied)');
const applyAt = runner.indexOf('for (const file of files)');
ok(callAt > 0 && applyAt > 0 && callAt < applyAt,
   'checked BEFORE the apply loop, so a refusal can never leave a half-migrated database');
ok(/MIGRATE_ALLOW_DUPLICATE_NUMBERS !== 'true'/.test(runner)
   && /MIGRATE_ALLOW_DUPLICATE_NUMBERS=true — applying a duplicate number anyway/.test(runner),
   'the hatch exists and SAYS SO in the log when it is used — a silent override is a worse bug than the one it dodges');
ok(/process\.exit\(1\)/.test(runner.slice(runner.indexOf('CLI entry'))),
   'the CLI exits non-zero — that is the surface where somebody is holding the filenames');
const boot = readFileSync(join(ROOT, 'server/src/index.js'), 'utf8');
ok(/BOOT MIGRATIONS FAILED \(staying up on the schema we have\)/.test(boot),
   'while a BOOT logs it loudly and stays up degraded — a refusal must not cost the queenzee its availability');

console.log(fail ? `\n✗ ${fail} FAILED` : '\n✓ a number this database has already used cannot be re-used by a file it has never seen');
process.exit(fail ? 1 : 0);

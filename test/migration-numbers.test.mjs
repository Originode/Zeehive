// MIGRATION NUMBERS — two files may not claim the same one. A lint, earned three times.
//
// db/migrations/ IS the ledger (CLAUDE.md §4: never a list in a doc) and its only ordering is the
// FILENAME. So a number is not decoration — it is the apply order, and the runner
// (server/src/db/migrate.js) sorts the directory and walks it. Two files claiming the same number is
// therefore not a stylistic wobble: postgres applies them in whatever order a string sort happens to
// give two names that were meant to be identical, and nothing anywhere says so.
//
// WHY IT KEEPS HAPPENING (ticket #9): a cxell zee reads db/migrations/ in its OWN worktree, takes the
// next free number, writes the file and lands. Every sibling zee working at the same hour does the
// same, and none of them can see the others' branches — so two 038s, two 066s, two 079s, two 082s and
// finally two 085s landed, the last pair applying in a single boot on the shipped tip. git shows no
// conflict for two files that never touch each other.
//
// The FIX has two halves and this file is the second one:
//   * a zee gets a number it can trust from the queenzee, which CAN see every live xell —
//     `zee migration-number` (advisory: it hands out a number, it does not gate a landing);
//   * and if a duplicate is ever written anyway, THE BUILD SAYS SO — here — instead of postgres
//     deciding the order quietly.
//
// The five landed pairs are GRANDFATHERED, not renumbered: a forward-only ledger is already applied
// everywhere, so renaming a landed file desynchronises `schema_migrations` on every database that
// has run it (the same reasoning test/harness-memory-migrations.test.mjs grandfathers its six
// offenders with). The list below is the RECORD of the bug, not permission to add to it — and each
// entry is checked to still BE a duplicate, so it cannot rot into a licence for a new one.
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// The shape the runner's sort depends on: NNN_snake_case.sql. A file that does not match has no
// number to police, which is the one way a collision could hide from this lint.
const NAME = /^(\d{3})_[a-z0-9_]+\.sql$/;

// Landed before the rule existed, and each one applies (in some string order) on every database that
// has run it. DO NOT ADD TO THIS LIST — a new duplicate gets renumbered before it lands.
const GRANDFATHERED = {
  '038': ['038_backup_mode.sql', '038_machine_priority_per_project.sql'],
  '066': ['066_manual_ship_refusal.sql', '066_work_tracker_column_meanings.sql'],
  '079': ['079_manager_manual_readonly_workspace.sql', '079_manual_shell_safe_bodies.sql'],
  '082': ['082_env_cxell_projection.sql', '082_harness_avatars_into_meta_db.sql'],
  '085': ['085_manager_manual_harness_verbs.sql', '085_snapshot_row_counts.sql'],
};

// The whole check, as a function of a FILE LIST — so the samples below run through the identical
// code the real directory does, and the guard is proved to FIRE rather than merely proved not to
// complain about today's folder.
function collisions(files) {
  const byNumber = new Map();
  for (const f of files) {
    const n = NAME.exec(f)?.[1];
    if (!n) continue;
    if (!byNumber.has(n)) byNumber.set(n, []);
    byNumber.get(n).push(f);
  }
  return [...byNumber.entries()].filter(([, fs]) => fs.length > 1)
    .map(([number, fs]) => ({ number, files: fs.sort() }))
    .sort((a, b) => a.number.localeCompare(b.number));
}

// The sentence a future author reads when the suite goes red. It names the verb, because "pick
// another number" is exactly the instruction that produced five collisions.
const FIX = 'RENUMBER it before landing, and get the number from the queenzee — `zee migration-number` '
  + 'accounts for what is landed AND what every other live xell has claimed, which your own worktree cannot.';

console.log('\n── the ledger is well-formed ──');
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
ok(files.length > 0, `db/migrations/ has migrations to check (${files.length})`);
const malformed = files.filter((f) => !NAME.test(f));
ok(malformed.length === 0,
   `every migration is NNN_snake_case.sql — the filename IS the apply order (bad: ${malformed.join(', ') || 'none'})`);

console.log('\n── no NEW duplicate number ──');
const found = collisions(files);
const known = new Set(Object.keys(GRANDFATHERED));
for (const c of found.filter((c) => !known.has(c.number))) {
  ok(false, `${c.number} is claimed by ${c.files.length} migrations: ${c.files.join(' + ')} — the ledger's only `
    + `ordering is the filename, so postgres would apply these in whatever order a string sort gives. ${FIX}`);
}
ok(found.every((c) => known.has(c.number)),
   `no migration number is claimed twice, apart from the ${known.size} landed pairs below`);

// A grandfathered entry must still describe a real duplicate. Otherwise the list quietly becomes a
// blanket permit for that number — and 086 is written by a zee reading this file, not by this file.
console.log('\n── and the grandfathered pairs are still exactly what the list says ──');
for (const [number, expected] of Object.entries(GRANDFATHERED)) {
  const actual = found.find((c) => c.number === number);
  ok(!!actual, `${number} is still a duplicate (if it is not, DELETE its line — a stale entry permits a new collision)`);
  ok(actual && actual.files.join(' + ') === [...expected].sort().join(' + '),
     `${number} is the known pair: ${[...expected].sort().join(' + ')}${actual ? ` (found: ${actual.files.join(' + ')})` : ''}`);
}

console.log('\n── the guard fires (samples, not files) ──');
ok(collisions(['001_a.sql', '002_b.sql', '003_c.sql']).length === 0, 'a clean ledger passes');
const dup = collisions(['085_a.sql', '086_b.sql', '086_c.sql']);
ok(dup.length === 1 && dup[0].number === '086' && dup[0].files.join(' + ') === '086_b.sql + 086_c.sql',
   'two files claiming 086 are caught, and both are named');
ok(collisions(['086_b.sql', '086_c.sql', '086_d.sql'])[0].files.length === 3,
   'a THIRD file on the same number is caught too (the pair is not a special case)');
ok(collisions(['20260729_a.sql', '20260729_b.sql']).length === 0
   && !NAME.test('20260729_a.sql'),
   'a filename outside NNN_ form is not silently policed — the well-formed check above is what catches it');

console.log(`\n${fail === 0 ? 'ALL PASSED ✓' : `${fail} FAILURE(S) ✗`}`);
process.exit(fail === 0 ? 0 : 1);

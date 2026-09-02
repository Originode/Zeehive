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
// then two 085s landed, the last pair applying in a single boot on the shipped tip. git shows no
// conflict for two files that never touch each other.
//
// And then it happened AGAIN, twice, under this file, while it was being written: 086 was claimed by
// THREE separate xells (a stale-backup alert, a harness scope guard and a land-clearance fix) inside
// one evening, and 088 by two more in the minutes between this lint being written and being landed.
// The guard's first act after each `zee sync` was to fail on them. Seven numbers now, one of them
// three ways — which is the argument for the claim verb rather than for better manners.
//
// The FIX has two halves and this file is the second one:
//   * a zee gets a number it can trust from the queenzee, which CAN see every live xell —
//     `zee migration-number` (advisory: it hands out a number, it does not gate a landing);
//   * and if a duplicate is ever written anyway, THE BUILD SAYS SO — here — instead of postgres
//     deciding the order quietly.
//
// The landed collisions are GRANDFATHERED, not renumbered: a forward-only ledger is already applied
// everywhere, so renaming a landed file desynchronises `schema_migrations` on every database that
// has run it (the same reasoning test/harness-memory-migrations.test.mjs grandfathers its six
// offenders with). The list below is the RECORD of the bug, not permission to add to it — and each
// entry is checked to still BE that exact set, so it cannot rot into a licence for a new one.
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// WHICH of two colliding files is safe to rename (#35). This lint told authors to RENUMBER without
// knowing which one a database had already applied — and renaming an applied migration re-runs it, which
// is what happened to 090_restore_report.sql within twenty minutes of the guard landing. The rule is
// shared with the runtime refusal in server/src/db/migrate.js so the two can never give different advice.
import { renameAdvice, RERUN_WARNING } from '../server/src/db/rename-advice.js';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// THE LEDGER, if there is one to read. Opportunistic on purpose: this lint has always run in a fresh
// clone with no database and must keep doing so, so a missing/unreachable DATABASE_URL is answered with
// NULL — "nobody could tell me", which renameAdvice treats differently from "nothing is applied". It
// never fails the lint: the duplicate check itself needs no database.
async function readLedger() {
  if (!process.env.DATABASE_URL) return null;
  try {
    const pg = (await import('pg')).default;
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 2500, query_timeout: 2500 });
    await c.connect();
    try {
      const r = await c.query('SELECT filename FROM schema_migrations');
      return new Set(r.rows.map((x) => x.filename));
    } finally { await c.end().catch(() => {}); }
  } catch { return null; }
}
const applied = await readLedger();

// WHAT MAIN CARRIES — the fact that makes a collision permanent (#35). Both files landed means every
// database following main has run both, so a rename can only re-run one of them for everybody and the
// honest resolution is to RECORD the pair. One git call, best-effort: no repo, no branch, no answer, and
// the advice then falls back to the ledger alone rather than inventing a certainty it does not have.
async function readLanded() {
  try {
    const { spawnSync } = await import('node:child_process');
    const { execPath } = process;   // (unused — kept explicit that this shells out to git, not to node)
    void execPath;
    const r = spawnSync('git', ['-C', resolve(DIR, '..', '..'), 'ls-tree', '--name-only', '-r',
      'origin/main', '--', 'db/migrations'], { encoding: 'utf8', timeout: 4000 });
    if (r.status !== 0) return null;
    const names = r.stdout.split('\n').map((s) => s.trim().replace(/^db\/migrations\//, ''))
      .filter((s) => s.endsWith('.sql'));
    return names.length ? new Set(names) : null;
  } catch { return null; }
}
const landed = await readLanded();

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
  // Three xells, one evening, none able to see the others — landed while this lint was being written.
  '086': ['086_backup_stale_alert_state.sql', '086_harness_scope_guard_children.sql',
          '086_land_clearance_silence.sql'],
  // And one more, landed in the minutes between this lint being written and being landed. Both files
  // were already on main, so neither was mine to renumber — the repair is forward, i.e. this line.
  '088': ['088_manager_manual_harness_key.sql', '088_manager_manual_scratch_resolution.sql'],
  // And then a NINTH: a number handed out at 18:20 by `zee migration-number` had already been taken
  // by a file landed at 17:06:37 — 75 minutes earlier, on the implement-per-docs provisioning line.
  // The verb's own answer said "landed max 241" because it read the master ref at the moment of the
  // ask, and the sibling 242 was still on a parallel branch that merged minutes later (3ae602f). Both
  // files are on main now, so neither is safe to renumber (schema_migrations keys on FILENAME) — the
  // repair is forward, i.e. this line. ORDER CHECKED, NOT ASSUMED: the two bodies are disjoint and
  // order-independent — 242_infra_medic_manager.sql re-types a harness row; the other is a single
  // COMMENT ON COLUMN container.last_build_error_class — so whichever string order a fresh database
  // applies them in, the result is identical.
  '242': ['242_infra_medic_manager.sql', '242_refresh_build_failure_class_column_comment_for_unknown.sql'],
  // (The EIGHTH collision was here — 090 twice, created BY a renumber escaping a different one — and it
  // is gone because somebody moved 090_restore_report.sql to 095. Its line is DELETED rather than left:
  // a grandfather entry that no longer describes a real duplicate is a standing permit for the next
  // collision on that number, which is why this list is checked in both directions. And this rename
  // was SAFE, which is the part worth recording accurately: that file never sat on a deployable tip
  // under either earlier name. Checked, not assumed — no first-parent commit of master contains
  // db/migrations/087_restore_report.sql or 090_restore_report.sql, and a clone of the production
  // ledger holds 095_restore_report.sql and neither of the others, so no shared database re-ran it.
  // The renumber was done on its author's own branch, before landing, which is exactly where a number
  // may still be changed. The hazard the grandfather rule exists for is real — schema_migrations keys
  // on FILENAME, so renaming a file that HAS applied re-runs it — it simply was not paid here, and the
  // way to tell the two cases apart is the check above, not the number's history.)
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
// another number" is exactly the instruction that produced every one of these collisions — and it names
// the FILE, because "renumber it" is only safe advice about the file no database has run (#35).
const VERB = 'Get the new number from the queenzee — `zee migration-number` accounts for what is landed '
  + 'AND what every other live xell has claimed, which your own worktree cannot.';
const FIX = (files) => {
  const adv = renameAdvice(files, applied, landed);
  // A collision that is already HISTORY has no rename to get right, so the verb that hands out a fresh
  // number is not the instruction — recording it is.
  return adv.grandfather ? adv.advice : `${adv.advice} ${VERB}`;
};

console.log('\n── the ledger is well-formed'
  + ` (rename advice: ${applied ? `${applied.size} applied on DATABASE_URL` : 'no database readable'}, `
  + `${landed ? `${landed.size} landed on origin/main` : 'main not readable'}) ──`);
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
    + `ordering is the filename, so postgres would apply these in whatever order a string sort gives. ${FIX(c.files)}`);
}
ok(found.every((c) => known.has(c.number)),
   `no migration number is claimed twice, apart from the ${known.size} landed collisions below`);

// A grandfathered entry must still describe a real duplicate. Otherwise the list quietly becomes a
// blanket permit for that number — and 086 is written by a zee reading this file, not by this file.
console.log('\n── and the grandfathered collisions are still exactly what the list says ──');
for (const [number, expected] of Object.entries(GRANDFATHERED)) {
  const actual = found.find((c) => c.number === number);
  ok(!!actual, `${number} is still a duplicate (if it is not, DELETE its line — a stale entry permits a new collision)`);
  ok(actual && actual.files.join(' + ') === [...expected].sort().join(' + '),
     `${number} is the known collision: ${[...expected].sort().join(' + ')}${actual ? ` (found: ${actual.files.join(' + ')})` : ''}`);
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

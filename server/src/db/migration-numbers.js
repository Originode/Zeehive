// TWO MIGRATIONS, ONE NUMBER — the guard, not the numbering scheme (ticket #9).
//
// Migrations apply in FILENAME order (`readdirSync().sort()` in migrate.js), so when two files share a
// numeric prefix their order is decided by string comparison of whatever follows it — while each author
// believed theirs was simply next. That is not hypothetical: it happened three times in one day with
// zees working in parallel, and the third instance was TWO migrations patching the SAME manual, where
// order is the whole question.
//
// What makes it dangerous is that it is invisible to the author. The ledger keys on filename
// (`schema_migrations.filename`, PRIMARY KEY, no checksum), so duplicates are perfectly legal and each
// zee's own database has already applied its own file — the ordering question never arises there. Only a
// run from EMPTY exercises the real order, and only if somebody happens to do one.
//
// THIS GUARD PREVENTS NOTHING. Two zees in parallel will still both reach for the next number; nothing
// here coordinates them. What it does is convert a silent ordering hazard into an obvious failure the
// moment the two files meet — on any database, for any zee, whether or not they run a virgin check.
//
// It is deliberately NOT a numbering scheme. Timestamps, a central allocator, or leaving it alone is a
// human's open decision on #9; a duplicate guard is correct under every one of those, so it lands
// without pre-empting the choice.
//
// FORWARD-ONLY IS UNTOUCHED. Seven prefixes are already duplicated in this repo (086 three times, one
// of them mine). They are applied everywhere and must keep working exactly as they do, so they are
// RECORDED below as history — by exact filename, not by number. A third file joining one of those
// prefixes is a NEW collision and is refused like any other: the record is a fact about the past, not a
// licence for that number.

// The duplicates that exist as of this guard. Recorded by exact filename SET, so this list cannot be
// used as permission: add a file to one of these prefixes and the set no longer matches, which is a
// refusal. Do not add to it to silence a fresh collision — renumber the unapplied file instead. The
// only legitimate edits here are (a) a pair that a human has genuinely landed on every database and
// consciously accepted, and (b) removing an entry if a prefix ever stops being duplicated.
export const KNOWN_DUPLICATES = Object.freeze({
  '038': ['038_backup_mode.sql', '038_machine_priority_per_project.sql'],
  '066': ['066_manual_ship_refusal.sql', '066_work_tracker_column_meanings.sql'],
  '079': ['079_manager_manual_readonly_workspace.sql', '079_manual_shell_safe_bodies.sql'],
  '082': ['082_env_cxell_projection.sql', '082_harness_avatars_into_meta_db.sql'],
  '085': ['085_manager_manual_harness_verbs.sql', '085_snapshot_row_counts.sql'],
  '086': ['086_backup_stale_alert_state.sql', '086_harness_scope_guard_children.sql',
          '086_land_clearance_silence.sql'],
  '088': ['088_manager_manual_harness_key.sql', '088_manager_manual_scratch_resolution.sql'],
});

// The leading digits of a migration filename, or null for anything that is not numbered that way.
export const numberOf = (file) => (/^(\d+)_/.exec(String(file || '')) || [])[1] || null;

// Every number carried by more than one file, with its files sorted the way the runner will apply them.
export function duplicateGroups(files = []) {
  const byNumber = new Map();
  for (const f of files) {
    const n = numberOf(f);
    if (!n) continue;
    if (!byNumber.has(n)) byNumber.set(n, []);
    byNumber.get(n).push(f);
  }
  return [...byNumber.entries()]
    .filter(([, fs]) => fs.length > 1)
    .map(([number, fs]) => ({ number, files: [...fs].sort() }))
    .sort((a, b) => a.number.localeCompare(b.number));
}

// …minus the ones recorded as history. A group matches history only when its filename set is EXACTLY
// the recorded one — same length, same names — so a newcomer on an old number is still a collision.
export function newDuplicates(files = [], known = KNOWN_DUPLICATES) {
  return duplicateGroups(files).filter((g) => {
    const rec = known[g.number];
    if (!rec) return true;
    const a = [...rec].sort().join('|');
    return a !== g.files.join('|');
  });
}

// What a human (or a zee) reads when it fires. It names every file involved, says WHY the collision
// matters, states that nothing has been applied, and gives the fix — including the one thing that must
// not be done, because renaming an applied file re-runs it (the ledger keys on filename).
export function duplicateRefusal(groups, known = KNOWN_DUPLICATES) {
  const lines = ['Refusing to migrate: two or more migrations share a number.', ''];
  for (const g of groups) {
    const rec = known[g.number] || [];
    lines.push(`  ${g.number}:`);
    for (const f of g.files) lines.push(`    ${f}${rec.includes(f) ? '   (already recorded history)' : '   ← new'}`);
  }
  lines.push('',
    'Migrations apply in FILENAME order, so which of these runs first is decided by string comparison',
    'of the text after the number — not by intent, and almost certainly not by what either author',
    'assumed. NOTHING HAS BEEN APPLIED by this run.',
    '',
    'Fix the filename, not the ledger:',
    '  • Renumber the file that has NOT applied anywhere yet to the next FREE number, content unchanged.',
    '  • NEVER renumber a file that has already applied on any database: schema_migrations keys on the',
    '    FILENAME, so a rename makes it look new and it runs a second time.',
    '  • Only if a duplicate is genuinely already applied everywhere does it belong in KNOWN_DUPLICATES',
    '    (server/src/db/migration-numbers.js) — that list is a record of history, never permission.',
    '',
    'Escape hatch, for a human recovering something live: MIGRATE_ALLOW_DUPLICATE_NUMBERS=true migrates',
    'anyway. It does not fix the ordering — it only says you have decided you know what the order is.');
  return lines.join('\n');
}

// The runner's call. Throws BEFORE anything is applied, so a refusal never leaves a half-migrated
// database; returns the groups it tolerated so a caller can log them if it wants to.
export function assertUniqueMigrationNumbers(files = [],
  { known = KNOWN_DUPLICATES, allow = process.env.MIGRATE_ALLOW_DUPLICATE_NUMBERS === 'true' } = {}) {
  const fresh = newDuplicates(files, known);
  if (fresh.length && !allow) throw new Error(duplicateRefusal(fresh, known));
  return { duplicates: duplicateGroups(files), refused: fresh, allowed: !!fresh.length && allow };
}

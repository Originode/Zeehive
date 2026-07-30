// WHICH OF TWO COLLIDING MIGRATIONS IS SAFE TO RENAME — ticket #35, and the guard's own lesson.
//
// The duplicate-number guards (test/migration-numbers.test.mjs, and the runtime refusal in migrate.js)
// tell an author to RENUMBER. That advice is right about the collision and was silent about its cost:
// `schema_migrations` keys on FILENAME with no checksum, so renaming a file a database has already
// applied makes it look NEW and RUN AGAIN. It happened within twenty minutes of the guard landing —
// 090_restore_report.sql was renumbered to 095 and one database ran the same migration at 00:11 and
// again at 00:14. Harmless only because that body was `ADD COLUMN IF NOT EXISTS`; an INSERT, a DROP or an
// unguarded harness-memory edit would have applied twice for real.
//
// So the advice has to name a FILE, not a direction. Between two colliding files the one to move is the
// one no database has run, and the ledger already says which that is — the guards read it anyway. Where
// BOTH have applied there is no safe rename and the honest answer is to say so and stop suggesting one:
// a wrong suggestion there double-applies for somebody else, which is worse than no suggestion at all.
//
// AND A THIRD CASE, which is the one that keeps coming up: when both colliding files are LANDED ON MAIN,
// the collision is HISTORY. Every database that follows main has run both, in whatever order a string sort
// gave, and no rename can change that — it can only re-run one of them for everybody. The honest answer
// there is to RECORD the pair (the grandfather list) and move on, which is what this repo has done seven
// times. "Applied on this database" and "landed on main" are different facts and give different advice:
// the first is about one machine, the second is about the fleet, and only the second makes a collision
// permanent. A file that exists on another XELL's branch is neither — that one is still free to move, and
// is exactly the case where a rename is the right call.
//
// Pure and dependency-free ON PURPOSE. Both layers need the same answer — the runtime refusal has the
// ledger in hand, and the static lint can only sometimes reach it — so the RULE lives here once and each
// caller supplies what it knows. `applied = null` means "nobody could tell me", which is a different
// answer from "nothing is applied" and is deliberately not collapsed into it.

// The sentence that was missing tonight. Kept as a constant because it belongs verbatim in every message
// that says the word "rename", and because a future edit to one of them should not be able to drop it.
export const RERUN_WARNING =
  'Renaming a migration a database has ALREADY APPLIED makes it run again: the ledger '
  + '(schema_migrations) keys on the FILENAME and stores no checksum, so the new name looks like a new '
  + 'migration on every database that ran the old one.';

// files:   the colliding filenames (same numeric prefix).
// applied: a Set of filenames this ledger has run, or NULL when no ledger could be read.
// landed:  a Set of filenames present on MAIN, or NULL when nobody looked. Optional, and checked FIRST —
//          it is the only fact that makes a collision permanent.
// Returns { move, blocked, grandfather, unknown, applied, unapplied, advice }; `move` is the file it is
// safe to rename, or null when there is no safe answer, and `advice` is the sentence a human reads.
export function renameAdvice(files = [], applied = null, landed = null) {
  const all = [...files].sort();
  if (all.length < 2) {
    return { move: null, blocked: false, grandfather: false, unknown: false, applied: [], unapplied: all, advice: null };
  }

  // HISTORY FIRST. Both on main means every database that follows main has already run both, so there is
  // nothing left to sequence and a rename can only re-run one of them for everyone.
  if (landed && all.every((f) => landed.has(f))) {
    return {
      move: null, blocked: true, grandfather: true, unknown: false,
      applied: all.filter((f) => applied?.has(f)), unapplied: [],
      advice: `All of these are LANDED ON MAIN (${all.join(', ')}), so this collision is HISTORY: every `
        + `database that follows main has already run both, in whatever order a string sort gave. Do NOT `
        + `rename any of them — ${RERUN_WARNING} RECORD the pair instead, in the grandfather list in `
        + `test/migration-numbers.test.mjs, with a line saying what happened. That list is a record of `
        + `history, never permission — and delete the line the moment it stops describing a real duplicate.`,
    };
  }

  if (applied == null) {
    return {
      move: null, blocked: false, grandfather: false, unknown: true, applied: [], unapplied: [],
      advice: `No ledger was readable here, so which of these has already applied is UNKNOWN — and that is `
        + `the only thing that decides which one is safe to move. ${RERUN_WARNING} Check `
        + `\`SELECT filename FROM schema_migrations\` on every database that matters before renaming either: `
        + `move the one that appears in NONE of them.`,
    };
  }

  const done = all.filter((f) => applied.has(f));
  const todo = all.filter((f) => !applied.has(f));

  if (done.length && !todo.length) {
    // Every one of them is in. There is no safe rename, and saying "renumber it" here is how the next
    // database gets a double-apply.
    return {
      move: null, blocked: true, grandfather: false, unknown: false, applied: done, unapplied: [],
      advice: `All ${done.length} of these have ALREADY APPLIED here (${done.join(', ')}), so NONE of them is `
        + `safe to rename and this guard is not suggesting one. ${RERUN_WARNING} The repair is forward: `
        + `leave the filenames alone and record the pair as history (the grandfather list in `
        + `test/migration-numbers.test.mjs), or have a human decide — a rename here would re-run a `
        + `migration for everybody else, which is worse than a settled collision.`,
    };
  }

  if (todo.length === 1 && done.length) {
    return {
      move: todo[0], blocked: false, grandfather: false, unknown: false, applied: done, unapplied: todo,
      advice: `Rename ${todo[0]} — it is the one this ledger has NEVER applied, so moving it costs nothing. `
        + `Do NOT rename ${done.join(' or ')}: ${RERUN_WARNING}`,
    };
  }

  // Among files that are free to move, prefer one that is NOT on main: renaming a landed-but-not-yet-run
  // file still rewrites what every follower of main will run, and there is usually an unlanded sibling.
  const free = todo.filter((f) => !landed || !landed.has(f));
  if (!done.length) {
    // Nothing is applied here — every one of them is still free to move, and that is worth saying,
    // because "either is fine on THIS database" is not the same as "either is fine everywhere".
    return {
      move: (free[0] || todo[0]), blocked: false, grandfather: false, unknown: false, applied: [], unapplied: todo,
      advice: free.length && free.length < todo.length
        ? `None of these has applied on this database, and ${free.join(', ')} ${free.length === 1 ? 'is' : 'are'} `
          + `not on main either — rename ${free[0]}. ${RERUN_WARNING} The landed one has been run by every `
          + `database that follows main, so it is not the one to move.`
        : `None of these has applied on this database, so any of them can be renamed here — move the `
          + `one that is not yet landed on main (${todo.join(' or ')}). ${RERUN_WARNING} If one of them HAS `
          + `landed, other databases have run it: rename the other.`,
    };
  }

  // Several applied, several not: name the unapplied ones, and do not pick for them.
  return {
    move: todo[0], blocked: false, grandfather: false, unknown: false, applied: done, unapplied: todo,
    advice: `Rename one of ${todo.join(', ')} — those have never applied here. Do NOT rename `
      + `${done.join(' or ')}: ${RERUN_WARNING}`,
  };
}

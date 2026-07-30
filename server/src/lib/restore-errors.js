// WHAT pg_restore ACTUALLY TOLD US — ticket #30.
//
// pg_restore here runs `--clean --if-exists --no-owner` and WITHOUT `--exit-on-error`, so it continues
// past an object it cannot create and prints a tally at the end. We produced that output and threw it
// away, which cost us twice:
//
//   1. THE NUMBER WAS UNREAD. "errors ignored on restore: 7" is the difference between "this database
//      is a faithful copy" and "this database is a copy with seven holes in it", and it was in stderr
//      the whole time. The row-count check (queenzee/datadiff.js) catches the CONSEQUENCE — rows that
//      did not arrive, and only where a reference exists to catch them with — while the CAUSE is right
//      here, naming the object and the reason ('type "geometry" does not exist' is the classic).
//   2. WORSE: IT WAS MISREAD AS TOTAL FAILURE. pg_restore EXITS 1 when it ignored errors — verified by
//      running a real dump and a real restore, not from memory — and both restore paths treated any
//      non-zero exit as a throw. So a restore that actually completed, with data on disk, was logged
//      "restore FAILED", never recorded as having happened, and never graded. The omnibiz dev db that
//      was missing core.location (a table its dump certainly contained) is exactly this shape.
//
// So: a tally line means pg_restore RAN TO COMPLETION and is reporting its own count. That is a
// restore that completed WITH PROBLEMS — more useful than no restore, and it must be recorded, graded
// and said out loud. A non-zero exit with NO tally is still a genuine failure (bad archive, refused
// connection, killed process) and is still thrown.
//
// Pure, and built against VERBATIM output from a real pg_restore (see test/restore-grade-errors.test.mjs).

// The tally pg_restore prints last: "pg_restore: warning: errors ignored on restore: 7".
const TALLY = /errors ignored on restore:\s*(\d+)/i;
// An error line. The real format is one line of "pg_restore: error: <what>", sometimes followed by a
// "Command was: …" block and DETAIL/CONTEXT lines — those are context, not separate errors, so they
// are not counted as such. We keep the first line of each, which is the part that names the cause.
const ERR_LINE = /^pg_restore:\s*(?:error|warning):\s*(.+)$/i;
const SKIP_CONTEXT = /^(Command was:|DETAIL:|CONTEXT:|HINT:|\s|$)/;

const MAX_SAMPLE = 8;   // enough to see the pattern; a tooltip is not a log file

// stderr → { completed, ignored, errors[], error_count, truncated }.
//   completed  — pg_restore printed its tally, so it ran to the end of the archive
//   ignored    — the number IT reported (authoritative; never our own count of lines)
//   errors     — up to MAX_SAMPLE distinct first-lines, the CAUSE a human needs
export function parseRestoreErrors(stderr) {
  const text = String(stderr || '');
  const m = TALLY.exec(text);
  const seen = new Set();
  const errors = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (SKIP_CONTEXT.test(line)) continue;
    const e = ERR_LINE.exec(line.trim());
    if (!e) continue;
    const what = e[1].trim();
    if (TALLY.test(what)) continue;                    // the tally is not one of the errors
    // Collapse duplicates: forty rows of the same missing type is one fact, not forty.
    const key = what.slice(0, 160);
    if (seen.has(key)) continue;
    seen.add(key);
    if (errors.length < MAX_SAMPLE) errors.push(what);
  }
  return {
    completed: !!m,
    ignored: m ? Number(m[1]) : null,
    errors,
    error_count: seen.size,
    truncated: seen.size > errors.length,
  };
}

// The DECISION both restore paths need: did this restore happen?
//
//   { ok: true,  ignored: 0 }        a clean restore
//   { ok: true,  ignored: N }        COMPLETED WITH PROBLEMS — recorded, graded, said out loud, and
//                                   NOT thrown: the data is on disk and a copy with holes beats none
//   { ok: false }                    a genuine failure — no tally, so pg_restore never finished
//
// `status` is the process exit code (null/undefined when a pipe reports separately).
export function restoreOutcome({ status, stderr }) {
  const p = parseRestoreErrors(stderr);
  if (p.completed) {
    return {
      ok: true, completed_with_errors: p.ignored > 0, ignored: p.ignored,
      errors: p.errors, error_count: p.error_count, truncated: p.truncated,
      reason: p.ignored > 0
        ? `pg_restore completed but IGNORED ${p.ignored} error(s) — the data is loaded, with holes in it`
        : 'pg_restore completed with no ignored errors',
    };
  }
  if (status === 0) {
    // Exit 0 and no tally: older/quieter pg_restore versions print nothing when there is nothing to
    // report. Clean, and we say we could not see a tally rather than inventing a zero.
    return { ok: true, completed_with_errors: false, ignored: null, errors: p.errors,
             error_count: p.error_count, truncated: false,
             reason: 'pg_restore exited cleanly (it printed no error tally)' };
  }
  return { ok: false, completed_with_errors: false, ignored: null, errors: p.errors,
           error_count: p.error_count, truncated: p.truncated,
           reason: `pg_restore did not finish (exit ${status}) and printed no error tally — this is a `
             + 'genuine failure, not a restore with holes' };
}

// The one-line summary a human reads on the chip / in the log. Deliberately silent-ish when clean: a
// pool refresh restores databases all day, and a green line on every one of them is how the line that
// matters becomes invisible.
export function restoreErrorLine(report) {
  if (!report) return null;
  if (report.ok === false) return `restore FAILED — ${report.reason}`;
  if (!report.ignored) return null;                    // clean → say nothing
  return `⚠ ${report.ignored} error(s) IGNORED during the restore`
    + (report.errors?.length ? ` — e.g. ${report.errors[0]}` : '');
}

// PURE baseline/delta selection for "catch a xell's own db up to prod's schema" (see
// docs/schema-catchup-plan.md). This is the one genuinely-new decision in the catch-up flow; the
// rest (runPending / ledgerFiles / prodDb / proddiff / attachXellDb) is existing, exercised code.
//
// No I/O — exported for unit tests, exactly like decideProdDbTarget / pickDbContainer / diffPayload.
//
// INPUT
//   prodLedger : [{ filename, sha, applied_at }]  — the baseline=false rows of prod's zeehive_migrations,
//                i.e. every migration prod has actually RUN (never the baselined pre-ledger history).
//   opts.mode  : 'ledger' | 'isolated' | 'clone'
//     ledger   → opts.done : Set<filename> the target db ALREADY reflects, read from its OWN
//                zeehive_migrations table. This is the EXACT primary path: a db-isolated restored from
//                a full prod dump carries prod's ledger frozen at dump time, so the set-diff against
//                prod's current ledger is precisely the migrations prod ran afterwards. Also the path a
//                clone/isolated takes on its SECOND catch-up (the first one created the ledger).
//     isolated → opts.takenAt : the db_snapshot.taken_at the isolated db was restored from, used only
//                when the db has NO ledger (a table-scoped dump that dropped zeehive_migrations). Every
//                prod migration applied AT/BEFORE taken_at is in the dump by construction; only those
//                applied AFTER it are the delta. Reasons about TIME, not about what the dump contained.
//     clone    → opts.baselineDone : Set<filename> already reflected in the clone (from ledgerFiles at
//                merge-base(main, HEAD)); delta = prod files NOT in that set.
//
// OUTPUT { delta:[{filename, sha}], skipped:[filename], reason } — delta ordered by filename, de-duped.
// A file with no usable sha still rides the delta with sha=null; the caller falls back to main-tip.

function orderDedupe(rows) {
  const seen = new Set();
  const out = [];
  for (const r of [...rows].sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0)) {
    if (seen.has(r.filename)) continue;
    seen.add(r.filename);
    out.push({ filename: r.filename, sha: r.sha || null });
  }
  return out;
}

export function catchupDelta(prodLedger, opts = {}) {
  const ledger = Array.isArray(prodLedger) ? prodLedger.filter((r) => r && r.filename) : [];

  if (opts.mode === 'ledger') {
    const done = opts.done instanceof Set ? opts.done : new Set(opts.done || []);
    return { delta: orderDedupe(ledger.filter((r) => !done.has(r.filename))),
      skipped: ledger.filter((r) => done.has(r.filename)).map((r) => r.filename).sort(),
      reason: 'ledger-set-diff' };
  }

  if (opts.mode === 'isolated') {
    const t = opts.takenAt != null ? new Date(opts.takenAt).getTime() : NaN;
    if (Number.isNaN(t)) {
      // No snapshot timestamp to anchor on: cannot safely attribute the delta by time. Signal the
      // caller to fall back (read the db's own ledger, or recommend --restore) rather than guess.
      return { delta: [], skipped: ledger.map((r) => r.filename).sort(),
        reason: 'no-snapshot-anchor' };
    }
    const after = ledger.filter((r) => new Date(r.applied_at).getTime() > t);
    const before = ledger.filter((r) => new Date(r.applied_at).getTime() <= t);
    return { delta: orderDedupe(after), skipped: before.map((r) => r.filename).sort(),
      reason: 'isolated-by-taken-at' };
  }

  if (opts.mode === 'clone') {
    const done = opts.baselineDone instanceof Set ? opts.baselineDone : new Set(opts.baselineDone || []);
    const pend = ledger.filter((r) => !done.has(r.filename));
    return { delta: orderDedupe(pend),
      skipped: ledger.filter((r) => done.has(r.filename)).map((r) => r.filename).sort(),
      reason: 'clone-by-fork-baseline' };
  }

  return { delta: [], skipped: [], reason: 'unknown-mode' };
}

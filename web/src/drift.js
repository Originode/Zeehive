// DRIFT TEXT — the words the console puts on a schema comparison. No React, no DOM: pure functions
// over the payload queenzee/proddiff.js produces, so the rules inside them (which direction is
// dangerous, whether a verdict was actually recorded) are testable without a browser, and are
// written down in exactly ONE place instead of once per caller.
// ── the on-demand "Check diff" report ───────────────────────────────────────────────────────────
// A comparison the human ASKED for is read to answer a question ("why is this db drifted at all?"),
// so it gets the full report, not the one-line summary the background tick's chip carries: which db
// it was measured against, where the differences are BY SCHEMA (exact counts — the line that usually
// names the culprit), then the per-kind object names the server sampled.
//
// The chip tooltip (driftText, in Container.jsx) is the GLANCE; this is the INVESTIGATION.

// WHICH WAY the drift runs, which is the first thing worth knowing and the thing a total hides.
// Both counts are exact (never sampled), so this reading is safe:
//
//   only MISSING  → this db is a strict SUBSET of the reference. Nothing was created here that the
//                   reference lacks, so this is not local schema work: objects the reference has
//                   never arrived. Something in the LOAD fell short — a dump older than the
//                   reference (prod that ships migrations changes daily, a nightly snapshot does
//                   not), a table-scoped dump, or an object whose restore errored while pg_restore
//                   carried on past it.
//   only EXTRA    → a strict SUPERSET. `pg_restore --clean` drops only what the archive CONTAINS,
//                   so anything this db has that the dump does not survives every "fresh restore",
//                   forever. Unshipped schema work and objects prod has since dropped both land here.
//   both          → some of each; read the by-schema rollup to see whether they are the same story.
export function driftDirection(r) {
  let missing = 0, extra = 0;
  for (const v of Object.values(r?.kinds || {})) { missing += v.missing_count || 0; extra += v.extra_count || 0; }
  if (!missing && !extra) return null;
  if (!extra) return { kind: 'subset', missing, extra,
    text: `Every difference is MISSING and none is extra — this db is a strict SUBSET of the reference. `
        + `Nothing was added here, so look at what LOADED it: a dump older than the reference `
        + `(a schema that ships migrations moves daily), a table-scoped dump, or an object whose `
        + `restore errored while the rest carried on.` };
  if (!missing) return { kind: 'superset', missing, extra,
    text: `Every difference is EXTRA and nothing is missing — this db is a strict SUPERSET of the `
        + `reference. A restore drops only what its archive contains, so objects this db has and the `
        + `dump does not (unshipped schema work, or objects the reference has since dropped) survive `
        + `every fresh restore.` };
  return { kind: 'both', missing, extra,
    text: `${missing} missing AND ${extra} extra — two different stories in one number. The by-schema `
        + `rollup usually splits them: absent objects point at what loaded this db, extra ones at `
        + `work (or leftovers) that only exist here.` };
}

export function diffReportText(name, r) {
  const ref = r?.reference;
  const refName = ref ? `${ref.name}${ref.is_prod ? ' (production)' : ''}` : 'production';
  const head = `${name}\n  vs  ${refName}\n`;
  if (r?.same_db) return `${head}\nThese are the same database — there is nothing to diff.`;
  if (r?.ok === false) return `${head}\n⚠ could not compare:\n${r.error || 'unknown error'}`;

  const total = r?.total || 0;
  const out = [head];
  out.push(total === 0
    ? `\n✓ schema MATCHES ${ref?.is_prod === false ? 'this reference' : 'production'} — 0 differences.`
    : `\n⚠ DRIFTED — ${total} difference(s).`);

  if (total) {
    out.push('\n\n− = the reference has it, this db does not (code may expect it)');
    out.push('\n+ = this db has it, the reference does not');
    const dir = driftDirection(r);
    if (dir) out.push(`\n\n${dir.text}`);
    // Where the drift LIVES. Counts here are exact even when the name lists below are sampled, so a
    // single schema owning every difference (an extension's, one the dump never captured) is visible
    // immediately instead of inferred from 8 names.
    if (Array.isArray(r.by_schema) && r.by_schema.length) {
      out.push('\n\nby schema:');
      for (const s of r.by_schema) out.push(`\n  ${s.schema} — ${s.missing} missing, ${s.extra} extra`);
    }
    for (const [kind, v] of Object.entries(r.kinds || {})) {
      const miss = v.missing_count || 0, extra = v.extra_count || 0;
      if (!miss && !extra) continue;
      out.push(`\n\n${kind}: ${miss} missing, ${extra} extra`);
      for (const x of (v.missing || [])) out.push(`\n  − ${x}`);
      if (miss > (v.missing || []).length) out.push(`\n  … +${miss - v.missing.length} more missing`);
      for (const x of (v.extra || [])) out.push(`\n  + ${x}`);
      if (extra > (v.extra || []).length) out.push(`\n  … +${extra - v.extra.length} more extra`);
    }
  }
  // Only the comparison against PRODUCTION is a drift verdict, so only that one repaints the chip.
  // Say which happened — a human who compared dev↔dev must not think the chip now means that.
  out.push(r?.persisted
    ? `\n\nThe chip's drift mark now shows this verdict.`
    : `\n\nThis was measured against a NON-production database, so it is a report only — `
      + `the chip's drift-from-production mark is unchanged.`);
  return out.join('');
}

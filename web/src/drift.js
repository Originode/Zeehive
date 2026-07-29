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

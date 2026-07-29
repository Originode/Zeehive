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

// WHAT A DRIFT NUMBER COVERS, in one place, because both readings must carry it — TKT-22-4F0E:
// "check diff says a massive gap. and im afraid the data might not be fully backed up." Those are two
// questions and this comparison only answers the first. It reads catalogs: it counts no rows, opens
// no dump, and so can neither confirm nor deny that production's data is safe. A green 0 is not
// reassurance about data and a red 12,802 is not evidence of data loss. (docs/data-completeness-check.md)
export const SCOPE_LINE = 'What this covers: SCHEMA only — tables, columns, triggers.'
  + '\nWhat it does NOT: row data. It counts no rows and reads no backup, so it can neither confirm'
  + '\nnor deny that production data is fully backed up. (Backups panel → a dump\'s own table list.)';

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

  // EMPTY is not DRIFTED. A db holding none of the reference's tables was never loaded at all, and
  // reporting that as "12,802 differences" is how an unused dev clone came to look like a data-loss
  // event (TKT-22-4F0E). Say the true thing, and stop — a per-object list of "everything" helps nobody.
  if (r?.empty_db) {
    const t = r.kinds?.table || {};
    return `${head}\n⚠ this database is EMPTY — it has NO application tables at all.`
      + `\n${refName} has ${t.ref_count ?? '?'}; this db has ${t.mine_count ?? 0}.`
      + '\nIt was never restored, or its restore failed. That is not drift, and it says nothing'
      + `\nabout ${ref?.is_prod === false ? 'the reference' : 'production'} or its backups.`
      + `\n\n${SCOPE_LINE}`;
  }

  const total = r?.total || 0;
  const out = [head];
  out.push(total === 0
    ? `\n✓ schema MATCHES ${ref?.is_prod === false ? 'this reference' : 'production'} — 0 differences.`
    : `\n⚠ DRIFTED — ${total} difference(s).`);
  // On EVERY outcome, including the green one: a 0 here is the sentence most likely to be quoted
  // back as "so the backup is fine".
  out.push(`\n\n${SCOPE_LINE}`);

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

// ── the "Check data" report — the OTHER question, kept visibly other ────────────────────────────
// TKT-22-4F0E arrived as two questions in one sentence ("check diff says a massive gap. and im afraid
// the data might not be fully backed up") and the console had one number for both. This is the second
// answer, and it is written to be unmistakable for the first: it never says "drift", it names the
// BACKUP it compared against and when that backup was taken, and it states the asymmetry it rests on
// (an estimate on the reference side, an exact count here) so a few percent is never read as loss.
export function dataReportText(name, r) {
  const head = `${name}\n  rows vs the backup it was restored from\n`;
  if (r?.ok === false) return `${head}\n⚠ could not check:\n${r.error || 'unknown error'}`;

  const ref = r?.reference || {};
  const when = ref.taken_at ? new Date(ref.taken_at).toLocaleString() : 'unknown time';
  const out = [head, `\nbackup taken ${when}`];
  if (r?.restored_note) out.push(`\n(${r.restored_note})`);

  out.push(r.verdict === 'complete'
    ? `\n\n✓ every table has the rows that backup recorded — ${r.ok_count}/${r.checked} tables, `
      + `~${(r.got_total || 0).toLocaleString()} rows counted here vs ~${(r.ref_total || 0).toLocaleString()} recorded.`
    : r.verdict === 'incomplete'
      ? `\n\n⚠ DATA IS MISSING — ${r.empty.length} table(s) are EMPTY and ${r.short.length} are short of what `
        + `the backup recorded (${r.ok_count}/${r.checked} tables verified).`
      : `\n\n… NOT FULLY VERIFIED — ${r.ok_count}/${r.checked} tables match; the rest could not be judged.`);

  const list = (label, rows, fmt) => {
    if (!rows?.length) return;
    out.push(`\n\n${label} (${rows.length}):`);
    for (const x of rows.slice(0, 20)) out.push(`\n  ${fmt(x)}`);
    if (rows.length > 20) out.push(`\n  … +${rows.length - 20} more`);
  };
  // EMPTY first, always: it is the only shape no estimate error can explain away.
  list('EMPTY here, populated in the backup', r.empty, (x) => `${x.table} — backup ~${x.ref.toLocaleString()}, here 0`);
  list('short of the backup', r.short, (x) => `${x.table} — backup ~${x.ref.toLocaleString()}, here ${x.got.toLocaleString()}`);
  list('ABSENT from this database (schema, not rows — run Check diff)', r.missing, (x) => `${x.table}`);
  list('no reference count (never analyzed in the source)', r.unknown, (x) => `${x.table} — here ${x.got.toLocaleString()}`);

  out.push('\n\nThe reference is the planner\'s row ESTIMATE taken from the source when the dump was made;'
    + `\nthis side is an exact count. Expect a few percent either way — a shortfall under `
    + `${Math.round((ref.tolerance ?? 0.1) * 100)}% is not\nreported, and a table with MORE rows than the backup is `
    + 'normal (rows kept arriving, or this db\nhas been written to since).');
  out.push('\n\nWhat this covers: ROW COUNTS per table.'
    + '\nWhat it does NOT: the contents of a row, and the SCHEMA (that is Check diff).');
  return out.join('');
}

// ── the chip's DATA lines: what the last restore reported, and how its rows graded ────────────────
// Two facts, adjacent and separate, because they answer different questions and neither substitutes for
// the other (#30): the TALLY says "this restore had trouble, and here is the cause", the GRADE says
// "and here is what is missing". A restore can ignore 400 errors while every table it loaded still
// passes its counts — indexes, constraints and triggers are not rows.
//
// And the schema drift lines above are a THIRD question. All three live on one chip, so each says which
// it is; that separation is the whole of TKT-22-4F0E.
export function dataText(c) {
  const out = [];
  const r = c.restore_report;
  if (r) {
    const when = c.restored_at ? new Date(c.restored_at).toLocaleString() : '';
    if (r.ok === false) {
      out.push(`\n\n⚠ last restore FAILED${when ? ` (${when})` : ''}\n${r.reason || ''}`);
    } else if (r.ignored) {
      out.push(`\n\n⚠ last restore IGNORED ${r.ignored} error(s)${when ? ` (${when})` : ''}`);
      out.push('\nThe data loaded, with holes in it. pg_restore continued past these:');
      for (const e of (r.errors || []).slice(0, 5)) out.push(`\n  · ${e}`);
      if (r.truncated || (r.error_count || 0) > (r.errors || []).length) {
        out.push(`\n  … ${(r.error_count || 0) - (r.errors || []).length} more distinct error(s)`);
      }
      out.push('\nRows are a separate question — see the row check below.');
    } else {
      // Clean restores get ONE quiet line. A pool refresh restores databases all day.
      out.push(`\n\n✓ last restore clean${when ? ` (${when})` : ''} — pg_restore ignored no errors`);
    }
  }

  const d = c.data_check;
  if (d) {
    const when = c.data_check_at ? ` (${new Date(c.data_check_at).toLocaleString()})` : '';
    if (d.ok === false) {
      out.push(`\n\nrow check: not run${when} — ${d.error || 'unknown reason'}`);
    } else if (d.verdict === 'incomplete') {
      out.push(`\n\n⚠ ROWS MISSING vs the backup this db was restored from${when}`);
      out.push(`\n${d.empty?.length || 0} table(s) EMPTY, ${d.short?.length || 0} short (${d.ok_count}/${d.checked} verified)`);
      for (const x of [...(d.empty || []), ...(d.short || [])].slice(0, 5)) {
        out.push(`\n  · ${x.table} — backup ~${x.ref?.toLocaleString?.() ?? x.ref}, here ${x.got?.toLocaleString?.() ?? x.got}`);
      }
    } else if (d.verdict === 'unverified') {
      out.push(`\n\nrow check${when}: ${d.ok_count}/${d.checked} table(s) match; the rest could not be judged`);
    } else {
      out.push(`\n\n✓ rows match the backup this db was restored from${when} (${d.ok_count}/${d.checked} tables)`);
    }
    out.push('\nRow COUNTS only — not the contents of a row, and not the schema.');
  }
  return out.join('');
}

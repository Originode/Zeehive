// THE HELPER THAT EDITS HARNESS MEMORY BY PATH — exercised against a real database.
//
// `harness.bundle->'memory'` is an ARRAY of {path, text} entries and it is edited by MIGRATION. Six
// migrations (050, 051, 053, 056, 057, 066) patched it by reading `memory->0` and writing the array
// back as a single-element `jsonb_build_array` — which deletes every other memory file in that
// harness. That is not a style point: it removed the hand-written `tend-or-land.md` note from the
// LIVE meta-DB, and it survived six migrations and two zees because it is invisible on a fresh
// database (only one entry exists to destroy) and every cxell has a fresh database.
//
// test/harness-memory-migrations.test.mjs lints the pattern out of new migrations. This test covers
// the other half: that `harness_memory_put()` (migration 076) actually does what a migration author
// is now told to rely on, against real postgres and real jsonb:
//
//   • APPENDS when the path is absent, REPLACES when it is present, and NEVER touches a sibling
//   • is a SET, not an append-to-the-array — calling it twice is one entry, not two (idempotent
//     in the 065/071 sense: a re-run past the ledger is a no-op)
//   • preserves other keys on the entry it patches, and the ORDER of the array
//   • refuses the calls that would silently corrupt a persona (NULL text, non-array memory)
//   • and, side by side on the same fixture, the historical hand-rolled pattern DELETES the sibling
//     while the helper keeps it — the regression, reproduced and then shown fixed
//
// It also reads the live `zee-base` row: on any migrated database the manual and the hygiene note
// must BOTH be there (071), and the manual must carry what 077 wrote through the helper.
//
// Needs DATABASE_URL (this repo's `.zeehive.env`). If the helper is missing, your db is behind the
// ledger — run `npm run db:migrate` before reading a failure here as a bug.
const { q, one, pool } = await import('../server/src/db/pool.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const KEY = 'zz-memput-probe';                      // throwaway harness row, deleted in the finally
const paths = (bundle) => (bundle?.memory || []).map((m) => m.path);
const entry = (bundle, path) => (bundle?.memory || []).find((m) => m.path === path);
const bundleOf = async (key = KEY) => (await one(`SELECT bundle FROM harness WHERE key=$1`, [key]))?.bundle;
const put = async (path, text, key = KEY) =>
  (await one(`SELECT harness_memory_put($1,$2,$3) AS r`, [key, path, text]))?.r;
const get = async (path, key = KEY) =>
  (await one(`SELECT harness_memory_get($1,$2) AS t`, [key, path]))?.t;
const fixture = async (bundle) => {
  await q(`DELETE FROM harness WHERE key=$1`, [KEY]);
  await q(`INSERT INTO harness (key, label, bundle) VALUES ($1, 'memput probe', $2::jsonb)`,
    [KEY, JSON.stringify(bundle)]);
};

try {
  // ── 0. the helper is in the schema, where a migration can reach it ──
  console.log('\n── the helper lives in the SCHEMA (a migration can call it; a JS module could not) ──');
  const fns = await q(
    `SELECT p.proname, pg_get_function_result(p.oid) AS ret, obj_description(p.oid,'pg_proc') AS comment
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE p.proname IN ('harness_memory_put','harness_memory_get') AND n.nspname='public'`);
  ok(fns.some((f) => f.proname === 'harness_memory_put'),
     'harness_memory_put() exists (if this fails your db is behind the ledger — npm run db:migrate)');
  ok(fns.some((f) => f.proname === 'harness_memory_get'), 'harness_memory_get() exists beside it');
  ok(fns.every((f) => f.comment && /BY PATH/i.test(f.comment)),
     'both are COMMENTed with the rule, so the next author finds it from psql');

  // ── 1. append, then append again: siblings accumulate, nothing is lost ──
  console.log('\n── APPEND when the path is absent ──');
  await fixture({ label: 'memput probe' });                       // no `memory` key at all
  ok(await put('manual.md', 'one') === 'appended', 'the first entry is appended even with no memory array present');
  ok(await put('note.md', 'two') === 'appended', 'and so is a second');
  let b = await bundleOf();
  ok(JSON.stringify(paths(b)) === JSON.stringify(['manual.md', 'note.md']),
     'both entries are there, in the order they were written');
  ok(await get('manual.md') === 'one' && await get('note.md') === 'two', 'and both read back BY PATH');
  ok(await get('missing.md') === null, 'a path that is not there reads as NULL, not an error');

  // ── 2. replace by path: the sibling survives (this is the whole bug) ──
  console.log('\n── REPLACE when it is present — and the sibling survives ──');
  ok(await put('manual.md', 'one, edited') === 'replaced', 'patching an existing path reports "replaced"');
  b = await bundleOf();
  ok(entry(b, 'manual.md').text === 'one, edited', 'the entry took the new text');
  ok(entry(b, 'note.md')?.text === 'two',
     'and the OTHER memory file is untouched — the six migrations deleted it right here');
  ok(paths(b).length === 2 && JSON.stringify(paths(b)) === JSON.stringify(['manual.md', 'note.md']),
     'the array is the same length and the same order (a patch, not a rebuild)');

  // ── 3. it is a SET, so a re-run is a no-op rather than a second copy ──
  console.log('\n── idempotent: writing the same text twice is one entry ──');
  ok(await put('manual.md', 'one, edited') === 'unchanged', 'the same text again is reported "unchanged"');
  ok(await put('note.md', 'two, edited') === 'replaced' && await put('note.md', 'two, edited') === 'unchanged',
     'and a real change followed by a repeat settles at "unchanged"');
  b = await bundleOf();
  ok(paths(b).filter((p) => p === 'note.md').length === 1, 'never a duplicate entry for the same path');

  // ── 4. what else lives on the entry is not the helper's business ──
  console.log('\n── it patches TEXT, not the entry ──');
  await fixture({ memory: [
    { path: 'manual.md', text: 'one', pinned: true, source: 'migration 047' },
    { path: 'note.md', text: 'two' },
  ] });
  await put('manual.md', 'one, edited');
  b = await bundleOf();
  ok(entry(b, 'manual.md').pinned === true && entry(b, 'manual.md').source === 'migration 047',
     'other keys on the patched entry survive (it writes {memory,i,text}, not the whole element)');

  // ── 5. the calls it refuses, because the alternative is a corrupted persona ──
  console.log('\n── the refusals ──');
  const throws = async (sql, params) => {
    try { await q(sql, params); return null; } catch (e) { return e.message; }
  };
  const nullErr = await throws(`SELECT harness_memory_put($1,'manual.md',NULL)`, [KEY]);
  ok(nullErr && /NULL text/i.test(nullErr),
     'a NULL text is refused, not written — it is always an unguarded read in the caller');
  const pathErr = await throws(`SELECT harness_memory_put($1,'   ','x')`, [KEY]);
  ok(pathErr && /path/i.test(pathErr), 'an empty path is refused (a memory file with no name is not addressable)');
  ok(await one(`SELECT harness_memory_put('no-such-harness','a.md','x') AS r`).then((r) => r.r) === 'no-harness',
     'a harness that does not exist on this database reports "no-harness" rather than failing the migration');
  await fixture({ memory: { 'manual.md': 'one' } });             // memory as an OBJECT: not our shape
  const shapeErr = await throws(`SELECT harness_memory_put($1,'manual.md','x')`, [KEY]);
  ok(shapeErr && /not an array/i.test(shapeErr),
     'a bundle whose memory is not an array is refused rather than overwritten');
  ok(await get('manual.md') === null, 'and the read half returns NULL for that shape instead of erroring');

  // ── 6. the regression, side by side on the same fixture ──
  console.log('\n── the old pattern vs the helper, on the same data ──');
  const twoEntries = { memory: [{ path: 'manual.md', text: 'one' }, { path: 'note.md', text: 'two' }] };
  await fixture(twoEntries);
  // Exactly what 050/051/053/056/057/066 do: read memory->0, write the array back as one element.
  await q(`UPDATE harness SET bundle = jsonb_set(bundle, '{memory}',
             jsonb_build_array(jsonb_build_object('path', bundle->'memory'->0->>'path',
                                                  'text', (bundle->'memory'->0->>'text') || ', edited')))
            WHERE key=$1`, [KEY]);
  b = await bundleOf();
  ok(paths(b).length === 1 && !entry(b, 'note.md'),
     'the hand-rolled rebuild DELETES the sibling — reproduced here so the reason for the helper is not folklore');
  await fixture(twoEntries);
  await put('manual.md', 'one, edited');
  b = await bundleOf();
  ok(paths(b).length === 2 && entry(b, 'note.md')?.text === 'two' && entry(b, 'manual.md').text === 'one, edited',
     'the helper makes the same edit and keeps the sibling');

  // ── 7. the live row: what the migrations actually produced on THIS database ──
  console.log('\n── zee-base on this database ──');
  const zb = await bundleOf('zee-base');
  ok(!!zb, 'zee-base is present (it carries the cxell manual every zee is briefed with)');
  ok(paths(zb).includes('cxell-zee-manual.md') && paths(zb).includes('tend-or-land.md'),
     'it holds BOTH memory files — the manual and the hygiene note the six deleters removed (071 re-seeds it)');
  const manual = await get('cxell-zee-manual.md', 'zee-base');
  ok(/is a db question first/.test(manual || ''),
     'and the manual carries the paragraph migration 077 wrote THROUGH the helper (the helper is used, not dead schema)');
  ok((await get('tend-or-land.md', 'zee-base') || '').length > 1500,
     'while the hygiene note beside it is whole — the sibling a hand-rolled patch would have taken');
} finally {
  await q(`DELETE FROM harness WHERE key=$1`, [KEY]).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

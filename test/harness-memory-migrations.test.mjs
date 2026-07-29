// HOW A MIGRATION MAY EDIT THE MANUAL — a lint, earned the hard way.
//
// The manual (and the hygiene note beside it) live in the meta-DB as `harness.bundle->'memory'`, an
// ARRAY of {path, text} entries, and they are edited by migration. Two ways of doing that are safe
// and one destroys data:
//
//   SAFE   find the entry BY PATH, write back to that index. 063/064/065/069/070 do this, and 064's
//          comment says why in one line: "Located BY PATH within the memory array (never by index)".
//   SAFE   append a NEW entry with `existing || jsonb_build_array(...)`.
//   FATAL  rebuild the array: `jsonb_set(bundle,'{memory}', jsonb_build_array(<one entry>))`. Every
//          other memory file in that harness is deleted, silently, and only on databases that HAVE
//          more than one — which is never a fresh one, so tests pass and production loses a file.
//
// That is not hypothetical, and it is not one rogue migration: SIX of them do it (050, 051, 053,
// 056, 057, 066). It was harmless for as long as `memory` held exactly one entry — and then a human
// typed a second file into the harness manager, and every one of those migrations became a delete.
// 066 is simply the one that ran recently enough to be caught in the act: it removed the
// hand-written `tend-or-land.md` note from this xell's database the moment it applied. On a FRESH
// database none of this shows, because nothing has added a second entry by the time they run —
// which is why it survived six migrations and two zees.
//
// 064 is the one that got it right, and it wrote the rule down in a comment while doing so:
// "Located BY PATH within the memory array (never by index)". This lint is that comment, enforced.
//
// The six are GRANDFATHERED, not rewritten: a forward-only ledger means they are already applied
// everywhere, so editing them changes nothing and desynchronises the record. You repair forward —
// 071 re-seeds the note any of them deleted. The list below is the record of the bug, not
// permission to copy it; anything newer must obey the rule.
//
// AND SINCE 076 THERE IS A HELPER, so the rule is no longer "remember to address by path" — it is
// "do not hand-roll it at all". `harness_memory_put(harness_key, path, text)` locates the entry BY
// PATH, replaces when present, appends when absent and preserves every sibling; `harness_memory_get`
// is its read half. Every migration that sorts after the helper must go through it, and the second
// half of this lint enforces exactly that — including on two SAMPLES compiled into the test, so the
// guard is proved to fire rather than merely proved not to complain about today's files.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(here, '..', 'db', 'migrations');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// Applied everywhere before the rule existed; repaired by 071. Do not add to this list — if a new
// migration needs to be here, it needs to be rewritten instead.
const GRANDFATHERED = new Set([
  '050_manual_zee_seed.sql', '051_manual_prod_ask_visible.sql', '053_manual_manager_crew.sql',
  '056_manual_tend_reason.sql', '057_manual_tend_reason_full.sql', '066_manual_ship_refusal.sql',
]);

const files = readdirSync(DIR).filter((f) => f.endsWith('.sql'));
const touchesMemory = files.filter((f) => /bundle\s*->\s*'memory'|'\{memory\}'/.test(readFileSync(join(DIR, f), 'utf8')));
console.log(`\n── ${touchesMemory.length} migration(s) touch harness memory ──`);
ok(touchesMemory.length > 0, 'the lint found the migrations it is meant to police');

for (const f of touchesMemory) {
  const sql = readFileSync(join(DIR, f), 'utf8');
  const rebuilds = /jsonb_set\s*\(\s*bundle\s*,\s*'\{memory\}'\s*,\s*(mem\b|jsonb_build_array)/.test(sql)
    && !/COALESCE\s*\(\s*bundle\s*->\s*'memory'[\s\S]{0,80}\|\|/.test(sql);
  const byIndex = /bundle\s*->\s*'memory'\s*->\s*\d+/.test(sql);
  if (GRANDFATHERED.has(f)) {
    ok(rebuilds || byIndex, `${f} is the KNOWN violation this lint exists for (still true, so the note stays honest)`);
    continue;
  }
  ok(!rebuilds, `${f} does not rebuild the memory array (that deletes every other memory file)`);
  ok(!byIndex, `${f} does not read memory by POSITION (index 0 is not a promise)`);
}

// ── THE HELPER, and the rule that it is now the only way ─────────────────────
// The lint above catches the next occurrence; the helper removes the opportunity. It lives in the
// SCHEMA (a migration can call it; a JS module could not) and it is the one function that writes
// harness memory.
console.log('\n── the helper ──');
const HELPER = 'harness_memory_put';
const helperFile = files.sort().find((f) => new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+${HELPER}`, 'i')
  .test(readFileSync(join(DIR, f), 'utf8')));
ok(!!helperFile, `a migration defines ${HELPER}() — the one function that writes harness memory`);
const helperSql = helperFile ? readFileSync(join(DIR, helperFile), 'utf8') : '';
// CREATE OR REPLACE, not CREATE: re-running the file past the ledger must redefine, not fail.
ok(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+harness_memory_get/i.test(helperSql),
   `${helperFile} defines its read half too (harness_memory_get), so an anchored edit never walks the array either`);
ok(/e\s*->>\s*'path'\s*=\s*p_path/.test(helperSql),
   'the helper locates the entry BY PATH — the rule 064 wrote down and six migrations broke');
ok(/COALESCE\s*\(\s*bundle\s*->\s*'memory'[\s\S]{0,120}\|\|/.test(helperSql),
   'when the entry is absent it APPENDS to the existing array (never rebuilds it)');
ok(/ARRAY\[\s*'memory'\s*,\s*idx::text\s*,\s*'text'\s*\]/.test(helperSql),
   'when it is present it writes only that entry\'s text — every sibling, and every other key on the entry, survives');

// The rule, mechanically: anything that sorts AFTER the helper may not touch the memory array by
// hand. This is the sentence a future author reads when the suite goes red, so it names the helper
// and the call to make.
const MUST_USE = (f) => `${f} must edit harness memory through ${HELPER}(<harness key>, <path>, <text>) `
  + `(read it back with harness_memory_get) — it finds the entry BY PATH, replaces it when present and appends it `
  + `when absent, so every sibling memory file survives. Hand-rolled jsonb against harness.bundle is what `
  + `050/051/053/056/057/066 did, and it deleted a memory file out of the live meta-DB.`;

// A file breaks the rule when it WRITES harness.bundle itself while dealing in memory. Defined as a
// function so the samples below run through the identical check the migrations do.
const handRollsMemoryWrite = (sql) => {
  const writesBundle = /UPDATE\s+harness\b[\s\S]{0,400}?\bSET\b[\s\S]{0,400}?\bbundle\s*=/i.test(sql);
  const dealsInMemory = /'\{memory\}'|bundle\s*->\s*'memory'|ARRAY\[\s*'memory'|'memory'\s*,\s*jsonb_build_array/.test(sql);
  return writesBundle && dealsInMemory;
};

console.log('\n── the guard fires (samples, not files) ──');
const SAMPLE_HAND_ROLLED = `DO $$ DECLARE idx int; txt text; BEGIN
  SELECT (a.i-1), a.e->>'text' INTO idx, txt FROM harness h,
    LATERAL jsonb_array_elements(h.bundle->'memory') WITH ORDINALITY AS a(e,i)
   WHERE h.key='zee-base' AND a.e->>'path'='cxell-zee-manual.md';
  UPDATE harness SET bundle = jsonb_set(bundle, ARRAY['memory', idx::text, 'text'], to_jsonb(txt || 'more'))
   WHERE key='zee-base'; END $$;`;
const SAMPLE_HELPER = `DO $$ DECLARE txt text; BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL OR txt LIKE '%more%' THEN RETURN; END IF;
  PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', txt || 'more'); END $$;`;
ok(handRollsMemoryWrite(SAMPLE_HAND_ROLLED),
   'a NEW migration that hand-rolls the memory array is caught (even the by-path form — the helper exists now)');
ok(!handRollsMemoryWrite(SAMPLE_HELPER), `and one written through ${HELPER}() passes`);

console.log('\n── every migration after the helper uses it ──');
const after = helperFile ? files.filter((f) => f > helperFile) : [];
ok(after.length > 0, `at least one migration sorts after ${helperFile} and can prove the helper works`);
let usesHelper = 0;
for (const f of after) {
  const sql = readFileSync(join(DIR, f), 'utf8');
  if (new RegExp(`${HELPER}\\s*\\(`).test(sql)) usesHelper++;
  if (!handRollsMemoryWrite(sql)) continue;          // the common case: says nothing about memory
  ok(false, MUST_USE(f));
}
ok(usesHelper > 0, `and at least one of them CALLS ${HELPER}() — the helper is exercised by a real migration, not shipped as dead schema`);

// And the repair for the one that did: the note must be re-seedable, guarded, and it must run AFTER
// the migration that removes it — filename order is the only ordering a forward-only ledger has.
console.log('\n── the repair ──');
const seed = files.find((f) => /seed_tend_or_land/.test(f));
ok(!!seed, 'a migration re-seeds the note 066 deletes');
// Against the LAST of them, not the first: the repair has to run after every migration that can
// delete the note, and on a fresh database they all run in one pass.
const lastDeleter = [...GRANDFATHERED].sort().pop();
ok(seed > lastDeleter,
   `and it sorts AFTER the LAST migration that deletes it (${seed} > ${lastDeleter}) — filename order is the ledger's only order`);
const seedSql = readFileSync(join(DIR, seed), 'utf8');
ok(/IF has_note THEN RETURN/.test(seedSql), 'it is guarded, so it never overwrites a note somebody edited');
ok(/COALESCE\(bundle->'memory'[\s\S]{0,40}\|\|/.test(seedSql), 'and it APPENDS rather than rebuilding — the rule it is written to obey');

console.log(`\n${fail === 0 ? 'ALL PASSED ✓' : `${fail} FAILURE(S) ✗`}`);
process.exit(fail === 0 ? 0 : 1);

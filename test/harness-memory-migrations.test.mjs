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

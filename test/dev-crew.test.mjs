// THE DEV CREW — the project-agnostic role harnesses, and the BUDGETS that keep them affordable.
//
// The crew is `zee-base → dev-base → dev-<role>`. What this test defends is not that the rows exist
// but that the shape stays cheap and stays honest, because both decay silently:
//
//   1. THE CHAIN. Every role's parent is dev-base, dev-base's parent is zee-base, and `parent_id` on
//      the row is what resolves it. A role that loses its parent still looks perfectly healthy in the
//      console and briefs its wearer with no manual at all.
//   2. THE MANUAL ARRIVES ONCE, BY INHERITANCE. It lives in the meta-DB on zee-base; no member of
//      this subtree may carry a copy, and it must appear EXACTLY once in the merged memory. Two
//      copies is not merely waste — it is two versions of the wearer's own law, one of them stale
//      from the day it was pasted.
//   3. THE BUDGETS. effectiveHarness() merges root → leaf and harnessLayerText() INLINES the
//      personality, every skill body and every memory file into the briefing. So a paragraph added
//      to all eight roles is paid for by every wearer, eight times over, on every dispatch. The
//      rule is therefore structural: shared text lives in dev-base ONCE, and a ROLE carries no
//      memory files at all, a short personality and at most two small skills.
//   4. NO RESTATED VERBS, NO PROJECT LORE. House rule 8 — what a zee is told is versioned like
//      code, and a harness that paraphrases a CLI verb is drift the moment the CLI moves. These
//      personas also work on OTHER repositories, so a Zeehive path or container name in one is a
//      lie to its wearer.
//   5. zee_type = worker for every member (they land code; a manager never does).
//
// Three things about HOW it checks, each of which was a hole worth naming:
//
//   * IT LINTS THE PARSED BUNDLE, never a file. Since migration 080 the row IS the harness and there
//     are no harnesses/dev-*/ files left to read — but the bundle was the right target even before
//     that, because it is what a zee ACTUALLY RECEIVES. The old file lint walked the folder and
//     skipped HARNESS.yml (its YAML comments tripped the verb regex), while `label:` and `summary:`
//     out of that same file went into the bundle and into every picker: project lore could be
//     smuggled through the one file nothing checked. A bundle has no comments to trip over and no
//     field that reaches a wearer unlinted.
//   * IT DERIVES THE CREW from the rows. The roster used to be a hardcoded map in this file, so a
//     role added by migration was checked by NOTHING until a human remembered to come and edit it.
//   * IT WRITES NOTHING. Every call below is a read (the folder refresh that used to rewrite these
//     rows is gone with 080), so there is nothing to snapshot and nothing to restore.
const H = await import('../server/src/lib/harness.js');
const { q, one, pool } = await import('../server/src/db/pool.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// The budgets — the ONLY numbers this file states, and it enforces every one of them as a ceiling.
// Measured on the bundle, which is what a wearer pays for on every dispatch.
const ROLE_PERSONALITY_LINES = 40;
const ROLE_SKILL_BODY_LINES = 30;
const ROLE_MAX_SKILLS = 2;
const ROLE_OWN_CHARS = 8000;          // a role's OWN contribution to the briefing
const BASE_PERSONALITY_LINES = 30;
const BASE_MEMORY_LINES = 180;
const BASE_OWN_CHARS = 16000;

const CREW_ROOT = 'dev-base';         // the harness whose subtree IS the worker crew
const LEAD = 'dev-lead';              // the MANAGER harness that casts it — deliberately not crew

const bundleOf = (row) => (typeof row.bundle === 'string' ? JSON.parse(row.bundle) : (row.bundle || {}));
const ownChars = (b) => (b.personality || '').length
  + (b.skills || []).reduce((n, s) => n + String(s.body || '').length, 0)
  + (b.memory || []).reduce((n, m) => n + String(m.text || '').length, 0);
const lines = (t) => String(t || '').replace(/\n$/, '').split('\n').length;
// harnessFiles() slugs a skill name into its directory the same way; mirrored so the expected paths
// below are derived from the real skill names rather than listed.
const fileSafe = (s) => String(s || 'note').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

// Every field of a bundle that reaches a wearer, with a name for the failure message. `label`,
// `summary` and `glyph` are in here on purpose: they are the ones the old file lint could not see.
const ownTexts = (b) => [
  ['label', b.label], ['summary', b.summary], ['glyph', b.glyph], ['personality', b.personality],
  ...(b.skills || []).flatMap((s) => [[`skill ${s.name} (when)`, s.when], [`skill ${s.name}`, s.body]]),
  ...(b.memory || []).map((m) => [`memory ${m.path}`, m.text]),
].filter(([, t]) => String(t || '').trim());

const hits = (rows, re) => rows.flatMap(([key, b]) => ownTexts(b)
  .filter(([, t]) => re.test(t)).map(([where, t]) => `${key} ${where}: "${t.match(re)[0].trim()}"`));

try {
  console.log('\n── the crew derives from the rows, not from a list in this file ──');
  const all = await q(
    `SELECT h.*, p.key AS parent_key FROM harness h LEFT JOIN harness p ON p.id = h.parent_id`);
  const byKey = Object.fromEntries(all.map((r) => [r.key, r]));

  // MEMBERSHIP IS STRUCTURAL: a harness is crew if its parent chain reaches dev-base.
  //
  // NOT `key LIKE 'dev-%'`. A prefix glob is a test on the NAME, and the name is an accident of
  // authoring: `dev-lead` matches it and is not crew — it is a MANAGER harness (zee_type=manager,
  // parent `manager`, its own test) for which every budget and every assertion below is simply the
  // wrong question. The glob fails the other way too: `zeetest` sits under zee-base and would be
  // missed by the prefix while a future role named without it would go unchecked. What a harness IS
  // — its declared type and its parent chain — is the thing these lints are actually about, so a
  // role added under dev-base is linted whatever it is called, and a manager harness never is
  // however it is named.
  const chainOf = (key) => { const c = []; let cur = byKey[key], n = 0;
    while (cur && n++ < 32) { c.push(cur.key); cur = byKey[cur.parent_key]; } return c; };
  const isCrew = (key) => chainOf(key).includes(CREW_ROOT);
  const crew = all.filter((r) => isCrew(r.key)).sort((a, b) => a.key.localeCompare(b.key));
  const roles = crew.filter((r) => r.key !== CREW_ROOT);
  const crewKeys = crew.map((r) => r.key);

  // The vacuity guard. Every loop below iterates this list, so a derivation that returns nothing
  // would report a clean run having checked nothing at all.
  ok(!!byKey[CREW_ROOT], `${CREW_ROOT} is in the meta-DB (run db:migrate — 073_dev_crew.sql)`);
  ok(roles.length >= 1, `the ${CREW_ROOT} subtree has roles in it (found ${roles.length})`);
  console.log(`     derived crew: ${crewKeys.join(', ')}`);

  const base = byKey[CREW_ROOT];
  if (!base) throw new Error(`no ${CREW_ROOT} harness row — apply db/migrations/073_dev_crew.sql`);
  const baseOwn = bundleOf(base);

  const notWorker = crew.filter((r) => r.zee_type !== 'worker');
  ok(!notWorker.length,
     `every crew harness is zee_type=worker (${notWorker.map((r) => `${r.key}=${r.zee_type}`).join(', ') || 'all worker'})`);
  const disabled = crew.filter((r) => !r.enabled);
  ok(!disabled.length, `and every one is enabled (${disabled.map((r) => r.key).join(', ') || 'none disabled'})`);
  // dir is the dead file-backing column: a non-null value means a folder projection is back, which is
  // what 080 removed and what made a migration's edit invisible behind an agreeing hash.
  const filed = crew.filter((r) => r.dir !== null);
  ok(!filed.length, `all DB-owned — no dir projects over a row (${filed.map((r) => r.key).join(', ') || 'none'})`);
  const wrongParent = roles.filter((r) => r.parent_key !== CREW_ROOT);
  ok(!wrongParent.length,
     `every role's parent is ${CREW_ROOT} (${wrongParent.map((r) => `${r.key}→${r.parent_key}`).join(', ') || 'all correct'})`);
  ok(base.parent_key === 'zee-base', `and ${CREW_ROOT} inherits zee-base (got ${base.parent_key})`);

  console.log('\n── and it selects on what a harness IS, so the lead stays outside ──');
  const lead = byKey[LEAD];
  ok(!!lead, `${LEAD} exists (the manager harness that casts this crew)`);
  ok(!crewKeys.includes(LEAD),
     `${LEAD} is NOT linted as crew — it matches a "dev-" prefix but its chain is ${chainOf(LEAD).reverse().join(' → ')}`);
  ok(lead?.zee_type === 'manager', `because it is a manager harness (zee_type=${lead?.zee_type})`);

  // Two independent statements of the roster: the rows, and the memory the lead actually casts from.
  // A role added by migration that the lead has never heard of cannot be dispatched, and a role the
  // lead names that no longer exists is a cast that fails at spawn — so they must agree exactly.
  console.log('\n── the roster the lead casts from is the crew that exists ──');
  const roster = (await one(`SELECT harness_memory_get($1,'memory/dev-role-roster.md') AS t`, [LEAD]))?.t || '';
  ok(!!roster.trim(), `${LEAD} carries memory/dev-role-roster.md (${roster.length} chars)`);
  const named = [...new Set([...roster.matchAll(/`(dev-[a-z-]+)`/g)].map((m) => m[1]))].filter((k) => k !== CREW_ROOT);
  const unknownToLead = roles.map((r) => r.key).filter((k) => !named.includes(k));
  const leadInvents = named.filter((k) => !roles.some((r) => r.key === k));
  ok(!unknownToLead.length,
     `every role in the meta-DB is on the lead's roster (missing: ${unknownToLead.join(', ') || 'none'})`);
  ok(!leadInvents.length,
     `and the roster names no role that does not exist (${leadInvents.join(', ') || 'none'})`);

  console.log('\n── the manual is INHERITED, exactly once, and copied nowhere ──');
  const baseEff = await H.effectiveHarness(base);
  ok(baseEff.chain.join(' → ') === 'Zee Base → Dev Base', `${CREW_ROOT} chain: ${baseEff.chain.join(' → ')}`);
  const manualIn = (eff) => (eff.memory || []).filter((m) => /cxell-zee-manual/.test(m.path));
  ok(manualIn(baseEff).length === 1 && manualIn(baseEff)[0].text.length > 5000,
     `${CREW_ROOT} inherits ONE copy of the manual (${manualIn(baseEff)[0]?.text.length || 0} chars)`);
  ok(manualIn(baseEff)[0]?.from === 'zee-base',
     `stamped with the harness that owns it (from=${manualIn(baseEff)[0]?.from})`);
  const copies = crew.filter((r) => (bundleOf(r).memory || []).some((m) => /cxell-zee-manual/.test(m.path)));
  ok(!copies.length, `and no crew harness carries a copy of its own (${copies.map((r) => r.key).join(', ') || 'none'})`);

  console.log('\n── no restated verbs, no project lore — in the BUNDLE a zee receives ──');
  const own = crew.map((r) => [r.key, bundleOf(r)]);
  const VERBS = /(^|[^a-z-])zee\s+(status|working|env|build|device|sync|db-catchup|tend|land|ship|hint-land|hint-ship|prod|seed|report|inbox|work|item|done|dispatch|say|suggest-done)\b|--wait\b|--hot\b|--watch\b|--withdraw\b/;
  const restating = hits(own, VERBS);
  ok(!restating.length,
     `no crew harness restates a CLI verb or flag — the manual is referred to, never quoted `
     + `(${restating.join('; ') || 'none'})`);
  // Project lore: these personas are dispatched on OTHER repositories.
  const LORE = /server\/src|db\/migrations|zeehive_[a-z]+_|npm run |queenzee|\.zeehive\.env/;
  const lore = hits(own, LORE);
  ok(!lore.length,
     `no crew harness names a Zeehive path, container or script (${lore.join('; ') || 'none'})`);

  console.log('\n── dev-base is the ONE place shared text lives, and it is bounded ──');
  ok(lines(baseOwn.personality) <= BASE_PERSONALITY_LINES,
     `${CREW_ROOT} personality is ${lines(baseOwn.personality)} lines (≤ ${BASE_PERSONALITY_LINES})`);
  const loop = (baseOwn.memory || []).find((m) => /dev-loop/.test(m.path));
  ok(!!loop, `${CREW_ROOT} carries memory/dev-loop.md — the shared loop, written once`);
  ok(lines(loop?.text) <= BASE_MEMORY_LINES, `dev-loop.md is ${lines(loop?.text)} lines (≤ ${BASE_MEMORY_LINES})`);
  ok((baseOwn.memory || []).length === 1, `${CREW_ROOT} carries exactly one memory file (${(baseOwn.memory || []).length})`);
  ok((baseOwn.skills || []).length === 1 && baseOwn.skills[0].name === 'orient-in-a-new-repo',
     `${CREW_ROOT} carries the one shared skill: ${(baseOwn.skills || []).map((s) => s.name).join(', ')}`);
  ok(ownChars(baseOwn) <= BASE_OWN_CHARS, `${CREW_ROOT}'s own briefing text is ${ownChars(baseOwn)} chars (≤ ${BASE_OWN_CHARS})`);

  console.log('\n── every role: the chain, the label, its OWN budget, and the files it lands ──');
  for (const row of roles) {
    const key = row.key;
    const b = bundleOf(row);
    const eff = await H.effectiveHarness(row);
    ok(!!row.label && row.label !== key, `${key}: has a human label ("${row.label}")`);
    ok(eff.chain.join(' → ') === `Zee Base → Dev Base → ${row.label}`, `${key}: chain is ${eff.chain.join(' → ')}`);
    ok(!!b.glyph && !!b.summary, `${key}: has a glyph and a summary for the picker`);

    // ZERO own memory: the shared layer is dev-base's job, and a role that grows one has forked it.
    ok(!(b.memory || []).length, `${key}: carries NO memory of its own (${(b.memory || []).length})`);
    ok(manualIn(eff).length === 1, `${key}: the manual reaches it once, by inheritance`);
    ok(eff.memory.some((m) => /dev-loop/.test(m.path)), `${key}: and dev-base's loop comes with it`);

    const skills = b.skills || [];
    ok(skills.length >= 1 && skills.length <= ROLE_MAX_SKILLS,
       `${key}: ${skills.length} own skill(s) (1–${ROLE_MAX_SKILLS}): ${skills.map((s) => s.name).join(', ')}`);
    ok(ownChars(b) <= ROLE_OWN_CHARS, `${key}: own briefing text is ${ownChars(b)} chars (≤ ${ROLE_OWN_CHARS})`);
    ok(lines(b.personality) <= ROLE_PERSONALITY_LINES,
       `${key}: personality is ${lines(b.personality)} lines (≤ ${ROLE_PERSONALITY_LINES})`);
    for (const s of skills) {
      ok(lines(s.body) <= ROLE_SKILL_BODY_LINES,
         `${key}/${s.name}: skill body is ${lines(s.body)} lines (≤ ${ROLE_SKILL_BODY_LINES})`);
    }

    // …and it materializes into a cxell as real files, generated from the row.
    const files = H.harnessFiles(eff);
    const rels = files.map((f) => f.relPath);
    const want = ['.zeehive/harness/PERSONA.md', '.zeehive/harness/memory/cxell-zee-manual.md',
                  '.zeehive/harness/memory/dev-loop.md',
                  ...(eff.skills || []).map((s) => `.claude/skills/${fileSafe(s.name)}/SKILL.md`)];
    const absent = want.filter((w) => !rels.includes(w));
    ok(!absent.length, `${key}: materializes ${want.length} files, incl. its own skills (missing: ${absent.join(', ') || 'none'})`);
    ok(rels.filter((r) => /cxell-zee-manual/.test(r)).length === 1, `${key}: exactly ONE manual file lands in the workspace`);
    // Every injected file says it is generated and where the source is — a zee that "fixes" one of
    // these edits a file that lands in no diff and is overwritten on the next assignment.
    const unstamped = files.filter((f) => !f.text.includes('GENERATED by ZEEHIVE from the meta-DB'));
    ok(!unstamped.length, `${key}: every generated file carries the provenance banner (${unstamped.map((f) => f.relPath).join(', ') || 'all stamped'})`);
    const manualFile = files.find((f) => /cxell-zee-manual/.test(f.relPath));
    ok(/harness `zee-base`/.test(manualFile?.text || ''),
       `${key}: and the manual's banner names zee-base as its source, not the harness worn`);
  }

  console.log('\n── the read model the console and the pickers use ──');
  const list = await H.listHarnesses({ zeeType: 'worker' });
  const listed = list.filter((h) => crewKeys.includes(h.key));
  ok(listed.length === crew.length,
     `GET /api/harnesses?zee_type=worker offers all ${crew.length} crew harnesses (${listed.length})`);
  const empty = listed.filter((h) => h.bundle_empty);
  ok(!empty.length,
     `none is bundle_empty — every one would brief a zee with something (${empty.map((h) => h.key).join(', ') || 'none'})`);
  ok(listed.every((h) => h.key === CREW_ROOT ? h.parent === 'zee-base' : h.parent === CREW_ROOT),
     'and each reports its parent to the console');
  ok(listed.every((h) => !!h.glyph && !!h.summary), 'each has a glyph and a summary for the picker');
  const asManager = await H.listHarnesses({ zeeType: 'manager' });
  ok(!asManager.some((h) => crewKeys.includes(h.key)), 'a MANAGER picker is never offered a crew harness');
  ok(asManager.some((h) => h.key === LEAD), `while the lead is offered there, and only there`);
} finally {
  await pool.end().catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

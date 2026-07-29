// THE DEV CREW — the project-agnostic role harnesses, and the BUDGETS that keep them affordable.
//
// The crew is `zee-base → dev-base → dev-<role>` for eight roles. What this test defends is not
// that the folders exist but that the shape stays cheap and stays honest, because both decay
// silently:
//
//   1. THE CHAIN. Every role's parent is dev-base, dev-base's parent is zee-base, and parent links
//      come from HARNESS.yml `parent:` at refresh — never from SQL. A role that loses its parent
//      still looks perfectly healthy in the console and briefs its wearer with no manual at all.
//   2. THE MANUAL ARRIVES ONCE, BY INHERITANCE. It lives in the meta-DB on zee-base; no file in
//      this subtree may carry a copy of it, and it must appear EXACTLY once in the merged memory.
//      Two copies is not merely waste — it is two versions of the wearer's own law, one of them
//      stale from the day it was pasted.
//   3. THE BUDGETS. effectiveHarness() merges root → leaf and harnessLayerText() INLINES the
//      personality, every skill body and every memory file into the briefing. So a paragraph added
//      to all eight roles is paid for by every wearer, eight times over, on every dispatch. The
//      rule is therefore structural: shared text lives in dev-base ONCE, and a ROLE carries no
//      memory files at all, a short personality and at most two small skills.
//   4. NO RESTATED VERBS, NO PROJECT LORE. House rule 8 — what a zee is told is versioned like
//      code, and a harness that paraphrases a CLI verb is drift the moment the CLI moves. These
//      personas also work on OTHER repositories, so a Zeehive path or container name in one is a
//      lie to its wearer.
//   5. zee_type = worker for all nine (they land code; a manager never does).
//
// Reads the real harness folders and this xell's real meta-DB, runs the real refreshHarnesses().
// It writes nothing of its own, and restores every harness row it refreshed in a finally.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const H = await import('../server/src/lib/harness.js');
const { q, one, pool } = await import('../server/src/db/pool.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// key → label, exactly as migration 073 seeds them and each HARNESS.yml declares them.
const ROLES = {
  'dev-scout': 'Scout',
  'dev-architect': 'Architect',
  'dev-builder': 'Builder',
  'dev-tester': 'Test Wright',
  'dev-reviewer': 'Reviewer',
  'dev-fixer': 'Fixer',
  'dev-scribe': 'Scribe',
  'dev-shipwright': 'Shipwright',
};
const CREW = ['dev-base', ...Object.keys(ROLES)];

// The budgets. Lines for the FILES a human edits; characters for what actually reaches a briefing.
const ROLE_PERSONALITY_LINES = 40;
const ROLE_SKILL_BODY_LINES = 30;
const ROLE_MAX_SKILLS = 2;
const ROLE_OWN_CHARS = 8000;          // a role's OWN contribution to the briefing
const BASE_PERSONALITY_LINES = 30;
const BASE_MEMORY_LINES = 180;
const BASE_OWN_CHARS = 16000;

const bundleOf = (row) => (typeof row.bundle === 'string' ? JSON.parse(row.bundle) : (row.bundle || {}));
const ownChars = (b) => (b.personality || '').length
  + (b.skills || []).reduce((n, s) => n + String(s.body || '').length, 0)
  + (b.memory || []).reduce((n, m) => n + String(m.text || '').length, 0);
const lines = (t) => String(t).replace(/\n$/, '').split('\n').length;
// A SKILL.md's BODY is what loadHarnessDir keeps — everything after the YAML frontmatter.
const skillBody = (raw) => { const m = raw.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/); return (m ? m[1] : raw).trim(); };

const snapshot = await q(`SELECT id, bundle, bundle_hash, head_commit, avatar_path, label, parent_id, zee_type FROM harness`);

try {
  console.log('\n── migration 073 seeded the crew as file-backed rows ──');
  const seeded = await q(`SELECT key, label, dir, zee_type, enabled FROM harness WHERE key = ANY($1) ORDER BY key`, [CREW]);
  ok(seeded.length === 9, `all 9 crew harnesses are in the meta-DB (found ${seeded.length})`
    + (seeded.length === 9 ? '' : ' — run db/migrations/073_dev_crew.sql'));
  ok(seeded.every((r) => r.dir === `harnesses/${r.key}` && r.enabled),
     'each is enabled and file-backed at harnesses/<key>/');
  ok(seeded.every((r) => r.zee_type === 'worker'),
     `every crew harness is zee_type=worker (${[...new Set(seeded.map((r) => r.zee_type))].join(', ')})`);

  console.log('\n── the folders parse, and declare their own parent + type ──');
  for (const key of CREW) {
    const loaded = H.loadHarnessDir(`harnesses/${key}`);
    ok(!loaded.missing && !!loaded.bundle && loaded.errors.length === 0,
       `${key}: HARNESS.yml parses (${loaded.errors.join('; ') || 'no errors'})`);
    if (!loaded.bundle) continue;
    const want = key === 'dev-base' ? 'zee-base' : 'dev-base';
    ok(loaded.bundle.parent === want, `${key}: declares parent "${want}" in the FILE (got "${loaded.bundle.parent}")`);
    ok(loaded.bundle.zee_type === 'worker', `${key}: declares zee_type worker`);
  }

  console.log('\n── refreshHarnesses() resolves the chain from those files (never from SQL) ──');
  await H.refreshHarnesses();
  const base = await one(`SELECT * FROM harness WHERE key='dev-base'`);
  const zeeBase = await one(`SELECT * FROM harness WHERE key='zee-base'`);
  ok(!!zeeBase, 'zee-base exists (the DB-owned harness that carries the manual)');
  ok(base.parent_id === zeeBase?.id, 'dev-base → zee-base');
  const baseEff = await H.effectiveHarness(base);
  ok(baseEff.chain.join(' → ') === 'Zee Base → Dev Base', `dev-base chain: ${baseEff.chain.join(' → ')}`);

  console.log('\n── the manual is INHERITED, exactly once, and copied nowhere ──');
  const manualIn = (eff) => (eff.memory || []).filter((m) => /cxell-zee-manual/.test(m.path));
  ok(manualIn(baseEff).length === 1 && manualIn(baseEff)[0].text.length > 5000,
     `dev-base inherits ONE copy of the manual (${manualIn(baseEff)[0]?.text.length || 0} chars)`);
  const baseOwn = bundleOf(base);
  ok(!(baseOwn.memory || []).some((m) => /cxell-zee-manual/.test(m.path)),
     'and dev-base does not carry a copy of its own');
  // No file under this subtree may hold the manual, or paraphrase the CLI it documents.
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) files.push(p); } };
  for (const key of CREW) walk(join(ROOT, 'harnesses', key));
  const VERBS = /(^|[^a-z-])zee\s+(status|working|env|build|device|sync|db-catchup|tend|land|ship|hint-land|hint-ship|prod|seed|report|inbox|work|item|done|dispatch|say|suggest-done)\b|--wait\b|--hot\b|--watch\b|--withdraw\b/;
  const restating = files.filter((f) => VERBS.test(readFileSync(f, 'utf8')));
  ok(restating.length === 0,
     `no crew file restates a CLI verb or flag — the manual is referred to, never quoted `
     + `(${restating.map((f) => f.slice(ROOT.length + 1)).join(', ') || 'none'})`);
  // Project lore: these personas are dispatched on OTHER repositories.
  const LORE = /server\/src|db\/migrations|zeehive_[a-z]+_|npm run |queenzee|\.zeehive\.env/;
  const lore = files.filter((f) => !f.endsWith('HARNESS.yml') && LORE.test(readFileSync(f, 'utf8')));
  ok(lore.length === 0,
     `no crew persona names a Zeehive path, container or script `
     + `(${lore.map((f) => f.slice(ROOT.length + 1)).join(', ') || 'none'})`);

  console.log('\n── dev-base is the ONE place shared text lives, and it is bounded ──');
  ok(lines(readFileSync(join(ROOT, 'harnesses/dev-base/PERSONALITY.md'), 'utf8')) <= BASE_PERSONALITY_LINES,
     `dev-base/PERSONALITY.md is ≤ ${BASE_PERSONALITY_LINES} lines `
     + `(${lines(readFileSync(join(ROOT, 'harnesses/dev-base/PERSONALITY.md'), 'utf8'))})`);
  const loop = join(ROOT, 'harnesses/dev-base/memory/dev-loop.md');
  ok(existsSync(loop), 'dev-base carries memory/dev-loop.md — the shared loop, written once');
  ok(lines(readFileSync(loop, 'utf8')) <= BASE_MEMORY_LINES,
     `dev-loop.md is ≤ ${BASE_MEMORY_LINES} lines (${lines(readFileSync(loop, 'utf8'))})`);
  ok((baseOwn.memory || []).length === 1, `dev-base carries exactly one memory file (${(baseOwn.memory || []).length})`);
  ok((baseOwn.skills || []).length === 1 && baseOwn.skills[0].name === 'orient-in-a-new-repo',
     `dev-base carries the one shared skill: ${(baseOwn.skills || []).map((s) => s.name).join(', ')}`);
  ok(ownChars(baseOwn) <= BASE_OWN_CHARS, `dev-base's own briefing text is ${ownChars(baseOwn)} chars (≤ ${BASE_OWN_CHARS})`);

  console.log('\n── every role: the chain, the label, the type, and its OWN budget ──');
  for (const [key, label] of Object.entries(ROLES)) {
    const row = await one(`SELECT * FROM harness WHERE key=$1`, [key]);
    const b = bundleOf(row);
    const eff = await H.effectiveHarness(row);
    ok(row.parent_id === base.id, `${key}: parent resolved to dev-base`);
    ok(eff.chain.join(' → ') === `Zee Base → Dev Base → ${label}`, `${key}: chain is ${eff.chain.join(' → ')}`);
    ok(row.zee_type === 'worker' && row.label === label, `${key}: worker, labelled "${row.label}"`);

    // ZERO own memory: the shared layer is dev-base's job, and a role that grows one has forked it.
    ok(!(b.memory || []).length, `${key}: carries NO memory of its own (${(b.memory || []).length})`);
    ok(manualIn(eff).length === 1, `${key}: the manual reaches it once, by inheritance`);
    ok(eff.memory.some((m) => /dev-loop/.test(m.path)), `${key}: and dev-base's loop comes with it`);

    const skills = b.skills || [];
    ok(skills.length >= 1 && skills.length <= ROLE_MAX_SKILLS,
       `${key}: ${skills.length} own skill(s) (1–${ROLE_MAX_SKILLS}): ${skills.map((s) => s.name).join(', ')}`);
    ok(ownChars(b) <= ROLE_OWN_CHARS, `${key}: own briefing text is ${ownChars(b)} chars (≤ ${ROLE_OWN_CHARS})`);

    const pers = join(ROOT, 'harnesses', key, 'PERSONALITY.md');
    ok(lines(readFileSync(pers, 'utf8')) <= ROLE_PERSONALITY_LINES,
       `${key}: PERSONALITY.md is ${lines(readFileSync(pers, 'utf8'))} lines (≤ ${ROLE_PERSONALITY_LINES})`);
    const skillsDir = join(ROOT, 'harnesses', key, 'skills');
    for (const n of readdirSync(skillsDir).filter((x) => statSync(join(skillsDir, x)).isDirectory())) {
      const body = skillBody(readFileSync(join(skillsDir, n, 'SKILL.md'), 'utf8'));
      ok(lines(body) <= ROLE_SKILL_BODY_LINES, `${key}/${n}: skill body is ${lines(body)} lines (≤ ${ROLE_SKILL_BODY_LINES})`);
    }
  }

  console.log('\n── the read model the console and the pickers use ──');
  const list = await H.listHarnesses({ zeeType: 'worker' });
  const crew = list.filter((h) => CREW.includes(h.key));
  ok(crew.length === 9, `GET /api/harnesses?zee_type=worker offers all 9 (${crew.length})`);
  ok(crew.every((h) => !h.files_missing && !h.bundle_empty),
     'none is files_missing or bundle_empty — every one would brief a zee with something'
     + (crew.some((h) => h.files_missing || h.bundle_empty)
        ? `: ${crew.filter((h) => h.files_missing || h.bundle_empty).map((h) => h.key).join(', ')}` : ''));
  ok(crew.every((h) => h.key === 'dev-base' ? h.parent === 'zee-base' : h.parent === 'dev-base'),
     'and each reports its parent to the console');
  ok(crew.every((h) => !!h.glyph && !!h.summary), 'each has a glyph and a summary for the picker');
  const asManager = await H.listHarnesses({ zeeType: 'manager' });
  ok(!asManager.some((h) => CREW.includes(h.key)), 'a MANAGER picker is never offered a crew harness');

  console.log('\n── and it materializes into a cxell as real files ──');
  const scout = await H.effectiveHarness(await one(`SELECT * FROM harness WHERE key='dev-scout'`));
  const rels = H.harnessFiles(scout).map((f) => f.relPath);
  for (const want of ['.zeehive/harness/PERSONA.md', '.zeehive/harness/memory/cxell-zee-manual.md',
                      '.zeehive/harness/memory/dev-loop.md', '.claude/skills/orient-in-a-new-repo/SKILL.md',
                      '.claude/skills/write-the-spec/SKILL.md']) {
    ok(rels.includes(want), `Scout materializes ${want}`);
  }
  ok(rels.filter((r) => /cxell-zee-manual/.test(r)).length === 1, 'and exactly ONE manual file lands in the workspace');
} finally {
  // The refresh above rewrote real rows from the folders; put every one back as it was found.
  for (const r of snapshot) {
    await q(`UPDATE harness SET bundle=$2, bundle_hash=$3, head_commit=$4, avatar_path=$5, label=$6, parent_id=$7, zee_type=$8 WHERE id=$1`,
      [r.id, JSON.stringify(r.bundle), r.bundle_hash, r.head_commit, r.avatar_path, r.label, r.parent_id, r.zee_type]).catch(() => {});
  }
  await pool.end().catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

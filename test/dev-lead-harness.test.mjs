// DEV-LEAD ("Crew Lead") — the manager harness that runs the dev crew.
//
// A lead adds exactly ONE thing to `manager`: the roster of dev roles and the judgement of which
// role a piece of work needs. Everything else — the manager manual, the dispatch-brief skill, the
// refusals — must arrive by INHERITANCE. The two ways that quietly breaks are what this test is for:
// a COPY of the parent's manual (two manuals, one of which rots), and a harness whose declared type
// drifts off `manager` (a lead is a manager zee; 054 refuses cross-type inheritance and refuses a
// worker xell wearing a manager harness at all).
//
// Since migration 080 the harness is the ROW: there is no harnesses/dev-lead/ folder, so "is it
// copied?" is a question about the bundle rather than about files, and the budget is measured in the
// text that actually reaches a briefing.
//
// It asserts, against the real meta DB:
//   1. the ROW is right — parent resolves to `manager`, zee_type stays `manager`, label/glyph/summary
//      are there and bundle_empty is not set;
//   2. the CHAIN merges root→leaf: the manager manual and dispatch-brief are in the effective persona,
//      byte-identical to the PARENT's row, and are NOT duplicated into dev-lead's own bundle;
//   3. the size budget this harness was written to (persona/skill ≤ 30 lines, memory ≤ 80), measured
//      on the row, and that it adds nothing else;
//   4. the roster keys the skill casts from are the eight real crew keys;
//   5. the DB TYPE GUARD refuses a worker xell wearing it — from both directions.
//
// It creates one throwaway project + xell and deletes them in a finally, whatever happens.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import pg from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.TKB_NOTIFY = '0';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const lines = (rel) => readFileSync(join(ROOT, rel), 'utf8').split('\n').filter((l, i, a) => !(i === a.length - 1 && l === '')).length;
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

const H = await import('../server/src/lib/harness.js');
const { q, one, pool } = await import('../server/src/db/pool.js');

const DIR = 'harnesses/dev-lead';
const PID = '00000000-0000-4000-8000-0000000d1ead';
const XOURCE = '00000000-0000-4000-8000-0000000d1eb0';
const tmp = mkdtempSync(join(tmpdir(), 'devlead-'));

// The crew this lead casts from is DERIVED, by the same structural rule as test/dev-crew.test.mjs:
// a harness is crew if its parent chain reaches dev-base. Pasting the keys here meant a role added
// by migration was outside this check until a human remembered it — and worse, the "invents no role"
// assertion below would then FAIL on a roster that was perfectly correct.
const crewKeys = async () => {
  const rows = await q(`SELECT h.key, p.key AS parent FROM harness h LEFT JOIN harness p ON p.id=h.parent_id`);
  const parentOf = Object.fromEntries(rows.map((r) => [r.key, r.parent]));
  const reaches = (k) => { let c = k, n = 0; while (c && n++ < 32) { if (parentOf[c] === 'dev-base') return true; c = parentOf[c]; } return false; };
  return rows.map((r) => r.key).filter(reaches).sort();
};

async function cleanup({ files = false } = {}) {
  try { await q(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* */ }
  if (files) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } }
}

try {
  await cleanup();

  // ── 1. the ROW is the harness ────────────────────────────────────────────
  console.log('\n── the harness row carries it (no folder, since 080) ──');
  const seeded = await one(`SELECT id FROM harness WHERE key='dev-lead'`);
  ok(!!seeded, 'migration 074 seeded the dev-lead row (run db:migrate first)');
  if (!seeded) throw new Error('dev-lead row missing — apply db/migrations/074_dev_lead.sql');

  const row = await one(
    `SELECT h.*, p.key AS parent_key FROM harness h LEFT JOIN harness p ON p.id=h.parent_id WHERE h.key='dev-lead'`);
  const bundle = typeof row.bundle === 'string' ? JSON.parse(row.bundle) : (row.bundle || {});
  ok(row.parent_key === 'manager', `parent resolves to manager (got ${row.parent_key})`);
  ok(row.zee_type === 'manager', `zee_type stays manager (got ${row.zee_type})`);
  ok(row.label === 'Crew Lead' && !!bundle.glyph && !!bundle.summary, 'label/glyph/summary are on the row');
  ok(row.dir === null, 'and it is DB-owned — no folder can project over it');

  const health = H.harnessHealth({ ...row, skills: bundle.skills, memory: bundle.memory, personality: bundle.personality });
  ok(!health.bundle_empty, `it would not brief a zee with nothing (${JSON.stringify(health)})`);

  const listed = (await H.listHarnesses({ zeeType: 'manager' })).find((h) => h.key === 'dev-lead');
  ok(!!listed && listed.parent === 'manager' && listed.zee_type === 'manager' && !listed.bundle_empty,
     'GET /api/harnesses read model shows it healthy, parent manager, zee_type manager');
  const asWorker = (await H.listHarnesses({ zeeType: 'worker' })).find((h) => h.key === 'dev-lead');
  ok(!asWorker, 'and the worker picker never offers it');

  // ── 2. INHERITED, not copied ─────────────────────────────────────────────
  console.log('\n── the manager manual arrives by inheritance ──');
  const eff = await H.effectiveHarness(row);
  ok(eff.chain.join(' → ') === 'Manager Zee → Crew Lead', `chain merges root→leaf (${eff.chain.join(' → ')})`);

  const manual = (await one(
    `SELECT harness_memory_get('manager','memory/manager-zee-manual.md') AS t`)).t;
  const inherited = (eff.memory || []).find((m) => m.path.endsWith('manager-zee-manual.md'));
  ok(!!inherited && inherited.text === manual, "the effective persona carries the PARENT ROW's manual, byte-identical");
  ok(inherited.from === 'manager', 'stamped with the harness that owns it, so a generated file can name it');
  ok((bundle.memory || []).length === 1 && bundle.memory[0].path.endsWith('dev-role-roster.md'),
     `dev-lead's OWN memory is the roster and nothing else (${(bundle.memory || []).map((m) => m.path).join(', ')})`);

  // a copy is the failure this whole harness is shaped to avoid — look for the parent's text inside
  // dev-lead's OWN bundle, by a sentence only the manager manual has.
  const marker = 'You are a **manager zee**';
  const ownText = [bundle.personality || '', ...(bundle.skills || []).map((s) => s.body || ''),
                   ...(bundle.memory || []).map((m) => m.text || '')].join('\n');
  ok(!ownText.includes(marker), "dev-lead's own bundle does not copy the manager manual");
  ok(!existsSync(join(ROOT, DIR)) || !readdirSync(join(ROOT, DIR)).some((f) => f.endsWith('.md')),
     'and no .md file has come back under harnesses/dev-lead/ (the meta-DB owns the text)');

  const skillNames = (eff.skills || []).map((s) => s.name);
  ok(skillNames.includes('dispatch-brief'), 'dispatch-brief is inherited (not re-authored here)');
  ok(skillNames.includes('pick-the-role'), 'pick-the-role is the skill this harness adds');
  ok((bundle.skills || []).length === 1, `and it is the ONLY skill in this folder (${(bundle.skills || []).length})`);
  ok(!(bundle.skills || []).some((s) => s.name === 'dispatch-brief'), "dispatch-brief is not duplicated into dev-lead's own bundle");

  const text = H.harnessLayerText(eff);
  ok(text.includes('inheriting: Manager Zee'), 'the briefing says what it inherits');
  ok(text.includes(marker) && text.includes('dev-role-roster'),
     'the briefing inlines both the inherited manual and the added roster');

  // ── 3. the size budget, measured on the ROW ──────────────────────────────
  // The budget is what a wearer PAYS for on every dispatch, and since 080 that is the row's text —
  // there is no file left to count lines in, so the same numbers are counted there.
  console.log('\n── size budget ──');
  const lineCount = (t) => String(t || '').split('\n').filter((l, i, a) => !(i === a.length - 1 && l === '')).length;
  const pl = lineCount(bundle.personality);
  const skillBody = (bundle.skills || []).find((s) => s.name === 'pick-the-role')?.body;
  const sl = lineCount(skillBody);
  const ml = lineCount((bundle.memory || [])[0]?.text);
  ok(pl <= 30, `the personality is ${pl} lines (budget 30)`);
  ok(sl <= 30, `the pick-the-role skill body is ${sl} lines (budget 30)`);
  ok(ml <= 80, `the dev-role-roster memory is ${ml} lines (budget 80)`);
  ok((bundle.skills || []).length === 1 && (bundle.memory || []).length === 1,
     `and it adds nothing else: ${(bundle.skills || []).length} skill, ${(bundle.memory || []).length} memory entry`);

  // ── 4. it casts from the REAL crew keys ──────────────────────────────────
  console.log('\n── the roster is the real crew ──');
  const CREW = await crewKeys();
  ok(CREW.length >= 1, `the dev-base subtree has roles to cast (${CREW.join(', ') || 'NONE — 073 not applied?'})`);
  const leafText = (bundle.skills?.[0]?.body || '') + '\n' + (bundle.memory?.[0]?.text || '');
  for (const k of CREW) ok(leafText.includes(k), `the lead knows the role key ${k}`);
  const invented = [...leafText.matchAll(/\bdev-[a-z]+\b/g)].map((m) => m[0])
    .filter((k) => !CREW.includes(k) && k !== 'dev-base');
  ok(!invented.length, `and invents no role that does not exist (${[...new Set(invented)].join(', ') || 'none'})`);

  // ── 5. the DB type guard: a WORKER may not wear it ───────────────────────
  console.log('\n── a worker xell cannot wear a manager harness ──');
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# dev-lead test\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
  await q(`INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
             VALUES ($1,'devlead-test',$2,'master','devleadtest','postgres')`, [PID, repo]);
  await q(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [XOURCE, PID]);
  const worker = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled)
       VALUES ($1,$2,'devlead-w','spinoff/devlead-w',$3,'working',false) RETURNING id, zee_type`,
    [PID, XOURCE, join(tmp, 'wt')]);
  ok(worker.zee_type === 'worker', 'the throwaway xell is a worker');

  ok(!H.harnessFitsType('manager', 'worker'), 'harnessFitsType() says a worker may not wear a manager harness');
  try {
    await q(`UPDATE xell SET harness_id=$2 WHERE id=$1`, [worker.id, row.id]);
    ok(false, 'the DB refuses a worker xell wearing dev-lead');
  } catch (e) {
    ok(/is for manager zees/.test(e.message),
       `the DB refuses a worker xell wearing dev-lead (${e.message.split('\n')[0].slice(0, 80)})`);
  }
  try {
    await H.assignHarness(worker.id, 'dev-lead');
    ok(false, 'assignHarness() refuses it too');
  } catch (e) {
    ok(/manager/.test(e.message), `assignHarness() refuses it too (${e.message.split('\n')[0].slice(0, 80)})`);
  }
  const still = await one(`SELECT harness_id FROM xell WHERE id=$1`, [worker.id]);
  ok(!still.harness_id, 'and the worker is left wearing nothing rather than half-assigned');

  // the other direction: the harness may not be retyped to worker to sneak past the guard
  try {
    await q(`UPDATE harness SET zee_type='worker' WHERE key='dev-lead' AND parent_id IS NOT NULL`);
    const after = await one(`SELECT zee_type FROM harness WHERE key='dev-lead'`);
    ok(false, `retyping dev-lead to worker is refused (it became ${after.zee_type})`);
  } catch (e) {
    ok(/inherit/.test(e.message),
       `retyping dev-lead to worker is refused — it could no longer inherit manager (${e.message.split('\n')[0].slice(0, 80)})`);
  }
} finally {
  await cleanup({ files: true });
  await pool.end();
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall good\n');
process.exit(failures ? 1 : 0);

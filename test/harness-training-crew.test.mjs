// THE HARNESS TRAINING CREW — trainer, teacher, master (migration 138, docs/harness-training-crew.md).
//
// The shape this test defends is the decision record's, and every piece of it decays silently:
//
//   1. THE CHAINS. zee-base → trainer → teacher (workers), manager → master (a manager). A row that
//      loses its parent still looks healthy in the console and briefs its wearer with no manual.
//   2. MANUALS ARRIVE ONCE, BY INHERITANCE. The cxell manual reaches trainer and teacher exactly
//      once from zee-base; the manager manual reaches master exactly once from manager; nobody
//      carries a copy. Two copies is two versions of a wearer's law, one stale.
//   3. THE BUDGETS (dev-lead's numbers): personality ≤ 30 lines, a skill body ≤ 30, a memory file
//      ≤ 80 — measured on the ROW, which is what a wearer pays for on every dispatch.
//   4. THE ROSTER on master names the real worker keys, so the casting layer and the crew move
//      together.
//   5. THE TYPE WALLS hold: a worker xell cannot wear master, and master cannot be re-parented
//      onto teacher — the literal "master inherits teacher" the decision record rejects. If that
//      probe ever passes, 054's guard has been weakened and the decision needs re-examining, not
//      silently accepting.
//
// It creates one throwaway project + xell for the wear-guard probe and deletes them in a finally.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.TKB_NOTIFY = '0';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

const H = await import('../server/src/lib/harness.js');
const { q, one, pool } = await import('../server/src/db/pool.js');

const PID = '00000000-0000-4000-8000-00000138aaaa';
const XOURCE = '00000000-0000-4000-8000-00000138aaab';
const tmp = mkdtempSync(join(tmpdir(), 'traincrew-'));
const lineCount = (t) => String(t || '').split('\n').filter((l, i, a) => !(i === a.length - 1 && l === '')).length;
const bundleOf = (row) => (typeof row.bundle === 'string' ? JSON.parse(row.bundle) : (row.bundle || {}));
const rowOf = (key) => one(
  `SELECT h.*, p.key AS parent_key FROM harness h LEFT JOIN harness p ON p.id=h.parent_id WHERE h.key=$1`, [key]);

async function cleanup({ files = false } = {}) {
  try { await q(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* */ }
  if (files) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } }
}

try {
  await cleanup();

  // ── 1. the rows, their chains, their types ───────────────────────────────
  console.log('\n── the three rows (migration 138) ──');
  const WANT = [
    { key: 'trainer', type: 'worker', parent: 'zee-base', memories: 1, skill: 'improve-a-harness' },
    { key: 'teacher', type: 'worker', parent: 'trainer', memories: 0, skill: 'mint-a-harness' },
    { key: 'master', type: 'manager', parent: 'manager', memories: 1, skill: 'improve-or-create' },
  ];
  const rows = {};
  for (const w of WANT) {
    const row = await rowOf(w.key);
    ok(!!row, `${w.key}: the row exists (run db:migrate — 138 seeds it)`);
    if (!row) throw new Error(`${w.key} missing — apply db/migrations/138_trainer_teacher_master_harnesses.sql`);
    rows[w.key] = row;
    const b = bundleOf(row);
    ok(row.zee_type === w.type, `${w.key}: zee_type is ${w.type} (got ${row.zee_type})`);
    ok(row.parent_key === w.parent, `${w.key}: parent resolves to ${w.parent} (got ${row.parent_key})`);
    ok(row.dir === null, `${w.key}: DB-owned — no folder can project over it`);
    ok(row.enabled === true, `${w.key}: enabled`);
    ok(!!row.label && !!b.glyph && !!b.summary, `${w.key}: label/glyph/summary are on the row`);
    const health = H.harnessHealth({ ...row, skills: b.skills, memory: b.memory, personality: b.personality });
    ok(!health.bundle_empty, `${w.key}: would not brief a zee with nothing`);
    ok((b.skills || []).length === 1 && b.skills[0].name === w.skill,
       `${w.key}: exactly one own skill, ${w.skill} (got ${(b.skills || []).map((s) => s.name).join(', ') || 'none'})`);
    ok((b.memory || []).length === w.memories,
       `${w.key}: carries ${w.memories} own memory file(s) (got ${(b.memory || []).length})`);
  }

  // trainer/teacher are deliberately NOT dev crew: their chain must not reach dev-base, or the
  // crew's craft-not-lore lints would (rightly) fail them — decision record, option 4.
  ok(rows.trainer.parent_key === 'zee-base' && rows.teacher.parent_key === 'trainer',
     'the worker chain roots at zee-base directly — outside the dev-base (dev crew) subtree');

  // ── 2. the pickers offer them to the right type only ─────────────────────
  console.log('\n── pickers ──');
  const workers = (await H.listHarnesses({ zeeType: 'worker' })).map((h) => h.key);
  const managers = (await H.listHarnesses({ zeeType: 'manager' })).map((h) => h.key);
  ok(workers.includes('trainer') && workers.includes('teacher'), 'worker picker offers trainer and teacher');
  ok(!workers.includes('master'), 'and never master');
  ok(managers.includes('master'), 'manager picker offers master');
  ok(!managers.includes('trainer') && !managers.includes('teacher'), 'and never trainer/teacher');

  // ── 3. manuals arrive by inheritance, exactly once, uncopied ─────────────
  console.log('\n── inheritance ──');
  const cxellManual = (await one(`SELECT harness_memory_get('zee-base','cxell-zee-manual.md') AS t`)).t;
  const managerManual = (await one(`SELECT harness_memory_get('manager','memory/manager-zee-manual.md') AS t`)).t;
  ok(!!cxellManual && !!managerManual, 'both parent manuals exist to inherit');

  const effTrainer = await H.effectiveHarness(rows.trainer);
  const effTeacher = await H.effectiveHarness(rows.teacher);
  const effMaster = await H.effectiveHarness(rows.master);
  ok(effTrainer.chain.join(' → ') === 'Zee Base → Trainer', `trainer chain (${effTrainer.chain.join(' → ')})`);
  ok(effTeacher.chain.join(' → ') === 'Zee Base → Trainer → Teacher', `teacher chain (${effTeacher.chain.join(' → ')})`);
  ok(effMaster.chain.join(' → ') === 'Manager Zee → Master', `master chain (${effMaster.chain.join(' → ')})`);

  const manualsIn = (eff, path) => (eff.memory || []).filter((m) => m.path.endsWith(path));
  for (const [name, eff] of [['trainer', effTrainer], ['teacher', effTeacher]]) {
    const found = manualsIn(eff, 'cxell-zee-manual.md');
    ok(found.length === 1 && found[0].text === cxellManual && found[0].from === 'zee-base',
       `${name}: the cxell manual reaches it ONCE, byte-identical, from zee-base`);
  }
  const mm = manualsIn(effMaster, 'manager-zee-manual.md');
  ok(mm.length === 1 && mm[0].text === managerManual && mm[0].from === 'manager',
     'master: the manager manual reaches it ONCE, byte-identical, from manager');

  const trainerManual = manualsIn(effTeacher, 'trainer-manual.md');
  ok(trainerManual.length === 1 && trainerManual[0].from === 'trainer',
     "teacher: inherits the trainer's manual from the trainer row (its own memory stays empty)");

  const ownText = (key) => {
    const b = bundleOf(rows[key]);
    return [b.personality || '', ...(b.skills || []).map((s) => s.body || ''),
            ...(b.memory || []).map((m) => m.text || '')].join('\n');
  };
  ok(!ownText('trainer').includes('You are a **cxell zee**') && !ownText('teacher').includes('You are a **cxell zee**'),
     'neither worker row copies the cxell manual');
  ok(!ownText('teacher').includes('You are the TRAINER'), "teacher's own bundle does not copy the trainer persona");
  ok(!ownText('master').includes('You are a **manager zee**'), "master's own bundle does not copy the manager manual");

  // ── 4. the budgets, measured on the row ──────────────────────────────────
  console.log('\n── budgets (dev-lead numbers: 30/30/80) ──');
  for (const key of ['trainer', 'teacher', 'master']) {
    const b = bundleOf(rows[key]);
    const pl = lineCount(b.personality);
    ok(pl <= 30, `${key}: personality is ${pl} lines (≤ 30)`);
    for (const s of b.skills || []) {
      const sl = lineCount(s.body);
      ok(sl <= 30, `${key}: skill ${s.name} body is ${sl} lines (≤ 30)`);
    }
    for (const m of b.memory || []) {
      const ml = lineCount(m.text);
      ok(ml <= 80, `${key}: memory ${m.path} is ${ml} lines (≤ 80)`);
    }
  }

  // ── 5. master casts from the real keys ───────────────────────────────────
  console.log('\n── the roster is the real crew ──');
  const mb = bundleOf(rows.master);
  const leafText = (mb.skills?.[0]?.body || '') + '\n' + (mb.memory?.[0]?.text || '');
  for (const k of ['trainer', 'teacher']) ok(leafText.includes(`\`${k}\``), `master knows the role key ${k}`);

  // ── 6. the type walls hold ───────────────────────────────────────────────
  console.log('\n── the type walls ──');
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# training crew test\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
  await q(`INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
             VALUES ($1,'traincrew-test',$2,'master','traincrewtest','postgres')`, [PID, repo]);
  await q(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [XOURCE, PID]);
  const worker = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled)
       VALUES ($1,$2,'traincrew-w','spinoff/traincrew-w',$3,'working',false) RETURNING id, zee_type`,
    [PID, XOURCE, join(tmp, 'wt')]);
  ok(worker.zee_type === 'worker', 'the throwaway xell is a worker');

  ok(!H.harnessFitsType('manager', 'worker'), 'harnessFitsType(): a worker may not wear master');
  ok(!H.harnessFitsType('worker', 'manager'), 'harnessFitsType(): a manager may not wear trainer/teacher');
  try {
    await q(`UPDATE xell SET harness_id=$2 WHERE id=$1`, [worker.id, rows.master.id]);
    ok(false, 'the DB refuses a worker xell wearing master');
  } catch (e) {
    ok(/is for manager zees/.test(e.message),
       `the DB refuses a worker xell wearing master (${e.message.split('\n')[0].slice(0, 80)})`);
  }
  ok(H.harnessFitsType('worker', 'worker'), 'and a worker CAN wear trainer/teacher');

  // the decision record's one-way door, proven still shut: master may not inherit teacher.
  try {
    await q(`UPDATE harness SET parent_id=(SELECT id FROM harness WHERE key='teacher') WHERE key='master'`);
    const after = await rowOf('master');
    ok(false, `re-parenting master onto teacher is refused (it became ${after.parent_key})`);
  } catch (e) {
    ok(/may only inherit within its own/.test(e.message),
       `re-parenting master onto teacher is refused by the type guard (${e.message.split('\n')[0].slice(0, 80)})`);
  }
  // and the mirror: trainer cannot be retyped manager while parented on zee-base.
  try {
    await q(`UPDATE harness SET zee_type='manager' WHERE key='trainer'`);
    const after = await rowOf('trainer');
    ok(false, `retyping trainer to manager is refused (it became ${after.zee_type})`);
  } catch (e) {
    ok(/may only inherit within its own/.test(e.message),
       `retyping trainer to manager is refused — it could no longer inherit zee-base (${e.message.split('\n')[0].slice(0, 80)})`);
  }
} finally {
  await cleanup({ files: true });
  await pool.end();
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall good\n');
process.exit(failures ? 1 : 0);

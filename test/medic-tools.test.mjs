// THE MEDIC TOOL REGISTRY'S WALLS (lib/medic-tools.js, docs/medic-meta-plane-plan.md §4, DR-7/DR-8)
// — against a REAL postgres (DATABASE_URL; `zee db-sandbox --migrate` in a cage).
//
// Covered here:
//   1. the two registries are DISJOINT — no medic tool name resolves in LANGCHAIN_TOOLS and vice
//      versa (a zee loop must never be able to name a medic verb), and runMedicTool refuses a name
//      off the allowlist with a visible message;
//   2. the source window's path guard — a `../` escape and a SYMLINK escape are both refusal
//      RESULTS (never a read, never a throw), and no write/exec sibling exists in the registry;
//   3. meta_write audits BEFORE it runs — a write postgres REFUSES (UPDATE xell) still leaves its
//      medic_action row, marked refused; an accepted write's row carries the rows affected; the
//      interior-semicolon stacking refusal;
//   4. dispatch_worker refuses a project that is not the orchestrator's own, with the scope wall
//      named;
//   5. need_human is flagged endsTurn (the loop's turn-ends-on-ask reads the registry, not a
//      hardcoded verb list) and requires a reason; report refuses the driver-owned statuses.
//
// Fixture rows are removed in a finally, whatever happens. The symlink fixture lives in the REPO
// ROOT for the duration of one assertion only (the guard's root IS config.repoRoot, so an escape
// must be planted inside it) and is unlinked in the same finally.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.MEDICRW_MODE = 'real';   // the sandbox is throwaway; the ambient SHIP_MODE=simulate must not no-op the SQL half

const { MEDIC_TOOLS, runMedicTool, singleStatement, guardedSourcePath } =
  await import('../server/src/lib/medic-tools.js');
const { LANGCHAIN_TOOLS } = await import('../server/src/lib/langchain-tools.js');
const { pool, q, one } = await import('../server/src/db/pool.js');
const { config } = await import('../server/src/config.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const cleanups = [];

try {
  console.log('\n── 1. registries disjoint + allowlist refusal ──');
  const medicNames = Object.keys(MEDIC_TOOLS);
  const zeeNames = Object.keys(LANGCHAIN_TOOLS);
  const overlap = medicNames.filter((n) => zeeNames.includes(n));
  ok(overlap.length === 0, `no shared verb name (overlap: ${overlap.join(', ') || 'none'})`);
  ok(medicNames.every((n) => MEDIC_TOOLS[n].name === n), 'every entry is keyed by its own name');
  const refusedName = JSON.parse(await runMedicTool({ id: 'x' }, { name: 'status', args: {} }));
  ok(refusedName.ok === false && /not a medic tool/.test(refusedName.error),
    'a ZEE verb name is refused by the medic dispatch path, visibly');
  const workspaceish = ['bash', 'run_bash', 'write_file', 'file_write', 'exec', 'docker', 'git_commit', 'source_write'];
  ok(workspaceish.every((n) => !MEDIC_TOOLS[n]), 'no workspace-action tool exists (absence is the wall)');

  console.log('\n── 2. the source window ──');
  const dotdot = guardedSourcePath('../../../etc/passwd');
  ok(!!dotdot.error, 'a ../ escape is a refusal result');
  const repoRoot = fs.realpathSync(path.resolve(config.repoRoot));
  const linkPath = path.join(repoRoot, 'tmp-medic-test-escape-link');
  try { fs.unlinkSync(linkPath); } catch { /* stale from a killed run */ }
  fs.symlinkSync('/etc', linkPath);
  cleanups.push(() => { try { fs.unlinkSync(linkPath); } catch { /* gone */ } });
  const viaLink = guardedSourcePath('tmp-medic-test-escape-link/passwd');
  ok(!!viaLink.error, 'a SYMLINK escape is a refusal result (realpath before containment)');
  const inside = guardedSourcePath('package.json');
  ok(!inside.error, 'a real in-tree path resolves');

  console.log('\n── 3. meta_write: audit-first, one statement, postgres as the wall ──');
  const proj = await one(`INSERT INTO project (name, repo_root) VALUES ('medic-tools-test-proj', '/tmp/none') RETURNING id`);
  cleanups.push(() => q(`DELETE FROM project WHERE id=$1`, [proj.id]));
  const medic = await one(`INSERT INTO medic (target_project_id, brief) VALUES ($1, 'test') RETURNING *`, [proj.id]);
  cleanups.push(() => q(`DELETE FROM medic WHERE id=$1`, [medic.id]));
  cleanups.push(() => q(`DELETE FROM medic_action WHERE medic_id=$1`, [medic.id]));

  ok(!!singleStatement('UPDATE machine SET enabled=true; DROP TABLE machine').error,
    'an interior semicolon (a stacked second statement) is refused');

  const refusedWrite = JSON.parse(await runMedicTool(medic, {
    name: 'meta_write', args: { sql: `UPDATE xell SET status=status WHERE false` } }));
  ok(refusedWrite.refused === true && /postgres refused/.test(refusedWrite.reason),
    'UPDATE xell comes back as a REFUSAL result (the role, speaking)');
  const refusedRow = await one(
    `SELECT * FROM medic_action WHERE medic_id=$1 AND tool='meta_write' ORDER BY created_at DESC LIMIT 1`, [medic.id]);
  ok(!!refusedRow && /UPDATE xell/.test(refusedRow.statement) && refusedRow.result?.refused === true,
    'the REFUSED write still left its audit row, marked refused (audited before it ran)');

  const okWrite = JSON.parse(await runMedicTool(medic, {
    name: 'meta_write', args: { sql: `UPDATE project_condition SET body=body WHERE false` } }));
  ok(okWrite.ok === true && okWrite.rowCount === 0, 'a config-surface write runs on the medic role');
  const okRow = await one(
    `SELECT * FROM medic_action WHERE medic_id=$1 AND tool='meta_write' ORDER BY created_at DESC LIMIT 1`, [medic.id]);
  ok(okRow.rows_affected === 0 && okRow.result?.ok === true, 'its audit row carries the rows affected');

  const sel = JSON.parse(await runMedicTool(medic, {
    name: 'meta_select', args: { sql: `SELECT name FROM project WHERE id='${proj.id}'` } }));
  ok(sel.ok === true && sel.rows?.[0]?.name === 'medic-tools-test-proj', 'meta_select reads');
  const selWrite = JSON.parse(await runMedicTool(medic, {
    name: 'meta_select', args: { sql: `UPDATE project_condition SET body=body WHERE false` } }));
  ok(selWrite.refused === true, 'meta_select refuses a write shape (use meta_write, which audits)');

  console.log('\n── 4. dispatch_worker: the scope wall ──');
  // Seed the well-known self project so selfProjectId RESOLVES and the test proves the actual
  // refusal, not the resolver's legible failure on a bare sandbox.
  const zeehive = await one(`SELECT id FROM project WHERE lower(name)='zeehive'`)
    || await one(`INSERT INTO project (name, repo_root) VALUES ('Zeehive', '/tmp/none') RETURNING id`);
  cleanups.push(() => q(`DELETE FROM project WHERE id=$1 AND name='Zeehive' AND repo_root='/tmp/none'`, [zeehive.id]));
  const other = await one(`INSERT INTO project (name, repo_root) VALUES ('medic-tools-other-proj', '/tmp/none') RETURNING id`);
  cleanups.push(() => q(`DELETE FROM project WHERE id=$1`, [other.id]));
  const wrongTarget = JSON.parse(await runMedicTool(medic, {
    name: 'dispatch_worker', args: { title: 'x', task: 'y', project: 'medic-tools-other-proj' } }));
  ok(wrongTarget.refused === true && /ZEEHIVE workers only/.test(wrongTarget.reason),
    'a non-orchestrator project is refused with the scope wall named');

  console.log('\n── 5. the ask + the report guard ──');
  ok(MEDIC_TOOLS.need_human.endsTurn === true,
    'need_human is flagged endsTurn — the loop reads the registry, not a verb-name list');
  const noReason = JSON.parse(await runMedicTool(medic, { name: 'need_human', args: {} }));
  ok(noReason.refused === true, 'need_human without a reason is refused (the reason IS the message)');
  const badStatus = JSON.parse(await runMedicTool(medic, { name: 'report', args: { message: 'x', status: 'retired' } }));
  ok(badStatus.refused === true, 'report cannot set retired/errored (humans and the driver own those)');
  const asked = JSON.parse(await runMedicTool(medic, { name: 'need_human', args: { reason: 'test ask' } }));
  ok(asked.ok === true, 'need_human with a reason works');
  const row = await one(`SELECT status, needs_human_reason FROM medic WHERE id=$1`, [medic.id]);
  ok(row.status === 'awaiting-human' && row.needs_human_reason === 'test ask',
    'it set awaiting-human + the one-line reason (what the Bay renders)');
} finally {
  for (const c of cleanups.reverse()) { try { await c(); } catch { /* teardown is best-effort */ } }
  const { medicDbPool } = await import('../server/src/lib/medic-role.js');
  await medicDbPool().then((p) => p.end()).catch(() => {});
  await pool.end();
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);

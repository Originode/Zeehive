// Ticket #173: a failed build must say WHY — persist last_build_error on the container row
// and surface it through getBuildStatus (what `zee build --wait` polls).
//
// THE DEFECT: lib/build.js finalized a failed build with health='down' and one logline carrying
// only the LAST stderr line, into a 300-line ring buffer. The container row kept last_build_commit
// / last_built_at / hot_build and NO error. A caged zee that saw building → down got
// "the build FAILED. Check the queenzee terminal" and nothing retrievable.
//
// Covered here (against a real postgres — DATABASE_URL — so the new column from migration 210
// is present; no docker):
//   • formatBuildFailure keeps a useful tail and falls back when empty
//   • a failed finalize UPDATE leaves last_build_error on the row
//   • a successful finalize CLEARS last_build_error
//   • starting a build (health='building') clears a prior failure
//   • getBuildStatus returns last_build_error on the container payload
//   • the --wait report order prefers last_build_error over published_health=down
//     (a failed build sets both; without this order the zee only saw "port refused")
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { q, one, pool } = await import('../server/src/db/pool.js');
const { formatBuildFailure, getBuildStatus } = await import('../server/src/lib/build.js');

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, 'a');
const tmp = mkdtempSync(join(tmpdir(), `lbe-${tag}-`));
const created = { projects: [], xells: [], containers: [] };

try {
  console.log('\n── 1. formatBuildFailure contract ──');
  ok(formatBuildFailure('') === 'see docker output', 'empty → fallback');
  ok(formatBuildFailure(null, 'see .zeehive log') === 'see .zeehive log', 'null → custom fallback');
  ok(formatBuildFailure('  boom  ') === 'boom', 'trims whitespace');
  const long = 'x'.repeat(2000) + '\nREAL_CAUSE: compose file not found';
  const fmt = formatBuildFailure(long);
  ok(fmt.length === 1500, `long stderr capped at 1500 (got ${fmt.length})`);
  ok(fmt.endsWith('REAL_CAUSE: compose file not found'), 'cap keeps the TAIL (the useful end)');

  console.log('\n── 2. fixtures: project + xell + buildable container ──');
  // getBuildStatus reads worktree HEAD via git — give it a real temp git repo.
  const { spawnSync } = await import('node:child_process');
  spawnSync('git', ['init'], { cwd: tmp, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'test@zeehive'], { cwd: tmp });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: tmp });
  writeFileSync(join(tmp, 'README'), 'lbe');
  spawnSync('git', ['add', '.'], { cwd: tmp });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: tmp });

  const proj = await one(
    `INSERT INTO project (name, repo_root, main_branch, db_user, db_name)
     VALUES ($1, $2, 'main', 'zeehive', 'zeehive') RETURNING id`,
    [`lbe_${tag}`, tmp]);
  created.projects.push(proj.id);

  const xource = await one(
    `INSERT INTO xource (project_id, ref) VALUES ($1, 'main') RETURNING id`,
    [proj.id]);
  created.xources = [xource.id];

  const xell = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled)
     VALUES ($1, $2, $3, $4, $5, 'claimed', false) RETURNING id`,
    [proj.id, xource.id, `lbe-${tag}`, `spinoff/lbe-${tag}`, tmp]);
  created.xells.push(xell.id);

  // isolation='per-xell' is required whenever owner_xell_id is set (CHECK on container).
  const c = await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, health, owner_xell_id, image_tag, docker_ctx)
     VALUES ($1, 'server', 'spinoff', 'per-xell', $2, 'down', $3, 'zeehive-spin-server:x', 'default')
     RETURNING id, name`,
    [proj.id, `lbe_srv_${tag}`, xell.id]);
  created.containers.push(c.id);
  ok(!!c.id, `fixture container ${c.name}`);

  // Column must exist (migration 210). Fail loudly if the test DB was not migrated.
  const col = await one(
    `SELECT 1 AS ok FROM information_schema.columns
      WHERE table_name='container' AND column_name='last_build_error'`);
  ok(!!col, 'container.last_build_error column exists (migration 210 applied)');

  console.log('\n── 3. failed finalize persists the reason ──');
  const reason = 'compose file not found: docker-compose.spinoff.yml\nerror: network zeehive not found';
  const failed = await one(
    `UPDATE container
        SET health = 'down'::container_health, hot_build = false,
            last_build_commit = COALESCE($2, last_build_commit),
            last_built_at = CASE WHEN false THEN now() ELSE last_built_at END,
            last_build_error = $3
      WHERE id=$1 RETURNING *`,
    [c.id, null, formatBuildFailure(reason)]);
  ok(failed.health === 'down', 'failed finalize → health=down');
  ok(failed.last_build_error.includes('network zeehive not found'),
     'failed finalize → last_build_error keeps the stderr tail');
  ok(failed.last_built_at == null, 'failed finalize does NOT stamp last_built_at');

  console.log('\n── 4. getBuildStatus returns last_build_error ──');
  // Avoid the live published-port probe hanging on a fake host: leave host/url null so the probe
  // has nothing to dial (probePublishedRole returns null/down quickly on missing url).
  const st = await getBuildStatus(xell.id);
  const row = st.containers.find((x) => x.id === c.id);
  ok(!!row, 'getBuildStatus lists the fixture container');
  ok(row?.last_build_error?.includes('network zeehive not found'),
     'getBuildStatus.containers[].last_build_error carries the persisted reason');

  console.log('\n── 5. starting a build clears a prior failure ──');
  const building = await one(
    `UPDATE container SET health='building', last_build_error=NULL WHERE id=$1 RETURNING *`,
    [c.id]);
  ok(building.health === 'building', 'build start → health=building');
  ok(building.last_build_error == null, 'build start clears last_build_error');

  console.log('\n── 6. successful finalize clears the error and stamps the commit ──');
  // Re-seed a failure, then succeed — proves success overwrites, not just start-clear.
  await one(`UPDATE container SET last_build_error='stale failure' WHERE id=$1`, [c.id]);
  const head = 'abcdef12';
  const succeeded = await one(
    `UPDATE container
        SET health = 'up'::container_health, hot_build = false,
            last_build_commit = COALESCE($2, last_build_commit),
            last_built_at = CASE WHEN true THEN now() ELSE last_built_at END,
            last_build_error = $3
      WHERE id=$1 RETURNING *`,
    [c.id, head, null]);
  ok(succeeded.health === 'up', 'success → health=up');
  ok(succeeded.last_build_error == null, 'success clears last_build_error');
  ok(succeeded.last_build_commit === head, 'success records last_build_commit');
  ok(!!succeeded.last_built_at, 'success stamps last_built_at');

  console.log('\n── 7. --wait report order: last_build_error beats published_health=down ──');
  // Mirrors the branch order in scripts/zee pollBuild / scripts/xell-build.mjs waitForBuild.
  // A failed finalize leaves health=down AND the published probe also reads down; without
  // preferring last_build_error the zee only ever saw "port refused".
  const pickBranch = (c2) => {
    if (c2.health === 'up' && c2.serving_head) return 'serving';
    if (c2.last_build_error) return 'build-error';
    if (c2.published_health === 'down') return 'published-down';
    if (c2.health === 'up') return 'up-stale';
    return 'failed-no-reason';
  };
  ok(pickBranch({
    health: 'down', published_health: 'down', last_build_error: 'compose missing', serving_head: false,
  }) === 'build-error',
     'when both fail signals are set, --wait takes the persisted build error');
  ok(pickBranch({
    health: 'down', published_health: 'down', last_build_error: null, serving_head: false,
  }) === 'published-down',
     'without a persisted reason, --wait still reports published-port refusal (TKT-136)');
  ok(pickBranch({
    health: 'up', published_health: 'up', last_build_error: null, serving_head: true,
  }) === 'serving',
     'healthy path unchanged');

} finally {
  for (const id of created.containers) await q(`DELETE FROM container WHERE id=$1`, [id]).catch(() => {});
  for (const id of created.xells) await q(`DELETE FROM xell WHERE id=$1`, [id]).catch(() => {});
  for (const id of created.projects) await q(`DELETE FROM project WHERE id=$1`, [id]).catch(() => {});
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  await pool.end().catch(() => {});
}

console.log(fail ? `\n✗ ${fail} failure(s)` : '\n✓ all passed');
process.exit(fail ? 1 : 0);

// POOL DEFAULT-HARNESS test — the contract of "allow setting harness as default": a project's spawn
// template can name the harness a BARE dispatch attaches (pool_config.default_harness_id), the same
// way it already names a default runtime and db coupling. intake reads that column when --harness is
// omitted and the pooled xell carries none, so this is what makes "every new xell wears Scribe by
// default" real. It runs the REAL lib/projects.js against this xell's isolated postgres — no mocks.
import { randomUUID } from 'node:crypto';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { getPoolConfig, updatePoolConfig } = await import('../server/src/lib/projects.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
const hkey = `zt-harn-${tag}`;                // a non-core harness fixture (UNIQUE)
let projId, harnId;

try {
  projId = (await one(`INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`,
    [`zt-dh-${tag}`, `/tmp/zt-dh-${tag}`])).id;
  await q(`INSERT INTO pool_config (project_id) VALUES ($1)`, [projId]);
  harnId = (await one(
    `INSERT INTO harness (key, label, enabled, is_law_core) VALUES ($1,$2,true,false) RETURNING id`,
    [hkey, `ZT Harness ${tag}`])).id;

  console.log('\n── a bare project has no default harness ──');
  ok((await getPoolConfig(projId)).default_harness_id === null, 'default_harness_id starts NULL (core only)');
  ok((await getPoolConfig(projId)).harness_key === null, 'getPoolConfig exposes harness_key = null when unset');

  console.log('\n── setting a default harness by key ──');
  await updatePoolConfig(projId, { default_harness_key: hkey });
  let pc = await getPoolConfig(projId);
  ok(pc.default_harness_id === harnId, 'default_harness_id now points at the chosen harness');
  ok(pc.harness_key === hkey, 'getPoolConfig exposes the harness key (for the UI to preselect)');
  ok(pc.harness_label === `ZT Harness ${tag}`, 'getPoolConfig exposes the harness label too');

  console.log('\n── clearing back to core-only ──');
  await updatePoolConfig(projId, { default_harness_key: '' });
  ok((await getPoolConfig(projId)).default_harness_id === null, "'' clears the default back to core-only");
  await updatePoolConfig(projId, { default_harness_key: hkey });   // set again to test 'none'
  await updatePoolConfig(projId, { default_harness_key: 'none' });
  ok((await getPoolConfig(projId)).default_harness_id === null, "'none' also clears the default");

  console.log('\n── guards ──');
  let threw = false;
  try { await updatePoolConfig(projId, { default_harness_key: `no-such-${tag}` }); } catch { threw = true; }
  ok(threw, 'an unknown harness key is REFUSED (not silently ignored)');
  threw = false;
  try { await updatePoolConfig(projId, { default_harness_key: 'core' }); } catch { threw = true; }
  ok(threw, 'the core (law) harness cannot be a selectable default — every xell already gets it');

  console.log('\n── it does not disturb the sibling defaults ──');
  await updatePoolConfig(projId, { default_harness_key: hkey, target_ready: 2 });
  pc = await getPoolConfig(projId);
  ok(pc.default_harness_id === harnId && pc.target_ready === 2,
     'harness default and another pool field patch together in one call');
} finally {
  if (projId) await q(`DELETE FROM pool_config WHERE project_id=$1`, [projId]).catch(() => {});
  if (projId) await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  if (harnId) await q(`DELETE FROM harness WHERE id=$1`, [harnId]).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);

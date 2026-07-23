// DB RESOLVER — end-to-end against a fake `docker` and this xell's REAL database.
//
// Proves the shipped resolveRealDbContainer / resolveRealDbContainerCached and shipmigrate's new
// assertProdDbTarget behave correctly over the real registry (container rows) with docker faked on
// PATH. Complements db-resolver-registry.test.mjs (pure logic) with the full I/O path.
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const ctx = `ztctx-${tag}`;
const LOGICAL = `zt${tag}_db_prod`;
const REAL    = `zt${tag}_db_prod_v184`;
const CLONE   = `zt${tag}_db_prod_dev_local_x`;

// ── fake docker on PATH (state file the shim reads fresh each call) ──────────────────────────────
const bin = mkdtempSync(join(tmpdir(), `zt-bin-${tag}-`));
const stateFile = join(bin, 'state.json');
const setState = (s) => writeFileSync(stateFile, JSON.stringify(s));
const shim = join(bin, 'fake-docker.mjs');
writeFileSync(shim, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const a = process.argv.slice(2);
const st = JSON.parse(readFileSync(process.env.FAKE_DOCKER_STATE, 'utf8'));
if (a.includes('ps')) { process.stdout.write((st.ps||[]).map(c=>c.name+'\\t'+(c.ports||'')).join('\\n')+'\\n'); process.exit(0); }
if (a.includes('inspect')) { const n=a[a.length-1]; const p=(st.inspect||{})[n];
  if (p===undefined){process.stderr.write('No such object: '+n+'\\n');process.exit(1);} process.stdout.write(JSON.stringify(p)+'\\n'); process.exit(0); }
process.exit(0);
`);
writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash\nexec node "${shim}" "$@"\n`);
chmodSync(join(bin, 'docker'), 0o755);
process.env.FAKE_DOCKER_STATE = stateFile;
process.env.PATH = `${bin}:${process.env.PATH}`;

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { q, one, pool } = await import('../server/src/db/pool.js');
const { resolveRealDbContainer, resolveRealDbContainerCached } = await import('../server/src/lib/xell-db.js');
const { assertProdDbTarget, applyMigrations } = await import('../server/src/queenzee/shipmigrate.js');

// ── seed: project + prod row (logical name, port 5432) + clone row (its OWN tier=dev row) ─────────
const projectId = (await one(
  `INSERT INTO project (name, repo_root, db_user, db_name) VALUES ($1,$2,'omnibiz','omnibiz') RETURNING id`,
  [`zt-resolver-${tag}`, process.cwd()])).id;
const prodRow = await one(
  `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, host_port, internal_port)
   VALUES ($1,'db','prod','shared',$2,$3,5432,5432) RETURNING *`, [projectId, LOGICAL, ctx]);
await one(
  `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, host_port, internal_port)
   VALUES ($1,'db','dev','shared',$2,$3,32768,5432) RETURNING id`, [projectId, CLONE, ctx]);

try {
  // ── 1. resolveRealDbContainer picks the REAL prod, not the clone ────────────────────────────────
  // docker ps lists the clone FIRST (newest) — the exact ordering the old resolver tripped on.
  setState({ ps: [
    { name: CLONE, ports: '0.0.0.0:32768->5432/tcp' },
    { name: REAL,  ports: '0.0.0.0:5432->5432/tcp' },
  ] });
  console.log('resolveRealDbContainer (registry identity, docker faked)');
  let r = await resolveRealDbContainer(ctx, LOGICAL);            // no row → internal registry lookup
  ok(r === REAL, `resolves ${LOGICAL} → ${REAL} (real prod), clone ignored [${r}]`);
  r = await resolveRealDbContainer(ctx, LOGICAL, { row: prodRow });
  ok(r === REAL, 'same when the row is passed in');

  // ── 2. Cached hot-path answers WITHOUT blocking on a cold miss ──────────────────────────────────
  console.log('resolveRealDbContainerCached: cold miss is non-blocking');
  const t0 = Date.now();
  const cold = resolveRealDbContainerCached(ctx, LOGICAL);
  const dt = Date.now() - t0;
  ok(dt < 50, `cold miss returned in ${dt}ms (no blocking docker ps on the hot path)`);
  ok(cold === LOGICAL, `cold miss serves the logical name (${cold}) — guard-tolerated`);
  // background refresh should sharpen it to the real name shortly
  let sharpened = LOGICAL;
  for (let i = 0; i < 40 && sharpened !== REAL; i++) { await sleep(50); sharpened = resolveRealDbContainerCached(ctx, LOGICAL); }
  ok(sharpened === REAL, `background refresh sharpened the cache to ${REAL}`);

  // ── 3. ambiguity → refusal ──────────────────────────────────────────────────────────────────────
  console.log('ambiguity → throw (refuse to guess)');
  setState({ ps: [
    { name: REAL,             ports: '0.0.0.0:5432->5432/tcp' },
    { name: `${LOGICAL}_v185`, ports: '0.0.0.0:5432->5432/tcp' },   // two unregistered, both :5432
  ] });
  let threw = false;
  try { await resolveRealDbContainer(ctx, LOGICAL, { row: prodRow }); }
  catch (e) { threw = /Refusing to guess|candidates/.test(e.message); }
  ok(threw, 'two containers publish :5432 and neither is registered → throws, not a coin flip');

  // ── 4. assertProdDbTarget ───────────────────────────────────────────────────────────────────────
  console.log('shipmigrate assertProdDbTarget');
  const dbHandle = { ctx, container: REAL, tier: 'prod', host_port: 5432 };
  setState({ inspect: { [REAL]: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '5432' }] } } });
  ok((await assertProdDbTarget(dbHandle)).ok === true, 'passes when the container publishes the row port (5432)');

  setState({ inspect: { [REAL]: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '32768' }] } } });
  let a = await assertProdDbTarget(dbHandle);
  ok(a.ok === false && /NOT the registry's production database/.test(a.error), 'ABORTS when the port does not match (this was the clone)');

  a = await assertProdDbTarget({ ...dbHandle, tier: 'dev' });
  ok(a.ok === false && /tier='dev'/.test(a.error), 'ABORTS when the selected row is not tier=prod');

  // ── 5. applyMigrations aborts BEFORE writing when the target is not prod ─────────────────────────
  console.log('applyMigrations: aborts before any write on a mismatched target');
  const project = await one(`SELECT * FROM project WHERE id=$1`, [projectId]);
  setState({
    ps: [{ name: REAL, ports: '0.0.0.0:5432->5432/tcp' }],            // resolve LOGICAL → REAL
    inspect: { [REAL]: { '5432/tcp': [{ HostPort: '32768' }] } },     // …but REAL publishes the CLONE port
  });
  const res = await applyMigrations(project, 'HEAD');
  ok(res.ok === false && res.applied.length === 0 && /NOT the registry's production database/.test(res.error),
     'refuses and applies NOTHING when it cannot prove the target is prod');

  console.log(failures ? `\n${failures} INTEGRATION check(s) FAILED` : '\nall INTEGRATION checks passed');
} finally {
  await q(`DELETE FROM container WHERE project_id=$1`, [projectId]);
  await q(`DELETE FROM project WHERE id=$1`, [projectId]);
  await pool.end();
}
process.exitCode = failures ? 1 : 0;

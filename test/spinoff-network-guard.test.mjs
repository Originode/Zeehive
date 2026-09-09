// SPINOFF → PROD-NETWORK GUARD — the enforcement behind the 2026-08-25/26 outage
// (spinoff webapp on the prod docker network shadowing Caddy's `webapp` DNS).
//
// Pure module tests (no db, no docker) plus one buildContainer integration against
// DATABASE_URL when present (skipped cleanly otherwise — use `zee db-sandbox --migrate`).
//
// Covered:
//   1. attachedExternalNetworks only counts EXTERNAL nets a service actually lists
//   2. renamed external ({ external: { name } }) resolves to the real docker name
//   3. prodNetworkNames unions manifest requires + prod-compose externals
//   4. a forbidden attach is REFUSED with an actionable error naming the network
//   5. a clean spinoff (no external nets / non-overlapping) is allowed
//   6. Zeehive's generated compose (no networks key) is allowed
//   7. buildContainer refuses before flipping health to 'building' (when DATABASE_URL set)
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {
  attachedExternalNetworks,
  declaredExternalNetworks,
  prodNetworkNames,
  checkSpinoffProdNetworkAttach,
  assertSpinoffNotOnProdNetworks,
  externalNetworkActualName,
} = await import('../server/src/lib/spinoff-network-guard.js');
const { parse } = await import('yaml');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

console.log('\n── 1. externalNetworkActualName ──');
ok(externalNetworkActualName('foo', { external: true }) === 'foo', 'external:true → key name');
ok(externalNetworkActualName('foo', { external: { name: 'real-net' } }) === 'real-net',
   'external:{name} → renamed actual');
ok(externalNetworkActualName('foo', {}) === null, 'non-external → null');
ok(externalNetworkActualName('foo', null) === null, 'missing decl → null');

console.log('\n── 2. attachedExternalNetworks — only EXTERNAL + attached ──');
{
  const doc = parse(`
networks:
  localnet:
  prodnet:
    external: true
  renamed:
    external: { name: omnibiz_omnibiz-net }
services:
  webapp:
    image: x
    networks: [prodnet, renamed]
  server:
    image: x
    networks: [localnet]
  idle:
    image: x
`);
  const attached = attachedExternalNetworks(doc);
  ok(attached.has('prodnet'), 'attached external listed');
  ok(attached.has('omnibiz_omnibiz-net'), 'renamed external resolves to actual docker name');
  ok(!attached.has('localnet'), 'project-local network is NOT treated as external');
  ok(!attached.has('renamed'), 'the compose key is not the docker name when renamed');
  const declared = declaredExternalNetworks(doc);
  ok(declared.has('prodnet') && declared.has('omnibiz_omnibiz-net'),
     'declaredExternalNetworks includes every external, attached or not');
}

console.log('\n── 3. prodNetworkNames — requires ∪ prod-compose externals ──');
{
  const manifest = {
    tiers: {
      prod: { requires: { networks: ['from-manifest', { name: 'also-manifest' }], volumes: ['vol'] } },
    },
  };
  const prodDoc = parse(`
networks:
  from-compose:
    external: true
  also-manifest:
    external: true
services:
  caddy: { image: caddy, networks: [from-compose] }
`);
  const names = prodNetworkNames(manifest, prodDoc);
  ok(names.has('from-manifest') && names.has('also-manifest'), 'manifest requires.networks are forbidden');
  ok(names.has('from-compose'), 'prod-compose external networks are forbidden even when requires omits them');
  ok(!names.has('vol'), 'volumes are not networks');
}

console.log('\n── 4. the incident shape is REFUSED ──');
{
  // OmniBiz-shaped: prod compose uses omnibiz_omnibiz-net; spinoff attaches the same.
  // Seeded OmniBiz prod.requires lists volumes only — so the compose parse is load-bearing.
  const spin = `
networks:
  omnibiz_omnibiz-net:
    external: true
services:
  webapp:
    image: omnibiz-spin-webapp:x
    networks: [omnibiz_omnibiz-net]
  server:
    image: omnibiz-spin-server:x
    networks: [omnibiz_omnibiz-net]
`;
  const prod = `
networks:
  omnibiz_omnibiz-net:
    external: true
services:
  webapp: { image: omnibiz-web, networks: [omnibiz_omnibiz-net] }
  caddy:  { image: caddy, networks: [omnibiz_omnibiz-net] }
`;
  const r = checkSpinoffProdNetworkAttach({
    spinComposeYaml: spin,
    prodComposeYaml: prod,
    manifest: { tiers: { prod: { requires: { volumes: ['postgres_data_prod'] } } } },
  });
  ok(!r.ok, 'incident-shaped attach is refused');
  ok(r.overlap?.includes('omnibiz_omnibiz-net'), `overlap names the network [${r.overlap}]`);
  ok(/refusing to bring up spinoff/.test(r.error || ''), 'error leads with the refusal');
  ok(/2026-08-25/.test(r.error || ''), 'error cites the incident so the next reader knows why');
  let threw = null;
  try { assertSpinoffNotOnProdNetworks({ spinComposeYaml: spin, prodComposeYaml: prod, manifest: {} }); }
  catch (e) { threw = e; }
  // manifest empty + prod compose still forbids
  ok(!!threw && threw.code === 'SPINOFF_PROD_NETWORK',
     `assert throws with code SPINOFF_PROD_NETWORK [${threw?.code}]`);
}

console.log('\n── 5. clean shapes are allowed ──');
{
  const clean = checkSpinoffProdNetworkAttach({
    spinComposeYaml: `
services:
  server: { image: s }
  webapp: { image: w }
`,
    prodComposeYaml: `
networks:
  prodnet: { external: true }
services:
  webapp: { image: p, networks: [prodnet] }
`,
    manifest: { tiers: { prod: { requires: { networks: ['prodnet'] } } } },
  });
  ok(clean.ok, 'spinoff with no networks key is allowed (ZEEHIVE generated shape)');

  const sharedDevOnly = checkSpinoffProdNetworkAttach({
    spinComposeYaml: `
networks:
  shared-dev: { external: true }
services:
  webapp: { image: w, networks: [shared-dev] }
`,
    prodComposeYaml: `
networks:
  prodnet: { external: true }
services:
  webapp: { image: p, networks: [prodnet] }
`,
    manifest: { tiers: { prod: { requires: { networks: ['prodnet'] } } } },
  });
  ok(sharedDevOnly.ok, 'spinoff on a shared-DEV network that prod does not use is allowed');

  const empty = checkSpinoffProdNetworkAttach({});
  ok(empty.ok, 'missing compose text is a no-op (nothing to refuse)');
}

console.log('\n── 6. Zeehive committed compose stays green ──');
{
  const zeehiveSpin = readFileSync(join(ROOT, 'docker-compose.spinoff.yml'), 'utf8');
  const r = checkSpinoffProdNetworkAttach({
    spinComposeYaml: zeehiveSpin,
    manifest: {
      tiers: {
        prod: { compose: 'docker-compose.yml', requires: { networks: ['anything'] } },
      },
    },
    prodComposeYaml: `
networks:
  anything: { external: true }
services:
  server: { image: x, networks: [anything] }
`,
  });
  ok(r.ok, 'ZEEHIVE generated spinoff (no external nets) is never refused');
}

// ── 7. buildContainer integration (needs DATABASE_URL) ───────────────────────
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.log('\n── 7. buildContainer integration SKIPPED (no DATABASE_URL; use `zee db-sandbox --migrate`) ──');
} else {
  console.log('\n── 7. buildContainer refuses a forbidden attach before building ──');
  const { q, one, pool } = await import('../server/src/db/pool.js');
  const { buildContainer } = await import('../server/src/lib/build.js');
  const tag = randomUUID().slice(0, 8);
  const tmp = mkdtempSync(join(tmpdir(), `zt-sng-${tag}-`));
  const created = { projects: [], xells: [], containers: [], xources: [] };
  try {
    spawnSync('git', ['init'], { cwd: tmp, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'test@zeehive'], { cwd: tmp });
    spawnSync('git', ['config', 'user.name', 'test'], { cwd: tmp });
    writeFileSync(join(tmp, 'README'), 'sng');
    // Forbidden spinoff compose: attaches to a prod external network.
    writeFileSync(join(tmp, 'docker-compose.spinoff.yml'), `
networks:
  bad-prod-net:
    external: true
services:
  server:
    image: app-server
    networks: [bad-prod-net]
  webapp:
    image: app-web
    networks: [bad-prod-net]
`);
    writeFileSync(join(tmp, 'docker-compose.prod.yml'), `
networks:
  bad-prod-net:
    external: true
services:
  webapp:
    image: prod-web
    networks: [bad-prod-net]
`);
    spawnSync('git', ['add', '.'], { cwd: tmp });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmp });

    const proj = await one(
      `INSERT INTO project (name, repo_root, main_branch, compose_spinoff, compose_prod, manifest)
       VALUES ($1,$2,'main','docker-compose.spinoff.yml','docker-compose.prod.yml',$3::jsonb)
       RETURNING id`,
      [`sng_${tag}`, tmp, JSON.stringify({
        tiers: {
          spinoff: { compose: 'docker-compose.spinoff.yml' },
          prod: { compose: 'docker-compose.prod.yml' },
        },
      })]);
    created.projects.push(proj.id);
    const xource = await one(
      `INSERT INTO xource (project_id, ref) VALUES ($1,'main') RETURNING id`, [proj.id]);
    created.xources.push(xource.id);
    const xell = await one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status)
       VALUES ($1,$2,$3,$4,$5,'claimed') RETURNING id`,
      [proj.id, xource.id, `sng-${tag}`, `spinoff/sng-${tag}`, tmp]);
    created.xells.push(xell.id);
    const c = await one(
      `INSERT INTO container (project_id, role, tier, isolation, name, health, owner_xell_id,
                              image_tag, docker_ctx, compose_file, compose_project)
       VALUES ($1,'webapp','spinoff','per-xell',$2,'down',$3,
               'app-web:x','default','docker-compose.spinoff.yml',$4)
       RETURNING id, health`,
      [proj.id, `sng_web_${tag}`, xell.id, `sng-spin-${tag}`]);
    created.containers.push(c.id);

    let refused = null;
    try { await buildContainer(c.id, {}); } catch (e) { refused = e.message; }
    ok(!!refused, 'buildContainer REFUSES the forbidden attach');
    ok(/refusing to bring up spinoff/.test(refused || ''), 'refusal names the spinoff bring-up');
    ok(/bad-prod-net/.test(refused || ''), `refusal names the network [${refused}]`);
    const after = await one(`SELECT health FROM container WHERE id=$1`, [c.id]);
    ok(after.health === 'down',
       `health stays 'down' — refused BEFORE flipping to building [${after.health}]`);

    // Control: same shape without the attach is NOT refused at the guard (it may fail later
    // for missing env/docker — we only assert the guard did not throw the prod-network error).
    writeFileSync(join(tmp, 'docker-compose.spinoff.yml'), `
services:
  server: { image: app-server }
  webapp: { image: app-web }
`);
    let cleanErr = null;
    try { await buildContainer(c.id, {}); } catch (e) { cleanErr = e.message; }
    ok(!/refusing to bring up spinoff/.test(cleanErr || ''),
       `clean compose is not refused by the prod-network guard [${cleanErr || 'started/queued'}]`);
    // If it did start building under BUILD_MODE=simulate, mark it down so cleanup is quiet.
    await q(`UPDATE container SET health='down' WHERE id=$1 AND health='building'`, [c.id]).catch(() => {});
  } finally {
    for (const id of created.containers) await q(`DELETE FROM container WHERE id=$1`, [id]).catch(() => {});
    for (const id of created.xells) {
      await q(`DELETE FROM xell_uses_container WHERE xell_id=$1`, [id]).catch(() => {});
      await q(`DELETE FROM xell WHERE id=$1`, [id]).catch(() => {});
    }
    for (const id of created.xources) await q(`DELETE FROM xource WHERE id=$1`, [id]).catch(() => {});
    for (const id of created.projects) await q(`DELETE FROM project WHERE id=$1`, [id]).catch(() => {});
    await pool.end().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(failures ? `\n${failures} FAILURE(S) ✗` : '\nALL PASSED ✓');
process.exit(failures ? 1 : 0);

// SHIP BUNDLE — integration test for bundling DEFERRED ships into one combined deploy.
//
// Sets up an ISOLATED throwaway project in the real DB (its own git repo + worktrees, its own prod
// site + a stub-build prod container), seeds 3 DEFERRED ship requests, then exercises the real
// shipgate:
//   1. bundleDeferredShips → one carrier goes pending (awaiting approval), the other two fold in as
//      riders (bundled_into = carrier, still deferred).
//   2. reject the carrier → riders are freed back to plain-deferred.
//   3. re-bundle, then APPROVE the carrier → its ONE stub build ships, and both riders resolve to
//      'shipped' from that single deploy (resolveBundleRiders).
// Everything it creates is torn down in a finally, whatever happens.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.SHIP_MODE = 'simulate';               // don't touch anything real
process.env.SHIP_REAPER_ENABLED = 'false';        // no background ticks racing us
process.env.LANDING_PAD_ENABLED = 'false';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = new pg.Client({ connectionString: url });
const tmp = mkdtempSync(join(tmpdir(), 'shipbundle-'));
const PID = '00000000-0000-4000-8000-00000000b111';   // fixed ids so cleanup is total even on crash
const ids = { xource: '00000000-0000-4000-8000-00000000b222',
  site: '00000000-0000-4000-8000-00000000b333' };

async function cleanup({ files = false } = {}) {
  try { await client.query(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* */ }
  if (files) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } }
}

try {
  await client.connect();
  await cleanup();   // drop any rows a prior crashed run left (keeps the fresh temp dir)

  // ── a real git repo + 3 worktrees, all at master HEAD (landed, clean) ──
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README'), 'hi\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  const head = git(repo, 'rev-parse', 'HEAD');
  const wts = [];
  for (const s of ['alpha', 'bravo', 'charlie']) {
    const wt = join(tmp, `wt-${s}`);
    git(repo, 'worktree', 'add', '-q', '-b', `spinoff/${s}`, wt, 'master');
    wts.push(wt);
  }

  // ── a stub build script: prints the one json line the projector reads ──
  const build = join(tmp, 'build.sh');
  writeFileSync(build, `#!/usr/bin/env bash\necho '{"ok":true,"head":"${head}","method":"stub"}'\n`);
  chmodSync(build, 0o755);

  // ── seed the isolated project ──
  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'shipbundle-test',$2,'master')`,
    [PID, repo]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [ids.xource, PID]);
  await client.query(
    `INSERT INTO deploy_site (id, project_id, key, tier, is_default) VALUES ($1,$2,'local','prod',true)`,
    [ids.site, PID]);
  await client.query(
    `INSERT INTO container (project_id, role, tier, isolation, name, build_script, site_id, health)
       VALUES ($1,'server','prod','shared','sb-prod-server',$2,$3,'up')`, [PID, build, ids.site]);

  const xellIds = [];
  const shipIds = [];
  for (let i = 0; i < 3; i++) {
    const x = (await client.query(
      `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled)
         VALUES ($1,$2,$3,$4,$5,'idle',false) RETURNING id`,
      [PID, ids.xource, ['alpha', 'bravo', 'charlie'][i], `spinoff/${['alpha','bravo','charlie'][i]}`, wts[i]])).rows[0].id;
    xellIds.push(x);
    // DEFERRED ship: pending + deferred_at set, skip_migrations so runShip needs no prod DB.
    const s = (await client.query(
      `INSERT INTO ship_request (project_id, xell_id, commit, reason, targets, status, skip_migrations,
                                 site_id, deferred_at, deferred_by)
         VALUES ($1,$2,$3,$4,'{server}','pending',true,$5, now(), 'human@console') RETURNING id`,
      [PID, x, head, `feat ${i}`, ids.site])).rows[0].id;
    shipIds.push(s);
  }

  const { bundleDeferredShips, decideShip } = await import('../server/src/queenzee/shipgate.js');
  const shipRow = async (id) => (await client.query(`SELECT * FROM ship_request WHERE id=$1`, [id])).rows[0];

  // ── 1. BUNDLE ──
  const res = await bundleDeferredShips(PID, { by: 'test@bundle' });
  ok(res.ok === true, `bundle ok (${JSON.stringify(res.reason || res.bundles?.length)})`);
  ok(res.bundles?.length === 1, `one carrier bundle for the single prod site (${res.bundles?.length})`);

  const rows = await Promise.all(shipIds.map(shipRow));
  const carriers = rows.filter((r) => r.status === 'pending' && !r.deferred_at && !r.bundled_into);
  const riders = rows.filter((r) => r.status === 'pending' && r.deferred_at && r.bundled_into);
  ok(carriers.length === 1, `exactly one carrier is pending+undeferred (${carriers.length})`);
  ok(riders.length === 2, `the other two are folded riders (${riders.length})`);
  ok(riders.every((r) => r.bundled_into === carriers[0].id), 'both riders point at the carrier');
  ok(/bundled ship of 3/.test(carriers[0].reason || ''), `carrier reason names the bundle: "${carriers[0].reason}"`);

  // ── 2. REJECT the carrier → riders freed ──
  await decideShip(carriers[0].id, 'rejected', 'test@bundle');
  const afterReject = await Promise.all(shipIds.map(shipRow));
  const freed = afterReject.filter((r) => r.status === 'pending' && r.deferred_at && !r.bundled_into);
  ok(freed.length === 2, `rejecting the carrier frees its 2 riders back to plain-deferred (${freed.length})`);
  ok((await shipRow(carriers[0].id)).status === 'rejected', 'carrier is rejected');

  // give the two survivors a fresh site so a re-bundle has a full set again: re-defer the rejected
  // carrier's xell by inserting a new deferred ship for it (its old request is terminal).
  await client.query(
    `INSERT INTO ship_request (project_id, xell_id, commit, reason, targets, status, skip_migrations,
                               site_id, deferred_at, deferred_by)
       VALUES ($1,$2,$3,'re-defer','{server}','pending',true,$4, now(),'human@console')`,
    [PID, carriers[0].xell_id, head, ids.site]);

  // ── 3. RE-BUNDLE then APPROVE → one deploy ships carrier + riders ──
  const res2 = await bundleDeferredShips(PID, { by: 'test@bundle' });
  ok(res2.ok === true && res2.bundles[0].count === 3, `re-bundle carries all 3 again (${res2.bundles?.[0]?.count})`);
  const open = (await client.query(
    `SELECT * FROM ship_request WHERE project_id=$1 AND status='pending' AND deferred_at IS NULL AND bundled_into IS NULL`,
    [PID])).rows;
  const carrier2 = open[0];
  await decideShip(carrier2.id, 'approved', 'test@bundle');   // → runShip (simulate + stub build)

  // wait for the async ship to settle
  let settled = null;
  for (let i = 0; i < 40; i++) {
    settled = (await client.query(`SELECT status FROM ship_request WHERE id=$1`, [carrier2.id])).rows[0].status;
    if (settled === 'shipped' || settled === 'failed') break;
    await sleep(150);
  }
  ok(settled === 'shipped', `carrier's single stub build shipped (${settled})`);
  const ridersFinal = (await client.query(
    `SELECT status, containers FROM ship_request WHERE bundled_into=$1`, [carrier2.id])).rows;
  ok(ridersFinal.length === 2, `two riders were folded into the approved carrier (${ridersFinal.length})`);
  ok(ridersFinal.every((r) => r.status === 'shipped'), 'both riders resolve to SHIPPED from the one deploy');
  ok(ridersFinal.every((r) => JSON.stringify(r.containers).includes('bundled')),
     'each rider records it rode the bundle, without a build of its own');

} finally {
  await cleanup({ files: true });
  await client.end();
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);

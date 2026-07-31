// SHIP ↔ CXELL-IMAGE OVERRIDE — the guard's release valve, as a per-ship human decision.
//
// A ship rebuilds zeehive/zee-agent (the image every cxell zee runs) from the shipped commit, and a
// FAILED rebuild now fails the ship: a queenzee on new code with a silently stale fleet image is the
// one outcome nobody can detect — it cost two zees an evening of mtime forensics to find once.
// But a fatal guard needs an override a human can reach IN THE MOMENT, and the first one shipped
// was `CXELL_IMAGE_REQUIRED=0` in the queenzee's OWN process env: an override that needs a .env edit
// and a queenzee restart, i.e. itself a deploy, exactly when someone is mid-incident.
//
// So the override rides the SHIP REQUEST (migration 055). This proves the whole path against the
// real shipgate, in an isolated throwaway project, with a stub build script that RECORDS the
// environment it was handed:
//   1. DEFAULT IS FATAL: no override → the flag is false on the row, nothing is injected into the
//      build script's env, and a build that reports the cxell-image failure FAILS the ship.
//   2. THE OVERRIDE REACHES THE SCRIPT: approving with it → CXELL_IMAGE_REQUIRED=0 arrives in the
//      child's environment, explicitly (not by inheritance).
//   3. IT IS RECORDED, NOT SILENT: the choice is on the ship_request row afterwards, next to who
//      decided it — so the audit trail says a human chose it.
//   4. THE OPERATOR-LEVEL ESCAPE STILL WORKS: a queenzee genuinely started with
//      CXELL_IMAGE_REQUIRED=0 still passes it through for a ship that did not ask for the override.
// Everything it creates is torn down in a finally, whatever happens.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.SHIP_MODE = 'simulate';               // never touch anything real
process.env.SHIP_REAPER_ENABLED = 'false';        // no background ticks racing us
process.env.LANDING_PAD_ENABLED = 'false';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = new pg.Client({ connectionString: url });
const tmp = mkdtempSync(join(tmpdir(), 'shipcxi-'));
const PID = '00000000-0000-4000-8000-00000000c111';   // fixed ids so cleanup is total even on crash
const ids = { xource: '00000000-0000-4000-8000-00000000c222',
  site: '00000000-0000-4000-8000-00000000c333' };

async function cleanup({ files = false } = {}) {
  try { await client.query(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* */ }
  if (files) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } }
}

try {
  await client.connect();
  await cleanup();   // drop rows a prior crashed run left

  // ── a real git repo + one worktree ──
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README'), 'hi\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  const head = git(repo, 'rev-parse', 'HEAD');
  const wt = join(tmp, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'spinoff/cxi', wt, 'master');

  // ── stub build scripts. Each RECORDS the cxell-image env it was handed, which is the only way to
  //    prove the flag arrived in the child rather than merely sitting on a row. ──
  const envFile = join(tmp, 'seen-env.txt');
  const okBuild = join(tmp, 'build-ok.sh');
  writeFileSync(okBuild,
    `#!/usr/bin/env bash\n`
    + `printf '%s' "\${CXELL_IMAGE_REQUIRED-<unset>}" > '${envFile}'\n`
    + `echo '{"ok":true,"head":"${head}","method":"stub"}'\n`);
  chmodSync(okBuild, 0o755);
  // The guard firing for real: this is exactly what scripts/lib/cxell-image.sh makes self-ship.sh
  // emit when the zee-agent rebuild fails and the override was NOT given.
  const failBuild = join(tmp, 'build-cxell-fail.sh');
  writeFileSync(failBuild,
    `#!/usr/bin/env bash\n`
    + `printf '%s' "\${CXELL_IMAGE_REQUIRED-<unset>}" > '${envFile}'\n`
    + `echo "self-ship: !!! CXELL-IMAGE FAILED — could NOT rebuild zeehive/zee-agent" >&2\n`
    + `echo '{"ok":false,"head":"${head}","method":"cxell-image-failed"}'\n`
    + `exit 1\n`);
  chmodSync(failBuild, 0o755);

  // ── seed the isolated project ──
  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'shipcxi-test',$2,'master')`,
    [PID, repo]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [ids.xource, PID]);
  await client.query(
    `INSERT INTO deploy_site (id, project_id, key, tier, is_default) VALUES ($1,$2,'local','prod',true)`,
    [ids.site, PID]);
  const containerId = (await client.query(
    `INSERT INTO container (project_id, role, tier, isolation, name, build_script, site_id, health)
       VALUES ($1,'server','prod','shared','cxi-prod-server',$2,$3,'up') RETURNING id`,
    [PID, okBuild, ids.site])).rows[0].id;
  const xellId = (await client.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled)
       VALUES ($1,$2,'cxi-alpha','spinoff/cxi',$3,'idle',false) RETURNING id`,
    [PID, ids.xource, wt])).rows[0].id;

  const { decideShip } = await import('../server/src/queenzee/shipgate.js');
  const shipRow = async (id) => (await client.query(`SELECT * FROM ship_request WHERE id=$1`, [id])).rows[0];
  const newShip = async () => (await client.query(
    `INSERT INTO ship_request (project_id, xell_id, commit, reason, targets, status, skip_migrations, site_id)
       VALUES ($1,$2,$3,'cxell-image override test','{server}','pending',true,$4) RETURNING id`,
    [PID, xellId, head, ids.site])).rows[0].id;
  const useBuild = async (script) =>
    client.query(`UPDATE container SET build_script=$2 WHERE id=$1`, [containerId, script]);
  // runShip is fire-and-forget from decideShip; wait for the row to leave 'approved'/'shipping'.
  const settle = async (id, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      const r = await shipRow(id);
      if (['shipped', 'failed', 'rejected'].includes(r.status)) return r;
      await sleep(100);
    }
    return shipRow(id);
  };
  const seenEnv = () => (existsSync(envFile) ? readFileSync(envFile, 'utf8') : '<no build ran>');
  const clearEnvFile = () => { try { rmSync(envFile, { force: true }); } catch { /* */ } };
  // Free the prod lock between ships — each deploy takes it and starts a release countdown.
  const freeLock = () => client.query(`DELETE FROM deploy_lock WHERE project_id=$1`, [PID]);

  console.log('\n── 1. the DEFAULT is fatal: no override, and a cxell-image failure fails the ship ──');
  clearEnvFile(); await freeLock();
  await useBuild(failBuild);
  const s1 = await newShip();
  await decideShip(s1, 'approved', 'test@human');           // no override
  const r1 = await settle(s1);
  ok(r1.allow_stale_cxell_image === false, 'the request records NO override by default');
  ok(seenEnv() === '<unset>',
     `nothing is injected into the build script's env when the override is off (saw "${seenEnv()}")`);
  ok(r1.status === 'failed', `a cxell-image failure FAILS the ship (status: ${r1.status})`);
  ok(/CXELL-IMAGE FAILED/.test(r1.error || ''),
     'and the failure text lands on the request where a human reads it, not only in a log');
  const containers1 = Array.isArray(r1.containers) ? r1.containers : JSON.parse(r1.containers || '[]');
  ok(containers1.some((c) => c.method === 'cxell-image-failed' || c.ok === false),
     'the ship record names the cxell-image failure as the reason');

  console.log('\n── 2. the override REACHES THE BUILD SCRIPT, explicitly ──');
  clearEnvFile(); await freeLock();
  await useBuild(okBuild);
  const s2 = await newShip();
  await decideShip(s2, 'approved', 'test@human', { allowStaleCxellImage: true });
  const r2 = await settle(s2);
  ok(seenEnv() === '0', `the child was handed CXELL_IMAGE_REQUIRED=0 (saw "${seenEnv()}")`);
  ok(r2.status === 'shipped', `and the ship proceeds (status: ${r2.status})`);

  console.log('\n── 3. the choice is RECORDED on the request, next to who made it ──');
  ok(r2.allow_stale_cxell_image === true, 'allow_stale_cxell_image is true on the row afterwards');
  ok(r2.decided_by === 'test@human', `and the human who chose it is on the same row (${r2.decided_by})`);
  const s2b = await shipRow(s2);
  ok(s2b.allow_stale_cxell_image === true, 'it survives the ship (the audit trail is durable, not in-flight state)');

  console.log('\n── 4. a REJECT never records an override (nothing may quietly clear a guard) ──');
  await freeLock();
  const s3 = await newShip();
  const r3 = await decideShip(s3, 'rejected', 'test@human', { allowStaleCxellImage: true });
  ok(r3.status === 'rejected' && r3.allow_stale_cxell_image === false,
     'approving is the only decision that can set it');

  console.log('\n── 5. the OPERATOR-level escape still works (a queenzee with no reachable daemon) ──');
  clearEnvFile(); await freeLock();
  await useBuild(okBuild);
  process.env.CXELL_IMAGE_REQUIRED = '0';                   // as if the queenzee itself was started with it
  const s4 = await newShip();
  await decideShip(s4, 'approved', 'test@human');           // NO per-ship override
  const r4 = await settle(s4);
  delete process.env.CXELL_IMAGE_REQUIRED;
  ok(seenEnv() === '0', `the queenzee's own env still passes through (saw "${seenEnv()}")`);
  ok(r4.allow_stale_cxell_image === false,
     'and that operator-level setting is NOT recorded as a human per-ship choice — the two are distinct');

  console.log('\n── 6. the API surface a human clicks through ──');
  const routes = readFileSync(new URL('../server/src/api/routes.js', import.meta.url), 'utf8');
  ok(/allow_stale_cxell_image/.test(routes), 'the approve route accepts allow_stale_cxell_image');
  ok((routes.match(/allowStaleCxellImage/g) || []).length >= 2,
     'both approve and unlock-and-ship pass it through');
  const ship = readFileSync(new URL('../web/src/Ship.jsx', import.meta.url), 'utf8');
  ok(/data-testid="ship-stale-override"/.test(ship), 'the console offers it as an explicit tick on a pending card');
  ok(/data-testid="ship-stale-chosen"/.test(ship), 'and shows afterwards that the ship was approved WITH it');
  ok(/useState\(false\)/.test(ship.slice(ship.indexOf('allowStale'), ship.indexOf('allowStale') + 400))
     || /const \[allowStale, setAllowStale\] = useState\(false\)/.test(ship),
     'defaulting to OFF — the guard is only ever waived deliberately');

  console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
} catch (e) {
  console.error('\n✗ threw:', e.stack || e.message);
  fail++;
} finally {
  await cleanup({ files: true });
  try { await client.end(); } catch { /* */ }
}
process.exit(fail ? 1 : 0);

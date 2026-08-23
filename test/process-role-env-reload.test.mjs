// AFTER AN ENV-PROJECTION RULE SHIPS, A PROCESS-ROLE TIER MUST RELOAD IT — the gap this branch closes.
//
// `.zeehive.env` is a FILE a process role reads at boot (start-xell-process.sh unsets every key the
// file owns so dotenv re-reads it). When the queenzee rewrites that file — a ship changed the
// projection, and the boot reconcile (lib/provision.reconcileXellEnvs) re-emits it — the RUNNING
// server keeps serving the OLD values: dotenv loaded them once at start and nothing restarts the
// process. The fix was live on disk and dead in memory, and nobody could tell: the file said new,
// the server served old, and every health probe answered.
//
// This pins the close: a REAL-mode reconcile that rewrites a process-role xell's .zeehive.env
// RESTARTS its running tier, and the restart is AWAITED so the reconcile knows the tier actually
// came up on the new file — never "assume", always verify.
//
//   1. REAL rewrite → the RUNNING process tier is restarted, OBSERVABLY: the tier's server now
//      answers with a value that only exists in the NEW file (the "no zee had to guess" bar).
//   2. SIMULATE sees the same drift and REPORTS the restart it would do, touching nothing — a
//      nested queenzee (PROVISION_MODE=simulate) walks the REAL fleet's rows and must never exec
//      into another zee's process tier.
//   3. A 'down' process tier is NOT started — starting one is the pool's job; the sweep says so.
//   4. A CONTAINER tier (docker_ctx+image_tag set) is NOT restarted — its env is baked at
//      container-create, not read from this file. Different problem, deliberately not touched.
//   5. A restart that FAILS is loud: the row lands on terminal 'down' (never stuck 'building'),
//      the reconcile's result reports it, and it must never read as "reloaded" — unmeasurable ≠ yes.
//   6. The reconcile is idempotent: a second sweep with no drift restarts nothing.
//
// It runs the REAL scripts/start-xell-process.sh against a REAL throwaway meta-DB (a `zee
// db-sandbox --migrate` instance) and a real HTTP server. The fixture server (serve.mjs) reads
// .zeehive.env itself and hands its port to its successor — the real script kills the old listener
// with fuser, which a cxell cage may not have — so the restart path is exercised end-to-end without
// needing psmisc.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.PROVISION_MODE = 'simulate';
process.env.BUILD_MODE = 'simulate';

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };

const { q, one, pool } = await import('../server/src/db/pool.js');
const { reconcileXellEnvs } = await import('../server/src/lib/provision.js');
const { recentLogs } = await import('../server/src/lib/logbus.js');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'start-xell-process.sh');
const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const root = mkdtempSync(join(tmpdir(), `envrel-${tag}-`));

// Three ports, one per xell, from a tag-derived base so parallel runs do not collide. A server that
// reads PORT from its .zeehive.env (like a real process app) binds the first; the fail and compose
// xells never actually serve.
const base = 61000 + (parseInt(tag, 16) % 1300) * 3;
const PORTS = { live: base, fail: base + 1, compose: base + 2 };

const MANIFEST = {
  tiers: { spinoff: { runner: 'process', ports: {
    server: { env: 'PORT', base: 4800, mod: 90 },
    webapp: { env: 'ZEEHIVE_WEB_PORT', base: 5300, mod: 90 },
  } } },
  roles: {
    server: { runner: 'process', start: 'node serve.mjs' },
    webapp: { runner: 'process', start: 'node serve.mjs' },
  },
};

// The fixture app: parses .zeehive.env itself (the projection IS the config, same rule as a real
// process role) and, on a port conflict, kills the previous incarnation (its PID in .serve-pid) and
// retries — the same "the new process takes over from the old" semantics fuser gives the real script.
const SERVE_MJS = `
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
const env = {};
for (const line of readFileSync('.zeehive.env', 'utf8').split('\\n')) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
  if (m) env[m[1]] = m[2];
}
const port = Number(env.PORT || process.argv[2]);
const pidFile = new URL('./.serve-pid', import.meta.url);
let bound = false;
for (let i = 0; i < 100 && !bound; i++) {
  const srv = http.createServer((_q, r) => r.end('pid=' + process.pid + ' proof=' + (env.RELOAD_PROOF ?? 'unset')));
  try {
    await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(port, resolve); });
    bound = true;
    writeFileSync(pidFile, String(process.pid));
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    try {
      const old = Number(readFileSync(pidFile, 'utf8').trim());
      if (old && old !== process.pid) process.kill(old, 'SIGTERM');
    } catch { /* no old pid */ }
    await sleep(100);
  }
}
if (!bound) process.exit(3);
setTimeout(() => process.exit(0), 120000).unref?.();
`.trim() + '\n';

const probe = (port) => new Promise((res) => {
  const req = http.get({ host: '127.0.0.1', port, timeout: 2000 }, (r) => {
    let body = ''; r.on('data', (d) => (body += d)); r.on('end', () => res({ code: r.statusCode, body }));
  });
  req.on('error', (e) => res({ error: e.message }));
  req.on('timeout', () => { req.destroy(); res({ error: 'timeout' }); });
});

// The real script's port-kill is `fuser`, which a cxell cage may not have — so kill any leftover
// fixture listener by /proc scan instead (test-only hygiene, not part of the product path).
const killLeftoverListeners = async (port) => {
  for (const p of await readdirSync('/proc')) {
    if (!/^\d+$/.test(p)) continue;
    try {
      const cmd = readFileSync(`/proc/${p}/cmdline`, 'utf8');
      if (cmd.includes('serve.mjs') && cmd.includes(String(port))) process.kill(Number(p), 'SIGKILL');
    } catch { /* gone */ }
  }
  await new Promise((r) => setTimeout(r, 200));
};

function makeWorktree(name, { failNpm = false } = {}) {
  const wt = join(root, name);
  mkdirSync(wt, { recursive: true });
  mkdirSync(join(wt, 'node_modules'), { recursive: true });           // install is skipped
  writeFileSync(join(wt, 'node_modules', '.package-lock.json'), '{}'); // npm's completion marker
  writeFileSync(join(wt, '.zeehive.env'), `RELOAD_PROOF=old\nPORT=${PORTS[name]}\n`);
  writeFileSync(join(wt, 'serve.mjs'), SERVE_MJS);
  if (failNpm) {
    // no node_modules + a dependency missing from the lock → `npm ci` refuses fast, offline (the
    // same fixture as one-install-per-worktree.test.mjs #3). The restart therefore FAILS fast.
    rmSync(join(wt, 'node_modules'), { recursive: true, force: true });
    writeFileSync(join(wt, 'package.json'), JSON.stringify({
      name: `envrel-${tag}-fail`, version: '1.0.0', private: true, workspaces: ['pkg0'],
      dependencies: { 'left-pad': '^1.3.0' },                          // NOT in the lock → ci refuses
    }, null, 2));
    writeFileSync(join(wt, 'package-lock.json'),
      JSON.stringify({ name: `envrel-${tag}-fail`, version: '1.0.0', lockfileVersion: 3, requires: true, packages: {} }, null, 2));
  }
  return wt;
}

// Start a process role EXACTLY as build.js spawns it, and wait for the script's JSON verdict — the
// "a prior build left this tier running" setup.
const startRole = (wt, port) => new Promise((res) => {
  const p = spawn('bash', [SCRIPT, wt, 'server', String(port), 'real', 'node', 'serve.mjs'], { cwd: ROOT });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.on('close', () => res(JSON.parse(out.trim().split('\n').filter(Boolean).pop() || '{}')));
});

const since = () => recentLogs(600).length;
const envLogsSince = (n) => recentLogs(600).slice(n).filter((l) => l.scope === 'env').map((l) => l.msg);

let pid = null;
let liveSrvId = null, webRowId = null, ctrRowId = null, failSrvId = null;
try {
  await Promise.all(Object.values(PORTS).map(killLeftoverListeners));

  pid = (await one(
    `INSERT INTO project (name, repo_root, db_user, db_name, manifest)
       VALUES ($1,$2,'zeehive','zeehive',$3::jsonb) RETURNING id`,
    [`envrel-${tag}`, process.cwd(), JSON.stringify(MANIFEST)])).id;
  const xoid = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [pid])).id;

  const env = await one(
    `INSERT INTO environment (project_id, key, tier, label, is_default)
       VALUES ($1,$2,'dev','env-reload fixture',true) RETURNING *`,
    [pid, `dev-${tag}`]);
  const envVar = (await one(
    `INSERT INTO environment_var (environment_id, name, value, is_secret)
       VALUES ($1,'RELOAD_PROOF','old',false) RETURNING id`,
    [env.id])).id;

  const mkXell = async (name, { failNpm = false } = {}) => {
    const slug = `envrel-${tag}-${name}`;
    const wt = makeWorktree(name, { failNpm });
    const x = await one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, zee_type, db_coupling)
         VALUES ($1,$2,$3,$4,$5,'working',false,'worker','db-isolated') RETURNING *`,
      [pid, xoid, slug, `spinoff/${slug}`, wt]);
    return { ...x, wt, name, slug };
  };
  const mkRow = async (xell, role, port, health, { container = false } = {}) => {
    const row = await one(
      `INSERT INTO container (project_id, role, tier, isolation, name, image_tag, docker_ctx, host, host_port, internal_port, url, owner_xell_id, health)
         VALUES ($1,$2,'spinoff','per-xell',$3,${container ? "'img:tag'" : 'NULL'},${container ? "'default'" : 'NULL'},
                 '127.0.0.1',$4,3000,$5,$6,$7) RETURNING id`,
      [pid, role, `${xell.slug}-${role}`, port, `http://127.0.0.1:${port}`, xell.id, health]);
    return row.id;
  };

  const live = await mkXell('live');
  const fail = await mkXell('fail', { failNpm: true });
  const compose = await mkXell('compose');

  // live xell: a RUNNING process server + a 'down' process webapp + a LIVE zee agent in it.
  liveSrvId = await mkRow(live, 'server', PORTS.live, 'up');
  webRowId = await mkRow(live, 'webapp', PORTS.live + 2, 'down');
  await q(`INSERT INTO zee (xell_id, attach_mode, entrypoint, status, viewer_kind)
             VALUES ($1,'headless-spawn','cxell-cli','working','ssh-terminal')`, [live.id]);
  // fail xell: a process server row health='up' whose worktree will FAIL the restart.
  failSrvId = await mkRow(fail, 'server', PORTS.fail, 'up');
  // compose xell: a CONTAINER tier (docker_ctx + image_tag set) — deliberately NOT a restart target.
  ctrRowId = await mkRow(compose, 'server', PORTS.compose, 'up', { container: true });

  // Bring the live server UP for real — exactly what a prior build left running on the OLD file.
  const up = await startRole(live.wt, PORTS.live);
  ok(up.ok === true, `setup: the live process-role server is up (as a prior build left it) ${up.method}`);
  const p0 = await probe(PORTS.live);
  ok(p0.body.includes('proof=old'), `setup: it serves the OLD env (${p0.body})`);

  // ── 1. SIMULATE reports the restart it would do, and touches nothing ─────────────────────────
  console.log('\n── PROVISION_MODE=simulate: the drift is SEEN and REPORTED, never acted on ──');
  const dry = await reconcileXellEnvs({ reason: 'test-simulate', mode: 'simulate' });
  ok(dry.dry_run === true, 'simulate: dry_run is true');
  ok(dry.would_restart.includes(`${live.slug}:server`),
     `simulate: reports the process tier it WOULD restart [${dry.would_restart.join(', ')}]`);
  ok(!dry.would_restart.some((w) => w.includes(`${compose.slug}:`)),
     'simulate: a CONTAINER tier is NOT reported for restart (its env is baked, not read from the file)');
  ok(dry.would_restart.every((w) => !w.includes(':webapp')), 'simulate: a DOWN process tier is not reported either');
  const pSim = await probe(PORTS.live);
  ok(pSim.body.includes('proof=old'), 'simulate: the running server still serves the OLD env — nothing was touched');

  // ── 2. the env rule CHANGES (a ship landed): RELOAD_PROOF now resolves to 'new' ─────────────
  console.log('\n── the projection rule changes: RELOAD_PROOF old → new in the meta-DB ──');
  await q(`UPDATE environment_var SET value='new' WHERE id=$1`, [envVar]);
  const before = await probe(PORTS.live);
  ok(before.body.includes('proof=old'),
     `before the reconcile the running server still serves the OLD value (${before.body}) — file changes do NOT reach memory`);

  // ── 3. REAL reconcile: rewrite + restart, and the running tier OBSERVABLY serves the new env ─
  console.log('\n── real reconcile: rewrite the projection AND restart the running tier onto it ──');
  const mark = since();
  const r = await reconcileXellEnvs({ reason: 'test', mode: 'real' });
  ok(r.rewritten >= 3, `a real sweep rewrites every stale xell (rewritten=${r.rewritten})`);
  ok(r.restarted.includes(`${live.slug}:server`),
     `the RUNNING process tier is restarted onto the new file [${r.restarted.join(', ')}]`);
  ok(!r.restarted.some((s) => s.includes(':webapp')),
     'a DOWN process tier is NOT started (its load is the pool\'s job)');
  ok(!r.restarted.some((s) => s.includes(`${compose.slug}:`)),
     'a CONTAINER tier is NOT restarted');
  ok(!r.restarted.some((s) => s.includes(`${fail.slug}:`)),
     'a FAILED restart is NOT counted as restarted — the tier is DOWN, and down is not "reloaded"');
  ok(r.restart_failed.some((s) => s.startsWith(fail.slug)),
     `a restart that FAILS is reported, not swallowed [${r.restart_failed.join('; ')}]`);

  const after = await probe(PORTS.live);
  ok(after.body.includes('proof=new'),
     `DONE: the running process-role server now serves the NEW env (${after.body}) — no zee had to guess`);

  const logs = envLogsSince(mark);
  const liveLine = logs.filter((m) => m.startsWith(`${live.slug}:`)).pop();
  ok(/restarted to load it \[server\]/.test(liveLine || ''),
     `the per-xell log says the tier was RESTARTED (${(liveLine || '').slice(0, 100)}…)`);
  ok(!/still runs on the old values/.test(liveLine || ''),
     '…and does NOT warn a live zee its app is stale — the tier was just reloaded, the warning is for tiers that were not');
  const failLine = logs.filter((m) => m.startsWith(`${fail.slug}:`)).pop();
  ok(/restart FAILED/.test(failLine || ''), 'the FAILED restart is LOUD in the per-xell log');

  // row states are the truth that outlives the log
  ok((await one(`SELECT health FROM container WHERE id=$1`, [liveSrvId])).health === 'up',
     'the live server row is back on UP after its reload');
  ok((await one(`SELECT health FROM container WHERE id=$1`, [webRowId])).health === 'down',
     'the down webapp row stayed down (not started)');
  ok((await one(`SELECT health FROM container WHERE id=$1`, [ctrRowId])).health === 'up',
     'the container row is untouched (still up, as provision left it)');
  const failRow = await one(`SELECT health, last_build_error FROM container WHERE id=$1`, [failSrvId]);
  ok(failRow.health === 'down',
     'the failed restart landed the row on terminal DOWN — never stuck on "building"');
  ok(/npm ci|npm-ci-failed|start-timeout|no-worktree/.test(failRow.last_build_error || ''),
     `the row carries WHY the restart failed (${(failRow.last_build_error || '').slice(0, 60)})`);

  // ── 4. idempotent: a second sweep with no drift restarts nothing ────────────────────────────
  console.log('\n── a clean sweep is a NO-OP (a reload must not become a loop) ──');
  const r2 = await reconcileXellEnvs({ reason: 'test-again', mode: 'real' });
  ok(r2.rewritten === 0 && r2.restarted.length === 0 && r2.restart_failed.length === 0,
     'no drift → no rewrite, no restart, no failure');
  const after2 = await probe(PORTS.live);
  ok(after2.body.includes('proof=new'), 'the live server still serves the new env');

  console.log(failures ? `\n${failures} FAILED` : '\nall good');
} catch (e) {
  console.error('TEST ERROR:', e);
  failures++;
} finally {
  // kill every fixture listener this test started (serve.pid is the map)
  for (const p of Object.values(PORTS)) {
    try {
      const pidFile = join(root, Object.keys(PORTS).find((k) => PORTS[k] === p), '.serve-pid');
      const old = Number(readFileSync(pidFile, 'utf8').trim());
      if (old) process.kill(old, 'SIGKILL');
    } catch { /* no pid file / already gone */ }
    await killLeftoverListeners(p).catch(() => {});
  }
  if (pid) await q(`DELETE FROM project WHERE id=$1`, [pid]).catch(() => {});
  await pool.end().catch(() => {});
  try { rmSync(root, { recursive: true, force: true }); } catch { /* tmp */ }
}
process.exit(failures ? 1 : 0);

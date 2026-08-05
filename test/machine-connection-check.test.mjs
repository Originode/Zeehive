// MACHINE CONNECTION CHECK — the Deploy tab's per-machine probe (checkMachineConnection): does the
// queenzee's STORED settings for a machine (its docker_ctx) actually reach that host's daemon?
//   • the docker_ctx is not configured on the queenzee → ok:false, code:'unknown-context'
//   • the context exists but the daemon is unreachable → ok:false, code:'unreachable'
//   • both hold → ok:true, reachable, container_count + latency
//   • the machine row is gone → throws (a 400 route error, not a verdict)
//
// It runs the REAL lib/machines.js against a real postgres (this xell's db-sandbox) and a FAKE
// `docker` on PATH + scratch DOCKER_CONFIG (the same harness ssh-health-dial.test.mjs uses): the
// ssh:// context dials the CLI (which we fake), the tcp:// context dials the daemon HTTP API
// (which we deliberately DON'T fake — an unreachable TCP daemon must surface as 'unreachable').
// Machines are INSERTed directly (createMachine validates the context against `docker context ls`).
process.env.PROVISION_MODE = 'simulate';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// ── fake docker CLI on PATH + scratch DOCKER_CONFIG ─────────────────────────────
const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const bin = mkdtempSync(join(tmpdir(), `mchk-${tag}-`));
const ctxDir = mkdtempSync(join(tmpdir(), `mchk-ctx-${tag}-`));
process.env.DOCKER_CONFIG = ctxDir;
const FAKE_STATE = join(bin, 'state.json');
writeFileSync(FAKE_STATE, JSON.stringify({ reachable: true, containers: [] }));

const shim = join(bin, 'fake-docker.mjs');
writeFileSync(shim, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const st = JSON.parse(readFileSync(process.env.MCHK_FAKE_STATE, 'utf8'));
const a = process.argv.slice(2);
if (!st.reachable) { process.exit(1); }
if (a.includes('ps')) {
  for (const c of st.containers || []) process.stdout.write(JSON.stringify(c) + '\\n');
  process.exit(0);
}
process.exit(0);
`);
writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash\nexec node "${shim}" "$@"\n`);
chmodSync(join(bin, 'docker'), 0o755);
process.env.MCHK_FAKE_STATE = FAKE_STATE;
process.env.PATH = `${bin}:${process.env.PATH}`;

// ── scratch context store (docker's contexts/meta/<sha256>/meta.json) ──────────
const ctxPath = (name) => join(ctxDir, 'contexts', 'meta', createHash('sha256').update(name).digest('hex'), 'meta.json');
const putCtx = (name, host) => {
  const p = ctxPath(name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ Name: name, Endpoints: { docker: { Host: host } } }), 'utf8');
};

const { checkMachineConnection } = await import('../server/src/lib/machines.js');
const { q, one, pool } = await import('../server/src/db/pool.js');

const hasDb = !!process.env.DATABASE_URL;
if (!hasDb) {
  console.log('  (no DATABASE_URL — DB-backed cases skipped)');
}

// ── fixtures ─────────────────────────────────────────────────────────────────────
const tag2 = randomUUID().slice(0, 8).replace(/-/g, '');
const reachCtx = `zt-reach-${tag2}`;    // ssh:// context whose daemon the fake CLI answers
const deadCtx  = `zt-dead-${tag2}`;     // ssh:// context whose daemon the fake CLI refuses
const tcpCtx   = `zt-tcp-${tag2}`;      // tcp:// context with NO daemon behind it
const missCtx  = `zt-miss-${tag2}`;     // no meta.json at all
putCtx(reachCtx, 'ssh://fake@reach.invalid');
putCtx(deadCtx, 'ssh://fake@dead.invalid');
putCtx(tcpCtx, 'tcp://127.0.0.1:1');    // port 1 — nothing listens, instant ECONNREFUSED

const CONTAINERS = [
  { Names: ['/zt_server_prod'], Image: 'x:y', State: 'running', Status: 'Up',
    Labels: { 'zeehive.project': 'zt', 'zeehive.role': 'server' }, Ports: [] },
  { Names: ['/zt_db_prod'], Image: 'postgres:16', State: 'running', Status: 'Up',
    Labels: { 'zeehive.project': 'zt', 'zeehive.role': 'db' }, Ports: [] },
];

let mReach, mDead, mTcp, mMiss;
try {
  console.log('\n── a reachable daemon → ok:true with endpoint + count + latency ──');
  if (hasDb) {
    mReach = (await one(`INSERT INTO machine (key, docker_ctx, enabled) VALUES ($1,$2,true) RETURNING id`,
      [`zt-reach-${tag2}`, reachCtx])).id;
    writeFileSync(FAKE_STATE, JSON.stringify({ reachable: true, containers: CONTAINERS }));
    const r = await checkMachineConnection(mReach);
    ok(r.ok === true && r.reachable === true, `ok + reachable [${r.ok}/${r.reachable}]`);
    ok(r.docker_ctx === reachCtx, `docker_ctx rides through [${r.docker_ctx}]`);
    ok(r.endpoint === 'ssh://fake@reach.invalid', `endpoint read from the context store [${r.endpoint}]`);
    ok(r.container_count === 2, `container_count from the fake ps [${r.container_count}]`);
    ok(Number.isInteger(r.latency_ms) && r.latency_ms >= 0, `latency_ms present [${r.latency_ms}]`);
  }

  console.log('\n── an unknown docker_ctx → ok:false, code unknown-context ──');
  if (hasDb) {
    mMiss = (await one(`INSERT INTO machine (key, docker_ctx, enabled) VALUES ($1,$2,true) RETURNING id`,
      [`zt-miss-${tag2}`, missCtx])).id;
    const r = await checkMachineConnection(mMiss);
    ok(r.ok === false && r.reachable === false, `ok:false + not reachable`);
    ok(r.code === 'unknown-context', `code=unknown-context [${r.code}]`);
    ok(/unknown docker context/.test(r.error || ''), `error names the missing context [${r.error}]`);
  }

  console.log('\n── a context whose daemon is down → ok:false, code unreachable ──');
  if (hasDb) {
    mDead = (await one(`INSERT INTO machine (key, docker_ctx, enabled) VALUES ($1,$2,true) RETURNING id`,
      [`zt-dead-${tag2}`, deadCtx])).id;
    writeFileSync(FAKE_STATE, JSON.stringify({ reachable: false, containers: CONTAINERS }));
    const r = await checkMachineConnection(mDead);
    ok(r.ok === false && r.code === 'unreachable', `code=unreachable [${r.code}]`);
    ok(/unreachable/.test(r.error || ''), `error says unreachable [${r.error}]`);
    ok(r.endpoint === 'ssh://fake@dead.invalid', `endpoint still reported so the setting is visible [${r.endpoint}]`);
  }

  console.log('\n── a tcp:// context with no daemon behind it → code unreachable ──');
  if (hasDb) {
    mTcp = (await one(`INSERT INTO machine (key, docker_ctx, enabled) VALUES ($1,$2,true) RETURNING id`,
      [`zt-tcp-${tag2}`, tcpCtx])).id;
    const r = await checkMachineConnection(mTcp);
    ok(r.ok === false && r.code === 'unreachable', `code=unreachable [${r.code}]`);
    ok(r.endpoint === 'tcp://127.0.0.1:1', `endpoint reported [${r.endpoint}]`);
  }

  console.log('\n── a missing machine row → throws (route 400, not a verdict) ──');
  if (hasDb) {
    let threw = null;
    try { await checkMachineConnection(randomUUID()); } catch (e) { threw = e; }
    ok(!!threw && /machine not found/.test(threw.message || ''), `throws 'machine not found'`);
  }

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  if (hasDb) {
    const ids = [mReach, mDead, mTcp, mMiss].filter(Boolean);
    if (ids.length) await q(`DELETE FROM machine WHERE id = ANY($1::uuid[])`, [ids]);
    await pool.end();
  }
  rmSync(bin, { recursive: true, force: true });
  rmSync(ctxDir, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);

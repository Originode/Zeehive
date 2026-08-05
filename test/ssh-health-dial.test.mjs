// SSH HEALTH DIAL — the queenzee's READ paths must reach a daemon whose context endpoint is
// ssh:// (mardale-prod re-pointed at ssh.omnibiz.express while the LAN route to 10.2.0.16 is
// down). The docker HTTP API cannot ride SSH, so dockerPs / listContainersDetailed dial SSH
// contexts through the `docker` CLI (`docker --context <ctx> ps --format {{json .}}`) instead of
// the HTTP path — which is what makes the prod chips show real state (up/down) instead of
// 'unknown' after the failover swap.
//
// This proves, against a FAKE `docker` on PATH and a scratch DOCKER_CONFIG:
//   1. dockerPs over an ssh:// context returns the container Map from the CLI (not a throw);
//   2. listContainersDetailed over an ssh:// context returns the detailed shape;
//   3. a TCP context still takes the HTTP path (the CLI is never invoked for it);
//   4. an ssh:// context still REFUSES in resolveContext (the action/terminal paths unchanged);
//   5. an unreachable SSH daemon (CLI exits nonzero) surfaces as null → 'unknown', never 'down'.
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// ── fake docker CLI on PATH ─────────────────────────────────────────────────────
const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const bin = mkdtempSync(join(tmpdir(), `sshdial-${tag}-`));
const ctxDir = mkdtempSync(join(tmpdir(), `sshdial-ctx-${tag}-`));
process.env.DOCKER_CONFIG = ctxDir;
const FAKE_STATE = join(bin, 'state.json');
writeFileSync(FAKE_STATE, JSON.stringify({ reachable: true }));

const shim = join(bin, 'fake-docker.mjs');
writeFileSync(shim, `#!/usr/bin/env node
import { readFileSync, appendFileSync } from 'node:fs';
const st = JSON.parse(readFileSync(process.env.FAKE_SSH_DOCKER_STATE, 'utf8'));
const a = process.argv.slice(2);
// record the invocation for the "CLI is never called for TCP" assertion
if (process.env.FAKE_SSH_DOCKER_LOG) appendFileSync(process.env.FAKE_SSH_DOCKER_LOG, a.join(' ') + '\\n');
if (!st.reachable) { process.exit(1); }
if (a.includes('ps')) {
  for (const c of st.containers || []) process.stdout.write(JSON.stringify(c) + '\\n');
  process.exit(0);
}
process.exit(0);
`);
// the wrapper makes the ESM shim executable as `docker`
writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash\nexec node "${shim}" "$@"\n`);
chmodSync(join(bin, 'docker'), 0o755);
process.env.FAKE_SSH_DOCKER_STATE = FAKE_STATE;
process.env.FAKE_SSH_DOCKER_LOG = join(bin, 'docker.log');
process.env.PATH = `${bin}:${process.env.PATH}`;

// ── scratch context store ───────────────────────────────────────────────────────
const ctxPath = (name) => join(ctxDir, 'contexts', 'meta', createHash('sha256').update(name).digest('hex'), 'meta.json');
const putCtx = (name, host) => {
  const p = ctxPath(name);
  mkdirSync(join(dirname(p)), { recursive: true });
  writeFileSync(p, JSON.stringify({ Name: name, Endpoints: { docker: { Host: host } } }), 'utf8');
};
putCtx('mardale-prod', 'ssh://mnrevelo@ssh.omnibiz.express');   // the failover shape
putCtx('tcp-ctx', 'tcp://10.2.0.16:2375');

const { dockerPs, listContainersDetailed, resolveContext } = await import('../server/src/lib/docker.js');

const CONTAINERS = [
  { Names: ['/omnibiz_server_prod'], Image: 'omnibiz-server:prod', State: 'running', Status: 'Up 3 hours',
    Labels: { 'zeehive.project': 'omnibiz', 'zeehive.role': 'server' }, Ports: [{ PublicPort: 3000, PrivatePort: 3000, Type: 'tcp' }] },
  { Names: ['/omnibiz_db_prod_v184'], Image: 'postgres:16', State: 'running', Status: 'Up 3 hours',
    Labels: { 'zeehive.project': 'omnibiz', 'zeehive.role': 'db' }, Ports: [{ PublicPort: 5432, PrivatePort: 5432, Type: 'tcp' }] },
  { Names: ['/cloudflare_tunnel'], Image: 'cloudflare/cloudflared:latest', State: 'exited', Status: 'Exited (0) 2 days ago',
    Labels: { 'zeehive.project': 'omnibiz', 'zeehive.role': 'infra' }, Ports: [] },
];

try {
  console.log('\n── dockerPs over an ssh:// context dials the CLI ──');
  writeFileSync(FAKE_STATE, JSON.stringify({ reachable: true, containers: CONTAINERS }));
  const ps = await dockerPs('mardale-prod', 5000);
  ok(ps instanceof Map && ps.size === 3, `returns the container Map from the CLI [${ps.size} containers]`);
  ok(ps.get('omnibiz_server_prod')?.state === 'running', 'state rides through');
  ok(ps.get('omnibiz_server_prod')?.project === 'omnibiz' && ps.get('omnibiz_server_prod')?.role === 'server',
     'zeehive labels ride through');
  ok(ps.get('cloudflare_tunnel')?.state === 'exited', 'non-running containers included');

  console.log('\n── listContainersDetailed over ssh:// dials the CLI ──');
  const det = await listContainersDetailed('mardale-prod', 5000);
  ok(Array.isArray(det) && det.length === 3, `returns the detailed array [${det.length}]`);
  const srv = det.find((c) => c.name === 'omnibiz_server_prod');
  ok(srv?.image === 'omnibiz-server:prod' && srv?.ports?.[0]?.public === 3000, 'image + published ports ride through');
  ok(srv?.compose_project === null && srv?.labels_present === true, 'labels_present reflects the label set');

  console.log('\n── a TCP context still takes the HTTP path (CLI never invoked) ──');
  rmSync(process.env.FAKE_SSH_DOCKER_LOG, { force: true });
  let httpErr = null;
  try { await dockerPs('tcp-ctx', 500); } catch (e) { httpErr = e; }
  // the fake CLI is the only docker on PATH; a TCP dial goes to the daemon HTTP API, which the
  // fake does NOT serve → connection refused OR the probe times out → throws either way (the
  // caller maps it to 'unknown'). The point is it did NOT go through the CLI.
  ok(httpErr && /ECONNREFUSED|refused|socket|timeout/i.test(httpErr.message || ''),
     `tcp context dials HTTP (throws, not CLI) [${httpErr?.message?.slice(0, 60)}]`);
  const log = (() => { try { return require('node:fs').readFileSync(process.env.FAKE_SSH_DOCKER_LOG, 'utf8'); } catch { return ''; } })();
  ok(!/--context tcp-ctx/.test(log), 'the CLI was never invoked for the tcp context');

  console.log('\n── ssh:// still refuses in resolveContext (action paths unchanged) ──');
  let sshErr = null;
  try { await resolveContext('mardale-prod'); } catch (e) { sshErr = e; }
  ok(!!sshErr && /SSH/.test(sshErr?.message || ''), 'resolveContext still throws on ssh://');

  console.log('\n── an unreachable SSH daemon surfaces as unknown, never down ──');
  writeFileSync(FAKE_STATE, JSON.stringify({ reachable: false, containers: CONTAINERS }));
  let unk = null;
  try { await dockerPs('mardale-prod', 5000); } catch (e) { unk = e; }
  ok(!!unk && /unreachable/.test(unk?.message || ''), 'dockerPs throws "unreachable" for a dead SSH daemon');

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  rmSync(bin, { recursive: true, force: true });
  rmSync(ctxDir, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);

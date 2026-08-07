// TKT-136 defect #2: `zee build --wait` must not report UP while the published port refuses.
//
// THE DEFECT: getBuildStatus (what --wait/--watch polls) treated health='up' + matching
// last_build_commit as "serving your HEAD". For process roles, health came from a localhost
// probe (ticket #8) while the row's published host:port was the dev MACHINE's ip — a host that
// does not run the process. Live 2026-08-06: --wait said UP @ 9bdb5142 while
// http://10.2.0.16:4853/health returned 000 from the cage.
//
// THE FIX (three pieces, tested here without db/docker):
//   1. processRoleReachableHost() is the CXELL_API_BASE hostname — where the process actually is
//      reachable from a cage — never a machine host_ip.
//   2. probePublishedRole() asks ONLY the published url (no localhost shortcut). A live process
//      on localhost with a wrong/dead published url is DOWN for --wait.
//   3. processBootLogTail() returns the last lines of .zeehive-<role>.log so --wait can surface
//      why the port never answered.
//
// Real HTTP + a temp log file. No database, no docker.
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  processRoleReachableHost, processRolePublishedUrl,
  processProbeUrls, probeProcessRole,
  publishedUrl, publishedProbeTarget, probePublishedRole,
} from '../server/src/queenzee/containers.js';
import { processBootLogTail } from '../server/src/lib/build.js';
import { config } from '../server/src/config.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const listen = (server, host = '127.0.0.1') =>
  new Promise((res) => server.listen(0, host, () => res(server.address().port)));

const servers = [];
const tmpDirs = [];
try {
  console.log('\n── 1. process-role published host is CXELL_API_BASE, not a machine ip ──');
  let expectedHost = '127.0.0.1';
  try { expectedHost = new URL(config.cxellApiBase).hostname || '127.0.0.1'; } catch { /* */ }
  ok(processRoleReachableHost() === expectedHost,
     `processRoleReachableHost() === ${expectedHost} (from CXELL_API_BASE=${config.cxellApiBase})`);
  ok(processRolePublishedUrl(4836) === `http://${expectedHost}:4836`,
     'processRolePublishedUrl stamps that host + the role port');
  ok(!/^10\./.test(processRoleReachableHost()) || expectedHost.startsWith('10.'),
     'does not invent a LAN machine ip when CXELL_API_BASE is a docker/service name');

  console.log('\n── 2. published probe target prefers /health for server roles ──');
  ok(publishedUrl({ url: 'http://zeehive_server:4836' }) === 'http://zeehive_server:4836',
     'publishedUrl prefers the stamped url');
  ok(publishedUrl({ host: 'zeehive_server', host_port: 4836 }) === 'http://zeehive_server:4836',
     'publishedUrl builds from host:host_port when url is absent');
  ok(publishedProbeTarget({ role: 'server', url: 'http://zeehive_server:4836' })
       === 'http://zeehive_server:4836/health',
     'server role probes /health on the published url');
  ok(publishedProbeTarget({ role: 'webapp', url: 'http://zeehive_server:5336' })
       === 'http://zeehive_server:5336',
     'webapp role probes the url root (vite has no /health)');

  console.log('\n── 3. HEALTHY path: published url answers → probePublishedRole is up ──');
  const up = http.createServer((q, r) => {
    if (q.url === '/health') { r.end(JSON.stringify({ ok: true })); return; }
    r.statusCode = 404; r.end('no');
  });
  servers.push(up);
  const upPort = await listen(up);
  // Stamp url as 127.0.0.1 so the published probe is real HTTP against this process.
  const healthy = { role: 'server', host_port: upPort, url: `http://127.0.0.1:${upPort}`, host: '127.0.0.1' };
  ok(await probePublishedRole(healthy, { timeout: 2000 }) === 'up',
     'a process answering /health on its published url is UP for --wait');
  ok(await probeProcessRole(healthy, { timeout: 2000 }) === 'up',
     'and the monitor probe (localhost-first) still agrees');

  console.log('\n── 4. REFUSED-PORT path: localhost alive, published url dead → --wait DOWN ──');
  // Reproduces the live defect: process answers on the queenzee's localhost, published binding
  // points at an unroutable host (the old machine-ip stamp). Monitor can say up; --wait must not.
  const onlyLocal = http.createServer((_q, r) => r.end('ok'));
  servers.push(onlyLocal);
  const localPort = await listen(onlyLocal);
  const lie = {
    role: 'server',
    host_port: localPort,
    // 10.255.255.1 is TEST-NET-ish unroutable — stands in for the dev machine ip that does not
    // serve this port (the same stand-in process-role-health.test.mjs uses).
    url: `http://10.255.255.1:${localPort}`,
    host: '10.255.255.1',
  };
  ok(processProbeUrls(lie)[0] === `http://127.0.0.1:${localPort}`,
     'monitor still asks localhost first (ticket #8, kept)');
  ok(await probeProcessRole(lie, { timeout: 2000 }) === 'up',
     'monitor reads UP from localhost — the process is alive');
  ok(await probePublishedRole(lie, { timeout: 2000 }) === 'down',
     'published probe reads DOWN — the binding refuses (the defect, fenced)');
  // serving_head contract (mirrors getBuildStatus): published must be up.
  const wouldServeHead = (health, published_health, hot, same) =>
    health === 'up' && published_health === 'up' && !hot && same;
  ok(wouldServeHead('up', 'up', false, true) === true, 'healthy path: serving_head is true');
  ok(wouldServeHead('up', 'down', false, true) === false,
     'refused published port: serving_head is false even if monitor health is up');

  console.log('\n── 5. nothing listening on published url is still DOWN ──');
  const dead = http.createServer((_q, r) => r.end('ok'));
  servers.push(dead);
  const deadPort = await listen(dead);
  await new Promise((res) => dead.close(res));
  ok(await probePublishedRole(
    { role: 'server', host_port: deadPort, url: `http://127.0.0.1:${deadPort}` },
    { timeout: 2000 },
  ) === 'down', 'a role with no process behind the published url is DOWN');

  console.log('\n── 6. a 5xx on the published url is not "up" ──');
  const broken = http.createServer((_q, r) => { r.statusCode = 502; r.end('bad'); });
  servers.push(broken);
  const brokenPort = await listen(broken);
  ok(await probePublishedRole(
    { role: 'server', host_port: brokenPort, url: `http://127.0.0.1:${brokenPort}` },
    { timeout: 2000 },
  ) === 'down', 'published 502 is DOWN (same rule as the monitor probe)');

  console.log('\n── 7. boot-log tail surfaces the last lines for --wait ──');
  const dir = mkdtempSync(join(tmpdir(), 'zeehive-bootlog-'));
  tmpDirs.push(dir);
  writeFileSync(join(dir, '.zeehive-server.log'),
    'line1\nline2\nError: listen EADDRINUSE\nport never answered\n');
  const tail = processBootLogTail(dir, 'server', { lines: 2 });
  ok(tail === 'Error: listen EADDRINUSE\nport never answered',
     'processBootLogTail returns the last N lines of .zeehive-<role>.log');
  ok(processBootLogTail(dir, 'webapp') === null,
     'missing log file → null (no throw)');
  ok(processBootLogTail(null, 'server') === null, 'no worktree → null');
} finally {
  for (const s of servers) { try { s.close(); } catch { /* */ } }
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

// CAGE API ADDRESS (ticket #94) — the injected ZEEHIVE_API must be a name a cage can trust, and an
// unresolvable one must be LEGIBLE rather than read as a dead fleet.
//
// THE BUG: ZEEHIVE_API=http://zeehive_server:4700 (the compose service name) was injected into every
// cage and FLAPPED — the name does not resolve while the queenzee container is being recreated
// (getaddrinfo ENOTFOUND), and from a sealed container that DNS error reads as "the fleet is down".
// The CLI was only "immune" because it defaulted to host.docker.internal when the env was unset.
//
// THE FIX, asserted here:
//   1. every cxell is created with host.docker.internal:host-gateway in its hosts (cxellRunArgs), so
//      the stable address resolves on native Linux too — Docker Desktop adds it automatically;
//   2. config exposes cxellApiFallback (the second name), defaulting to the stable address;
//   3. the CLI retries ZEEHIVE_API_FALLBACK on a network error and SAYS SO — an unresolvable primary
//      is a NAME problem, not a dead queenzee;
//   4. when both fail, the CLI's error names the stable address and says "the fleet is not down".
//
// Pure + one real HTTP mock. No database, no docker. The CLI child is spawned ASYNC so this test's
// own event loop (which owns the mock server) stays free to answer it.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'zee');
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const listen = (server) => new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
const servers = [];

// Run `node scripts/zee <args>` with env, returning { status, stdout, stderr }. Async so a mock
// server in THIS process can answer the child's fallback requests.
function runCli(args, env) {
  return new Promise((resolve2) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8',
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => { child.kill('SIGKILL'); }, 15000);
    child.on('close', (code) => { clearTimeout(t); resolve2({ status: code, stdout: out, stderr: err }); });
  });
}

// A tiny mock queenzee: answers every path with 200 {ok:true} and records that it was hit.
let mockHits = 0;
const mock = http.createServer((_q, r) => { mockHits++; r.writeHead(200, { 'content-type': 'application/json' }); r.end('{"ok":true,"mock":true}'); });
servers.push(mock);
const mockPort = await listen(mock);

try {
  console.log('\n── 1. every cxell resolves the stable host.docker.internal (cxellRunArgs) ──');
  const { cxellRunArgs } = await import('../server/src/lib/cxell.js');
  const run = cxellRunArgs({ name: 'cage-api-test', net: 'zee-hive-net', port: 2222, img: 'i', xellId: 'x' });
  ok(run.includes('--add-host') && run.join(' ').includes('host.docker.internal:host-gateway'),
     'cxellRunArgs adds --add-host host.docker.internal:host-gateway — native Linux cages get the stable name');
  ok(run[0] === 'run' && run.includes('--network') && run.includes('NET_ADMIN'),
     'and the cage is still created exactly as before otherwise');

  console.log('\n── 2. config exposes the fallback address ──');
  const { config } = await import('../server/src/config.js');
  ok(config.cxellApiFallback === 'http://host.docker.internal:4700',
     `cxellApiFallback defaults to the stable address (got ${config.cxellApiFallback})`);
  ok(config.cxellApiBase === 'http://host.docker.internal:4700',
     `cxellApiBase is the stable address by default (got ${config.cxellApiBase})`);

  console.log('\n── 3. the CLI retries the fallback on a network error and says so ──');
  // Primary = 127.0.0.1:1 (connection refused, instant). Fallback = the mock. The CLI must succeed
  // via the fallback, print the legible notice, and exit 0.
  const fallbackRun = await runCli(['status'], {
    ZEEHIVE_API: 'http://127.0.0.1:1',
    ZEEHIVE_API_FALLBACK: `http://127.0.0.1:${mockPort}`,
    ZEEHIVE_XELL_TOKEN: 'cage-api-test-token',
  });
  ok(fallbackRun.status === 0, `fallback run exits 0 (got ${fallbackRun.status})`);
  ok(mockHits > 0, `the fallback (mock) was actually hit (${mockHits} request(s))`);
  ok(/unreachable/.test(fallbackRun.stderr) && /Fell back/.test(fallbackRun.stderr),
     'the notice names the unreachable primary and the fallback');
  ok(/"mock":\s*true/.test(fallbackRun.stdout), 'the answer came from the fallback server');

  console.log('\n── 4. when both fail, the error is LEGIBLE (not a dead fleet) ──');
  const bothFail = await runCli(['status'], {
    ZEEHIVE_API: 'http://this-name-does-not-exist.invalid:4700',
    ZEEHIVE_API_FALLBACK: 'http://also-bad.invalid:4700',
    ZEEHIVE_XELL_TOKEN: 'cage-api-test-token',
  });
  ok(bothFail.status !== 0, `both-fail exits non-zero (got ${bothFail.status})`);
  ok(/did not resolve/.test(bothFail.stderr) && /this-name-does-not-exist\.invalid/.test(bothFail.stderr),
     'the error names the address that did not resolve');
  ok(/host\.docker\.internal:4700/.test(bothFail.stderr) && /fleet is not down/.test(bothFail.stderr),
     'and points at the stable address while saying the fleet is not down');

  console.log('\n── 5. the primary STABLE address fails legibly when unreachable ──');
  // Primary === fallback (host.docker.internal on a dead port): the CLI must NOT retry the same
  // address pointlessly, and the failure must name the queenzee address — a legible
  // connection-refused, not a bare DNS stack that reads as a dead fleet.
  const stableDead = await runCli(['status'], {
    ZEEHIVE_API: 'http://host.docker.internal:1',
    ZEEHIVE_API_FALLBACK: 'http://host.docker.internal:1',
    ZEEHIVE_XELL_TOKEN: 'cage-api-test-token',
  });
  ok(stableDead.status !== 0, `stable dead exits non-zero (got ${stableDead.status})`);
  ok(/could not reach the queenzee/.test(stableDead.stderr),
     'and the failure names the queenzee address rather than throwing a bare DNS error');
} finally {
  for (const s of servers) s.close();
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

// COMPOSE × CODE PORTS (TKT-179) — the lockstep rule in docker-compose.prod.yml's header is
// "bootstrap.yml and prod.yml describe ONE stack; any port/name/extra_hosts change lands in both".
// Until this test existed that rule was enforced by NOTHING but a comment asking humans to
// remember — which is how the gateway's port (4701) was minted into every cage's provider base-URLs
// while NEITHER compose file published it, and every provider failed wearing the VENDOR's name for
// 13h (2026-08-23).
//
// What this covers (pure; no db, no docker):
//   • the gateway port the CODE hands out (server/src/config.js gatewayPort / server/src/lib/gateway.js
//     GATEWAY_PORT) is published by the server service's ports: in BOTH docker/zeehive/
//     docker-compose.prod.yml AND docker-compose.bootstrap.yml — host AND container sides, because a
//     cage dials host.docker.internal:<port> and the gateway listens inside the container on the
//     same port;
//   • the API port (config.port, 4700 — CXELL_API_BASE) is covered too, as the equally-checkable
//     sibling: the same drift that hid the gateway would hide it, and it is read from the same
//     config object;
//   • the two code sources for the gateway port agree (config.gatewayPort === GATEWAY_PORT).
//
// The port is READ FROM THE CODE, never retyped. The compose paths can be overridden
// (COMPOSE_PROD / COMPOSE_BOOTSTRAP) so the test can be pointed at a scratch copy — the way this
// file is verified green without ever editing the real compose files.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// The compose files describe the DEFAULT install: neither sets PORT / GATEWAY_PORT in the server
// environment, so the CODE DEFAULTS (4700 / 4701) are what an install from these files hands out.
// This cage's .zeehive.env sets PORT=4801 for its own spinoff server — irrelevant here, and it
// would make the test demand 4801 in the PROD files. Clear both so config.js falls back to the
// defaults before any module reads them.
process.env.PORT = '';
process.env.GATEWAY_PORT = '';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROD_COMPOSE = process.env.COMPOSE_PROD || join(ROOT, 'docker/zeehive/docker-compose.prod.yml');
const BOOTSTRAP_COMPOSE = process.env.COMPOSE_BOOTSTRAP || join(ROOT, 'docker-compose.bootstrap.yml');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const { config } = await import('../server/src/config.js');
const { GATEWAY_PORT } = await import('../server/src/lib/gateway.js');

// Parse a compose port spec into { host, container }, each { start, end } or null.
//   "4700"                 → container 4700, host null (docker picks a random host port)
//   "4700:4700"            → host 4700, container 4700
//   "127.0.0.1:4700:4700"  → host 4700 (IP ignored), container 4700
//   "5300-5389:5300-5389"  → host 5300–5389, container 5300–5389
function parsePortSpec(spec) {
  const parts = String(spec).trim().split(':');
  let host = null, container = null;
  if (parts.length === 1) {
    container = parts[0];
  } else if (parts.length === 2) {
    [host, container] = parts;
  } else if (parts.length === 3) {
    host = parts[1]; container = parts[2];
  }
  const parseSide = (s) => {
    if (!s) return null;
    const m = /^(\d+)(?:-(\d+))?$/.exec(s.trim());
    if (!m) return null;
    return { start: Number(m[1]), end: Number(m[2] ?? m[1]) };
  };
  return { host: parseSide(host), container: parseSide(container) };
}

const inRange = (r, port) => !!r && port >= r.start && port <= r.end;
// A port is "published" when the HOST side carries it (that is the address a cage dials —
// host.docker.internal:<port>) AND the CONTAINER side carries it (that is where the process must
// be listening). A one-sided mapping (e.g. 4701:4700) forwards to the wrong listener.
const published = (specs, port) => specs.some((s) => {
  const p = parsePortSpec(s);
  return inRange(p.host, port) && inRange(p.container, port);
});

function serverPorts(composeFile) {
  const doc = parse(readFileSync(composeFile, 'utf8'));
  return (doc?.services?.server?.ports || []).map(String);
}

console.log('\n── the ports the code hands out ──');
ok(config.gatewayPort === GATEWAY_PORT,
   `config.gatewayPort (${config.gatewayPort}) agrees with GATEWAY_PORT (${GATEWAY_PORT})`);
const required = [
  { port: GATEWAY_PORT, label: 'gateway' },
  { port: config.port, label: 'API (CXELL_API_BASE)' },
];

const files = [
  { name: 'docker/zeehive/docker-compose.prod.yml', path: PROD_COMPOSE },
  { name: 'docker-compose.bootstrap.yml', path: BOOTSTRAP_COMPOSE },
];

for (const file of files) {
  console.log(`\n── ${file.name} publishes the code ports ──`);
  const specs = serverPorts(file.path);
  ok(Array.isArray(specs) && specs.length > 0,
     `server service has a ports: block [${specs.join(', ') || 'none'}]`);
  for (const { port, label } of required) {
    ok(published(specs, port),
       `${file.name} publishes the ${label} port ${port} (server ports: ${JSON.stringify(specs)})`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S) ✗` : '\nALL PASSED ✓');
process.exit(failures ? 1 : 0);

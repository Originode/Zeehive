// NETBIRD CONTROL-PLANE COMPOSE (docs/netbird-mesh-plan.md §3.1) — the self-hosted NetBird
// services (management / signal / relay / dashboard) added to BOTH queenzee compose files behind
// the `mesh` PROFILE, so an unscoped `up -d` boots the exact pre-mesh stack.
//
// This is a CONFIG-LEVEL parse test, the repo's pattern for compose authorship: it parses and
// asserts the YAML, and says plainly that LIVE STAND-UP IS A HUMAN'S DEPLOY (docker/zeehive/
// README.md → "The NetBird mesh control plane") — it deliberately does not run NetBird.
//
// Covered:
//   • both files (bootstrap + prod) define the four §3.1 services, all profile-gated to `mesh`
//     (never started by an unscoped up), with the same container names + published ports in lockstep
//   • the server service still publishes the code ports (4700 / 4701 / 5300-5389) — the TKT-179
//     gateway line is never touched by the mesh addition
//   • the mesh services publish NO port inside any queenzee/spin reserved range
//   • the management API/gRPC ports the code's lib/netbird.js expects are published
//   • the named datastore volumes are declared (netbird_management_data is the ONE-WAY DOOR the
//     README tells humans to back up)
//   • the server env passes NETBIRD_API_URL / NETBIRD_API_TOKEN through EMPTY by default and
//     MESH_DOMAIN defaulting to config.meshDomain → mesh DISABLED unless a human opts in
//     (the standing invariant: a mesh-less queenzee behaves exactly as before)
//   • every ${…} the mesh block introduces has a `:-` default (bare `config -q` with no env
//     must still resolve)
//
// RUN:  node test/netbird-compose.test.mjs
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  { name: 'docker-compose.bootstrap.yml', path: resolve(ROOT, 'docker-compose.bootstrap.yml') },
  { name: 'docker/zeehive/docker-compose.prod.yml', path: resolve(ROOT, 'docker/zeehive/docker-compose.prod.yml') },
];

// The compose files describe the DEFAULT install: they never set PORT/GATEWAY_PORT in the server
// environment, so the CODE DEFAULTS (4700/4701) are what the files must publish. This worktree's
// own .zeehive.env sets PORT=4800s for its spinoff server — irrelevant here, and it would make the
// test demand that spinoff port in the PROD files. Clear both so config.js falls back to the
// defaults before any module reads them (the same guard the TKT-179 lockstep test uses).
process.env.PORT = '';
process.env.GATEWAY_PORT = '';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const section = (t) => console.log(`\n── ${t} ──`);

process.env.MESH_DOMAIN = '';
const { config } = await import('../server/src/config.js');
const MESH_DOMAIN_DEFAULT = config.meshDomain;

const MESH_SERVICES = ['netbird-management', 'netbird-signal', 'netbird-relay', 'netbird-dashboard'];
// Every port range a mesh service may never step on (queenzee API/gateway, web, spin previews,
// the host-era meta-db on 5445). Gateway/API are read from config, the rest are the file's own.
const RESERVED = [
  { start: config.port, end: config.port, why: 'the API port' },
  { start: config.gatewayPort, end: config.gatewayPort, why: 'the LLM gateway port (TKT-179)' },
  { start: 5180, end: 5180, why: 'the web dashboard' },
  { start: 5300, end: 5389, why: 'the xell webapp preview range' },
  { start: 5445, end: 5445, why: 'the host-era meta-db' },
];

// Parse a compose port spec into { host, container } sides ({start,end} or null). Same shape the
// TKT-179 lockstep test uses. A mesh service may publish an interpolated side
// (`${NETBIRD_MGMT_API_PORT:-33074}`): the default literal is what an install without the .env
// actually binds, so unwrap every `${VAR:-default}` FIRST — it embeds a colon before the default
// that would otherwise break the host:container split.
function parsePortSpec(spec) {
  const flat = String(spec).replace(/\$\{[A-Z0-9_]+:-([^}]+)\}/g, '$1').trim();
  const parts = flat.split(':');
  let host = null, container = null;
  if (parts.length === 1) container = parts[0];
  else if (parts.length === 2) { [host, container] = parts; }
  else if (parts.length === 3) { host = parts[1]; container = parts[2]; }
  const parseSide = (s) => {
    if (!s) return null;
    const m = /^(\d+)(?:-(\d+))?$/.exec(s.trim());
    if (!m) return null;
    return { start: Number(m[1]), end: Number(m[2] ?? m[1]) };
  };
  return { host: parseSide(host), container: parseSide(container) };
}
const inRange = (r, port) => !!r && port >= r.start && port <= r.end;
const overlapsReserved = (p) => RESERVED.some((r) =>
  (p.host && inRange(p.host, r.start)) || (p.container && inRange(p.container, r.start)));

// Assert every ${…} compose interpolation in a block carries a `:-` default (bare config -q).
function assertInterpolationsDefaulted(text, ctx) {
  const re = /\$\{([A-Z0-9_]+)([^}]*)\}/g;
  let m, bad = 0;
  while ((m = re.exec(text))) {
    const rest = m[2] || '';
    if (!rest.startsWith(':-')) { bad++; ok(false, `${ctx}: ${m[0]} has no ':-' default (a bare config -q would fail)`); }
  }
  if (!bad) ok(true, `${ctx}: every \${…} introduced carries a ':-' default (bare config -q resolves)`);
}

section('the mesh stays OFF by default — profile-gated, env-empty passthrough');
for (const file of FILES) {
  const raw = readFileSync(file.path, 'utf8');
  const doc = parse(raw);
  const meshBlockStart = raw.indexOf('netbird-management:');
  ok(meshBlockStart > -1, `${file.name} defines the mesh control-plane block`);
  if (meshBlockStart === -1) continue;

  for (const name of MESH_SERVICES) {
    const svc = doc.services?.[name];
    ok(!!svc, `${file.name}: service '${name}' exists`);
    ok(!!svc && Array.isArray(svc.profiles) && svc.profiles.includes('mesh'),
       `${file.name}: '${name}' is gated behind the mesh profile (an unscoped up never starts it)`);
  }
  ok(!('mesh' in (doc.services || {})),
     `${file.name}: there is no 'mesh' service — the CONTROL PLANE is not a spin sidecar`);
  assertInterpolationsDefaulted(raw.slice(meshBlockStart), `${file.name} mesh block`);

  const env = doc.services?.server?.environment || {};
  ok('NETBIRD_API_URL' in env && env.NETBIRD_API_URL === '${NETBIRD_API_URL:-}'
     && 'NETBIRD_API_TOKEN' in env && env.NETBIRD_API_TOKEN === '${NETBIRD_API_TOKEN:-}',
     `${file.name}: server passes NETBIRD_API_URL/TOKEN through EMPTY by default — mesh disabled unless a human opts in`);
  ok(env.MESH_DOMAIN === `\${MESH_DOMAIN:-${MESH_DOMAIN_DEFAULT}}`,
     `${file.name}: MESH_DOMAIN defaults to config.meshDomain ('${MESH_DOMAIN_DEFAULT}')`);
}

section('the TKT-179 gateway/API/server ports are untouched');
for (const file of FILES) {
  const doc = parse(readFileSync(file.path, 'utf8'));
  const specs = (doc.services?.server?.ports || []).map(String);
  const published = (port) => specs.some((s) => {
    const p = parsePortSpec(s);
    return inRange(p.host, port) && inRange(p.container, port);
  });
  ok(published(config.gatewayPort), `${file.name} still publishes the gateway port ${config.gatewayPort} (TKT-179)`);
  ok(published(config.port), `${file.name} still publishes the API port ${config.port}`);
  ok(specs.some((s) => parsePortSpec(s).host?.start === 5300 && parsePortSpec(s).host?.end === 5389),
     `${file.name} still publishes the 5300-5389 preview range`);
}

section('the control plane publishes its own ports — and no reserved range');
// Cross-file lockstep: identical service names AND identical host port pairs in both files.
const byFile = {};
for (const file of FILES) {
  const doc = parse(readFileSync(file.path, 'utf8'));
  const meshPorts = {};
  for (const name of MESH_SERVICES) {
    const svc = doc.services?.[name];
    if (!svc) { meshPorts[name] = []; continue; }
    meshPorts[name] = (svc.ports || []).map(String);
    ok(/netbirdio\/(management|signal|relay|dashboard)/.test(svc.image || ''),
       `${file.name}: '${name}' uses the official netbirdio image (${svc.image})`);
    ok(svc.container_name === `zeehive_netbird_${name.replace('netbird-', '')}`,
       `${file.name}: '${name}' has the expected container_name (${svc.container_name})`);
    for (const spec of meshPorts[name]) {
      const p = parsePortSpec(spec);
      ok(!overlapsReserved(p),
         `${file.name}: '${name}' port '${spec}' does not collide with a queenzee/spin reserved range`);
    }
  }
  byFile[file.name] = meshPorts;
}
const [a, b] = FILES;
for (const name of MESH_SERVICES) {
  ok(JSON.stringify(byFile[a.name][name]) === JSON.stringify(byFile[b.name][name]),
     `'${name}' publishes the SAME ports in both files (${byFile[a.name][name].join(', ') || 'none'})`);
}

section('management ports + datastore volumes (the one-way door)');
for (const file of FILES) {
  const doc = parse(readFileSync(file.path, 'utf8'));
  const mgmt = doc.services?.['netbird-management'] || {};
  const mgmtPorts = (mgmt.ports || []).map(String);
  ok(mgmtPorts.some((s) => parsePortSpec(s).host?.start === 33074 && parsePortSpec(s).container?.start === 443),
     `${file.name}: management REST API publishes a host 33074 → container 443 pair (the REST lib/netbird.js speaks)`);
  ok(mgmtPorts.some((s) => parsePortSpec(s).host?.start === 33073 && parsePortSpec(s).container?.start === 33073),
     `${file.name}: management gRPC publishes a 33073 pair (what agents dial)`);
  ok((mgmt.volumes || []).some((v) => /netbird_management_data:\/var\/lib\/netbird/.test(v)),
     `${file.name}: management mounts the netbird_management_data datastore`);
  const vols = doc.volumes || {};
  ok(!!vols.netbird_management_data && vols.netbird_management_data?.name === 'netbird_management_data'
     && !!vols.netbird_signal_data && vols.netbird_signal_data?.name === 'netbird_signal_data',
     `${file.name}: the named datastore volumes are declared explicitly (bare-name mountable by scripts)`);
}

section('live stand-up is a human deploy (documented, not verified here)');
const readme = readFileSync(resolve(ROOT, 'docker/zeehive/README.md'), 'utf8');
ok(/The NetBird mesh control plane/.test(readme), 'README documents the section');
ok(/one-way door/.test(readme) && /netbird_management_data/.test(readme),
   'README names the management datastore the one-way door to back up');
ok(/live stand-up is a human['’]s deploy/.test(readme), 'README says plainly that live stand-up is a human deploy');
ok(/netbird\/management\.json\.example/.test(readme), 'README points at the shipped management.json.example');
const example = JSON.parse(readFileSync(resolve(ROOT, 'docker/zeehive/netbird/management.json.example'), 'utf8'));
ok(!!example && Array.isArray(example.Relay?.Addresses) && typeof example.DataStoreEncryptionKey === 'string',
   'management.json.example is valid JSON with the endpoints a human edits');

console.log(failures ? `\n${failures} FAILURE(S) ✗` : '\nALL PASSED ✓');
process.exit(failures ? 1 : 0);

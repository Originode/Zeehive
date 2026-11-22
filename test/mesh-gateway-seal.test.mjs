// THE MESH ROUTE A CXELL IS SEALED WITH (docs/netbird-mesh-plan.md §3.5) — the seam between
// `cxell-firewall.sh`'s `ip route replace 100.64.0.0/10 via $MESH_GATEWAY_IP` and the queenzee
// that has to SUPPLY that address. `docker exec` inherits nothing from the queenzee's own
// environment, so without this the script's mesh branch can never fire on any install.
//
// No docker and no postgres: the resolver takes an injected `inspect` and sealCxell an injected
// `exec`, the same bounded-adapter shape lib/netbird.js uses.
//
// Covered:
//   • parseGatewayIp (PURE): a dotted quad only — docker's `<none>`, an empty answer or garbage
//     is "no gateway", never a half-true route
//   • mesh DISABLED → no inspect happens at all and the seal exec args are byte-identical to
//     today's (the standing invariant: a mesh-less queenzee behaves exactly as before)
//   • mesh ENABLED → the gateway container's zee-hive-net address is read on the CAGE'S OWN
//     context (zee-hive-net is per host) and rides as -e MESH_GATEWAY_IP
//   • a machine with NO gateway container (inspect throws) seals WITHOUT a mesh route
//   • config.meshGatewayIp overrides and skips the inspect entirely (explicit operator answer)
//   • sealCxell: the block list still rides, an explicit meshGatewayIp:null seals with no route,
//     and the script path/root exec are unchanged
//   • cxell-firewall.sh (static) reads MESH_GATEWAY_IP and installs the route with `replace`
//
// RUN:  node test/mesh-gateway-seal.test.mjs
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../server/src/config.js';
import {
  parseGatewayIp, resolveMeshGatewayIp, sealCxell, MESH_GATEWAY_CONTAINER, MESH_GATEWAY_NETWORK,
} from '../server/src/lib/cxell.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

const meshOn = () => { config.netbirdApiUrl = 'http://mesh.invalid'; config.netbirdApiToken = 't'; };
const meshOff = () => { config.netbirdApiUrl = null; config.netbirdApiToken = null; };
meshOff();
config.meshGatewayIp = null;

// A fake `docker inspect` with a call log: answers per context, so "the cage's own machine" is
// assertable without a daemon.
function fakeInspect(byCtx) {
  const calls = [];
  const fn = async (ctx) => {
    calls.push(ctx);
    const answer = byCtx[ctx ?? 'default'];
    if (answer instanceof Error) throw answer;
    return answer ?? '';
  };
  fn.calls = calls;
  return fn;
}
// A fake `docker exec` with a call log, standing in for dk() in sealCxell.
function fakeExec(out = 'cxell egress: default ALLOW; blocked prod db(s): none') {
  const calls = [];
  const fn = async (ctx, args) => { calls.push({ ctx, args }); return { out }; };
  fn.calls = calls;
  return fn;
}

section('parseGatewayIp — a dotted quad, or nothing');
ok(parseGatewayIp('172.19.0.5') === '172.19.0.5', 'a plain address is the answer');
ok(parseGatewayIp(' 172.19.0.5 \n') === '172.19.0.5', 'docker\'s trailing newline is trimmed');
ok(parseGatewayIp('<none>') === null, 'docker\'s <none> is NOT an address');
ok(parseGatewayIp('') === null, 'an absent container prints nothing → no gateway');
ok(parseGatewayIp(null) === null, 'null → no gateway');
ok(parseGatewayIp('zeehive-gw') === null, 'a hostname is not a route (never half-true)');

section('mesh DISABLED — no inspect, and the seal exec is byte-identical to today\'s');
{
  meshOff();
  const inspect = fakeInspect({ 'live-ctx': '172.19.0.5' });
  const ip = await resolveMeshGatewayIp('live-ctx', { inspect });
  ok(ip === null, 'a mesh-less queenzee resolves no gateway');
  ok(inspect.calls.length === 0, 'and makes NO docker call at all');

  const exec = fakeExec();
  await sealCxell({ ctx: 'live-ctx', name: 'cxell_slug', blockTcp: ['10.2.0.16:5432'], exec });
  const { args } = exec.calls[0];
  ok(JSON.stringify(args) === JSON.stringify([
    'exec', '-u', '0', '-e', 'CXELL_BLOCK_TCP=10.2.0.16:5432',
    'cxell_slug', 'bash', '/usr/local/bin/cxell-firewall.sh']),
    'the exec args are exactly the pre-mesh ones (block list only)');
}

section('mesh ENABLED — the gateway on the CAGE\'S OWN machine rides as -e MESH_GATEWAY_IP');
{
  meshOn();
  const inspect = fakeInspect({ 'live-ctx': '172.19.0.5\n', 'other-ctx': '' });
  ok(await resolveMeshGatewayIp('live-ctx', { inspect }) === '172.19.0.5',
     'the gateway container\'s zee-hive-net address is the answer');
  ok(inspect.calls.length === 1 && inspect.calls[0] === 'live-ctx',
     'resolved on the cage\'s own context — zee-hive-net is per docker host');
  ok(await resolveMeshGatewayIp('other-ctx', { inspect }) === null,
     'a machine with no gateway gets no mesh route (legacy ports stay the answer)');

  const exec = fakeExec();
  await sealCxell({ ctx: 'live-ctx', name: 'cxell_slug', blockTcp: ['10.2.0.16:5432'],
                    meshGatewayIp: '172.19.0.5', exec });
  ok(JSON.stringify(exec.calls[0].args) === JSON.stringify([
    'exec', '-u', '0', '-e', 'CXELL_BLOCK_TCP=10.2.0.16:5432', '-e', 'MESH_GATEWAY_IP=172.19.0.5',
    'cxell_slug', 'bash', '/usr/local/bin/cxell-firewall.sh']),
    'the seal passes the address the script\'s mesh branch reads');

  const exec2 = fakeExec();
  await sealCxell({ ctx: 'live-ctx', name: 'cxell_slug', meshGatewayIp: '172.19.0.5', exec: exec2 });
  ok(JSON.stringify(exec2.calls[0].args) === JSON.stringify([
    'exec', '-u', '0', '-e', 'MESH_GATEWAY_IP=172.19.0.5',
    'cxell_slug', 'bash', '/usr/local/bin/cxell-firewall.sh']),
    'an empty block list still seals — the mesh env is additive, never a replacement');

  const exec3 = fakeExec();
  await sealCxell({ ctx: 'live-ctx', name: 'cxell_slug', meshGatewayIp: null, exec: exec3 });
  ok(!exec3.calls[0].args.some((a) => String(a).startsWith('MESH_GATEWAY_IP')),
     'an explicit meshGatewayIp:null seals with no mesh route (the caller\'s decision stands)');
}

section('a machine whose daemon refuses the inspect is ORDINARY, not a failure');
{
  meshOn();
  const inspect = fakeInspect({ 'live-ctx': new Error('No such object: zeehive_mesh_gateway') });
  ok(await resolveMeshGatewayIp('live-ctx', { inspect }) === null,
     'a throwing inspect degrades to no mesh route instead of failing the seal');
}

section('config.meshGatewayIp — the explicit operator override wins, without a docker call');
{
  meshOff();
  config.meshGatewayIp = '10.9.9.9';
  const inspect = fakeInspect({ 'live-ctx': '172.19.0.5' });
  ok(await resolveMeshGatewayIp('live-ctx', { inspect }) === '10.9.9.9',
     'the override answers even on a mesh-less queenzee (setting it IS the opt-in)');
  ok(inspect.calls.length === 0, 'and no inspect is made');
  config.meshGatewayIp = 'not-an-ip';
  ok(await resolveMeshGatewayIp('live-ctx', { inspect }) === null,
     'a garbage override is refused like any other non-address');
  config.meshGatewayIp = null;
  meshOff();
}

section('cxell-firewall.sh (static) — the branch this seam feeds');
{
  const sh = readFileSync(resolve(ROOT, 'docker/zeehive/cxell-firewall.sh'), 'utf8');
  ok(/MESH_GATEWAY_IP=\$\{MESH_GATEWAY_IP:-\}/.test(sh), 'the script reads MESH_GATEWAY_IP, defaulting empty');
  ok(/ip route replace "\$MESH_CIDR" via "\$MESH_GATEWAY_IP"/.test(sh),
     'and installs the route with `replace` (idempotent across re-seals)');
  ok(/if \[ -n "\$MESH_GATEWAY_IP" \]/.test(sh), 'unset = no mesh line at all');
}

section('the names this seam pins');
ok(MESH_GATEWAY_CONTAINER === 'zeehive_mesh_gateway',
   'the container name matches the compose files\' mesh-gateway container_name');
ok(MESH_GATEWAY_NETWORK === 'zee-hive-net', 'the network is the one every cxell is already on');
for (const file of ['docker-compose.bootstrap.yml', 'docker/zeehive/docker-compose.prod.yml']) {
  const y = readFileSync(resolve(ROOT, file), 'utf8');
  ok(y.includes(`container_name: ${MESH_GATEWAY_CONTAINER}`),
     `${file}: declares ${MESH_GATEWAY_CONTAINER} (the name the resolver inspects)`);
}

console.log(fail ? `\n${fail} FAILED` : '\nall green');
process.exit(fail ? 1 : 0);

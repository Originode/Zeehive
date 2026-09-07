// MESH ROUTES — the router's directory half (lib/mesh-routes.js + /api/xell/self/routes +
// `zee routes`; docs/netbird-mesh-plan.md §3.4). The derivation is PURE, so this test needs no
// database and no daemon — rows in, payload out — plus a real loopback dial for the probe and
// static wiring assertions for the route/CLI/manual chain the drift test then holds together.
//
// Covered:
//   • canonicalPort: the manifest's spinoff `internal` wins; compose-gen's defaults otherwise
//   • dsnAt: re-addresses a DSN keeping credentials + database; null on garbage (never half-true)
//   • no peer → every answer is legacy-port, the projected DSN rides on db, no fallback block
//   • a JOINED peer → owned roles answer mesh (fqdn + canonical port, url on ip), the db DSN is
//     re-addressed, and the legacy pair rides as fallback (dual-stack during migration)
//   • a USED shared db is NEVER answered by the xell's own peer (that is a machine peer's job)
//   • a peer minted but not joined answers legacy (mesh is not claimed before it is true)
//   • an unparseable legacy DSN + mesh → the db answer FALLS BACK whole to legacy-port
//   • probeTcp: ok on a listening socket, refused on a closed port, unknown with nothing to dial
//   • wiring (static): routes.js mounts GET /xell/self/routes, self.js exports selfRoutes,
//     scripts/zee implements + advertises `zee routes`
//
// RUN:  node test/mesh-routes.test.mjs
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalPort, dsnAt, deriveXellRoutes, probeTcp } from '../server/src/lib/mesh-routes.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

const MANIFEST = { tiers: { spinoff: { ports: {
  server: { internal: 4700 }, webapp: { internal: 5180 }, db: { internal: 5432 },
} } } };
const OWNED = [
  { role: 'server', host: '10.1.0.15', host_port: 4860, url: 'http://10.1.0.15:4860' },
  { role: 'webapp', host: '10.1.0.15', host_port: 5360, url: 'http://10.1.0.15:5360' },
];
const USED_DB = [{ role: 'db', host: '10.1.0.15', host_port: 32773 }];
const OWNED_DB = [{ role: 'db', host: '10.1.0.15', host_port: 5510 }];
const DSN = 'postgresql://zeehive:pw@10.1.0.15:5510/zeehive';
const JOINED = { hostname: 'wise-delta-a1b2', status: 'joined', ip: '100.64.0.9' };

section('canonicalPort');
ok(canonicalPort('server', MANIFEST) === 4700, 'the manifest internal wins');
ok(canonicalPort('webapp', {}) === 5173 && canonicalPort('db', {}) === 5432,
   'compose-gen defaults otherwise');

section('dsnAt');
ok(dsnAt(DSN, '100.64.0.9', 5432) === 'postgresql://zeehive:pw@100.64.0.9:5432/zeehive',
   're-addresses keeping credentials + database');
ok(dsnAt('not a dsn at all //', 'h', 1) === null, 'garbage → null, never half-true');
ok(dsnAt(null, 'h', 1) === null && dsnAt(DSN, null, 1) === null, 'missing pieces → null');

section('no peer → legacy everywhere');
const legacy = deriveXellRoutes({ manifest: MANIFEST, owned: [...OWNED, ...OWNED_DB], used: [],
                                  peer: null, legacyDsn: DSN, dsnSource: 'own-db-container',
                                  meshDomain: 'netbird.selfhosted', meshEnabled: false });
ok(legacy.routes.server.source === 'legacy-port' && legacy.routes.server.port === 4860,
   'server answers the recorded host:port');
ok(legacy.routes.db.dsn === DSN && legacy.routes.db.dsn_source === 'own-db-container',
   'the projected DSN rides on the db answer');
ok(!('fallback' in legacy), 'no fallback block when nothing answered mesh');

section('a joined peer answers mesh for OWNED roles');
const mesh = deriveXellRoutes({ manifest: MANIFEST, owned: [...OWNED, ...OWNED_DB], used: [],
                                peer: JOINED, legacyDsn: DSN, dsnSource: 'own-db-container',
                                meshDomain: 'netbird.selfhosted', meshEnabled: true });
ok(mesh.routes.server.source === 'mesh' && mesh.routes.server.port === 4700
   && mesh.routes.server.hostname === 'wise-delta-a1b2.netbird.selfhosted',
   'server: mesh fqdn + CANONICAL port (the slot machinery is gone from the answer)');
ok(mesh.routes.server.url === 'http://100.64.0.9:4700', 'the url dials the peer ip');
ok(mesh.routes.db.dsn === 'postgresql://zeehive:pw@100.64.0.9:5432/zeehive',
   'the db DSN is re-addressed to the peer, credentials intact');
ok(mesh.fallback?.server?.port === 4860 && mesh.fallback?.db?.port === 5510,
   'the legacy pairs ride as fallback (dual-stack)');
ok(mesh.mesh.peer.hostname === 'wise-delta-a1b2' && mesh.mesh.enabled === true,
   'the peer is described');

section('a USED shared db stays legacy under a joined peer');
const shared = deriveXellRoutes({ manifest: MANIFEST, owned: OWNED, used: USED_DB,
                                  peer: JOINED, legacyDsn: 'postgresql://z@10.1.0.15:32773/zeehive',
                                  dsnSource: 'shared-dev-container',
                                  meshDomain: 'netbird.selfhosted', meshEnabled: true });
ok(shared.routes.db.source === 'legacy-port' && shared.routes.db.port === 32773,
   'the shared dev db is the MACHINE peer\'s to answer for, not this xell\'s');
ok(shared.routes.server.source === 'mesh', 'while the owned server still answers mesh');

section('a USED shared db answers mesh through its MACHINE peer (phase 2, §3.2)');
const MACHINE_DB = [{ role: 'db', host: '10.1.0.15', host_port: 32773, docker_ctx: 'zt-local' }];
const viaMachine = deriveXellRoutes({ manifest: MANIFEST, owned: OWNED, used: MACHINE_DB,
                                      peer: JOINED,
                                      machinePeers: [{ hostname: 'zt-local', status: 'joined',
                                                       ip: '100.64.0.20', docker_ctx: 'zt-local' }],
                                      legacyDsn: 'postgresql://z@10.1.0.15:32773/zeehive',
                                      dsnSource: 'shared-dev-container',
                                      meshDomain: 'netbird.selfhosted', meshEnabled: true });
ok(viaMachine.routes.db.source === 'mesh' && viaMachine.routes.db.port === 32773
   && viaMachine.routes.db.hostname === 'zt-local.netbird.selfhosted',
   'the shared dev db answers mesh at the MACHINE peer, KEEPING the published port');
ok(viaMachine.routes.db.dsn === 'postgresql://z@100.64.0.20:32773/zeehive',
   'the DSN is re-addressed to the machine peer, credentials intact');
ok(viaMachine.fallback?.db?.port === 32773, 'the legacy pair rides as fallback (dual-stack)');
ok(viaMachine.routes.server.source === 'mesh', 'the owned server still answers mesh (its own peer)');
const mintedMachine = deriveXellRoutes({ manifest: MANIFEST, owned: OWNED, used: MACHINE_DB,
                                         peer: JOINED,
                                         machinePeers: [{ hostname: 'zt-local', status: 'minted',
                                                          ip: null, docker_ctx: 'zt-local' }],
                                         legacyDsn: 'postgresql://z@10.1.0.15:32773/zeehive',
                                         dsnSource: 'shared-dev-container',
                                         meshDomain: 'netbird.selfhosted', meshEnabled: true });
ok(mintedMachine.routes.db.source === 'legacy-port',
   'a minted-but-not-joined machine peer does not claim the shared db before it is true');
const noHostPeer = deriveXellRoutes({ manifest: MANIFEST, owned: OWNED, used: MACHINE_DB,
                                      peer: JOINED, machinePeers: [],
                                      legacyDsn: 'postgresql://z@10.1.0.15:32773/zeehive',
                                      dsnSource: 'shared-dev-container',
                                      meshDomain: 'netbird.selfhosted', meshEnabled: true });
ok(noHostPeer.routes.db.source === 'legacy-port',
   'a machine with no mesh peer keeps the legacy answer (the standing invariant)');

section('a minted-but-not-joined peer answers legacy');
const minted = deriveXellRoutes({ manifest: MANIFEST, owned: [...OWNED, ...OWNED_DB], used: [],
                                  peer: { hostname: 'x', status: 'minted', ip: null },
                                  legacyDsn: DSN, dsnSource: 'own-db-container',
                                  meshDomain: 'netbird.selfhosted', meshEnabled: true });
ok(minted.routes.server.source === 'legacy-port', 'mesh is not claimed before it is true');

section('unparseable legacy DSN + mesh → whole-answer fallback');
const bad = deriveXellRoutes({ manifest: MANIFEST, owned: OWNED_DB, used: [],
                               peer: JOINED, legacyDsn: 'docker exec -it psql …',
                               dsnSource: 'own-db-container',
                               meshDomain: 'netbird.selfhosted', meshEnabled: true });
ok(bad.routes.db.source === 'legacy-port' && bad.routes.db.port === 5510,
   'a mesh db answer without a usable DSN degrades whole, never half-true');

section('probeTcp');
const srv = net.createServer(() => {});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
ok(await probeTcp('127.0.0.1', port) === 'ok', 'a listening socket answers ok');
await new Promise((r) => srv.close(r));
ok(await probeTcp('127.0.0.1', port) === 'refused', 'a closed port answers refused');
ok(await probeTcp(null, null) === 'unknown', 'nothing to dial answers unknown');

section('wiring (static)');
const routes = readFileSync(resolve(ROOT, 'server/src/api/routes.js'), 'utf8');
ok(routes.includes(`router.get('/xell/self/routes'`) && /selfRoutes/.test(routes),
   'routes.js mounts GET /xell/self/routes → selfRoutes');
const self = readFileSync(resolve(ROOT, 'server/src/queenzee/self.js'), 'utf8');
ok(/export async function selfRoutes\(/.test(self) && self.includes('deriveXellRoutes({'),
   'self.js gathers rows and delegates to the pure derivation');
const cli = readFileSync(resolve(ROOT, 'scripts/zee'), 'utf8');
ok(cli.includes(`case 'routes':`) && /^\s{2,}zee routes/m.test(cli),
   'scripts/zee implements AND advertises the verb (the drift test holds the manual half)');

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);

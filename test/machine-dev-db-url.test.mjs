// A LOCAL DEV DB PROVISION RECORDS A URL — the machine-matrix "＋ dev db" button must not leave
// the chip wearing "no URL recorded".
//
// THE DEFECT: provisionDevDb built its conn_ref host as `m.host_ip || project.dev_host_ip ||
// config.devHostIp`. A QUEENZEE-HOST ("local") machine — the context that IS this box — usually
// carries no host_ip (it's local!), so all three were null, derivedTcpDsn failed closed, and the
// freshly provisioned db row had host=NULL, conn_ref=NULL while host_port was very much set. The
// db chip tooltip then read "database: no URL recorded" for a database that was listening the
// whole time (db-dsn-needs-a-host records the sibling defect: the poisoned "null" DSN).
//
// The rule (mirrored from lib/provision.js urlHost): a LOCAL machine's published ports are the
// host's OWN — reachable at host.docker.internal from a containerized queenzee/cxell, else
// localhost. A REMOTE machine with none of the three explicit places still fails closed (its
// address is genuinely unknown; guessing 'localhost' is a silent wrong database).
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

const { machineDbHostFallback, queenzeeHostCtx } = await import('../server/src/lib/machines.js');
const inContainer = (await import('node:fs')).existsSync('/.dockerenv');
const localFallback = inContainer ? 'host.docker.internal' : 'localhost';

section('machineDbHostFallback — the explicit legacy places win, in order (when no deploy_site matches)');
const mk = (m = {}, p = {}, c = {}) => machineDbHostFallback(
  { docker_ctx: 'remote-ctx', host_ip: null, ...m },
  { dev_host_ip: null, ...p },
  { devHostIp: null, ...c });

ok(mk({ host_ip: '10.0.1.18' }) === '10.0.1.18', 'machine.host_ip is the first fallback answer');
ok(mk({ host_ip: '10.0.1.18' }, { dev_host_ip: '10.9.9.9' }) === '10.0.1.18',
   'machine.host_ip beats project.dev_host_ip');
ok(mk({}, { dev_host_ip: '10.9.9.9' }, { devHostIp: '10.8.8.8' }) === '10.9.9.9',
   'project.dev_host_ip beats config.devHostIp');
ok(mk({}, {}, { devHostIp: '10.8.8.8' }) === '10.8.8.8', 'config.devHostIp beats the fallback');

section('machineDbHostFallback — the QUEENZEE-HOST (local) machine falls back, so a local dev db records a URL');
const local = { docker_ctx: queenzeeHostCtx(), host_ip: null };
ok(machineDbHostFallback(local, { dev_host_ip: null }, { devHostIp: null }) === localFallback,
   `local machine with no host → '${localFallback}' (the host's own address), never null`);
ok(machineDbHostFallback(local, { dev_host_ip: null }, { devHostIp: null }) !== null,
   '…and therefore never leaves the chip with "no URL recorded"');

section('machineDbHostFallback — a REMOTE machine with no host still fails closed');
ok(machineDbHostFallback({ docker_ctx: 'ugreen-nas', host_ip: null }, { dev_host_ip: null }, { devHostIp: null }) === null,
   'remote machine with none of the three places → null (fail closed, not a guessed localhost)');
ok(machineDbHostFallback({ docker_ctx: 'ugreen-nas', host_ip: '' }, { dev_host_ip: null }, { devHostIp: null }) === null,
   'an empty-string host_ip is treated as absent too');

section('the dev-db provisioner resolves through machineDbHost (source-pinned)');
const machines = readFileSync(join(ROOT, 'server', 'src', 'lib', 'machines.js'), 'utf8');
ok(/const host = await machineDbHost\(m, project, config\);/.test(machines),
   'provisionDevDb resolves its host through machineDbHost (awaiting the site-first resolution)');
ok(/host\.docker\.internal/.test(machines) && /'localhost'/.test(machines),
   'the local fallback names both reachable host forms, exactly like lib/provision.js');
ok(/machineDbHost\(m, project, cfg\)/.test(machines),
   'machineDbHost is the exported helper under test (not inlined)');
ok(/siteHostForMachine\(projectId, dockerCtx\)/.test(machines),
   'deploy_site is consulted first — siteHostForMachine is the exported precedence flip (TKT-180)');

console.log(fail ? `\n${fail} FAILURE(S)` : '\nall good');
process.exit(fail ? 1 : 0);

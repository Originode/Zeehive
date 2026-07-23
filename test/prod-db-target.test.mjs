// PROD DB TARGET GUARD — the pure decision that stops a prod migration writing to the wrong
// database. Split out of assertProdDbTarget's inline I/O the same way pickDbContainer is a pure
// function over (row, docker-result): decideProdDbTarget(db, inspect) takes the registry row-handle
// and a spawnSync-shaped docker-inspect result, and returns { ok } | { ok:false, error }.
//
// The guard must prove the ADDRESS the registry recorded — in whichever form the row has one:
//   • omnibiz prod publishes a host_port (10.2.0.16:5432) → confirm by published port,
//   • Zeehive's meta db publishes NOTHING ({"5432/tcp": null}) and is reachable only over the
//     compose network under the alias `meta-db` → confirm by network alias from conn_ref.
// A row with NEITHER address, a non-prod row, or a docker inspect that fails → REFUSED.
import { decideProdDbTarget, connRefAlias } from '../server/src/queenzee/shipmigrate.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// docker-inspect result shims (mirror spawnSync's { status, stdout, stderr }).
const portsOk = (ports) => ({ status: 0, stdout: JSON.stringify(ports) });      // .NetworkSettings.Ports
const netsOk  = (nets)  => ({ status: 0, stdout: JSON.stringify(nets) });        // .NetworkSettings.Networks
const inspectFail = (stderr) => ({ status: 1, stdout: '', stderr });

// ── connRefAlias: only a DNS-style host is an identity docker can confirm ─────────────────────────
console.log('connRefAlias: DNS host yes; IP / localhost / null / empty no');
ok(connRefAlias('postgresql://zeehive@meta-db:5432/zeehive') === 'meta-db', 'meta-db from a real conn_ref');
ok(connRefAlias('postgres://u:p@omnibiz_db_prod:5432/db') === 'omnibiz_db_prod', 'underscore host allowed');
ok(connRefAlias('postgresql://zeehive@10.2.0.16:5432/zeehive') === null, 'bare IP → null (not confirmable)');
ok(connRefAlias('postgresql://zeehive@localhost:5445/zeehive') === null, 'localhost → null');
ok(connRefAlias('postgresql://zeehive@null:5432/zeehive') === null, 'literal null host → null');
ok(connRefAlias('') === null, 'empty conn_ref → null');
ok(connRefAlias(null) === null, 'null conn_ref → null');

// ── omnibiz prod: host_port present → confirm by published port ───────────────────────────────────
console.log('omnibiz prod (host_port=5432): confirm by published port');
const omni = { container: 'omnibiz_db_prod_v184', ctx: 'mardale-prod', tier: 'prod', host_port: 5432, conn_ref: '' };
ok(decideProdDbTarget(omni, portsOk({ '5432/tcp': [{ HostIp: '10.2.0.16', HostPort: '5432' }] })).ok === true,
   'publishes 5432 → OK');

// the real 2026-07-23 incident: resolver handed us a 7.7MB dev clone that publishes 32768, not 5432.
let a = decideProdDbTarget(omni, portsOk({ '5432/tcp': [{ HostPort: '32768' }] }));
ok(a.ok === false && /NOT the registry's production database/.test(a.error) && /host_port 5432/.test(a.error),
   'clone publishes 32768, not 5432 → REFUSED (the incident)');

// ── zeehive prod: host_port NULL, identity is the conn_ref network alias ──────────────────────────
console.log('zeehive prod (host_port=NULL, conn_ref meta-db): confirm by network alias');
const zee = { container: 'zeehive_meta_db', ctx: 'default', tier: 'prod', host_port: null,
  conn_ref: 'postgresql://zeehive@meta-db:5432/zeehive' };
// docker's own report: publishes NOTHING, but carries the alias on zeehive_default.
ok(decideProdDbTarget(zee, netsOk({ zeehive_default: { Aliases: ['zeehive_meta_db', 'meta-db'] } })).ok === true,
   'aliases include meta-db → OK');
// DNSNames is the newer compose field — accept it too.
ok(decideProdDbTarget(zee, netsOk({ zeehive_default: { DNSNames: ['zeehive_meta_db', 'meta-db'] } })).ok === true,
   'DNSNames include meta-db → OK');

a = decideProdDbTarget(zee, netsOk({ zeehive_default: { Aliases: ['zeehive_meta_db'] } }));
ok(a.ok === false && /does not answer to the prod db row's network name 'meta-db'/.test(a.error)
   && /NOT the registry's production database/.test(a.error),
   'pointed at a container that lacks the meta-db alias → REFUSED');

// ── host_port NULL and no usable conn_ref host → unaddressed → REFUSED (no daemon needed) ─────────
console.log('host_port NULL + no confirmable conn_ref host → REFUSED');
for (const [label, conn_ref] of [
  ['empty conn_ref', ''],
  ['host `null`', 'postgresql://zeehive@null:5432/zeehive'],
  ['host `localhost`', 'postgresql://zeehive@localhost:5445/zeehive'],
  ['a bare IP', 'postgresql://zeehive@10.2.0.16:5432/zeehive'],
]) {
  // inspect is null: an unaddressed row is refused BEFORE any docker call.
  const r = decideProdDbTarget({ container: 'x', ctx: 'default', tier: 'prod', host_port: null, conn_ref }, null);
  ok(r.ok === false && /records neither a host_port nor a network host/.test(r.error),
     `${label} → REFUSED without touching docker`);
}

// ── tier != prod → REFUSED (before any inspect) ───────────────────────────────────────────────────
console.log('non-prod row → REFUSED');
a = decideProdDbTarget({ ...omni, tier: 'dev' }, null);
ok(a.ok === false && /tier='dev', not 'prod'/.test(a.error), "tier='dev' → REFUSED");

// ── docker inspect exits non-zero → REFUSED, message names container AND context ─────────────────
console.log('docker inspect fails → REFUSED, names the container and the context');
a = decideProdDbTarget(omni, inspectFail('Error: No such object: omnibiz_db_prod_v184'));
ok(a.ok === false && a.error.includes('omnibiz_db_prod_v184') && a.error.includes('mardale-prod')
   && /cannot inspect/.test(a.error),
   'inspect status!=0 → REFUSED naming omnibiz_db_prod_v184 on mardale-prod');
// same for the alias mode (network context)
a = decideProdDbTarget(zee, inspectFail('Cannot connect to the Docker daemon'));
ok(a.ok === false && a.error.includes('zeehive_meta_db') && a.error.includes('default'),
   'alias-mode inspect failure → REFUSED naming zeehive_meta_db on default');

// ── malformed inspect stdout → treated as no addresses → REFUSED (fails closed) ──────────────────
console.log('malformed inspect stdout → fails closed');
a = decideProdDbTarget(omni, { status: 0, stdout: 'not json' });
ok(a.ok === false && /published: none/.test(a.error), 'unparseable ports → REFUSED (no port matched)');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exitCode = failures ? 1 : 0;

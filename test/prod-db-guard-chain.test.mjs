// THE RESOLVE → GUARD CHAIN for a prod migration's target.
//
// shipmigrate.js resolves WHICH container is this project's production database
// (`resolveRealDbContainer` → `pickDbContainer`) and then `assertProdDbTarget` re-confirms it
// before any irreversible write (`decideProdDbTarget`). Both halves are pure and exported, so the
// chain can be exercised end to end without a daemon.
//
// So can its second premise: the guard's chosen proof of identity must not be the same property the
// resolver already used to select. `pickDbContainer`'s port path selected a container BECAUSE
// `docker ps` reported it publishing the row's recorded host_port; the guard then inspected that
// same container and required it to publish that same host_port. On one daemon those are the same
// fact (this file models them from one source on purpose — that is the finding), so on that path the
// guard could only ever confirm its own premise. A container that is NOT the registry's production
// database — the host's own postgres, another project's db, any stranger binding 5432 — was
// accepted as prod, and the migration ran in it.
//
// The port is not an identity: on the mardale-prod host 5432 is the HOST's own postgres port, and
// several machines share one daemon. The registry's identity for a db row is its NAME (the logical
// name, or the fleet's versioned `<logical>_<suffix>` mint — machines.js derives every dev db as
// `<project>_db_dev_<machine>`), with the recorded address as the DISAMBIGUATOR among the containers
// that name already claims.
//
// This pins the safe property: the chain never accepts a container the row's name cannot claim.
//
// RED BEFORE THE FIX (pickDbContainer selected by port first), section 1:
//   ✗ the resolver does not select a stranger by the port alone (picked host-postgres via port)
//   ✗ and the guard does NOT accept it as prod (ACCEPTED)
// GREEN after (the resolver requires the row's NAME; the port disambiguates within it).
import { pickDbContainer } from '../server/src/lib/xell-db.js';
import { decideProdDbTarget, prodDbAddress } from '../server/src/queenzee/shipmigrate.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// ── the daemon, modelled faithfully from ONE state ───────────────────────────────────────────────
// `docker ps --format '{{.Names}}\t{{.Ports}}'` prints the published HOST port before `->`;
// `docker inspect --format '{{json .NetworkSettings.Ports}}'` reports that same number as HostPort.
// Same daemon, same container — which is exactly why a guard that checks the port the resolver
// picked by cannot be independent. A container that publishes NOTHING inspects as {"5432/tcp": null}.
const portsMap = (published) => Object.fromEntries([[published.length ? '5432/tcp' : '5432/tcp',
  published.length ? published.map((p) => ({ HostIp: '0.0.0.0', HostPort: String(p) })) : null]]);

function daemon(containers) {
  const byName = new Map(containers.map((c) => [c.name, c]));
  return {
    running: containers.map((c) => ({ name: c.name, hostPorts: new Set(c.publishes) })),
    inspect: (name) => (byName.has(name)
      ? { status: 0, stdout: JSON.stringify(portsMap(byName.get(name).publishes)) }
      : { status: 1, stdout: '', stderr: `Error: No such object: ${name}` }),
  };
}

// The shipped chain, verbatim in shape: prodDb() resolves the container (pickDbContainer), the guard
// inspects THE RESOLVED NAME, decideProdDbTarget judges.
function resolveThenGuard(d, row, registeredElsewhere = new Set()) {
  const pick = pickDbContainer(d.running, { name: row.logical, host_port: row.host_port }, registeredElsewhere);
  if (pick.ambiguous) return { pick, refused: 'ambiguous', candidates: pick.candidates };
  const db = { container: pick.name, ctx: row.ctx, tier: row.tier, host_port: row.host_port,
    conn_ref: row.conn_ref, logical: row.logical };
  const addr = prodDbAddress(db);
  const inspect = (db.tier === 'prod' && addr.mode !== 'none') ? d.inspect(db.container) : null;
  return { pick, db, verdict: decideProdDbTarget(db, inspect) };
}

// The malformed-omnibiz shape the card was cut from: the prod row records host_port 5432, no
// conn_ref, and the logical name `omnibiz_db_prod`.
const PROD_ROW = { logical: 'omnibiz_db_prod', ctx: 'mardale-prod', tier: 'prod',
  host_port: 5432, conn_ref: null };

// ── 1. THE ADVERSARIAL CASE ──────────────────────────────────────────────────────────────────────
// No container named exactly `omnibiz_db_prod`; exactly ONE container publishes 5432 — and it is NOT
// this registry's production database. It is the host's own postgres (or any stranger) and owns no
// registry row, so nothing excludes it.
console.log('stranger publishes the recorded port, no exact-name container running');
{
  const d = daemon([{ name: 'host-postgres', publishes: [5432] }]);
  const r = resolveThenGuard(d, PROD_ROW);
  ok(r.pick.name !== 'host-postgres',
    `the resolver does not select a stranger by the port alone (picked ${r.pick.name} via ${r.pick.via})`);
  ok(r.verdict.ok === false,
    `and the guard does NOT accept it as prod (${r.verdict.ok ? 'ACCEPTED' : r.verdict.error})`);
}

// Same hazard, one step sharper: the stranger is the ONLY thing running, so the port path is the
// only thing that could resolve at all — the resolver must fall back to the row's own name and let
// the guard refuse the unidentifiable target, never hand over the stranger.
console.log('the row\'s identity is the NAME, not the port it cannot own');
{
  const d = daemon([{ name: 'some-other-projects-db', publishes: [5432] }]);
  const p = pickDbContainer(d.running, { name: PROD_ROW.logical, host_port: PROD_ROW.host_port }, new Set());
  ok(p.name === PROD_ROW.logical && p.unresolved === true,
    `unclaimed name + a stranger publishing the port → unresolved fallback to ${PROD_ROW.logical}`);
}

// ── 2. THE LEGITIMATE PATHS STILL RESOLVE ────────────────────────────────────────────────────────
// The fleet's real shape: the row is logical (`omnibiz_db_prod`), the daemon runs the versioned
// container (`omnibiz_db_prod_v184`) that publishes the recorded port.
console.log('legitimate: the row\'s own versioned container, publishing the recorded port');
{
  const r = resolveThenGuard(daemon([{ name: 'omnibiz_db_prod_v184', publishes: [5432] }]), PROD_ROW);
  ok(r.pick.via === 'port' && r.verdict.ok === true, 'omnibiz_db_prod → _v184 by port → ACCEPTED');

  const e = resolveThenGuard(daemon([{ name: 'omnibiz_db_prod', publishes: [5432] }]), PROD_ROW);
  ok(e.pick.via === 'exact' && e.verdict.ok === true, 'exact logical name running → ACCEPTED');
}

// ── 3. THE GUARD IS REAL WHERE IT ALWAYS WAS ─────────────────────────────────────────────────────
// The 00:22 failure from the card: a container named exactly `omnibiz_db_prod` IS running and
// publishes NOTHING (the row's port 5432 is not its). The resolver used no port to pick it, so the
// guard's port check is genuinely independent and fires with its counter-message.
console.log('exact-name container that publishes nothing → the guard refuses (00:22 shape)');
{
  const r = resolveThenGuard(daemon([{ name: 'omnibiz_db_prod', publishes: [] }]), PROD_ROW);
  ok(r.verdict.ok === false && /does not publish the prod db row's host_port 5432/.test(r.verdict.error),
    `refused by the address: ${String(r.verdict.error).slice(0, 90)}…`);
}

// The 2026-07-23 incident shape: a dev clone publishing 32768 while the row records 5432. It IS a
// versioned extension of the row's name, so it is a candidate — and the port is what refuses it.
console.log('the 2026-07-23 clone (publishes 32768, row says 5432) → refused');
{
  const r = resolveThenGuard(daemon([{ name: 'omnibiz_db_prod_dev_local_mardale_prod', publishes: [32768] }]), PROD_ROW);
  ok(r.verdict.ok === false && /does not publish/.test(r.verdict.error),
    'a named candidate publishing the wrong port is refused by the guard');
}

// Two containers the row's name claims, both publishing the recorded port → refuse, never coin-flip.
console.log('ambiguous candidates → refusal, not a coin flip');
{
  const r = resolveThenGuard(daemon([{ name: 'omnibiz_db_prod_v184', publishes: [5432] },
    { name: 'omnibiz_db_prod_v185', publishes: [5432] }]), PROD_ROW);
  ok(r.refused === 'ambiguous' && r.candidates.length === 2, 'two claimable names on :5432 → ambiguous');
}

// ── 4. THE ALIAS PATH IS NOT THE SAME SHAPE ──────────────────────────────────────────────────────
// Where the row has NO host_port, identity is the conn_ref network alias (Zeehive's own meta db).
// The resolver only ever sees names and ports, so it CANNOT have selected by the alias — the guard's
// alias check is independent of the resolve on every path, and is a real check.
console.log('alias mode: the resolver cannot have used the alias, so the check is independent');
{
  const row = { logical: 'zeehive_meta_db', ctx: 'default', tier: 'prod', host_port: null,
    conn_ref: 'postgresql://zeehive@meta-db:5432/zeehive' };
  const d = daemon([{ name: 'zeehive_meta_db_v2', publishes: [32768] }]);
  d.inspect = () => ({ status: 0, stdout: JSON.stringify({ zeehive_default: { Aliases: ['zeehive_meta_db_v2'] } }) });
  const r = resolveThenGuard(d, row);
  ok(r.pick.via === 'prefix' && r.verdict.ok === false
    && /does not answer to the prod db row's network name 'meta-db'/.test(r.verdict.error),
    'a name-candidate that does not carry the row\'s alias is REFUSED');

  d.inspect = () => ({ status: 0, stdout: JSON.stringify({ zeehive_default: { Aliases: ['zeehive_meta_db_v2', 'meta-db'] } }) });
  ok(resolveThenGuard(d, row).verdict.ok === true, 'and ACCEPTED when the alias is there');
}

// ── 5. NOTHING TO RESOLVE ────────────────────────────────────────────────────────────────────────
console.log('nothing running at all → the logical name is inspected and fails closed');
{
  const r = resolveThenGuard(daemon([]), PROD_ROW);
  ok(r.pick.unresolved === true && r.verdict.ok === false && /cannot inspect/.test(r.verdict.error),
    'no candidates → fallback → the guard cannot inspect it → REFUSED');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exitCode = failures ? 1 : 0;

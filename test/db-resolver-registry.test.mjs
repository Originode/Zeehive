// DB CONTAINER RESOLUTION — resolve from REGISTRY IDENTITY, not name shape.
//
// Guards the 2026-07-23 incident: a dev clone minted as `omnibiz_db_prod_dev_local_mardale_prod`
// is a prefix-extension of `omnibiz_db_prod`, so the OLD resolver (first running name that starts
// with `${logical}_`, docker ps newest-first) picked the clone and a prod ship migrated a 7.7MB
// throwaway while reporting success. This proves:
//   1. the OLD heuristic reproducibly picks the WRONG container (understand the bug),
//   2. the NEW pickDbContainer picks the real prod by durable identity (published port) and by
//      excluding names that own their own registry row,
//   3. the legitimate versioned case (omnibiz_db_prod → omnibiz_db_prod_v184) still resolves,
//   4. genuine ambiguity is REFUSED, not coin-flipped,
//   5. end-to-end resolveRealDbContainer (docker ps + registry) picks right / refuses, and the
//      Cached hot-path variant answers WITHOUT blocking on a cold miss,
//   6. shipmigrate aborts before writing when the target is not the registry's prod database.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const entry = (name, ...ports) => ({ name, hostPorts: new Set(ports) });

// ── 1. reproduce the OLD bug (pure) ─────────────────────────────────────────────────────────────
console.log('OLD heuristic: name-prefix scan picks the WRONG container');
function oldResolve(runningNamesNewestFirst, logical) {
  return runningNamesNewestFirst.find((n) => n !== logical && n.startsWith(`${logical}_`)) || logical;
}
const CLONE = 'omnibiz_db_prod_dev_local_mardale_prod';
const REAL  = 'omnibiz_db_prod_v184';
// docker ps lists newest first; the clone is ~10h old, prod is 6 days old → clone first.
ok(oldResolve([CLONE, REAL], 'omnibiz_db_prod') === CLONE,
   `old resolver picks the dev CLONE (${CLONE}) — the bug`);

// ── 2. new resolver picks the real prod by identity ─────────────────────────────────────────────
const { pickDbContainer } = await import('../server/src/lib/xell-db.js');
console.log('NEW pickDbContainer: durable identity + registered-name exclusion');
const running = [entry(CLONE, 32768), entry(REAL, 5432)];  // same order docker ps returned
const registeredElsewhere = new Set([CLONE]);              // the clone owns its OWN tier=dev row
let p = pickDbContainer(running, { name: 'omnibiz_db_prod', host_port: 5432 }, registeredElsewhere);
ok(p.name === REAL && !p.ambiguous, `picks the real prod ${REAL} (via ${p.via})`);

// Registered-name exclusion ALONE kills the bug, even with NO recorded port (prefix fallback path).
p = pickDbContainer(running, { name: 'omnibiz_db_prod', host_port: null }, registeredElsewhere);
ok(p.name === REAL, 'even with no host_port, excluding the registered clone leaves only real prod');

// Without exclusion AND without a port, the prefix fallback is ambiguous → refuse (not the clone).
p = pickDbContainer(running, { name: 'omnibiz_db_prod', host_port: null }, new Set());
ok(p.ambiguous === true, 'no port + both look versioned → REFUSE (never silently the clone)');

// ── 3. legitimate versioned case still resolves ─────────────────────────────────────────────────
console.log('legitimate versioned case: omnibiz_db_prod → omnibiz_db_prod_v184');
p = pickDbContainer([entry(REAL, 5432)], { name: 'omnibiz_db_prod', host_port: 5432 }, new Set());
ok(p.name === REAL && p.via === 'port', 'single running versioned db resolves by port');
p = pickDbContainer([entry(REAL, 5432)], { name: 'omnibiz_db_prod', host_port: null }, new Set());
ok(p.name === REAL && p.via === 'prefix', 'single running versioned db resolves by prefix when no port on file');
// exact name running → exact
p = pickDbContainer([entry('omnibiz_db_prod', 5432)], { name: 'omnibiz_db_prod', host_port: 5432 }, new Set());
ok(p.name === 'omnibiz_db_prod' && p.via === 'exact', 'exact logical name running is taken as-is');
// nothing running → logical fallback
p = pickDbContainer([entry('unrelated', 1)], { name: 'omnibiz_db_prod', host_port: 5432 }, new Set());
ok(p.name === 'omnibiz_db_prod' && p.unresolved, 'nothing matches → logical fallback (guard-tolerated)');

// ── 4. ambiguity is refused ─────────────────────────────────────────────────────────────────────
console.log('ambiguity → refusal, not a coin flip');
p = pickDbContainer([entry('a_x', 5432), entry('a_y', 5432)], { name: 'a', host_port: 5432 }, new Set());
ok(p.ambiguous === true && p.candidates.length === 2, 'two containers publish the wanted port → ambiguous');

console.log(failures ? `\n${failures} PURE check(s) FAILED` : '\nall PURE checks passed');
process.exitCode = failures ? 1 : 0;

// Export the fixtures the integration half needs via globals is overkill — the integration test is
// a separate file so it can require a live DB without failing the pure checks when the DB is absent.

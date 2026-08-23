// SHIP-FAILURE-CLASSIFIER test — the pure half of ticket #58: a failed ship's raw output is
// classified into a small stable cause vocabulary (ship-behind-live, image-pull, npm-install,
// migration-refused, health-check, disk, other) plus the ONE line that identifies it. The raw log STAYS on the row
// (error / containers are never replaced); this is the one-line diagnosis beside it.
//
// The fixture text is REAL text the deploy path produces — the refusal sentences from
// shipmigrate.js (decideProdDbTarget), the docker build/npm error shapes from failed builds, the
// stranded-ship note from shipgate.js (recoverStrandedShip) — not a vocabulary invented for the
// classifier. The rule order is load-bearing: migration-refused precedes the generic docker/npm
// patterns it also contains, and the distinctive causes precede the catch-all.
import { classifyShipFailure, SHIP_FAILURE_CAUSES } from '../server/src/lib/ship-failure.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// ── 1. the vocabulary itself ───────────────────────────────────────────────────
console.log('── the cause vocabulary ──');
ok(Array.isArray(SHIP_FAILURE_CAUSES) && SHIP_FAILURE_CAUSES.length === 7, 'exactly seven causes');
ok(SHIP_FAILURE_CAUSES.includes('ship-behind-live'),
   'the direction guard refusal is in the vocabulary (a ship_request row can carry it)');
ok(SHIP_FAILURE_CAUSES.includes('other'), 'the catch-all is the last resort');
ok([...SHIP_FAILURE_CAUSES].sort().join(',') === SHIP_FAILURE_CAUSES.slice().sort().join(','),
   'the vocabulary is stable (a sorted copy equals itself)');

// ── 2. migration-refused — the 5+3 knowable failures, VERBATIM from shipmigrate.js ──
console.log('\n── migration-refused (shipmigrate.decideProdDbTarget refusal sentences) ──');
{
  const unaddressed = classifyShipFailure({ error:
    'refusing to migrate omnibiz_db_prod: the prod db row records neither a host_port nor a network '
    + 'host in conn_ref, so its identity cannot be confirmed — record one before shipping migrations' });
  ok(unaddressed.cause === 'migration-refused', `unaddressed row → ${unaddressed.cause}`);
  ok(/host_port nor a network host/.test(unaddressed.line), 'the ONE line names the actual hole');

  const uninspectable = classifyShipFailure({ containers: [
    { ok: false, role: 'migrations', error:
      'refusing to migrate: cannot inspect omnibiz_db_prod on mardale to confirm it is prod — '
      + 'Error: No such object: omnibiz_db_prod' },
  ]});
  ok(uninspectable.cause === 'migration-refused', `uninspectable target → ${uninspectable.cause}`);
  ok(/cannot inspect omnibiz_db_prod on mardale/.test(uninspectable.line),
     'the ONE line names the container and the context');

  const wrongPort = classifyShipFailure({ containers: [
    { ok: false, role: 'migrations', error:
      'refusing to migrate omnibiz_db_prod: it does not publish the prod db row\'s host_port 5432 '
      + '(published: none). This is NOT the registry\'s production database — aborting before any write.' },
  ]});
  ok(wrongPort.cause === 'migration-refused', `wrong published port → ${wrongPort.cause}`);
}

// ── 3. image-pull — real docker build/solve failures ───────────────────────────
console.log('\n── image-pull (real docker build output) ──');
{
  const denied = classifyShipFailure({ containers: [
    { ok: false, role: 'server', error: 'failed to solve', log:
      '#8 [server 1/5] FROM docker.io/library/node:18-alpine\n'
      + '#8 ERROR: failed to solve: failed to resolve source metadata for '
      + 'docker.io/library/node:18-alpine: pull access denied, repository does not exist or may '
      + 'require \'docker login\': denied: requested access to the resource is denied' },
  ]});
  ok(denied.cause === 'image-pull', `pull access denied → ${denied.cause}`);
  ok(/pull access denied/.test(denied.line), 'the ONE line carries the pull denial');

  const manifest = classifyShipFailure({ error: 'failed to solve: node:20: manifest unknown' });
  ok(manifest.cause === 'image-pull', `manifest unknown → ${manifest.cause}`);

  const rate = classifyShipFailure({ error: 'toomanyrequests: You have reached your pull rate limit' });
  ok(rate.cause === 'image-pull', `pull rate limit → ${rate.cause}`);
}

// ── 4. npm-install — the classic RUN npm ci failure ────────────────────────────
console.log('\n── npm-install (the #N RUN npm ci step failing) ──');
{
  const etarget = classifyShipFailure({ containers: [
    { ok: false, role: 'webapp', error: 'exit 1', log:
      '#11 [webapp 5/6] RUN npm ci\n'
      + '#11 0.356 npm ERR! code ETARGET\n'
      + '#11 0.357 npm ERR! No matching version found for react@19.0.0' },
  ]});
  ok(etarget.cause === 'npm-install', `npm ERR! ETARGET → ${etarget.cause}`);
  ok(/No matching version found for react@19\.0\.0/.test(etarget.line),
     'the ONE line is the actual resolution error, not the docker noise');

  const e404 = classifyShipFailure({ error:
    'npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/@foo%2fbar' });
  ok(e404.cause === 'npm-install', `npm ERR! E404 → ${e404.cause}`);
}

// ── 5. disk — no space on the daemon or the build cache ────────────────────────
console.log('\n── disk ──');
{
  const enospc = classifyShipFailure({ containers: [
    { ok: false, role: 'server', error: 'exit 1',
      log: '#12 [server 4/5] RUN npm ci\n#12 ERROR: ENOSPC: no space left on device, write' },
  ]});
  ok(enospc.cause === 'disk', `ENOSPC → ${enospc.cause}`);
  ok(/no space left on device/.test(enospc.line), 'the ONE line names the disk');

  const full = classifyShipFailure({ error: 'failed to build: ERROR: filesystem is full' });
  ok(full.cause === 'disk', `filesystem is full → ${full.cause}`);
}

// ── 6. health-check — the stranded-ship note from shipgate.js ─────────────────
console.log('\n── health-check (shipgate.recoverStrandedShip) ──');
{
  const stranded = classifyShipFailure({ error:
    'orphaned by a queenzee restart mid-ship; targets not verifiably up — re-request' });
  ok(stranded.cause === 'health-check', `targets not verifiably up → ${stranded.cause}`);

  const probe = classifyShipFailure({ error:
    'connectivity check failed: the webapp is not ready (curl timed out)' });
  ok(probe.cause === 'health-check', `connectivity check failed → ${probe.cause}`);
}

// ── 7. order is load-bearing: migration-refused before the generic patterns ────
console.log('\n── rule order (migration-refused beats the docker/npm patterns it contains) ──');
{
  const mig = classifyShipFailure({ error:
    'refusing to migrate: cannot inspect prod_db on mardale to confirm it is prod — ' + 'failed to pull' });
  ok(mig.cause === 'migration-refused',
     `a refusal mentioning a pull failure is STILL migration-refused (first match wins) → ${mig.cause}`);
}

// ── 8. the catch-all and degenerate input ─────────────────────────────────────
console.log('\n── other + robustness ──');
{
  const mystery = classifyShipFailure({ error: 'something entirely unexpected happened' });
  ok(mystery.cause === 'other', `an unknown failure → ${mystery.cause}`);
  ok(mystery.line === 'something entirely unexpected happened', 'the ONE line is the first verdict line');

  const empty = classifyShipFailure({});
  ok(empty.cause === 'other' && empty.line === '', 'no input still yields a shape, never throws');
  ok(classifyShipFailure(null).cause === 'other', 'null input is safe');
  // a SUCCEEDED step's log is never a verdict
  const successOnly = classifyShipFailure({ containers: [{ ok: true, log: 'npm ERR! in a passing step' }] });
  ok(successOnly.cause === 'other', 'a passing step\'s log is not evidence of a failure');
}

console.log(`\n${fail === 0 ? 'ALL PASSED ✓' : `${fail} FAILURE(S) ✗`}`);
process.exit(fail === 0 ? 0 : 1);

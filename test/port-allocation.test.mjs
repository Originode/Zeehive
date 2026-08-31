// HOST-PORT ALLOCATION (TKT-85 family, provision-proof plan §4.5) — stage 2.
//
// The per-xell db host-port used to be a PURE FORMULA (base + slot). A formula cannot see what
// actually owns host ports, so two xells whose slugs hash to the same slot collided silently — the
// second `docker run -p` died with "port is already allocated" and provisioning failed. The fix:
// the slot is the STARTING guess, and the actual port is the first free one walking UP from it,
// checked against the UNION of the meta-DB's recorded db host ports on that context and one bounded
// `docker ps --format '{{.Ports}}'` read of the daemon. This test drives the REAL allocator
// (lib/provision.freeDbHostPort) against the REAL meta-DB:
//
//   • collision → next slot: a recorded row / a daemon-published port on the slot skips it;
//   • the daemon read is FAILURE-TOLERANT: an unreachable daemon (adapter returns `unknown`)
//     DEGRADES to meta-DB-only allocation, logged, never a hang (the bounded-ness is the adapter's
//     own contract — dockerAdapter is what the fix uses, and it kills the child at timeout);
//   • a caller that already lost a bind (the retry) walks PAST the lost port (skip);
//   • a fully-claimed window falls back to the formula port — a provision never FAILS on a crowded
//     host by guessing; the bind refusal/retry is the arbiter.
//   • spinComposeDbPort (the lib/build.js projection) — a ROW-LESS xell (db-shared-dev, no per-xell
//     db row) must NOT inherit the compose default 5500: that is the one host port every other
//     row-less spin db wants, so they collide cross-xell. A recorded row stays authoritative; a
//     row-less xell allocates through the same real allocator (recorded ∪ daemon-bound), and an
//     allocation that blows up degrades to null = the compose default, never a build blocker.
//
// PROVISION_MODE=simulate: allocation is read-only toward the meta-DB and the stubbed daemon — no
// machine is touched.
process.env.PROVISION_MODE = 'simulate';
process.env.BUILD_MODE = 'simulate';

import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { q, one, pool } from '../server/src/db/pool.js';
import { publishedPortsFromPs, freeDbHostPort, spinComposeDbPort } from '../server/src/lib/provision.js';

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const CTX = `portalloc-${tag}`;   // a context that can only ever be this test's — no live rows use it
const BASE = 5500;
const tmp = mkdtempSync(join(tmpdir(), `portalloc-${tag}-`));
let projId = null;

// ── the pure parser: docker ps --format '{{.Ports}}' → published host ports ──
console.log('\n── publishedPortsFromPs (pure) ──');
const PS = [
  '0.0.0.0:5509->5432/tcp',
  '[::]:5508->5432/tcp',
  '127.0.0.1:5201->5173/tcp',
  '0.0.0.0:5503->5432/tcp, [::]:5503->5432/tcp',
  '0.0.0.0:5505->8080/tcp',
].join('\n');
const parsed = publishedPortsFromPs(PS);
ok(parsed.has(5509) && parsed.has(5508) && parsed.has(5201) && parsed.has(5503) && parsed.has(5505),
   'extracts the host port of every published mapping (v4, v6, loopback, stacked)');
ok(parsed.size === 5, `…and nothing else (${parsed.size} ports, no bare ports) — '${[...parsed].join(',')}'`);
ok(publishedPortsFromPs('').size === 0, 'empty output → empty set');
ok(publishedPortsFromPs(null).size === 0, 'null output → empty set');

const daemonUp = (lines) => () => Promise.resolve({ status: 0, stdout: lines.join('\n'), stderr: '' });
const daemonDown = () => Promise.resolve({ unknown: true, reason: 'docker did not answer within 4000ms' });

try {
  projId = (await one(
    `INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`,
    [`zt-portalloc-${tag}`, tmp])).id;

  // ── a recorded meta-DB row on the slot → the next slot is allocated ──
  console.log('\n── collision with a recorded meta-DB port → next slot ──');
  // isolation='shared' (owner NULL) — the allocation query keys on role + docker_ctx, so a shared
  // row is a perfectly faithful "recorded db port" without needing a xell to own it.
  const rec = async (port) => q(
    `INSERT INTO container (project_id,role,tier,isolation,name,docker_ctx,host_port,conn_ref,owner_xell_id)
       VALUES ($1,'db','spinoff','shared',$2,$3,$4,$5,NULL)`,
    [projId, `portalloc-${tag}-${port}`, CTX, port, `postgresql://u@h:${port}/db`]);
  await rec(BASE + 7);                                   // the exact slot this test will ask for
  const p1 = await freeDbHostPort(CTX, { base: BASE, slot: 7, docker: daemonUp([]) });
  ok(p1 === BASE + 8, `a recorded :${BASE + 7} on the slot → :${BASE + 8} (got :${p1})`);
  await rec(BASE + 8);                                   // and now that is taken too
  const p2 = await freeDbHostPort(CTX, { base: BASE, slot: 7, docker: daemonUp([]) });
  ok(p2 === BASE + 9, `walking on: :${BASE + 8} now recorded → :${BASE + 9} (got :${p2})`);

  // ── a daemon-published port on the slot → the next slot is allocated ──
  console.log('\n── collision with a daemon-published port → next slot ──');
  // Nothing recorded at 5510 — only the daemon says a container published it.
  const p3 = await freeDbHostPort(CTX, { base: BASE, slot: 10, docker: daemonUp([`0.0.0.0:${BASE + 10}->5432/tcp`]) });
  ok(p3 === BASE + 11, `the daemon owns :${BASE + 10} → :${BASE + 11} (got :${p3})`);

  // ── an unreachable daemon DEGRADES to meta-DB-only, never a hang ──
  console.log('\n── an unreachable daemon degrades to meta-DB-only allocation ──');
  const p4 = await freeDbHostPort(CTX, { base: BASE, slot: 20, docker: daemonDown });
  ok(p4 === BASE + 20, `daemon unknown → the formula port still allocates (meta-DB said it was free): :${p4}`);
  const p4b = await freeDbHostPort(CTX, { base: BASE, slot: 7, docker: daemonDown });
  ok(p4b === BASE + 9, `…but it still respects the meta-DB rows (recorded :${BASE + 7} and :${BASE + 8} → :${p4b})`);

  // ── the bind-refusal retry's forward progress: a lost port is walked past (skip) ──
  console.log('\n── the retry skips a port this caller already lost (skip) ──');
  const p5 = await freeDbHostPort(CTX, { base: BASE, slot: 30, docker: daemonUp([]), skip: [BASE + 30] });
  ok(p5 === BASE + 31, `a lost :${BASE + 30} is walked past → :${BASE + 31} (got :${p5})`);
  const p6 = await freeDbHostPort(CTX, { base: BASE, slot: 30, docker: daemonUp([]), skip: [BASE + 30, BASE + 31, BASE + 32] });
  ok(p6 === BASE + 33, `…accumulating: 3 lost ports skipped → :${BASE + 33} (got :${p6})`);

  // ── a fully-claimed window falls back to the formula port (never fail by guessing) ──
  console.log('\n── a fully-claimed window falls back to the formula port ──');
  const oldWin = process.env.PORT_ALLOC_WINDOW;
  process.env.PORT_ALLOC_WINDOW = '3';
  try {
    await rec(BASE + 40); await rec(BASE + 41); await rec(BASE + 42);   // the whole 3-port window
    const p7 = await freeDbHostPort(CTX, { base: BASE, slot: 40, docker: daemonUp([]) });
    ok(p7 === BASE + 40, `window 40–42 all taken → falls back to the formula :${BASE + 40} (got :${p7}) `
      + '— the caller (docker run) is the arbiter, never a guessed port');
  } finally { process.env.PORT_ALLOC_WINDOW = oldWin; }

  // ── spinComposeDbPort (lib/build.js projection): a ROW-LESS xell's spin db must not inherit the
  // compose default 5500 — that is the one host port every other row-less spin db also wants, so
  // they collide cross-xell (the "Bind for 0.0.0.0:5500 failed" that took a build down twice). ──
  console.log('\n── spinComposeDbPort: row-less xells allocate instead of the 5500 default ──');
  const slotFor = (s, mod = 90) => {
    const hex = createHash('md5').update(s).digest('hex').slice(0, 4);
    return parseInt(hex, 16) % mod;
  };
  const daemonThrow = () => { throw new Error('docker blew up'); };
  // Slots already recorded by the sections above (7, 8, 40–42) + the ones THIS section records.
  const recSlots = new Set([7, 8, 40, 41, 42]);
  const firstFreeAbove = (start) => { let s = start; while (recSlots.has(s)) s++; return s; };

  // a RECORDED row is authoritative — no allocation read, even for a port that looks taken. It is
  // ALSO a recorded db port the walkers below must respect (dead-daemon case), so track its slot.
  const authPort = BASE + 70;
  await rec(authPort);
  recSlots.add(70);
  const au = await spinComposeDbPort({ recordedPort: authPort, ctx: CTX, slug: 'ignored', project: { id: projId }, docker: daemonThrow });
  ok(au === authPort, `a recorded db port rides along unchanged (:${authPort}), no allocation read (got :${au})`);

  // row-less: the slot's own recorded port is skipped → the next free slot is allocated
  const slugR = `portalloc-${tag}-rowless`;
  const slotR = slotFor(slugR);
  await rec(BASE + slotR);
  recSlots.add(slotR);
  const expR = firstFreeAbove(slotR + 1);
  const rl1 = await spinComposeDbPort({ recordedPort: null, ctx: CTX, slug: slugR, project: { id: projId }, docker: daemonUp([]) });
  ok(rl1 === BASE + expR, `row-less @ :${BASE + slotR} (recorded) → walks to :${BASE + expR} (got :${rl1}) `
    + '— NOT the compose default 5500');

  // row-less: a daemon-published port on the slot is skipped the same way
  const slugD = `portalloc-${tag}-daemon`;
  const slotD = slotFor(slugD);
  const expD = firstFreeAbove(slotD + 1);
  const rl2 = await spinComposeDbPort({ recordedPort: null, ctx: CTX, slug: slugD, project: { id: projId },
    docker: daemonUp([`0.0.0.0:${BASE + slotD}->5432/tcp`]) });
  ok(rl2 === BASE + expD, `row-less @ :${BASE + slotD} (daemon owns it) → :${BASE + expD} (got :${rl2})`);

  // row-less with a DEAD daemon still allocates from the meta-DB only (never a hang, never the
  // default): the slot itself is free in the meta-DB, so it is the answer even though the daemon
  // is unreachable and even though that same slot was "owned" when the daemon answered above.
  const expDead = firstFreeAbove(slotD);
  const rl3 = await spinComposeDbPort({ recordedPort: null, ctx: CTX, slug: slugD, project: { id: projId }, docker: daemonDown });
  ok(rl3 === BASE + expDead, `dead daemon → meta-DB-only allocation lands on :${BASE + expDead} (got :${rl3})`);

  // an allocation that BLOWS UP degrades to null = the compose default — never a build blocker
  const rl4 = await spinComposeDbPort({ recordedPort: null, ctx: CTX, slug: slugR, project: { id: projId }, docker: daemonThrow });
  ok(rl4 === null, `allocator throw → null (compose default), never a build blocker (got ${rl4})`);
} finally {
  await q(`DELETE FROM container WHERE project_id=$1`, [projId]).catch(() => {});
  await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
  await pool.end();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);

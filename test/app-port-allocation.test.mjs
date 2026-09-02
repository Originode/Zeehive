// APP-TIER HOST-PORT ALLOCATION (TKT-85 family, provision-proof plan §4.5) — the second half.
//
// The per-xell DB port stopped being a pure formula (see port-allocation.test.mjs). The app tier's
// two ports did NOT: provisionXell handed out computePorts()'s base+slot with nobody checking who
// already owned them. With port_slot_mod=90 and a dozen live xells per project that is routine, and
// the live hive shows it — two xells on ctx 'default' both recorded :4824/:5324. The loser's spin
// stack then dies at "Bind for 0.0.0.0:5324 failed: port is already allocated"; that failure is
// classed INFRA; an INFRA failure writes build_readiness_record='missing'; and 'missing' makes
// fillStopReasonFor STOP the pool fill for the WHOLE project on that machine. One slot collision
// silently halts a project's pooling — which is what "not provisioning xells" looks like from
// outside.
//
// So the app tier allocates exactly like the db tier: the slot is the STARTING guess, and the pair
// is the first slot walking UP whose BOTH ports are free against the union of (meta-DB recorded
// server/webapp host ports on that context) and one bounded `docker ps` read of the daemon.
//
//   • a recorded row on EITHER port of the slot → the next slot (both ports move together, so the
//     :31xx/:52xx pairing every other reader assumes survives);
//   • a daemon-published port on either → the same;
//   • PROCESS-runner rows carry docker_ctx NULL but publish on the QUEENZEE HOST, so they count
//     when (and only when) the target context is the queenzee host;
//   • an unreachable daemon DEGRADES to meta-DB-only, never a hang;
//   • a caller that already lost a bind walks past it (skip);
//   • a fully-claimed window falls back to the FORMULA pair — never fail a provision by guessing;
//   • and end to end: two xells in a project whose slot_mod forces a collision get DIFFERENT,
//     still-paired ports recorded on their container rows (the rows lib/build.js projects into
//     SPINOFF_SERVER_PORT/SPINOFF_WEB_PORT, i.e. what actually gets bound).
//
// PROVISION_MODE=simulate: no machine is touched; the allocation is read-only toward the meta-DB
// and (in the unit sections) a stubbed daemon.
process.env.PROVISION_MODE = 'simulate';
process.env.BUILD_MODE = 'simulate';

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { q, one, pool } from '../server/src/db/pool.js';
import { freeAppSlot, computePorts, provisionXell } from '../server/src/lib/provision.js';
import { queenzeeHostCtx } from '../server/src/lib/machines.js';

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const CTX = `appalloc-${tag}`;     // a context only this test can ever use
// Bases FAR from every real project's 3100/5200 window: the queenzee-host section below allocates
// on the REAL 'default' context (that is the point of it), so the ports it walks must be ones no
// live row or container could plausibly own.
const SB = 33100;
const WB = 35200;
const tmp = mkdtempSync(join(tmpdir(), `appalloc-${tag}-`));
let projId = null;
const madeProjects = [];

const daemonUp = (lines) => () => Promise.resolve({ status: 0, stdout: lines.join('\n'), stderr: '' });
const daemonDown = () => Promise.resolve({ unknown: true, reason: 'docker did not answer within 4000ms' });

// a recorded app-tier row (isolation 'shared', owner NULL — the allocation query keys on role +
// docker_ctx, so ownership is irrelevant to what it sees)
const rec = (role, port, ctx = CTX) => q(
  `INSERT INTO container (project_id,role,tier,isolation,name,docker_ctx,host_port,owner_xell_id)
     VALUES ($1,$2,'spinoff','shared',$3,$4,$5,NULL)`,
  [projId, role, `appalloc-${tag}-${role}-${port}-${ctx ?? 'null'}`, ctx, port]);

try {
  projId = (await one(
    `INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`,
    [`zt-appalloc-${tag}`, tmp])).id;
  madeProjects.push(projId);
  const alloc = (slot, opts = {}) => freeAppSlot(CTX, { serverBase: SB, webBase: WB, slot, docker: daemonUp([]), ...opts });

  console.log('\n── a free slot is left alone (the formula still wins when nothing owns it) ──');
  const a0 = await alloc(3);
  ok(a0.slot === 3 && a0.serverPort === SB + 3 && a0.webPort === WB + 3,
     `nothing owns slot 3 → :${a0.serverPort}/:${a0.webPort} (the formula pair)`);

  console.log('\n── a recorded row on the slot → the next slot, BOTH ports moving together ──');
  await rec('server', SB + 7);
  const a1 = await alloc(7);
  ok(a1.slot === 8 && a1.serverPort === SB + 8 && a1.webPort === WB + 8,
     `a recorded server :${SB + 7} → slot 8 (:${a1.serverPort}/:${a1.webPort}) — the WEB port moved too, `
     + 'even though nothing owned it');

  console.log('\n── a collision on the WEB port alone still moves the pair ──');
  await rec('webapp', WB + 20);
  const a2 = await alloc(20);
  ok(a2.slot === 21 && a2.serverPort === SB + 21 && a2.webPort === WB + 21,
     `a recorded webapp :${WB + 20} (server :${SB + 20} free) → slot 21 (:${a2.serverPort}/:${a2.webPort}) `
     + '— a slot is free only when BOTH its ports are');

  console.log('\n── the walk needs both ports free on ONE slot ──');
  await rec('server', SB + 30);      // slot 30 blocked by the server port
  await rec('webapp', WB + 31);      // slot 31 blocked by the web port
  const a3 = await alloc(30);
  ok(a3.slot === 32, `slot 30 (server taken) and 31 (web taken) skipped → slot 32 (got ${a3.slot}: `
     + `:${a3.serverPort}/:${a3.webPort})`);

  console.log('\n── a daemon-published port on either port → the next slot ──');
  const a4 = await freeAppSlot(CTX, { serverBase: SB, webBase: WB, slot: 40,
    docker: daemonUp([`0.0.0.0:${SB + 40}->3000/tcp`]) });
  ok(a4.slot === 41, `the daemon owns :${SB + 40} → slot 41 (got ${a4.slot})`);
  const a5 = await freeAppSlot(CTX, { serverBase: SB, webBase: WB, slot: 40,
    docker: daemonUp([`[::]:${WB + 40}->5173/tcp`, `0.0.0.0:${WB + 41}->5173/tcp`]) });
  ok(a5.slot === 42, `the daemon owns web :${WB + 40} and :${WB + 41} → slot 42 (got ${a5.slot})`);

  console.log('\n── an unreachable daemon degrades to meta-DB-only allocation, never a hang ──');
  const a6 = await freeAppSlot(CTX, { serverBase: SB, webBase: WB, slot: 50, docker: daemonDown });
  ok(a6.slot === 50, `daemon unknown → the formula slot still allocates (the meta-DB said it was free): ${a6.slot}`);
  const a7 = await freeAppSlot(CTX, { serverBase: SB, webBase: WB, slot: 7, docker: daemonDown });
  ok(a7.slot === 8, `…but the recorded rows are still respected (recorded :${SB + 7} → slot ${a7.slot})`);

  console.log('\n── the bind-refusal retry walks past a port this caller already lost (skip) ──');
  const a8 = await alloc(60, { skip: [SB + 60] });
  ok(a8.slot === 61, `a lost server :${SB + 60} is walked past → slot ${a8.slot}`);
  const a9 = await alloc(60, { skip: [WB + 60, WB + 61] });
  ok(a9.slot === 62, `two lost WEB ports are walked past → slot ${a9.slot}`);

  console.log('\n── a fully-claimed window falls back to the FORMULA pair (never guess) ──');
  const oldWin = process.env.PORT_ALLOC_WINDOW;
  process.env.PORT_ALLOC_WINDOW = '3';
  try {
    await rec('server', SB + 70); await rec('server', SB + 71); await rec('webapp', WB + 72);
    const a10 = await alloc(70);
    ok(a10.slot === 70 && a10.serverPort === SB + 70,
       `window 70–72 all claimed → falls back to the formula slot 70 (:${a10.serverPort}/:${a10.webPort}) `
       + '— docker run stays the arbiter, never a guessed port');
  } finally { process.env.PORT_ALLOC_WINDOW = oldWin; }

  // ── PROCESS-runner rows: docker_ctx NULL, but published on the QUEENZEE HOST ──
  // A process xell's server/webapp are bare processes in a worktree; their rows carry no context,
  // yet they hold host ports on the queenzee host. A container xell placed on that same host must
  // see them, or the two fight over one port. On any OTHER context they are irrelevant.
  console.log('\n── process rows (docker_ctx NULL) count on the queenzee host, and only there ──');
  const HOST = queenzeeHostCtx();
  await rec('server', SB + 80, null);
  const onHost = await freeAppSlot(HOST, { serverBase: SB, webBase: WB, slot: 80, docker: daemonUp([]) });
  ok(onHost.slot === 81, `a process server row on :${SB + 80} is seen on '${HOST}' → slot ${onHost.slot}`);
  const elsewhere = await freeAppSlot(CTX, { serverBase: SB, webBase: WB, slot: 80, docker: daemonUp([]) });
  ok(elsewhere.slot === 80, `…and NOT on another context '${CTX}' → slot ${elsewhere.slot} (a process on the `
     + 'queenzee host cannot collide with a container on a remote daemon)');

  // ── END TO END: the real provisionXell, on a project rigged to collide ──
  // port_slot_mod = 1 makes EVERY slug hash to slot 0, so the second xell is guaranteed to want the
  // first one's ports. Before this fix both rows recorded the same pair and the second stack died
  // at bind (→ 'missing' → the pool fill STOPS). Simulate mode: rows only, no machine touched.
  console.log('\n── provisionXell: a guaranteed slot collision produces DIFFERENT, still-paired ports ──');
  const p2 = (await one(
    `INSERT INTO project (name, repo_root, main_branch, port_server_base, port_web_base, port_slot_mod)
     VALUES ($1,$2,'main',$3,$4,1) RETURNING id`,
    [`zt-appalloc-collide-${tag}`, tmp, SB, WB])).id;
  madeProjects.push(p2);
  await q(`INSERT INTO xource (project_id, ref) VALUES ($1,'main')`, [p2]);
  await q(`INSERT INTO pool_config (project_id, target_ready) VALUES ($1,0)`, [p2]);

  const x1 = await provisionXell({ projectId: p2, mode: 'simulate' });
  const x2 = await provisionXell({ projectId: p2, mode: 'simulate' });
  ok(computePorts(x1.slug, { port_server_base: SB, port_web_base: WB, port_slot_mod: 1 }).slot === 0
     && computePorts(x2.slug, { port_server_base: SB, port_web_base: WB, port_slot_mod: 1 }).slot === 0,
     'both slugs hash to slot 0 (slot_mod=1) — the formula would hand both xells the same pair');
  const portsOf = async (id) => Object.fromEntries((await q(
    `SELECT role, host_port FROM container WHERE owner_xell_id=$1 AND role IN ('server','webapp')`, [id]))
    .map((r) => [r.role, Number(r.host_port)]));
  const r1 = await portsOf(x1.id);
  const r2 = await portsOf(x2.id);
  ok(r1.server === SB && r1.webapp === WB,
     `the first xell keeps the formula pair :${r1.server}/:${r1.webapp}`);
  ok(r2.server !== r1.server && r2.webapp !== r1.webapp,
     `the second xell does NOT reuse them (:${r2.server}/:${r2.webapp} vs :${r1.server}/:${r1.webapp}) `
     + '— the collision that halts a pool never gets recorded');
  ok(r2.server - SB === r2.webapp - WB,
     `…and its ports stay PAIRED on one slot (${r2.server - SB}): :${r2.server}/:${r2.webapp}`);
  const url = (await one(`SELECT url FROM container WHERE owner_xell_id=$1 AND role='webapp'`, [x2.id]))?.url;
  ok(String(url).endsWith(`:${r2.webapp}`),
     `the xell's URL carries the ALLOCATED web port, not the formula one (${url})`);
  ok(String(x2.url).endsWith(`:${r2.webapp}`),
     `…and so does the URL provisionXell RETURNS to the pool (${x2.url})`);

  // ── REAL MODE: the ports reach the stack, and a LOST BIND is retried on the next slot ──
  // The allocation reads the daemon at ONE moment; something can bind between the read and
  // `spin-env.sh up` (and when docker is unreachable the read saw nothing at all). The db path
  // already treats a bind refusal as "retry the next free slot"; the app tier now does the same,
  // so a race costs a retry instead of the whole project's pool fill.
  //
  // A real fixture repo (git worktree + a spin-env.sh of our own) drives scripts/provision-xell.sh
  // for real — no docker, no machine: the fixture spin-env.sh RECORDS the ports it was handed and
  // REFUSES the first pair exactly as a losing docker bind would.
  console.log('\n── real mode: the allocated ports reach spin-env.sh, and a lost bind retries ──');
  const SB2 = SB + 1000, WB2 = WB + 1000;   // a ladder of its own: the section above already claimed rows on SB/WB
  const repo = join(tmp, 'repo');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  const seen = join(tmp, 'spin-env-saw.txt');
  writeFileSync(join(repo, 'scripts', 'spin-env.sh'),
    '#!/usr/bin/env bash\n'
    + `echo "$SPINOFF_SERVER_PORT $SPINOFF_WEB_PORT" >> ${JSON.stringify(seen)}\n`
    + `if [ "$SPINOFF_SERVER_PORT" = "${SB2}" ]; then\n`
    + `  echo "Error response from daemon: Bind for 0.0.0.0:${WB2} failed: port is already allocated" >&2\n`
    + '  exit 1\nfi\n');
  writeFileSync(join(repo, 'package.json'), '{"name":"zt-appalloc-fixture"}\n');   // no lockfile: no npm warm
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git('config', 'user.email', 'zt@example.invalid'); git('config', 'user.name', 'zt');
  git('add', '-A'); git('commit', '-qm', 'fixture');

  const p3 = (await one(
    `INSERT INTO project (name, repo_root, main_branch, port_server_base, port_web_base, port_slot_mod)
     VALUES ($1,$2,'main',$3,$4,1) RETURNING id`,
    [`zt-appalloc-real-${tag}`, repo, SB2, WB2])).id;
  madeProjects.push(p3);
  await q(`INSERT INTO xource (project_id, ref) VALUES ($1,'main')`, [p3]);
  await q(`INSERT INTO pool_config (project_id, target_ready) VALUES ($1,0)`, [p3]);
  // This cage's .zeehive.env sets PROVISION_APP_TIER=false (the nested-queenzee safety default) —
  // the app tier is the whole point here, so ask for it explicitly and put it back afterwards.
  const oldAppTier = process.env.PROVISION_APP_TIER;
  process.env.PROVISION_APP_TIER = 'true';
  let x3;
  try {
    x3 = await provisionXell({ projectId: p3, mode: 'real' });
  } finally { process.env.PROVISION_APP_TIER = oldAppTier; }
  const r3 = await portsOf(x3.id);
  const handed = readFileSync(seen, 'utf8').trim().split('\n');
  ok(handed[0] === `${SB2} ${WB2}`,
     `spin-env.sh was handed the ALLOCATED pair, not its own formula (first attempt: '${handed[0]}')`);
  ok(handed.length === 2 && handed[1] === `${SB2 + 1} ${WB2 + 1}`,
     `the refused bind was retried ONCE on the next slot (attempt 2: '${handed[1] ?? 'none'}')`);
  ok(r3.server === SB2 + 1 && r3.webapp === WB2 + 1,
     `and the rows record the pair that actually came up (:${r3.server}/:${r3.webapp}), not the refused one `
     + '— a row whose port nothing listens on is the fault this whole family exists to stop');
  ok(String(x3.url).endsWith(`:${r3.webapp}`), `the returned URL follows the retry (${x3.url})`);
} finally {
  for (const id of madeProjects) {
    await q(`DELETE FROM xell_uses_container WHERE xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [id]).catch(() => {});
    await q(`DELETE FROM container WHERE project_id=$1`, [id]).catch(() => {});
    await q(`DELETE FROM xell WHERE project_id=$1`, [id]).catch(() => {});
    await q(`DELETE FROM pool_config WHERE project_id=$1`, [id]).catch(() => {});
    await q(`DELETE FROM xource WHERE project_id=$1`, [id]).catch(() => {});
    await q(`DELETE FROM project WHERE id=$1`, [id]).catch(() => {});
  }
  rmSync(tmp, { recursive: true, force: true });
  await pool.end();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);

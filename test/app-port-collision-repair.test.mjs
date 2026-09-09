// REPAIRING AN ALREADY-RECORDED APP-PORT COLLISION (TKT-85 family) — the other half of the fix.
//
// freeAppSlot stops NEW collisions. It cannot undo the ones the formula era already wrote: the live
// hive has xells whose server/webapp rows record a pair another xell holds (two on ctx 'default'
// both on :4824/:5324). That is not a race — it is a duplicate that is true every time it is read,
// so the losing xell can NEVER build: compose asks for the neighbour's port, dies with "port is
// already allocated", the failure is classed INFRA, the INFRA verdict writes
// build_readiness_record='missing', and the pool fill STOPS for that project on that machine. Until
// now the only cure was a human re-porting rows by hand.
//
// So the build path repairs it first, and this drives the REAL buildContainer (BUILD_MODE=simulate,
// so nothing is compiled) plus the REAL repair against the REAL meta-DB:
//
//   • the LATER xell moves and the older one keeps its ports (first come keeps the port — two
//     xells building at once must not swap places or chase each other up the ladder);
//   • both of the mover's rows AND its URL are re-stamped together (the pair stays a pair);
//   • the build then projects the REPAIRED ports (SPINOFF_SERVER_PORT/SPINOFF_WEB_PORT come from
//     the row — a build must ask for a port it can actually bind);
//   • a xell with no duplicate is untouched — this is a repair, not a re-shuffle.
import { randomUUID } from 'node:crypto';

process.env.PROVISION_MODE = 'simulate';
process.env.BUILD_MODE = 'simulate';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { repairCollidedAppPorts } = await import('../server/src/lib/provision.js');
const { buildContainer } = await import('../server/src/lib/build.js');

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };

const tag = randomUUID().slice(0, 8);
const CTX = `apprepair-${tag}`;
const SB = 33100, WB = 35200;      // far from every live project's ladder
let projId = null;

// a xell with an app-tier pair recorded exactly as provision stamps it
const mkXell = async (slug, serverPort, webPort, readyAt) => {
  const x = (await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, ready_at)
     VALUES ($1,(SELECT id FROM xource WHERE project_id=$1),$2,$3,$4,'ready',true,$5) RETURNING *`,
    [projId, slug, `spinoff/${slug}`, `/tmp/${slug}`, readyAt])).id;
  for (const [role, port] of [['server', serverPort], ['webapp', webPort]]) {
    await q(
      `INSERT INTO container (project_id,role,tier,isolation,name,image_tag,docker_ctx,host,host_port,
          internal_port,url,compose_project,compose_file,owner_xell_id,health)
       VALUES ($1,$2,'spinoff','per-xell',$3,$4,$5,'10.9.9.9',$6,$7,$8,$9,'docker-compose.spinoff.yml',$10,'down')`,
      [projId, role, `apprepair-${slug}-${role}`, `apprepair-${role}:${slug}`, CTX, port,
       role === 'server' ? 3000 : 5173, `http://10.9.9.9:${port}`, `apprepair-${slug}`, x]);
  }
  return x;
};
const portsOf = async (id) => Object.fromEntries((await q(
  `SELECT role, host_port, url FROM container WHERE owner_xell_id=$1 AND role IN ('server','webapp')`, [id]))
  .map((r) => [r.role, { port: Number(r.host_port), url: r.url }]));

try {
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch, port_server_base, port_web_base, port_slot_mod)
     VALUES ($1,$2,'main',$3,$4,1) RETURNING id`,
    [`zt-apprepair-${tag}`, `/tmp/zt-apprepair-${tag}`, SB, WB])).id;
  await q(`INSERT INTO xource (project_id, ref) VALUES ($1,'main')`, [projId]);
  await q(`INSERT INTO pool_config (project_id, target_ready) VALUES ($1,0)`, [projId]);

  // The live shape: two xells, same context, SAME recorded pair. The elder was ready first.
  const elder = await mkXell(`apprepair-elder-${tag}`, SB, WB, '2026-08-01T10:00:00Z');
  const later = await mkXell(`apprepair-later-${tag}`, SB, WB, '2026-08-01T12:00:00Z');

  console.log('\n── first come keeps the port: the elder xell is not moved ──');
  const rElder = await repairCollidedAppPorts(elder);
  ok(rElder.repaired === false, `the elder is left alone (${rElder.reason})`);
  const eP = await portsOf(elder);
  ok(eP.server.port === SB && eP.webapp.port === WB,
     `…and still holds :${eP.server.port}/:${eP.webapp.port} — a repair never disturbs the holder`);

  console.log('\n── the later xell moves, as a PAIR, rows and URL together ──');
  const rLater = await repairCollidedAppPorts(later);
  const lP = await portsOf(later);
  ok(rLater.repaired === true, `the duplicate is repaired (${JSON.stringify(rLater.to || rLater.reason)})`);
  ok(lP.server.port !== SB && lP.webapp.port !== WB,
     `it no longer records the elder's pair (:${lP.server.port}/:${lP.webapp.port})`);
  ok(lP.server.port - SB === lP.webapp.port - WB,
     `…and its ports stay PAIRED on one slot (${lP.server.port - SB})`);
  ok(lP.webapp.url.endsWith(`:${lP.webapp.port}`) && lP.server.url.endsWith(`:${lP.server.port}`),
     `the URLs follow the ports (${lP.webapp.url}) — a row's url must never point at a port it no longer owns`);

  console.log('\n── a repaired xell is stable: a second pass finds nothing to do ──');
  const again = await repairCollidedAppPorts(later);
  const lP2 = await portsOf(later);
  ok(again.repaired === false && lP2.server.port === lP.server.port,
     `no duplicate left → no move (${again.reason}); still :${lP2.server.port}/:${lP2.webapp.port} `
     + '— the repair converges instead of walking the ladder on every build');

  console.log('\n── buildContainer repairs BEFORE it projects the ports it will bind ──');
  // Back into the broken state, then build the later xell's server through the real entry point.
  await q(`UPDATE container SET host_port=$2, url=$3 WHERE owner_xell_id=$1 AND role='server'`,
    [later, SB, `http://10.9.9.9:${SB}`]);
  await q(`UPDATE container SET host_port=$2, url=$3 WHERE owner_xell_id=$1 AND role='webapp'`,
    [later, WB, `http://10.9.9.9:${WB}`]);
  const serverRow = await one(
    `SELECT id FROM container WHERE owner_xell_id=$1 AND role='server'`, [later]);
  const verdict = await buildContainer(serverRow.id, {});
  const lP3 = await portsOf(later);
  ok(verdict?.status === 'building', `the build started (${JSON.stringify(verdict?.status)})`);
  ok(lP3.server.port !== SB && lP3.webapp.port !== WB,
     `…on re-stamped ports (:${lP3.server.port}/:${lP3.webapp.port}), not the neighbour's `
     + `(:${SB}/:${WB}) — the bind that would have failed never happens`);
  const eP2 = await portsOf(elder);
  ok(eP2.server.port === SB && eP2.webapp.port === WB,
     'and the elder still holds what it held — one xell moved, not both');
} finally {
  await q(`DELETE FROM xell_uses_container WHERE xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [projId]).catch(() => {});
  await q(`DELETE FROM container WHERE project_id=$1`, [projId]).catch(() => {});
  await q(`DELETE FROM xell WHERE project_id=$1`, [projId]).catch(() => {});
  await q(`DELETE FROM pool_config WHERE project_id=$1`, [projId]).catch(() => {});
  await q(`DELETE FROM xource WHERE project_id=$1`, [projId]).catch(() => {});
  await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  await pool.end();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);

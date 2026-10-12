// THE "MOVED PORT" HEAL — a db row whose RUNNING container publishes its port somewhere other
// than the row records gets host_port and conn_ref re-stamped from the live mapping.
//
// Third sibling of hostless-db-heal.test.mjs (no address) and machine-site-host-precedence
// (wrong host). A shared dev db is run with `-p 0:5432`, docker picks the host port, and the
// row records it once; a restart hands the container a NEW port and nothing rewrote the row —
// 2026-10-12, omnibiz_db_dev_local recorded 10.1.0.15:32768 while publishing 32769. The
// shared-dev-db readiness check dials the ROW, read ECONNREFUSED, recorded the pair 'missing',
// and the pool fill-stop + dispatch pickDevMachine both honoured it: omnibiz got no xells over a
// db that was up. healStaleDbPortRows (queenzee/containers.js) is the fix; this pins its shape:
//
// • RUNNING, publishes internal_port on ONE other host port → host_port + conn_ref port rewritten
//   (user, host, database in conn_ref kept exactly as recorded).
// • exited                                → untouched (nothing learned; last true address kept)
// • running, publishes nothing            → untouched
// • running, two mappings for that port   → untouched (ambiguous — never a guessed port)
// • running, same port                    → untouched (already correct)
// • prod tier                             → untouched (dev/spinoff shapes only, like its siblings)
// • daemon unreachable (null map)         → untouched
// • dockerPs's CLI payload (Ports STRING) → read the same as the API array (publishedPortsOf)
//
// The ps map is a fake (the monitor's own dockerPs shape); the rows are real. Requires a migrated
// postgres at DATABASE_URL (like hostless-db-heal.test.mjs).
import { randomUUID } from 'node:crypto';

process.env.PROVISION_MODE = 'simulate';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { publishedPortsOf } = await import('../server/src/lib/docker.js');
const { healStaleDbPortRows, liveDbPortFor, withPort } = await import('../server/src/queenzee/containers.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
const ctx = `zt-port-ctx-${tag}`;
const deadCtx = `zt-port-dead-${tag}`;
let proj = null;
const tcp = (pub, priv = 5432) => ({ ip: '0.0.0.0', public: pub, private: priv, type: 'tcp' });
const entry = (state, ports = []) => ({ state, xell: null, project: null, role: null, ports });
try {
  proj = (await one(
    `INSERT INTO project (name, repo_root, main_branch, manifest, compose_spinoff, db_name, db_user)
     VALUES ($1,$2,'main',$3::jsonb,NULL,$4,$5) RETURNING id`,
    [`zt-port-proj-${tag}`, `/tmp/zt-port-${tag}`, JSON.stringify({ tiers: { spinoff: {} } }), 'omnibiz', 'postgres'])).id;
  await q(`INSERT INTO machine (key, docker_ctx, max_xells, enabled) VALUES ($1,$2,9,true)`, [`zt-port-m-${tag}`, ctx]);
  await q(`INSERT INTO machine (key, docker_ctx, max_xells, enabled) VALUES ($1,$2,9,true)`, [`zt-port-dead-${tag}`, deadCtx]);

  const mk = async (name, { tier = 'dev', port = 32768, dctx = ctx } = {}) => (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, host, host_port, internal_port, conn_ref, conn_pw, health)
     VALUES ($1,'db',$2,'shared',$3,$4,'10.1.0.15',$5,5432,$6,'secret','up') RETURNING *`,
    [proj, tier, name, dctx, port, `postgresql://postgres@10.1.0.15:${port}/omnibiz`]));
  const moved = await mk(`zt_port_moved_${tag}`);
  const exited = await mk(`zt_port_exited_${tag}`);
  const unpub = await mk(`zt_port_unpub_${tag}`);
  const ambig = await mk(`zt_port_ambig_${tag}`);
  const same = await mk(`zt_port_same_${tag}`);
  const prod = await mk(`zt_port_prod_${tag}`, { tier: 'prod' });
  const dead = await mk(`zt_port_dead_${tag}`, { dctx: deadCtx });

  // The monitor's own SELECT shape (project_token / xell_slug drive matchContainer).
  const rows = (await q(
    `SELECT c.id, c.name, c.docker_ctx, c.health, c.role, c.isolation, c.tier,
            c.host_port, c.internal_port, c.conn_ref, c.url,
            lower(regexp_replace(p.name, '[^a-zA-Z0-9]', '', 'g')) AS project_token, NULL AS xell_slug
       FROM container c JOIN project p ON p.id = c.project_id WHERE c.project_id=$1`, [proj]));

  const psByCtx = {
    [ctx]: new Map([
      [moved.name, entry('running', [tcp(32769)])],
      [exited.name, entry('exited', [])],
      [unpub.name, entry('running', [])],
      [ambig.name, entry('running', [tcp(32770), tcp(32771)])],
      [same.name, entry('running', [tcp(32768)])],
      [prod.name, entry('running', [tcp(5433)])],
    ]),
    [deadCtx]: null,
  };

  console.log('\n── a running db whose published port moved is re-stamped ──');
  const n = await healStaleDbPortRows(rows, psByCtx);
  const m = await one(`SELECT host_port, conn_ref, conn_pw, host FROM container WHERE id=$1`, [moved.id]);
  ok(m.host_port === 32769, `host_port rewritten to the live port (got ${m.host_port}; the defect is 32768)`);
  ok(m.conn_ref === 'postgresql://postgres@10.1.0.15:32769/omnibiz',
     `conn_ref carries the live port, user/host/db as recorded (got ${m.conn_ref})`);
  ok(m.conn_pw === 'secret' && m.host === '10.1.0.15', 'conn_pw and host untouched');
  ok(n === 1, `exactly one row healed (got ${n})`);

  console.log('\n── every other shape is left exactly as recorded ──');
  for (const [label, r] of [['exited', exited], ['publishes nothing', unpub], ['ambiguous (two mappings)', ambig],
                            ['same port', same], ['prod tier', prod], ['daemon unreachable', dead]]) {
    const x = await one(`SELECT host_port, conn_ref FROM container WHERE id=$1`, [r.id]);
    ok(x.host_port === 32768 && x.conn_ref === r.conn_ref, `${label}: untouched`);
  }

  console.log('\n── idempotent: a second tick over the healed fleet changes nothing ──');
  const n2 = await healStaleDbPortRows(
    (await q(`SELECT c.*, 'x' AS project_token, NULL AS xell_slug FROM container c WHERE c.project_id=$1`, [proj])), psByCtx);
  ok(n2 === 0, `second pass heals nothing (got ${n2})`);

  console.log('\n── the pure halves ──');
  ok(liveDbPortFor({ host_port: 32768, internal_port: 5432 }, { name: 'x', info: entry('running', [tcp(32769)]) }) === 32769, 'liveDbPortFor: moved → the live port');
  ok(liveDbPortFor({ host_port: 32768, internal_port: 5432 }, { name: 'x', info: entry('running', [tcp(32769, 5433)]) }) === null, 'liveDbPortFor: a mapping for another internal port is not this db');
  ok(liveDbPortFor({ host_port: 32768, internal_port: 5432 }, null) === null, 'liveDbPortFor: no match → null');
  ok(withPort('postgresql://postgres@10.1.0.15:32768/omnibiz', 32769) === 'postgresql://postgres@10.1.0.15:32769/omnibiz', 'withPort replaces only the port');
  ok(withPort('not a url', 1) === null, 'withPort: unparseable → null (field left as recorded)');
  const cli = publishedPortsOf({ Ports: '0.0.0.0:32769->5432/tcp, :::32769->5432/tcp' });
  const api = publishedPortsOf({ Ports: [{ IP: '0.0.0.0', PrivatePort: 5432, PublicPort: 32769, Type: 'tcp' }, { IP: '::', PrivatePort: 5432, PublicPort: 32769, Type: 'tcp' }] });
  ok(JSON.stringify(cli) === JSON.stringify(api) && cli.length === 1 && cli[0].public === 32769,
     `publishedPortsOf reads the CLI string and the API array identically (${JSON.stringify(cli)})`);
  ok(publishedPortsOf({ Ports: '5432/tcp' }).length === 0 && publishedPortsOf({ Ports: 42 }).length === 0,
     'publishedPortsOf: exposed-only or junk → publishes nothing');
} finally {
  if (proj) {
    await q(`DELETE FROM container WHERE project_id=$1`, [proj]).catch(() => {});
    await q(`DELETE FROM machine WHERE key LIKE $1`, [`zt-port-%-${tag}`]).catch(() => {});
    await q(`DELETE FROM project WHERE id=$1`, [proj]).catch(() => {});
  }
  await pool.end().catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);

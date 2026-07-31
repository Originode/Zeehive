// A MANAGER'S PROD READ-ONLY DSN — where its ADDRESS comes from.
//
// mintProdReader used to run its OWN raw query for `host(c.host) AS host, c.host_port` and build the
// DSN from those two columns alone (SELECTing c.conn_ref in the same query and never using it). So a
// production database registered ALIAS-ONLY — publishes no host port, reachable only on a docker
// network, which is Zeehive's own meta db and the shape shipmigrate's prodDbAddress() has modelled
// since the ship gate — failed closed with "the prod db row publishes no host:port…", and an
// operator could not add a manager zee at all.
//
// This proves, in order:
//   1. the ADDRESS DECISION is pure and table-testable — port / alias / none, plus reachability;
//   2. mintProdReader reuses prodDbAddress() rather than a second resolver: an alias-only prod db
//      mints a DSN on the alias, end to end, against the REAL registry;
//   3. failure is still CLOSED — an unaddressed row, and an alias on a docker daemon a cxell cannot
//      reach, both refuse, with a message that names WHERE to put the missing address;
//   4. read-only stays read-only: nothing here ever falls back to the owner credential.
//
// PRODRO_MODE=simulate mints nothing; docker is faked on PATH. Nothing touches a real cluster.
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.PRODRO_MODE = 'simulate';
process.env.SHIP_MODE = 'simulate';
process.env.TKB_NOTIFY = '0';

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const bin = mkdtempSync(join(tmpdir(), `pro-bin-${tag}-`));
const stateFile = join(bin, 'state.json');
const setState = (s) => writeFileSync(stateFile, JSON.stringify(s));
const shim = join(bin, 'fake-docker.mjs');
writeFileSync(shim, `#!/usr/bin/env node
import { readFileSync, appendFileSync } from 'node:fs';
const a = process.argv.slice(2);
if (process.env.FAKE_DOCKER_LOG) appendFileSync(process.env.FAKE_DOCKER_LOG, a.join(' ') + '\\n');
const st = JSON.parse(readFileSync(process.env.FAKE_DOCKER_STATE, 'utf8'));
if (a.includes('ps')) { process.stdout.write((st.ps||[]).map(c=>c.name+'\\t'+(c.ports||'')).join('\\n')+'\\n'); process.exit(0); }
if (a[0]==='network' || a[1]==='network') { process.exit(st.networkConnectFails ? 1 : 0); }
if (a.includes('inspect')) { const n=a[a.length-1]; const p=(st.inspect||{})[n];
  if (p===undefined){process.stderr.write('No such object: '+n+'\\n');process.exit(1);} process.stdout.write(JSON.stringify(p)+'\\n'); process.exit(0); }
process.exit(0);
`);
writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash\nexec node "${shim}" "$@"\n`);
chmodSync(join(bin, 'docker'), 0o755);
process.env.FAKE_DOCKER_STATE = stateFile;
process.env.FAKE_DOCKER_LOG = join(bin, 'docker.log');
process.env.PATH = `${bin}:${process.env.PATH}`;
setState({});

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { q, one, pool } = await import('../server/src/db/pool.js');
const PRO = await import('../server/src/lib/prod-readonly.js');

const ALIASC = `pro${tag}_meta_db`;
const PORTC  = `pro${tag}_db_prod`;
let aliasPid = null; let portPid = null; let nonePid = null;

try {
  // ── 1. the ADDRESS DECISION, pure ───────────────────────────────────────────────────────────
  console.log('decideReaderAddress: port / alias / none — pure, no I/O');
  const D = PRO.decideReaderAddress;
  ok(typeof D === 'function', 'the decision is exported as a pure function (not a second resolver inside the mint)');
  if (typeof D === 'function') {
    const proj = { name: 'ProjX' };
    const port = D({ project: proj, db: { ctx: 'default', host_port: 5432, conn_ref: null, logical: PORTC },
                     row: { name: PORTC, host: '10.2.0.16', host_port: 5432 } });
    ok(port.ok && port.mode === 'port' && port.host === '10.2.0.16' && port.port === 5432,
       `a published host:port is unchanged today's behaviour (${port.host}:${port.port})`);

    const alias = D({ project: proj, db: { ctx: 'default', host_port: null, conn_ref: `postgresql://zeehive@meta-db:5432/zeehive`, logical: ALIASC },
                      row: { name: ALIASC, host: null, host_port: null, conn_ref: 'postgresql://zeehive@meta-db:5432/zeehive' } });
    ok(alias.ok && alias.mode === 'alias' && alias.host === 'meta-db' && alias.port === 5432,
       `an alias-only row resolves to its docker network name (${alias.host}:${alias.port})`);

    const alias6 = D({ project: proj, db: { ctx: 'default', host_port: null, conn_ref: 'postgresql://u@meta-db:6543/z' }, row: {} });
    ok(alias6.ok && alias6.port === 6543, 'the port comes from the conn_ref URL when it names one');
    const aliasNoPort = D({ project: proj, db: { ctx: 'default', host_port: null, conn_ref: 'postgresql://u@meta-db/z' }, row: {} });
    ok(aliasNoPort.ok && aliasNoPort.port === 5432, "and defaults to 5432 when it doesn't (libpq's own default)");

    // Reachability is part of the truth: an alias is a DOCKER NETWORK name, and a network on another
    // daemon cannot resolve from a cxell. A DSN that cannot connect is worse than a clear refusal.
    const far = D({ project: proj, db: { ctx: 'mardale-prod', host_port: null, conn_ref: 'postgresql://u@meta-db:5432/z', logical: ALIASC },
                    row: { name: ALIASC } });
    ok(!far.ok && /mardale-prod/.test(far.error || ''),
       'an alias on ANOTHER docker context refuses (a cxell runs on the queenzee\'s daemon)');

    const none = D({ project: proj, db: { ctx: 'default', host_port: null, conn_ref: null, logical: PORTC },
                     row: { name: PORTC, host: null, host_port: null } });
    ok(!none.ok, 'a row carrying NEITHER address still fails CLOSED');
    for (const must of ['ProjX', PORTC, 'host_port', 'conn_ref']) {
      ok(!none.ok && none.error.includes(must), `and the refusal names ${must} — where to put the address`);
    }

    const hostless = D({ project: proj, db: { ctx: 'default', host_port: 5432, conn_ref: 'postgresql://u@meta-db:5432/z' },
                         row: { name: PORTC, host: null, host_port: 5432 } });
    ok(hostless.ok && hostless.mode === 'alias',
       'a host_port with no host falls through to the alias rather than building a dsn on "null"');
  }

  console.log('connRefPort / networksCarryingAlias');
  const haveHelpers = typeof PRO.connRefPort === 'function' && typeof PRO.networksCarryingAlias === 'function';
  ok(haveHelpers, 'the alias helpers are exported');
  if (haveHelpers) {
    ok(PRO.connRefPort('postgresql://z@meta-db:5445/z') === 5445, 'connRefPort reads the URL port');
    ok(PRO.connRefPort('nonsense') === 5432, 'and falls back to 5432');
    const nets = { zeehive_default: { Aliases: ['meta-db'], DNSNames: ['x'] }, other: { Aliases: ['nope'] } };
    ok(JSON.stringify(PRO.networksCarryingAlias(nets, 'meta-db')) === '["zeehive_default"]',
       'networksCarryingAlias names only the network that answers to the alias');
    ok(PRO.networksCarryingAlias(nets, 'ghost').length === 0, 'and none when nothing does');
    ok(PRO.networksCarryingAlias(null, 'x').length === 0, 'null-safe');
  }

  // ── 2. the REAL mint, end to end, over the REAL registry ────────────────────────────────────
  console.log('mintProdReader against an ALIAS-ONLY prod db (the row an operator could not use)');
  aliasPid = (await one(
    `INSERT INTO project (name, repo_root, db_user, db_name) VALUES ($1,$2,'zeehive','zeehive') RETURNING id`,
    [`pro-alias-${tag}`, process.cwd()])).id;
  await q(`INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port, conn_ref)
             VALUES ($1,'db','prod','shared',$2,'default',5432,$3)`,
          [aliasPid, ALIASC, `postgresql://zeehive@meta-db:5432/zeehive`]);
  setState({ ps: [{ name: ALIASC, ports: '' }],
             inspect: { [ALIASC]: { zeehive_default: { Aliases: [ALIASC, 'meta-db'] } } } });

  const aliasProject = await one(`SELECT * FROM project WHERE id=$1`, [aliasPid]);
  const fakeXell = { id: null, slug: `pro-alias-${tag}` };
  let minted = null; let mintErr = null;
  try { minted = await PRO.mintProdReader({ ...fakeXell, id: null }, aliasProject); }
  catch (e) { mintErr = e.message; }
  ok(!mintErr, `the mint SUCCEEDS on an alias-only prod db [${mintErr || 'no error'}]`);
  ok(!!minted?.dsn && minted.dsn.includes('@meta-db:5432/zeehive'),
     `the DSN is built on the network alias (${(minted?.dsn || '').replace(/:[^:@]*@/, ':***@')})`);
  ok(minted?.dsn?.startsWith('postgresql://zee_ro_'), 'with the xell\'s OWN read-only role, never the owner credential');
  ok(minted?.mode === 'simulate', 'and nothing was created (PRODRO_MODE=simulate)');
  ok(minted?.address_mode === 'alias', 'the caller is TOLD the address is an alias (a cxell must join that network)');

  // ── 3. the port shape is byte-for-byte what it always was ───────────────────────────────────
  console.log('mintProdReader against a published host:port prod db (unchanged)');
  portPid = (await one(
    `INSERT INTO project (name, repo_root, db_user, db_name) VALUES ($1,$2,'omnibiz','omnibiz') RETURNING id`,
    [`pro-port-${tag}`, process.cwd()])).id;
  await q(`INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, host, host_port, internal_port)
             VALUES ($1,'db','prod','shared',$2,'default','10.2.0.16',5432,5432)`, [portPid, PORTC]);
  setState({ ps: [{ name: PORTC, ports: '0.0.0.0:5432->5432/tcp' }],
             inspect: { [PORTC]: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '5432' }] } } });
  const portProject = await one(`SELECT * FROM project WHERE id=$1`, [portPid]);
  let pMint = null; let pErr = null;
  try { pMint = await PRO.mintProdReader({ id: null, slug: `pro-port-${tag}` }, portProject); }
  catch (e) { pErr = e.message; }
  ok(!pErr && pMint?.dsn?.includes('@10.2.0.16:5432/omnibiz'),
     `the published address still wins [${pErr || pMint?.address}]`);
  ok(pMint?.address_mode === 'port', 'and is reported as a port address (no network join needed)');

  // ── 4. an UNADDRESSED row still fails CLOSED, actionably ────────────────────────────────────
  console.log('mintProdReader against a prod db row with no address at all');
  nonePid = (await one(
    `INSERT INTO project (name, repo_root, db_user, db_name) VALUES ($1,$2,'x','x') RETURNING id`,
    [`pro-none-${tag}`, process.cwd()])).id;
  const NONEC = `pro${tag}_db_noaddr`;
  await q(`INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port)
             VALUES ($1,'db','prod','shared',$2,'default',5432)`, [nonePid, NONEC]);
  setState({ ps: [{ name: NONEC, ports: '' }], inspect: { [NONEC]: {} } });
  const noneProject = await one(`SELECT * FROM project WHERE id=$1`, [nonePid]);
  let nErr = null;
  try { await PRO.mintProdReader({ id: null, slug: `pro-none-${tag}` }, noneProject); }
  catch (e) { nErr = e.message; }
  ok(!!nErr, 'refused');
  ok(!!nErr && nErr.includes(NONEC) && /host_port/.test(nErr) && /conn_ref/.test(nErr),
     `and the refusal names the container row and the exact columns to fill [${(nErr || '').slice(0, 150)}]`);
  // The refusal may (and does) show the SHAPE of a conn_ref as a placeholder — what it must never
  // carry is a real credential: no minted role, no password, no owner DSN.
  ok(!!nErr && !/zee_ro_/.test(nErr) && !/:\/\/[^<\s]*:[^@\s]*@/.test(nErr),
     'no credential of any kind leaks into the refusal (placeholders only)');

  // ── 5. an alias DSN is only TRUE if the cxell can resolve it — so it JOINS that network ──────
  // ensureCxell() puts a cage on zee-hive-net and nothing else. Without this the alias DSN above
  // would be a lie, which is worse than the refusal it replaced.
  console.log('connectCxellToProdNetwork: the manager cxell joins the prod db\'s network — and only it');
  const xourceId = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [aliasPid])).id;
  const mkX = async (slug, coupling) => (await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, zee_type, db_coupling)
       VALUES ($1,$2,$3,$4,'/tmp/'||$3,'working',false,'manager',$5) RETURNING *`,
    [aliasPid, xourceId, slug, `spinoff/${slug}`, coupling]));
  const mgrX = await mkX(`pro-mgr-${tag}`, 'db-prod-readonly');
  const wrkX = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, zee_type, db_coupling)
       VALUES ($1,$2,$3,$4,'/tmp/'||$3,'working',false,'worker','db-shared-dev') RETURNING *`,
    [aliasPid, xourceId, `pro-wrk-${tag}`, `spinoff/pro-wrk-${tag}`]);

  setState({ ps: [{ name: ALIASC, ports: '' }],
             inspect: { [ALIASC]: { zeehive_default: { Aliases: [ALIASC, 'meta-db'] }, bridge: { Aliases: [] } } } });

  const simJoin = await PRO.connectCxellToProdNetwork({ xellId: mgrX.id, cxellName: 'cxell_pro' });
  ok(simJoin.required === true && simJoin.simulated === true,
     'PRODRO_MODE=simulate creates nothing but still reports the join was REQUIRED');

  const worker = await PRO.connectCxellToProdNetwork({ xellId: wrkX.id, cxellName: 'cxell_wrk' });
  ok(worker.required === false && !worker.joined,
     'an ordinary WORKER cxell is never joined to a prod network (only db-prod-readonly is)');

  // The real docker path, against the fake daemon: which argv it runs, and which network it picks.
  process.env.PRODRO_MODE = 'real';       // PRODRO_MODE is read at module load; a fresh URL re-loads it
  const PROREAL = await import('../server/src/lib/prod-readonly.js?prodro=real');
  process.env.PRODRO_MODE = 'simulate';   // restore for anything imported later
  ok(PROREAL.PRODRO_MODE === 'real', 'fixture: the re-imported module is in REAL mode (docker actually runs)');
  writeFileSync(process.env.FAKE_DOCKER_LOG, '');
  const joined = await PROREAL.connectCxellToProdNetwork({ xellId: mgrX.id, cxellName: 'cxell_pro' });
  ok(joined.joined === true && joined.network === 'zeehive_default',
     `it joins the ONE network that answers to the alias (${joined.network || joined.error})`);
  const log = readFileSync(process.env.FAKE_DOCKER_LOG, 'utf8');
  ok(/network connect zeehive_default cxell_pro/.test(log),
     'by running exactly `docker network connect <net> <this cxell>` — one network, one container');
  ok(!/network connect bridge/.test(log), 'and NOT every network the prod db happens to be on');

  setState({ ps: [{ name: ALIASC, ports: '' }], inspect: { [ALIASC]: { bridge: { Aliases: [] } } } });
  const wrong = await PROREAL.connectCxellToProdNetwork({ xellId: mgrX.id, cxellName: 'cxell_pro' });
  ok(!wrong.joined && /answers to 'meta-db'/.test(wrong.error || ''),
     'a prod container that answers to no such name FAILS CLOSED with the reason, joining nothing');

  // ── 6. the read-only guarantee is untouched ─────────────────────────────────────────────────
  console.log('read-only stays read-only');
  const sql = PRO.readonlyRoleSql(PRO.roRoleName('x'), 'pw', 'db', 'owner');
  ok(/GRANT SELECT ON ALL TABLES/.test(sql) && /default_transaction_read_only = on/.test(sql)
     && !/GRANT (INSERT|UPDATE|DELETE|ALL)/.test(sql),
     'the minted role is still SELECT-only, forced read-only at session level');

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  for (const p of [aliasPid, portPid, nonePid]) {
    if (p) await q(`DELETE FROM project WHERE id=$1`, [p]).catch(() => {});
  }
  await pool.end().catch(() => {});
  try { rmSync(bin, { recursive: true, force: true }); } catch { /* */ }
}
process.exit(fail ? 1 : 0);

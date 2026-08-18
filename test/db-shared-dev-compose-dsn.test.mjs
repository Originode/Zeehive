// A db-shared-dev xell gets a DATABASE_URL for EVERY runner — the cxell zee has no docker.
//
// resolveXellDsn only emitted the linked shared dev db's conn_ref for PROCESS-runner projects,
// on the theory that a compose-runner xell's CONTAINERS reach the db by compose-network alias.
// That is true for the containers — but the CXELL zee, the agent in its cage, is not on that
// network: it has no docker and reaches postgres over TCP, so its .zeehive.env needs the same
// TCP door. This is the report that keeps coming back ("this xell's .zeehive.env has no
// DATABASE_URL"), and ZEEHIVE itself is a compose-runner project (zeehive.yml tiers.spinoff
// declares no runner, so the default applies).
//
// Pinned here:
//   • compose-runner db-shared-dev WITH a linked shared dev db → DATABASE_URL = the conn_ref
//   • the same, with a conn_ref-less but PUBLISHED shared dev db → derived TCP DSN (host:port)
//   • db-shared-dev with NO shared dev db linked → no DATABASE_URL (still the db-less state)
//   • the projection carries exactly ONE DATABASE_URL line — an environment cannot override it
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.PROVISION_MODE = 'simulate';
process.env.BUILD_MODE = 'simulate';
process.env.TKB_NOTIFY = '0';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { q, one, pool } = await import('../server/src/db/pool.js');
const { emitXellEnv } = await import('../server/src/lib/provision.js');

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const root = mkdtempSync(join(tmpdir(), `sdcomp-${tag}-`));
let pid = null;

function readEmitted(dir) {
  const text = readFileSync(join(dir, '.zeehive.env'), 'utf8');
  const vars = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) vars[m[1]] = m[2];
  }
  return { text, vars };
}

try {
  // Compose-runner project — the default shape, ZEEHIVE itself included: tiers.spinoff exists but
  // declares NO runner, so spinRunner stays null and every role resolves as a compose service.
  pid = (await one(
    `INSERT INTO project (name, repo_root, db_user, db_name, manifest)
       VALUES ($1,$2,'zeehive','zeehive',$3::jsonb) RETURNING id`,
    [`sdcomp-${tag}`, process.cwd(), JSON.stringify({
      tiers: { spinoff: { ports: {
        server: { env: 'PORT', base: 4800, mod: 90 },
        webapp: { env: 'ZEEHIVE_WEB_PORT', base: 5300, mod: 90 },
      } } },
      roles: { server: {}, webapp: {} },
    })])).id;
  const xoid = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [pid])).id;

  const SHARED_DEV = `postgresql://zeehive@shared_dev_${tag}:5432/devdb`;
  const DERIVED_DEV = `postgresql://zeehive@10.77.0.9:5433/zeehive`;

  // The shared dev db the xell USES — the inventory shape this whole fix is about.
  const sharedDevId = (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port, conn_ref)
       VALUES ($1,'db','dev','shared',$2,'default',5432,$3) RETURNING id`,
    [pid, `sdcomp_shared_${tag}`, SHARED_DEV])).id;

  // A SECOND shared dev db that is PUBLISHED (host+host_port) but records no conn_ref — the
  // derived-TCP-DSN fallback path, so a caged zee still gets a door rather than a docker exec.
  const publishedDevId = (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port,
                            host, host_port, conn_ref)
       VALUES ($1,'db','dev','shared',$2,'default',5432,'10.77.0.9',5433,NULL) RETURNING id`,
    [pid, `sdcomp_pub_${tag}`])).id;

  const mkXell = async (name, { coupling, useShared = null }) => {
    const slug = `sdcomp-${tag}-${name}`;
    const wt = join(root, name);
    mkdirSync(wt, { recursive: true });
    const x = await one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                         zee_type, db_coupling)
         VALUES ($1,$2,$3,$4,$5,'working',false,'worker',$6) RETURNING *`,
      [pid, xoid, slug, `spinoff/${slug}`, wt, coupling]);
    if (useShared) {
      await q(`INSERT INTO xell_uses_container (xell_id, container_id, relation) VALUES ($1,$2,'uses')`,
              [x.id, useShared]);
    }
    // server row so ports land (emit needs something to stamp)
    await q(`INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port,
                                    host_port, owner_xell_id)
               VALUES ($1,'server','spinoff','per-xell',$2,'default',4700,$3,$4)`,
            [pid, `sdcomp_${tag}_${name}_srv`, 4800 + name.length, x.id]);
    return { ...x, wt };
  };

  const withRef     = await mkXell('withref', { coupling: 'db-shared-dev', useShared: sharedDevId });
  const published   = await mkXell('published', { coupling: 'db-shared-dev', useShared: publishedDevId });
  const bare        = await mkXell('bare', { coupling: 'db-shared-dev' });

  // ── 1. the report that started it: the linked shared dev db's conn_ref lands ────────────────
  console.log('\n── compose-runner db-shared-dev WITH a linked shared dev db gets DATABASE_URL ──');
  await emitXellEnv(withRef.id);
  const refFile = readEmitted(withRef.wt);
  ok(refFile.vars.DATABASE_URL === SHARED_DEV,
     `DATABASE_URL is the shared dev db's conn_ref (${refFile.vars.DATABASE_URL})`);
  ok((refFile.text.match(/^DATABASE_URL=/gm) || []).length === 1,
     'exactly one DATABASE_URL line lands in the file');

  // ── 2. a published-but-conn_ref-less shared dev db still yields a TCP door ──────────────────
  console.log('\n── a conn_ref-less but PUBLISHED shared dev db is derived, not dropped ──');
  await emitXellEnv(published.id);
  const pubFile = readEmitted(published.wt);
  ok(pubFile.vars.DATABASE_URL === DERIVED_DEV,
     `DATABASE_URL is derived from host:host_port (${pubFile.vars.DATABASE_URL})`);

  // ── 3. no linked shared dev db → still no DATABASE_URL (the genuinely db-less state) ────────
  console.log('\n── db-shared-dev with NO shared dev db linked stays DSN-less ──');
  await emitXellEnv(bare.id);
  const bareFile = readEmitted(bare.wt);
  ok(bareFile.vars.DATABASE_URL === undefined,
     'no DATABASE_URL line is written (nothing is linked, so nothing is projected)');

} finally {
  if (pid) await q(`DELETE FROM project WHERE id=$1`, [pid]).catch(() => {});
  try { rmSync(root, { recursive: true, force: true }); } catch { /* tmp */ }
  await pool.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);

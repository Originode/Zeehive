// DNS HOSTNAMES IN HOST COLUMNS — where a docker context / daemon lives may be a DNS name,
// not just an IP.
//
// The columns that name WHERE things run (project.dev_host_ip/prod_host_ip, deploy_site.host,
// container.host) were typed `inet`, which only accepts IP addresses. A docker context endpoint
// can be tcp://docker.example.com:2375, a machine's host_ip is already free text, and a
// container's published host can be a docker network name. Migration 107 casts them all to text.
//
// This proves, against the REAL registry:
//   1. the four host columns are TEXT (not inet), so a DNS name can be stored;
//   2. DNS hostnames round-trip through each of them;
//   3. the code paths that read them back (resolveSite, bindingFor) surface the DNS name.
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { q, one, pool } = await import('../server/src/db/pool.js');
const { resolveSite } = await import('../server/src/lib/sites.js');
const { bindingFor } = await import('../server/src/queenzee/intake.js');

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
let pid = null;

try {
  // ── 1. the columns are TEXT — a DNS name can be stored at all ────────────────────────────────
  console.log('host columns are text (not inet) so DNS names can be stored');
  const cols = await q(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE (table_name='project'   AND column_name IN ('dev_host_ip','prod_host_ip'))
         OR (table_name='deploy_site' AND column_name='host')
         OR (table_name='container'   AND column_name='host')
      ORDER BY table_name, column_name`);
  const type = (t, c) => cols.find((x) => x.table_name === t && x.column_name === c)?.data_type;
  ok(type('project', 'dev_host_ip') === 'text', `project.dev_host_ip is text [${type('project', 'dev_host_ip')}]`);
  ok(type('project', 'prod_host_ip') === 'text', `project.prod_host_ip is text [${type('project', 'prod_host_ip')}]`);
  ok(type('deploy_site', 'host') === 'text', `deploy_site.host is text [${type('deploy_site', 'host')}]`);
  ok(type('container', 'host') === 'text', `container.host is text [${type('container', 'host')}]`);

  // ── 2. DNS hostnames round-trip through every column ─────────────────────────────────────────
  console.log('DNS hostnames round-trip through the host columns');
  pid = (await one(
    `INSERT INTO project (name, repo_root, dev_host_ip, prod_host_ip)
       VALUES ($1, '/tmp', 'build.docker.example.com', 'db.prod.example.com') RETURNING id`,
    [`zt-dns-${tag}`])).id;
  const proj = await one(`SELECT dev_host_ip, prod_host_ip FROM project WHERE id=$1`, [pid]);
  ok(proj.dev_host_ip === 'build.docker.example.com', `project.dev_host_ip keeps the DNS name [${proj.dev_host_ip}]`);
  ok(proj.prod_host_ip === 'db.prod.example.com', `project.prod_host_ip keeps the DNS name [${proj.prod_host_ip}]`);

  await q(
    `INSERT INTO deploy_site (project_id, key, tier, docker_ctx, host, is_default)
       VALUES ($1,'dev','dev','default','dev.docker.example.com',true)`, [pid]);
  const site = await one(`SELECT host FROM deploy_site WHERE project_id=$1 AND key='dev'`, [pid]);
  ok(site.host === 'dev.docker.example.com', `deploy_site.host keeps the DNS name [${site.host}]`);

  await q(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, host, host_port, internal_port)
       VALUES ($1,'db','dev','shared','zt_dns_db','default','meta-db.internal',5432,5432)`, [pid]);
  const con = await one(`SELECT host FROM container WHERE project_id=$1 AND name='zt_dns_db'`, [pid]);
  ok(con.host === 'meta-db.internal', `container.host keeps the DNS name [${con.host}]`);

  // ── 3. the shipped readers surface the DNS name, not a dropped/null host ─────────────────────
  console.log('shipped readers surface the DNS host');
  const devSite = await resolveSite(pid, 'dev');
  ok(devSite?.host === 'dev.docker.example.com',
     `resolveSite returns the DNS host for the dev site [${devSite?.host || 'none'}]`);

  // bindingFor reads the xell's own container rows — stand up a minimal xell + uses link.
  const xo = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [pid])).id;
  const xell = (await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, db_coupling)
       VALUES ($1,$2,$3,$4,'/tmp/'||$3,'working',false,'db-shared-dev') RETURNING id`,
    [pid, xo, `zt-dns-xell-${tag}`, `spinoff/zt-dns-xell-${tag}`])).id;
  await q(`INSERT INTO xell_uses_container (xell_id, container_id, relation) VALUES ($1,$2,'owns')`,
          [xell, (await one(`SELECT id FROM container WHERE project_id=$1 AND name='zt_dns_db'`, [pid])).id]);
  const binding = await bindingFor(xell, { id: 'fake', status: 'working' }, null, { cxell: true });
  const dbRow = binding.containers?.find?.((c) => c.role === 'db') || binding.db || null;
  ok((dbRow?.host || binding.host || '') === 'meta-db.internal',
     `bindingFor surfaces container.host 'meta-db.internal' [${dbRow?.host || binding.host || 'none'}]`);

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  if (pid) await q(`DELETE FROM project WHERE id=$1`, [pid]).catch(() => {});
  await pool.end().catch(() => {});
}
process.exit(fail ? 1 : 0);

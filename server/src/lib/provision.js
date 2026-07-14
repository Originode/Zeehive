// Deterministic xell provisioning. Materializes a xell + its container stack in the
// meta-DB. In 'real' mode it also runs scripts/provision-xell.sh (git worktree +
// spin-env up on ugreen-nas); in 'simulate' mode it only records the modeled state
// (correctly-computed ports/names) with NO live side effects on the dev NAS.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pool, q, one } from '../db/pool.js';
import { config } from '../config.js';
import { broadcast } from '../lib/events.js';
import { headCommit } from './git.js';

const ADJ = ['swift', 'calm', 'bright', 'bold', 'keen', 'lively', 'nimble', 'quiet', 'sunny', 'wise'];
const NOUN = ['harbor', 'meadow', 'summit', 'delta', 'ember', 'grove', 'atlas', 'cove', 'ridge', 'vale'];

// Mirror of spin-env.sh: slot = (first 4 hex of md5(slug)) % 90.
export function computePorts(slug) {
  const hex = crypto.createHash('md5').update(slug).digest('hex').slice(0, 4);
  const slot = parseInt(hex, 16) % 90;
  return { slot, serverPort: 3100 + slot, webPort: 5200 + slot };
}

export async function makeSlug(projectId) {
  for (let i = 0; i < 50; i++) {
    const a = ADJ[crypto.randomInt(ADJ.length)];
    const n = NOUN[crypto.randomInt(NOUN.length)];
    const suffix = crypto.randomBytes(3).toString('hex');
    const slug = `${a}-${n}-${suffix}`;
    const clash = await one(`SELECT 1 FROM xell WHERE project_id=$1 AND slug=$2`, [projectId, slug]);
    if (!clash) return slug;
  }
  throw new Error('could not allocate a unique slug');
}

// Provision one pooled (empty, ready) xell for a project.
export async function provisionXell({ projectId, mode = 'simulate', sourceCoupling, dbCoupling }) {
  const project = await one(`SELECT * FROM project WHERE id=$1`, [projectId]);
  const xource = await one(`SELECT * FROM xource WHERE project_id=$1 AND ref=$2`, [projectId, project.main_branch]);
  const cfg = await one(`SELECT * FROM pool_config WHERE project_id=$1`, [projectId]);
  const slug = await makeSlug(projectId);
  const branch = `spinoff/${slug}`;
  const worktree = `${project.repo_root.replace(/\\/g, '/')}/.claude/worktrees/${slug}`;
  const ports = computePorts(slug);
  const url = `http://${project.dev_host_ip}:${ports.webPort}`;

  // the xell branches off the CURRENT xource tip — capture it (cheap, both modes)
  let head = headCommit(project.repo_root, project.main_branch);
  let health = 'unknown';
  if (mode === 'real') {
    const script = resolve(config.repoRoot, 'scripts', 'provision-xell.sh');
    const r = spawnSync('bash', [script, slug, project.repo_root.replace(/\\/g, '/')], {
      encoding: 'utf8', timeout: 600000,
      env: { ...process.env, SPINOFF_DOCKER_CONTEXT: config.dockerCtx, DEV_HOST_IP: project.dev_host_ip },
    });
    if (r.status !== 0) throw new Error(`provision-xell.sh failed: ${(r.stderr || '').slice(-500)}`);
    health = 'up'; // head_commit stays the full xource tip captured above

  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [xell] } = await client.query(
      `INSERT INTO xell (project_id,xource_id,slug,branch,worktree_path,git_dir,head_commit,
          source_coupling,db_coupling,status,is_pooled,ready_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',true,now()) RETURNING *`,
      [projectId, xource.id, slug, branch, worktree,
       `${worktree}/.git`, head,
       sourceCoupling || cfg.default_source_coupling, dbCoupling || cfg.default_db_coupling]);

    // per-xell containers: its own server + webapp
    const mk = async (role, name, hostPort, intPort, curl, image) => {
      const { rows: [c] } = await client.query(
        `INSERT INTO container (project_id,role,tier,isolation,name,image_tag,docker_ctx,host,host_port,internal_port,url,compose_project,compose_file,owner_xell_id,health)
         VALUES ($1,$2,'spinoff','per-xell',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [projectId, role, name, image, project.docker_ctx_dev, project.dev_host_ip, hostPort, intPort, curl,
         `omnibiz-spin-${slug}`, project.compose_spinoff, xell.id, health]);
      await client.query(`INSERT INTO xell_uses_container (xell_id,container_id,relation) VALUES ($1,$2,'owns')`, [xell.id, c.id]);
    };
    await mk('server', `omnibiz_spin_server_${slug}`, ports.serverPort, 3000, `http://${project.dev_host_ip}:${ports.serverPort}`, `omnibiz-spin-server:${slug}`);
    await mk('webapp', `omnibiz_spin_web_${slug}`, ports.webPort, 5173, url, `omnibiz-spin-webapp:${slug}`);

    // db coupling: link the shared dev db it USES (db-shared-dev default)
    if ((dbCoupling || cfg.default_db_coupling) === 'db-shared-dev') {
      const shared = await client.query(
        `SELECT id FROM container WHERE project_id=$1 AND role='db' AND tier='dev' AND isolation='shared' LIMIT 1`, [projectId]);
      if (shared.rows[0]) {
        await client.query(`INSERT INTO xell_uses_container (xell_id,container_id,relation) VALUES ($1,$2,'uses') ON CONFLICT DO NOTHING`, [xell.id, shared.rows[0].id]);
      }
    }
    await client.query('COMMIT');
    broadcast('xell', xell);
    return { ...xell, ports, url, mode };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

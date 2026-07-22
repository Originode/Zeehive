// Machines — the physical docker hosts of the hive, as data (migration 023). One row per docker
// context: what the host IS (can it build?), what it should carry (pool_size / max_xells), and
// where new dev work goes first (dev_priority). Consumed by:
//   provision.js  — pickDevMachine() chooses WHERE a fresh xell spawns; defaultBuildCtxFor()
//                   chooses WHERE its images compile (the NAS runs but must not build).
//   pool.js       — per-machine pool targets replace pool_config.target_ready once any dev
//                   machine exists.
//   intake.js     — dispatch claims a ready xell from the highest-priority machine first.
//   the console   — the container matrix renders one column per machine, and this module's CRUD
//                   is what its "+ machine" / knobs call.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { q, one } from '../db/pool.js';
import { config } from '../config.js';
import { broadcast } from './events.js';
import { logline } from './logbus.js';
import { resolveContext } from './docker.js';
import { resolveBash } from './bash.js';
import { namingFor } from './manifest.js';

const MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

// projectId (optional) scopes pool_size AND dev_priority to that project (machine_pool, 025+038) —
// the matrix shows and edits THIS project's pool and spawn priority on each machine. Without it,
// rows carry neither: there is no such thing as a machine-wide pool or priority anymore, only the
// machine-wide max_xells cap.
export async function listMachines(projectId = null) {
  if (!projectId) {
    return q(`SELECT id, key, label, docker_ctx, host_ip, can_build, can_device,
                     max_xells, enabled, notes, created_at
                FROM machine ORDER BY created_at`);
  }
  return q(
    `SELECT m.id, m.key, m.label, m.docker_ctx, m.host_ip, m.can_build, m.can_device,
            m.max_xells, m.enabled, m.notes, m.created_at,
            COALESCE(mp.pool_size, 0)    AS pool_size,
            COALESCE(mp.dev_priority, 0) AS dev_priority
       FROM machine m LEFT JOIN machine_pool mp ON mp.machine_id = m.id AND mp.project_id = $1
      ORDER BY COALESCE(mp.dev_priority, 0) DESC, m.created_at`, [projectId]);
}

// This machine's warm-pool target for ONE project. No row → 0: a project pools nowhere it
// hasn't been given a number.
export async function machinePoolSize(machineId, projectId) {
  const r = await one(
    `SELECT pool_size FROM machine_pool WHERE machine_id=$1 AND project_id=$2`, [machineId, projectId]);
  return r?.pool_size || 0;
}

// This machine's dev spawn priority for ONE project (machine_pool, 038). No row / 0 → this
// machine is not a dev spawn target for the project at all.
export async function machinePriority(machineId, projectId) {
  const r = await one(
    `SELECT dev_priority FROM machine_pool WHERE machine_id=$1 AND project_id=$2`, [machineId, projectId]);
  return r?.dev_priority || 0;
}

// Upsert ONE column of the per-(machine, project) policy row (machine_pool) — pool_size or
// dev_priority — leaving the other untouched (INSERT defaults it, ON CONFLICT never overwrites it).
async function setMachinePolicyField(machineId, projectId, field, value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${field} must be a non-negative integer`);
  const m = await one(`SELECT key FROM machine WHERE id=$1`, [machineId]);
  if (!m) throw new Error('machine not found');
  const row = await one(
    `INSERT INTO machine_pool (machine_id, project_id, ${field}) VALUES ($1,$2,$3)
     ON CONFLICT (machine_id, project_id) DO UPDATE SET ${field}=EXCLUDED.${field}
     RETURNING *`, [machineId, projectId, n]);
  broadcast('machine', { id: machineId });
  logline('machine', `${label} on ${m.key} → ${n} for project ${String(projectId).slice(0, 8)}`);
  return row;
}

export async function setMachinePool(machineId, projectId, poolSize) {
  return setMachinePolicyField(machineId, projectId, 'pool_size', poolSize, 'pool');
}

export async function setMachinePriority(machineId, projectId, priority) {
  return setMachinePolicyField(machineId, projectId, 'dev_priority', priority, 'dev priority');
}

// Machines that may host DEV xells FOR THIS PROJECT, best first (per-project priority, 038): a
// machine with no machine_pool row or dev_priority 0 for the project is not a target for it, even
// if another project spawns there. No projectId, or none configured for it ⇒ empty, and placement
// falls back to the legacy single-dev-site behavior — a fresh install keeps working with zero rows.
export async function devMachines(projectId) {
  if (!projectId) return [];
  return q(
    `SELECT m.id, m.key, m.label, m.docker_ctx, m.host_ip, m.can_build, m.can_device,
            m.max_xells, m.enabled, m.notes, m.created_at,
            mp.dev_priority AS dev_priority, COALESCE(mp.pool_size, 0) AS pool_size
       FROM machine m JOIN machine_pool mp ON mp.machine_id = m.id AND mp.project_id = $1
      WHERE m.enabled AND mp.dev_priority > 0
      ORDER BY mp.dev_priority DESC, m.created_at`, [projectId]);
}

export async function machineForCtx(ctx) {
  if (!ctx) return null;
  return one(`SELECT * FROM machine WHERE docker_ctx = $1`, [ctx]);
}

function validate(body, { partial = false } = {}) {
  const errs = [];
  if (!partial || body.key !== undefined) {
    if (!body.key || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(body.key)) {
      errs.push('key is required: lowercase letters/digits/dashes (e.g. "local", "ugreen-nas")');
    }
  }
  if (!partial || body.docker_ctx !== undefined) {
    if (!String(body.docker_ctx || '').trim()) errs.push('docker_ctx is required (a docker context name)');
  }
  for (const f of ['dev_priority', 'pool_size', 'max_xells']) {
    if (body[f] !== undefined && (!Number.isInteger(Number(body[f])) || Number(body[f]) < 0)) {
      errs.push(`${f} must be a non-negative integer`);
    }
  }
  if (errs.length) throw new Error(errs.join('; '));
}

export async function createMachine(body = {}) {
  validate(body);
  // The context must actually exist on the queenzee's docker CLI — a typo here would otherwise
  // surface later as every provision on this machine failing with an opaque docker error.
  const ctx = String(body.docker_ctx).trim();
  const known = await resolveContext(ctx).catch(() => null);
  if (!known) throw new Error(`docker context '${ctx}' is not configured on this machine — \`docker context ls\` doesn't know it`);
  const row = await one(
    `INSERT INTO machine (key,label,docker_ctx,host_ip,can_build,can_device,max_xells,enabled,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,true),$9) RETURNING *`,
    [body.key, body.label || null, ctx, body.host_ip || null, !!body.can_build, !!body.can_device,
     Number(body.max_xells) || 0,
     body.enabled === undefined ? null : !!body.enabled, body.notes || null]);
  // Pool AND priority are per (machine, project): a pool_size / dev_priority on create applies to
  // the project the console is looking at — other projects start at 0 here and set their own
  // numbers from their own views. Only max_xells (the cap) is a machine-wide fact on the row.
  if (body.project_id && Number(body.pool_size) > 0) {
    await setMachinePool(row.id, body.project_id, Number(body.pool_size));
  }
  if (body.project_id && Number(body.dev_priority) > 0) {
    await setMachinePriority(row.id, body.project_id, Number(body.dev_priority));
  }
  broadcast('machine', row);
  logline('machine', `machine added: ${row.key} (ctx ${row.docker_ctx}${row.can_build ? ', builds' : ', no builds'}${row.can_device ? ', devices' : ''}, cap ${row.max_xells}${Number(body.dev_priority) > 0 ? `, priority ${Number(body.dev_priority)} for this project` : ''})`);
  return row;
}

// dev_priority is NOT here: it is per (machine, project) now (machine_pool, 038), set through
// setMachinePriority, not PATCHed onto the machine row.
const PATCHABLE = ['key', 'label', 'docker_ctx', 'host_ip', 'can_build', 'can_device',
                   'max_xells', 'enabled', 'notes'];

export async function updateMachine(id, body = {}) {
  validate(body, { partial: true });
  if (body.docker_ctx !== undefined) {
    const known = await resolveContext(String(body.docker_ctx).trim()).catch(() => null);
    if (!known) throw new Error(`docker context '${body.docker_ctx}' is not configured on this machine`);
  }
  const sets = [], vals = [id];
  for (const f of PATCHABLE) {
    if (body[f] === undefined) continue;
    vals.push(body[f]);
    sets.push(`${f}=$${vals.length}`);
  }
  if (!sets.length) throw new Error('nothing to update');
  const row = await one(`UPDATE machine SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, vals);
  if (!row) throw new Error('machine not found');
  broadcast('machine', row);
  return row;
}

export async function deleteMachine(id) {
  const m = await one(`SELECT * FROM machine WHERE id=$1`, [id]);
  if (!m) throw new Error('machine not found');
  // A machine with live containers on it is not a row you delete — it is a host you drain first.
  const inUse = await one(
    `SELECT count(*)::int AS n FROM container c
       LEFT JOIN xell x ON x.id = c.owner_xell_id
      WHERE c.docker_ctx = $1 AND (x.id IS NULL OR x.status <> 'retired')`, [m.docker_ctx]);
  if (inUse?.n > 0) {
    throw new Error(`machine '${m.key}' still has ${inUse.n} container(s) on ${m.docker_ctx} — drain it (pool 0, reap its xells) before deleting`);
  }
  await q(`DELETE FROM machine WHERE id=$1`, [id]);
  broadcast('machine', { id, deleted: true });
  logline('machine', `machine removed: ${m.key}`);
  return { ok: true };
}

// Live DEV xells on a machine, ACROSS every project — max_xells is a machine-wide cap (the host
// only has so much muscle, whoever's xells they are). ready + claimed + working all count; only
// retired ones and production don't. Counted through the server container because that is the
// one row every dev xell owns and stamps with its run context.
export async function liveXellCount(ctx) {
  const r = await one(
    `SELECT count(DISTINCT x.id)::int AS n
       FROM xell x JOIN container c ON c.owner_xell_id = x.id AND c.role='server'
      WHERE x.status <> 'retired' AND NOT x.is_production AND c.docker_ctx = $1`, [ctx]);
  return r?.n || 0;
}

// WHERE does the next dev xell for THIS PROJECT spawn? The highest-priority enabled machine (in
// this project's priorities, 038) that still has room under its machine-wide cap. Returns null
// when no machines are configured for the project (legacy placement) and THROWS when they exist
// but every one is at its cap — "the hive is full" is an answer, not a fallback to the NAS.
export async function pickDevMachine(projectId) {
  const ms = await devMachines(projectId);
  if (!ms.length) return null;
  for (const m of ms) {
    if ((await liveXellCount(m.docker_ctx)) < m.max_xells) return m;
  }
  throw new Error(`every dev machine is at its max_xells cap (${ms.map((m) => m.key).join(', ')}) — raise a cap or mark xells done`);
}

// This project's shared dev db ON a given machine. A dev xell's app tier must never reach across
// docker contexts for its database, so "no dev db here" means this machine cannot host xells yet.
export async function sharedDevDb(projectId, ctx) {
  return one(
    `SELECT * FROM container
      WHERE project_id=$1 AND role='db' AND tier='dev' AND isolation='shared' AND docker_ctx=$2
      LIMIT 1`, [projectId, ctx]);
}

// WHERE do a xell's images compile when it runs on `machine`? On the machine itself when it can
// build; otherwise on the oldest build-capable machine (registry handoff) — build capability is a
// machine-wide fact, so its choice no longer rides on the (now per-project) dev_priority. null ⇒
// build on the run host (no capable machine, or no machines at all): the legacy behavior.
export async function defaultBuildCtxFor(machine) {
  if (!machine || machine.can_build) return null;
  const b = await one(
    `SELECT docker_ctx FROM machine WHERE enabled AND can_build ORDER BY created_at LIMIT 1`);
  return b?.docker_ctx || null;
}

// The best host for a mobile DEVICE xhip: an enabled machine that can run an Android emulator (KVM)
// or has a phone tethered — can_device (035), a machine-wide capability (no per-project priority).
// null ⇒ no device host configured; the device driver turns that into an actionable "mark a machine
// can_device" error, never a crash-loop.
export async function deviceCapableMachine() {
  return one(
    `SELECT * FROM machine WHERE enabled AND can_device ORDER BY created_at LIMIT 1`);
}

// ── per-machine dev db provisioning ───────────────────────────────────────────
// Stand up THIS project's shared dev postgres on a machine that doesn't have one: same script as
// the isolated per-xell db (image + latest prod dump), plus the project-network attach under the
// `postgres` alias so the machine's future spinoff stacks resolve it. Runs in the background
// (a restore takes minutes); the container row appears when it succeeds.
const provisioning = new Set();   // `${projectId}::${machineId}` — one at a time per pair

export async function provisionDevDb(projectId, machineId, { snapshotId = null } = {}) {
  const project = await one(`SELECT * FROM project WHERE id=$1`, [projectId]);
  if (!project) throw new Error('project not found');
  const m = await one(`SELECT * FROM machine WHERE id=$1`, [machineId]);
  if (!m) throw new Error('machine not found');
  const existing = await sharedDevDb(projectId, m.docker_ctx);
  if (existing) throw new Error(`${m.key} already has a shared dev db for ${project.name}: ${existing.name}`);
  const lockKey = `${projectId}::${machineId}`;
  if (provisioning.has(lockKey)) throw new Error(`a dev db provision for ${project.name} on ${m.key} is already running`);

  // Image AND name from the project's OWN db lineage: its existing shared dev db first (a prod
  // dump needs the custom postgis build, and `omnibiz_db_dev` on another machine should read as
  // its sibling `omnibiz_db_dev_<machine>`, not as a per-xell spin name) — else its prod db
  // (bootstrapping a project's FIRST dev db: Zeehive's meta-db is stock postgres, and guessing
  // another project's image would stand up a database its dumps can't even restore into).
  const source = await one(
    `SELECT name, image_tag FROM container
      WHERE project_id=$1 AND role='db' AND tier='dev' AND isolation='shared'
      ORDER BY (image_tag IS NOT NULL) DESC LIMIT 1`, [projectId]);
  const prodDb = source ? null : await one(
    `SELECT name, image_tag, docker_ctx FROM container
      WHERE project_id=$1 AND role='db' AND tier='prod' LIMIT 1`, [projectId]);
  // A modeled prod db row often has no image_tag — the LIVE container knows what it runs.
  let prodImage = prodDb?.image_tag || null;
  if (prodDb && !prodImage && MODE === 'real') {
    prodImage = (spawnSync('docker', ['--context', prodDb.docker_ctx || 'default', 'inspect', '-f', '{{.Config.Image}}', prodDb.name],
      { encoding: 'utf8', timeout: 15000, windowsHide: true }).stdout || '').trim() || null;
  }
  const image = source?.image_tag || prodImage || 'omnibiz-postgis:18-3.6-h3';

  // Data: the requested snapshot, else the latest completed prod backup. No dump is allowed but
  // loudly so — an empty dev db is only schema-less postgres, useless until something fills it.
  const snap = snapshotId
    ? await one(`SELECT * FROM db_snapshot WHERE id=$1`, [snapshotId])
    : await one(`SELECT * FROM db_snapshot WHERE project_id=$1 AND source='prod' AND status='done'
                  ORDER BY taken_at DESC LIMIT 1`, [projectId]);

  // The compose network + alias this project's spinoffs expect (manifest requires) — the alias is
  // how app containers find their db, and a db without it crash-loops the machine's whole fleet.
  const reqNets = project.manifest?.tiers?.spinoff?.requires?.networks || [];
  const netEntry = reqNets.map((n) => (typeof n === 'string' ? { name: n, aliases: [] } : n))
    .find((n) => (n.aliases || []).length) || null;
  const network = netEntry?.name || null;
  const alias = netEntry?.aliases?.[0] || 'postgres';

  const mkey = m.key.replace(/-/g, '_');
  const name = source?.name ? `${source.name}_${mkey}`
    : prodDb?.name ? `${prodDb.name}_dev_${mkey}`
    : namingFor(project, 'db', `dev-${m.key}`).container;
  const host = m.host_ip || project.dev_host_ip || config.devHostIp;
  const dbUser = project.db_user || config.prodDbUser || 'postgres';
  const dbName = project.db_name || config.prodDbName || 'omnibiz';

  provisioning.add(lockKey);
  logline('machine', `provisioning dev db for ${project.name} on ${m.key} (${image}${snap ? `, restore ${String(snap.dump_path).split(/[\\/]/).pop()}` : ', NO DUMP — empty db'}${network ? `, network ${network} alias ${alias}` : ''})…`);

  (async () => {
    let port = 0;
    if (MODE === 'real') {
      const script = resolve(config.repoRoot, 'scripts', 'provision-xell-db.sh');
      const dumpPath = snap?.dump_path ? String(snap.dump_path).replace(/\\/g, '/') : '';
      const r = spawnSync(resolveBash(), [script, name, m.docker_ctx, image, dumpPath, dbUser, dbName], {
        encoding: 'utf8', timeout: 3600000, windowsHide: true,
        env: { ...process.env, ...(network ? { DB_NETWORK: network, DB_NETWORK_ALIAS: alias } : {}) },
      });
      const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
      let res = null; try { res = JSON.parse(line); } catch { /* no JSON */ }
      if (!res?.ok) throw new Error(res?.reason || (r.stderr || 'provision-xell-db.sh failed').slice(-300));
      port = Number(res.port) || 0;
    }
    const conn = `postgresql://${dbUser}@${host}:${port || 5432}/${dbName}`;
    const row = await one(
      `INSERT INTO container (project_id, role, tier, isolation, name, image_tag, docker_ctx, host,
                              host_port, internal_port, conn_ref, health)
       VALUES ($1,'db','dev','shared',$2,$3,$4,$5,$6,5432,$7,$8)
       ON CONFLICT (project_id, name) DO UPDATE
         SET image_tag=EXCLUDED.image_tag, docker_ctx=EXCLUDED.docker_ctx, host=EXCLUDED.host,
             host_port=EXCLUDED.host_port, conn_ref=EXCLUDED.conn_ref, health=EXCLUDED.health
       RETURNING *`,
      [projectId, name, image, m.docker_ctx, host, port || null, conn, MODE === 'real' ? 'up' : 'down']);
    broadcast('container', row);
    logline('machine', `dev db READY on ${m.key}: ${name} :${port}${snap ? ' (dump restored)' : ' (empty)'} — ${m.key} can now host ${project.name} xells`);
  })().catch((e) => {
    logline('machine', `dev db provision FAILED on ${m.key}: ${e.message}`);
  }).finally(() => provisioning.delete(lockKey));

  return { status: 'provisioning', machine: m.key, name, image,
           restore_from: snap?.dump_path || null, mode: MODE };
}

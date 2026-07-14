// Production deploy lock — one xell holds `prod` at a time (padlock in the UI).
import { q, one } from '../db/pool.js';
import { broadcast } from '../lib/events.js';
import { logline } from '../lib/logbus.js';

async function projectOfXell(xellId) {
  const x = await one(`SELECT project_id FROM xell WHERE id=$1`, [xellId]);
  return x?.project_id;
}

export async function acquireProdLock({ xell_id, zee_id, phase = 'deploying', task, container = 'prod' }) {
  const projectId = await projectOfXell(xell_id);
  if (!projectId) throw new Error('unknown xell');
  // atomic: succeeds only if no holder exists for this container
  const got = await one(
    `INSERT INTO deploy_lock (project_id, container, xell_id, zee_id, phase, task)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (project_id, container) DO NOTHING
     RETURNING *`,
    [projectId, container, xell_id, zee_id || null, phase, task || null]);
  if (got) {
    broadcast('xell', { id: xell_id });
    const x = await one(`SELECT slug FROM xell WHERE id=$1`, [xell_id]);
    logline('lock', `${x?.slug || xell_id} ACQUIRED ${container} deploy lock (phase ${phase})`);
    return { acquired: true, lock: got };
  }
  const held = await one(
    `SELECT dl.*, x.slug FROM deploy_lock dl JOIN xell x ON x.id=dl.xell_id
       WHERE dl.project_id=$1 AND dl.container=$2`, [projectId, container]);
  return { acquired: false, held };
}

export async function releaseProdLock({ xell_id, container = 'prod' }) {
  const lock = await one(`SELECT * FROM deploy_lock WHERE xell_id=$1 AND container=$2`, [xell_id, container]);
  if (!lock) return { released: false, reason: 'not held by this xell' };
  await q(`DELETE FROM deploy_lock WHERE id=$1`, [lock.id]);
  broadcast('xell', { id: xell_id });
  const x = await one(`SELECT slug FROM xell WHERE id=$1`, [xell_id]);
  logline('lock', `${x?.slug || xell_id} RELEASED ${container} deploy lock`);
  return { released: true };
}

export async function prodLockStatus(projectId, container = 'prod') {
  return one(
    `SELECT dl.*, x.slug, x.branch FROM deploy_lock dl JOIN xell x ON x.id=dl.xell_id
       WHERE dl.project_id=$1 AND dl.container=$2`, [projectId, container]);
}

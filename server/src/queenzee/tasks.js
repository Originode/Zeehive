// Task intake + the human "done" gate. Queenzee treats prompt_text as opaque.
import { q, one } from '../db/pool.js';
import { broadcast } from '../lib/events.js';
import { reapXell } from './reaper.js';
import { spawnHeadless } from './intake.js';
import { logline } from '../lib/logbus.js';

async function defaultProjectId() {
  const p = await one(`SELECT id FROM project ORDER BY created_at LIMIT 1`);
  return p?.id;
}

// POST /api/tasks { prompt, mode?, source?, req_db_coupling?, req_source_coupling?, runtime?, project? }
// mode 'headless' → queenzee immediately spawns a zee via the Agent SDK on a ready xell.
// Otherwise the task is queued for a human to pick up via /xell (skill-claim).
export async function createTask({ prompt, mode, source, req_db_coupling, req_source_coupling, runtime, project }) {
  if (!prompt) throw new Error('prompt required');
  const projectId = project || (await defaultProjectId());
  const rt = runtime ? await one(`SELECT id FROM agent_runtime WHERE key=$1`, [runtime]) : null;
  const task = await one(
    `INSERT INTO task (project_id, prompt_text, source, req_db_coupling, req_source_coupling, req_runtime_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,'queued') RETURNING *`,
    [projectId, prompt, source || 'api', req_db_coupling || null, req_source_coupling || null, rt?.id || null]);
  broadcast('task', task);

  if (mode === 'headless') {
    const spawned = await spawnHeadless({ projectId, task: prompt, runtime });
    const linked = await one(
      `UPDATE task SET status='assigned', xell_id=$2, zee_id=$3, assigned_at=now() WHERE id=$1 RETURNING *`,
      [task.id, spawned.xell_id, spawned.zee_id]);
    broadcast('task', linked);
    return { task: linked, spawned };
  }
  return task;
}

// AI-facing: the zee QUERIES whether its job is done / what its state is.
export async function xellStatus({ session_id, xell_id }) {
  let xell;
  if (xell_id) xell = await one(`SELECT * FROM xell WHERE id=$1`, [xell_id]);
  else if (session_id) xell = await one(
    `SELECT x.* FROM xell x JOIN zee z ON z.xell_id=x.id
       WHERE z.claude_session_id=$1 ORDER BY z.created_at DESC LIMIT 1`, [session_id]);
  if (!xell) return null;
  const zee = await one(
    `SELECT id,name,status,cli_active FROM zee WHERE xell_id=$1
       AND status IN ('spawning','online','working','idle') ORDER BY created_at DESC LIMIT 1`, [xell.id]);
  const task = await one(`SELECT id,status,prompt_text,done_by,done_at FROM task WHERE xell_id=$1 ORDER BY created_at DESC LIMIT 1`, [xell.id]);
  const lock = await one(`SELECT container,phase FROM deploy_lock WHERE xell_id=$1`, [xell.id]);
  return {
    xell: { id: xell.id, slug: xell.slug, branch: xell.branch, status: xell.status, head_commit: xell.head_commit },
    zee, task,
    holds_prod_lock: !!lock, prod_lock_phase: lock?.phase || null,
    done: task?.status === 'done',
    awaiting_confirmation: xell.status === 'awaiting-done',
  };
}

// AI-facing: the zee PROPOSES the job is done. Does NOT complete it — flags the xell for a
// HUMAN to confirm via "Mark done" (the human is the only one who decides done).
export async function proposeDone({ session_id, xell_id, task_id, note }) {
  let target = xell_id;
  if (!target && task_id) target = (await one(`SELECT xell_id FROM task WHERE id=$1`, [task_id]))?.xell_id;
  if (!target && session_id) target = (await one(`SELECT xell_id FROM zee WHERE claude_session_id=$1 ORDER BY created_at DESC LIMIT 1`, [session_id]))?.xell_id;
  if (!target) throw new Error('provide session_id, xell_id, or task_id');
  const xell = await one(
    `UPDATE xell SET status='awaiting-done' WHERE id=$1 AND status NOT IN ('retired','tearing-down') RETURNING *`, [target]);
  if (xell) { broadcast('xell', xell); logline('intake', `zee reported job done on ${xell.slug} — awaiting human confirmation`); }
  return {
    ok: !!xell, xell_id: target, status: 'awaiting-done',
    message: 'Flagged for human confirmation — a human confirms completion via "Mark done" in the web app. You are not torn down until then.',
    note: note || null,
  };
}

// POST /api/tasks/:id/done  → the ONLY signal that a xell is finished (human-decided)
export async function markTaskDone(taskId, doneBy, { force = false } = {}) {
  const task = await one(`SELECT * FROM task WHERE id = $1`, [taskId]);
  if (!task) throw new Error('task not found');

  // Check the reap BEFORE flipping the task to done: an ACTIVE xell is refused unless forced, and
  // marking the task done while its zee keeps working would leave the two lying about each other.
  if (task.xell_id) {
    const reap = await reapXell(task.xell_id, 'task-done', { force });
    if (reap?.ok === false) return { task: null, reap, blocked: true };
    const done = await one(
      `UPDATE task SET status='done', done_at=now(), done_by=$2 WHERE id=$1 RETURNING *`,
      [taskId, doneBy]);
    broadcast('task', done);
    return { task: done, reap };
  }

  const done = await one(
    `UPDATE task SET status='done', done_at=now(), done_by=$2 WHERE id=$1 RETURNING *`,
    [taskId, doneBy]);
  broadcast('task', done);
  return { task: done, reap: null };
}

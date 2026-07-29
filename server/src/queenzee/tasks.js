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

// Which xell a done proposal/retraction is about, from whichever handle the caller has.
async function resolveDoneTarget({ session_id, xell_id, task_id }) {
  let target = xell_id;
  if (!target && task_id) target = (await one(`SELECT xell_id FROM task WHERE id=$1`, [task_id]))?.xell_id;
  if (!target && session_id) target = (await one(`SELECT xell_id FROM zee WHERE claude_session_id=$1 ORDER BY created_at DESC LIMIT 1`, [session_id]))?.xell_id;
  if (!target) throw new Error('provide session_id, xell_id, or task_id');
  return target;
}

// AI-facing: the zee PROPOSES the job is done. Does NOT complete it — flags the xell for a
// HUMAN to confirm via "Mark done" (the human is the only one who decides done).
export async function proposeDone({ session_id, xell_id, task_id, note }) {
  const target = await resolveDoneTarget({ session_id, xell_id, task_id });
  const xell = await one(
    `UPDATE xell SET status='awaiting-done' WHERE id=$1 AND status NOT IN ('retired','tearing-down') RETURNING *`, [target]);
  if (xell) { broadcast('xell', xell); logline('intake', `zee reported job done on ${xell.slug} — awaiting human confirmation`); }
  return {
    ok: !!xell, xell_id: target, status: 'awaiting-done',
    message: 'Flagged for human confirmation — a human confirms completion via "Mark done" in the web app. You are not torn down until then.',
    note: note || null,
  };
}

// AI-facing: the zee WITHDRAWS its own done proposal (`zee done --clear`), returning the xell to
// the working lifecycle. The symmetric partner of proposeDone, and the missing half of a verb that
// could previously only be spoken once: a zee that proposed done and was then handed more work had
// no way to take it back, and until the precedence fix in lib/hive-status.js the stale proposal
// masked every later signal it raised. The only workaround anyone found was rewriting the done
// card's summary, which is a workaround, not a channel.
//
// It can only ever undo a PROPOSAL. Once a human has confirmed (status 'tearing-down', or the xell
// is retired), the decision is theirs and the reap is under way — retracting is refused, loudly and
// specifically, rather than racing the queenzee's own teardown.
export async function retractDone({ session_id, xell_id, task_id } = {}) {
  const target = await resolveDoneTarget({ session_id, xell_id, task_id });
  // 'claimed' is the neutral occupied state intake itself sets when a zee is bound; hiveStatus
  // derives working/idle from the live zee row on top of it, so this restores the xell without
  // inventing an activity it cannot vouch for.
  const xell = await one(
    `UPDATE xell SET status='claimed' WHERE id=$1 AND status='awaiting-done' RETURNING *`, [target]);
  if (xell) {
    broadcast('xell', xell);
    logline('intake', `zee RETRACTED its done proposal on ${xell.slug} — back to work (no longer awaiting confirmation)`);
    return {
      ok: true, xell_id: target, status: xell.status, retracted: true,
      message: 'Done proposal WITHDRAWN — the xell is back in the working lifecycle and no longer '
        + 'asks a human to confirm. Any land/ship/tend signal you raise is visible again.',
    };
  }
  // Nothing flipped — say precisely why, because "ok:false" alone is the kind of answer that sent a
  // zee looking for a workaround in the first place.
  const now = await one(`SELECT status, slug FROM xell WHERE id=$1`, [target]);
  if (!now) return { ok: false, xell_id: target, error: 'no such xell' };
  if (now.status === 'tearing-down' || now.status === 'retired') {
    return { ok: false, xell_id: target, status: now.status, retracted: false,
      error: `a human already CONFIRMED done for ${now.slug} — it is being torn down, and that is `
        + 'not a zee\'s to undo. Your commits are collected as part of the teardown.' };
  }
  return { ok: false, xell_id: target, status: now.status, retracted: false,
    error: `${now.slug} is not awaiting done (status: ${now.status}) — there is no proposal to withdraw.` };
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

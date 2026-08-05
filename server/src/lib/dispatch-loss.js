// A DISPATCH DESTROYED BEFORE ITS ZEE EVER RAN IS NEWS — tell whoever dispatched it.
//
// THE SECOND HALF OF TKT-88-D6B4. Five dispatched tasks were torn down in three minutes on
// 2026-08-05 and the whole record of it was three log lines per xell, on a ring buffer nobody was
// watching. The DISPATCHER — a human at the console, and a manager zee with a crew — was never
// told anything: the work item still said 'assigned', the hexagon simply vanished, and a human
// retried blind at least four times, each retry burning a provision + warm cycle on the same race.
//
// The race itself is now impossible (lib/xell-claim.js). This is the alarm that says so when it
// happens anyway, by any route we have not thought of: a teardown the QUEENZEE decided, of a xell
// that had been spoken for, in which no zee ever ran, reaches the dispatcher where they are —
// a manager in its inbox, everyone else as a ticket in the console.
//
// WHAT IT DELIBERATELY DOES NOT DO. It never fires on a HUMAN's teardown ("Mark done", a console
// cleanup, a danger purge): that is somebody's decision, made in front of the console that shows
// it, and an alarm for it is noise. It never fires for a xell that was still POOL STOCK (a ready
// xell being trimmed or reconciled away is the pool doing its job — nobody was waiting on it). And
// it never fires when a zee actually RAN: a zee that started and then died is the revive loop's
// business (queenzee/revive.js), which already classifies and reports it.
import { q, one } from '../db/pool.js';
import { logline } from './logbus.js';

// The reap reasons the QUEENZEE decides by itself. Everything else — task-done, done-suggestion,
// human-cleanup, danger-purge — is a human's call and needs no alarm.
export const QUEENZEE_DECIDED_REAPS = ['stale:', 'pool-surplus', 'stranded-teardown'];

export const isQueenzeeDecided = (reason) =>
  QUEENZEE_DECIDED_REAPS.some((r) => String(reason || '').startsWith(r));

// DID A ZEE EVER RUN IN THERE? A row in 'spawning' with no session id is a cage that was still
// being built — nothing ran, nothing was said, nothing can be resumed. Anything else (a session
// id, or any later status) means an agent existed and its ending is somebody else's story.
export const everRan = (zees = []) =>
  zees.some((z) => !!z.claude_session_id || (z.status && z.status !== 'spawning'));

// PURE — the whole rule, so it can be read and table-tested without a database or a teardown.
//   reason        the reap reason (see above)
//   status        the xell's status at the moment of the reap
//   isPooled      is it still pool stock?
//   zees          every zee row the xell ever had (status + claude_session_id)
//   hasTask       does a task row name the job it was dispatched to do?
//   managerXellId the manager that dispatched it, if any
export function decideDispatchLoss({ reason, status, isPooled, zees = [], hasTask = false,
                                     managerXellId = null } = {}) {
  if (!isQueenzeeDecided(reason)) {
    return { lost: false, to: null, why: `${reason || 'this teardown'} is a human's decision, not a loss` };
  }
  if (everRan(zees)) {
    return { lost: false, to: null, why: 'a zee ran in it — how that turn ended is the reviver\'s story, not this one' };
  }
  // SPOKEN FOR: taken out of the pool for a job (the claim sets is_pooled=false as it takes it),
  // or already carrying the task row a dispatch writes. A 'ready', pooled xell is stock.
  const spokenFor = isPooled === false && status !== 'ready';
  if (!spokenFor && !hasTask) {
    return { lost: false, to: null, why: 'it was still pool stock — nobody was waiting on it' };
  }
  return {
    lost: true,
    to: managerXellId ? 'manager' : 'human',
    why: `it was dispatched (${status}${hasTask ? ', task recorded' : ''}) and torn down as `
       + `"${reason}" before any zee ran in it`,
  };
}

// Gather the evidence a verdict needs — BEFORE the teardown stamps the zee rows and deletes the
// containers, or the answer to "did a zee ever run?" is rewritten by the thing we are reporting on.
export async function collectDispatchLoss(xell, reason) {
  if (!xell?.id) return { lost: false };
  const zees = await q(
    `SELECT status, claude_session_id FROM zee WHERE xell_id=$1`, [xell.id]).catch(() => []);
  const task = await one(
    `SELECT prompt_text, source FROM task WHERE xell_id=$1 ORDER BY assigned_at DESC NULLS LAST LIMIT 1`,
    [xell.id]).catch(() => null);
  const verdict = decideDispatchLoss({
    reason, status: xell.status, isPooled: xell.is_pooled, zees,
    hasTask: !!task, managerXellId: xell.manager_xell_id,
  });
  return { ...verdict, xell, reason, task };
}

// The first line of the task text — what the job was called, for a human or a manager reading a
// one-line alert. Same shape intake.js names a xell from.
const taskTitle = (text) => {
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^#+\s*/, '').trim();
    if (line) return line.slice(0, 120);
  }
  return null;
};

export function dispatchLossBody(loss) {
  const { xell, reason, task } = loss;
  const title = taskTitle(task?.prompt_text);
  return [
    `The xell **${xell.slug}** was decommissioned by the queenzee (\`${reason}\`) before any zee ran in it.`,
    title ? `\nIt had been dispatched to: **${title}**` : '\nIt had been dispatched, but no task text was recorded.',
    '\nNothing of that dispatch survives — the worktree and branch went with the xell, and no agent',
    'ever started, so there is no session to resume and nothing to collect.',
    '\n**Do not retry blind.** Re-dispatch the task; if this repeats, the loss is in the teardown',
    'path and not in the task (TKT-88-D6B4 — a pool sweep taking a xell a dispatch had just picked',
    'destroyed five dispatches in three minutes, and the only record was three log lines).',
  ].join('\n');
}

// DELIVER IT. A manager gets it in its inbox (and typed into its live session if it has one);
// everyone else gets a ticket, because a console with no card is exactly the silence this fixes.
// Best-effort and never throws: a teardown must not fail because an alarm could not be delivered —
// but a failed delivery is logged, because a swallowed alarm is the bug itself.
export async function reportDispatchLoss(loss) {
  if (!loss?.lost) return { reported: false };
  const { xell, reason } = loss;
  const body = dispatchLossBody(loss);
  try {
    if (loss.to === 'manager') {
      const manager = await one(`SELECT id, slug, project_id FROM xell WHERE id=$1`, [xell.manager_xell_id]);
      if (manager) {
        // Imported here, not at module load: lib/managers.js reaches into queenzee/nudge.js, and
        // this module is imported by the reaper — the same dynamic-import shape the reaper already
        // uses for lib/prod-readonly.js.
        const { postMessage } = await import('./managers.js');
        await postMessage({ from: null, to: manager, kind: 'message', by: 'queenzee',
                            body: `⚠ YOUR DISPATCH WAS DESTROYED BEFORE IT RAN\n\n${body}` });
        logline('reaper', `${xell.slug}: its dispatch never ran — told its manager ${manager.slug}`);
        return { reported: true, to: 'manager', manager: manager.slug };
      }
      logline('reaper', `${xell.slug}: its dispatch never ran, and its manager row is gone — raising a ticket instead`);
    }
    const { createTicket } = await import('./tickets.js');
    const ticket = await createTicket({
      project_id: xell.project_id,
      title: `Dispatch destroyed before its zee ran: ${xell.slug} (${reason})`,
      body, kind: 'incident', priority: 2, reporter: 'queenzee',
    });
    logline('reaper', `${xell.slug}: its dispatch never ran — raised ${ticket.code} for a human`);
    return { reported: true, to: 'human', ticket: ticket.code };
  } catch (e) {
    logline('reaper', `${xell.slug}: its dispatch never ran and the alarm could NOT be delivered (${e.message}) `
      + '— whoever dispatched it has not been told');
    return { reported: false, error: e.message };
  }
}

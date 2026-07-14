// Intake router — binds a zee to a ready xell. Two modes, same DB + observability:
//   skill-claim   : a human's Claude session (via /xell) claims the freshest ready xell
//   headless-spawn: queenzee spawns a headless zee via the Agent SDK (see spawnHeadless)
import { q, one } from '../db/pool.js';
import { runtimeById, runtimeByKey, viewerUrlFor } from '../lib/runtimes.js';
import { broadcast } from '../lib/events.js';
import { remoteStart, remoteStartArgs } from '../lib/claude-cli.js';
import { provisionXell } from '../lib/provision.js';
import { landOne, isAtSourceTip } from './landing.js';
import { logline } from '../lib/logbus.js';

// PROVISION_MODE=real actually creates the git worktree (and app tier unless
// PROVISION_APP_TIER=false); 'simulate' models it in the DB only. Same knob as the pool.
const PROVISION_MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

function norm(p) { return String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase(); }

async function readyXells(projectId) {
  return q(
    `SELECT * FROM xell WHERE project_id = $1 AND status = 'ready' ORDER BY ready_at DESC NULLS LAST, created_at DESC`,
    [projectId]);
}

// The ready xell the caller is physically STANDING IN (cwd === its worktree), or null.
// Exact match only — no "freshest ready" fallback: binding a session that isn't in the
// worktree would let it edit the xource (main repo), which is the isolation hole we forbid.
function readyXellForCwd(ready, cwd) {
  if (!cwd) return null;
  const target = norm(cwd);
  return ready.find((x) => norm(x.worktree_path) === target) || null;
}

async function defaultProjectId() {
  const p = await one(`SELECT id FROM project ORDER BY created_at LIMIT 1`);
  return p?.id;
}

// Raised when the caller isn't standing in a xell worktree. The route turns it into a
// 409 the skill shows verbatim — NO claim, NO 'claimed' status, so the zee does not work.
class NeedsWorktree extends Error {
  constructor(detail) { super('not-in-worktree'); this.code = 'NEEDS_WORKTREE'; this.detail = detail; }
}

// POST /api/xell/claim  { session_id, cwd, task, runtime?, project? }
// The zee gets 'claimed' — and may begin work — ONLY when its session is physically inside a
// ready xell's worktree. Anything else refuses: a session in the xource (main repo) or a
// foreign worktree would edit the wrong tree, defeating isolation.
export async function claimXell({ session_id, cwd, task, runtime, project }) {
  const projectId = project || (await defaultProjectId());
  if (!projectId) throw new Error('no project configured');

  // idempotent: if this session already owns a live zee, return its (already-claimed) binding
  const existing = await one(
    `SELECT z.*, x.worktree_path, x.branch FROM zee z JOIN xell x ON x.id = z.xell_id
       WHERE z.claude_session_id = $1 AND z.status IN ('spawning','online','working','idle')`,
    [session_id]);
  if (existing) return bindingFor(existing.xell_id, existing);

  const ready = await readyXells(projectId);
  const xell = readyXellForCwd(ready, cwd); // the worktree the caller is STANDING IN, or null

  if (!xell) {
    // Not in a worktree → cannot claim. Make sure a ready worktree EXISTS to open (provision
    // on demand if the pool is dry), then tell the caller to open it and re-run /xell there.
    let open = ready[0];
    if (!open) {
      logline('intake', `no ready worktree — provisioning one to open on demand (${PROVISION_MODE})…`);
      const p = await provisionXell({ projectId, mode: PROVISION_MODE });
      open = await one(`SELECT * FROM xell WHERE id=$1`, [p.id]);
    }
    // resolve the runtime the queenzee would spawn (the pool default / UI runtime toggle)
    const pcfg = await one(`SELECT default_runtime_id FROM pool_config WHERE project_id=$1`, [projectId]);
    const drt = await runtimeById(pcfg?.default_runtime_id);
    logline('intake', `claim refused (not in worktree) — offering dispatch to ${open.slug} (${drt?.label || 'default'})`);
    throw new NeedsWorktree({
      needs_worktree: true,
      can_dispatch: true,
      // the recommended path: queenzee spawns a zee INTO this worktree (human confirms first)
      dispatch: {
        xell_id: open.id, slug: open.slug, worktree_path: open.worktree_path,
        runtime_key: drt?.key || null, runtime_label: drt?.label || 'default runtime',
      },
      task: task || null,
      your_cwd: cwd || null,
      open_worktree: open.worktree_path,
      open_slug: open.slug,
      also_ready: ready.filter((x) => x.id !== open.id).map((x) => ({ slug: x.slug, worktree_path: x.worktree_path })),
      message:
        'Your session is in the main repo (xource), not a xell worktree, so it was NOT claimed. ' +
        'Recommended: DISPATCH this task to the ready xell below — the queenzee spawns a zee inside its ' +
        'worktree to do the work. Confirm with the user first. (Or open the worktree yourself and /xell there.)',
    });
  }

  const pool = await one(`SELECT default_runtime_id FROM pool_config WHERE project_id = $1`, [projectId]);
  const rt = runtime ? await runtimeByKey(runtime) : await runtimeById(pool?.default_runtime_id);
  const viewer = viewerUrlFor(rt, session_id, null);

  // Enforce "ready ⟺ diff(0,0)" at the point of use: fast-forward the worktree onto the source
  // tip so the zee starts from current source, even if it drifted since the last pool tick.
  if (PROVISION_MODE === 'real') {
    const src = (await one(`SELECT main_branch FROM project WHERE id=$1`, [projectId]))?.main_branch || 'main';
    const res = landOne(xell.worktree_path, src);
    if (isAtSourceTip(res) && res.head && res.head !== xell.head_commit) {
      await one(`UPDATE xell SET head_commit=$2, last_synced_commit=$2 WHERE id=$1`, [xell.id, res.head]);
      xell.head_commit = res.head;
    } else if (res && !isAtSourceTip(res)) {
      logline('intake', `warn: ${xell.slug} not at source tip at claim (${res.reason}, behind ${res.behind}) — proceeding`);
    }
  }

  // cwd is guaranteed === worktree_path here, so the stored cwd is honest.
  const zee = await one(
    `INSERT INTO zee (xell_id, claude_session_id, attach_mode, runtime_id, viewer_url, viewer_kind,
                      status, cwd, session_name, attached_at)
     VALUES ($1,$2,'skill-claim',$3,$4,$5,'online',$6,$7, now()) RETURNING *`,
    [xell.id, session_id, rt?.id || null, viewer.url, viewer.kind, xell.worktree_path, session_id]);

  const updatedXell = await one(`UPDATE xell SET status='claimed', is_pooled=false WHERE id=$1 RETURNING *`, [xell.id]);
  broadcast('zee', zee);
  broadcast('xell', updatedXell);
  logline('intake', `xell ${xell.slug} claimed (skill) by session ${String(session_id).slice(0, 8)} — in-worktree ✓`);

  // link the opaque task (if any) to this xell/zee — queenzee never inspects prompt_text
  if (task) {
    await q(
      `INSERT INTO task (project_id, prompt_text, source, status, xell_id, zee_id, assigned_at)
       VALUES ($1,$2,'skill','assigned',$3,$4, now())`,
      [projectId, task, xell.id, zee.id]);
  }
  return bindingFor(xell.id, zee, task);
}

// POST /api/xell/dispatch — the confirmed auto-dispatch path for /xell run OUTSIDE a worktree.
// The queenzee spawns a zee INTO a ready xell's worktree (headless locally, or `claude remote`
// per the runtime) to run the task. Human confirms in their session before this is called.
export async function dispatchXell({ xell_id, task, runtime, project }) {
  if (!task) throw new Error('task (prompt) required to dispatch');
  const projectId = project || (await defaultProjectId());
  const spawned = await spawnHeadless({ projectId, xellId: xell_id || null, task, runtime });
  const xell = await one(`SELECT slug, worktree_path FROM xell WHERE id=$1`, [spawned.xell_id]);
  logline('intake', `dispatched a zee into ${xell?.slug} to run the task (${runtime || 'default runtime'})`);
  return { status: 'dispatched', slug: xell?.slug, worktree: xell?.worktree_path, ...spawned };
}

// The JSON the /xell skill inlines so the Claude session becomes this xell's zee.
async function bindingFor(xellId, zee, task) {
  const xell = await one(`SELECT x.*, xo.ref AS xource_ref FROM xell x JOIN xource xo ON xo.id=x.xource_id WHERE x.id=$1`, [xellId]);
  const stack = await q(
    `SELECT c.role, c.name, c.url, c.tier, c.conn_ref, uc.relation
       FROM xell_uses_container uc JOIN container c ON c.id = uc.container_id
      WHERE uc.xell_id = $1 ORDER BY c.role`, [xellId]);
  return {
    status: 'claimed', // the gate: the zee may begin work ONLY when this is 'claimed'
    xell: {
      id: xell.id, slug: xell.slug, branch: xell.branch, worktree_path: xell.worktree_path,
      source: xell.xource_ref, source_coupling: xell.source_coupling, db_coupling: xell.db_coupling,
    },
    zee: { id: zee.id, name: zee.name, viewer_url: zee.viewer_url },
    containers: stack,
    task: task || null,
    rules: [
      'Work ONLY inside worktree_path. Never touch the xource (read-only).',
      'Use ONLY your assigned containers/URLs above.',
      'Land locally: commit on your branch, then `git push . HEAD:main`. origin is off-limits.',
    ],
  };
}

// headless-spawn — queenzee spawns a zee itself via the Agent SDK, no human click.
// Binds to a ready xell (cwd = its worktree), injects the opaque task, and drives the
// stream in the background, updating the zee row as the harness reports. The SAME hooks +
// poller observe it, so status/telemetry is identical to a skill-claimed zee.
export async function spawnHeadless({ projectId, xellId, task, runtime, model = 'sonnet' }) {
  const pid = projectId || (await defaultProjectId());
  const xell = xellId
    ? await one(`SELECT * FROM xell WHERE id=$1`, [xellId])
    : await readyXellForCwd(pid, null);
  if (!xell) throw new Error('no ready xell available for headless spawn');
  if (!task) throw new Error('task (prompt) required for headless spawn');

  const cfgRow = await one(`SELECT default_runtime_id FROM pool_config WHERE project_id=$1`, [pid]);
  const rt = runtime ? await runtimeByKey(runtime) : await runtimeById(cfgRow?.default_runtime_id);

  // REMOTE runtime → run the literal `claude remote` CLI, not the local SDK.
  if (rt?.key === 'claude-code-remote') return spawnRemote({ pid, xell, task, rt, model });

  let sdk;
  try { sdk = await import('@anthropic-ai/claude-agent-sdk'); }
  catch { throw new Error('@anthropic-ai/claude-agent-sdk not installed'); }

  const zee = await one(
    `INSERT INTO zee (xell_id, attach_mode, runtime_id, viewer_kind, status, kind, entrypoint,
                      model, permission_mode, cwd)
     VALUES ($1,'headless-spawn',$2,$3,'spawning','headless','headless-sdk',$4,'bypassPermissions',$5)
     RETURNING *`,
    [xell.id, rt?.id || null, rt?.viewer_kind || 'none', model, xell.worktree_path]);
  await one(`UPDATE xell SET status='claimed', is_pooled=false WHERE id=$1`, [xell.id]);
  broadcast('zee', zee);

  // drive the SDK stream in the background — do NOT block the caller
  (async () => {
    try {
      const it = sdk.query({
        prompt: task,
        options: {
          cwd: xell.worktree_path,
          model,
          permissionMode: 'bypassPermissions',
          allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
        },
      });
      for await (const msg of it) {
        if (msg?.type === 'system' && (msg.subtype === 'init')) {
          const sid = msg.session_id || msg.data?.session_id;
          if (sid) {
            const { url } = viewerUrlFor(rt, sid, null);
            await q(`UPDATE zee SET claude_session_id=$2, session_name=$2, viewer_url=$3, status='working', attached_at=now() WHERE id=$1`,
              [zee.id, sid, url]);
          }
        }
        if (msg?.type === 'result') {
          const cost = msg.total_cost_usd ?? msg.usage?.total_cost_usd ?? 0;
          await q(`UPDATE zee SET cost_usd=$2, status='idle', last_stop_reason='end_turn' WHERE id=$1`, [zee.id, cost]);
        }
      }
    } catch (err) {
      await q(`UPDATE zee SET status='errored', last_stop_reason=$2 WHERE id=$1`, [zee.id, String(err.message).slice(0, 200)]);
    }
  })();

  return { zee_id: zee.id, xell_id: xell.id, worktree: xell.worktree_path };
}

// REMOTE spawn — runs the literal `claude remote` command (Remote Control). Records the
// real CLI result; if claude.ai isn't logged in, the zee is marked errored with the CLI's
// own message (no fabricated success).
async function spawnRemote({ pid, xell, task, rt, model }) {
  const name = `xell-${xell.slug}`;
  const zee = await one(
    `INSERT INTO zee (xell_id, attach_mode, runtime_id, viewer_kind, status, kind, entrypoint,
                      model, permission_mode, cwd, remote_ref)
     VALUES ($1,'headless-spawn',$2,'web','spawning','remote','claude-remote',$3,'bypassPermissions',$4,$5)
     RETURNING *`,
    [xell.id, rt.id, model, xell.worktree_path, name]);
  await one(`UPDATE xell SET status='claimed', is_pooled=false WHERE id=$1`, [xell.id]);
  broadcast('zee', zee);

  // run `claude remote start …` in the background — never block the request/event loop
  (async () => {
    const res = await remoteStart({ name, prompt: task, cwd: xell.worktree_path, model });
    if (res.ok) {
      const viewer = viewerUrlFor(rt, res.sessionId, res.url);
      const updated = await one(
        `UPDATE zee SET claude_session_id=$2, session_name=$2, viewer_url=$3, viewer_kind=$4,
                        status='working', attached_at=now() WHERE id=$1 RETURNING *`,
        [zee.id, res.sessionId || name, viewer.url, viewer.kind]);
      broadcast('zee', updated);
    } else {
      const reason = res.loggedOut
        ? 'claude remote: not logged in to claude.ai (Remote Control requires a subscription)'
        : `claude remote start failed (exit ${res.status}): ${(res.stderr || '').slice(0, 160) || 'no output / timed out'}`;
      const updated = await one(`UPDATE zee SET status='errored', last_stop_reason=$2 WHERE id=$1 RETURNING *`, [zee.id, reason]);
      broadcast('zee', updated);
    }
  })();

  return { zee_id: zee.id, xell_id: xell.id, remote: { ran: `claude ${remoteStartArgs({ name, model }).join(' ')}`, started: true } };
}

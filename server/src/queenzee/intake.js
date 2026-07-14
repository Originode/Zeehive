// Intake router — binds a zee to a ready xell. Two modes, same DB + observability:
//   skill-claim   : a human's Claude session (via /xell) claims the freshest ready xell
//   headless-spawn: queenzee spawns a headless zee via the Agent SDK (see spawnHeadless)
import { q, one } from '../db/pool.js';
import { runtimeById, runtimeByKey, viewerUrlFor } from '../lib/runtimes.js';
import { broadcast } from '../lib/events.js';
import { remoteStart, remoteStartArgs } from '../lib/claude-cli.js';
import { logline } from '../lib/logbus.js';

function norm(p) { return String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase(); }

// Resolve which pooled xell the caller is standing in, by cwd (matches the worktree path).
async function readyXellForCwd(projectId, cwd) {
  const ready = await q(
    `SELECT * FROM xell WHERE project_id = $1 AND status = 'ready' ORDER BY ready_at DESC NULLS LAST, created_at DESC`,
    [projectId]);
  if (cwd) {
    const target = norm(cwd);
    const match = ready.find((x) => norm(x.worktree_path) === target);
    if (match) return match;
  }
  return ready[0] || null; // else the freshest ready xell
}

async function defaultProjectId() {
  const p = await one(`SELECT id FROM project ORDER BY created_at LIMIT 1`);
  return p?.id;
}

// POST /api/xell/claim  { session_id, cwd, task, runtime?, project? }
export async function claimXell({ session_id, cwd, task, runtime, project }) {
  const projectId = project || (await defaultProjectId());
  if (!projectId) throw new Error('no project configured');

  // idempotent: if this session already owns a live zee, return its binding
  const existing = await one(
    `SELECT z.*, x.worktree_path, x.branch FROM zee z JOIN xell x ON x.id = z.xell_id
       WHERE z.claude_session_id = $1 AND z.status IN ('spawning','online','working','idle')`,
    [session_id]);
  if (existing) return bindingFor(existing.xell_id, existing);

  const xell = await readyXellForCwd(projectId, cwd);
  if (!xell) throw new Error('no ready xell available — pool is empty, try again shortly');

  const pool = await one(`SELECT default_runtime_id FROM pool_config WHERE project_id = $1`, [projectId]);
  const rt = runtime ? await runtimeByKey(runtime) : await runtimeById(pool?.default_runtime_id);
  const viewer = viewerUrlFor(rt, session_id, null);

  const zee = await one(
    `INSERT INTO zee (xell_id, claude_session_id, attach_mode, runtime_id, viewer_url, viewer_kind,
                      status, cwd, session_name, attached_at)
     VALUES ($1,$2,'skill-claim',$3,$4,$5,'online',$6,$7, now()) RETURNING *`,
    [xell.id, session_id, rt?.id || null, viewer.url, viewer.kind, cwd || xell.worktree_path, session_id]);

  const updatedXell = await one(`UPDATE xell SET status='claimed', is_pooled=false WHERE id=$1 RETURNING *`, [xell.id]);
  broadcast('zee', zee);
  broadcast('xell', updatedXell);
  logline('intake', `xell ${xell.slug} claimed (skill) by session ${String(session_id).slice(0, 8)}`);

  // link the opaque task (if any) to this xell/zee — queenzee never inspects prompt_text
  if (task) {
    await q(
      `INSERT INTO task (project_id, prompt_text, source, status, xell_id, zee_id, assigned_at)
       VALUES ($1,$2,'skill','assigned',$3,$4, now())`,
      [projectId, task, xell.id, zee.id]);
  }
  return bindingFor(xell.id, zee, task);
}

// The JSON the /xell skill inlines so the Claude session becomes this xell's zee.
async function bindingFor(xellId, zee, task) {
  const xell = await one(`SELECT x.*, xo.ref AS xource_ref FROM xell x JOIN xource xo ON xo.id=x.xource_id WHERE x.id=$1`, [xellId]);
  const stack = await q(
    `SELECT c.role, c.name, c.url, c.tier, c.conn_ref, uc.relation
       FROM xell_uses_container uc JOIN container c ON c.id = uc.container_id
      WHERE uc.xell_id = $1 ORDER BY c.role`, [xellId]);
  return {
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

// Intake router — binds a zee to a ready xell. Two modes, same DB + observability:
//   skill-claim   : a human's Claude session (via /xell) claims the freshest ready xell
//   headless-spawn: queenzee spawns a headless zee via the Agent SDK (see spawnHeadless)
import { resolve } from 'node:path';
import { q, one } from '../db/pool.js';
import { config } from '../config.js';
import { runtimeById, runtimeByKey, viewerUrlFor } from '../lib/runtimes.js';
import { broadcast } from '../lib/events.js';
import { remoteStart, remoteStartArgs } from '../lib/claude-cli.js';
import { provisionXell } from '../lib/provision.js';
import { sessionTitle } from '../lib/session-title.js';
import { renameXellForTask } from '../lib/rename-xell.js';
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
export async function dispatchXell({ xell_id, task, runtime, project, mode, session_id, title, headless = true, model }) {
  if (!task) throw new Error('task (prompt) required to dispatch');
  const m = resolveMode(mode); // validates 1–5 up front, before anything is spawned
  const projectId = project || (await defaultProjectId());
  // The spawned zee never titles itself, so it takes the DISPATCHING session's title — but
  // prefixed. Plain inheritance made the two identical in the sidebar: the human clicks the title
  // expecting the zee and lands on the dispatcher, a dead artifact sitting in the read-only
  // xource. "xell : X" is the one doing the work; the bare "X" is the launcher.
  // This exact string is also stored on zee.title, so the sidebar and the XEEHIVE dashboard match.
  const from = title || (session_id ? sessionTitle(session_id) : null);
  const inherited = from ? `xell : ${from}` : null;

  // Now that we know the job, give the worktree a human-trackable name — BEFORE spawning, so the
  // zee's cwd is the final path and Claude Code's sidebar (which names a worktree by its folder)
  // shows something findable instead of "calm-summit-403da6". Best-effort: if it can't rename
  // (already built, name taken), the xell just keeps its pooled slug and the dispatch proceeds.
  if (xell_id && from) await renameXellForTask(xell_id, from);

  const spawned = await spawnHeadless({
    projectId, xellId: xell_id || null, task, runtime, mode, title: inherited,
    headless: headless !== false, ...(model ? { model } : {}),
  });
  const xell = await one(`SELECT slug, worktree_path FROM xell WHERE id=$1`, [spawned.xell_id]);

  // Report only what actually happened — spawnHeadless/spawnRemote await the real start.
  if (spawned.ok === false) {
    logline('intake', `dispatch FAILED into ${xell?.slug}: ${spawned.error}`);
    const err = new Error(spawned.error || 'spawn failed');
    err.detail = { status: 'dispatch-failed', slug: xell?.slug, zee_id: spawned.zee_id, error: spawned.error };
    throw err;
  }
  logline('intake', `dispatched a zee into ${xell?.slug} — confirmed working (${runtime || 'default runtime'}, mode ${m.key})`);
  return { status: 'dispatched', slug: xell?.slug, worktree: xell?.worktree_path,
           mode: m.key, mode_label: m.label, ...spawned };
}

// The JSON the /xell skill inlines so the Claude session becomes this xell's zee.
async function bindingFor(xellId, zee, task) {
  const xell = await one(`SELECT x.*, xo.ref AS xource_ref FROM xell x JOIN xource xo ON xo.id=x.xource_id WHERE x.id=$1`, [xellId]);
  const stack = await q(
    `SELECT c.role, c.name, c.url, c.tier, c.conn_ref, uc.relation
       FROM xell_uses_container uc JOIN container c ON c.id = uc.container_id
      WHERE uc.xell_id = $1 ORDER BY c.role`, [xellId]);
  // How this zee builds its own app tier — ALWAYS via the queenzee, never by hand. Running
  // docker/compose/spin-env.sh directly leaves the orchestrator blind (no built-commit, no hot
  // flag, no health/spinner) and can mangle a container mid-operation.
  const bs = `node "${resolve(config.repoRoot, 'scripts', 'xell-build.mjs')}"`;
  const build = {
    how: 'Build ONLY through the queenzee with these commands. Do NOT run docker, docker compose, '
       + 'scripts/spin-env.sh, or ad-hoc build scripts yourself.',
    all: `${bs} ${xell.id} all`,
    server: `${bs} ${xell.id} server`,
    webapp: `${bs} ${xell.id} webapp`,
    hot_suffix: '--hot',
    semantics: {
      build: 'rebuilds the image from THIS worktree\'s code and recreates the container — use this to see your changes run',
      hot: 'append --hot to bounce the container from the existing image (fast, but does NOT pick up code changes — there is no source mount)',
    },
    note: 'Builds run in the background and are non-blocking; watch container health on the dashboard (building → up = ok, down = failed).',
  };

  return {
    status: 'claimed', // the gate: the zee may begin work ONLY when this is 'claimed'
    xell: {
      id: xell.id, slug: xell.slug, branch: xell.branch, worktree_path: xell.worktree_path,
      source: xell.xource_ref, source_coupling: xell.source_coupling, db_coupling: xell.db_coupling,
    },
    zee: { id: zee.id, name: zee.name, viewer_url: zee.viewer_url },
    containers: stack,
    build,
    task: task || null,
    rules: [
      'Work ONLY inside worktree_path. Never touch the xource (read-only).',
      'Use ONLY your assigned containers/URLs above.',
      'To run/see your changes, BUILD via the `build` commands above — never run docker, docker compose, or spin-env.sh yourself.',
      'Land locally: commit on your branch, then `git push . HEAD:main`. origin is off-limits.',
    ],
  };
}

// Dispatch autonomy, 1..5 — how much rope the spawned zee gets. Escalating capability:
// tools widen and prompting falls away, ending at 5 = no permission prompts at all.
//
// NOTE for headless zees: nobody is attached to answer a permission prompt, so modes that can
// still ask (2–4, on a tool outside their allow-list) will STALL rather than ask. 5 is the one
// that always runs unattended; 1 is the safe "look, don't touch" recon.
export const DISPATCH_MODES = {
  1: { key: 'plan',   permissionMode: 'plan',              tools: ['Read', 'Glob', 'Grep'],                                  label: 'read-only recon — investigates, changes nothing' },
  2: { key: 'edits',  permissionMode: 'acceptEdits',       tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write'],                 label: 'edit files, no shell' },
  3: { key: 'shell',  permissionMode: 'acceptEdits',       tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],         label: 'edit files + run shell' },
  4: { key: 'auto',   permissionMode: 'acceptEdits',       tools: null,                                                      label: 'all tools, auto-accept edits' },
  5: { key: 'bypass', permissionMode: 'bypassPermissions', tools: null,                                                      label: 'bypass all permission prompts (fully unattended)' },
};
export function resolveMode(mode) {
  if (mode === undefined || mode === null || mode === '') return DISPATCH_MODES[5]; // current default
  const n = Number(mode);
  if (!Number.isInteger(n) || !DISPATCH_MODES[n]) {
    throw new Error(`mode must be 1–5 (1=${DISPATCH_MODES[1].key} … 5=${DISPATCH_MODES[5].key})`);
  }
  return DISPATCH_MODES[n];
}

// A dispatched zee never runs the /xell skill, so nothing tells it what it is. Hand it the SAME
// binding a skill-claim would inline (worktree, containers, build commands, rules) plus the facts
// of running headless. Without this it gets a bare task string — it doesn't know it's a zee, what
// it owns, how to build, or that nobody can answer a question, so it researches and then stalls
// asking "want me to continue?" into a void.
async function briefing(xellId, zee, task, { headless = true } = {}) {
  const b = await bindingFor(xellId, zee, task);
  // Be truthful about who (if anyone) can answer. A dispatched session is still a real session the
  // human can open and talk to — claiming "nobody can answer you" when they can is a lie that
  // pushes the zee to guess instead of surfacing a genuine blocker.
  const running = headless
    ? [
      '- UNATTENDED: nobody is watching this run. Do not stop to ask for confirmation or direction —',
      '  decide, act, and keep going until the job is done.',
      '- Ambiguity is not a blocker: pick the most reasonable option, note the assumption in your',
      '  final message, and continue. Research with nothing built is a FAILURE, not a status update.',
    ]
    : [
      '- ATTENDED: nobody is reading this exact turn, but a human CAN open this session and reply.',
      '  Default to deciding and proceeding — do not idle waiting for input.',
      '- If you hit a decision that is genuinely load-bearing and you would be guessing (a schema',
      '  choice, destructive migration, product behaviour), you MAY stop and ask — state the options',
      '  and your recommendation clearly, then wait. Do the reversible work first regardless.',
    ];
  return [
    'You are a ZEE: an autonomous agent the XEEHIVE queenzee placed in an isolated git worktree',
    '(a "xell") to do ONE job, start to finish.',
    '',
    '## Your binding (authoritative — this is the environment you own)',
    '```json',
    JSON.stringify({ xell: b.xell, containers: b.containers, build: b.build }, null, 2),
    '```',
    '',
    '## Rules',
    ...b.rules.map((r) => `- ${r}`),
    '',
    '## How you are running (read this carefully)',
    ...running,
    '- Do the work in THIS turn. Background sub-agents can be killed when the turn ends, so do not',
    '  put the critical path in one and wait on it — read the code yourself with Read/Glob/Grep.',
    '- Explore the codebase before designing: find the existing patterns and build on them.',
    '- When the job is done, stop. A human marks it done in the XEEHIVE dashboard — never despawn',
    '  yourself, and never touch the xource (the read-only main repo).',
    '',
    '## Your task',
    task,
  ].join('\n');
}

// headless-spawn — queenzee spawns a zee itself via the Agent SDK, no human click.
// Binds to a ready xell (cwd = its worktree), injects the opaque task, and drives the
// stream in the background, updating the zee row as the harness reports. The SAME hooks +
// poller observe it, so status/telemetry is identical to a skill-claimed zee.
// What model a dispatched zee runs. It was hard-defaulted to 'sonnet' while humans drive Opus —
// so every zee was quietly the weaker model on the hardest, least-supervised work. Override per
// dispatch, or set ZEE_MODEL. Default is opus: a zee runs unattended with no one to catch it.
const DEFAULT_ZEE_MODEL = process.env.ZEE_MODEL || 'opus';

export async function spawnHeadless({ projectId, xellId, task, runtime, model = DEFAULT_ZEE_MODEL, mode, title, headless = true }) {
  const m = resolveMode(mode);
  const pid = projectId || (await defaultProjectId());
  const xell = xellId
    ? await one(`SELECT * FROM xell WHERE id=$1`, [xellId])
    : await readyXellForCwd(pid, null);
  if (!xell) throw new Error('no ready xell available for headless spawn');
  if (!task) throw new Error('task (prompt) required for headless spawn');

  const cfgRow = await one(`SELECT default_runtime_id FROM pool_config WHERE project_id=$1`, [pid]);
  const rt = runtime ? await runtimeByKey(runtime) : await runtimeById(cfgRow?.default_runtime_id);

  // REMOTE runtime → run the literal `claude remote` CLI, not the local SDK.
  if (rt?.key === 'claude-code-remote') return spawnRemote({ pid, xell, task, rt, model, m, title, headless });

  let sdk;
  try { sdk = await import('@anthropic-ai/claude-agent-sdk'); }
  catch { throw new Error('@anthropic-ai/claude-agent-sdk not installed'); }

  // A zee never auto-titles itself. Always give it one: without a title Claude Code's sidebar
  // falls back to the worktree folder name ("calm-summit-403da6"), which is unreadable for a
  // human trying to find their work. Same string goes on zee.title so the dashboard matches.
  const zeeTitle = title || `xell : ${xell.slug}`;
  const zee = await one(
    `INSERT INTO zee (xell_id, attach_mode, runtime_id, viewer_kind, status, kind, entrypoint,
                      model, permission_mode, cwd, title)
     VALUES ($1,'headless-spawn',$2,$3,'spawning','headless','headless-sdk',$4,$5,$6,$7)
     RETURNING *`,
    [xell.id, rt?.id || null, rt?.viewer_kind || 'none', model, m.permissionMode, xell.worktree_path, zeeTitle]);
  await one(`UPDATE xell SET status='claimed', is_pooled=false WHERE id=$1`, [xell.id]);
  broadcast('zee', zee);
  logline('intake', `spawning zee in ${xell.slug} — mode ${m.key} (${m.permissionMode})`);

  const it = sdk.query({
    prompt: await briefing(xell.id, zee, task, { headless }), // the binding + rules, not a bare task
    options: {
      cwd: xell.worktree_path,
      model,
      // PROJECT KNOWLEDGE. Set both explicitly — do not rely on SDK defaults. Without them the
      // zee runs with no CLAUDE.md and no Claude Code system prompt, so it lands in a repo it
      // knows nothing about and burns its turn asking "where does the HRM module live?".
      // 'project' is REQUIRED for CLAUDE.md to load.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      permissionMode: m.permissionMode,
      // The SDK REQUIRES this companion flag for 'bypassPermissions' — without it the bypass is
      // rejected and the session silently falls back to prompting (shows as "Manual" in the UI),
      // which is exactly why dispatched zees came up asking for permission.
      ...(m.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      // tools: null → the SDK's full default set (modes 4–5); otherwise the mode's allow-list
      ...(m.tools ? { allowedTools: m.tools } : {}),
    },
  });
  const iter = it[Symbol.asyncIterator]();

  // AWAIT the first event so we report only what actually happened — a dispatch that says
  // "spawned" while the agent silently died is worse than an honest failure.
  let first;
  try {
    first = await Promise.race([
      iter.next(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out waiting for the agent to start')), 45000)),
    ]);
  } catch (err) {
    const reason = `headless spawn failed: ${err.message}`;
    const dead = await one(`UPDATE zee SET status='errored', last_stop_reason=$2 WHERE id=$1 RETURNING *`, [zee.id, reason.slice(0, 200)]);
    broadcast('zee', dead);
    await releaseXell(xell.id);
    return { ok: false, zee_id: zee.id, xell_id: xell.id, error: reason };
  }

  const m0 = first?.value;
  let sid = (m0?.type === 'system' && m0.subtype === 'init') ? (m0.session_id || m0.data?.session_id) : null;

  // Title the REAL Claude Code session (renameSession appends a custom-title entry to its JSONL).
  // Without this the spawned session shows as "Untitled" in the sidebar — zee.title only ever
  // labelled the XEEHIVE dashboard row, not the session itself.
  // Retry in the background: at init the session's JSONL may not exist yet, so an immediate
  // rename races file creation and silently loses the title.
  // Fast backoff, not a flat 1.5s wait: the session's JSONL appears almost immediately, and every
  // millisecond it sits untitled is a window where the human opens it and sees "Untitled" (the
  // panel header caches the title at open and won't refresh).
  if (sid && zeeTitle && typeof sdk.renameSession === 'function') {
    (async () => {
      for (let i = 0, wait = 100; i < 12; i++, wait = Math.min(wait * 1.6, 2000)) {
        try { await sdk.renameSession(sid, zeeTitle); logline('intake', `titled session ${sid.slice(0, 8)} → "${zeeTitle}"`); return; }
        catch { await new Promise((r) => setTimeout(r, wait)); } // JSONL not written yet — retry
      }
      logline('intake', `could not title session ${sid.slice(0, 8)} (renameSession kept failing)`);
    })();
  }
  const { url } = viewerUrlFor(rt, sid, null);
  const live = await one(
    `UPDATE zee SET claude_session_id=COALESCE($2, claude_session_id), session_name=COALESCE($2, session_name),
                    viewer_url=$3, status='working', attached_at=now() WHERE id=$1 RETURNING *`,
    [zee.id, sid, url]);
  broadcast('zee', live);

  // drive the REST of the stream in the background — do NOT block the caller
  (async () => {
    try {
      for (let n = await iter.next(); !n.done; n = await iter.next()) {
        const msg = n.value;
        if (msg?.type === 'system' && msg.subtype === 'init') {
          const s = msg.session_id || msg.data?.session_id;
          if (s && s !== sid) {
            sid = s;
            const v = viewerUrlFor(rt, s, null);
            await q(`UPDATE zee SET claude_session_id=$2, session_name=$2, viewer_url=$3 WHERE id=$1`, [zee.id, s, v.url]);
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

  return { ok: true, zee_id: zee.id, xell_id: xell.id, worktree: xell.worktree_path, session: sid,
           mode: m.key, permission_mode: m.permissionMode };
}

// A spawn that failed must hand the xell back — otherwise a dead zee strands it as 'claimed'.
async function releaseXell(xellId) {
  const row = await one(`UPDATE xell SET status='ready', is_pooled=true WHERE id=$1 AND status='claimed' RETURNING *`, [xellId]);
  if (row) broadcast('xell', row);
}

// REMOTE spawn — runs the literal `claude remote` command (Remote Control). Records the
// real CLI result; if claude.ai isn't logged in, the zee is marked errored with the CLI's
// own message (no fabricated success).
async function spawnRemote({ pid, xell, task, rt, model, m = DISPATCH_MODES[5], title, headless = true }) {
  const name = `xell-${xell.slug}`;
  const zee = await one(
    `INSERT INTO zee (xell_id, attach_mode, runtime_id, viewer_kind, status, kind, entrypoint,
                      model, permission_mode, cwd, remote_ref, title)
     VALUES ($1,'headless-spawn',$2,'web','spawning','remote','claude-remote',$3,$4,$5,$6,$7)
     RETURNING *`,
    [xell.id, rt.id, model, m.permissionMode, xell.worktree_path, name, title || null]);
  await one(`UPDATE xell SET status='claimed', is_pooled=false WHERE id=$1`, [xell.id]);
  broadcast('zee', zee);

  // AWAIT the real CLI result — never claim a zee started before we've observed it. (remoteStart
  // is async and fails fast, e.g. when claude.ai isn't logged in.)
  const res = await remoteStart({ name, prompt: await briefing(xell.id, zee, task, { headless }), cwd: xell.worktree_path, model });
  if (res.ok) {
    const viewer = viewerUrlFor(rt, res.sessionId, res.url);
    const updated = await one(
      `UPDATE zee SET claude_session_id=$2, session_name=$2, viewer_url=$3, viewer_kind=$4,
                      status='working', attached_at=now() WHERE id=$1 RETURNING *`,
      [zee.id, res.sessionId || name, viewer.url, viewer.kind]);
    broadcast('zee', updated);
    return { ok: true, zee_id: zee.id, xell_id: xell.id, session: res.sessionId || name,
             remote: { ran: `claude ${remoteStartArgs({ name, model }).join(' ')}`, started: true } };
  }

  const reason = res.loggedOut
    ? 'claude remote: not logged in to claude.ai (Remote Control requires a subscription). '
      + 'Switch the runtime to "Claude Code (local)" or run `claude /login`.'
    : `claude remote start failed (exit ${res.status}): ${(res.stderr || '').slice(0, 160) || 'no output / timed out'}`;
  const dead = await one(`UPDATE zee SET status='errored', last_stop_reason=$2 WHERE id=$1 RETURNING *`, [zee.id, reason.slice(0, 200)]);
  broadcast('zee', dead);
  await releaseXell(xell.id); // a dead zee must not hold the xell hostage
  return { ok: false, zee_id: zee.id, xell_id: xell.id, error: reason };
}

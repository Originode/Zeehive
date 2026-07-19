// Intake router — binds a zee to a ready xell. Two modes, same DB + observability:
//   skill-claim   : a human's Claude session (via /xell) claims the freshest ready xell
//   headless-spawn: queenzee spawns a headless zee via the Agent SDK (see spawnHeadless)
import { resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { q, one } from '../db/pool.js';
import { config } from '../config.js';
import { runtimeById, runtimeByKey, viewerUrlFor } from '../lib/runtimes.js';
import { resolveRealDbContainerCached } from '../lib/xell-db.js';
import { broadcast } from '../lib/events.js';
import { remoteStart, remoteStartArgs } from '../lib/claude-cli.js';
import { provisionXell } from '../lib/provision.js';
import { sessionTitle } from '../lib/session-title.js';
import { renameXellForTask } from '../lib/rename-xell.js';
import { attachXellDb } from '../lib/xell-db.js';
import { cloneInstanceFor } from '../lib/db-instances.js';
import { resolveProjectId } from '../lib/project-resolve.js';
import { dbIdentity } from '../lib/projects.js';
import { landOne, isAtSourceTip } from './landing.js';
import { logline } from '../lib/logbus.js';
import { tokenForSpawn } from '../lib/provider-tokens.js';
import { ensureCage, cloneIntoCage, warmCage, sealCage, runZee, removeCage, cageName,
         ensureZeehiveKeypair, openCageSsh } from '../lib/cage.js';
import { mintXellToken } from '../lib/xell-token.js';

// PROVISION_MODE=real actually creates the git worktree (and app tier unless
// PROVISION_APP_TIER=false); 'simulate' models it in the DB only. Same knob as the pool.
const PROVISION_MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

function norm(p) { return String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase(); }

async function readyXells(projectId) {
  // Machine-priority first (023): a claim takes a ready xell from the preferred machine before
  // any other — "if local priority is higher, dev xells get spawned there first" applies to
  // dispatch exactly like it does to the pool fill. With no machine rows every priority is 0
  // and this is the old freshest-first order unchanged.
  return q(
    `SELECT x.* FROM xell x
       LEFT JOIN container sc ON sc.owner_xell_id = x.id AND sc.role = 'server'
       LEFT JOIN machine m ON m.docker_ctx = sc.docker_ctx AND m.enabled
      WHERE x.project_id = $1 AND x.status = 'ready'
      ORDER BY COALESCE(m.dev_priority, 0) DESC, x.ready_at DESC NULLS LAST, x.created_at DESC`,
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

// Last-resort default, for internal callers that genuinely have no project signal (the task
// poller). Intake never uses it: claim/dispatch resolve from the invoker's cwd instead, because
// "oldest project row" silently means OmniBiz even when you are standing in ZeeHive.
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
  // The invoker hands over its project: explicit `project`, else the repo/worktree its cwd is in.
  const projectId = await resolveProjectId({ project, cwd });

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
    const proj = await one(`SELECT name, repo_root FROM project WHERE id=$1`, [projectId]);
    logline('intake', `claim refused (not in worktree) — offering dispatch to ${open.slug} in ${proj?.name} (${drt?.label || 'default'})`);
    throw new NeedsWorktree({
      needs_worktree: true,
      can_dispatch: true,
      // Which project the caller's cwd resolved to — the human confirming the dispatch must be
      // able to see it landed on the right repo before saying yes.
      project: { id: projectId, name: proj?.name, repo_root: proj?.repo_root },
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

// First heading (or first non-empty line) of a task's text — the human-readable name of the job.
// Markdown '#' prefixes are stripped; long lines truncated (slugifyTitle caps the folder anyway).
function titleFromTask(task) {
  for (const raw of String(task || '').split(/\r?\n/)) {
    const line = raw.replace(/^#+\s*/, '').trim();
    if (line) return line.slice(0, 80);
  }
  return null;
}

// Pasted images ride the dispatch body as base64 data URLs (the dashboard "+" composer lets a
// human paste a screenshot into the prompt). Decode them into the TARGET worktree so the spawned
// zee can Read them by a path relative to its cwd — the same way a human would hand it a file.
// Returns the worktree-relative paths saved (drops any that fail; never throws — a bad image must
// not sink the dispatch). The folder gets a `.gitignore` of `*` so pasted screenshots never show
// up as dirty files or get accidentally committed by the zee.
function saveDispatchImages(worktreePath, images) {
  if (!worktreePath || !existsSync(worktreePath) || !Array.isArray(images) || !images.length) return [];
  const dir = resolve(worktreePath, '.zeehive', 'prompt-attachments');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, '.gitignore'), '*\n'); // git ignores the whole folder, incl. this file
  } catch (e) { logline('intake', `could not prepare attachments dir: ${e.message}`); return []; }
  const stamp = Date.now();
  const saved = [];
  images.forEach((img, i) => {
    const data = typeof img === 'string' ? img : img?.data;
    if (!data) return;
    const m = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(data);
    const mime = (m && m[1]) || 'image/png';
    const b64 = m ? m[2] : data;
    const ext = (mime.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'png';
    const raw = (typeof img === 'object' && img?.name) ? String(img.name) : '';
    const base = raw.replace(/\.[^.]*$/, '').replace(/[^a-z0-9._-]/gi, '_').slice(0, 40) || `pasted-${i + 1}`;
    const rel = `.zeehive/prompt-attachments/${stamp}-${i + 1}-${base}.${ext}`;
    try {
      writeFileSync(resolve(worktreePath, rel), Buffer.from(b64, 'base64'));
      saved.push(rel);
    } catch (e) { logline('intake', `could not save pasted image #${i + 1}: ${e.message}`); }
  });
  return saved;
}

// POST /api/xell/dispatch — the confirmed auto-dispatch path for /xell run OUTSIDE a worktree.
// The queenzee spawns a zee INTO a ready xell's worktree (headless locally, or `claude remote`
// per the runtime) to run the task. Human confirms in their session before this is called.
export async function dispatchXell({ xell_id, task, runtime, project, cwd, mode, session_id, title,
                                     headless = true, model, db, db_container, dump, images }) {
  if (!task) throw new Error('task (prompt) required to dispatch');
  const m = resolveMode(mode); // validates 1–5 up front, before anything is spawned
  // Same handover as claim, plus: a named xell_id decides the project by itself — the dispatcher's
  // cwd cannot contradict the worktree the zee will actually run in.
  const projectId = await resolveProjectId({ project, cwd, xell_id });
  // The TASK names this work — not the dispatcher. Naming from the invoking session's title
  // produced worktrees named after whatever the dispatcher happened to be doing earlier: a
  // "machine chip on xell cards" task dispatched from a session titled "Windows Subsystem for
  // Linux setup" became windows-subsystem-for-linux-setup-49ac05 on the dashboard. The task's
  // own first heading/line is the job's name; an explicit `title` param still wins, and the
  // session title remains only the fallback for a caller with no readable task text.
  // The spawned zee never titles itself, so the same string (prefixed "xell : ") becomes
  // zee.title — the sidebar, the worktree folder and the dashboard all name the same job.
  const from = title || titleFromTask(task) || (session_id ? sessionTitle(session_id) : null);
  const inherited = from ? `xell : ${from}` : null;

  // Resolve the target xell UP FRONT. If the caller didn't name one we must still pick it here,
  // not inside spawnHeadless — otherwise the rename below is skipped and the xell keeps its
  // cryptic pooled slug, which is the whole thing the rename exists to fix.
  const targetId = xell_id || (await readyXells(projectId))[0]?.id || null;

  // Now that we know the job, give the worktree a human-trackable name — BEFORE spawning, so the
  // zee's cwd is the final path and Claude Code's sidebar (which names a worktree by its folder)
  // shows something findable instead of "calm-summit-403da6". Best-effort: if it can't rename
  // (already built, name taken), the xell just keeps its pooled slug and the dispatch proceeds.
  if (targetId && from) await renameXellForTask(targetId, from);

  // Point the xell at the right database BEFORE the zee starts — a pooled xell comes up on the
  // shared dev db, so "start from the latest prod dump" or "hotfix against prod" must be attached
  // now or the zee spends its turn on the wrong data.
  if (targetId && (db || db_container || dump)) {
    await attachXellDb(targetId, { coupling: db, container: db_container, dump });
  }

  // Pasted images: save them into the (possibly just-renamed) target worktree and append a
  // reference block so the zee is handed PATHS to Read, not a base64 blob in its prompt. Done
  // AFTER the rename above, which moves the worktree folder — so we re-read the current path.
  let taskText = task;
  if (targetId && Array.isArray(images) && images.length) {
    const wt = (await one(`SELECT worktree_path FROM xell WHERE id=$1`, [targetId]))?.worktree_path;
    const saved = saveDispatchImages(wt, images);
    if (saved.length) {
      taskText += `\n\n## Attached images\n`
        + `The human pasted ${saved.length} image(s) into this prompt. They are saved in your `
        + `worktree — open them with the Read tool (paths are relative to your worktree root):\n`
        + saved.map((p) => `- ${p}`).join('\n');
    }
  }

  const spawned = await spawnHeadless({
    projectId, xellId: targetId, task: taskText, runtime, mode, title: inherited,
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
  // Record the task, exactly as a skill-claim does. Without this the xell has no task row, so the
  // dashboard cannot render "Mark done" — a dispatched zee that reports done would strand in
  // awaiting-done with no way for a human to confirm it and no path to being reaped.
  await q(
    `INSERT INTO task (project_id, prompt_text, source, status, xell_id, zee_id, assigned_at)
     VALUES ($1,$2,'dispatch','assigned',$3,$4, now())`,
    [projectId, taskText, spawned.xell_id, spawned.zee_id]);

  logline('intake', `dispatched a zee into ${xell?.slug} — confirmed working (${runtime || 'default runtime'}, mode ${m.key})`);
  return { status: 'dispatched', slug: xell?.slug, worktree: xell?.worktree_path,
           mode: m.key, mode_label: m.label, ...spawned };
}

// The JSON the /xell skill inlines so the Claude session becomes this xell's zee.
async function bindingFor(xellId, zee, task) {
  const xell = await one(`SELECT x.*, xo.ref AS xource_ref FROM xell x JOIN xource xo ON xo.id=x.xource_id WHERE x.id=$1`, [xellId]);
  const dbid = await dbIdentity(xell.project_id);
  const rows = await q(
    `SELECT c.role, c.name, c.url, c.tier, c.conn_ref, c.docker_ctx, uc.relation
       FROM xell_uses_container uc JOIN container c ON c.id = uc.container_id
      WHERE uc.xell_id = $1 ORDER BY c.role`, [xellId]);

  // RESOLVE AT THE BOUNDARY — every consumer below inherits it, so no field can drift back to the
  // inventory name. The row carries a LOGICAL name; the daemon runs a versioned one, and the
  // logical name can be an EXITED husk still holding the old volume. Un-resolved it either errors
  // (`container … is not running`) or — if anyone starts that husk — silently reads and WRITES the
  // wrong database while looking correct.
  //
  // Resolving field-by-field is what broke this before: `db.psql` resolved while `db.container`
  // and the whole `containers[]` list stayed raw — and `rules` says "use ONLY your assigned
  // containers above", pointing the zee AT the dead name. It got a working command beside a dead
  // name, used the name, and read `container … is not running` as "I am blocked from prod".
  const stack = rows.map((c) => (c.role === 'db'
    ? { ...c, name: resolveRealDbContainerCached(c.docker_ctx, c.name) }
    : c));

  // HOW TO REACH YOUR DATABASE — spelled out, because guessing is how a zee ends up running
  // docker against a container it was never given (and getting denied by the prod guard). The db
  // has no conn_ref and prod's postgres isn't exposed on the network, so `docker exec` IS the
  // sanctioned path for data work — the prod guard allows it for exactly the xell whose assigned
  // database this is, and denies it for everyone else.
  const dbc = stack.find((c) => c.role === 'db');   // already resolved at the boundary above
  // db-clone: the CONTAINER is shared, but this DATABASE inside it is the xell's own (its
  // db_instance row). The container's conn_ref names the SHARED database, so a clone must never
  // inherit it — every handle below carries the clone's name instead.
  const clone = xell.db_coupling === 'db-clone' ? (await cloneInstanceFor(xellId))?.name || null : null;
  const db = dbc ? {
    container: dbc.name,
    coupling: xell.db_coupling,
    ...(clone ? { database: clone } : {}),
    is_production: dbc.tier === 'prod',
    psql: (dbc.conn_ref && !clone)
      ? `psql "${dbc.conn_ref}"`
      : `docker --context ${dbc.docker_ctx} exec -i ${dbc.name} psql -U ${dbid.user} -d ${clone || dbid.name}`,
    note: dbc.tier === 'prod'
      ? 'This IS the live production database — a human deliberately assigned it to you (--db shared-prod). '
        + 'It is YOUR container: querying it is expected, not a violation. Reads are free. Before ANY '
        + 'write/migration, state exactly what it will change and get a human to agree.'
      : clone
        ? `Your assigned database is YOUR OWN CLONE (${clone}) inside the shared dev postgres — `
          + 'migrate/seed/destroy it freely; nothing you do to it touches dev, prod, or any other zee. '
          + `Always connect with -d ${clone}: the container's default database is the SHARED dev db, `
          + 'and its schema is frozen (DDL there trips every xell\'s ship gate).'
        : 'Your assigned database. Do not reach for prod: you were not given it, and the prod guard '
          + 'will deny it.',
  } : null;
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
    wait_suffix: '--wait',
    semantics: {
      build: 'rebuilds the image from THIS worktree\'s code and recreates the container — use this to see your changes run',
      hot: 'append --hot to bounce the container from the existing image (fast, but does NOT pick up code changes — there is no source mount)',
      wait: 'append --wait to BLOCK until the build settles and be told whether the container is '
          + 'actually serving your current HEAD (exit 0 = built, 1 = failed/timeout, 20min cap)',
    },
    how_to_wait: 'NEVER hand-roll a wait. Do not curl your own webapp in a poll loop, do not grep '
      + 'it for your changed text, do not `sleep` and re-check: those loops guess at a condition, '
      + 'and when they guess wrong they hang for 45 minutes on a build that finished long ago. '
      + `Instead run \`${bs} ${xell.id} <role> --wait\`. The queenzee RECORDS the commit each `
      + 'container was built at, so --wait answers from fact. Run it in the BACKGROUND and its exit '
      + 'is your nudge — the harness re-invokes you the moment it finishes, so you can keep working.',
    note: 'Without --wait, builds are non-blocking and you get no completion signal at all (the '
      + 'dashboard spinner is for the human, not for you).',
  };

  // SHIPPING TO PRODUCTION — one pipeline, and the queenzee narrates it. The zee is told only
  // where the gate is, never the procedure: /api/ooney/check answers every call with the exact
  // next step measured from live state, so instructions cannot drift the way a baked-in document
  // would. Everything in the cascade is queenzee-executed and deterministic (sync check, schema
  // diff vs prod, container builds, the prod build itself); the ONLY step the zee performs is the
  // human-cleared merge to the source, and the only human step is clearance.
  const oo = `node "${resolve(config.repoRoot, 'scripts', 'xell-ooney.mjs')}"`;
  const ship = {
    how: 'To put your work in PRODUCTION, run /ooney (or the command below). It is a gate cascade: '
       + 'in-sync-with-source, schema identical to prod, your containers built from your current '
       + 'commit, then HUMAN clearance — the queenzee then builds prod itself, holding the prod '
       + 'lock for your xell (the prod build API rejects any non-holder). The response of every '
       + 'call IS the procedure: do what the failing gate says, then re-run. Do not improvise '
       + 'around a deny, and do not attempt any prod docker/compose command yourself — the guard '
       + 'denies it and the gate exists so you never need it.',
    check: `${oo} [server|webapp|both]`,
    wait: `${oo} [server|webapp|both] --wait   # run in the BACKGROUND; its exit is your nudge (live=0, deny=1)`,
    targets: 'Name what you are shipping: server, webapp, or both (default both).',
  };

  return {
    status: 'claimed', // the gate: the zee may begin work ONLY when this is 'claimed'
    xell: {
      id: xell.id, slug: xell.slug, branch: xell.branch, worktree_path: xell.worktree_path,
      source: xell.xource_ref, source_coupling: xell.source_coupling, db_coupling: xell.db_coupling,
      ...(clone ? { clone_db_name: clone } : {}),
    },
    zee: { id: zee.id, name: zee.name, viewer_url: zee.viewer_url },
    containers: stack,
    build,
    db,
    ship,
    task: task || null,
    rules: [
      'Work ONLY inside worktree_path. Never touch the xource (read-only).',
      'Use ONLY your assigned containers/URLs above.',
      ...(xell.db_coupling === 'db-shared-prod'
        ? ['⚠ YOUR DATABASE IS LIVE PRODUCTION (db_coupling=db-shared-prod). Every write is real and '
         + 'irreversible — there is no undo and no snapshot between you and an outage. Read freely; '
         + 'before ANY write or migration, state exactly what it will change and get a human to agree. '
         + 'Never run a destructive statement to "test" something.']
        : []),
      ...(xell.db_coupling === 'db-isolated'
        ? ['Your database is your OWN container, restored from a dump — it is a copy, so you may '
         + 'migrate/seed/destroy it freely. Nothing you do to it touches dev or prod.']
        : []),
      ...(xell.db_coupling === 'db-clone'
        ? [`Your database is your OWN CLONE (${clone || 'see db.database'}) inside the shared `
         + 'dev postgres — migrate/seed/destroy it freely, nothing touches dev/prod/other zees. ALWAYS '
         + 'connect with -d to YOUR database: the container default is the shared dev db, whose schema is '
         + 'FROZEN. Write schema changes as files under server/sql/migrations/ (idempotent DDL; one-time '
         + `data fixes under server/sql/ops/), then apply them to your clone with `
         + `\`node "${resolve(config.repoRoot, 'scripts', 'xell-db-migrate.mjs')}" ${xell.id}\` — the SAME `
         + 'files ride your ship to prod, so testing them here is testing the deploy.']
        : []),
      ...(xell.db_coupling === 'db-shared-dev'
        ? ['NEVER run DDL (CREATE/ALTER/DROP …) on your database — it is the SHARED dev db and its '
         + 'schema is frozen; ad-hoc DDL there trips every other xell\'s ship gate. If this job needs '
         + 'schema changes, write them as files under server/sql/migrations/ — the queenzee detects '
         + 'those on your branch and auto-attaches your own clone database (watch for the db-clone '
         + 'switch, then rebuild your app tier so it picks up its own DATABASE_URL).']
        : []),
      'VERIFY YOUR WORK IN THIS XELL — you already have everything you need. The containers listed '
      + 'above are YOURS: your own server, webapp and database, isolated from prod and from every '
      + 'other zee. Do not ask for a xell (you are in one), do not ask to use dev or prod, and do '
      + 'not stop at "I cannot verify this here". Build into your own containers with the `build` '
      + 'commands above and exercise the real thing before you call the work done.',
      'To run/see your changes, BUILD via the `build` commands above — never run docker, docker compose, or spin-env.sh yourself.',
      'To wait for a build, append --wait to the build command (see build.how_to_wait). NEVER poll '
      + 'your own container in a bash loop to find out if a build landed — that is how zees end up '
      + 'blocked for an hour on a build that succeeded long ago.',
      'CHECKPOINT-COMMIT FREELY on your own branch (`git commit` as you go, whenever a step works). '
      + 'A commit only moves YOUR branch ref — it lands nothing, touches no one else, and is the '
      + 'only thing protecting your work. Nothing is integrated until you push, and that push needs '
      + 'a human. So commit early and often; do not hoard uncommitted changes waiting for approval.',
      `To SHIP TO PRODUCTION you may only ASK: \`node "${resolve(config.repoRoot, 'scripts', 'xell-ship.mjs')}" ${xell.id} --reason "<what you are shipping>" --wait\` `
      + '(run it in the BACKGROUND — its exit is your nudge). A human approves it, then the '
      + 'QUEENZEE takes the prod lock and runs the deploy itself, from the xource at main. You do '
      + 'NOT hold the lock, you do NOT run a prod build, and you do NOT release anything — that is '
      + 'deliberate: a zee deploying by hand ships a band-aid (live in prod, absent from main, '
      + 'silently reverted by the next rebuild from main). A ship is REFUSED unless your work is '
      + 'already landed on main. Never run docker/compose against prod yourself.',
      'Land locally: commit on your branch, then `git push . HEAD:main`. origin is off-limits.',
      'That push is a REQUEST, not an action: a git hook on the xource declines it and raises it '
      + 'in the ZEEHIVE console for a human to verify. Expected — your work is safe on your branch. '
      + 'Re-run the SAME push once a human approves it; do not amend to a new sha, and never try to '
      + 'bypass the hook.',
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

// The harness's permission modes — what a RUNNING session can be switched between. Distinct from
// DISPATCH_MODES above: a dispatch level also picks a tool allow-list, which is fixed at spawn
// and cannot change mid-session. This is the changeable half.
export const PERMISSION_MODES = ['default', 'plan', 'acceptEdits', 'bypassPermissions'];

// Live control handles for headless SDK zees: zee_id → the SDK query object, held while its
// stream is being driven. This is the ONLY channel that can change a running session's mode —
// setPermissionMode is a control request over the CLI's stdin, and the SDK keeps stdin open
// until the turn's first result even for a string prompt. A skill-claimed (interactive) zee
// lives in the human's own Claude Code process, so it never appears here.
const LIVE_QUERIES = new Map();

// Change a zee's permission mode from the dashboard. Live-applies when we hold the session's
// handle; otherwise records on the zee row and says so — for an interactive session the mode is
// changed in-session (shift+tab), and the hook sync in status.js keeps the chip truthful either
// way (it mirrors whatever mode the session actually reports next).
export async function setZeeMode(zeeId, permissionMode) {
  if (!PERMISSION_MODES.includes(permissionMode)) {
    throw new Error(`permission_mode must be one of: ${PERMISSION_MODES.join(', ')}`);
  }
  const zee = await one(`SELECT * FROM zee WHERE id=$1`, [zeeId]);
  if (!zee) throw new Error('no such zee');

  let applied = false;
  let note = null;
  const it = LIVE_QUERIES.get(zee.id);
  if (it) {
    try { await it.setPermissionMode(permissionMode); applied = true; }
    catch (err) {
      // Recorded anyway — the next hook event re-syncs the chip to the session's REAL mode, so a
      // failed apply cannot leave a lie on screen for long. Most common causes: the turn already
      // ended (stdin closed), or bypass was refused (session spawned without the danger flag).
      note = `could not apply to the running session (${String(err?.message || err).slice(0, 140)}) — `
        + 'recorded on the zee; the chip re-syncs to the session’s real mode on its next event.';
    }
  } else if (['spawning', 'online', 'working', 'idle'].includes(zee.status)) {
    note = 'no control channel to this session (it runs in its own Claude Code process) — recorded '
      + 'on the zee; change the mode in the session itself (shift+tab) to make it real. The chip '
      + 'follows whatever mode the session actually reports.';
  }

  const updated = await one(`UPDATE zee SET permission_mode=$2 WHERE id=$1 RETURNING *`, [zeeId, permissionMode]);
  broadcast('zee', updated);
  logline('intake', `zee ${String(zee.id).slice(0, 8)} mode → ${permissionMode}${applied ? ' (live)' : ' (recorded)'}`);
  return { ok: true, zee_id: zee.id, permission_mode: permissionMode, applied, note };
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
    'You are a ZEE: an autonomous agent the ZEEHIVE queenzee placed in an isolated git worktree',
    '(a "xell") to do ONE job, start to finish.',
    '',
    '## Your binding (authoritative — this is the environment you own)',
    '```json',
    // Include `db` — without it a dispatched zee has ONLY containers[] for its database, so it
    // reconstructs the `docker exec … psql` line by hand (guessing the exact form) and never sees
    // db.note, the prod-write warning. A claiming zee gets the whole binding; a dispatched one got
    // three keys. Same handoff, same fields.
    JSON.stringify({ xell: b.xell, containers: b.containers, db: b.db, build: b.build }, null, 2),
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
    '- When the job is done, stop. A human marks it done in the ZEEHIVE dashboard — never despawn',
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

// The models a dispatched zee can run — the aliases the Agent SDK/CLI resolves to the current
// Claude generation (so we never hardcode a dated model id here). The dashboard "+" composer reads
// this for its model picker; `default` marks whatever DEFAULT_ZEE_MODEL currently is.
const ZEE_MODELS = [
  { key: 'opus',   label: 'Opus',   note: 'most capable — best for unattended, load-bearing work' },
  { key: 'sonnet', label: 'Sonnet', note: 'fast and cheaper — good for well-scoped or simple jobs' },
  { key: 'haiku',  label: 'Haiku',  note: 'fastest and cheapest — light edits and quick tasks' },
];
export function listDispatchModels() {
  return ZEE_MODELS.map((m) => ({ ...m, default: m.key === DEFAULT_ZEE_MODEL }));
}

export async function spawnHeadless({ projectId, xellId, task, runtime, model = DEFAULT_ZEE_MODEL, mode, title, headless = true }) {
  const m = resolveMode(mode);
  const pid = projectId || (await defaultProjectId());
  const xell = xellId
    ? await one(`SELECT * FROM xell WHERE id=$1`, [xellId])
    // No xell named → take the freshest ready one. (readyXellForCwd matches a caller's cwd to a
    // worktree and takes the ready ARRAY — passing projectId here silently matched nothing, so
    // every dispatch without an explicit xell_id died with "no ready xell available".)
    : (await readyXells(pid))[0];
  if (!xell) throw new Error('no ready xell available for headless spawn');
  if (!task) throw new Error('task (prompt) required for headless spawn');

  // A stale xell_id is the whole ballgame here. An explicit id resolved in an earlier turn can
  // point at a xell the reaper has since RETIRED — and a retired xell's worktree is deleted. We
  // then hand that dead path to the SDK as `cwd`, Node raises ENOENT on the spawn, and the SDK
  // blames the EXECUTABLE: "native binary ... exists but failed to launch ... musl vs glibc".
  // That message is boilerplate (sZ() in sdk.mjs — it prints it for ANY spawn error) and it is a
  // lie on Windows: the binary is fine. Two sessions burned an hour debugging a perfectly good
  // claude.exe because of it. So check here, and say what is ACTUALLY wrong.
  if (xell.status === 'retired' || xell.status === 'tearing-down') {
    throw new Error(
      `xell ${xell.slug} is ${xell.status} — its worktree is gone, so there is nothing to spawn into. `
      + 'You are holding a stale xell id from an earlier turn; ask the queenzee for a ready xell instead.');
  }
  if (!xell.worktree_path || !existsSync(xell.worktree_path)) {
    throw new Error(
      `xell ${xell.slug} has no worktree on disk (${xell.worktree_path}) — the DB says '${xell.status}' but the `
      + 'directory is missing, so a spawn there would fail. Do NOT chase the Claude binary if you see a '
      + '"failed to launch / libc" error: that is the SDK misreporting ENOENT on this cwd.');
  }

  const cfgRow = await one(`SELECT default_runtime_id FROM pool_config WHERE project_id=$1`, [pid]);
  const rt = runtime ? await runtimeByKey(runtime) : await runtimeById(cfgRow?.default_runtime_id);

  // REMOTE runtime → run the literal `claude remote` CLI, not the local SDK.
  if (rt?.key === 'claude-code-remote') return spawnRemote({ pid, xell, task, rt, model, m, title, headless });
  // CAGED runtime → the CLI runs INSIDE the xell's zee-agent container (structural confinement).
  if (rt?.key === 'claude-code-caged') return spawnCaged({ pid, xell, task, rt, model, m, title, headless });

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
  LIVE_QUERIES.set(zee.id, it); // dashboard mode changes reach this session while we drive it

  // AWAIT the first event so we report only what actually happened — a dispatch that says
  // "spawned" while the agent silently died is worse than an honest failure.
  let first;
  try {
    first = await Promise.race([
      iter.next(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out waiting for the agent to start')), 45000)),
    ]);
  } catch (err) {
    LIVE_QUERIES.delete(zee.id);
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
  // labelled the ZEEHIVE dashboard row, not the session itself.
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
    } finally {
      LIVE_QUERIES.delete(zee.id); // stream over → no live control channel to hand out
    }
  })();

  return { ok: true, zee_id: zee.id, xell_id: xell.id, worktree: xell.worktree_path, session: sid,
           mode: m.key, permission_mode: m.permissionMode };
}

// CAGED spawn — the zee's claude CLI runs INSIDE a per-xell zee-agent container. This is the
// runtime that makes confinement STRUCTURAL instead of prompted: the cage sees a private clone
// of the xell's branch, a default-DROP egress firewall (api.anthropic.com + the queenzee API +
// its own stack's host:ports), no docker socket, no host filesystem. Because the walls are
// real, the CLI always runs bypassPermissions inside — the cage IS the permission system, so
// the dispatch mode's tool ladder is irrelevant here (there is nothing outside to protect).
//
// No viewer: the session JSONL lives inside the container, so claude:// cannot attach. The
// live feed is the stream-json event stream, re-broadcast per-zee on the SSE bus as
// 'zee-output' and narrated into the Terminal under the `zee:<slug>` scope.
async function spawnCaged({ pid, xell, task, rt, model, m = DISPATCH_MODES[5], title, headless = true }) {
  // Token FIRST — a project with no connected Claude token must fail the dispatch cleanly
  // (with the fix spelled out) before anything claims the xell or builds a container.
  const token = await tokenForSpawn(pid, 'claude');

  // Egress policy (simplified 2026-07-19): the container is the confinement boundary — a caged
  // zee can't reach the host or other xells no matter what — so we DON'T lock egress down (that
  // only broke npm/builds). We block the ONE thing that matters: the fleet's live PROD databases,
  // which Docker's bridge NAT would otherwise expose on the LAN. A xell bound to prod
  // (db-shared-prod) keeps its OWN prod DB reachable — that binding is a human's call.
  const prodDbs = await q(
    `SELECT DISTINCT host(c.host) AS host, c.host_port, c.project_id FROM container c
      WHERE c.tier='prod' AND c.role='db' AND c.host IS NOT NULL AND c.host_port IS NOT NULL`);
  const prodBound = xell.db_coupling === 'db-shared-prod';
  const blockTcp = prodDbs
    .filter((r) => !(prodBound && r.project_id === xell.project_id))
    .map((r) => `${r.host}:${r.host_port}`);

  const zeeTitle = title || `xell : ${xell.slug}`;
  const zee = await one(
    `INSERT INTO zee (xell_id, attach_mode, runtime_id, viewer_kind, status, kind, entrypoint,
                      model, permission_mode, cwd, title)
     VALUES ($1,'headless-spawn',$2,'none','spawning','headless','caged-cli',$3,'bypassPermissions',$4,$5)
     RETURNING *`,
    [xell.id, rt?.id || null, model, '/work/repo', zeeTitle]);
  await one(`UPDATE xell SET status='claimed', is_pooled=false WHERE id=$1`, [xell.id]);
  broadcast('zee', zee);
  logline('intake', `caging zee in ${xell.slug} — building the cage (mode requested: ${m.key}; cage always runs bypass inside)`);

  // The cage runs on the queenzee's local daemon for now — its network reach is the firewall
  // allow-list, so co-location with the xell's app tier is unnecessary (they meet over TCP).
  const ctx = 'default';
  const name = cageName(xell.slug);
  // The per-xell IDENTITY token: the caged zee's only credential to the queenzee's /api/xell/self/*
  // workflow verbs (land/ship/prod/done/status). Minted here, HASH stored on the xell, PLAINTEXT
  // injected into the cage env below — never persisted in the clear (see lib/xell-token.js).
  const xellToken = await mintXellToken(xell.id);
  let sshPort = null;
  try {
    const created = await ensureCage({ ctx, slug: xell.slug, xellId: xell.id });
    sshPort = created.sshPort;
    await cloneIntoCage({ ctx, name, worktree: xell.worktree_path });
    // Warm BEFORE sealing (egress fully open): install deps + prebuild so the zee starts working
    // right away instead of running npm itself. Queenzee-driven, so it costs no agent tokens.
    logline('cage', `${name}: warming (npm ci + web build) so the zee starts ready…`);
    const warm = await warmCage({ ctx, name });
    logline('cage', `${name}: ${warm.warmed ? 'warmed (deps + web build ready)' : 'warm incomplete — zee will install as needed'}`);
    const sealed = await sealCage({ ctx, name, blockTcp });
    logline('cage', `${name}: ${sealed[sealed.length - 1]}`);
    // Open the attend door: authorize the fleet key and start sshd with the token in the login
    // env. This is what makes the dashboard terminal and desktop "Add SSH host" work — the zee's
    // viewer_url below becomes a literal ssh:// deeplink into this cage. The xell identity token
    // rides into /etc/environment too, so an attending SSH shell's `zee` CLI is authenticated.
    const { publicKey } = ensureZeehiveKeypair();
    await openCageSsh({ ctx, name, publicKey, token, xellToken });
    const viewerUrl = `ssh://zee@127.0.0.1:${sshPort}`;
    await q(`UPDATE zee SET viewer_kind='ssh-terminal', viewer_url=$2 WHERE id=$1`, [zee.id, viewerUrl]);
    logline('cage', `${name}: attend door open — ${viewerUrl}`);
  } catch (err) {
    await removeCage({ ctx, slug: xell.slug });
    const reason = `cage build failed: ${err.message}`;
    const dead = await one(`UPDATE zee SET status='errored', last_stop_reason=$2 WHERE id=$1 RETURNING *`, [zee.id, reason.slice(0, 200)]);
    broadcast('zee', dead);
    await releaseXell(xell.id);
    return { ok: false, zee_id: zee.id, xell_id: xell.id, error: reason };
  }

  // The briefing still binds the xell truthfully (containers, db, rules) — then the caged
  // addendum corrects the parts that are host-shaped: paths and docker access.
  const prompt = [
    await briefing(xell.id, zee, task, { headless }),
    '',
    '## You are CAGED (overrides anything above that conflicts)',
    '- Your workspace is /work/repo — a private clone of your branch. Host paths in the binding',
    '  (worktree_path and friends) refer to the same code from the outside; ignore them.',
    '- You have NO docker CLI. Where the binding says `docker exec … psql`, connect over TCP',
    '  instead: your assigned containers are reachable at the host:port pairs in the binding',
    '  (and via DATABASE_URL in /work/repo/.zeehive.env). Nothing else on the network resolves —',
    '  that is by design, not an outage.',
    '- Commit your work on your branch as you go. Your commits are collected from this container',
    '  when the job completes; nothing you do here can touch the host, other xells, or prod.',
    '',
    '## READ THE PROJECT MANUAL FIRST',
    '- You run `--bare`, which does NOT auto-load project memory — so open it yourself with the Read',
    '  tool before you design anything. Read `/work/repo/CLAUDE.md` if it exists; if not, read the',
    '  repo\'s top-level manual/handover instead (look for CLAUDE.md, AGENTS.md, HANDOFF.md or',
    '  README.md at /work/repo, and the memory files they reference). That, plus the docs it points',
    '  to, is how this repo actually works; guessing instead is how a zee wastes its whole turn.',
    '',
    '## YOUR QUEENZEE VERBS — how a caged zee lands/ships/goes-to-prod/finishes',
    'You are walled in: no docker, no host fs, no skills. The queenzee API is your ONLY door out, and',
    'it is authenticated as YOU by $ZEEHIVE_XELL_TOKEN (already in your env). Every "skill" a host zee',
    'has is ONE call here — and each one is only a REQUEST that lands on a HUMAN gate. You may know',
    'them all; none of them lets you act unilaterally. Use the `zee` CLI (on your PATH) — do not',
    'hand-roll curl:',
    '  - `zee status`               → where you stand: your task, and whether a land/ship/prod/done is pending a human.',
    '  - `zee land`                 → collect your commits out of the cage and run the gated push to main. HELD for a human.',
    '  - `zee ship --reason "..."`  → ask to deploy to prod (add `--targets server webapp`). Refused unless already landed; a human approves; the QUEENZEE builds from main.',
    '  - `zee prod --reason "..."`  → ASK to be bound to the prod database. Recorded only — a human confirms, then the cage is re-sealed to reach prod. Until then you cannot.',
    '  - `zee done --summary "..."` → propose your job is done. A human confirms with "Mark done"; THAT tears the cage down. Never try to despawn yourself.',
    'The FULL manual (every verb, its gate, the golden rules) is at `/work/repo/docs/caged-zee-manual.md` —',
    'Read it. Each verb maps to the same landgate/shipgate/prod/done a human drives from the console;',
    'nothing here is a bypass. Commit freely; you can only ever ASK to land, ship, bind-prod, or finish.',
  ].join('\n');

  let sid = null;
  let resolveInit;
  const initSeen = new Promise((res) => { resolveInit = res; });
  const feed = (ev) => {
    if (ev?.type === 'system' && ev.subtype === 'init') {
      sid = ev.session_id || ev.data?.session_id || null;
      resolveInit(ev);
      if (sid) {
        q(`UPDATE zee SET claude_session_id=$2, session_name=$2, status='working', attached_at=now() WHERE id=$1`, [zee.id, sid])
          .then(() => one(`SELECT * FROM zee WHERE id=$1`, [zee.id])).then((row) => broadcast('zee', row))
          .catch(() => {});
      }
    }
    if (ev?.type === 'assistant') {
      const blocks = ev.message?.content || [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text?.trim()) logline(`zee:${xell.slug}`, b.text.trim().slice(0, 300));
        if (b.type === 'tool_use') logline(`zee:${xell.slug}`, `[${b.name}] ${JSON.stringify(b.input || {}).slice(0, 160)}`);
      }
    }
    // the raw feed for a future per-zee pane — small envelope, full event
    broadcast('zee-output', { zee_id: zee.id, xell_id: xell.id, slug: xell.slug, event: ev });
  };

  const handle = runZee({ ctx, name, prompt, model, token, xellToken, onEvent: feed });

  // Report only what actually happened: await the init event (or an early death) before
  // claiming the spawn succeeded — same contract as the SDK path.
  try {
    await Promise.race([
      initSeen,
      handle.done, // resolves/rejects only on exit — an early death beats a 60s silence
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out waiting for the caged agent to start')), 60000)),
    ]);
  } catch (err) {
    await removeCage({ ctx, slug: xell.slug });
    const reason = `caged spawn failed: ${String(err.message).slice(0, 300)}`;
    const dead = await one(`UPDATE zee SET status='errored', last_stop_reason=$2 WHERE id=$1 RETURNING *`, [zee.id, reason.slice(0, 200)]);
    broadcast('zee', dead);
    await releaseXell(xell.id);
    return { ok: false, zee_id: zee.id, xell_id: xell.id, error: reason };
  }

  // Drive the rest in the background. The cage container is KEPT after the turn (idle, sealed)
  // so its commits can be collected (lib/cage.js exportCageDiff) — the reaper owns teardown.
  handle.done
    .then(async ({ result }) => {
      const cost = result?.total_cost_usd ?? 0;
      const errored = result?.is_error;
      await q(`UPDATE zee SET cost_usd=$2, status=$3, last_stop_reason=$4 WHERE id=$1`,
        [zee.id, cost, errored ? 'errored' : 'idle', errored ? String(result?.result || 'error').slice(0, 200) : 'end_turn']);
      const row = await one(`SELECT * FROM zee WHERE id=$1`, [zee.id]);
      broadcast('zee', row);
      logline('intake', `caged zee in ${xell.slug} finished (${errored ? 'errored' : 'ok'}, $${cost})`);
    })
    .catch(async (err) => {
      await q(`UPDATE zee SET status='errored', last_stop_reason=$2 WHERE id=$1`, [zee.id, String(err.message).slice(0, 200)]);
      logline('intake', `caged zee in ${xell.slug} died: ${String(err.message).slice(0, 160)}`);
    });

  return { ok: true, zee_id: zee.id, xell_id: xell.id, cage: name, session: sid,
           mode: m.key, permission_mode: 'bypassPermissions', caged: true };
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

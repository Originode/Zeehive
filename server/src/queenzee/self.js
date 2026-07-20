// THE CAGED-ZEE ↔ QUEENZEE WORKFLOW PROTOCOL — the verbs a CAGED zee calls to do everything a
// host-side zee does with skills. A caged zee runs `claude --bare` inside a per-xell container with
// no docker CLI, no host filesystem and no skills; the queenzee API is its ONLY door out of the
// cage. So every skill — orient, land, ship, bind-prod, done — is ONE authenticated call here.
//
// The shape is deliberate and uniform: the cage is the WALL, this API is the single narrow DOOR,
// and the human is the LOCK on it. Knowledge is not power — the zee may KNOW every verb, because
// each verb is only a REQUEST that lands on an existing human gate. Nothing here bypasses a gate;
// each function maps the calling xell onto the SAME landgate / shipgate / prod-bind / proposeDone
// path a host-side zee (or a human in the console) uses. The caller is always resolved from the
// per-xell token (routes.js), so a verb can only ever act on the xell that presented it.
import { q, one } from '../db/pool.js';
import { config } from '../config.js';
import { broadcast } from '../lib/events.js';
import { logline } from '../lib/logbus.js';
import { collectCageDiffToWorktree, sealCage, cageName } from '../lib/cage.js';
import { pushToXource, catchUpToXource } from './xellgit.js';
import { landStatus } from './landgate.js';
import { requestShip, shipStatus } from './shipgate.js';
import { proposeDone } from './tasks.js';
import { attachProdStack } from '../lib/xell-prod.js';
import { buildXell, getBuildStatus } from '../lib/build.js';
import { hiveStatus, hiveLabel } from '../lib/hive-status.js';
import { setTend, tendOpen, pingWorking } from '../lib/status.js';

const liveZee = (xellId) => one(
  `SELECT id, name, status, model FROM zee WHERE xell_id=$1
     AND status IN ('spawning','online','working','idle') ORDER BY created_at DESC LIMIT 1`, [xellId]);

// ── GET /api/xell/self/status — the read model a caged zee orients from ────────
// Everything it needs to know where it stands: its own status/task, whether a landing/ship/prod-bind
// is pending a human, its containers and db binding. No secrets (the token itself never appears).
export async function selfStatus(xell) {
  const zee = await liveZee(xell.id);
  const task = await one(`SELECT id, status, done_at, done_by FROM task WHERE xell_id=$1 ORDER BY created_at DESC LIMIT 1`, [xell.id]);
  const land = await landStatus(xell.id);
  const ship = await shipStatus(xell.id);
  const prodBind = await one(
    `SELECT id, status, reason, requested_at, decided_at, decided_by FROM prod_bind_request
       WHERE xell_id=$1 ORDER BY requested_at DESC LIMIT 1`, [xell.id]);
  const lock = await one(`SELECT container, phase FROM deploy_lock WHERE xell_id=$1`, [xell.id]);
  const containers = await q(
    `SELECT c.role, c.name, c.tier, host(c.host) AS host, c.host_port FROM xell_uses_container uc
       JOIN container c ON c.id = uc.container_id WHERE uc.xell_id=$1 ORDER BY c.role`, [xell.id]);
  const tend = await tendOpen(xell.id);
  // The DISPLAY status the hive shows for this xell — the same derivation the dashboard renders, so
  // a caged zee sees itself exactly as a human does (and can tell its tend/land/ship pings landed).
  const hive = hiveStatus(
    { ...xell, zee_status: zee?.status },
    {
      landPending: land ? ['pending', 'approved'].includes(land.status) : false,
      shipPending: ship ? ['pending', 'approved', 'shipping'].includes(ship.status) : false,
      tendPending: tend,
      prodUnprotected: xell.is_production && !!lock,
    },
  );
  return {
    xell: {
      id: xell.id, slug: xell.slug, branch: xell.branch, status: xell.status,
      hive_status: hive, hive_status_label: hiveLabel(hive),
      head_commit: xell.head_commit, db_coupling: xell.db_coupling,
      on_prod: xell.db_coupling === 'db-shared-prod',
    },
    tend: { open: tend },
    zee: zee || null,
    task: task ? { id: task.id, status: task.status, done: task.status === 'done' } : null,
    awaiting_done: xell.status === 'awaiting-done',
    landing: land
      ? { status: land.status, new_sha: land.new_sha, decided_by: land.decided_by, pending: land.status === 'pending' }
      : null,
    ship: ship
      ? { status: ship.status, commit: ship.commit, decided_by: ship.decided_by,
          pending: ['pending', 'approved', 'shipping'].includes(ship.status) }
      : null,
    prod_bind: prodBind
      ? { id: prodBind.id, status: prodBind.status, pending: prodBind.status === 'pending' }
      : null,
    holds_prod_lock: !!lock, prod_lock_phase: lock?.phase || null,
    containers,
  };
}

// ── POST /api/xell/self/land — collect the cage's commits, catch up, and run the gated push ──
// The missing piece for a caged zee: its commits live INSIDE the container, but the land gate pushes
// from the host worktree. So we (1) pull the cage's commits onto the worktree, (2) CATCH THE
// WORKTREE UP to the current xource tip — because the zee committed on top of master-as-it-was and
// master moved, so a raw push would be a non-fast-forward the gate silently drops — then (3) run the
// SAME gated `git push . HEAD:main` a host-side zee runs, HELD for a human. We never move main.
//
// And we REPORT THE REAL OUTCOME: `landed` (a human already approved this sha), `held` (a genuine
// pending land_request now exists — verified), or `needs-resolution` (couldn't catch up: a real
// conflict). Never "held" when nothing was actually raised — the fleet-burn-tracker lie.
export async function selfLand(xell) {
  if (!xell.worktree_path) return { ok: false, status: 'error', error: `${xell.slug} has no host worktree to land from` };

  // 1) COLLECT — best-effort: a missing docker/cage or an already-collected worktree is a no-op,
  // not a failure. Only a worktree that has DIVERGED from the cage is a real refusal.
  let collected;
  try {
    collected = await collectCageDiffToWorktree({ ctx: 'default', slug: xell.slug, worktree: xell.worktree_path });
  } catch (e) {
    if (/do not fast-forward/i.test(e.message)) return { ok: false, status: 'needs-resolution', stage: 'collect', error: e.message };
    collected = { collected: false, warning: `cage collection skipped: ${e.message}` };
    logline('self', `${xell.slug} land: cage collection skipped (${e.message})`);
  }

  // 2) CATCH UP to the current xource tip so an older-based commit still fast-forwards. A rebase
  // conflict is a real, honest stop — do NOT silently proceed to a doomed push.
  let caughtUp;
  try {
    caughtUp = await catchUpToXource(xell.id);
  } catch (e) {
    return { ok: false, status: 'needs-resolution', stage: 'catch-up', error: e.message, collected };
  }
  if (caughtUp.state === 'conflict' || caughtUp.state === 'no-head') {
    return {
      ok: false, status: 'needs-resolution', stage: 'catch-up', collected, catch_up: caughtUp,
      conflict: caughtUp.output || null,
      message: caughtUp.state === 'conflict'
        ? `Could not catch up to ${caughtUp.ref}: your commits CONFLICT with work that landed while you were `
          + 'running. Nothing was pushed and your branch is untouched. Pull the latest into your cage, resolve '
          + 'the conflict, commit, and `zee land` again.'
        : `Could not read HEAD in the worktree for ${xell.slug} — nothing to land.`,
    };
  }

  // 3) PUSH — the same gated `git push . HEAD:<ref>`. The landgate's update hook decides.
  const push = await pushToXource(xell.id, `zee@${xell.slug}`).catch((e) => ({ error: e.message }));
  if (push.error) return { ok: false, status: 'error', stage: 'push', error: push.error, collected, catch_up: caughtUp };

  // 4) REPORT THE REAL OUTCOME.
  const caughtNote = (caughtUp.state === 'merged' || caughtUp.state === 'rebased' || caughtUp.state === 'fast-forwarded')
    ? ` (after catching up to ${caughtUp.ref} — ${caughtUp.state})` : '';

  if (push.landed) {
    return {
      ok: true, status: 'landed', landed: true, collected, catch_up: caughtUp, request: await landStatus(xell.id),
      message: `LANDED on ${push.ref} @ ${String(push.head).slice(0, 8)} — a human had already approved this exact sha${caughtNote}.`,
    };
  }

  // Push was HELD → a pending land_request for THIS EXACT sha must now exist. Verify it before we
  // dare say "held" — the whole point of the fix is that the status can be trusted.
  const request = await landStatus(xell.id);
  const trulyHeld = request && request.status === 'pending' && request.new_sha === push.head;
  if (trulyHeld) {
    return {
      ok: true, status: 'held', landed: false, collected, catch_up: caughtUp, request,
      message: `Landing REQUESTED — your push is HELD at the gate for a human to approve in the ZEEHIVE console `
        + `(land_request ${String(request.id).slice(0, 8)}, sha ${String(push.head).slice(0, 8)})${caughtNote}. Your commits `
        + 'are safe on your branch; nothing lands until a human agrees. You do NOT need to re-run land: when a human '
        + 'approves, the queenzee lands it AND nudges you to continue. To block meanwhile, `zee land --wait` (or '
        + '`zee status --wait`) in the background — its exit is your nudge.',
    };
  }

  // Push did not land AND there is no fresh pending hold for this sha — this is NOT a clean held
  // landing, so do not pretend it is. Say what actually happened.
  return {
    ok: false, status: request ? request.status : 'unknown', landed: false, collected, catch_up: caughtUp,
    request: request || null,
    push_output: push.output ? String(push.output).slice(-800) : null,
    message: request
      ? (request.status === 'rejected'
        ? `A human REJECTED this exact sha (${String(request.new_sha).slice(0, 8)}) — re-pushing will not help; talk to them.`
        : `Push did not land and the latest land_request is '${request.status}' (sha ${String(request.new_sha).slice(0, 8)}), `
          + `not a fresh pending hold for ${String(push.head).slice(0, 8)}. Check the ZEEHIVE console — this is NOT a clean held landing.`)
      : 'Push did not land and NO land_request was raised — the gate held nothing (a non-fast-forward the catch-up '
        + 'did not resolve, or the gate is unreachable). This is a real failure, not a held landing.',
  };
}

// ── POST /api/xell/self/ship — file a ship request (shipgate) ──────────────────
// The zee only ASKS. requestShip refuses unless the work is already landed on main (the anti-band-aid
// rule), holds the request for a human, and the QUEENZEE deploys from main on approval. Identical to
// the host-side scripts/xell-ship.mjs path — this is just the caged entry to it.
export async function selfShip(xell, { targets = null, reason = null } = {}) {
  const zee = await liveZee(xell.id);
  return requestShip({ xellId: xell.id, zeeId: zee?.id || null, reason, targets });
}

// ── POST /api/xell/self/prod-request — ASK to bind this xell to the prod stack ──
// Records a REQUEST only. It does NOT bind: binding grants prod DATA, a human's call (HANDOFF). The
// human confirms in the console (decideProdBind), and ONLY then does the queenzee attachProdStack
// AND re-seal the cage firewall to allow the prod db. Until confirmed the cage cannot reach prod.
export async function selfProdRequest(xell, { reason = null } = {}) {
  const existing = await one(
    `SELECT * FROM prod_bind_request WHERE xell_id=$1 AND status='pending'`, [xell.id]);
  if (existing) return { ok: true, request: existing, note: 'you already have an open prod-bind request' };
  const zee = await liveZee(xell.id);
  const row = await one(
    `INSERT INTO prod_bind_request (project_id, xell_id, zee_id, reason) VALUES ($1,$2,$3,$4) RETURNING *`,
    [xell.project_id, xell.id, zee?.id || null, reason]);
  broadcast('prod-bind', row);
  broadcast('xell', { id: xell.id });
  logline('xell-prod', `${xell.slug} REQUESTED a prod bind — awaiting human confirmation${reason ? `: ${reason}` : ''}`);
  return {
    ok: true, request: row,
    message: 'Prod-bind REQUESTED — a human must CONFIRM it in the ZEEHIVE console. Until then your cage '
      + 'physically cannot reach prod (the firewall stays sealed). This grants the prod DATABASE only, not '
      + 'prod code — shipping code stays the ship gate (`zee ship`).',
  };
}

// ── HUMAN side: confirm/reject a prod-bind request (no zee path to this) ────────
export async function listProdBindRequests(projectId, { open = true } = {}) {
  const where = open ? `AND pbr.status = 'pending'` : '';
  return q(
    `SELECT pbr.*, x.slug AS xell_slug FROM prod_bind_request pbr
       JOIN xell x ON x.id = pbr.xell_id
      WHERE pbr.project_id=$1 ${where} ORDER BY pbr.requested_at DESC LIMIT 50`, [projectId]);
}

// The human decides. On CONFIRM: bind the prod stack (attachProdStack — the same call /xell-prod
// makes) AND re-seal the cage firewall so the cage can now reach the prod db host:port. Rejection is
// a plain status flip; nothing is bound and the cage stays sealed.
export async function decideProdBind(id, decision, by = 'human@console') {
  if (!['confirmed', 'rejected'].includes(decision)) throw new Error(`bad decision: ${decision}`);
  const row = await one(
    `UPDATE prod_bind_request SET status=$2, decided_at=now(), decided_by=$3
       WHERE id=$1 AND status='pending' RETURNING *`, [id, decision, by]);
  if (!row) throw new Error('no such pending prod-bind request (already decided?)');
  broadcast('prod-bind', row);
  if (decision !== 'confirmed') {
    logline('xell-prod', `prod-bind for ${row.xell_id} REJECTED by ${by}`);
    return row;
  }
  const bind = await attachProdStack(row.xell_id, { by });
  // Re-seal the cage so it can now reach the prod db (its stack just changed to include prod). A cage
  // that isn't running (a purely-host xell, or a torn-down cage) simply has no firewall to re-seal —
  // best-effort, recorded either way.
  const reseal = await resealCageForStack(row.xell_id).catch((e) => ({ error: e.message }));
  const done = await one(
    `UPDATE prod_bind_request SET result=$2::jsonb WHERE id=$1 RETURNING *`,
    [id, JSON.stringify({ bind, reseal })]);
  broadcast('prod-bind', done);
  logline('xell-prod', `prod-bind CONFIRMED by ${by} for ${bind.xell} — cage re-sealed (${reseal.error ? `reseal error: ${reseal.error}` : 'prod db now reachable'})`);
  return done;
}

// Re-seal the cage now that this xell is bound to prod: block every prod DB EXCEPT this xell's own
// project's — that one is now reachable, which is the whole point of the bind. Mirrors spawnCaged's
// block-list logic (default-allow egress, drop only prod DBs).
async function resealCageForStack(xellId) {
  const xell = await one(`SELECT slug, project_id FROM xell WHERE id=$1`, [xellId]);
  const prodDbs = await q(
    `SELECT DISTINCT host(c.host) AS host, c.host_port, c.project_id FROM container c
      WHERE c.tier='prod' AND c.role='db' AND c.host IS NOT NULL AND c.host_port IS NOT NULL`);
  const blockTcp = prodDbs
    .filter((r) => r.project_id !== xell.project_id) // this xell's prod DB is now allowed
    .map((r) => `${r.host}:${r.host_port}`);
  const sealed = await sealCage({ ctx: 'default', name: cageName(xell.slug), blockTcp });
  return { blockTcp, tail: sealed[sealed.length - 1] || null };
}

// ── POST /api/xell/self/done — propose done (the human confirms → teardown) ─────
// The zee never despawns itself. proposeDone flags the xell 'awaiting-done'; a human confirms with
// "Mark done" in the dashboard, and THAT is what reaps the cage (collecting its commits first).
export async function selfDone(xell, { summary = null } = {}) {
  return proposeDone({ xell_id: xell.id, note: summary });
}

// ── POST /api/xell/self/tend — raise (or clear) "I need a human in the console" ─
// A caged zee's ping for human attention that ISN'T a land/ship/done (a question, a stuck decision,
// a heads-up). Unlike those it opens no gate and blocks nothing — it just flags the xell so the hive
// shows `occ-tendRequest` and the human knows to look. `--clear` (or {clear:true}) lowers it; a zee
// that reports working again clears it automatically.
export async function selfTend(xell, { reason = null, clear = false } = {}) {
  const zee = await liveZee(xell.id);
  const res = await setTend(xell.id, !clear, { reason, zeeId: zee?.id || null });
  logline('self', `${xell.slug} ${clear ? 'CLEARED its tend' : 'raised a TEND'}${reason ? `: ${reason}` : ''}`);
  return {
    ok: true, ...res,
    message: clear
      ? 'Tend cleared — the hive no longer flags this xell for attention.'
      : 'Tend RAISED — the hive now shows this xell as needing a human (occ-tendRequest). Nothing is '
        + 'gated or blocked; a human will see it in the console. It clears when you `zee tend --clear` '
        + 'or report working (`zee working`).',
  };
}

// ── POST /api/xell/self/working — ping "I am actively working" ──────────────────
// Channel A (harness hooks) isn't installed for caged zees, so a cage can look idle to the passive
// poller even mid-task. This ping lets a zee assert live activity — the hive shows `occ-working` —
// and clears any open tend.
export async function selfWorking(xell, { note = null } = {}) {
  const zee = await liveZee(xell.id);
  if (!zee) return { ok: false, error: 'no live zee bound to this xell to mark working' };
  const res = await pingWorking(zee, { note });
  return { ok: true, ...res, message: 'Working ping recorded — the hive shows this xell as occ-working.' };
}

// ── POST /api/xell/self/build — (re)build THIS cage's own app tier ─────────────
// The verb a caged zee needs to run e2e tests against its OWN change. A host-side zee runs
// scripts/xell-build.mjs; a caged zee has no host fs and no docker, so that script is unreachable —
// this is its only door to a build. UNLIKE land/ship/prod/done it is NOT human-gated: building your
// own throwaway containers is the whole point of a xell, so it acts immediately.
//
// The catch a caged zee cannot see: its commits live INSIDE the cage, but buildXell compiles from
// the HOST worktree. So we first COLLECT the cage's committed diff onto the worktree (exactly like
// selfLand step 1) — otherwise the build would faithfully rebuild the OLD code and the zee would
// chase a change that never entered its container. Only COMMITTED cage work is collected (the bundle
// is commits, never the dirty tree), so a zee must commit before it builds.
export async function selfBuild(xell, { role = null, hot = false } = {}) {
  if (!xell.worktree_path) return { ok: false, error: `${xell.slug} has no host worktree to build from` };

  // COLLECT the cage's commits so the build includes the zee's code. A --hot bounce reuses the
  // existing image and picks up NO code, so collecting for it is pointless — skip it. Best-effort
  // otherwise: an already-collected worktree or an unreachable cage is a harmless no-op, but a real
  // divergence (the worktree moved since caging) is an honest stop, exactly as landing treats it.
  let collected = null;
  if (!hot) {
    try {
      collected = await collectCageDiffToWorktree({ ctx: 'default', slug: xell.slug, worktree: xell.worktree_path });
    } catch (e) {
      if (/do not fast-forward/i.test(e.message)) {
        return {
          ok: false, status: 'needs-resolution', stage: 'collect', error: e.message,
          message: `Could not pull your cage's commits onto the worktree to build from — it diverged since caging. `
            + 'Nothing was built and your branch is untouched. Pull the latest into your cage, resolve, commit, '
            + 'and `zee build` again.',
        };
      }
      collected = { collected: false, warning: `cage collection skipped: ${e.message}` };
      logline('self', `${xell.slug} build: cage collection skipped (${e.message})`);
    }
  }

  let started;
  try { started = await buildXell(xell.id, { hot, role }); }
  catch (e) { return { ok: false, error: e.message, collected }; }

  const roleLabel = role || 'server + webapp';
  const from = collected?.collected ? `collected HEAD ${String(collected.head).slice(0, 8)}` : 'your worktree';
  return {
    ok: true, hot, role: role || 'all', collected, started,
    message: `${hot ? 'HOT build' : 'Build'} started for ${roleLabel} from ${from} — running in the background on `
      + 'the queenzee (this call does NOT block). To find out when it settles and whether the container is '
      + `actually serving your HEAD, run \`zee build ${role || ''} --wait\` (or --watch) in the BACKGROUND — its `
      + `exit is your nudge.${hot ? ' NOTE: --hot reused the old image, so it does NOT contain code changes.' : ''}`,
  };
}

// ── GET /api/xell/self/build/status — is this cage's stack built from its HEAD? ─
// Read-only. What `zee build --wait/--watch` polls: per-container health + serving_head, measured
// against the worktree HEAD (the commit the last collect fast-forwarded it to). Starts no build and
// collects nothing — safe to poll on a tight loop.
export async function selfBuildStatus(xell) {
  return getBuildStatus(xell.id);
}

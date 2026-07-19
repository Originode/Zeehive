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
import { pushToXource } from './xellgit.js';
import { landStatus } from './landgate.js';
import { requestShip, shipStatus } from './shipgate.js';
import { proposeDone } from './tasks.js';
import { attachProdStack } from '../lib/xell-prod.js';

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
  return {
    xell: {
      id: xell.id, slug: xell.slug, branch: xell.branch, status: xell.status,
      head_commit: xell.head_commit, db_coupling: xell.db_coupling,
      on_prod: xell.db_coupling === 'db-shared-prod',
    },
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

// ── POST /api/xell/self/land — collect the cage's commits and run the gated push ──
// The missing piece for a caged zee: its commits live INSIDE the container, but the land gate pushes
// from the host worktree. So we pull the cage's commits onto the worktree (collectCageDiffToWorktree)
// and then run the SAME gated `git push . HEAD:main` (pushToXource) a host-side zee runs — which
// trips the land gate and is HELD for a human. We never move main ourselves.
export async function selfLand(xell) {
  if (!xell.worktree_path) return { ok: false, error: `${xell.slug} has no host worktree to land from` };
  // Collect is best-effort: if the queenzee cannot reach the cage (or it made no new commits) we
  // still push whatever the worktree already has — the gate, not this step, is the decision point.
  let collected;
  try {
    collected = await collectCageDiffToWorktree({ ctx: 'default', slug: xell.slug, worktree: xell.worktree_path });
  } catch (e) {
    // A DIVERGED worktree is a real refusal (surface it); a missing docker/cage is just "nothing to
    // collect" and must not block the push.
    if (/do not fast-forward/i.test(e.message)) return { ok: false, stage: 'collect', error: e.message };
    collected = { collected: false, warning: `cage collection skipped: ${e.message}` };
    logline('self', `${xell.slug} land: cage collection skipped (${e.message})`);
  }

  const push = await pushToXource(xell.id, `zee@${xell.slug}`).catch((e) => ({ error: e.message }));
  if (push.error) return { ok: false, stage: 'push', error: push.error, collected };

  const request = await landStatus(xell.id);
  return {
    ok: true,
    collected,
    landed: !!push.landed,
    request: request || null,
    message: push.landed
      ? `LANDED on ${push.ref} @ ${String(push.head).slice(0, 8)} — a human had already approved this exact sha.`
      : 'Landing REQUESTED — your push is HELD at the gate for a human to approve in the ZEEHIVE console. '
        + 'Your commits are safe on your branch; nothing lands until a human agrees. Re-run `zee land` '
        + 'after approval (or poll `zee status`).',
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

// Recompute the cage's egress allow-list from the xell's CURRENT containers (now including prod) and
// re-run the firewall seal. Mirrors the seal in spawnCaged, just with the post-bind stack.
async function resealCageForStack(xellId) {
  const xell = await one(`SELECT slug FROM xell WHERE id=$1`, [xellId]);
  const stack = await q(
    `SELECT host(c.host) AS host, c.host_port FROM xell_uses_container uc JOIN container c ON c.id=uc.container_id
      WHERE uc.xell_id=$1 AND c.host IS NOT NULL AND c.host_port IS NOT NULL`, [xellId]);
  const allowTcp = stack.map((r) => `${r.host}:${r.host_port}`);
  const sealed = await sealCage({
    ctx: 'default', name: cageName(xell.slug),
    queenzee: `host.docker.internal:${config.port}`, allowTcp,
  });
  return { allowTcp, tail: sealed[sealed.length - 1] || null };
}

// ── POST /api/xell/self/done — propose done (the human confirms → teardown) ─────
// The zee never despawns itself. proposeDone flags the xell 'awaiting-done'; a human confirms with
// "Mark done" in the dashboard, and THAT is what reaps the cage (collecting its commits first).
export async function selfDone(xell, { summary = null } = {}) {
  return proposeDone({ xell_id: xell.id, note: summary });
}

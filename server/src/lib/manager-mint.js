// THE MANAGER-MINT GATE — a ROUTER asking a human for another manager (migration 149).
//
// A manager zee has never been something an agent could create, and that has not changed here.
// lib/manager-spawn.js says why in one line — "a manager that could mint managers is a fleet that
// grows sideways with nobody's consent" — and `zee dispatch` refuses a manager harness outright.
// What this module adds is the ASK, for exactly one kind of agent and with a human on the other end:
//
//   router  → files a REQUEST (`zee mint-manager --reason "…" --task "…"`)
//   human   → approves or rejects it in the console
//   queenzee→ runs createManagerZee ITSELF on approval — the same function the console's own
//             "Add manager" button calls, with the same read-only prod bind and type stamp.
//
// So the authority boundary is untouched: no code path here lets an agent produce a manager, and an
// approval is a human calling the human path. The router's reach grows by one sentence — "may I?" —
// and nothing else.
//
// WHY THE ROUTER AND NOT EVERY MANAGER. The router is the project's front door: it is the only zee
// that sees a raw human prompt before anyone has sized it, so it is the only one positioned to say
// "this is a programme, not a task". A crew-running manager that wants more hands already has the
// verb for it (`zee assign`), and a manager asking for a peer manager is a fleet growing sideways by
// a different road. The refusal is by ROUTER-ness (lib/router.js isRouterXell, the harness chain),
// not by key, so a project's own router persona descending from `router` asks with the same verb.
//
// Shaped deliberately like lib/xource-clean.js (111): one open request per asking xell, dismissal is
// view-only, the result rides on the row as a receipt, and the queenzee does the privileged part.
import { q, one } from '../db/pool.js';
import { broadcast } from './events.js';
import { logline } from './logbus.js';

// ── the ROUTER's side ────────────────────────────────────────────────────────
//
// The caller (queenzee/self.js) has already established that this xell is a router; this function
// owns the shape of the ask itself: a reason is mandatory (it is the whole of what a human reads),
// and a second open request is refused rather than stacked — the same "one card per zee" rule the
// landing gate learned the hard way.
export async function requestManagerMint({ xellId, zeeId = null, reason = null, task = null,
                                           harnessKey = null, title = null } = {}) {
  if (!xellId) throw new Error('no asking xell');
  const xell = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
  if (!xell) throw new Error('unknown xell');
  const project = await one(`SELECT * FROM project WHERE id=$1`, [xell.project_id]);
  if (!project) throw new Error('unknown project');

  const why = String(reason || '').trim();
  if (!why) {
    return { ok: false, status: 'refused', request: null, error:
      'a manager-mint request needs --reason "…": say why one well-briefed worker will NOT do. It is the '
      + 'whole of what a human reads before deciding, and "this is big" is not a reason — name the strands, '
      + 'what blocks what, and why the work outlives one cage.' };
  }

  const existing = await one(
    `SELECT * FROM manager_mint_request WHERE xell_id=$1 AND status='pending'`, [xellId]);
  if (existing) {
    return { ok: true, request: existing, note:
      'you already have an open manager-mint request — a human must decide it before you can file '
      + 'another (`zee mint-manager --withdraw` un-asks it).' };
  }

  // A named harness must exist and must be a MANAGER persona: a request that would fail at mint time
  // is refused now, while the router can still act on the answer, rather than after a human has
  // approved something the spawn then declines.
  const key = String(harnessKey || '').trim().toLowerCase() || null;
  if (key) {
    const h = await one(`SELECT key, zee_type, project_id FROM harness WHERE key=$1 AND enabled`, [key]);
    if (!h) {
      return { ok: false, status: 'refused', request: null, error:
        `no enabled harness "${key}" — omit --harness for the fleet's own \`manager\` persona.` };
    }
    if (h.zee_type !== 'manager') {
      return { ok: false, status: 'refused', request: null, error:
        `"${key}" is a ${h.zee_type} persona, and a manager xell wears a MANAGER one. Name a manager `
        + 'harness, or omit --harness for `manager`.' };
    }
    if (h.project_id && String(h.project_id) !== String(project.id)) {
      return { ok: false, status: 'refused', request: null, error:
        `"${key}" belongs to another project — a project-scoped persona is visible to its own project only.` };
    }
  }

  const row = await one(
    `INSERT INTO manager_mint_request (project_id, xell_id, zee_id, reason, task, harness_key, title)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [project.id, xellId, zeeId, why, task ? String(task).trim() : null, key, title || null]);
  broadcast('manager-mint', row);
  broadcast('xell', { id: xellId });
  logline('manager-mint',
    `HELD manager-mint request from ${xell.slug} — ${why.replace(/\s+/g, ' ').slice(0, 140)}`);
  return {
    ok: true, request: row,
    message: 'Manager-mint REQUESTED — a human must approve it in the ZEEHIVE console (your hexagon now '
      + 'shows `manager?`). On approval the QUEENZEE mints the manager itself: a xell, the manager type '
      + 'stamp, a read-only production role and the manager persona. You spawn nothing, and the new '
      + 'manager is a peer rather than your crew. Keep routing meanwhile — a rejection usually means '
      + '"dispatch a worker", which you can do straight away.',
  };
}

// The asking router's own read (`zee status` → manager_mint, `zee mint-manager --status`).
export async function managerMintStatusFor(xellId) {
  if (!xellId) return null;
  return one(
    `SELECT m.*, x.slug AS created_slug
       FROM manager_mint_request m
       LEFT JOIN xell x ON x.id = m.created_xell_id
      WHERE m.xell_id=$1 ORDER BY m.requested_at DESC LIMIT 1`, [xellId]);
}

// UN-ASK. Exactly `zee land --withdraw`'s meaning: nothing is created, nothing is rejected, the card
// simply leaves the human's screen. Only a PENDING request can be withdrawn — an approved one is a
// human's decision and is not the agent's to retract.
export async function withdrawManagerMint({ xellId, id = null, reason = null } = {}) {
  const row = await one(
    `UPDATE manager_mint_request SET status='withdrawn', finished_at=now(),
            result = COALESCE(result,'{}'::jsonb) || jsonb_build_object('withdraw_reason', $3::text)
      WHERE status='pending' AND ($2::uuid IS NULL OR id=$2) AND xell_id=$1 RETURNING *`,
    [xellId, id, reason || null]);
  if (!row) return { ok: true, withdrawn: false, note: 'you have no open manager-mint request to withdraw' };
  broadcast('manager-mint', row);
  broadcast('xell', { id: xellId });
  logline('manager-mint', `manager-mint request ${String(row.id).slice(0, 8)} WITHDRAWN by the router`);
  return { ok: true, withdrawn: true, request: row,
    message: 'Withdrawn — the card is off the human\'s screen. Nothing was minted and nothing rejected.' };
}

// ── the HUMAN's side ─────────────────────────────────────────────────────────
export async function listManagerMintRequests(projectId, { open = true } = {}) {
  const where = open
    ? `AND (m.status = ANY($2) OR (m.status IN ('created','failed')
             AND COALESCE(m.finished_at, m.decided_at, m.requested_at) > now() - interval '15 minutes'))`
    : '';
  const args = open ? [projectId, ['pending', 'approved']] : [projectId];
  return q(
    `SELECT m.*, x.slug AS live_xell_slug, c.slug AS created_slug
       FROM manager_mint_request m
       LEFT JOIN xell x ON x.id = m.xell_id
       LEFT JOIN xell c ON c.id = m.created_xell_id
      WHERE m.project_id=$1 AND m.dismissed_at IS NULL ${where}
      ORDER BY m.requested_at DESC LIMIT 50`, args);
}

// "Seen it — stop showing me." View-only, like every other dismiss in the console.
export async function dismissManagerMint(id, by = 'human@console') {
  const row = await one(
    `UPDATE manager_mint_request SET dismissed_at=now(), dismissed_by=$2 WHERE id=$1 RETURNING *`, [id, by]);
  if (!row) throw new Error('no such manager-mint request');
  broadcast('manager-mint', row);
  return row;
}

// THE HUMAN'S DECISION. Approve → the queenzee mints the manager inline and the row becomes the
// receipt (which xell it produced). Reject → the row closes and the router is told, so it can
// dispatch a worker instead.
export async function decideManagerMint(id, decision, by = 'human@console', { note = null } = {}) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error(`bad decision: ${decision}`);
  const row = await one(
    `UPDATE manager_mint_request SET status=$2, decided_at=now(), decided_by=$3,
            result = COALESCE(result,'{}'::jsonb) || jsonb_build_object('note', $4::text)
      WHERE id=$1 AND status='pending' RETURNING *`, [id, decision, by, note]);
  if (!row) throw new Error('no such pending manager-mint request (already decided?)');
  broadcast('manager-mint', row);
  if (row.xell_id) broadcast('xell', { id: row.xell_id });
  if (decision === 'rejected') {
    logline('manager-mint', `manager-mint request ${String(id).slice(0, 8)} REJECTED by ${by}`);
    return row;
  }
  return runManagerMint(id, { by });
}

// Execute an approved mint. Deliberately the SAME call the console's own "Add manager" button makes
// (lib/manager-spawn.js createManagerZee) — a human approving a request must get exactly what a
// human clicking the button gets, or this gate is a second, weaker way to add a manager.
export async function runManagerMint(id, { by = 'human@console' } = {}) {
  const row = await one(
    `UPDATE manager_mint_request SET status='approved'
      WHERE id=$1 AND status IN ('approved','pending') RETURNING *`, [id]);
  if (!row) throw new Error('no such approved manager-mint request');
  broadcast('manager-mint', row);

  const project = await one(`SELECT * FROM project WHERE id=$1`, [row.project_id]);
  if (!project) return fail(id, 'project row missing');

  try {
    const { createManagerZee } = await import('./manager-spawn.js');
    const out = await createManagerZee({
      project: project.id,
      task: row.task || undefined,
      title: row.title || 'manager zee (minted on a router request)',
      harness: row.harness_key || 'manager',
    });
    const done = await one(
      `UPDATE manager_mint_request SET status='created', finished_at=now(),
              created_xell_id=$2, result = COALESCE(result,'{}'::jsonb) || $3::jsonb
        WHERE id=$1 RETURNING *`,
      [id, out?.xell_id || null, JSON.stringify({ ok: true, slug: out?.slug || null, by })]);
    broadcast('manager-mint', done);
    if (row.xell_id) broadcast('xell', { id: row.xell_id });
    logline('manager-mint',
      `MANAGER MINTED on ${out?.slug || '?'} by ${by} — requested by ${String(row.xell_id || '').slice(0, 8)}`);
    return done;
  } catch (e) {
    // A mint that fails half-way (a dry pool, no provider account, a prod reader that would not
    // mint) must land on the row rather than in a log nobody reads: the human clicked approve and
    // is owed the outcome.
    return fail(id, e.message, row.xell_id);
  }
}

async function fail(id, error, xellId = null) {
  const failed = await one(
    `UPDATE manager_mint_request SET status='failed', finished_at=now(),
            result = COALESCE(result,'{}'::jsonb) || jsonb_build_object('ok', false, 'error', $2::text)
      WHERE id=$1 RETURNING *`, [id, String(error).slice(0, 500)]);
  if (failed) broadcast('manager-mint', failed);
  if (xellId) broadcast('xell', { id: xellId });
  logline('manager-mint', `manager-mint ${String(id).slice(0, 8)} FAILED: ${String(error).slice(0, 200)}`);
  return failed;
}

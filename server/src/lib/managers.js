// MANAGER ZEES — the fleet's middle layer.
//
// A manager zee is an ordinary xell (`xell.zee_type='manager'`) whose zee coordinates OTHER zees instead
// of writing code. Everything it can do is still a queenzee verb behind the same walls; what changes
// is WHICH verbs, and that split is the whole design:
//
//   GAINS (fleet reach)                          LOSES (repo reach)
//   ─────────────────────────────────            ─────────────────────────────
//   dispatch workers (stamped as its crew)       zero push/PR access to the xource — `zee land`,
//   converse with them in real time              xellgit push/PR and the landgate's git hook all
//   read PRODUCTION (read-only role)             REFUSE a manager outright, and the landgate raises
//   suggest a xell is done (human confirms)      no request, so there is nothing to approve either
//
// SHIPPING IS NOT BLOCKED. Holding the production database is not a reason to withhold the ship
// gate: a ship is still landed-only, human-approved and queenzee-executed. A manager is often the
// right agent to ask for one — it is the one holding the whole picture.
//
// This module owns the manager's DOMAIN (who manages whom, the crew read model, the messages, the
// done suggestions). The verbs that expose it live in queenzee/self.js; the human side lives in
// api/routes.js. Nothing here despawns anything or moves a ref.
import { q, one } from '../db/pool.js';
import { broadcast } from './events.js';
import { logline } from './logbus.js';
import { hiveStatus, hiveLabel } from './hive-status.js';
import { sendMessageToXell } from '../queenzee/nudge.js';

// ── who is what ──────────────────────────────────────────────────────────────
export const isManager = (xell) => xell?.zee_type === 'manager';

// The single sentence every refusal shares. Written once so the manager reads the SAME explanation
// wherever it hits the wall — a manager that gets three different stories about why it cannot push
// will keep trying the third one.
export const NO_PUSH_REASON =
  'a MANAGER zee has zero push/PR access to the xource — it writes no code and lands none. This is '
  + 'refused by the queenzee itself (the landgate declines a manager push without even raising a '
  + 'request, so there is no approval that could let it through). If something must change in the '
  + 'repo, dispatch a worker to make it: `zee dispatch --task "…"`.';

// Refuse an action for a manager xell, uniformly. Returns null when the xell is a worker (carry on).
export function refuseForManager(xell, verb) {
  if (!isManager(xell)) return null;
  return { ok: false, status: 'refused', refused: verb, error: NO_PUSH_REASON };
}

// ── the crew ─────────────────────────────────────────────────────────────────
// Every worker this manager dispatched, with the live signals a manager actually decides on: what
// the hive shows, whether it is waiting on a human, and its git position (unlanded work is the one
// thing that must not be reaped). One query + one per-row signal query — this is polled by an agent,
// not rendered at 60fps, so clarity beats cleverness.
export async function crewFor(managerXellId) {
  const rows = await q(
    `SELECT x.id, x.slug, x.branch, x.status, x.head_commit, x.created_at, x.db_coupling,
            z.status AS zee_status, z.cli_active, z.title AS zee_title, z.model,
            t.prompt_text AS task_text,
            EXISTS(SELECT 1 FROM land_request lr WHERE lr.xell_id=x.id
                     AND lr.status IN ('pending','approved') AND lr.dismissed_at IS NULL) AS land_pending,
            EXISTS(SELECT 1 FROM ship_request sr WHERE sr.xell_id=x.id
                     AND sr.status IN ('pending','approved','shipping') AND sr.dismissed_at IS NULL
                     AND sr.deferred_at IS NULL) AS ship_pending,
            EXISTS(SELECT 1 FROM prod_bind_request pbr WHERE pbr.xell_id=x.id AND pbr.status='pending') AS prod_bind_pending,
            EXISTS(SELECT 1 FROM prod_seed_request psr WHERE psr.xell_id=x.id
                     AND psr.status IN ('pending','approved','running') AND psr.dismissed_at IS NULL) AS seed_pending,
            (SELECT se.hook_event_name FROM session_event se
               WHERE se.xell_id=x.id AND se.hook_event_name IN ('tend-request','tend-clear')
               ORDER BY se.ts DESC LIMIT 1) = 'tend-request' AS tend_pending,
            EXISTS(SELECT 1 FROM done_suggestion ds WHERE ds.target_xell_id=x.id
                     AND ds.status='pending' AND ds.dismissed_at IS NULL) AS done_suggested,
            (SELECT zm.body FROM zee_message zm WHERE zm.from_xell_id=x.id AND zm.to_xell_id=$1
               ORDER BY zm.created_at DESC LIMIT 1) AS last_message,
            (SELECT zm.created_at FROM zee_message zm WHERE zm.from_xell_id=x.id AND zm.to_xell_id=$1
               ORDER BY zm.created_at DESC LIMIT 1) AS last_message_at
       FROM xell x
       LEFT JOIN LATERAL (
         SELECT * FROM zee zz WHERE zz.xell_id = x.id
          ORDER BY CASE WHEN zz.status IN ('spawning','online','working','idle') THEN 0 ELSE 1 END,
                   zz.created_at DESC LIMIT 1) z ON true
       LEFT JOIN LATERAL (
         SELECT * FROM task tt WHERE tt.xell_id = x.id ORDER BY tt.created_at DESC LIMIT 1) t ON true
      WHERE x.manager_xell_id = $1 AND x.status <> 'retired'
      ORDER BY x.created_at`, [managerXellId]);

  return rows.map((r) => {
    const hive = hiveStatus(
      { ...r, is_production: false },
      { landPending: r.land_pending, shipPending: r.ship_pending, tendPending: r.tend_pending,
        prodBindPending: r.prod_bind_pending, seedPending: r.seed_pending,
        doneSuggested: r.done_suggested },
    );
    const waiting = [
      r.land_pending && 'a landing is HELD for a human',
      r.ship_pending && 'a ship is awaiting a human',
      r.prod_bind_pending && 'it asked for the PROD database',
      r.seed_pending && 'it asked for production to be SEEDED',
      r.tend_pending && 'it raised a TEND (needs a human)',
      r.status === 'awaiting-done' && 'it proposed DONE (a human must confirm)',
      r.done_suggested && 'you already suggested it is done (awaiting a human)',
    ].filter(Boolean);
    return {
      xell_id: r.id, slug: r.slug, branch: r.branch, status: r.status,
      hive_status: hive, hive_status_label: hiveLabel(hive),
      zee_status: r.zee_status || null, working: r.cli_active === true || r.zee_status === 'working',
      model: r.model || null, title: r.zee_title || null,
      task: r.task_text ? String(r.task_text).split('\n')[0].slice(0, 160) : null,
      head_commit: r.head_commit || null,
      waiting_on_human: waiting,
      last_message: r.last_message ? String(r.last_message).slice(0, 300) : null,
      last_message_at: r.last_message_at || null,
    };
  });
}

// Resolve one of MY workers by slug or id. Refusing to resolve a stranger is what keeps a manager
// scoped to its own crew — there is no verb here that can name a xell it did not dispatch.
export async function workerOf(managerXellId, slugOrId) {
  const key = String(slugOrId || '').trim();
  if (!key) return null;
  const byId = /^[0-9a-f-]{36}$/i.test(key);
  return one(
    `SELECT * FROM xell WHERE manager_xell_id=$1 AND status <> 'retired' AND ${byId ? 'id::text' : 'slug'}=$2`,
    [managerXellId, key]);
}

// ── messages (manager ⇄ worker) ──────────────────────────────────────────────
// STORE, then DELIVER. The row is the durable inbox (a worker mid-turn, or asleep, still finds it);
// delivery types the text into the recipient's live cxell session so a conversation actually happens
// where the agent — and any watching human — is looking. Delivery failure is recorded, never thrown:
// an undelivered message is still a message, and pretending otherwise loses it.
export async function postMessage({ from, to, body, kind = 'message', by = null, deliver = true }) {
  const text = String(body || '').trim();
  if (!text) throw new Error('a message needs a body');
  const row = await one(
    `INSERT INTO zee_message (project_id, from_xell_id, from_slug, to_xell_id, to_slug, kind, body, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`,
    [from?.project_id || to?.project_id, from?.id || null, from?.slug || by || 'queenzee',
     to?.id || null, to?.slug || null, kind, text.slice(0, 20000),
     JSON.stringify({ by: by || from?.slug || 'queenzee' })]);

  let delivery = { sent: false, reason: 'delivery not attempted' };
  if (deliver && to?.id) {
    const prefix = kind === 'reflection'
      ? `🪞 REFLECTION from ${from?.slug || 'a worker'}`
      : kind === 'directive' ? `🐝 MANAGER ${from?.slug || ''}`
      : `✉ ${from?.slug || 'zee'}`;
    delivery = await sendMessageToXell(to.id, { text: `${prefix}: ${text}`, by: from?.slug || 'queenzee' });
  }
  const done = await one(
    `UPDATE zee_message SET delivered=$2, delivery=$3::jsonb WHERE id=$1 RETURNING *`,
    [row.id, !!delivery.sent, JSON.stringify(delivery)]);
  broadcast('zee-message', { id: done.id, to_xell_id: done.to_xell_id, from_xell_id: done.from_xell_id, kind });
  logline('crew', `${done.from_slug || '?'} → ${done.to_slug || 'console'} (${kind}): `
    + `${text.replace(/\s+/g, ' ').slice(0, 120)}${delivery.sent ? '' : ` [not delivered: ${delivery.reason || delivery.error || '—'}]`}`);
  return { ok: true, message: done, delivered: !!delivery.sent, delivery };
}

// This xell's inbox. Unread by default (an agent polling its own inbox wants what it has not seen);
// `all` returns the recent history. Reading MARKS READ — the read model and the receipt are the same
// call on purpose, so a message cannot be "delivered, seen, and still nagging".
export async function inboxFor(xellId, { all = false, limit = 50 } = {}) {
  const rows = await q(
    `SELECT * FROM zee_message WHERE to_xell_id=$1 ${all ? '' : 'AND read_at IS NULL'}
      ORDER BY created_at DESC LIMIT $2`, [xellId, Math.min(200, Math.max(1, limit))]);
  const unread = rows.filter((r) => !r.read_at).map((r) => r.id);
  if (unread.length) await q(`UPDATE zee_message SET read_at=now() WHERE id = ANY($1::uuid[])`, [unread]);
  return rows.map((r) => ({
    id: r.id, from: r.from_slug, kind: r.kind, body: r.body,
    at: r.created_at, was_unread: unread.includes(r.id),
  }));
}

// ── done suggestions (a manager proposes SOMEONE ELSE is finished) ───────────
// Deliberately not `zee done`: that is a zee proposing its own completion. This proposes another
// xell's, so it can never be self-serviceable — it raises a card and a `done?` prompt, and a HUMAN
// confirms (with a typed confirmation in the console). The queenzee does the marking.
export async function suggestDone({ manager, target, reason = null }) {
  if (!manager || !target) throw new Error('suggest-done needs a manager and a target xell');
  if (manager.id === target.id) {
    throw new Error('a manager cannot suggest ITSELF done — use `zee done --summary "…"` for your own job');
  }
  const open = await one(
    `SELECT * FROM done_suggestion WHERE target_xell_id=$1 AND status='pending' AND dismissed_at IS NULL`,
    [target.id]);
  if (open) return { ok: true, suggestion: open, note: 'a done suggestion for that xell is already awaiting a human' };
  const row = await one(
    `INSERT INTO done_suggestion (project_id, manager_xell_id, manager_slug, target_xell_id, target_slug, reason)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [target.project_id, manager.id, manager.slug, target.id, target.slug, reason]);
  broadcast('done-suggestion', row);
  broadcast('xell', { id: target.id });
  logline('crew', `${manager.slug} SUGGESTS ${target.slug} is done — awaiting human confirmation${reason ? `: ${reason}` : ''}`);
  return {
    ok: true, suggestion: row,
    message: `Suggested that ${target.slug} is done. A HUMAN must confirm it in the console (the xell now `
      + 'shows `done?`), and their confirmation is what marks the task done and tears the cxell down — '
      + 'you cannot do that yourself, and you cannot approve your own suggestion. Its commits are '
      + 'collected first; if it still has unlanded work, tell it to `zee land` before this is confirmed.',
  };
}

export async function listDoneSuggestions(projectId, { open = true } = {}) {
  return q(
    `SELECT ds.*, x.slug AS live_target_slug, x.status AS target_status,
            m.slug AS live_manager_slug
       FROM done_suggestion ds
       LEFT JOIN xell x ON x.id = ds.target_xell_id
       LEFT JOIN xell m ON m.id = ds.manager_xell_id
      WHERE ds.project_id=$1 AND ds.dismissed_at IS NULL
        ${open ? `AND ds.status='pending'` : ''}
      ORDER BY ds.requested_at DESC LIMIT 50`, [projectId]);
}

export async function dismissDoneSuggestion(id, by = 'human@console') {
  const row = await one(
    `UPDATE done_suggestion SET dismissed_at=now(), decided_by=COALESCE(decided_by,$2) WHERE id=$1 RETURNING *`,
    [id, by]);
  broadcast('done-suggestion', row);
  return row;
}

// The HUMAN's decision on a done suggestion. Approve → the queenzee marks the xell's task done and
// reaps it, exactly as the console's own "Mark done" does (same function, same reap, same commit
// collection). Reject → the manager is told, and nothing happens to the xell.
//
// tasks.js is imported lazily: it reaches back into provisioning/reaping, and a top-level import
// here would make lib ↔ queenzee circular for a call that runs once per human click.
export async function decideDoneSuggestion(id, decision, by = 'human@console', { force = false } = {}) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error(`bad decision: ${decision}`);
  const row = await one(
    `UPDATE done_suggestion SET status=$2, decided_at=now(), decided_by=$3
       WHERE id=$1 AND status='pending' RETURNING *`, [id, decision, by]);
  if (!row) throw new Error('no such pending done suggestion (already decided?)');
  broadcast('done-suggestion', row);

  const manager = row.manager_xell_id ? await one(`SELECT * FROM xell WHERE id=$1`, [row.manager_xell_id]) : null;
  const target = row.target_xell_id ? await one(`SELECT * FROM xell WHERE id=$1`, [row.target_xell_id]) : null;

  if (decision === 'rejected') {
    logline('crew', `done suggestion for ${row.target_slug} REJECTED by ${by}`);
    if (manager) {
      await postMessage({ from: null, to: manager, kind: 'report', by,
        body: `A human REJECTED your suggestion that ${row.target_slug} is done. It keeps working — `
          + 'ask it what remains, or re-scope its task.' }).catch(() => {});
    }
    return row;
  }

  if (!target) {
    const gone = await one(`UPDATE done_suggestion SET status='failed', result=$2::jsonb WHERE id=$1 RETURNING *`,
      [id, JSON.stringify({ error: 'the target xell no longer exists' })]);
    return gone;
  }

  const { markTaskDone } = await import('../queenzee/tasks.js');
  const task = await one(
    `SELECT id FROM task WHERE xell_id=$1 ORDER BY created_at DESC LIMIT 1`, [target.id]);
  let result;
  try {
    if (task) {
      result = await markTaskDone(task.id, by, { force });
      if (result?.blocked) {
        const held = await one(`UPDATE done_suggestion SET status='failed', result=$2::jsonb WHERE id=$1 RETURNING *`,
          [id, JSON.stringify(result)]);
        broadcast('done-suggestion', held);
        return held;
      }
    } else {
      // A xell with no task row (a bare dispatch) is reaped directly — the same path the console's
      // "Mark done" takes for one, so a manager's suggestion can never end in a xell nobody can close.
      const { reapXell } = await import('../queenzee/reaper.js');
      result = { reap: await reapXell(target.id, 'done-suggestion', { force }) };
      if (result.reap?.ok === false) {
        const held = await one(`UPDATE done_suggestion SET status='failed', result=$2::jsonb WHERE id=$1 RETURNING *`,
          [id, JSON.stringify(result)]);
        broadcast('done-suggestion', held);
        return held;
      }
    }
  } catch (e) {
    const failed = await one(`UPDATE done_suggestion SET status='failed', result=$2::jsonb WHERE id=$1 RETURNING *`,
      [id, JSON.stringify({ error: e.message })]);
    broadcast('done-suggestion', failed);
    return failed;
  }

  const done = await one(`UPDATE done_suggestion SET result=$2::jsonb WHERE id=$1 RETURNING *`,
    [id, JSON.stringify({ ok: true, marked_by: by })]);
  broadcast('done-suggestion', done);
  broadcast('xell', { id: target.id });
  logline('crew', `done suggestion for ${row.target_slug} CONFIRMED by ${by} — task marked done and the xell reaped`);
  if (manager) {
    await postMessage({ from: null, to: manager, kind: 'report', by,
      body: `A human CONFIRMED your suggestion: ${row.target_slug} is marked done and its cxell is being torn `
        + 'down (its commits were collected first). One fewer worker in your crew.' }).catch(() => {});
  }
  return done;
}

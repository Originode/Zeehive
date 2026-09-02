// A2A MEET — group chat rooms for zees (docs/zee-meet-plan.md, DR-1..DR-5).
//
// The human directive: "i want agents to be able to talk to each other via some sort of peer to
// peer a2a chat session like a group chat via a zee meet verb… zees can join and talk."
//
// This module is the DB half of `zee meet` (the CLI/verb surface lives in self.js + routes.js;
// the pure shape helpers live here so they are testable standalone against DATABASE_URL — the
// same reason postMessage lives in lib/managers.js rather than in the routes).
//
// The design in one paragraph (the full decision record is docs/zee-meet-decision-record.md):
//   • A meet is a ROOM (a2a_meet) with a MEMBERSHIP SET (a2a_meet_member) and a TRANSCRIPT
//     (a2a_meet_message). It is NOT a fan-out of zee_message rows and NOT an A2A Task (DR-1).
//   • Any live zee of a project may create a room and may attend any room of its project by code
//     (DR-2). Attendance is self-serve and RECORDED — the member row is the audit. The code is
//     DERIVED, never stored: <founder-slug-truncated>/<last-6-hex-of-room-id>.
//   • A `say` writes ONE transcript row (authoritative), then best-effort notifies every OTHER
//     live member through the existing sendMessageToXell machinery (DR-3) — the same
//     queued/typed/resumed verdict a manager's `zee say` gets. A member that is not live catches
//     up with `zee meet --list` / `--transcript`.
//   • leave/close and "room as A2A Task" are NAMED SEAMS, not built (DR-4): a reaped xell drops
//     out by ON DELETE CASCADE; the conversationTaskId('a2a_meet', meet_id) projection reuses the
//     DR-8 machinery when a peer asks for it.
//   • DEFAULT scoping is still the founder's project (DR-2). A founder may INVITE another whole
//     project into the room (DR-5); the invite row is the audit. Without an invite, a code from
//     another project refuses with today's sentence — widening by explicit consent, never a
//     relaxation. Withdrawing the invite stops future attends/says; member rows and the
//     transcript stay. INVITING is founder-only; WITHDRAWING may also be done by a live manager
//     of the host project so a founder reap cannot leave a permanent cross-project grant.
import { q, one } from '../db/pool.js';
import { sendMessageToXell } from '../queenzee/nudge.js';
import { logline } from './logbus.js';

// ── the code ──────────────────────────────────────────────────────────────────
// The "conversation link or code" the human asked for. Derived from the room row, never stored
// (house rule 7): <slug>/<token>. slug = the founder's xell slug truncated to 12 chars (a hint
// who started it); token = the last 6 hex chars of the room's uuid id (16.7M codes; a zee that
// cannot guess a sibling's slug cannot guess a code). Pure so it is testable.
export function meetCodeFor({ slug = null, id = null } = {}) {
  const hint = String(slug || 'meet').replace(/[^a-z0-9-]/gi, '').slice(0, 12).toLowerCase() || 'meet';
  const token = String(id || '').replace(/-/g, '').slice(-6).toLowerCase();
  return `${hint}/${token}`;
}

// Resolve a code (or a full uuid) to a meet id + slug. A code is `<slug>/<token>`; the slug is a
// hint only — the token is the selector. The slug is fuzzy-matched (prefix, case-insensitive) so
// a truncated slug from a briefing still resolves; the token is exact (the last 6 hex of the id).
// A full uuid (with dashes) is accepted as-is. Returns null when the code does not parse.
export function parseMeetCode(input = '') {
  const s = String(input || '').trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    return { slug: null, token: s.replace(/-/g, '').slice(-6).toLowerCase(), fullId: s };
  }
  const m = /^([a-z0-9-]{1,24})\/([0-9a-f]{4,8})$/i.exec(s);
  if (!m) return null;
  return { slug: m[1].toLowerCase(), token: m[2].toLowerCase(), fullId: null };
}

// Resolve a parsed code to a meet row by matching the token against the room id's tail. The slug
// (when present) is a scope hint — the token is the selector, and the project is a hard filter
// (a code from another project must never resolve here — guests go through meetForCaller, which
// joins a2a_meet_invite so only an invited project can see a foreign room).
export async function meetForCode(parsed, { projectId = null } = {}) {
  if (!parsed) return null;
  if (parsed.fullId) {
    return one(`SELECT * FROM a2a_meet WHERE id=$1 AND ($2::uuid IS NULL OR project_id=$2)`,
      [parsed.fullId, projectId]);
  }
  // token matches the room id's last 6 hex chars. The slug hint is fuzzy: it must be a PREFIX of
  // the stored slug (case-insensitive), or absent. Exact token + prefix slug is tight enough for
  // a throwaway dev fleet.
  const rows = await q(
    `SELECT * FROM a2a_meet
      WHERE right(replace(id::text,'-',''), 6) = lower($1)
        AND ($2::uuid IS NULL OR project_id = $2)`, [parsed.token, projectId]);
  if (!rows.length) return null;
  if (parsed.slug) {
    const hit = rows.find((r) => String(r.slug).toLowerCase().startsWith(parsed.slug));
    if (hit) return hit;
    return null; // token matched but the slug hint does not — do not resolve a code pasted with a wrong hint
  }
  return rows[0];
}

// Guest-project resolve: the room matches the code AND the caller's project holds an invite.
// Joining the invite table is what keeps a non-invited project's probe from learning a room exists.
async function meetForCodeInvited(parsed, projectId) {
  if (!parsed || !projectId) return null;
  if (parsed.fullId) {
    return one(
      `SELECT m.* FROM a2a_meet m
         JOIN a2a_meet_invite i ON i.meet_id = m.id AND i.project_id = $2
        WHERE m.id = $1`, [parsed.fullId, projectId]);
  }
  const rows = await q(
    `SELECT m.* FROM a2a_meet m
       JOIN a2a_meet_invite i ON i.meet_id = m.id AND i.project_id = $2
      WHERE right(replace(m.id::text,'-',''), 6) = lower($1)`, [parsed.token, projectId]);
  if (!rows.length) return null;
  if (parsed.slug) {
    const hit = rows.find((r) => String(r.slug).toLowerCase().startsWith(parsed.slug));
    return hit || null;
  }
  return rows[0];
}

export async function isProjectInvited(meetId, projectId) {
  if (!meetId || !projectId) return false;
  const r = await one(
    `SELECT 1 FROM a2a_meet_invite WHERE meet_id=$1 AND project_id=$2`, [meetId, projectId]);
  return !!r;
}

// Resolve a code for a caller: home project first (byte-identical to today's meetForCode), then
// an invited guest project. `access` is 'home' | 'invited' | 'former' | null.
//   home     — room.project_id === caller's project (DR-2 default)
//   invited  — a2a_meet_invite row for the caller's project (DR-5)
//   former   — caller is still a member but the invite is gone (withdrawn); used only to refuse
//              attend/say with a clearer sentence, and to let transcript keep working for history
async function meetForCaller(parsed, xell, { allowFormer = false } = {}) {
  if (!parsed || !xell?.project_id) return { room: null, access: null };
  const home = await meetForCode(parsed, { projectId: xell.project_id });
  if (home) return { room: home, access: 'home' };
  const invited = await meetForCodeInvited(parsed, xell.project_id);
  if (invited) return { room: invited, access: 'invited' };
  if (allowFormer) {
    // Probe without project filter ONLY to detect a withdrawn-invite member. The row is never
    // returned to a non-member — that would leak room existence to a stranger who guessed a code.
    const any = await meetForCode(parsed, { projectId: null });
    if (any && any.project_id !== xell.project_id && await isMember(any.id, xell.id)) {
      return { room: any, access: 'former' };
    }
  }
  return { room: null, access: null };
}

const SCOPED_REFUSAL = (code) =>
  `no meet "${code}" in your project — check the code, or have the founder re-print it. `
  + 'A meet is project-scoped: you can only attend rooms your own project created.';

const INVITE_WITHDRAWN = (code) =>
  `your project's invite to "${code}" was withdrawn — you can no longer attend or post. `
  + 'The transcript and membership record are kept.';

// ── membership helpers ────────────────────────────────────────────────────────
export async function isMember(meetId, xellId) {
  if (!meetId || !xellId) return false;
  const r = await one(`SELECT 1 FROM a2a_meet_member WHERE meet_id=$1 AND xell_id=$2`, [meetId, xellId]);
  return !!r;
}

// The member seats of a room, with their slugs and roles, oldest join first.
export async function membersFor(meetId) {
  return q(
    `SELECT m.xell_id, m.role, m.joined_at, m.last_read_at, x.slug AS xell_slug
       FROM a2a_meet_member m LEFT JOIN xell x ON x.id = m.xell_id
      WHERE m.meet_id=$1 ORDER BY m.joined_at ASC`, [meetId]);
}

// ── create ────────────────────────────────────────────────────────────────────
// A room starts with the founder as its only member. The code is what the founder's `zee meet
// create` prints and what an attender's `zee meet attend <code>` takes.
export async function createMeet({ xell, title = null }) {
  const text = String(title || '').trim();
  if (!text) return { ok: false, error: 'create needs --title "…" — what the room is about' };
  if (text.length > 200) return { ok: false, error: 'title is too long (200 chars max)' };
  const room = await one(
    `INSERT INTO a2a_meet (project_id, slug, title, founder_xell_id)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [xell.project_id, String(xell.slug || 'meet').replace(/[^a-z0-9-]/gi, '').slice(0, 12).toLowerCase() || 'meet',
     text, xell.id]);
  await one(
    `INSERT INTO a2a_meet_member (meet_id, xell_id, role) VALUES ($1,$2,'founder')
       ON CONFLICT (meet_id, xell_id) DO NOTHING`, [room.id, xell.id]);
  logline('meet', `${xell.slug} created meet ${meetCodeFor(room)} — ${text.slice(0, 80)}`);
  return { ok: true, room, code: meetCodeFor(room) };
}

// ── attend ────────────────────────────────────────────────────────────────────
// Idempotent: re-attending returns the room with joined:false. Attendance is self-serve and
// recorded (DR-2) — the member row is the audit; there is no approval gate. A guest project's
// zee may attend only while its project holds an invite (DR-5); a withdrawn invite refuses
// even a former member who tries to re-attend.
export async function attendMeet({ xell, code = null }) {
  if (!code) return { ok: false, error: 'attend needs <code> — the conversation link a founder printed (`zee meet create`)' };
  const parsed = parseMeetCode(code);
  if (!parsed) return { ok: false, error: `"${code}" is not a meet code — expected <slug>/<token> or a full uuid` };
  const { room, access } = await meetForCaller(parsed, xell, { allowFormer: true });
  if (!room || access === 'former') {
    if (access === 'former') return { ok: false, error: INVITE_WITHDRAWN(code) };
    return { ok: false, error: SCOPED_REFUSAL(code) };
  }
  const already = await isMember(room.id, xell.id);
  if (!already) {
    await one(`INSERT INTO a2a_meet_member (meet_id, xell_id, role) VALUES ($1,$2,'member')`, [room.id, xell.id]);
    logline('meet', `${xell.slug} attended meet ${meetCodeFor(room)}${access === 'invited' ? ' (invited guest)' : ''}`);
  }
  const members = await membersFor(room.id);
  return { ok: true, meet_id: room.id, code: meetCodeFor(room), title: room.title,
           joined: !already, already, members: members.map((m) => ({ slug: m.xell_slug, role: m.role })) };
}

// ── say ───────────────────────────────────────────────────────────────────────
// Writes ONE transcript row (authoritative), then best-effort notifies every OTHER live member
// through the existing sendMessageToXell machinery (DR-3). The row is the memory; a failed
// delivery loses nothing. A member posting to a room it is not a member of is refused (attend
// first — the membership set is the visibility boundary).
export async function sayToMeet({ xell, code = null, message = null }) {
  const text = String(message || '').trim();
  if (!text) return { ok: false, error: 'say needs --message "…" — what you want the room to hear' };
  if (text.length > 20000) return { ok: false, error: 'message is too long (20000 chars max)' };
  if (!code) return { ok: false, error: 'say needs <code> — the room you are posting to (`zee meet --list` shows yours)' };
  const parsed = parseMeetCode(code);
  if (!parsed) return { ok: false, error: `"${code}" is not a meet code — expected <slug>/<token> or a full uuid` };
  // Withdraw stops future says for guests (DR-5) even when the member row still exists.
  const { room, access } = await meetForCaller(parsed, xell, { allowFormer: true });
  if (!room || access === 'former') {
    if (access === 'former') return { ok: false, error: INVITE_WITHDRAWN(code) };
    return { ok: false, error: `no meet "${code}" in your project — check the code` };
  }
  if (!(await isMember(room.id, xell.id))) {
    return { ok: false, error: `you are not a member of "${code}" — attend it first: \`zee meet attend ${code}\`` };
  }
  // project_id on the message is the ROOM's project (not the poster's) — a guest's post stays
  // under the room that owns the conversation; nothing else about the guest project leaks.
  const row = await one(
    `INSERT INTO a2a_meet_message (meet_id, project_id, from_xell_id, from_slug, body)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [room.id, room.project_id, xell.id, xell.slug, text]);

  // Fan-out: notify every OTHER live member. Best-effort and fire-and-forget — the transcript
  // row above is the record; a member mid-turn or asleep reads it with `zee meet --transcript`.
  const members = await membersFor(room.id);
  const notified = [];
  const deliveries = [];
  for (const m of members) {
    if (!m.xell_id || m.xell_id === xell.id) continue;
    try {
      const d = await sendMessageToXell(m.xell_id, {
        text: `💬 ${xell.slug} in meet ${meetCodeFor(room)}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`,
        by: xell.slug,
      });
      deliveries.push({ slug: m.xell_slug, delivery: d.delivery || 'none', sent: d.sent || false,
                        reason: d.reason || d.error || null });
      if (d.sent) notified.push(m.xell_slug);
      else logline('meet', `delivery to ${m.xell_slug} failed (${d.reason || d.error || '—'})`);
    } catch (e) {
      deliveries.push({ slug: m.xell_slug, delivery: 'none', sent: false, reason: String(e.message).slice(0, 120) });
      logline('meet', `delivery to ${m.xell_slug} threw (${String(e.message).slice(0, 120)})`);
    }
  }
  logline('meet', `${xell.slug} → meet ${meetCodeFor(room)}: ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
  return {
    ok: true, posted: true, code: meetCodeFor(room), meet_id: room.id,
    message: { id: row.id, from: xell.slug, body: row.body, at: row.created_at },
    deliveries,
  };
}

// ── list / transcript ─────────────────────────────────────────────────────────
// The rooms the caller is a member of, newest first, with a per-room unread hint (messages since
// the caller's last_read_at, which is bumped when they fetch a transcript). Reading the transcript
// is the "mark read" act — the same read-model/receipt coupling as zee inbox.
export async function listMeetsFor(xell) {
  const rows = await q(
    `SELECT m.meet_id, meet.title, meet.slug AS meet_slug, meet.created_at,
            m.joined_at, m.last_read_at, m.role,
            (SELECT count(*) FROM a2a_meet_message msg
              WHERE msg.meet_id = m.meet_id
                AND (m.last_read_at IS NULL OR msg.created_at > m.last_read_at)) AS unread,
            (SELECT count(*) FROM a2a_meet_member mem WHERE mem.meet_id = m.meet_id) AS member_count,
            (SELECT count(*) FROM a2a_meet_message msg WHERE msg.meet_id = m.meet_id) AS message_count
       FROM a2a_meet_member m JOIN a2a_meet meet ON meet.id = m.meet_id
      WHERE m.xell_id = $1
      ORDER BY meet.created_at DESC LIMIT 100`, [xell.id]);
  return rows.map((r) => ({
    code: meetCodeFor({ slug: r.meet_slug, id: r.meet_id }),
    title: r.title, role: r.role, joined_at: r.joined_at, last_read_at: r.last_read_at,
    unread: Number(r.unread), member_count: Number(r.member_count), message_count: Number(r.message_count),
  }));
}

// The transcript of one room — the catch-up a newly attended zee reads. Requires membership.
// Bumps last_read_at (the receipt) in the same call.
export async function transcriptFor(xell, code = null) {
  if (!code) return { ok: false, error: 'transcript needs <code> — the room you are reading (`zee meet --list` shows yours)' };
  const parsed = parseMeetCode(code);
  if (!parsed) return { ok: false, error: `"${code}" is not a meet code` };
  // Former members (invite withdrawn) may still read — membership is the visibility boundary and
  // the transcript is a fact; only attend/say are cut off by a withdraw.
  const { room, access } = await meetForCaller(parsed, xell, { allowFormer: true });
  if (!room) return { ok: false, error: `no meet "${code}" in your project` };
  if (!(await isMember(room.id, xell.id))) {
    return { ok: false, error: `you are not a member of "${code}" — attend it first: \`zee meet attend ${code}\`` };
  }
  const [messages, members] = await Promise.all([
    q(`SELECT id, from_slug, body, kind, created_at FROM a2a_meet_message
        WHERE meet_id=$1 ORDER BY created_at ASC, id ASC`, [room.id]),
    membersFor(room.id),
  ]);
  await q(`UPDATE a2a_meet_member SET last_read_at = now() WHERE meet_id=$1 AND xell_id=$2`, [room.id, xell.id]);
  return {
    ok: true, code: meetCodeFor(room), meet_id: room.id, title: room.title,
    access, members: members.map((m) => ({ slug: m.xell_slug, role: m.role })),
    messages: messages.map((m) => ({ id: m.id, from: m.from_slug, body: m.body, kind: m.kind, at: m.created_at })),
  };
}

// ── invite / uninvite ─────────────────────────────────────────────────────────
// Only the FOUNDER may invite, and only a whole PROJECT (never a xell, never "anyone"). The
// invite row is the audit (DR-5). Inviting the room's own project is a no-op that says so.
// --remove deletes the invite; member rows and the transcript are not touched.

async function resolveProjectRef(ref) {
  const s = String(ref || '').trim();
  if (!s) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    return one(`SELECT id, name FROM project WHERE id=$1`, [s]);
  }
  // Case-insensitive exact name match. Ambiguous names refuse rather than guess.
  const rows = await q(
    `SELECT id, name FROM project WHERE lower(name) = lower($1) ORDER BY created_at ASC`, [s]);
  if (!rows.length) return null;
  if (rows.length > 1) {
    const err = new Error(
      `project name "${s}" matches ${rows.length} projects — pass the project id instead`);
    err.code = 'ambiguous';
    err.matches = rows;
    throw err;
  }
  return rows[0];
}

// Gate for invite/withdraw. The room must be in the caller's project (a guest project's manager
// cannot touch another project's room — meetForCode with their projectId returns null).
//
// Asymmetry (DR-5): WIDENING (invite) is founder-only. NARROWING (withdraw) may be done by the
// founder OR by any live manager of the room's OWN (host) project — so an ordinary founder reap
// cannot leave a permanent cross-project grant that nobody can revoke. "Live" = zee_type manager
// and status not retired/tearing-down. If the host project has no live manager, a human in the
// console is the answer (named in the DR; not widened to "any host zee").
async function roomForInviteAct(xell, code, { remove = false } = {}) {
  if (!code) {
    return { ok: false, error: remove
      ? 'invite --remove needs <code> — the room whose invite you are withdrawing'
      : 'invite needs <code> — the room you founded (`zee meet --list` shows yours)' };
  }
  const parsed = parseMeetCode(code);
  if (!parsed) return { ok: false, error: `"${code}" is not a meet code — expected <slug>/<token> or a full uuid` };
  const room = await meetForCode(parsed, { projectId: xell.project_id });
  if (!room) return { ok: false, error: SCOPED_REFUSAL(code) };

  // A retired/torn-down xell cannot act even if it still matches founder_xell_id — resolveSelf
  // already 409s them at the HTTP edge; mirror that here so a reap cannot be bypassed at the lib.
  const live = xell.status !== 'retired'
    && xell.status !== 'tearing-down'
    && xell.status !== 'husk';
  const isFounder = live && room.founder_xell_id && room.founder_xell_id === xell.id;
  if (isFounder) return { ok: true, room, as: 'founder' };

  if (remove) {
    const liveHostManager = live
      && xell.zee_type === 'manager'
      && xell.project_id === room.project_id;
    if (liveHostManager) return { ok: true, room, as: 'host-manager' };
    return {
      ok: false,
      error: `only the founder of "${meetCodeFor(room)}" or a live manager of its project may withdraw an invite`
        + (room.founder_xell_id ? '' : ' — the founding xell is gone'),
    };
  }

  return { ok: false, error: `only the founder of "${meetCodeFor(room)}" may invite — you are not the founder` };
}

export async function invitesFor(meetId) {
  return q(
    `SELECT i.project_id, p.name AS project_name, i.invited_by_xell_id, i.created_at,
            x.slug AS invited_by_slug
       FROM a2a_meet_invite i
       JOIN project p ON p.id = i.project_id
       LEFT JOIN xell x ON x.id = i.invited_by_xell_id
      WHERE i.meet_id = $1
      ORDER BY i.created_at ASC`, [meetId]);
}

export async function inviteToMeet({ xell, code = null, project = null, remove = false } = {}) {
  const gate = await roomForInviteAct(xell, code, { remove: !!remove });
  if (!gate.ok) return gate;
  const { room, as } = gate;
  if (!project) {
    return { ok: false, error: 'invite needs --project <name-or-id> — the whole project to let into this room' };
  }

  let target;
  try { target = await resolveProjectRef(project); }
  catch (e) {
    if (e.code === 'ambiguous') {
      return { ok: false, error: e.message,
               matches: (e.matches || []).map((p) => ({ id: p.id, name: p.name })) };
    }
    throw e;
  }
  if (!target) {
    return { ok: false, error: `no project "${project}" — pass a project name or id` };
  }

  if (target.id === room.project_id) {
    return {
      ok: true, noop: true, code: meetCodeFor(room), meet_id: room.id,
      project: { id: target.id, name: target.name },
      message: `"${target.name}" is this room's own project — it is already in. Nothing to invite.`,
      invites: (await invitesFor(room.id)).map((i) => ({
        project_id: i.project_id, name: i.project_name, invited_by: i.invited_by_slug, at: i.created_at,
      })),
    };
  }

  if (remove) {
    const deleted = await one(
      `DELETE FROM a2a_meet_invite WHERE meet_id=$1 AND project_id=$2 RETURNING *`,
      [room.id, target.id]);
    logline('meet', `${xell.slug} (${as}) withdrew invite of project ${target.name} from meet ${meetCodeFor(room)}`);
    return {
      ok: true, removed: !!deleted, code: meetCodeFor(room), meet_id: room.id, as,
      project: { id: target.id, name: target.name },
      message: deleted
        ? `Withdrew invite for "${target.name}" from ${meetCodeFor(room)}. Existing members and the transcript stay; their zees can no longer attend or post.`
        : `"${target.name}" was not invited to ${meetCodeFor(room)} — nothing to withdraw.`,
      invites: (await invitesFor(room.id)).map((i) => ({
        project_id: i.project_id, name: i.project_name, invited_by: i.invited_by_slug, at: i.created_at,
      })),
    };
  }

  const existing = await isProjectInvited(room.id, target.id);
  if (!existing) {
    await one(
      `INSERT INTO a2a_meet_invite (meet_id, project_id, invited_by_xell_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (meet_id, project_id) DO NOTHING`,
      [room.id, target.id, xell.id]);
    logline('meet', `${xell.slug} invited project ${target.name} to meet ${meetCodeFor(room)}`);
  }
  return {
    ok: true, invited: true, already: existing, code: meetCodeFor(room), meet_id: room.id,
    project: { id: target.id, name: target.name },
    message: existing
      ? `"${target.name}" is already invited to ${meetCodeFor(room)}.`
      : `Invited "${target.name}" to ${meetCodeFor(room)}. A zee of that project can now \`zee meet attend ${meetCodeFor(room)}\`.`,
    invites: (await invitesFor(room.id)).map((i) => ({
      project_id: i.project_id, name: i.project_name, invited_by: i.invited_by_slug, at: i.created_at,
    })),
  };
}

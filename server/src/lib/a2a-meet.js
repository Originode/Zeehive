// A2A MEET — group chat rooms for zees (docs/zee-meet-plan.md, DR-1..DR-4).
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
//
// Scoping: a meet is project-scoped (DR-2). The caller's xell must belong to the room's project
// to attend/post/read. There is deliberately NO crew scoping — the whole point is two arbitrary
// zees of one project meeting — and the member row is what makes "who was in the room" a fact.
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
// (a code from another project must never resolve here).
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
// recorded (DR-2) — the member row is the audit; there is no approval gate.
export async function attendMeet({ xell, code = null }) {
  if (!code) return { ok: false, error: 'attend needs <code> — the conversation link a founder printed (`zee meet create`)' };
  const parsed = parseMeetCode(code);
  if (!parsed) return { ok: false, error: `"${code}" is not a meet code — expected <slug>/<token> or a full uuid` };
  const room = await meetForCode(parsed, { projectId: xell.project_id });
  if (!room) {
    return { ok: false, error: `no meet "${code}" in your project — check the code, or have the founder re-print it. `
      + 'A meet is project-scoped: you can only attend rooms your own project created.' };
  }
  const already = await isMember(room.id, xell.id);
  if (!already) {
    await one(`INSERT INTO a2a_meet_member (meet_id, xell_id, role) VALUES ($1,$2,'member')`, [room.id, xell.id]);
    logline('meet', `${xell.slug} attended meet ${meetCodeFor(room)}`);
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
  const room = await meetForCode(parsed, { projectId: xell.project_id });
  if (!room) return { ok: false, error: `no meet "${code}" in your project — check the code` };
  if (!(await isMember(room.id, xell.id))) {
    return { ok: false, error: `you are not a member of "${code}" — attend it first: \`zee meet attend ${code}\`` };
  }
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
  const room = await meetForCode(parsed, { projectId: xell.project_id });
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
    members: members.map((m) => ({ slug: m.xell_slug, role: m.role })),
    messages: messages.map((m) => ({ id: m.id, from: m.from_slug, body: m.body, kind: m.kind, at: m.created_at })),
  };
}

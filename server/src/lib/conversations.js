// CONVERSATION ARCHIVES — a zee's session transcript, archived to the queenzee for review.
//
// A cxell zee's conversation IS its session transcript inside the cage at
// ~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl (Claude Code JSONL: one JSON event per
// line). Two doors into the same storage, both ending in `uploadConversationArchive`:
//
//   • the VERB (`zee upload-conversation`) — the zee CLI reads the transcript and POSTs the raw
//     text; this file parses + stores it. The zee's own act of archiving.
//   • the "upload conversations on done" harness setting — when a wearer proposes done, the
//     queenzee reads the transcript FROM the cxell container (it has docker; the zee is gone
//     soon) and stores the same archive. That path is best-effort and NEVER blocks the done
//     proposal: an archive that cannot be read is reported, not fatal.
//
// The stored row is a RECEIPT about a throwaway xell: xell_id is ON DELETE SET NULL, project_id
// + xell_slug keep it findable after the xell is reaped. A MANAGER may read the archives of the
// crew it dispatched (`zee conversations`) — the same scoping as every other crew verb, resolved
// from the caller's token, never from a body parameter.
import { q, one } from '../db/pool.js';
import { execInCxell } from './cxell.js';
import { logline } from './logbus.js';
import { isManager } from './managers.js';

// ── parsing ──────────────────────────────────────────────────────────────────
// The transcript is JSONL. Parse defensively: a partial write or a vendor-specific line that is
// not valid JSON degrades to a `raw` event rather than losing the whole archive. The `title` is
// Claude Code's own `custom-title` event (last one wins), the same source session-title.js reads.
export function parseTranscript(content) {
  const text = String(content || '');
  const events = [];
  let title = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && ev.type === 'custom-title' && ev.customTitle) title = ev.customTitle;
      events.push(ev);
    } catch {
      events.push({ type: 'raw', raw: line.slice(0, 2000) });
    }
  }
  return { events, lineCount: events.length, byteCount: Buffer.byteLength(text), title };
}

// ── the harness's archival settings ──────────────────────────────────────────
// Two booleans live on the harness row (migration 112). NOT inherited from the parent chain:
// a checkbox on a harness is a plain statement about that harness's wearers, exactly like
// `enabled`. `enable_reflection` defaults TRUE (the post-ship reflection always ran before this
// column existed); `upload_conversations_on_done` defaults FALSE (new, opt-in).
export async function harnessArchivalSettings(xell) {
  if (!xell?.harness_id) return { upload_conversations_on_done: false, enable_reflection: true };
  const h = await one(`SELECT upload_conversations_on_done, enable_reflection
                         FROM harness WHERE id=$1 AND enabled`, [xell.harness_id]);
  return {
    upload_conversations_on_done: !!h?.upload_conversations_on_done,
    enable_reflection: h ? h.enable_reflection !== false : true,
  };
}

// ── reading the transcript FROM the cxell container (the queenzee's door) ─────
// Used by the "upload on done" hook. Finds the NEWEST transcript under the cage's
// ~/.claude/projects/ (one zee per cxell, so the newest IS the current conversation), prints a
// sentinel path line so we know what we read, then cats the whole file. Resolves
// { content, path, sessionId, title } or throws when there is no transcript to read.
const CXELL_READ_SH = [
  'f="$(find ~/.claude/projects -name \'*.jsonl\' 2>/dev/null -printf \'%T@ %p\\n\' | sort -rn | head -1 | cut -d\' \' -f2-)"',
  'if [ -n "$f" ]; then echo "__ZEE_CONV_PATH__$f"; cat "$f"; fi',
].join('\n');

export async function readCxellTranscript(xell, { sessionId = null } = {}) {
  let sh = CXELL_READ_SH;
  if (sessionId) {
    // A known session id → read THAT file specifically (the newest fallback is for the verb
    // where the CLI picks the file and the server only stores it).
    const sid = String(sessionId).replace(/[^0-9a-zA-Z-]/g, '');
    if (sid) {
      sh = `f="$(ls -t ~/.claude/projects/-work-repo/${sid}.jsonl 2>/dev/null | head -1)"\n`
        + `if [ -n "$f" ]; then echo "__ZEE_CONV_PATH__$f"; cat "$f"; fi`;
    }
  }
  const r = await execInCxell({ ctx: 'default', slug: xell.slug, cmd: sh, timeoutMs: 20000 });
  const nl = r.out.indexOf('\n');
  const head = nl >= 0 ? r.out.slice(0, nl).trim() : r.out.trim();
  const content = nl >= 0 ? r.out.slice(nl + 1) : '';
  if (!head.startsWith('__ZEE_CONV_PATH__')) {
    throw new Error(`no conversation transcript in the cxell (${xell.slug}) — the zee has no `
      + '~/.claude/projects transcript to archive, or the cxell is not reachable from here');
  }
  const path = head.slice('__ZEE_CONV_PATH__'.length);
  const sid = path.match(/([0-9a-fA-F-]{8,36})\.jsonl$/)?.[1] || sessionId || null;
  return { content, path, sessionId: sid, title: null };
}

// ── the shared write ─────────────────────────────────────────────────────────
// Store one archive. `content` may come from the zee (verb) or be read from the cxell here
// (done hook, when content is omitted). Returns the row summary the caller echoes back.
export async function uploadConversationArchive(xell, { content = null, sessionId = null, title = null,
                                                        reason = null, uploadedBy = 'verb' } = {}) {
  let text = content != null ? String(content) : null;
  let read = null;
  if (text == null || !text.trim()) {
    read = await readCxellTranscript(xell, { sessionId });
    text = read.content;
  }
  if (!text || !text.trim()) {
    return { ok: false, error: 'nothing to archive — the conversation is empty' };
  }
  const { events, lineCount, byteCount, title: parsedTitle } = parseTranscript(text);
  const row = await one(
    `INSERT INTO xell_conversation
       (project_id, xell_id, xell_slug, zee_id, session_id, title, content, events, line_count, byte_count, uploaded_by, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)
     RETURNING id, xell_slug, session_id, title, line_count, byte_count, created_at`,
    [xell.project_id, xell.id, xell.slug,
     (await one(`SELECT id FROM zee WHERE xell_id=$1 ORDER BY created_at DESC LIMIT 1`, [xell.id]).catch(() => null))?.id || null,
     sessionId || read?.sessionId || null, title || read?.title || parsedTitle,
     text, JSON.stringify(events), lineCount, byteCount, uploadedBy, reason || null]);
  logline('self', `${xell.slug} archived its conversation (${uploadedBy}) — ${lineCount} lines, ${byteCount} bytes`
    + `${read?.path ? ` from ${read.path}` : ''}`);
  return {
    ok: true, conversation_id: row.id, xell: row.xell_slug, session_id: row.session_id,
    title: row.title || null, line_count: row.line_count, byte_count: row.byte_count,
    uploaded_by: uploadedBy, uploaded_at: row.created_at,
    message: `Conversation archived (${row.line_count} lines, ${row.byte_count} bytes) — `
      + (uploadedBy === 'done'
        ? 'the "upload conversations on done" harness setting archived it for you.'
        : 'it is stored for your manager to review (`zee conversations`).'),
  };
}

// ── the manager's read ───────────────────────────────────────────────────────
// A MANAGER may review the conversation archives of the xells IT dispatched — nothing more. The
// scope comes from the caller's token: xells whose manager_xell_id is this manager, resolved by
// slug or listed. A worker is refused (it has no crew to review).
export async function conversationsForManager(xell, { xell: slug = null, full = false } = {}) {
  if (!isManager(xell)) {
    return { ok: false, status: 'refused', error:
      '`zee conversations` is a MANAGER verb — a worker reviews nothing. Your own conversation is '
      + 'archived with `zee upload-conversation`; your manager (if you have one) is the one who reads it.' };
  }
  const crew = await q(`SELECT id, slug FROM xell WHERE manager_xell_id=$1 AND status <> 'retired'`, [xell.id]);
  const ids = crew.map((c) => c.id);
  if (!ids.length) {
    return { ok: true, count: 0, conversations: [],
      message: 'No workers in your crew yet — `zee dispatch --task "…"` spawns one. There are no '
        + 'conversation archives to review.' };
  }
  if (slug) {
    const target = crew.find((c) => c.slug === slug);
    if (!target) {
      return { ok: false, status: 'refused', error:
        `"${slug}" is not in your crew — \`zee zees\` lists the xells you dispatched. You can only `
        + 'review archives of workers you own.' };
    }
    const rows = await q(
      `SELECT c.id, c.xell_slug, c.session_id, c.title, c.line_count, c.byte_count, c.uploaded_by,
              c.reason, c.created_at
         FROM xell_conversation c WHERE c.xell_id=$1 ORDER BY c.created_at DESC LIMIT 20`, [target.id]);
    const newestId = rows[0]?.id || null;
    const out = [];
    for (const r of rows) {
      out.push(full && r.id === newestId
        ? { ...rowView(r), content: await conversationContent(r.id) }
        : rowView(r));
    }
    return {
      ok: true, xell: slug, count: rows.length, conversations: out,
      message: rows.length
        ? `${rows.length} archived conversation(s) for ${slug}.`
        : `No conversation archives for ${slug} yet — its zee can \`zee upload-conversation\`, or `
          + 'the harness can set "upload conversations on done".',
    };
  }
  const rows = await q(
    `SELECT c.id, c.xell_slug, c.session_id, c.title, c.line_count, c.byte_count, c.uploaded_by,
            c.reason, c.created_at
       FROM xell_conversation c
      WHERE c.xell_id = ANY($1::uuid[])
      ORDER BY c.created_at DESC LIMIT 100`, [ids]);
  return {
    ok: true, count: rows.length, conversations: rows.map(rowView),
    message: rows.length
      ? `${rows.length} conversation archive(s) across your crew. \`zee conversations --xell <slug> --full\` reads one.`
      : 'No conversation archives across your crew yet.',
  };
}

function rowView(r) {
  return {
    conversation_id: r.id, xell: r.xell_slug, session_id: r.session_id || null,
    title: r.title || null, line_count: r.line_count, byte_count: r.byte_count,
    uploaded_by: r.uploaded_by, reason: r.reason || null, uploaded_at: r.created_at,
  };
}

async function conversationContent(id) {
  const r = await one(`SELECT content FROM xell_conversation WHERE id=$1`, [id]);
  return r?.content || null;
}

// ── the full archived conversation for the console (human review) ────────────
// Used by the console route GET /xells/:id/conversations — a human may read ANY xell's archives
// (the console is the human surface; there is no scope wall to respect there).
export async function conversationsForXell(xellId, { full = false } = {}) {
  const rows = await q(
    `SELECT c.id, c.xell_slug, c.session_id, c.title, c.line_count, c.byte_count, c.uploaded_by,
            c.reason, c.created_at
       FROM xell_conversation c WHERE c.xell_id=$1 ORDER BY c.created_at DESC LIMIT 20`, [xellId]);
  return Promise.all(rows.map(async (r) => (full && r.id === rows[0]?.id
    ? { ...rowView(r), content: await conversationContent(r.id) }
    : rowView(r))));
}

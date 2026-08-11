// TICKET ATTACHMENTS — the evidence that comes WITH a ticket.
//
// A deployed project reporting a fault has more than a sentence: it has the stack trace, the JSON
// the API answered, the har file, the screenshot of the screen that went blank. Retyping any of
// that into a ticket body loses it, so this module is where it lands: rows in `ticket_attachment`
// (migration 190), stored as bytea in the meta-DB.
//
// Two decisions worth stating, because both are the sort of thing a later reader would otherwise
// re-litigate:
//
// 1. IN THE DATABASE, NOT ON A DISK. The meta-DB is what this fleet backs up, replicates and can
//    reach from every container; a path on one host's filesystem is unreachable from a cxell and is
//    exactly the kind of fact house rule 7 forbids writing down. The cost is that attachments must
//    stay SMALL, which is what the caps below enforce — 10 MB an attachment, 50 MB a ticket. Bigger
//    evidence belongs behind a URL in the ticket body.
// 2. AN ALLOW-LIST OF CONTENT TYPES, not a deny-list. What a ticket needs is images and text logs;
//    everything else is refused by name, with the list in the refusal so an integrator can read it
//    off the error instead of out of a doc. Nothing here is ever executed or rendered as HTML — the
//    download route serves it with `Content-Disposition: attachment` and nosniff.
import { createHash } from 'node:crypto';
import { q, one } from '../db/pool.js';
import { broadcast } from './events.js';
import { bad, notFound, refuse, assertId } from './work-items.js';

// content type -> the coarse class a UI renders by. This map IS the allow-list.
export const ATTACHMENT_TYPES = {
  'image/png':        'image',
  'image/jpeg':       'image',
  'image/gif':        'image',
  'image/webp':       'image',
  'image/svg+xml':    'image',    // served as a download, never inlined — see the header
  'text/plain':       'log',
  'text/csv':         'data',
  'text/markdown':    'log',
  'text/xml':         'data',
  'application/xml':  'data',
  'application/json': 'data',
  'application/x-ndjson': 'log',
  'application/yaml': 'data',
  'text/yaml':        'data',
  'application/pdf':  'file',
};
export const ATTACHMENT_CONTENT_TYPES = Object.keys(ATTACHMENT_TYPES);

// Extension -> content type, for the common case of a caller that sends a filename and no type.
// Deliberately small: it covers what a log or a screenshot is actually called.
const BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', txt: 'text/plain', log: 'text/plain', md: 'text/markdown',
  csv: 'text/csv', xml: 'text/xml', json: 'application/json', ndjson: 'application/x-ndjson',
  har: 'application/json', yaml: 'application/yaml', yml: 'application/yaml', pdf: 'application/pdf',
};

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;   // one attachment
export const MAX_TICKET_BYTES     = 50 * 1024 * 1024;   // everything on one ticket
export const MAX_TICKET_FILES     = 50;

export function attachmentLimits() {
  return {
    max_attachment_bytes: MAX_ATTACHMENT_BYTES,
    max_ticket_bytes: MAX_TICKET_BYTES,
    max_attachments_per_ticket: MAX_TICKET_FILES,
    content_types: ATTACHMENT_CONTENT_TYPES,
    encodings: ['base64', 'utf8'],
    note: 'Send `content_base64` for an image, or `text` for a log. Bigger evidence belongs behind a URL in the ticket body.',
  };
}

const COLS = `id, ticket_id, comment_id, filename, content_type, kind, size_bytes, sha256,
              uploaded_by, source, created_at`;

const shape = (row) => (row ? { ...row, download_url: `/api/tickets/${row.ticket_id}/attachments/${row.id}` } : null);

// A filename a human can read and a filesystem cannot be hurt by: no paths, no control characters.
// The name is metadata — it never becomes a path on this server — but it IS what a browser saves
// the download as, so it is sanitised at the door rather than at every reader.
function safeName(name, contentType) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (base) return base.slice(0, 200);
  const ext = Object.entries(BY_EXT).find(([, t]) => t === contentType)?.[0] || 'bin';
  return `attachment.${ext}`;
}

function resolveType(filename, contentType) {
  const declared = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (declared) return declared;
  const ext = String(filename || '').split('.').pop()?.toLowerCase();
  return BY_EXT[ext] || '';
}

// The bytes, from whichever of the two shapes the caller used. `text` is the ordinary case for a
// log (no base64 round trip in the caller's code); `content_base64` is what an image must use.
function bytesOf(spec) {
  if (typeof spec.text === 'string') return Buffer.from(spec.text, 'utf8');
  const b64 = spec.content_base64 ?? spec.content ?? null;
  if (typeof b64 !== 'string' || !b64.trim()) {
    throw bad('attachment needs `content_base64` (an image) or `text` (a log)');
  }
  // Buffer.from is lenient: it silently drops anything that is not base64, so a caller who sent
  // raw text in the base64 field would get a corrupted file and no error at all. Check first.
  const clean = b64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) {
    throw bad('`content_base64` is not valid base64 — send plain text in `text` instead');
  }
  return Buffer.from(clean, 'base64');
}

// ── reads ────────────────────────────────────────────────────────────────────

export async function listAttachments(ticketId) {
  assertId(ticketId, 'ticket id');
  const rows = await q(`SELECT ${COLS} FROM ticket_attachment WHERE ticket_id=$1 ORDER BY created_at`, [ticketId]);
  return rows.map(shape);
}

// The metadata AND the bytes — for the download route, which is the only caller that wants them.
export async function getAttachment(id, { ticketId = null } = {}) {
  assertId(id, 'attachment id');
  if (ticketId) assertId(ticketId, 'ticket id');
  const row = await one(
    `SELECT ${COLS}, content FROM ticket_attachment WHERE id=$1${ticketId ? ' AND ticket_id=$2' : ''}`,
    ticketId ? [id, ticketId] : [id]);
  if (!row) return null;
  return { ...shape(row), content: row.content };
}

// ── writes ───────────────────────────────────────────────────────────────────

// spec: { filename?, content_type?, text | content_base64, uploaded_by?, source?, comment_id? }
// Returns the METADATA only — the bytes go back out through the download route, never in a JSON
// answer to an upload (a 10 MB echo of what the caller just sent helps nobody).
export async function addAttachment(ticketId, spec = {}, { uploadedBy = null, source = null } = {}) {
  assertId(ticketId, 'ticket id');
  const ticket = await one(`SELECT id, number, project_id FROM ticket WHERE id=$1`, [ticketId]);
  if (!ticket) return null;

  const contentType = resolveType(spec.filename, spec.content_type);
  if (!contentType) {
    throw bad('attachment needs a `content_type` (or a filename with a known extension) — one of: '
      + ATTACHMENT_CONTENT_TYPES.join(', '));
  }
  const kind = ATTACHMENT_TYPES[contentType];
  if (!kind) {
    throw refuse(`"${contentType}" is not an accepted attachment type. Accepted: `
      + `${ATTACHMENT_CONTENT_TYPES.join(', ')}. Anything else belongs behind a URL in the ticket body.`);
  }
  const buf = bytesOf(spec);
  if (!buf.length) throw bad('attachment is empty');
  if (buf.length > MAX_ATTACHMENT_BYTES) {
    throw refuse(`attachment is ${buf.length} bytes — the limit is ${MAX_ATTACHMENT_BYTES} `
      + '(10 MB). Put bigger evidence behind a URL in the ticket body.');
  }
  if (spec.comment_id) {
    assertId(spec.comment_id, 'comment id');
    const c = await one(`SELECT id FROM ticket_comment WHERE id=$1 AND ticket_id=$2`, [spec.comment_id, ticketId]);
    if (!c) throw notFound('no such comment on this ticket');
  }

  // The per-ticket caps are checked against what is already stored, so a caller cannot walk past
  // them one 9 MB file at a time.
  const used = await one(
    `SELECT count(*)::int AS n, COALESCE(sum(size_bytes),0)::bigint AS bytes
       FROM ticket_attachment WHERE ticket_id=$1`, [ticketId]);
  if ((used?.n ?? 0) >= MAX_TICKET_FILES) {
    throw refuse(`ticket #${ticket.number} already has ${used.n} attachments — the limit is ${MAX_TICKET_FILES}.`);
  }
  if (Number(used?.bytes ?? 0) + buf.length > MAX_TICKET_BYTES) {
    throw refuse(`ticket #${ticket.number} would hold ${Number(used.bytes) + buf.length} bytes of `
      + `attachments — the limit is ${MAX_TICKET_BYTES} (50 MB).`);
  }

  const row = await one(
    `INSERT INTO ticket_attachment
       (ticket_id, comment_id, filename, content_type, kind, size_bytes, sha256, content, uploaded_by, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${COLS}`,
    [ticketId, spec.comment_id || null, safeName(spec.filename, contentType), contentType, kind,
     buf.length, createHash('sha256').update(buf).digest('hex'), buf,
     spec.uploaded_by || uploadedBy || null, spec.source || source || null]);
  broadcast('work', { kind: 'ticket-attachment', ticket_id: ticketId, attachment: shape(row) });
  return shape(row);
}

// Several in one call, in order, so "file this ticket WITH its evidence" is one round trip. Not a
// transaction: an attachment that is refused (too big, wrong type) must not throw away the ones
// that were fine, and the caller is told exactly which failed and why.
export async function addAttachments(ticketId, specs = [], opts = {}) {
  const list = [].concat(specs || []).filter(Boolean);
  const stored = [];
  const rejected = [];
  for (const spec of list) {
    try {
      const a = await addAttachment(ticketId, spec, opts);
      if (a) stored.push(a);
    } catch (err) {
      rejected.push({ filename: spec?.filename || null, error: String(err?.message || err) });
    }
  }
  return { stored, rejected };
}

export async function deleteAttachment(id, { ticketId = null } = {}) {
  assertId(id, 'attachment id');
  const row = await one(`SELECT ${COLS} FROM ticket_attachment WHERE id=$1${ticketId ? ' AND ticket_id=$2' : ''}`,
                        ticketId ? [id, ticketId] : [id]);
  if (!row) return null;
  await q(`DELETE FROM ticket_attachment WHERE id=$1`, [id]);
  broadcast('work', { kind: 'ticket-attachment-deleted', ticket_id: row.ticket_id, attachment: shape(row) });
  return { ok: true, deleted: shape(row) };
}

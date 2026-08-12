// PROJECT API KEYS — the credential a DEPLOYED project presents to the external ticketing API.
//
// A key names ONE project and nothing else. That is the whole security model of /api/ext/v1: the
// caller never sends a project id, the server resolves it from the key, and so "omnibiz files into
// omnibiz" is true by construction rather than by a check somebody has to remember — the same shape
// as the cxell verbs, which resolve the calling xell from its own token and never from the body
// (lib/xell-token.js, and the note above `xellFromToken` in api/routes.js).
//
// Storage mirrors xell-token.js exactly: the plaintext leaves this module ONCE, at mint, and only
// the sha256 HASH is stored. Nothing can hand a key back afterwards — a lost key is re-minted, not
// recovered — which is why every read model carries `key_hint` (zhk_ab12…7f9c) instead.
//
// This is NOT the cxell identity token: that one is identity for a caged agent behind a firewall,
// this one is a real credential travelling the open internet from somebody else's server. Hence
// 32 random bytes, a revocation column, and a last-used stamp so a dead integration is visible.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { q, one } from '../db/pool.js';
import { bad, notFound, refuse, assertId } from './work-items.js';

// zhk_ = ZeeHive Key. The prefix is deliberate and public: it makes a leaked key greppable in a log
// or a repo, and it lets the server refuse an obviously-not-a-key string before it hashes anything.
export const KEY_PREFIX = 'zhk_';

export const SCOPES = {
  'tickets:read':  'list and read the tickets of this project, their comments and their attachments',
  'tickets:write': 'file tickets, update them, comment on them and attach evidence',
};
export const SCOPE_KEYS = Object.keys(SCOPES);
const DEFAULT_SCOPES = ['tickets:read', 'tickets:write'];

export const hashKey = (k) => createHash('sha256').update(String(k)).digest('hex');
export const mintKey = () => `${KEY_PREFIX}${randomBytes(32).toString('hex')}`;
export const keyHint = (k) => (k ? `${String(k).slice(0, 8)}…${String(k).slice(-4)}` : null);

const COLS = `id, project_id, label, key_hint, scopes, created_by, created_at,
              last_used_at, last_seen_ip, revoked_at, revoked_by`;

const shape = (row) => (row ? { ...row, scopes: row.scopes || [], revoked: !!row.revoked_at } : null);

function checkScopes(scopes) {
  if (scopes == null) return DEFAULT_SCOPES;
  const list = [].concat(scopes).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) throw bad(`at least one scope is required — one of: ${SCOPE_KEYS.join(', ')}`);
  for (const s of list) {
    if (!SCOPE_KEYS.includes(s)) throw bad(`unknown scope "${s}" — one of: ${SCOPE_KEYS.join(', ')}`);
  }
  return [...new Set(list)];
}

// ── reads ────────────────────────────────────────────────────────────────────

export async function listProjectApiKeys(projectId) {
  assertId(projectId, 'project id');
  const rows = await q(
    `SELECT ${COLS},
            (SELECT count(*)::int FROM ticket t WHERE t.api_key_id = k.id) AS tickets_filed
       FROM project_api_key k
      WHERE project_id = $1
      ORDER BY revoked_at IS NOT NULL, created_at DESC`, [projectId]);
  return rows.map(shape);
}

// ── writes ───────────────────────────────────────────────────────────────────

// Returns the row PLUS `key` — the one and only time the plaintext exists outside the caller's
// hands. Every later read answers with the hint alone, so a console must show it now or never.
export async function createProjectApiKey(projectId, { label, scopes, created_by = null } = {}) {
  assertId(projectId, 'project id');
  const name = String(label || '').trim();
  if (!name) throw bad('label required — what a human will call this key ("omnibiz helpdesk")');
  if (!(await one(`SELECT id FROM project WHERE id=$1`, [projectId]))) throw notFound('no such project');
  const wanted = checkScopes(scopes);
  const key = mintKey();
  const row = await one(
    `INSERT INTO project_api_key (project_id, label, key_hash, key_hint, scopes, created_by)
     VALUES ($1,$2,$3,$4,$5::text[],$6) RETURNING ${COLS}`,
    [projectId, name, hashKey(key), keyHint(key), wanted, created_by]);
  return { ...shape(row), tickets_filed: 0, key };
}

export async function revokeProjectApiKey(id, { by = null } = {}) {
  assertId(id, 'api key id');
  const row = await one(`SELECT ${COLS} FROM project_api_key WHERE id=$1`, [id]);
  if (!row) return null;
  if (row.revoked_at) throw refuse(`"${row.label}" is already revoked — it stopped working at ${row.revoked_at.toISOString?.() || row.revoked_at}.`);
  const out = await one(
    `UPDATE project_api_key SET revoked_at=now(), revoked_by=$2 WHERE id=$1 RETURNING ${COLS}`, [id, by]);
  return shape(out);
}

// Deleting is for a key that was never used. A key that FILED tickets is revoked, never deleted:
// ticket.api_key_id would go null and the board would stop being able to say where those tickets
// came from. The refusal says which, and how many.
export async function deleteProjectApiKey(id) {
  assertId(id, 'api key id');
  const row = await one(`SELECT ${COLS} FROM project_api_key WHERE id=$1`, [id]);
  if (!row) return null;
  const n = await one(`SELECT count(*)::int AS n FROM ticket WHERE api_key_id=$1`, [id]);
  if (n?.n) {
    throw refuse(`"${row.label}" filed ${n.n} ticket(s) — revoke it instead of deleting it, `
      + 'so the board can still say where those tickets came from.');
  }
  await q(`DELETE FROM project_api_key WHERE id=$1`, [id]);
  return { ok: true, deleted: shape(row) };
}

// ── the door: a bearer key becomes a caller ──────────────────────────────────
//
// Answers { ok, key, project } for a live key, or { ok:false, reason } for anything else — never
// throws, because this runs before a route decides its own status code, and "why was I refused"
// is part of the contract an integrator debugs against. The reasons are deliberately specific
// (unknown vs revoked vs missing scope): this key is held by a machine somebody else operates, and
// a vague 401 costs that person a day.
export async function authenticateApiKey(presented, { scope = null, ip = null } = {}) {
  const raw = String(presented || '').trim();
  if (!raw) return { ok: false, status: 401, reason: `no API key — send "Authorization: Bearer ${KEY_PREFIX}…"` };
  if (!raw.startsWith(KEY_PREFIX)) {
    return { ok: false, status: 401, reason: `that is not a ZEEHIVE project API key — they start with "${KEY_PREFIX}"` };
  }
  const row = await one(
    `SELECT k.${COLS.split(',').map((c) => c.trim()).join(', k.')}, k.key_hash,
            p.name AS project_name
       FROM project_api_key k JOIN project p ON p.id = k.project_id
      WHERE k.key_hash = $1`, [hashKey(raw)]);
  // A constant-time compare on the HASH we just looked up by. The lookup itself is the equality
  // test, so this adds nothing cryptographically — it is here so a future change that widens the
  // query (a prefix scan, say) cannot quietly reintroduce a `===` on secret material.
  if (!row || !safeEqual(row.key_hash, hashKey(raw))) {
    return { ok: false, status: 401, reason: 'unknown API key — it identifies no project' };
  }
  if (row.revoked_at) {
    return { ok: false, status: 401, reason: `this API key was revoked${row.revoked_by ? ` by ${row.revoked_by}` : ''} — ask for a new one` };
  }
  const scopes = row.scopes || [];
  if (scope && !scopes.includes(scope)) {
    return { ok: false, status: 403,
             reason: `this key does not carry the "${scope}" scope (it has: ${scopes.join(', ') || 'none'})` };
  }
  // Stamped on every ACCEPTED call, so "when did omnibiz last talk to us" is a column and not a
  // guess. Failure here must never fail the call the caller actually made.
  q(`UPDATE project_api_key SET last_used_at=now(), last_seen_ip=$2 WHERE id=$1`, [row.id, ip || null])
    .catch(() => {});
  return {
    ok: true,
    key: { id: row.id, label: row.label, hint: row.key_hint, scopes },
    project: { id: row.project_id, name: row.project_name },
  };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

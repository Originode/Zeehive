// CURRENT CONDITIONS — a short, dated, per-PROJECT list of live impediments, injected into every
// briefing and readable with `zee conditions`.
//
// Deliberately the OPPOSITE of a manual. The manual (and the project doc, and the harness) are
// TIMELESS truths about how things work. These lines are DATED truths about what is broken RIGHT
// NOW: "the shared dev DSN is stale (TKT-47) — get a database with `zee db-sandbox`". Each line is
// true now and should be false soon, each renders with the date it was last touched (updated_at),
// and deleting one is a plain DELETE of a row — trivial on purpose, so a stale line gets pruned
// rather than accumulating into a second manual nobody dares touch.
//
// House rule 7: a condition is DATA — it lives in the meta-DB and is resolved LIVE at briefing
// time (queenzee/intake.js briefing()). Never write a condition into a doc in the repo: a doc
// restates data the day it rots.
import { q, one } from '../db/pool.js';

// A handful of lines, not a second manual. A hard ceiling so the list can never silently grow
// into the thing this card exists to prevent.
export const CONDITION_LIMIT = 25;

// YYYY-MM-DD (the date a human reads: "touched 2026-08-21"). Time of day is noise for an
// impediment that is true for hours at a time, and a bare date is what stays readable in a
// briefing line.
export function conditionDate(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

// The markdown section injected into a briefing, or null when there is nothing to say. Null — not
// an empty section — is the deletable/empty contract: a project with no live impediments gets a
// briefing that is byte-identical to one before this feature existed, so "nothing wrong right now"
// costs a worker nothing and adds no skim-past noise.
export function renderCurrentConditions(rows) {
  if (!rows || !rows.length) return null;
  const L = [];
  L.push('## ⚠ Current conditions — EPHEMERAL, dated');
  L.push('');
  L.push('<!-- These lines are LIVE IMPEDIMENTS for this project, injected from the meta-DB. They are');
  L.push('     NOT documentation: each is true NOW and hopefully false SOON, and each is dated. If a');
  L.push('     line stops being true it should be DELETED (your manager edits the list, or a human in');
  L.push('     the console) — stale conditions are worse than none. -->');
  L.push('');
  for (const r of rows) {
    L.push(`- [${conditionDate(r.updated_at || r.created_at) || '?'}] ${r.body}`);
  }
  return L.join('\n');
}

export async function listProjectConditions(projectId) {
  return q(
    `SELECT id, project_id, body, created_at, updated_at, created_by, updated_by
       FROM project_condition
      WHERE project_id=$1
      ORDER BY created_at ASC, id ASC
      LIMIT ${CONDITION_LIMIT + 1}`, [projectId]);
}

// The briefing-time renderer: fetch this project's conditions and render them (or null).
export async function currentConditionsMarkdownForProject(projectId) {
  if (!projectId) return null;
  const rows = await listProjectConditions(projectId);
  return renderCurrentConditions(rows);
}

export async function addProjectCondition(projectId, body, { actor = null } = {}) {
  const text = String(body || '').trim();
  if (!text) return { ok: false, error: 'a condition line is required' };
  const n = await one(`SELECT count(*)::int AS n FROM project_condition WHERE project_id=$1`, [projectId]);
  if (Number(n?.n || 0) >= CONDITION_LIMIT) {
    return { ok: false, error: `this project already has ${CONDITION_LIMIT} conditions — the list is `
      + 'meant to be a handful of live lines, not a second manual. Delete stale ones before adding more.' };
  }
  const row = await one(
    `INSERT INTO project_condition (project_id, body, created_by, updated_by)
     VALUES ($1,$2,$3,$3) RETURNING *`, [projectId, text, actor || null]);
  return { ok: true, condition: row };
}

export async function removeProjectCondition(conditionId) {
  const row = await one(`DELETE FROM project_condition WHERE id=$1 RETURNING *`, [conditionId]);
  if (!row) return { ok: false, error: `no condition ${conditionId}` };
  return { ok: true, removed: row.id };
}

// The manager's scoped delete: a condition id names a row in SOME project, and a manager must only
// ever delete from its OWN. The console's plain removeProjectCondition is unscoped (the human
// already picked the project); this one refuses a foreign row BY NAME rather than deleting it.
export async function removeProjectConditionScoped(conditionId, projectId) {
  const row = await one(
    `DELETE FROM project_condition WHERE id=$1 AND project_id=$2 RETURNING *`, [conditionId, projectId]);
  if (!row) return { ok: false, error: `no condition ${conditionId} in this project` };
  return { ok: true, removed: row.id };
}

export async function updateProjectCondition(conditionId, body, { actor = null } = {}) {
  const text = String(body || '').trim();
  if (!text) return { ok: false, error: 'a condition line is required' };
  const row = await one(
    `UPDATE project_condition SET body=$2, updated_at=now(), updated_by=$3
      WHERE id=$1 RETURNING *`, [conditionId, text, actor || null]);
  if (!row) return { ok: false, error: `no condition ${conditionId}` };
  return { ok: true, condition: row };
}

// PROJECT ENTRY-POINT DOCS — the AGENTS.md/CLAUDE.md a zee reads first, GENERATED from the meta-DB.
//
// Same rule as a harness (lib/harness.js, migration 080): the row is the source, the file in the xell
// is an artefact. An operator writes the project's agent-facing instructions once in the console and
// every zee dispatched onto that project finds them at the path its provider actually looks for —
// without a commit, and without each project having to remember to write one.
//
// THE ONE HARD RULE: never write over a git-TRACKED file. A project that has committed its own
// CLAUDE.md has said what it wants an agent to read, and a generated copy landing on top of it would
// (a) replace the project's own instructions with an operator's, (b) dirty every xell's worktree, and
// (c) put a file nobody wrote into a landing diff for a human to approve. So the injector asks git
// first and SKIPS with a reason. Untracked is the contract; the file is then git-excluded like the
// harness files beside it, so it can never travel into a commit either.
import { q, one } from '../db/pool.js';
import { logline } from './logbus.js';

// A path a generated doc may land on. Deliberately narrow — it is an entry point for an agent, not a
// way to write anywhere in someone's repo.
export function validateDocPath(relPath) {
  const raw = String(relPath || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!raw) return { ok: false, reason: 'a path is required' };
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return { ok: false, reason: 'must be repo-relative, not absolute' };
  const segs = raw.split('/');
  if (segs.some((s) => !s || s === '.' || s === '..')) return { ok: false, reason: "must not contain '..' or empty segments" };
  if (!/\.md$/i.test(raw)) return { ok: false, reason: 'must be a .md file (it is markdown an agent reads)' };
  if (segs[0] === '.git') return { ok: false, reason: '.git/ is not yours to write into' };
  // .zeehive/ is the harness + binding artefact space; a project doc claiming a path there would
  // collide with files the queenzee already generates and owns.
  if (segs[0] === '.zeehive') return { ok: false, reason: '.zeehive/ belongs to the harness files — pick another path' };
  if (raw.length > 200) return { ok: false, reason: 'path is too long' };
  return { ok: true, path: raw };
}

export async function listProjectDocs(projectId, { enabledOnly = false } = {}) {
  return q(`SELECT id, project_id, rel_path, title, body, enabled, sort, created_at, updated_at
              FROM project_doc WHERE project_id=$1 ${enabledOnly ? 'AND enabled' : ''}
             ORDER BY sort, lower(rel_path)`, [projectId]);
}

export async function createProjectDoc(projectId, { rel_path, title = null, body = '', enabled = true, sort = 0 } = {}) {
  const v = validateDocPath(rel_path);
  if (!v.ok) throw new Error(`bad path "${rel_path}": ${v.reason}`);
  const dup = await one(`SELECT id FROM project_doc WHERE project_id=$1 AND lower(rel_path)=lower($2)`, [projectId, v.path]);
  if (dup) throw new Error(`this project already has a doc at ${v.path}`);
  const row = await one(
    `INSERT INTO project_doc (project_id, rel_path, title, body, enabled, sort)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [projectId, v.path, title || null, String(body || ''), !!enabled, Number(sort) || 0]);
  logline('project-doc', `${v.path}: created for project ${String(projectId).slice(0, 8)} (${String(body || '').length} chars)`);
  return row;
}

export async function updateProjectDoc(id, patch = {}) {
  const cur = await one(`SELECT * FROM project_doc WHERE id=$1`, [id]);
  if (!cur) throw new Error('no such project doc');
  let path = cur.rel_path;
  if ('rel_path' in patch) {
    const v = validateDocPath(patch.rel_path);
    if (!v.ok) throw new Error(`bad path "${patch.rel_path}": ${v.reason}`);
    if (v.path.toLowerCase() !== cur.rel_path.toLowerCase()) {
      const dup = await one(`SELECT id FROM project_doc WHERE project_id=$1 AND lower(rel_path)=lower($2) AND id<>$3`,
        [cur.project_id, v.path, id]);
      if (dup) throw new Error(`this project already has a doc at ${v.path}`);
    }
    path = v.path;
  }
  const row = await one(
    `UPDATE project_doc SET rel_path=$2, title=$3, body=$4, enabled=$5, sort=$6, updated_at=now()
      WHERE id=$1 RETURNING *`,
    [id, path, 'title' in patch ? (patch.title || null) : cur.title,
     'body' in patch ? String(patch.body || '') : cur.body,
     'enabled' in patch ? !!patch.enabled : cur.enabled,
     'sort' in patch ? (Number(patch.sort) || 0) : cur.sort]);
  logline('project-doc', `${row.rel_path}: updated (${row.body.length} chars${row.enabled ? '' : ', DISABLED'})`);
  return row;
}

export async function deleteProjectDoc(id) {
  const row = await one(`DELETE FROM project_doc WHERE id=$1 RETURNING rel_path`, [id]);
  if (row) logline('project-doc', `${row.rel_path}: deleted`);
  return { deleted: !!row };
}

// The stamp every generated doc opens with. Same reasoning as the harness banner: these files look
// exactly like committed repo files, and a zee that "fixes" one is editing an artefact that the next
// assignment overwrites — an edit that lands in no diff and reaches nobody.
export function docBanner(relPath) {
  return `<!-- GENERATED by ZEEHIVE from the meta-DB — this project's entry-point doc \`${relPath}\`.\n`
    + '     Written into this xell when a zee was assigned to it, and rewritten whenever it changes.\n'
    + '     Editing THIS copy changes nothing: it is git-excluded, lands in no diff and is overwritten.\n'
    + "     The source is the project's Docs tab in the ZEEHIVE console. -->";
}

// The files to generate for a project, in injection order. Disabled rows are skipped, and an empty
// body is skipped too: writing a file that says nothing is worse than writing none, because a zee
// then believes it has read the project's instructions.
export async function projectDocFiles(projectId) {
  const rows = await listProjectDocs(projectId, { enabledOnly: true });
  return rows
    .filter((r) => String(r.body || '').trim())
    .map((r) => ({ relPath: r.rel_path, text: `${docBanner(r.rel_path)}\n\n${r.body.trim()}\n` }));
}

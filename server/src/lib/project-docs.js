// PROJECT ENTRY-POINT DOCS — the CONTENTS a zee reads first, GENERATED into one file per AI provider.
//
// Same rule as a harness (lib/harness.js, migration 080): the row is the source, the file in the xell
// is an artefact. An operator writes the project's agent-facing instructions ONCE in the console and
// every zee dispatched onto that project finds them at the path its provider actually looks for —
// without a commit, and without each project having to remember to write one.
//
// THE GRAIN IS THE CONTENTS, NOT THE FILE (migration 083). `body` is the source of truth; `targets`
// names which provider entry points to generate from it — CLAUDE.md for Claude Code, AGENTS.md for
// the ~20 tools that read the standard, GEMINI.md, .github/copilot-instructions.md,
// .cursor/rules/*.mdc … all listed in lib/agent-docs.js. One row, N files, no copy-paste to drift.
// Each generated file opens with a stamp saying it was generated and where the source is, and closes
// with THIS XELL's stack inventory (lib/xell-stack.js) — the half of an agent's context that is
// different in every xell and that nobody could write by hand.
//
// THE ONE HARD RULE: never write over a git-TRACKED file. A project that has committed its own
// CLAUDE.md has said what it wants an agent to read, and a generated copy landing on top of it would
// (a) replace the project's own instructions with an operator's, (b) dirty every xell's worktree, and
// (c) put a file nobody wrote into a landing diff for a human to approve. So the injector asks git
// first and SKIPS with a reason. Untracked is the contract; the file is then git-excluded like the
// harness files beside it, so it can never travel into a commit either.
import { q, one } from '../db/pool.js';
import { logline } from './logbus.js';
import { DEFAULT_TARGET_KEYS, resolveTargets, targetByKey } from './agent-docs.js';
import { xellStackMarkdown } from './xell-stack.js';

// Same switch every other real-side-effect module reads: 'real' touches machines, anything else
// models. The live push below obeys it — a NESTED queenzee (a zee running the server inside its own
// xell, whose fleet rows are the REAL fleet's) must only ever report what it would have written.
const PROVISION_MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

// PUSH AN EDIT INTO THE ZEES ALREADY RUNNING — the same rule a harness save obeys (lib/harness.js).
// An operator who fixes a project's AGENTS.md has fixed it for the NEXT zee only unless something
// carries it into the live ones, and "new zees only" is the failure that left a whole fleet briefed on
// stale text. Best-effort and never throws: the row is saved either way, and the reason it did not
// reach a xell is logged rather than swallowed.
//
// A DELETE deliberately does NOT reach in and remove the file: a queenzee deleting files out of a
// working zee's workspace is a worse surprise than a stale artefact, and the row is already gone from
// every future dispatch. The console says so where an operator deletes.
async function pushDocsToLiveXells(projectId, { mode = PROVISION_MODE } = {}) {
  const xells = await q(
    `SELECT x.id, x.slug FROM xell x
       WHERE x.project_id = $1 AND x.status NOT IN ('retired','tearing-down','husk')
         AND EXISTS (SELECT 1 FROM zee z WHERE z.xell_id = x.id AND z.entrypoint = 'cxell-cli'
                       AND z.status IN ('spawning','online','working','idle'))`, [projectId]);
  if (!xells.length) return { xells: 0, pushed: 0 };
  if (mode !== 'real') {
    logline('project-doc', `doc change NOT pushed into ${xells.length} live xell(s) — PROVISION_MODE=`
      + 'simulate: this queenzee models the fleet, it does not exec into its cxells. Would have '
      + `regenerated in: ${xells.map((x) => x.slug).join(', ')}`);
    return { xells: xells.length, pushed: 0, would_push: xells.length, dry_run: true };
  }
  // Lazily imported: intake.js imports this module, so a static import would close a cycle.
  const { injectProjectDocsIntoXell } = await import('../queenzee/intake.js');
  let pushed = 0;
  for (const x of xells) {
    // xellId rides along so the regenerated files carry THAT xell's stack section — an edit pushed
    // into six live cages produces six different appendices, which is the point of generating it.
    const r = await injectProjectDocsIntoXell({ ctx: 'default', slug: x.slug, projectId, xellId: x.id })
      .catch((e) => ({ written: 0, error: e.message }));
    if (r.written) pushed++;
    else logline('project-doc', `${x.slug}: doc change not applied`
      + `${r.error ? ` (${String(r.error).slice(0, 80)})` : ' (nothing written — see above)'}`);
  }
  return { xells: xells.length, pushed };
}

// The SHAPE rules every generated path obeys, whatever named it. Deliberately narrow — a generated
// doc is an entry point for an agent, not a way to write anywhere in someone's repo.
function pathShape(relPath) {
  const raw = String(relPath || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!raw) return { ok: false, reason: 'a path is required' };
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return { ok: false, reason: 'must be repo-relative, not absolute' };
  const segs = raw.split('/');
  if (segs.some((s) => !s || s === '.' || s === '..')) return { ok: false, reason: "must not contain '..' or empty segments" };
  if (segs[0] === '.git') return { ok: false, reason: '.git/ is not yours to write into' };
  // .zeehive/ is the harness + binding artefact space; a project doc claiming a path there would
  // collide with files the queenzee already generates and owns.
  if (segs[0] === '.zeehive') return { ok: false, reason: '.zeehive/ belongs to the harness files — pick another path' };
  if (raw.length > 200) return { ok: false, reason: 'path is too long' };
  return { ok: true, path: raw };
}

// A path an OPERATOR typed (the custom-path escape hatch). Markdown only: the provider conventions
// that are not .md (.cursor/rules/*.mdc, .rules, .goosehints) come from the registry in code, where
// the extension is part of a documented convention rather than a guess in a text box.
export function validateDocPath(relPath) {
  const v = pathShape(relPath);
  if (!v.ok) return v;
  if (!/\.md$/i.test(v.path)) return { ok: false, reason: 'must be a .md file (it is markdown an agent reads)' };
  return v;
}

// The registry's own paths, checked with the same shape rules. Exported so a test can hold
// lib/agent-docs.js to the contract instead of trusting that whoever adds a vendor got it right.
export function validateTargetPath(relPath) {
  return pathShape(relPath);
}

export async function listProjectDocs(projectId, { enabledOnly = false } = {}) {
  return q(`SELECT id, project_id, rel_path, targets, title, body, enabled, sort, created_at, updated_at
              FROM project_doc WHERE project_id=$1 ${enabledOnly ? 'AND enabled' : ''}
             ORDER BY sort, lower(coalesce(rel_path, targets[1]))`, [projectId]);
}

// A row is one of two things, and saying which is the whole of the validation:
//   TARGETS   — the normal case. The body is the source; the registry supplies the filenames.
//   REL_PATH  — the escape hatch: one custom file at a path the operator names.
// Both at once is refused rather than silently ranked, and neither at all is a row that generates
// nothing — which is exactly the silent nothing this mechanism exists to remove.
function resolveMode({ rel_path, targets }, { fallbackToDefaults = false } = {}) {
  const keys = Array.isArray(targets) ? targets.filter((k) => String(k || '').trim()) : [];
  const path = rel_path === null || rel_path === undefined ? '' : String(rel_path).trim();
  if (keys.length && path) {
    throw new Error('a doc is either generated for providers (targets) or written to one custom path '
      + `(rel_path) — not both. Got targets=[${keys.join(', ')}] and rel_path="${path}".`);
  }
  if (keys.length) return { targets: resolveTargets(keys).map((t) => t.key), rel_path: null };
  if (path) {
    const v = validateDocPath(path);
    if (!v.ok) throw new Error(`bad path "${path}": ${v.reason}`);
    return { targets: [], rel_path: v.path };
  }
  if (fallbackToDefaults) return { targets: [...DEFAULT_TARGET_KEYS], rel_path: null };
  throw new Error('a doc needs either targets (which provider files to generate) or a rel_path');
}

// Two rows generating the same file is a winner decided by ordering, so it is refused at the
// authoring surface where an operator can be told which row already claims it. 081 enforced this for
// paths with a unique index; targets need the same answer in words.
async function assertNoTargetClash(projectId, keys, exceptId = null) {
  if (!keys.length) return;
  const rows = await q(
    `SELECT id, title, targets FROM project_doc
      WHERE project_id=$1 AND targets && $2::text[] ${exceptId ? 'AND id<>$3' : ''}`,
    exceptId ? [projectId, keys, exceptId] : [projectId, keys]);
  if (!rows.length) return;
  const clash = rows[0].targets.filter((k) => keys.includes(k));
  throw new Error(`another doc in this project already generates ${clash.map((k) => targetByKey(k)?.path || k).join(', ')}`
    + `${rows[0].title ? ` (“${rows[0].title}”)` : ''} — edit that one, or turn the provider off there first`);
}

export async function createProjectDoc(projectId, { rel_path = null, targets = null, title = null,
                                                    body = '', enabled = true, sort = 0 } = {}) {
  // No targets and no path on a CREATE means "I just pasted the contents" — the flow this whole
  // change is for. Default to the registry's defaults (AGENTS.md + CLAUDE.md) rather than making an
  // operator choose filenames before they are allowed to write anything.
  const m = resolveMode({ rel_path, targets }, { fallbackToDefaults: true });
  if (m.rel_path) {
    const dup = await one(`SELECT id FROM project_doc WHERE project_id=$1 AND lower(rel_path)=lower($2)`,
      [projectId, m.rel_path]);
    if (dup) throw new Error(`this project already has a doc at ${m.rel_path}`);
  }
  await assertNoTargetClash(projectId, m.targets);
  const row = await one(
    `INSERT INTO project_doc (project_id, rel_path, targets, title, body, enabled, sort)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [projectId, m.rel_path, m.targets, title || null, String(body || ''), !!enabled, Number(sort) || 0]);
  logline('project-doc', `${docLabel(row)}: created for project ${String(projectId).slice(0, 8)} `
    + `(${String(body || '').length} chars)`);
  await pushDocsToLiveXells(projectId).catch(() => {});
  return row;
}

export async function updateProjectDoc(id, patch = {}) {
  const cur = await one(`SELECT * FROM project_doc WHERE id=$1`, [id]);
  if (!cur) throw new Error('no such project doc');
  // A patch that mentions neither key leaves the mode alone; mentioning either RE-decides it, so
  // switching a custom-path row to providers is `{ targets: [...], rel_path: null }`.
  const touches = 'rel_path' in patch || 'targets' in patch;
  const m = touches
    ? resolveMode({ rel_path: 'rel_path' in patch ? patch.rel_path : null,
                    targets: 'targets' in patch ? patch.targets : null })
    : { rel_path: cur.rel_path, targets: cur.targets || [] };
  if (m.rel_path && m.rel_path.toLowerCase() !== String(cur.rel_path || '').toLowerCase()) {
    const dup = await one(`SELECT id FROM project_doc WHERE project_id=$1 AND lower(rel_path)=lower($2) AND id<>$3`,
      [cur.project_id, m.rel_path, id]);
    if (dup) throw new Error(`this project already has a doc at ${m.rel_path}`);
  }
  await assertNoTargetClash(cur.project_id, m.targets, id);
  const row = await one(
    `UPDATE project_doc SET rel_path=$2, targets=$3, title=$4, body=$5, enabled=$6, sort=$7, updated_at=now()
      WHERE id=$1 RETURNING *`,
    [id, m.rel_path, m.targets, 'title' in patch ? (patch.title || null) : cur.title,
     'body' in patch ? String(patch.body || '') : cur.body,
     'enabled' in patch ? !!patch.enabled : cur.enabled,
     'sort' in patch ? (Number(patch.sort) || 0) : cur.sort]);
  logline('project-doc', `${docLabel(row)}: updated (${row.body.length} chars${row.enabled ? '' : ', DISABLED'})`);
  await pushDocsToLiveXells(cur.project_id).catch(() => {});
  return row;
}

// How a row is named in a log line a human reads: the files it generates, not its uuid.
function docLabel(row) {
  const paths = docTargets(row).map((t) => t.path);
  return paths.length ? paths.join(' + ') : (row.rel_path || String(row.id).slice(0, 8));
}

// The targets of one row — registry entries, or the single pseudo-target a custom-path row is. The
// pseudo-target carries no `reads` (nobody can say which tool opens a path an operator invented) and
// no frontmatter, so the renderer below needs no special case for it.
function docTargets(row) {
  const keys = Array.isArray(row.targets) ? row.targets : [];
  if (keys.length) {
    // Unknown keys can only come from a retired registry entry (data outlives code): keep the row
    // usable and let the caller log what it skipped rather than throwing on every generation.
    return keys.map((k) => targetByKey(k)).filter(Boolean);
  }
  return row.rel_path
    ? [{ key: 'custom', path: row.rel_path, label: row.rel_path, reads: [], url: null, frontmatter: null }]
    : [];
}

// WHAT WILL ACTUALLY BE WRITTEN — the console's preview, and the only place an operator can see the
// difference between what they typed and what an agent reads. Everything an author cannot see, they
// cannot trust: the stamp, the sibling list and the stack appendix are all added below the textbox,
// and until this existed the first person to lay eyes on the real file was a zee in a cage.
//
// It runs the REAL generator (no second renderer to drift), for a real xell when one is named. The
// xell must belong to this project — a preview is a read, but a read that could name any xell in the
// fleet is still a way to learn another project's container names.
export async function previewProjectDoc(docId, { xellId = null } = {}) {
  const row = await one(`SELECT * FROM project_doc WHERE id=$1`, [docId]);
  if (!row) throw new Error('no such project doc');
  let xell = null;
  if (xellId) {
    xell = await one(`SELECT id, slug FROM xell WHERE id=$1 AND project_id=$2`, [xellId, row.project_id]);
    if (!xell) throw new Error('that xell is not this project\'s');
  } else {
    // Default to a real xell of this project, newest first, so the preview shows a live stack section
    // rather than the emptier file a project with no xells would get.
    xell = await one(
      `SELECT id, slug FROM xell WHERE project_id=$1 AND status NOT IN ('retired','husk','tearing-down')
        ORDER BY created_at DESC LIMIT 1`, [row.project_id]);
  }
  const files = await projectDocFiles(row.project_id, { xellId: xell?.id || null });
  const mine = new Set(docTargets(row).map((t) => t.path));
  return {
    doc_id: row.id,
    xell: xell ? { id: xell.id, slug: xell.slug } : null,
    // Said plainly: with no xell there is no stack section, and an operator comparing two previews
    // must know which of the two they are looking at.
    note: xell
      ? `Generated as it would land in xell ${xell.slug} — the stack section is that xell's own.`
      : 'This project has no live xell, so the preview carries no stack section. A real injection into '
        + 'a xell appends its containers, ports, database and build verbs.',
    files: files.filter((f) => mine.has(f.relPath)),
  };
}

export async function deleteProjectDoc(id) {
  // RETURNING the whole row, not just rel_path: a source row's path is NULL (its filenames come from
  // `targets`), and "null: deleted" in the queenzee log names nothing a human can act on.
  const row = await one(`DELETE FROM project_doc WHERE id=$1 RETURNING *`, [id]);
  if (row) logline('project-doc', `${docLabel(row)}: deleted — new xells stop receiving it, and a zee `
    + 'already working keeps the copy it was given');
  return { deleted: !!row };
}

// The stamp every generated doc opens with. Same reasoning as the harness banner: these files look
// exactly like committed repo files, and an agent that "fixes" one is editing an artefact that the
// next assignment overwrites — an edit that lands in no diff and reaches nobody.
//
// It also names the SIBLINGS generated from the same source. Without that, a repo with CLAUDE.md and
// AGENTS.md side by side reads as two documents that happen to agree, and the first person to edit
// one believes they have changed the project's instructions.
export function docBanner(relPath, { reads = [], siblings = [] } = {}) {
  const L = [`<!-- GENERATED by ZEEHIVE — \`${relPath}\`, this project's entry-point doc.`];
  if (reads.length) L.push(`     Read by: ${reads.join(', ')}.`);
  L.push("     The SOURCE is the project's Docs tab in the ZEEHIVE console (one text, kept in the");
  L.push('     meta-DB), not this file.');
  if (siblings.length) {
    L.push(`     The same source also generates: ${siblings.join(', ')} — for other AI providers.`);
    L.push('     They are copies of one text; editing them separately is how they drift apart.');
  }
  L.push('     Written into this xell when a zee was assigned to it, and rewritten whenever it changes.');
  L.push('     Editing THIS copy changes nothing: it is git-excluded, lands in no diff, and is overwritten. -->');
  return L.join('\n');
}

// One provider file, rendered. Order matters: a tool that needs YAML frontmatter (Cursor's .mdc,
// Windsurf's rules) only honours it at byte 0, so it goes ABOVE the stamp; the project's own words
// come next because they are what the reader came for; the xell stack lands last, as an appendix.
function renderDoc({ target, body, siblings, stack }) {
  const parts = [];
  if (target.frontmatter) parts.push(`---\n${target.frontmatter}\n---\n`);
  parts.push(docBanner(target.path, { reads: target.reads || [], siblings }));
  parts.push('');
  parts.push(String(body).trim());
  if (stack) { parts.push(''); parts.push(stack.trimEnd()); }
  return `${parts.join('\n')}\n`;
}

// The files to generate for a project, in injection order — one per enabled row per target.
//
// Disabled rows are skipped, and an empty body is skipped too: writing a file that says nothing is
// worse than writing none, because a zee then believes it has read the project's instructions.
//
// `xellId` is what makes the stack appendix real. It is resolved ONCE here rather than per file: the
// six files a project generates describe the same xell, and querying six times would only invite them
// to disagree. Without a xellId (a caller with no xell — a preview, a test) the instructions are still
// generated; only the appendix is absent.
export async function projectDocFiles(projectId, { xellId = null } = {}) {
  const rows = await listProjectDocs(projectId, { enabledOnly: true });
  const live = rows.filter((r) => String(r.body || '').trim());
  if (!live.length) return [];
  // NEVER let a stack lookup cost a project its instructions: a doc with no appendix still tells an
  // agent how the repo works, and the failure is logged rather than thrown.
  let stack = null;
  if (xellId) {
    stack = await xellStackMarkdown(xellId).catch((e) => {
      logline('project-doc', `could not resolve the xell stack for the generated docs `
        + `(${String(e.message).slice(0, 100)}) — the files are generated without their stack section`);
      return null;
    });
  }
  const files = [];
  const claimed = new Map();     // lower(path) → the row that got there first
  for (const r of live) {
    const targets = docTargets(r);
    const paths = targets.map((t) => t.path);
    for (const t of targets) {
      const key = t.path.toLowerCase();
      if (claimed.has(key)) {
        // Should be unreachable (the authoring surface refuses a clash), but data outlives the code
        // that validated it. Say which row won, out loud — a file quietly holding another row's text
        // is worse than either row.
        logline('project-doc', `${t.path}: generated from one source only — two enabled docs claim it, `
          + `keeping the first (${claimed.get(key)})`);
        continue;
      }
      claimed.set(key, docLabel(r));
      files.push({
        relPath: t.path,
        target: t.key,
        text: renderDoc({ target: t, body: r.body, stack, siblings: paths.filter((p) => p !== t.path) }),
      });
    }
    if (!targets.length) {
      logline('project-doc', `a doc row for project ${String(projectId).slice(0, 8)} generates NOTHING `
        + `(targets ${JSON.stringify(r.targets)} match no known provider) — nobody receives it`);
    }
  }
  return files;
}

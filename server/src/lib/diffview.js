// THE DIFF VIEWER's read model — the PATCH behind a diffstat.
//
// The console has always shown a diff as three numbers ("4f +182/−31") on the xell card, on the
// hive flower, and on a held landing. Numbers are a summary of a decision a human is being asked to
// make — "approve this landing" — and the only place the actual change could be read was a terminal
// on the host, which the console user does not have. So a human either approved on trust or went
// looking. This module answers the other half of the question: given a diffstat you can see, hand
// back the lines it is counting.
//
// Two sources, because the numbers themselves come from two places (see lib/timeline.js getDiffs):
//   • a RANGE in the xource (old..new) — what a landing/PR would add to main. Read from repo_root:
//     xell worktrees share its object store, so the commits are already there.
//   • a LIVE tree — the xell's worktree, or, for a CXELLD zee, the private clone INSIDE its cxell
//     (where the work actually is until it lands). Same fallback order as getDiffs, so the viewer
//     can never disagree with the stat that opened it.
//
// Everything here is READ-ONLY git, capped in three directions (whole payload, per file, file
// count) so that one runaway diff can neither wedge the queenzee nor blow up the browser. A cap
// that fires is reported (`truncated`), never silently applied.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { q, one } from '../db/pool.js';
import { cleanGitEnv } from './git.js';
import { cxellPatch } from './cxell.js';

// git's own name for "nothing" — diffing against it renders an initial/rootless commit as one big
// addition instead of failing on a missing parent.
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export const MAX_PATCH_BYTES = 4_000_000;   // whole payload
export const MAX_FILE_BYTES = 240_000;      // one file's patch
export const MAX_FILES = 400;               // files carried
const MAX_UNTRACKED = 80;                   // untracked files synthesised into the patch
const MAX_UNTRACKED_BYTES = 120_000;        // per untracked file we read off disk

const SHA = /^[0-9a-fA-F]{4,40}$/;
const ZERO = /^0+$/;
export const isSha = (s) => SHA.test(String(s || ''));
// A ref we are willing to hand git: a sha, or a ref NAME (`main`, `origin/main`, `HEAD~2`). No
// whitespace, no leading `-` (git would read that as a FLAG), bounded length. Everything reaching
// here comes from our own DB or a project row, so this is a belt on top of braces.
export const safeRef = (s) => {
  const r = String(s || '').trim();
  return !!r && r.length <= 200 && !r.startsWith('-') && !/[\s\0]/.test(r);
};

// A capped, non-blocking git read. Kills the child the moment output passes the cap: `git diff` of a
// vendored folder is unbounded, and the queenzee must not buffer it whole to then throw it away.
function gitOut(cwd, args, { maxBytes = MAX_PATCH_BYTES, timeout = 25000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn('git', ['-C', cwd, '--no-pager', ...args], { windowsHide: true, env: cleanGitEnv() });
    let out = '', err = '', capped = false;
    const t = setTimeout(() => p.kill(), timeout);
    p.stdout.on('data', (d) => {
      if (capped) return;
      out += d.toString();
      if (out.length > maxBytes) { capped = true; out = out.slice(0, maxBytes); p.kill(); }
    });
    p.stderr.on('data', (d) => { if (err.length < 4000) err += d.toString(); });
    p.on('error', (e) => { clearTimeout(t); resolve({ status: -1, out, err: err || e.message, capped }); });
    p.on('close', (status) => { clearTimeout(t); resolve({ status: capped ? 0 : status, out, err, capped }); });
  });
}

// ── patch → files ───────────────────────────────────────────────────────────────────────────────
// One `git diff` is a concatenation of per-file patches, each opening with `diff --git`. The client
// wants them as a LIST (a file rail, per-file collapse), so the split happens here, once, where the
// per-file cap can be applied at a line boundary instead of mid-hunk.

const unquote = (p) => {
  if (!p.startsWith('"')) return p;
  try { return JSON.parse(p); } catch { return p.slice(1, -1); }
};
// `--- a/x` / `+++ b/x` — strip the a/ b/ prefix, and answer null for /dev/null (add/delete side).
const stripPrefix = (raw) => {
  const s = unquote(String(raw).trim());
  if (s === '/dev/null') return null;
  return s.replace(/^[abciwo]\//, '');
};

export function parseFilePatch(chunk, { maxFileBytes = MAX_FILE_BYTES } = {}) {
  const lines = chunk.split('\n');
  let status = 'modified', binary = false, path = null, oldPath = null, mode = null;
  let hunkAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('@@')) { hunkAt = i; break; }
    if (l.startsWith('new file mode')) { status = 'added'; mode = l.slice(14).trim(); }
    else if (l.startsWith('deleted file mode')) { status = 'deleted'; mode = l.slice(18).trim(); }
    else if (l.startsWith('rename from ')) { status = 'renamed'; oldPath = unquote(l.slice(12).trim()); }
    else if (l.startsWith('rename to ')) { path = unquote(l.slice(10).trim()); }
    else if (l.startsWith('copy to ')) { status = 'copied'; path = unquote(l.slice(8).trim()); }
    else if (l.startsWith('--- ')) { const p = stripPrefix(l.slice(4)); if (p) oldPath = p; }
    else if (l.startsWith('+++ ')) { const p = stripPrefix(l.slice(4)); if (p) path = p; }
    else if (l.startsWith('Binary files') || l.startsWith('GIT binary patch')) binary = true;
  }
  // Fallback for a header with no ---/+++ pair at all (a pure mode change, a binary file): read the
  // paths off the `diff --git a/x b/y` line. Ambiguous for paths containing " b/", which is why it
  // is the fallback and not the primary.
  if (!path || !oldPath) {
    const m = lines[0]?.match(/^diff --git (?:"?a\/)(.*?)"? (?:"?b\/)(.*?)"?$/);
    if (m) { oldPath = oldPath || unquote(m[1]); path = path || unquote(m[2]); }
  }
  path = path || oldPath || '(unknown)';
  oldPath = oldPath || path;

  let insertions = 0, deletions = 0;
  if (hunkAt >= 0) {
    for (let i = hunkAt; i < lines.length; i++) {
      const c = lines[i][0];
      if (c === '+' && !lines[i].startsWith('+++')) insertions++;
      else if (c === '-' && !lines[i].startsWith('---')) deletions++;
    }
  }

  let patch = chunk, truncated = false;
  if (patch.length > maxFileBytes) {
    patch = patch.slice(0, maxFileBytes);
    patch = patch.slice(0, patch.lastIndexOf('\n') + 1 || patch.length);
    truncated = true;
  }
  return {
    path, old_path: oldPath === path ? null : oldPath,
    status: binary ? (status === 'modified' ? 'binary' : status) : status,
    binary, mode, insertions, deletions, truncated, patch,
  };
}

// Split a whole `git diff` into per-file patches. Exported (and pure) so the parser is testable
// without a repo — it is the one piece of this module that has to be exactly right.
export function splitPatch(text, { maxFileBytes = MAX_FILE_BYTES, maxFiles = MAX_FILES } = {}) {
  const src = String(text || '');
  const starts = [];
  const re = /^diff --git .*$/gm;
  let m;
  while ((m = re.exec(src)) !== null) starts.push(m.index);
  const files = [];
  for (let i = 0; i < starts.length; i++) {
    const chunk = src.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : src.length);
    if (files.length >= maxFiles) break;
    files.push(parseFilePatch(chunk, { maxFileBytes }));
  }
  return { files, files_total: starts.length, truncated: starts.length > files.length };
}

const totals = (files) => files.reduce((a, f) => ({
  files: a.files + 1, insertions: a.insertions + f.insertions, deletions: a.deletions + f.deletions,
}), { files: 0, insertions: 0, deletions: 0 });

function payload({ source, base_ref, head_ref, label, text, capped, extra = [], note = null }) {
  const { files, files_total, truncated } = splitPatch(text);
  const all = [...files, ...extra].slice(0, MAX_FILES);
  return {
    ok: true, source, base: base_ref || null, head: head_ref || null, label: label || null,
    files: all, files_total: files_total + extra.length,
    truncated: truncated || capped || all.length < files_total + extra.length,
    stat: totals(all), note,
  };
}

// ── untracked files ─────────────────────────────────────────────────────────────────────────────
// `git diff` cannot see a file git has never been told about, so a zee that added five new files and
// has not committed reads as an empty patch — the exact moment the viewer is most wanted. Synthesise
// each untracked file as an all-additions patch (what `git diff --no-index /dev/null f` would print),
// which keeps the client's parser to ONE format.
function synthUntracked(worktree, relPath) {
  const abs = join(worktree, relPath);
  let st;
  try { st = statSync(abs); } catch { return null; }
  if (!st.isFile()) return null;
  const header = `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relPath}\n`;
  if (st.size > MAX_UNTRACKED_BYTES) {
    return { path: relPath, old_path: null, status: 'untracked', binary: false, mode: null,
             insertions: 0, deletions: 0, truncated: true,
             patch: `${header}@@ -0,0 +1 @@\n+(new file, ${st.size} bytes — too large to preview)\n` };
  }
  let buf;
  try { buf = readFileSync(abs); } catch { return null; }
  if (buf.includes(0)) {
    return { path: relPath, old_path: null, status: 'untracked', binary: true, mode: null,
             insertions: 0, deletions: 0, truncated: false,
             patch: `${header}Binary files /dev/null and b/${relPath} differ\n` };
  }
  const body = buf.toString('utf8');
  const lines = body.split('\n');
  const noEol = lines[lines.length - 1] !== '';
  if (!noEol) lines.pop();
  const patch = header + `@@ -0,0 +1,${lines.length} @@\n`
    + lines.map((l) => `+${l}`).join('\n') + '\n' + (noEol ? '\\ No newline at end of file\n' : '');
  return { path: relPath, old_path: null, status: 'untracked', binary: false, mode: null,
           insertions: lines.length, deletions: 0, truncated: false, patch };
}

async function untrackedFiles(worktree) {
  const r = await gitOut(worktree, ['ls-files', '--others', '--exclude-standard', '-z'], { maxBytes: 200_000 });
  if (r.status !== 0) return [];
  const rel = r.out.split('\0').filter(Boolean).slice(0, MAX_UNTRACKED);
  return rel.map((p) => synthUntracked(worktree, p)).filter(Boolean);
}

// ── the two public reads ────────────────────────────────────────────────────────────────────────

// A RANGE in a repo: what `old..new` adds. Used by the landing/PR gate — the human is deciding on
// exactly these commits, so the patch is read at exactly those shas.
export async function rangePatch(repoRoot, oldSha, newSha, { label = null } = {}) {
  if (!repoRoot || !existsSync(repoRoot)) return { ok: false, error: 'the project repo is not on disk here' };
  const head = String(newSha || '').trim();
  if (!safeRef(head)) return { ok: false, error: 'bad head ref' };
  const from = !oldSha || ZERO.test(String(oldSha)) ? EMPTY_TREE : String(oldSha).trim();
  if (!safeRef(from)) return { ok: false, error: 'bad base ref' };
  // `--` closes the rev list, so a ref can never be re-read as a git flag (git is spawned without
  // a shell, so that is the only injection shape that matters here).
  const r = await gitOut(repoRoot, ['diff', '--no-color', '-M', from, head, '--']);
  if (r.status !== 0) {
    return { ok: false, error: (r.err || 'git diff failed').trim().split('\n')[0],
             base: from, head, source: 'repo' };
  }
  return payload({ source: 'repo', base_ref: from, head_ref: head, label, text: r.out, capped: r.capped });
}

// The patch behind a LANDING (or a PR — both are land_request rows): old_sha..new_sha in the xource.
export async function landRequestPatch(id) {
  // xell_slug is a JOIN in the console's list model, not a column — read it the same way here so
  // the viewer's title says WHO is landing rather than "a xell".
  const row = await one(
    `SELECT lr.*, x.slug AS xell_slug FROM land_request lr
       LEFT JOIN xell x ON x.id = lr.xell_id WHERE lr.id=$1`, [id]);
  if (!row) throw new Error('no such land request');
  const project = await one(`SELECT * FROM project WHERE id=$1`, [row.project_id]);
  if (!project) throw new Error('the land request has no project');
  const out = await rangePatch(project.repo_root, row.old_sha, row.new_sha,
    { label: `${row.xell_slug || 'a xell'} → ${String(row.ref || '').replace('refs/heads/', '')}` });
  return { ...out, kind: 'land', land_request: row.id, project: project.id };
}

// Is a LIVE cxell zee driving this xell? Same live-status set as timeline.getDiffs — if it is, the
// work is in the cxell and the host worktree is frozen at the provisioning base, so reading the
// worktree would hand back an empty patch for a zee that has written all day.
async function hasLiveCxell(xellId) {
  const r = await one(
    `SELECT 1 AS yes FROM zee z JOIN agent_runtime r ON r.id = z.runtime_id
       WHERE r.key = 'claude-code-cxell'
         AND z.status IN ('spawning','online','working','idle')
         AND z.xell_id = $1 LIMIT 1`, [xellId]);
  return !!r;
}

// A XELL's live patch, in the two flavours its card shows numbers for:
//   source (default) — everything this xell adds over its fork point: what would land, committed or not.
//   own              — only what is not checkpointed yet (worktree vs its own HEAD).
export async function xellPatch(xellId, { kind = 'source' } = {}) {
  const x = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
  if (!x) throw new Error('no such xell');
  const project = await one(`SELECT * FROM project WHERE id=$1`, [x.project_id]);
  if (!project) throw new Error('this xell has no project');
  const branch = project.main_branch || 'main';
  const want = kind === 'own' ? 'own' : 'source';
  const meta = { kind: want, xell: x.id, slug: x.slug, project: project.id };

  // PRODUCTION is a xell too, and its "source diff" means something else: what is DEPLOYED vs the
  // origin mirror. It has no worktree and no zee, so answer it from the recorded ship or say why not.
  if (x.is_production) {
    if (want === 'own') return { ...meta, ok: true, source: 'repo', files: [], files_total: 0, truncated: false,
                                 stat: { files: 0, insertions: 0, deletions: 0 },
                                 note: 'production has no working tree — there is no uncommitted work to show' };
    const shipped = await one(
      `SELECT commit FROM ship_request WHERE project_id=$1 AND status='shipped'
         ORDER BY finished_at DESC NULLS LAST LIMIT 1`, [project.id]);
    if (!shipped?.commit) {
      return { ...meta, ok: false, error: 'no ship has landed yet, so nothing recorded what production is running' };
    }
    return { ...meta, ...await rangePatch(project.repo_root, shipped.commit, `origin/${branch}`,
      { label: `deployed ${String(shipped.commit).slice(0, 8)} → origin/${branch}` }) };
  }

  // CXELLD zee: read from inside the cage, where the work lives.
  if (x.head_commit && await hasLiveCxell(x.id)) {
    const p = await cxellPatch({ ctx: 'default', slug: x.slug, base: x.head_commit, kind: want,
                                 maxBytes: MAX_PATCH_BYTES }).catch(() => null);
    if (p) {
      return { ...meta, ...payload({
        source: 'cxell',
        base_ref: want === 'own' ? p.head || 'HEAD' : x.head_commit,
        head_ref: p.head || null,
        label: `${x.slug} · in its cxell${want === 'own' ? ' · uncommitted' : ''}`,
        text: p.text, capped: p.capped,
        note: want === 'source'
          ? 'read from inside the cxell — this is the zee\'s work, committed and not, since it was spun up'
          : 'read from inside the cxell — work not yet checkpointed',
      }) };
    }
  }

  // HOST WORKTREE. The source diff is measured from the FORK POINT, exactly as worktreeDiff does —
  // diffing against the branch TIP folds the source's own progress in as phantom deletions.
  if (x.worktree_path && existsSync(x.worktree_path)) {
    let base = 'HEAD';
    if (want === 'source') {
      const mb = await gitOut(x.worktree_path, ['merge-base', branch, 'HEAD'], { maxBytes: 200 });
      base = mb.status === 0 && mb.out.trim() ? mb.out.trim() : branch;
    }
    const r = await gitOut(x.worktree_path, ['diff', '--no-color', '-M', base]);
    if (r.status !== 0) return { ...meta, ok: false, error: (r.err || 'git diff failed').trim().split('\n')[0] };
    const hd = await gitOut(x.worktree_path, ['rev-parse', 'HEAD'], { maxBytes: 200 });
    const extra = await untrackedFiles(x.worktree_path);
    return { ...meta, ...payload({
      source: 'worktree', base_ref: base, head_ref: hd.status === 0 ? hd.out.trim() : null,
      label: `${x.slug} · worktree${want === 'own' ? ' · uncommitted' : ''}`,
      text: r.out, capped: r.capped, extra,
      note: extra.length ? `${extra.length} untracked file(s) included — git diff cannot see them` : null,
    }) };
  }

  // No worktree on disk (simulate mode / a xell whose folder is gone): fall back to the same
  // base-vs-source comparison getDiffs uses there, so the viewer still answers something true.
  if (want === 'source' && x.head_commit) {
    return { ...meta, ...await rangePatch(project.repo_root, x.head_commit, branch,
      { label: `${x.slug} · ${String(x.head_commit).slice(0, 8)} → ${branch} (no worktree on disk)` }) };
  }
  return { ...meta, ok: false, error: 'no worktree on disk for this xell' };
}

// The XOURCE's live dirty patch — what the broken-pipe modal previews. Three scopes match the
// three buckets a human acts on from that tip:
//   staged   — `git diff --cached` (what Commit it would land)
//   unstaged — worktree vs index + untracked (what is dirty but not in the index)
//   all      — worktree vs HEAD + untracked (the whole wedge landings refuse over)
// Read-only, same caps as every other patch. .claude/ untracked paths are filtered out — those
// are xell worktrees, never "rogue" xource dirt.
export async function xourcePatch(projectId, { scope = 'all' } = {}) {
  const project = await one(`SELECT * FROM project WHERE id=$1`, [projectId]);
  if (!project) throw new Error('no such project');
  const dir = project.repo_root;
  if (!dir || !existsSync(dir)) return { ok: false, error: 'the project xource is not on disk here' };
  const want = scope === 'staged' ? 'staged' : scope === 'unstaged' ? 'unstaged' : 'all';
  const main = project.main_branch || 'main';
  const meta = { kind: 'xource', scope: want, project: project.id, source: 'xource' };

  let args;
  if (want === 'staged') args = ['diff', '--no-color', '-M', '--cached'];
  else if (want === 'unstaged') args = ['diff', '--no-color', '-M'];
  else args = ['diff', '--no-color', '-M', 'HEAD'];

  const r = await gitOut(dir, args);
  // git diff exits 0 with empty output when clean; non-zero is a real failure (bad repo, etc.).
  if (r.status !== 0) {
    return { ...meta, ok: false, error: (r.err || 'git diff failed').trim().split('\n')[0],
      base: want === 'staged' ? 'HEAD' : (want === 'all' ? 'HEAD' : 'index'),
      head: want === 'staged' ? 'index' : 'worktree' };
  }

  let extra = [];
  if (want !== 'staged') {
    const ut = await untrackedFiles(dir);
    // Xell worktrees live under .claude/ and must never appear as "rogue xource files".
    extra = ut.filter((f) => f && f.path && !String(f.path).startsWith('.claude'));
  }

  const hd = await gitOut(dir, ['rev-parse', 'HEAD'], { maxBytes: 200 });
  const head = hd.status === 0 ? hd.out.trim() : null;
  const labels = {
    staged: `${project.name} · xource staged (what Commit would land)`,
    unstaged: `${project.name} · xource unstaged + untracked`,
    all: `${project.name} · xource all uncommitted`,
  };
  return {
    ...meta,
    ...payload({
      source: 'xource',
      base_ref: want === 'staged' ? (head || 'HEAD') : (want === 'all' ? (head || 'HEAD') : 'index'),
      head_ref: want === 'staged' ? 'index' : 'worktree',
      label: labels[want],
      text: r.out, capped: r.capped, extra,
      note: want === 'staged'
        ? 'staged index on the main checkout — landings refuse over this'
        : (extra.length
          ? `${extra.length} untracked file(s) included (.claude/ worktrees excluded)`
          : null),
    }),
    main_branch: main,
  };
}

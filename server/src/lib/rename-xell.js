// Give a xell a human-trackable name once we know what it's FOR.
//
// The pool mints worktrees before any task exists, so they carry random slugs
// ("calm-summit-403da6"). Claude Code's sidebar names a worktree by its folder, so that random
// name is what a human has to track — and no session title can change it. When a xell is
// dispatched we finally know the job, so we rename the worktree + branch to match.
//
// Ports and container names are derived from the folder basename (spin-env.sh), so a rename moves
// them too. That is safe ONLY before anything is built — hence the guard. The git work lives in
// scripts/rename-xell.sh (queenzee-run); this projector guards it and lands the DB atomically.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { pool, q, one } from '../db/pool.js';
import { broadcast } from '../lib/events.js';
import { cleanGitEnv } from '../lib/git.js';
import { computePorts, emitXellEnv } from '../lib/provision.js';
import { namingFor } from '../lib/manifest.js';
import { logline } from '../lib/logbus.js';
import { resolveBash } from './bash.js';

const MAX_BASE = 44; // keep the folder name (and the container names built from it) sane

// "Night shift punch pairing in DTR view" → "night-shift-punch-pairing-in-dtr-view"
export function slugifyTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_BASE)
    .replace(/-+$/g, '');
}

// Two xells dispatched from similarly-named sessions must not collide, so keep the original
// slug's random suffix as the uniquifier: "calm-summit-403da6" → "…-403da6".
const suffixOf = (slug) => String(slug || '').split('-').pop();

// Is it safe to rename? Only before anything is built: container names + ports hash off the
// folder, so renaming after a build would orphan the running containers and shift their ports.
export async function canRename(xellId) {
  const built = await q(
    `SELECT id FROM container
       WHERE owner_xell_id=$1 AND (last_build_commit IS NOT NULL OR health IN ('up','building'))`,
    [xellId]);
  if (built.length) return { ok: false, reason: 'xell has built/running containers — renaming would orphan them' };
  return { ok: true };
}

// Rename xell → slug derived from `title`. Returns { renamed, slug, reason }. Never throws:
// a failed rename must not take a dispatch down with it — the xell just keeps its random name.
export async function renameXellForTask(xellId, title) {
  const xell = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
  if (!xell) return { renamed: false, reason: 'no xell' };
  if (xell.is_production) return { renamed: false, reason: 'production is never renamed' };

  const base = slugifyTitle(title);
  if (!base) return { renamed: false, reason: 'no usable title' };
  const newSlug = `${base}-${suffixOf(xell.slug)}`;
  if (newSlug === xell.slug) return { renamed: false, reason: 'already named' };

  const guard = await canRename(xellId);
  if (!guard.ok) { logline('rename', `skipped ${xell.slug}: ${guard.reason}`); return { renamed: false, reason: guard.reason }; }

  const project = await one(
    `SELECT name, manifest, repo_root, dev_host_ip, port_server_base, port_web_base, port_slot_mod
       FROM project WHERE id=$1`, [xell.project_id]);
  const root = String(project.repo_root).replace(/\\/g, '/');

  const script = resolve(config.repoRoot, 'scripts', 'rename-xell.sh');
  const r = spawnSync(resolveBash(), [script, root, xell.slug, newSlug],
    { encoding: 'utf8', timeout: 60000, windowsHide: true, env: cleanGitEnv() });
  const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
  let res = null; try { res = JSON.parse(line); } catch { /* no JSON */ }
  if (!res?.ok) {
    logline('rename', `FAILED ${xell.slug} → ${newSlug}: ${res?.reason || (r.stderr || '').slice(-120)}`);
    return { renamed: false, reason: res?.reason || 'script failed' };
  }

  // Ports/names are a pure function of the slug — recompute so the DB matches what a future
  // build will actually create.
  const ports = computePorts(newSlug, project);
  const worktree = `${root}/.claude/worktrees/${newSlug}`;
  // runner: process rows carry NO image/compose — the rename must not re-stamp them (they were
  // deliberately NULL at provision). Same per-role/tier resolution provision uses.
  const runnerOf = (role) => project.manifest?.roles?.[role]?.runner
    || project.manifest?.tiers?.spinoff?.runner || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [row] } = await client.query(
      `UPDATE xell SET slug=$2, branch=$3, worktree_path=$4, git_dir=$5 WHERE id=$1 RETURNING *`,
      [xellId, newSlug, `spinoff/${newSlug}`, worktree, `${worktree}/.git`]);
    // Names are a pure function of (project naming templates, slug) — same source provision uses.
    // The URL keeps the row's OWN host (project.dev_host_ip is NULL for machine-placed xells —
    // interpolating it wrote literal "http://null:PORT" once already); localhost is the fallback.
    for (const [role, port] of [['server', ports.serverPort], ['webapp', ports.webPort]]) {
      const nm = namingFor(project, role, newSlug);
      const isProc = runnerOf(role) === 'process';
      await client.query(
        `UPDATE container SET name=$2, image_tag=$3, compose_project=$4, host_port=$5,
                url = 'http://' || COALESCE(host(host), $6) || ':' || $5
           WHERE owner_xell_id=$1 AND role=$7`,
        [xellId, nm.container, isProc ? null : nm.image, isProc ? null : nm.composeProject,
         port, project.dev_host_ip || 'localhost', role]);
    }
    await client.query('COMMIT');
    broadcast('xell', row);
    // Ports moved with the slug, so the worktree's .zeehive.env projection is now stale — the
    // exact drift that left ui-revamp's env 16 ports behind its rows. Regenerate; best-effort
    // (the rename itself is already landed and true).
    await emitXellEnv(xellId).catch((e) => logline('rename', `${newSlug}: .zeehive.env not regenerated — ${e.message}`));
    logline('rename', `${xell.slug} → ${newSlug} (worktree + branch + containers + env)`);
    return { renamed: true, slug: newSlug, worktree, from: xell.slug };
  } catch (err) {
    await client.query('ROLLBACK');
    // The git move already happened; the DB says otherwise. Say so loudly rather than pretend.
    logline('rename', `DB update failed after moving ${xell.slug} → ${newSlug}: ${err.message}`);
    return { renamed: false, reason: `db update failed after move: ${err.message}` };
  } finally {
    client.release();
  }
}

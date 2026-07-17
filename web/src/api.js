// Thin client: fetch the fleet read model + subscribe to the SSE stream.
// All read models are project-scoped — pass the selected project id (or null → server
// falls back to the first project).
const pq = (projectId) => (projectId ? `?project=${encodeURIComponent(projectId)}` : '');

export async function getFleet(projectId) {
  const r = await fetch(`/api/fleet${pq(projectId)}`);
  if (!r.ok) throw new Error(`fleet ${r.status}`);
  return r.json();
}

export async function getRuntimes() {
  const r = await fetch('/api/runtimes');
  return r.ok ? r.json() : [];
}

export async function getTimeline(projectId) {
  const r = await fetch(`/api/git/timeline${pq(projectId)}`);
  return r.ok ? r.json() : null;
}

export async function getDiffs(projectId) {
  const r = await fetch(`/api/xell/diffs${pq(projectId)}`);
  return r.ok ? r.json() : {};
}

export async function getLogs(n = 200) {
  const r = await fetch(`/api/logs?n=${n}`);
  return r.ok ? r.json() : [];
}

// ── projects (header menu: list / add / remove / select) ──────────────────────
export async function getProjects() {
  const r = await fetch('/api/projects');
  return r.ok ? r.json() : [];
}

export async function createProject(body) {
  const r = await fetch('/api/projects', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `create failed (${r.status})`);
  return data;
}

export async function deleteProject(id, force = false) {
  const r = await fetch(`/api/projects/${id}${force ? '?force=1' : ''}`, { method: 'DELETE' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `remove failed (${r.status})`);
  return data;
}

export async function updateProject(id, body) {
  const r = await fetch(`/api/projects/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `update failed (${r.status})`);
  return data;
}

// ── deploy sites: where each tier runs + how it's reached (spec §5) ───────────
export async function getDockerContexts() {
  const r = await fetch('/api/docker/contexts');
  const data = await r.json().catch(() => ({ ok: false, contexts: [] }));
  return data.contexts || [];
}

export async function getSites(projectId) {
  const r = await fetch(`/api/projects/${projectId}/sites`);
  return r.ok ? r.json() : [];
}

async function siteCall(url, method, body) {
  const r = await fetch(url, {
    method, headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `site ${method} failed (${r.status})`);
  return data;
}
export const createSite = (projectId, body) => siteCall(`/api/projects/${projectId}/sites`, 'POST', body);
export const updateSite = (siteId, body) => siteCall(`/api/sites/${siteId}`, 'PATCH', body);
export const deleteSite = (siteId, force = false) => siteCall(`/api/sites/${siteId}${force ? '?force=1' : ''}`, 'DELETE');

// ── onboarding surface: probe / readiness / inventory / spawn template / manifest ──
export const probeRepo = (repo_root) => siteCall('/api/projects/probe', 'POST', { repo_root });
export const getReadiness = (projectId) => fetch(`/api/projects/${projectId}/readiness`).then((r) => r.json());
export const getPoolConfig = (projectId) => fetch(`/api/projects/${projectId}/pool-config`).then((r) => r.json());
export const patchPoolConfig = (projectId, body) => siteCall(`/api/projects/${projectId}/pool-config`, 'PATCH', body);
export const getSharedContainers = (projectId) => fetch(`/api/projects/${projectId}/containers`).then((r) => r.json());
export const createSharedContainer = (projectId, body) => siteCall(`/api/projects/${projectId}/containers`, 'POST', body);
export const patchSharedContainer = (id, body) => siteCall(`/api/containers/${id}`, 'PATCH', body);
export const deleteSharedContainer = (id, force = false) => siteCall(`/api/containers/${id}${force ? '?force=1' : ''}`, 'DELETE');
export const getProjectManifestInfo = (projectId) => fetch(`/api/projects/${projectId}/manifest`).then((r) => r.json());
export const refreshProjectManifest = (projectId) => siteCall(`/api/projects/${projectId}/manifest/refresh`, 'POST');
export const draftProjectManifest = (projectId, write = false) => siteCall(`/api/projects/${projectId}/manifest/draft`, 'POST', { write });

// Subscribe to /api/stream for the selected project. Calls onSnapshot(fleet) on the
// initial snapshot and onChange() on every subsequent event (the app re-fetches on change).
export function subscribe(projectId, { onSnapshot, onChange, onStatus, onLog }) {
  const es = new EventSource(`/api/stream${pq(projectId)}`);
  es.addEventListener('snapshot', (e) => onSnapshot(JSON.parse(e.data)));
  for (const type of ['zee', 'xell', 'container', 'task', 'project', 'land', 'ship']) {
    es.addEventListener(type, () => onChange());
  }
  if (onLog) es.addEventListener('log', (e) => onLog(JSON.parse(e.data)));
  es.onopen = () => onStatus?.('live');
  es.onerror = () => onStatus?.('reconnecting');
  return () => es.close();
}

// (Re)build a per-xell container. hot=true → fast reload (lime dot); false → full rebuild.
export async function buildContainer(containerId, hot = false) {
  const r = await fetch(`/api/containers/${containerId}/build`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hot }),
  });
  return r.ok ? r.json() : Promise.reject(await r.json().catch(() => ({ error: r.statusText })));
}

// Build every buildable (server + webapp) container of a xell.
export async function buildXell(xellId, hot = false) {
  const r = await fetch(`/api/xells/${xellId}/build`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hot }),
  });
  return r.ok ? r.json() : Promise.reject(await r.json().catch(() => ({ error: r.statusText })));
}

// Tear a xell down directly — for xells with no task row to "Mark done" (e.g. a dispatched zee
// that reported done). Removes its worktree, branch and per-xell containers.
export async function reapXell(xellId, reason = 'human-cleanup', force = false) {
  const r = await fetch(`/api/xells/${xellId}/reap`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason, force }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `cleanup failed (${r.status})`);
  // The server refuses an ACTIVE xell without force and returns ok:false — surface that as an
  // error rather than letting the caller treat a refusal as a successful teardown.
  if (data?.ok === false) throw new Error(data.error || 'cleanup refused');
  return data;
}

// Change a zee's permission mode (the mode chip on a xell card). The server live-applies when
// it holds the session's handle (headless zees mid-turn); otherwise it records the value and
// returns { applied:false, note } explaining that the running session keeps its own mode.
export async function setZeeMode(zeeId, permission_mode) {
  const r = await fetch(`/api/zees/${zeeId}/mode`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ permission_mode }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `mode change failed (${r.status})`);
  return data;
}

// Open a xell's worktree folder in the host file manager (Explorer on Windows).
export async function revealWorktree(xellId) {
  const r = await fetch(`/api/xells/${xellId}/reveal`, { method: 'POST' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `open failed (${r.status})`);
  return data;
}

// How many ready (pre-warmed) xells queenzee keeps for this project (pool_config.target_ready).
export async function setPoolTarget(target_ready, projectId) {
  const r = await fetch('/api/pool/config', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target_ready, project: projectId }),
  });
  return r.ok ? r.json() : null;
}

export async function setDefaultRuntime(runtime) {
  const r = await fetch('/api/pool/runtime', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtime }),
  });
  return r.ok ? r.json() : null;
}

// ── prod DB backups (panel + settings + all-backups modal) ────────────────────
// Full list + current settings (the modal + settings form). The panel itself reads the
// last-backup summary straight off the fleet snapshot (fleet.backup).
export async function getBackups(projectId) {
  const r = await fetch(`/api/backups${pq(projectId)}`);
  return r.ok ? r.json() : { config: null, backups: [] };
}

export async function setBackupConfig(body) {
  const r = await fetch('/api/backups/config', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `save failed (${r.status})`);
  return data;
}

// Trigger a backup right now (used by the "Back up now" button in the modal).
export async function runBackup(projectId) {
  const r = await fetch('/api/backups/run', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: projectId }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `backup failed (${r.status})`);
  return data;
}

// Reveal a backup file in the host's file manager (Explorer on Windows).
export async function revealBackup(id) {
  const r = await fetch(`/api/backups/${id}/reveal`, { method: 'POST' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `open failed (${r.status})`);
  return data;
}

// Restore a backup into a db container (that container spins until the restore finishes).
export async function restoreBackup(id, container) {
  const r = await fetch(`/api/backups/${id}/restore`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ container }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `restore failed (${r.status})`);
  return data;
}

// ── landing gate (pushes to main held for human verification) ─────────────────
// The panel reads open requests off the fleet snapshot (fleet.landing); this is for the
// full history modal.
export async function getLandRequests(projectId, all = false) {
  const r = await fetch(`/api/land/requests${pq(projectId)}${all ? '&all=1' : ''}`);
  return r.ok ? r.json() : [];
}

// approve → the zee's NEXT push of this exact sha is let through by the xource's update hook.
// reject → that sha is refused for good; re-pushing it will not help.
export async function decideLanding(id, decision, by = 'human@console') {
  const r = await fetch(`/api/land/requests/${id}/${decision}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${decision} failed (${r.status})`);
  return data;
}

// ── shipping to production (zee asks · human approves · queenzee ships) ───────
// approve → the queenzee takes the prod lock and runs the deploy ITSELF, from main.
export async function decideShip(id, decision, by = 'human@console') {
  const r = await fetch(`/api/ship/requests/${id}/${decision}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${decision} failed (${r.status})`);
  return data;
}

// Stop the auto-release countdown — for a human who is actively verifying prod.
export async function holdProdLock(projectId, by = 'human@console') {
  const r = await fetch('/api/prod-lock/hold', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: projectId, by }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `hold failed (${r.status})`);
  return data;
}

export async function forceReleaseProdLock(projectId, by = 'human@console') {
  const r = await fetch('/api/prod-lock/force-release', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: projectId, by }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `release failed (${r.status})`);
  return data;
}

export async function markDone(taskId, doneBy = 'human', force = false) {
  const r = await fetch(`/api/tasks/${taskId}/done`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ done_by: doneBy, force }),
  });
  const data = await r.json().catch(() => ({}));
  // An ACTIVE xell is refused server-side (blocked:true) — don't let that read as "done".
  if (data?.blocked || data?.reap?.ok === false) throw new Error(data?.reap?.error || 'mark done refused');
  return data;
}

// ── a xell and its xource: push / pull / PR ──────────────────────────────────
// None of these is an override. push runs the same gated `git push . HEAD:<ref>` a zee runs;
// accepting a PR fast-forwards to a sha a human read. The gate is upstream of all of them.
async function xellVerb(id, verb, body = {}) {
  const r = await fetch(`/api/xells/${id}/${verb}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `${verb} failed`);
  return data;
}

export const pushXell = (id) => xellVerb(id, 'push');
export const pullXell = (id) => xellVerb(id, 'pull');
export const prXell = (id, note) => xellVerb(id, 'pr', { note });

export async function acceptPull(requestId) {
  const r = await fetch(`/api/land/requests/${requestId}/accept`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || 'accept failed');
  return data;
}

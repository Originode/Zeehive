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

// Subscribe to /api/stream for the selected project. Calls onSnapshot(fleet) on the
// initial snapshot and onChange() on every subsequent event (the app re-fetches on change).
export function subscribe(projectId, { onSnapshot, onChange, onStatus, onLog }) {
  const es = new EventSource(`/api/stream${pq(projectId)}`);
  es.addEventListener('snapshot', (e) => onSnapshot(JSON.parse(e.data)));
  for (const type of ['zee', 'xell', 'container', 'task', 'project']) {
    es.addEventListener(type, () => onChange());
  }
  if (onLog) es.addEventListener('log', (e) => onLog(JSON.parse(e.data)));
  es.onopen = () => onStatus?.('live');
  es.onerror = () => onStatus?.('reconnecting');
  return () => es.close();
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

export async function markDone(taskId, doneBy = 'human') {
  const r = await fetch(`/api/tasks/${taskId}/done`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ done_by: doneBy }),
  });
  return r.json();
}

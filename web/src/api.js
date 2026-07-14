// Thin client: fetch the fleet read model + subscribe to the SSE stream.
export async function getFleet() {
  const r = await fetch('/api/fleet');
  if (!r.ok) throw new Error(`fleet ${r.status}`);
  return r.json();
}

export async function getRuntimes() {
  const r = await fetch('/api/runtimes');
  return r.ok ? r.json() : [];
}

export async function getTimeline() {
  const r = await fetch('/api/git/timeline');
  return r.ok ? r.json() : null;
}

export async function getDiffs() {
  const r = await fetch('/api/xell/diffs');
  return r.ok ? r.json() : {};
}

export async function getLogs(n = 200) {
  const r = await fetch(`/api/logs?n=${n}`);
  return r.ok ? r.json() : [];
}

// Subscribe to /api/stream. Calls onSnapshot(fleet) on the initial snapshot and
// onChange() on every subsequent event (the app re-fetches the fleet on change).
export function subscribe({ onSnapshot, onChange, onStatus, onLog }) {
  const es = new EventSource('/api/stream');
  es.addEventListener('snapshot', (e) => onSnapshot(JSON.parse(e.data)));
  for (const type of ['zee', 'xell', 'container', 'task']) {
    es.addEventListener(type, () => onChange());
  }
  if (onLog) es.addEventListener('log', (e) => onLog(JSON.parse(e.data)));
  es.onopen = () => onStatus?.('live');
  es.onerror = () => onStatus?.('reconnecting');
  return () => es.close();
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

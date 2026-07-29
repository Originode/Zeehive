// Thin client: fetch the fleet read model + subscribe to the SSE stream.
// All read models are project-scoped — pass the selected project id (or null → server
// falls back to the first project).
const pq = (projectId) => (projectId ? `?project=${encodeURIComponent(projectId)}` : '');

export async function getFleet(projectId) {
  const r = await fetch(`/api/fleet${pq(projectId)}`);
  if (!r.ok) throw new Error(`fleet ${r.status}`);
  return r.json();
}

// Lazily stream the xell list as NDJSON so hexagons paint as their data arrives instead of waiting
// for the whole fleet. Calls onXell(xell) per line; resolves with {count} when the stream ends.
// Abortable via an AbortController signal (the caller cancels a stale stream on project switch).
export async function streamFleetXells(projectId, { onXell, signal } = {}) {
  const r = await fetch(`/api/fleet/xells-stream${pq(projectId)}`, { signal });
  if (!r.ok || !r.body) throw new Error(`xells-stream ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let count = 0;
  const handleLine = (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }   // skip a partial/garbled line
    if (msg.type === 'xell' && msg.xell) { onXell?.(msg.xell); count += 1; }
    else if (msg.type === 'error') throw new Error(msg.error || 'stream error');
  };
  // Read chunks, split on newlines, hand each complete line to handleLine.
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  if (buf) handleLine(buf);   // trailing line with no newline
  return { count };
}

export async function getRuntimes() {
  const r = await fetch('/api/runtimes');
  return r.ok ? r.json() : [];
}

// ── dispatch composer (the "+" button): modes, models, and the dispatch itself ──
// The autonomy scale (1=plan … 5=bypass) and the model list power the composer's pickers.
export async function getDispatchModes() {
  const r = await fetch('/api/xell/modes');
  return r.ok ? r.json() : [];
}
export async function getDispatchModels(provider = 'claude') {
  const r = await fetch(`/api/xell/models?provider=${encodeURIComponent(provider)}`);
  return r.ok ? r.json() : [];
}
// Harnesses — the system-wide config layers (persona/skills) a xell can wear. Listed for the
// composer picker + the switch-harness control on a xell card.
//
// `zeeType` narrows the list to what a xell of that TYPE may actually wear (054): a harness carries
// its type's manual, so offering a manager persona in a worker picker would only produce a refusal
// at assign time. Omit it in the harness MANAGER, which edits every persona regardless of type.
export async function getHarnesses(zeeType = null) {
  const r = await fetch(`/api/harnesses${zeeType ? `?zee_type=${encodeURIComponent(zeeType)}` : ''}`);
  return r.ok ? r.json() : [];
}
// Assign/switch a xell's harness (a human action). `harness` is a key/id, or null to clear to core.
export async function assignXellHarness(xellId, harness) {
  const r = await fetch(`/api/xells/${xellId}/harness`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ harness }),
  });
  return r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => ({}))).error || 'assign failed'));
}
// Harness authoring — unlimited DB-owned personas (persona/skills/memory).
const jorreject = async (r, msg) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => ({}))).error || msg)));
export const createHarness = (body) => fetch('/api/harnesses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => jorreject(r, 'create failed'));
export const getHarnessFull = (key) => fetch(`/api/harnesses/${key}/full`).then((r) => jorreject(r, 'load failed'));
export const updateHarness = (key, body) => fetch(`/api/harnesses/${key}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => jorreject(r, 'save failed'));
export const deleteHarness = (key) => fetch(`/api/harnesses/${key}`, { method: 'DELETE' }).then((r) => r.json());

// Dispatch a human-composed prompt EXACTLY like a /xell dispatch: the queenzee claims a ready xell
// for this project and spawns a zee into its worktree with the task (and any pasted images).
// `images` is [{ name, data }] where data is a base64 data URL. Throws with the server's message
// (e.g. "no ready xell available") so the composer can surface it without losing the prompt.
export async function dispatchTask(body) {
  const r = await fetch('/api/xell/dispatch', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `dispatch failed (${r.status})`);
  return data;
}

export async function getTimeline(projectId) {
  const r = await fetch(`/api/git/timeline${pq(projectId)}`);
  return r.ok ? r.json() : null;
}

export async function getDiffs(projectId) {
  const r = await fetch(`/api/xell/diffs${pq(projectId)}`);
  return r.ok ? r.json() : {};
}

// ── the DIFF VIEWER's two reads (the patch behind a diffstat) ─────────────────
// getDiffs above answers "how much" for every xell; these answer "what" for one. Both return the
// server's payload as-is INCLUDING its refusals ({ ok: false, error }) — a diff that cannot be read
// (no worktree, a gc'd sha, an unreachable cxell) is an answer the viewer shows, not an exception.
export async function getXellPatch(xellId, kind = 'source') {
  const r = await fetch(`/api/xells/${xellId}/diff?kind=${encodeURIComponent(kind)}`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok && d.error) return { ok: false, ...d };
  if (!r.ok) throw new Error(`diff ${r.status}`);
  return d;
}

export async function getLandPatch(requestId) {
  const r = await fetch(`/api/land/requests/${requestId}/diff`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok && d.error) return { ok: false, ...d };
  if (!r.ok) throw new Error(`diff ${r.status}`);
  return d;
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
// Durably hide a decided landing's receipt (server records dismissed_at — reloads keep it hidden).
export async function dismissLanding(id) {
  const r = await fetch(`/api/land/requests/${id}/dismiss`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `dismiss failed (${r.status})`);
  return data;
}

// ── provider accounts (masked — the server never returns the token itself). A project can
// hold several accounts of one provider type (e.g. two Claude subscriptions), each its own
// row/button; add with POST, remove per-account by id. ────────────────────────
export const getProviderTokens = (projectId) => fetch(`/api/projects/${projectId}/tokens`).then((r) => r.json());
export const addProviderToken = (projectId, provider, token, label) =>
  siteCall(`/api/projects/${projectId}/tokens`, 'POST', { provider, token, label: label || undefined });
export const deleteProviderAccount = (projectId, accountId) =>
  siteCall(`/api/projects/${projectId}/tokens/account/${accountId}`, 'DELETE');
export const putProviderToken = (projectId, provider, token) =>
  siteCall(`/api/projects/${projectId}/tokens/${provider}`, 'PUT', { token });
export const deleteProviderToken = (projectId, provider) =>
  siteCall(`/api/projects/${projectId}/tokens/${provider}`, 'DELETE');

export const createSite = (projectId, body) => siteCall(`/api/projects/${projectId}/sites`, 'POST', body);
export const updateSite = (siteId, body) => siteCall(`/api/sites/${siteId}`, 'PATCH', body);
export const deleteSite = (siteId, force = false) => siteCall(`/api/sites/${siteId}${force ? '?force=1' : ''}`, 'DELETE');

// ── environments (masked — the server never returns a secret value, only a hint). The meta-DB
// source of truth for the untracked .env; resolved onto a xell by tier (lib/environments.js). ──
export const getEnvironments = (projectId) => fetch(`/api/projects/${projectId}/environments`).then((r) => (r.ok ? r.json() : []));
export const createEnvironment = (projectId, body) => siteCall(`/api/projects/${projectId}/environments`, 'POST', body);
export const updateEnvironment = (envId, body) => siteCall(`/api/environments/${envId}`, 'PATCH', body);
export const deleteEnvironment = (envId, force = false) => siteCall(`/api/environments/${envId}${force ? '?force=1' : ''}`, 'DELETE');
export const getEnvVars = (envId) => siteCall(`/api/environments/${envId}/vars`, 'GET');
export const setEnvVar = (envId, name, value, is_secret) => siteCall(`/api/environments/${envId}/vars/${encodeURIComponent(name)}`, 'PUT', { value, is_secret });
export const deleteEnvVar = (envId, name) => siteCall(`/api/environments/${envId}/vars/${encodeURIComponent(name)}`, 'DELETE');
export const importEnv = (envId, text, is_secret = true) => siteCall(`/api/environments/${envId}/import`, 'POST', { text, is_secret });
export const exportEnv = (envId) => siteCall(`/api/environments/${envId}/export`, 'GET');
export const lintEnv = (envId) => fetch(`/api/environments/${envId}/lint`).then((r) => r.json());
// Extract a xell's CURRENT environment (its live .zeehive.env, else the resolved meta-DB env) as
// full .env text — the "pull out what this xell is running with" reveal.
export const extractXellEnv = (xellId) => siteCall(`/api/xells/${xellId}/env/export`, 'GET');

// ── discover & adopt a site's running stack (read-only docker; adopt models + links to prod) ──
// discoverSite returns {ok, containers[…]} or {ok:false, error} for an unreachable context — the
// caller MUST surface the error, not treat it as an empty stack.
export const discoverSite = (siteId) => fetch(`/api/sites/${siteId}/discover`).then((r) => r.json());
export const adoptContainers = (siteId, containers) =>
  siteCall(`/api/sites/${siteId}/adopt`, 'POST', { containers });

// ── onboarding surface: probe / readiness / inventory / spawn template / manifest ──
export const probeRepo = (repo_root) => siteCall('/api/projects/probe', 'POST', { repo_root });
// the server's repos home (null on a host-era install) — the create form's path hints use it
export const getReposHome = () => fetch('/api/projects/repos-home').then((r) => r.json());
// browse directories on the queenzee's own filesystem (the onboard form's folder picker)
export const listFsDirs = (path) => fetch(`/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`).then((r) => r.json());
// DANGER: purge all non-production xells in a project (project setup → Danger tab)
export const purgeDevXells = (projectId) => siteCall(`/api/projects/${projectId}/purge-dev`, 'POST', {});
// containerized era: mount a HOST folder into /repos (recreates the queenzee's own container)
export const getHostMounts = () => fetch('/api/projects/host-mounts').then((r) => r.json());
export const mountHostFolder = (host_path, name) => siteCall('/api/projects/mount-host', 'POST', { host_path, name: name || undefined });
// GitHub inbound — clone in, pull in. Outbound (push / PR) is opt-in and only surfaces when the
// project's PAT carries write access (githubAccess), and every outbound call is human-confirmed.
export const probeRemote = (url, token) => siteCall('/api/projects/probe-remote', 'POST', { url, token: token || undefined });
export const cloneProject = (body) => siteCall('/api/projects/clone', 'POST', body);
export const pullProject = (projectId) => siteCall(`/api/projects/${projectId}/pull`, 'POST', {});
export const githubAccess = (projectId) => fetch(`/api/projects/${projectId}/github-access`).then((r) => r.json());
export const pushProject = (projectId) => siteCall(`/api/projects/${projectId}/push`, 'POST', {});
export const pullRequestProject = (projectId, opts = {}) => siteCall(`/api/projects/${projectId}/pr`, 'POST', opts);
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
export function subscribe(projectId, { onSnapshot, onChange, onStatus, onLog, onShipLog }) {
  const es = new EventSource(`/api/stream${pq(projectId)}`);
  es.addEventListener('snapshot', (e) => onSnapshot(JSON.parse(e.data)));
  for (const type of ['zee', 'xell', 'container', 'task', 'project', 'land', 'ship', 'work']) {
    es.addEventListener(type, () => onChange());
  }
  if (onLog) es.addEventListener('log', (e) => onLog(JSON.parse(e.data)));
  // Per-ship build feed ({id, role, line}) — rendered live on that ship's own card.
  if (onShipLog) es.addEventListener('ship-log', (e) => onShipLog(JSON.parse(e.data)));
  es.onopen = () => onStatus?.('live');
  es.onerror = () => onStatus?.('reconnecting');
  return () => es.close();
}

// Live clone progress for the onboard form ({name,url,phase,label,pct,overall,detail,done}).
// Its own EventSource rather than a hook into subscribe(): the onboard modal runs before the
// project it is creating exists, so there is no project stream for it to ride on yet.
export function subscribeCloneProgress(onProgress) {
  const es = new EventSource('/api/stream');
  es.addEventListener('clone-progress', (e) => {
    try { onProgress(JSON.parse(e.data)); } catch { /* a malformed frame must not kill the stream */ }
  });
  return () => es.close();
}

// (Re)build a per-xell container. hot=true → fast reload (lime dot); false → full rebuild.
// buildCtx (optional): compile on this docker context now ('' resets to the run host). Omit to
// keep whatever build host the container already has.
export async function buildContainer(containerId, hot = false, buildCtx) {
  const body = { hot, ...(buildCtx !== undefined ? { build_ctx: buildCtx } : {}) };
  const r = await fetch(`/api/containers/${containerId}/build`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.ok ? r.json() : Promise.reject(await r.json().catch(() => ({ error: r.statusText })));
}

// Decommission ONE container (the container context-menu action): stop + remove it, reclaim its
// image, drop its row. The server REFUSES production (ok:false, protected:true) — surface that as
// an error rather than treating a refusal as a teardown.
export async function decommissionContainer(containerId, force = false) {
  const r = await fetch(`/api/containers/${containerId}/decommission`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `decommission failed (${r.status})`);
  if (data?.ok === false) throw new Error(data.error || 'decommission refused');
  return data;
}

// Check ONE db container's schema drift against PRODUCTION on demand (the chip's "Check diff" menu
// item). The server measures it NOW, persists the verdict, and broadcasts the container update — so
// the chip's drift mark repaints over SSE — and returns the payload { ok, total, kinds, same_db,
// error } so the caller can pop a one-line summary.
export async function checkContainerDiff(containerId) {
  const r = await fetch(`/api/containers/${containerId}/check-diff`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `check diff failed (${r.status})`);
  return data;
}

// Duplicate PRODUCTION into a dev db container (the chip's "Duplicate prod" menu item): a prod
// backup + restore fused into one action, so the db becomes an exact copy of live production. The
// server streams pg_dump(prod) → pg_restore(this db) and the container spins until it finishes.
// The server REFUSES a prod target and while prod is in use — surface that refusal as an error.
export async function duplicateProd(containerId) {
  const r = await fetch(`/api/containers/${containerId}/duplicate-prod`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `duplicate prod failed (${r.status})`);
  return data;
}

// Set WHERE a xell's images compile (both server+webapp). build_ctx='' resets to the run host.
// Throws with an actionable message if the context is foreign and no registry is configured.
export async function setXellBuildCtx(xellId, build_ctx) {
  const r = await fetch(`/api/xells/${xellId}/build-ctx`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ build_ctx }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `set build host failed (${r.status})`);
  return data;
}

// Same, but for a single container (server OR webapp) rather than the whole xell.
export async function setContainerBuildCtx(containerId, build_ctx) {
  const r = await fetch(`/api/containers/${containerId}/build-ctx`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ build_ctx }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `set build host failed (${r.status})`);
  return data;
}

// ── machines: the hive's docker hosts (placement, caps, build policy) ─────────
const jsonOrThrow = async (r, what) => {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${what} failed (${r.status})`);
  return data;
};
export async function getMachines() {
  const r = await fetch('/api/machines');
  return jsonOrThrow(r, 'list machines');
}
export async function createMachine(body) {
  const r = await fetch('/api/machines', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return jsonOrThrow(r, 'add machine');
}
export async function updateMachine(id, patch) {
  const r = await fetch(`/api/machines/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
  });
  return jsonOrThrow(r, 'update machine');
}
export async function deleteMachine(id) {
  const r = await fetch(`/api/machines/${id}`, { method: 'DELETE' });
  return jsonOrThrow(r, 'delete machine');
}
// Per-project pool size on a machine — how many ready xells THIS project keeps warm there.
export async function setMachinePool(machineId, projectId, pool_size) {
  const r = await fetch(`/api/machines/${machineId}/pool`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, pool_size }),
  });
  return jsonOrThrow(r, 'set pool size');
}
// Per-project dev spawn priority on a machine — where THIS project's new xells land first.
export async function setMachinePriority(machineId, projectId, dev_priority) {
  const r = await fetch(`/api/machines/${machineId}/priority`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, dev_priority }),
  });
  return jsonOrThrow(r, 'set priority');
}
// Stand up the project's shared dev db ON a machine (background; restores the latest prod backup).
export async function provisionMachineDevDb(machineId, projectId) {
  const r = await fetch(`/api/machines/${machineId}/dev-db`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project_id: projectId }),
  });
  return jsonOrThrow(r, 'provision dev db');
}

// ── device xhips (035): mobile devices as a container role ────────────────────
// The registered SHARED (physical) devices for a project — the pool a xell links from.
export async function getDevices(projectId) {
  const r = await fetch(`/api/devices?project=${encodeURIComponent(projectId)}`);
  return jsonOrThrow(r, 'list devices');
}
// Register a physical phone as a shared device on a can_device machine. transport 'net' (give
// adb_port) or 'usb' (give serial; adb_port defaults to the shared 5037 adb-server).
export async function registerDevice(body) {
  const r = await fetch('/api/devices', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return jsonOrThrow(r, 'register device');
}
// Stand up the shared adb-host on a machine (shares its USB-plugged phones over TCP :5037).
export async function provisionAdbHost(machineId, port) {
  const r = await fetch(`/api/machines/${machineId}/adb-host`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(port ? { port } : {}),
  });
  return jsonOrThrow(r, 'provision adb-host');
}
// The phones plugged into a machine's shared adb host (`adb devices` in the adb-host container).
// ?register=1 auto-registers every discovered serial as a shared USB device row (item #3).
export async function getUsbDevices(machineId, { register = false, projectId = null } = {}) {
  const qs = register ? `?register=1${projectId ? `&project=${encodeURIComponent(projectId)}` : ''}` : '';
  const r = await fetch(`/api/machines/${machineId}/usb-devices${qs}`);
  return jsonOrThrow(r, 'list usb devices');
}
// List the adb devices a machine can see (USB via its adb-host, else the host's network-connected
// phones), each tagged net|usb and marked whether it's already registered for the project.
export async function getAdbDevices(machineId, projectId = null) {
  const r = await fetch(`/api/machines/${machineId}/adb-devices${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`);
  return jsonOrThrow(r, 'list adb devices');
}
// Attach a device to a named xell by id (the dashboard's "attach device"). kind overrides the
// project's manifest default (emulator | physical).
export async function attachXellDevice(xellId, kind = null) {
  const r = await fetch(`/api/xells/${xellId}/device`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(kind ? { kind } : {}),
  });
  return jsonOrThrow(r, 'attach device');
}
// Detach (emulator: stop+remove; physical: unlink) the device attached to a xell.
export async function detachXellDevice(xellId) {
  const r = await fetch(`/api/xells/${xellId}/device`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'detach' }),
  });
  return jsonOrThrow(r, 'detach device');
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

export async function setDefaultRuntime(runtime, project) {
  // project is REQUIRED in practice: without it the server falls back to the oldest project, so
  // toggling the runtime on the Zeehive dashboard silently rewrote OmniBiz's default instead.
  const r = await fetch('/api/pool/runtime', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtime, project }),
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
// confirmProd must be true to restore over the PRODUCTION database (the UI collects a typed
// confirmation first) — the server refuses a prod target otherwise.
// tables — optional array of 'schema.table' strings to restore ONLY those out of the archive.
// null/omitted ⇒ restore the whole dump.
export async function restoreBackup(id, container, confirmProd = false, tables = null) {
  const r = await fetch(`/api/backups/${id}/restore`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ container, confirm_prod: !!confirmProd, tables }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `restore failed (${r.status})`);
  return data;
}

// Delete a single backup (removes the dump file and its row). Refused while it is still running.
export async function deleteBackup(id) {
  const r = await fetch(`/api/backups/${id}`, { method: 'DELETE' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `delete failed (${r.status})`);
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
// siteId (approve only): aim the ship at a chosen prod site — the dialog's target picker when a
// project has more than one production. Omit to ship to the request's recorded (default) site.
// allowStaleCxellImage (approve only): the human's explicit "ship anyway even if the cxell image
// cannot be rebuilt". A failed rebuild normally FAILS the ship; this is the per-ship release valve,
// and it is RECORDED on the request so the audit trail shows a human chose it.
export async function decideShip(id, decision, by = 'human@console', siteId = undefined,
                                 allowStaleCxellImage = false) {
  const r = await fetch(`/api/ship/requests/${id}/${decision}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ by, ...(siteId ? { site_id: siteId } : {}),
                           ...(allowStaleCxellImage ? { allow_stale_cxell_image: true } : {}) }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${decision} failed (${r.status})`);
  return data;
}

// Hide a shipped/failed ship card's receipt (visibility only — the ship itself is unchanged).
export async function dismissShip(id) {
  const r = await fetch(`/api/ship/requests/${id}/dismiss`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  return r.ok ? r.json() : null;
}

// Force-release the prod lock for this ship's site, then approve+ship it — one atomic step for the
// "production is locked, but send this one now" decision. siteId (optional) aims/re-aims the ship.
export async function unlockAndShip(id, siteId = undefined, allowStaleCxellImage = false) {
  const r = await fetch(`/api/ship/requests/${id}/unlock-and-ship`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...(siteId ? { site_id: siteId } : {}),
                           ...(allowStaleCxellImage ? { allow_stale_cxell_image: true } : {}) }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `unlock & ship failed (${r.status})`);
  return data;
}

// Defer a pending ship: set it aside (not rejected) so landings can accumulate for a combined ship.
export async function deferShip(id) {
  const r = await fetch(`/api/ship/requests/${id}/defer`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `defer failed (${r.status})`);
  return data;
}

// Resume a deferred ship: re-aim it at the current main tip and make it awaiting-approval again.
export async function resumeShip(id) {
  const r = await fetch(`/api/ship/requests/${id}/resume`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `resume failed (${r.status})`);
  return data;
}

// Bundle every DEFERRED ship into ONE combined deploy (per prod site): a carrier is re-aimed at the
// current main tip and approved, and the rest ride its single build. Returns { ok, bundles, skipped }.
export async function bundleDeferredShips(projectId) {
  const r = await fetch('/api/ship/bundle-deferred', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: projectId }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `bundle failed (${r.status})`);
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
// Nudge the xell's running zee: type "status?" straight into its live interactive session over SSH
// (not a forked headless run). Resolves { nudged, sent?, reason? } — nudged:false (not a throw)
// means there was no live cxell zee to reach.
export const nudgeXell = (id) => xellVerb(id, 'nudge');

// Send a composed operator message — long text and/or image attachments ([{ name, type, data }],
// data being a base64 / data-URL string) — to the xell's live cxell zee. Images and long text are
// handed over as files in the cxell's .zee-inbox with a pointer typed into the live session; short
// text is typed inline. Resolves { sent, attachments?, reason? } — sent:false (not a throw) means
// there was no live cxell zee to reach.
export const sendXellMessage = (id, { text, images } = {}) =>
  xellVerb(id, 'message', { text: text || '', images: images || [] });

// File a production ship request for this xell (the operator asking on the zee's behalf). It is
// REFUSED server-side unless the work is already landed on main; a human then approves it in the
// ship panel (or auto-approve does). Returns { ok, request?, reason? }.
export async function requestShipXell(xellId, reason) {
  const r = await fetch('/api/ship/request', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ xell_id: xellId, reason: reason || null }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `ship request failed (${r.status})`);
  return data;
}

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

// ── cxell file explorer: read-only view into a zee's worktree (rides the terminal modal) ──
export async function listCxellDir(zeeId, path) {
  const qs = path ? `?path=${encodeURIComponent(path)}` : '';
  const r = await fetch(`/api/zees/${zeeId}/fs${qs}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `list failed (${r.status})`);
  return data;
}

export async function readCxellFile(zeeId, path) {
  const r = await fetch(`/api/zees/${zeeId}/file?path=${encodeURIComponent(path)}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `read failed (${r.status})`);
  return data;
}

// ── PROD-DATA asks: the two things a zee may only REQUEST about production DATA ──
// Both are decided here, by a human, and performed by the queenzee — never by the zee.
//
//   prod BIND  → the xell's assigned database BECOMES live production (lib/xell-prod.js). The big
//                one: live, irreversible writes, and (for a cxell) the firewall is re-sealed so the
//                cxell can reach prod at all.
//   prod SEED  → the queenzee runs LANDED .sql file(s) from server/sql/seeds/ against production
//                (queenzee/seedgate.js). The narrow one: one reviewed file, no prod access granted.

// Confirm/reject a zee's request to be bound to the production stack.
export async function decideProdBind(id, decision, by = 'human@console') {
  const r = await fetch(`/api/prod-bind/requests/${id}/${decision}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${decision} failed (${r.status})`);
  return data;
}

// The exact SQL a seed request will run, read at ITS sha — what you approve is what runs.
// Also returns `prior`: every earlier run of the same file(s) on this production.
export async function seedRequestSql(id) {
  const r = await fetch(`/api/prod-seed/requests/${id}/sql`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `could not read the seed SQL (${r.status})`);
  return data;
}

// Approve (→ the queenzee RUNS it on production and returns the finished row) or reject a seed.
export async function decideProdSeed(id, decision, by = 'human@console') {
  const r = await fetch(`/api/prod-seed/requests/${id}/${decision}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${decision} failed (${r.status})`);
  return data;
}

// Hide a finished seed's receipt (visibility only — what ran on prod is unchanged).
export async function dismissSeed(id) {
  const r = await fetch(`/api/prod-seed/requests/${id}/dismiss`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  return r.ok ? r.json() : null;
}

// ── MANAGER ZEES ─────────────────────────────────────────────────────────────
// Adding a manager is a HUMAN act and there is no limit on how many you add — but only from here
// (a zee's dispatch verb refuses the role, so managers can never mint managers).
export async function addManagerZee(body = {}) {
  const r = await fetch('/api/managers', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `could not add a manager zee (${r.status})`);
  return data;
}

// A manager's crew (its dispatched workers, with live status).
export async function fetchCrew(xellId) {
  const r = await fetch(`/api/xells/${xellId}/crew`);
  const data = await r.json().catch(() => ([]));
  if (!r.ok) throw new Error(data.error || `crew unavailable (${r.status})`);
  return data;
}

// DONE SUGGESTIONS — a manager proposed a xell is finished; approving MARKS IT DONE and reaps the
// cxell, so the console asks for a typed confirmation before calling this.
export async function decideDoneSuggestion(id, decision, by = 'human@console', force = false) {
  const r = await fetch(`/api/done-suggestions/${id}/${decision}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by, force }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${decision} failed (${r.status})`);
  return data;
}
export async function dismissDoneSuggestion(id, by = 'human@console') {
  const r = await fetch(`/api/done-suggestions/${id}/dismiss`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `dismiss failed (${r.status})`);
  return data;
}

// Thin client: fetch the fleet read model + subscribe to the SSE stream.
// All read models are project-scoped — pass the selected project id (or null → server
// falls back to the first project).
const pq = (projectId) => (projectId ? `?project=${encodeURIComponent(projectId)}` : '');

// Every server-bound URL rides the app's own Vite base so the three transports — fetch,
// EventSource, WebSocket — agree on one answer. Base is '/' everywhere today (the /xell-web
// path-prefix era is over — xell webapps are direct ports now), so this is the identity; it stays
// because it is the one seam a future non-root base would need.
export function baseUrl(path) {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return `${base}${path}`;
}

// The href a HUMAN can open for a xell webapp. The stored url names the host the app tier runs on
// (a LAN ip the browser may not reach — e.g. the console is open at localhost); the PORT is the
// truth the meta-DB tracks, published on the queenzee host (docs/visual-verification-diagnosis.md
// §7). So: keep the port, swap the hostname for the one the browser provably reaches — the one
// this console was loaded from. Old-style path urls (/xell-web/<slug>/) resolve same-origin and
// hit the server's 302 onto the port, so they keep working too.
export function previewHref(url) {
  if (!url) return url;
  try {
    const u = new URL(url, window.location.href);
    if (u.port && u.port !== window.location.port) u.hostname = window.location.hostname;
    return u.toString();
  } catch { return url; }
}

export async function getFleet(projectId) {
  const r = await fetch(`/api/fleet${pq(projectId)}`);
  if (!r.ok) throw new Error(`fleet ${r.status}`);
  return r.json();
}

// ── PAUSE / PLAY — fleet-wide and project-scoped ─────────────────────────────────────────────────
// The fleet-wide stop button. Now ALSO accepts a `project` parameter for project-scoped pause.
// Without `projectId`, pauses the ENTIRE fleet (every project). With `projectId`, pauses only that
// project's xells while the rest of the fleet keeps working.
//
// Both verbs answer with the RECEIPT (counts + one row per xell), and the caller is expected to show
// it: "paused" that silently left three zees running is the failure this UI must not hide.
export async function pauseFleet(reason = null, projectId = null) {
  const r = await fetch('/api/fleet/pause', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason, by: 'human@console', project: projectId }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `pause failed (${r.status})`);
  return data;
}

export async function resumeFleet(projectId = null) {
  const r = await fetch('/api/fleet/resume', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ by: 'human@console', project: projectId }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `resume failed (${r.status})`);
  return data;
}

// ── PER-XELL PAUSE / PLAY (migration 101) ──────────────────────────────────────────────────────
// Pause ONE xell: marks it in session_event and interrupts its zee.
export async function pauseXell(xellId) {
  const r = await fetch(`/api/xells/${xellId}/pause`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ by: 'human@console' }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `pause xell failed (${r.status})`);
  return data;
}

// Resume ONE xell: marks it un-paused and nudges its zee back.
export async function resumeXell(xellId) {
  const r = await fetch(`/api/xells/${xellId}/resume`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ by: 'human@console' }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `resume xell failed (${r.status})`);
  return data;
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
// WHAT A HARNESS MAY DISPATCH — the composer's whole read model, in one call, derived from the
// persona the prompt BUTTON chose. The console's "＋ prompt" buttons are per HARNESS (the persona
// is the consequential choice; an account is a credential), so the providers, the accounts, the
// models and the meaning of the autonomy scale all follow from it — see server
// lib/dispatch-options.js. `harness` is three-state exactly like the composer's own value:
// undefined = the default for this zee type, '' = core only, a key = that harness.
export async function getDispatchOptions({ project, harness, zeeType = 'worker' } = {}) {
  const qs = [`project=${encodeURIComponent(project)}`,
              `zee_type=${encodeURIComponent(zeeType)}`,
              harness === undefined ? null : `harness=${encodeURIComponent(harness || '')}`]
    .filter(Boolean).join('&');
  const r = await fetch(`/api/dispatch/options?${qs}`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `dispatch options failed (${r.status})`);
  return r.json();
}
// THE ROUTER (139) — the project's front door. `status` answers the composer's gate (no live
// router → Dispatch disabled, "Deploy router" shown), `deploy`/`redeploy` are the no-prompt
// provider+model buttons, and `route` hands a RAW prompt to the live router as a routing request.
const routerCall = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body) }).then((r) => jorrejectRouter(r));
const jorrejectRouter = async (r) => (r.ok ? r.json()
  : Promise.reject(new Error((await r.json().catch(() => ({}))).error || `router call failed (${r.status})`)));
export const getRouterStatus = (project) =>
  fetch(`/api/router/status?project=${encodeURIComponent(project)}`).then((r) => jorrejectRouter(r));
export const deployRouter = (body) => routerCall('/api/router/deploy', body);
export const redeployRouter = (body) => routerCall('/api/router/redeploy', body);
export const routePrompt = (body) => routerCall('/api/router/route', body);
// The AI MODEL SPEC REGISTRY (migration 110) — the meta-DB rows (label/note/context/parameters)
// that the harness manager's policy editor reads. Not the picker list — that stays
// /api/xell/models, which resolves through the same registry plus the code defaults.
export async function getModelSpecs(provider = null) {
  const r = await fetch(`/api/ai-models${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`);
  return r.ok ? r.json() : [];
}
export async function updateModelSpec(provider, key, patch) {
  const r = await fetch(`/api/ai-models/${encodeURIComponent(provider)}/${encodeURIComponent(key)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `update model spec failed (${r.status})`);
  return data;
}
// Harnesses — the system-wide config layers (persona/skills) a xell can wear. Listed for the
// composer picker + the switch-harness control on a xell card.
//
// `zeeType` narrows the list to what a xell of that TYPE may actually wear (054): a harness carries
// its type's manual, so offering a manager persona in a worker picker would only produce a refusal
// at assign time. `projectId` narrows it the same way on the SCOPE axis (084): the system-wide
// harnesses PLUS that project's own, and never another project's — so every picker bound to a project
// must pass it, or it offers a choice the assign path (and the DB) would then refuse. Omit both in the
// harness MANAGER, which edits every persona and says which scope each one is.
export async function getHarnesses(zeeType = null, projectId = null) {
  const qs = [zeeType ? `zee_type=${encodeURIComponent(zeeType)}` : null,
              projectId ? `project=${encodeURIComponent(projectId)}` : null].filter(Boolean).join('&');
  const r = await fetch(`/api/harnesses${qs ? `?${qs}` : ''}`);
  return r.ok ? r.json() : [];
}
// SWAP THE ZEE working a xell: keep the xell (branch, commits, containers, database, work-item
// card) and put a NEW zee in it wearing a different persona — the console half of `zee swap`.
//
// This is NOT assignXellHarness below: that changes the row a running zee's cage was built from, so
// the agent in there keeps the manual it started with until something re-cages it. A swap collects
// the outgoing zee's commits onto the worktree FIRST, then re-cages, and briefs the incoming zee that
// it INHERITED the branch.
//
// A refusal (an open landing/ship/done card on that xell, a persona of the wrong type, a retired
// xell) comes back 409 with the server's own sentence — throw it verbatim: the whole point is that
// the human reads the real reason instead of "swap failed".
export async function swapXellZee(xellId, { harness, task = null, model = null, mode = null, title = null,
                                            provider = null, provider_token_id = null } = {}) {
  const r = await fetch(`/api/xells/${xellId}/swap`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ harness, task, model, mode, title, provider, provider_token_id }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data?.ok === false) throw new Error(data?.error || `swap failed (${r.status})`);
  return data;
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
// for this project and spawns a zee into its worktree with the task (and any pasted files).
// `images` is [{ name, data }] where data is a base64 data URL — a legacy field name that carries
// any file attachment. Throws with the server's message (e.g. "no ready xell available") so the
// composer can surface it without losing the prompt.
// IS SOMEBODY ALREADY IN THIS WORK? (#33) A read-only preflight the dispatch dialog calls as the prompt
// is written, so the answer is in front of you BEFORE the button rather than in the receipt after it.
// Advisory: it never refuses a dispatch, and a failure answers "no warnings" rather than throwing.
export async function dispatchOverlap(body) {
  const r = await fetch('/api/xell/dispatch/overlap', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) return { warnings: [], note: null };
  return r.json().catch(() => ({ warnings: [], note: null }));
}

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

// Xource dirty patch (broken-pipe modal preview). scope: 'staged' | 'unstaged' | 'all'.
export async function getXourcePatch(projectId, scope = 'all') {
  const q = new URLSearchParams({ scope: scope || 'all' });
  const r = await fetch(`/api/projects/${projectId}/xource/diff?${q}`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok && d.error) return { ok: false, ...d };
  if (!r.ok) throw new Error(`xource diff ${r.status}`);
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

// ── WIREGUARD MESH (Decision 5.4) — the human's door onto the ZEEHIVE network ─────────────────
// ZEEHIVE operates a WG server; a human (or another machine) downloads a ready .conf and joins the
// tunnel. Status is a read; the peer mint returns the .conf as a blob download (the private key
// lives only in that file); re-endpoint re-points the mesh server's dial-in address.
export async function getWireguard(projectId) {
  const r = await fetch(`/api/projects/${projectId}/wireguard`);
  return r.ok ? r.json() : { enabled: false, server: null, peers: [] };
}
export async function mintWireguardPeer(projectId, { name = null, dns = null } = {}) {
  const r = await fetch(`/api/projects/${projectId}/wireguard/peer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, dns }),
  });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).error) || `mint peer failed (${r.status})`);
  const blob = await r.blob();
  const cd = r.headers.get('Content-Disposition') || '';
  const fn = (cd.match(/filename="([^"]+)"/) || [])[1] || 'zeehive-wireguard.conf';
  return { blob, filename: fn };
}
export async function setWireguardEndpoint(projectId, endpoint) {
  const r = await fetch(`/api/projects/${projectId}/wireguard/endpoint`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `set endpoint failed (${r.status})`);
  return data;
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
export const pauseProviderAccount = (projectId, accountId, reason) =>
  siteCall(`/api/projects/${projectId}/tokens/account/${accountId}/pause`, 'POST',
    { reason: reason || undefined });
export const resumeProviderAccount = (projectId, accountId) =>
  siteCall(`/api/projects/${projectId}/tokens/account/${accountId}/resume`, 'POST');
// Per-provider spend-alert threshold (migration 206) — a USD amount per provider; a xell whose
// gateway-ledger spend on that provider exceeds it gets an over-budget hexagon indicator.
export const setProviderAlertAmount = (projectId, provider, amount) =>
  siteCall(`/api/projects/${projectId}/provider-alerts/${provider}`, 'PUT',
    { amount: amount === '' || amount == null ? null : amount });
// ── project API keys — the credential a DEPLOYED project presents to /api/ext/v1 (migration 190).
// The plaintext key comes back ONCE, on create; every later read carries key_hint alone, so the
// console must show it at mint time or never (lib/project-api-keys.js). ─────────
export const getProjectApiKeys = (projectId) =>
  fetch(`/api/projects/${projectId}/api-keys`).then((r) => jorreject(r, "could not load the API keys"));
export const createProjectApiKey = (projectId, label, scopes) =>
  siteCall(`/api/projects/${projectId}/api-keys`, "POST", { label, scopes: scopes || undefined });
export const revokeProjectApiKey = (projectId, keyId) =>
  siteCall(`/api/projects/${projectId}/api-keys/${keyId}/revoke`, "POST");
export const deleteProjectApiKey = (projectId, keyId) =>
  siteCall(`/api/projects/${projectId}/api-keys/${keyId}`, "DELETE");

export const putProviderToken = (projectId, provider, token) =>
  siteCall(`/api/projects/${projectId}/tokens/${provider}`, 'PUT', { token });
export const deleteProviderToken = (projectId, provider) =>
  siteCall(`/api/projects/${projectId}/tokens/${provider}`, 'DELETE');

export const createSite = (projectId, body) => siteCall(`/api/projects/${projectId}/sites`, 'POST', body);
export const updateSite = (siteId, body) => siteCall(`/api/sites/${siteId}`, 'PATCH', body);
export const deleteSite = (siteId, force = false) => siteCall(`/api/sites/${siteId}${force ? '?force=1' : ''}`, 'DELETE');

// ── environments (masked — the server never returns a secret value, only a hint). The meta-DB
// source of truth for the untracked .env; resolved onto a xell by tier (lib/environments.js). ──
// ── the project's ENTRY-POINT DOCS — one text, one file per AI provider ───────────────────────────
// The CONTENTS live in the meta-DB and the queenzee generates CLAUDE.md / AGENTS.md / GEMINI.md / …
// into every xell when a zee is assigned. The console's Docs tab is the authoring surface; the
// queenzee refuses to write one over a path the project has committed. The TARGET CATALOGUE (which
// provider reads which filename) is served by the API, never hard-coded here — vendors rename them.
export const getAgentDocTargets = () => fetch('/api/agent-doc-targets').then((r) => (r.ok ? r.json() : []));
export const getProjectDocs = (projectId) => fetch(`/api/projects/${projectId}/docs`).then((r) => (r.ok ? r.json() : []));
export const createProjectDoc = (projectId, body) => siteCall(`/api/projects/${projectId}/docs`, 'POST', body);
export const updateProjectDoc = (docId, body) => siteCall(`/api/project-docs/${docId}`, 'PUT', body);
// What will REALLY be written, run through the real generator: the stamp, the sibling list and the
// stack section an operator never typed and would otherwise first see inside a cage.
export const previewProjectDoc = (docId) => siteCall(`/api/project-docs/${docId}/preview`, 'GET');
export const deleteProjectDoc = (docId) => siteCall(`/api/project-docs/${docId}`, 'DELETE');

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
// …and the XELL side of the same fact (ticket #20): which environment a xell RESOLVED to (pinned or
// by tier), its var NAMES and counts — never values — and the pin/clear that re-projects
// .zeehive.env. Names-and-counts only: full values leave the meta-DB through exactly two doors
// (the .zeehive.env projection and the deploy materializer) and a picker must not become a third.
// The READ is GET /xells/:id/env/resolved — it sits with the other env/* reads (env/export) and NOT
// on the POST's path, which is the asymmetry that made this panel 404 on open for its first outing.
export const getXellEnvironment = (xellId) => siteCall(`/api/xells/${xellId}/env/resolved`, 'GET');
export const setXellEnvironment = (xellId, environmentId) =>
  siteCall(`/api/xells/${xellId}/environment`, 'POST', { environment_id: environmentId || null });
// A xell's message history — the manager⇄worker conversation (directives a manager sent, reports a
// worker sent back). Human-facing audit: marks NOTHING read (only the agent's own `zee inbox` does).
export const getXellMessages = (xellId) => siteCall(`/api/xells/${xellId}/messages`, 'GET');
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

// ── the squashed-snapshot offer ───────────────────────────────────────────────
// Some repository rules scan the COMMITS in the push, not the ref: secret-scanning push protection,
// file size, signatures, commit-message patterns. For those, a clean tip is not enough — the string
// (or the file, or the unsigned commit) is still back in the range. Zeehive can open the PR from a
// one-commit SQUASHED SNAPSHOT instead: same tree, same review diff, built on the remote base, so
// the offending commits are simply not part of the push. It is not a bypass — it is GitHub's own
// "remove it from the commits", done to the commits being pushed.
// Rules where that actually helps (a pull-request-required or branch-name rule is about the REF and
// would refuse the squashed push too, so it must not be offered there — an offer that cannot work is
// worse than none).
export const SQUASHABLE_RULES = new Set(['secrets', 'file-size', 'signatures', 'commit-message', 'linear-history', 'author-email']);
export const squashHelps = (r) => !!(r && r.opened === false && r.rule && SQUASHABLE_RULES.has(r.rule) && !r.squashed);
export const squashOffer = (r, branch = 'main') =>
  `${r?.rule === 'secrets' ? 'GitHub push protection' : 'A repository rule'} refused this because of something in the `
  + `COMMITS being pushed${(r?.rule_locations || []).length ? ` (${r.rule_locations.join(', ')})` : ''} — not the branch tip, which is why a `
  + `later fix does not clear it.\n\nOpen the PR from a SQUASHED SNAPSHOT instead? One commit carrying the current tree of `
  + `${branch}, on top of the remote base. The review diff is identical, the intermediate commits are not pushed, and `
  + `nothing local is rewritten.`;
export const getReadiness = (projectId) => fetch(`/api/projects/${projectId}/readiness`).then((r) => r.json());
// Machine × project build-readiness (ticket #173): per-machine verdict {ok|unknown|missing}
// with the failing check named, rendered in the container matrix where the pool knobs are set.
export const getBuildReadiness = (projectId) => fetch(`/api/projects/${projectId}/build-readiness`).then((r) => r.json());
// Machine × project build-bootstrap (ticket #173 follow-on): the one-click action that CREATES
// the dev prerequisites the probe names as missing. dryRun (default) returns the plan and performs
// nothing — the console shows it before a human commits; dryRun:false performs each step
// idempotently and re-runs the probe. QUEENZEE-performed; a prod tier/container/stack is refused.
export const planBuildBootstrap = (projectId, machineId) =>
  siteCall(`/api/projects/${projectId}/machines/${machineId}/build-bootstrap`, 'POST', { dry_run: true });
export const performBuildBootstrap = (projectId, machineId, actor) =>
  siteCall(`/api/projects/${projectId}/machines/${machineId}/build-bootstrap`, 'POST', { dry_run: false, by: actor });
export const getPoolConfig = (projectId) => fetch(`/api/projects/${projectId}/pool-config`).then((r) => r.json());
export const patchPoolConfig = (projectId, body) => siteCall(`/api/projects/${projectId}/pool-config`, 'PATCH', body);
export const getSharedContainers = (projectId) => fetch(`/api/projects/${projectId}/containers`).then((r) => r.json());
export const createSharedContainer = (projectId, body) => siteCall(`/api/projects/${projectId}/containers`, 'POST', body);
export const patchSharedContainer = (id, body) => siteCall(`/api/containers/${id}`, 'PATCH', body);
export const deleteSharedContainer = (id, force = false) => siteCall(`/api/containers/${id}${force ? '?force=1' : ''}`, 'DELETE');
export const getProjectManifestInfo = (projectId) => fetch(`/api/projects/${projectId}/manifest`).then((r) => r.json());
export const refreshProjectManifest = (projectId) => siteCall(`/api/projects/${projectId}/manifest/refresh`, 'POST');
export const draftProjectManifest = (projectId, write = false) => siteCall(`/api/projects/${projectId}/manifest/draft`, 'POST', { write });
// The "no manifest yet" wizard: build a yml PREVIEW from console form values (no write), then
// write the human-approved text to the repo root and apply it to the meta-DB row.
export const buildProjectManifest = (projectId, knobs) => siteCall(`/api/projects/${projectId}/manifest/build`, 'POST', { knobs });
export const writeProjectManifest = (projectId, body = {}) => siteCall(`/api/projects/${projectId}/manifest/write`, 'POST', body);
// Compose onboarding: plan is read-only; apply refuses without approved:true (server-enforced).
export const getComposeOnboardingPlan = (projectId) =>
  fetch(`/api/projects/${projectId}/manifest/compose-plan`).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { status: r.status, ...data });
    return data;
  });
export const applyComposeOnboarding = (projectId, body = {}) =>
  siteCall(`/api/projects/${projectId}/manifest/compose-apply`, 'POST', body);

// The event types a live change is worth acting on — the ONE authority for both live channels
// (the websocket and the SSE fallback) so they can never drift apart. 'fleet-pause' rides this
// list because a pause is the one change that can move NOTHING else: a fleet with no live cage
// broadcasts no zee/xell event, so without it the button would stay on 'pause' in every other
// open tab (and in this one, if the press came from elsewhere).
// test/work-console.test.mjs greps this name as the SSE seam.
export const STREAM_TYPES = [
  'zee', 'xell', 'container', 'task', 'project', 'land', 'ship', 'work', 'fleet-pause',
  'visual-verify', 'xource-clean', 'credential-inject', 'manager-mint',
];

// The event types that can move the GIT GRAPH: a landing moves main, a ship moves production's
// deployed commit, a project pull moves the xource heads. Every other type only moves the fleet
// snapshot, so the console re-reads the graph for these alone (App.jsx streamChange).
export const GIT_TYPES = ['land', 'ship', 'project'];

// Subscribe to the live stream for the selected project, WebSocket-first.
//
// The websocket /api/stream/ws carries the SAME wire contract as the SSE route (a leading
// `snapshot` frame, then one frame per event type, project-scoped via ?project=), so the two are
// interchangeable to a caller. It is preferred because it is a single multiplexed connection that
// opens and reconnects without per-tab EventSource fan-out, and it lets the server push the fleet
// snapshot on connect instead of the client polling for it.
//
// Callbacks:
//   onSnapshot(fleet)   — the leading fleet read model (the server sends one per connection).
//   onChange(type)      — every later event, with the EVENT TYPE named so the caller can re-read
//                         only what that event can have changed (fleet alone for most; the git
//                         graph too for land/ship/project).
//   onStatus('live'|'reconnecting')
//   onLog(l) onWork(w) onShipLog(l) onDbOpProgress(p) onDbOpLog(l) onQueenzeeActivity(a)
//
// Returns an unsubscribe function. If the websocket cannot open (an old proxy, a network that
// drops the upgrade), it falls back to the SSE route — which reconnects natively — with the same
// callbacks, so no consumer ever sees the difference.
export function subscribe(projectId, { onSnapshot, onChange, onStatus, onLog, onShipLog, onWork, onDbOpProgress, onDbOpLog, onQueenzeeActivity }) {
  const cbs = { onSnapshot, onChange, onStatus, onLog, onShipLog, onWork, onDbOpProgress, onDbOpLog, onQueenzeeActivity };
  let es = null;
  let closed = false;    // the caller unsubscribed — stop everything, do not reconnect
  let fellBack = false;  // SSE already owns the callbacks — don't open a second one

  // One frame handler for both channels: payload-bearing types call their callback, `work` ALSO
  // counts as a change (it is in STREAM_TYPES), and only the STREAM_TYPES trigger onChange — the
  // rest (tick, machine, site, environment, …) have no client interest, exactly as the old SSE
  // client treated them. The poller broadcasts `tick` every few seconds; treating it as a change
  // would re-read the fleet on a cadence, which is the spam this refactor exists to stop.
  const handleFrame = (msg) => {
    if (!msg || !msg.type) return;
    const data = msg.payload;
    switch (msg.type) {
      case 'ping': return;   // the server's keep-alive frame — nothing to do
      case 'snapshot': return onSnapshot?.(data);
      case 'log': return onLog?.(data);
      case 'ship-log': return onShipLog?.(data);
      case 'db-op-progress': return onDbOpProgress?.(data);
      case 'db-op-log': return onDbOpLog?.(data);
      case 'queenzee-activity': return onQueenzeeActivity?.(data);
      case 'work': onWork?.(data); return onChange?.('work');   // work is BOTH a payload and a change
      default: return STREAM_TYPES.includes(msg.type) ? onChange?.(msg.type) : undefined;
    }
  };

  // baseUrl rides the app's own base: a reviewed xell webapp (/xell-web/<slug>/) routes its stream
  // to THIS xell's own server through the queenzee proxy, not the outer console's.
  const wsPath = baseUrl(`/api/stream/ws${pq(projectId)}`);
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${wsPath}`);
  ws.onopen = () => onStatus?.('live');
  ws.onmessage = (e) => { try { handleFrame(JSON.parse(e.data)); } catch { /* a malformed frame must not kill the stream */ } };
  ws.onerror = () => fallbackToSSE();
  ws.onclose = () => fallbackToSSE();

  function fallbackToSSE() {
    if (closed || fellBack) return;
    fellBack = true;
    try { ws.close(); } catch { /* already closed */ }
    es = subscribeSSE(projectId, cbs);
  }

  return () => {
    closed = true;
    try { ws.close(); } catch { /* already closed */ }
    if (es) es();
  };
}

// The SSE route (/api/stream) — the resilient fallback, kept because EventSource reconnects
// natively and needs no client retry logic. Same callbacks, same frames as the websocket.
function subscribeSSE(projectId, { onSnapshot, onChange, onStatus, onLog, onShipLog, onWork, onDbOpProgress, onDbOpLog, onQueenzeeActivity }) {
  const es = new EventSource(baseUrl(`/api/stream${pq(projectId)}`));
  es.addEventListener('snapshot', (e) => onSnapshot(JSON.parse(e.data)));
  for (const type of STREAM_TYPES) {
    es.addEventListener(type, () => onChange(type));
  }
  if (onWork) es.addEventListener('work', (e) => {
    try { onWork(JSON.parse(e.data)); } catch { /* a malformed frame must not kill the stream */ }
  });
  if (onLog) es.addEventListener('log', (e) => onLog(JSON.parse(e.data)));
  // Queenzee↔xell activity ({dir:'q2x'|'x2q', xell_id, kind}) — the honeycomb's animated lines.
  if (onQueenzeeActivity) es.addEventListener('queenzee-activity', (e) => {
    try { onQueenzeeActivity(JSON.parse(e.data)); } catch { /* a malformed frame must not kill the stream */ }
  });
  // Per-ship build feed ({id, role, line}) — rendered live on that ship's own card.
  if (onShipLog) es.addEventListener('ship-log', (e) => onShipLog(JSON.parse(e.data)));
  // Live progress of db backup / restore / copy operations ({op, id, project_id, label, msg, pct, status, error}).
  // Shown as a progress toast that updates as the operation moves through its phases.
  if (onDbOpProgress) es.addEventListener('db-op-progress', (e) => {
    try { onDbOpProgress(JSON.parse(e.data)); } catch { /* a malformed frame must not kill the stream */ }
  });
  // RAW output lines of the same operations ({op, id, project_id, line}) — pg_dump / pg_restore
  // / docker's actual log, appended to the operation's toast so it reads like a build log.
  if (onDbOpLog) es.addEventListener('db-op-log', (e) => {
    try { onDbOpLog(JSON.parse(e.data)); } catch { /* a malformed frame must not kill the stream */ }
  });
  es.onopen = () => onStatus?.('live');
  es.onerror = () => onStatus?.('reconnecting');
  return () => es.close();
}

// Live clone progress for the onboard form ({name,url,phase,label,pct,overall,detail,done}).
// Its own EventSource rather than a hook into subscribe(): the onboard modal runs before the
// project it is creating exists, so there is no project stream for it to ride on yet.
export function subscribeCloneProgress(onProgress) {
  const es = new EventSource(baseUrl('/api/stream'));
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

// Check ONE db container's schema against a REFERENCE database on demand (the chip's "Check diff"
// menu item). `against` = another db container's id, or null/omitted for PRODUCTION — the default,
// and the only reference whose verdict is persisted + broadcast (so the chip's drift mark repaints
// over SSE). Any other reference is measured and reported only. Returns the payload
// { ok, total, kinds, by_schema, reference, persisted, same_db, error } so the caller can show it.
export async function checkContainerDiff(containerId, against = null) {
  const r = await fetch(`/api/containers/${containerId}/check-diff`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ against: against || null }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `check diff failed (${r.status})`);
  return data;
}

// Check ONE db container's ROWS against the backup it was restored from (the chip's "Check data" menu
// item). The sibling of checkContainerDiff, and a different question: that one asks whether the SHAPE
// matches production, this one asks whether the ROWS the source dump recorded actually arrived. Returns
// { ok, verdict, checked, ok_count, empty, short, missing, unknown, ref_total, got_total, reference, error }.
export async function checkContainerData(containerId) {
  const r = await fetch(`/api/containers/${containerId}/check-data`, { method: 'POST' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `check data failed (${r.status})`);
  return data;
}

// Is a data check even possible for this db, and against which backup? Asked before the menu item is
// offered, so a human is never invited to run a check whose only possible answer is "no reference".
export async function getDataCheckReadiness(containerId) {
  const r = await fetch(`/api/containers/${containerId}/data-check-readiness`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `readiness failed (${r.status})`);
  return data;
}

// The db containers this one can be compared against (the "Check diff" submenu). Production comes
// first — it is the default reference and the only one that writes the chip's drift verdict.
export async function getDiffCandidates(containerId) {
  const r = await fetch(`/api/containers/${containerId}/diff-candidates`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `diff candidates failed (${r.status})`);
  return Array.isArray(data.candidates) ? data.candidates : [];
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
// Probe whether the queenzee can actually REACH this machine with the settings on its row —
// resolves with { ok, docker_ctx, endpoint, reachable, ... } even when the daemon is down.
export async function checkMachineConnection(id) {
  const r = await fetch(`/api/machines/${id}/check`);
  return jsonOrThrow(r, 'check machine connection');
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

// Pause/resume this project's backups — the stop-switch for a retry storm. While paused, the
// scheduler starts no new backup (policy OR retry) and "Back up now" is refused, until a human
// flips it back. An in-flight backup is not interrupted (that's Cancel); restore/delete are untouched.
export async function setBackupPaused(paused, projectId) {
  const r = await fetch('/api/backups/pause', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused, project: projectId }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `pause failed (${r.status})`);
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

// Cancel a RUNNING backup: the in-flight dump is killed, the partial file removed, and the row
// finalised 'cancelled'. Not the same as delete — the row stays so a human can see it was stopped.
export async function cancelBackup(id) {
  const r = await fetch(`/api/backups/${id}/cancel`, { method: 'POST' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `cancel failed (${r.status})`);
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

// WITHDRAW a held landing on the zee's behalf — the operator half of `zee land --withdraw`.
// NOT a rejection: nothing is refused and no sha is burned, so the same work can be pushed and
// asked again. For the card a zee abandoned (or the older of a stack it left behind).
export async function withdrawLanding(id, reason = null) {
  const r = await fetch(`/api/land/requests/${id}/withdraw`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ by: 'human@console', reason }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `withdraw failed (${r.status})`);
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

// ── the cage itself ──────────────────────────────────────────────────────────
// What is this xell's cxell container doing right now? One `docker inspect`, read-only, asked
// on demand (never on a dashboard render) so the restart confirm can be TRUE about what it is
// about to end. Resolves { ok, state, missing, mid_turn, zee_status, name, mode }.
export async function cxellStatus(id) {
  const r = await fetch(`/api/xells/${id}/cxell`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || 'could not read the cxell state');
  return data;
}

// Restart the cage: the queenzee stops it (only with force), starts it, re-opens its ssh door,
// RE-SEALS its egress firewall and resumes the zee's session. `force` is required for a container
// docker still calls running — that is the wedged case, and stopping it ends the live turn.
// Resolves { ok, verdict, … } for every outcome, including the refusals ('running' without force,
// 'missing', 'unsealed', 'no-cxell'): they are answers, not errors.
export const restartXellCxell = (id, { force = false } = {}) =>
  xellVerb(id, 'cxell/restart', { force });

// Send a composed operator message — long text and/or FILE attachments ([{ name, type, data }],
// data being a base64 / data-URL string) — to the xell's live cxell zee. Files and long text are
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

// ── container file explorer: read-only view into a container's filesystem (rides the shell modal) ──
export async function listContainerDir(containerId, path) {
  const qs = path ? `?path=${encodeURIComponent(path)}` : '';
  const r = await fetch(`/api/containers/${containerId}/fs${qs}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `list failed (${r.status})`);
  return data;
}

export async function readContainerFile(containerId, path) {
  const r = await fetch(`/api/containers/${containerId}/file?path=${encodeURIComponent(path)}`);
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

// ── XOURCE CLEAN-UP — the project main checkout is mangled; landings/ships are blocked ─────────
// The console's two doors onto lib/xource-clean.js:
//   * read the state (clean/dirty/merge-in-progress …) for Project setup → Xource,
//   * a HUMAN directly cleans the xource (the console IS the human; the queenzee performs it),
//   * approve/reject a MANAGER's `zee xource-clean` request (same engine, one extra gate).
export async function getXourceState(projectId) {
  const r = await fetch(`/api/projects/${projectId}/xource`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `xource state failed (${r.status})`);
  return data;
}
export async function cleanXourceNow(projectId, reason) {
  const r = await fetch(`/api/projects/${projectId}/xource/clean`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ by: 'human@console', reason: reason || null }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data?.ok === false) throw new Error(data.error || `xource clean failed (${r.status})`);
  return data;
}
// Commit STAGED paths on the xource (broken-pipe modal "Commit it"). Message is required.
export async function commitXourceStaged(projectId, message) {
  const r = await fetch(`/api/projects/${projectId}/xource/commit`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ by: 'human@console', message: message || null }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data?.ok === false) throw new Error(data.error || `xource commit failed (${r.status})`);
  return data;
}
// Commit the xource's DIRTY work in ONE step (stage tracked changes, then commit) — the "commit
// locally" door. No separate staging step needed. Message is required.
export async function commitXourceDirty(projectId, message) {
  const r = await fetch(`/api/projects/${projectId}/xource/commit-dirty`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ by: 'human@console', message: message || null }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data?.ok === false) throw new Error(data.error || `xource commit failed (${r.status})`);
  return data;
}
// Stash dirty xource work (broken-pipe modal "Stash it") — parks dirt so the checkout is clean.
export async function stashXourceNow(projectId, message) {
  const r = await fetch(`/api/projects/${projectId}/xource/stash`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ by: 'human@console', message: message || null }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data?.ok === false) throw new Error(data.error || `xource stash failed (${r.status})`);
  return data;
}
export async function getXourceCleanRequests(projectId, all = false) {
  const r = await fetch(`/api/xource-clean/requests?project=${encodeURIComponent(projectId)}${all ? '&all=1' : ''}`);
  const data = await r.json().catch(() => ([]));
  if (!r.ok) throw new Error(data.error || `xource-clean requests failed (${r.status})`);
  return data;
}
export async function decideXourceClean(id, decision, by = 'human@console') {
  const r = await fetch(`/api/xource-clean/requests/${id}/${decision}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${decision} failed (${r.status})`);
  return data;
}
export async function dismissXourceClean(id, by = 'human@console') {
  const r = await fetch(`/api/xource-clean/requests/${id}/dismiss`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `dismiss failed (${r.status})`);
  return data;
}

// ── MANAGER MINT (human gate, 149) ────────────────────────────────────────────
// A ROUTER asked for another MANAGER zee. A human decides here: approve → the QUEENZEE mints it
// (the same createManagerZee the "Add manager" button calls); reject → the router dispatches a
// worker instead. No agent may create a manager, and nothing on this path changes that.
export async function getManagerMints(projectId, all = false) {
  const r = await fetch(`/api/manager-mints?project=${encodeURIComponent(projectId)}${all ? '&all=1' : ''}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `manager-mint requests failed (${r.status})`);
  return data;
}
export async function decideManagerMint(id, decision, by = 'human@console') {
  const r = await fetch(`/api/manager-mints/${id}/${decision}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${decision} failed (${r.status})`);
  return data;
}
export async function dismissManagerMint(id, by = 'human@console') {
  const r = await fetch(`/api/manager-mints/${id}/dismiss`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `dismiss failed (${r.status})`);
  return data;
}

// ── CREDENTIAL INJECTION (human gate) ──────────────────────────────────────────
// A request the QUEENZEE raised (a human connected/replaced an account → live cages hold an older
// key; a zee died on a 401 → scoped to that xell, quoting the vendor). A human decides here;
// approve → the queenzee recomputes the credential env from the meta-DB, rewrites ONLY the
// credential lines in each named cage's /etc/environment, re-runs the adapter's auth setup, and
// records a per-xell receipt. No zee path to approve — a zee never injects, asks for, or approves
// an injection.
export async function getCredentialInjectRequests(projectId, all = false) {
  const r = await fetch(`/api/credential-inject/requests?project=${encodeURIComponent(projectId)}${all ? '&all=1' : ''}`);
  const data = await r.json().catch(() => ([]));
  if (!r.ok) throw new Error(data.error || `credential-inject requests failed (${r.status})`);
  return data;
}
export async function decideCredentialInject(id, decision, by = 'human@console') {
  const r = await fetch(`/api/credential-inject/requests/${id}/${decision}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${decision} failed (${r.status})`);
  return data;
}
export async function dismissCredentialInject(id, by = 'human@console') {
  const r = await fetch(`/api/credential-inject/requests/${id}/dismiss`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `dismiss failed (${r.status})`);
  return data;
}

// ── VISUAL VERIFICATION (per-xell) ─────────────────────────────────────────────
// A human turned on "visual verification" for a xell at dispatch time; the zee built the webapp
// and OFFERED the live link to a human in the console (an Open-link card with a dismiss). This is
// the human side of that offer: turn the per-xell flag on/off, and dismiss an offer once looked at.
export async function setXellVisualVerify(id, visualVerify, by = 'human@console') {
  const r = await fetch(`/api/xells/${id}/visual-verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visual_verify: visualVerify, by }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `visual-verify update failed (${r.status})`);
  return data;
}

// Dismiss a visual-verify offer (the card's ✕). offerId may be an id or true (all open offers of
// the xell). View-only — the offer is a receipt, dismissing it just stops the card rendering.
export async function dismissVisualVerify(xellId, offerId, by = 'human@console') {
  const r = await fetch(`/api/xells/${xellId}/visual-verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dismiss: offerId || true, by }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `dismiss failed (${r.status})`);
  return data;
}

// ── XELL OBSERVABILITY — the per-turn ledger the console's right-click action renders ──────────
// Read-only: turns are written by the turn ledger (server/src/lib/turn-ledger.js) at turn
// boundaries. `getXellObservability` lists turns newest-first; `getTurnEvents` fetches the
// play-by-play events for one turn.
export async function getXellObservability(xellId, { zeeId = null, limit = 50 } = {}) {
  const qs = new URLSearchParams();
  if (zeeId) qs.set('zee_id', zeeId);
  if (limit) qs.set('limit', String(limit));
  const r = await fetch(`/api/xells/${xellId}/observability${qs.toString() ? `?${qs}` : ''}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `observability unavailable (${r.status})`);
  return data;
}
export async function getTurnEvents(turnId) {
  const r = await fetch(`/api/turns/${turnId}/events`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `turn events unavailable (${r.status})`);
  return data;
}
// The LLM gateway request ledger for one xell — the transport-layer record of every AI call
// (lib/gateway.js → llm_gateway_request). Read-only; the gateway writes it.
export async function getXellGatewayRequests(xellId, { limit = 50 } = {}) {
  const qs = limit ? `?limit=${limit}` : '';
  const r = await fetch(`/api/xells/${xellId}/gateway-requests${qs}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `gateway requests unavailable (${r.status})`);
  return data;
}
// The request/response BODIES of ONE gateway call (lib/gateway-bodies.js → llm_gateway_body,
// migration 162). The list endpoint ships no body text — a human expanding one call fetches
// that call's bodies here. Returns null when no bodies were captured.
export async function getGatewayRequestBody(xellId, requestId) {
  const r = await fetch(`/api/xells/${xellId}/gateway-requests/${requestId}/body`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return null;
  return data;
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


// WORK TRACKER — the thin HTTP client for the ticketing + work-item API.
//
// WHY this file exists at all, separate from `web/src/api.js`:
//   • `api.js` is the FLEET client (xells, zees, gates, SSE). The work tracker is a second,
//     self-contained read/write surface that happens to live in the same console. Keeping it in
//     its own module means the tracker can be read, reviewed and (one day) lifted out without
//     picking apart the file every other panel imports — and it keeps the console's one shared
//     client from turning into a 900-line junk drawer.
//   • It is deliberately THIN: one function per endpoint, no caching, no normalising, no state.
//     Every screen in `web/src/work/` owns its own loading/error state, exactly like the rest of
//     the console does (see Backups.jsx / ProdData.jsx). A client that quietly reshapes payloads
//     is a client you have to read twice when the server changes.
//
// THE ERROR CONTRACT IS THE POINT. The work API refuses with HTTP 4xx and `{error:"a sentence"}` —
// a sentence written for a human ("cannot move an activity under a task"). Every call here surfaces
// that sentence verbatim as `Error.message`, so the UI can print WHAT the server refused instead of
// a bare "failed". Never swallow it, never replace it with a generic string: the sentence IS the
// feature.
//
// Read models are project-scoped with `?project=<id>` exactly like `/api/fleet` — same convention,
// same helper shape, so a reader of api.js is already at home here.

const pq = (params) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
};

// The ONE place an HTTP answer becomes either data or a thrown sentence.
async function call(url, opts) {
  const r = await fetch(url, opts);
  let body = null;
  const text = await r.text();
  if (text) { try { body = JSON.parse(text); } catch { /* non-JSON body (a proxy error page) */ } }
  if (!r.ok) throw new Error((body && body.error) || `${r.status}`);
  return body;
}

const send = (url, method, payload) => call(url, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload || {}),
});

// ── the status vocabulary ────────────────────────────────────────────────────
// { statuses:[{key,label,order,terminal,next:[…]}], item_kinds:[…], ticket_kinds:[…] } — the WHOLE
// vocabulary in one call: the board's columns ARE `statuses`, in `order`; the drawer's picker is
// that status's own `next`; the ticket composer's kinds are `ticket_kinds`. Nothing in
// web/src/work/ may hardcode any of it — the server owns these words (the DB constrains them and a
// zee's live hive status maps onto them), and a second copy in the browser is a copy that drifts.
export const getWorkStatuses = () => call('/api/work-statuses');

// The vocabulary, defensively unwrapped. It is read by four screens, and a console that renders
// zero columns because the payload was an array instead of an object (or the other way round) is
// a console that looks like the tracker is empty. Also sorts by the server's own `order` once,
// here, so no caller has to remember to.
export function vocabOf(v) {
  const statuses = Array.isArray(v) ? v : (v?.statuses || []);
  return {
    statuses: [...statuses].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    itemKinds: v?.item_kinds || [],
    ticketKinds: v?.ticket_kinds || [],
  };
}

// ── tickets: intake ─────────────────────────────────────────────────────────
export const listTickets = (projectId, { status, kind, q } = {}) =>
  call(`/api/tickets${pq({ project: projectId, status, kind, q })}`);
export const getTicket = (id) => call(`/api/tickets/${encodeURIComponent(id)}`);
export const createTicket = (payload) => send('/api/tickets', 'POST', payload);
export const patchTicket = (id, patch) => send(`/api/tickets/${encodeURIComponent(id)}`, 'PATCH', patch);
export const deleteTicket = (id) => call(`/api/tickets/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const addComment = (id, payload) => send(`/api/tickets/${encodeURIComponent(id)}/comments`, 'POST', payload);
// items: [{title, kind, parent_id?, body?, priority?}] — the manager's "break this ticket down"
// action. One round trip, because half a created tree is worse than none.
export const breakdownTicket = (id, items) => send(`/api/tickets/${encodeURIComponent(id)}/breakdown`, 'POST', { items });

// ── work items: the hierarchy ────────────────────────────────────────────────
export const listWorkItems = (projectId, { tree, status, kind, root, ticket } = {}) =>
  call(`/api/work-items${pq({ project: projectId, tree: tree ? 1 : undefined, status, kind, root, ticket })}`);
export const getWorkItem = (id) => call(`/api/work-items/${encodeURIComponent(id)}`);
export const createWorkItem = (payload) => send('/api/work-items', 'POST', payload);
// A PATCH carrying parent_id is a MOVE within the tree — the server decides whether the shape is
// legal (a task may not parent an activity, a node may not become its own descendant) and refuses
// with its sentence. The rail shows that sentence rather than pretending the drop worked.
export const patchWorkItem = (id, patch) => send(`/api/work-items/${encodeURIComponent(id)}`, 'PATCH', patch);
export const deleteWorkItem = (id) => call(`/api/work-items/${encodeURIComponent(id)}`, { method: 'DELETE' });

// ── dependencies ────────────────────────────────────────────────────────────
export const addDep = (id, dependsOnId) =>
  send(`/api/work-items/${encodeURIComponent(id)}/deps`, 'POST', { depends_on_id: dependsOnId });
export const removeDep = (id, depId) =>
  call(`/api/work-items/${encodeURIComponent(id)}/deps/${encodeURIComponent(depId)}`, { method: 'DELETE' });

// ── the two computed read models ─────────────────────────────────────────────
// board: { root, columns:[{key,label,order,items:[card…]}] } — `root` scopes it to a subtree.
export const getBoard = (projectId, rootId) => call(`/api/board${pq({ project: projectId, root: rootId })}`);
// gantt: tree-ordered rows with computed dates. Part 4 renders it; Gantt.jsx is a placeholder today.
export const getGantt = (projectId, rootId) => call(`/api/gantt${pq({ project: projectId, root: rootId })}`);

// ── who is ON an item: assign an existing xell, or deploy a new worker (part 3's verbs) ──────
// These three are a different WEIGHT to everything above. `candidates` is a read model built for a
// picker — only the xells the server would accept, each with a `why` line — so the console never
// has to offer a uuid box or guess which xells are eligible. `assign`/`unassign` bind and unbind an
// existing xell. `deploy` SPAWNS A REAL ZEE, which is why the UI in DeployZee.jsx confirms it in
// plain words first; the client stays thin either way, and a refusal comes back as the same 409
// sentence every other verb here throws.
export const getAssignCandidates = (id) => call(`/api/work-items/${encodeURIComponent(id)}/candidates`);
export const assignWorkItem = (id, xellId) => send(`/api/work-items/${encodeURIComponent(id)}/assign`, 'POST', { xell_id: xellId });
export const unassignWorkItem = (id) => call(`/api/work-items/${encodeURIComponent(id)}/assign`, { method: 'DELETE' });
// { task?, model?, mode?, harness? } — every field optional; the server holds the defaults, so an
// omitted model is the server's choice and not a stale copy of one made in the browser.
export const deployWorkItem = (id, opts = {}) => send(`/api/work-items/${encodeURIComponent(id)}/deploy`, 'POST', opts);

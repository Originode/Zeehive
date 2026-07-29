// ── the manager↔CREW relation: ONE rule, for every layer that draws it ────────
//
// A manager and its crew are the only grouping in the hive that is a real relationship rather than a
// coincidence of position: seatXells already sits a manager's crew in the cells NEAREST to it, so the
// layout half-expressed it and the interaction said nothing. Ticket #24 made the honeycomb HEXES say
// it; #25 carried the same relation into the two other layers that draw the same fleet — the wire
// overlay (Connectors.jsx) and the git graph's commit dots (GraphPane.jsx).
//
// THAT is why this file exists rather than each layer answering "who is crew" for itself. #24 landed by
// DELETING a duplicate grouping: the honeycomb's hand-rolled `if (x.manager_xell_id)` pass had drifted
// from the read model and had no liveness rule at all, so a manager hexagon counted a reaped worker in
// its crew total. Two more copies for two more layers is the same bug waiting in three places. Every
// view imports these functions; none of them re-derives the relationship.
//
// It costs no request: `xell.manager_xell_id` already rides on the fleet payload the console polls.
//
// LIVE crew only, by the SAME rule the work tracker resolves a live zee with (server/src/lib/
// work-items.js LIVE_XELL_STATUSES): 'retired' is gone and 'husk'/'error' are VACANT (lib/
// hive-status.js classes both as vac-dirty), so no zee occupies any of them. A reaped worker lighting
// up as though it were still there draws a crew that does not exist — worse than no highlight.
const DEAD_XELL_STATUSES = ['retired', 'husk', 'error'];
export const isLiveXell = (x) => !!x && !DEAD_XELL_STATUSES.includes(String(x.status || ''));

// A MANAGER zee is not a work-cell (see hive/HiveCanvas.jsx): it writes no code and lands none, so its
// hexagon is drawn as a persona. Here it is simply the end of the relation that HAS a crew.
export const isManagerXell = (x) => x?.zee_type === 'manager';

// manager id → its LIVE crew, and worker id → the manager it reports to (only when that manager is
// itself live — a husk manager cannot be "who this one reports to"). A dead manager's own hover still
// gets a crew list: the manager row is vacant, but the workers it dispatched are real and running.
export function crewLinks(xells = []) {
  const byId = new Map();
  for (const x of xells || []) if (x?.id) byId.set(x.id, x);
  const crewOf = {};
  const managerOf = {};
  for (const x of xells || []) {
    const mid = x?.manager_xell_id;
    if (!mid || !isLiveXell(x)) continue;
    (crewOf[mid] ||= []).push(x);
    if (isLiveXell(byId.get(mid))) managerOf[x.id] = mid;
  }
  return { crewOf, managerOf };
}

// Who is RELATED to the focused (hovered or selected) xell, and HOW → Map(id → 'crew' | 'manager').
// ONE hop, deliberately: a manager marks its crew, and a worker marks the manager it reports to
// ("who does this one report to" is the same question asked backwards). A worker does NOT mark its
// SIBLINGS — they are not related to it, they merely share a boss, and lighting five cells from one
// worker's hover reads as a selection sweep rather than an answer.
export function relatedTo(xells = [], focusId, links = null) {
  const rel = new Map();
  if (!focusId) return rel;
  const focus = (xells || []).find((x) => x?.id === focusId);
  if (!focus) return rel;
  const l = links || crewLinks(xells);
  if (isManagerXell(focus)) for (const w of l.crewOf[focusId] || []) rel.set(w.id, 'crew');
  const mid = l.managerOf[focusId];
  if (mid && mid !== focusId) rel.set(mid, 'manager');
  return rel;
}

// WHICH xell the whole hive is focused on: the one under the cursor, or — with nothing hovered — the
// SELECTED (bloomed) one, so a manager's crew stays marked while its flower is open. Three views ask
// this question (honeycomb, wires, graph) and they must never disagree about the answer.
export const focusIdOf = (hover, expandedId = null) => (hover?.id || expandedId || null);

// A hex/trace/dot DIMS when the focus is elsewhere — but a RELATED one never dims, and that is the
// whole highlight: the focus lights its own group and the rest of the fleet recedes behind it.
export const hexDim = ({ hexId, expandedId = null, hovered = false, hoverActive = false, related = null }) =>
  !related && ((!!expandedId && expandedId !== hexId) || (hoverActive && !hovered));

// ── the shared VOCABULARY of "related" ───────────────────────────────────────
// DASHED means related-to-the-focus, in all three layers: the hexagon's tie-ring, the connector wire's
// stroke and the commit dot's anchor ring are all drawn with THIS dash. One idea taught once — and a
// signal that is not a colour, which is the house rule (a highlight that is only a hue fails for anyone
// who cannot separate those hues). Solid and bright stays reserved for the focus itself, so a related
// thing can never be mistaken for the thing that was chosen.
export const REL_DASH = [2, 4];
export const REL_DASH_ATTR = REL_DASH.join(' ');     // the SVG stroke-dasharray form of the same dash

// The WORD a relation carries. The word is the signal and colour only reinforces it, so every relation
// mark says which relation it is, and the long form names the other end of it when there is room.
export function relationTag(kind, otherSlug = null) {
  const other = String(otherSlug || '').trim();
  if (kind === 'crew') return { kind, glyph: '⬡', word: 'crew', long: other ? `crew of ${other}` : 'crew' };
  if (kind === 'manager') return { kind, glyph: '⬢', word: 'manager', long: other ? `manager of ${other}` : 'manager' };
  return null;
}

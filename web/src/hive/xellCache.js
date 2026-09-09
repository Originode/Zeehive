// THE HONEYCOMB'S XELL STORE — one map PER PROJECT, not one map that gets emptied.
//
// The console holds the xells it has streamed so the comb can be drawn. Held in a SINGLE map, that
// store has to be cleared every time the selected project changes, or the previous project's
// hexagons paint under the new project's name. Clearing is what a human sees as "the xells are
// getting removed and recreated when I change projects": the comb empties, then rebuilds itself
// hexagon by hexagon as the NDJSON stream re-delivers rows the browser already had a moment ago —
// and going BACK to a project you were just looking at rebuilds it from nothing all over again.
//
// Keyed by project, no clear is needed, because the question the clear was answering ("could this
// row belong to the other project?") cannot arise: a row is filed under the project it was fetched
// for. So a switch is a lookup — the new project's rows are already in hand — and the stream that
// follows RECONCILES that project's map in place (upsert each row as it arrives, then prune the ids
// the pass never saw). A stream or snapshot still resolving from the project you just left updates
// its own map and is neither dropped nor allowed to bleed.
//
// Note what this deliberately is NOT: a project filter. Nothing here ever reads `project_id` off a
// row to decide whether to keep it — the server already scoped the read (`WHERE x.project_id = $1`)
// and re-deciding it here would be a second copy of that rule. The project is the KEY, supplied by
// the caller that made the request; the rows are taken exactly as they arrived.
//
// One map per project VISITED in this session, holding the same row objects the fleet snapshot
// already holds — the console's project switcher is a short list, so this is bounded by what a
// human clicked, and nothing here grows per event.

// The default project has no id until the fleet resolves one (the server picks it), so `null` is a
// real selection with its own map — and the same selection the stream was requested under.
const keyOf = (project) => project || '';
const EMPTY = new Map();

export function createXellCache() {
  const byProject = new Map();   // project selection → Map(xell id → the row as it arrived)
  const peek = (project) => byProject.get(keyOf(project));            // read: never materialises
  const mapFor = (project) => {                                       // write: creates on demand
    const k = keyOf(project);
    let m = byProject.get(k);
    if (!m) { m = new Map(); byProject.set(k, m); }
    return m;
  };
  return {
    // A fresh array every call: it is what React renders from, so it must be a new identity to
    // repaint — while the ROWS inside keep theirs, which is what makes a re-stream reconcile
    // hexagons instead of recreating them.
    list: (project) => Array.from((peek(project) || EMPTY).values()),
    upsert: (project, xell) => { if (xell?.id) mapFor(project).set(xell.id, xell); },
    // End of a pass: drop the ids this pass did not see. Scoped to ONE project's map, so a pass
    // over project A can never delete project B's hexagons.
    prune: (project, seenIds) => {
      const m = mapFor(project);
      for (const id of Array.from(m.keys())) if (!seenIds.has(id)) m.delete(id);
    },
    // A whole authoritative list (a fleet snapshot) replaces that project's map — the same prune a
    // stream completion does, in one step.
    adopt: (project, rows) => {
      const next = new Map();
      for (const x of rows || []) if (x?.id) next.set(x.id, x);
      byProject.set(keyOf(project), next);
    },
  };
}

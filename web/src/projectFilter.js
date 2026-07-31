// ── PROJECT-SCOPING FILTER: one rule for every surface that draws the fleet ──
//
// The fleet stream, the fleet snapshot and the SSE updates are all project-scoped on the server,
// but the console's render path must never trust that completely: a project switch can leave the
// PREVIOUS project's LAST update stream landing after the new selection is set, and a foreign xell
// that reaches the honeycomb paints as a lingering remnant from the project you just left. The
// stream guards in App.jsx keep that from happening; this filter is the belt-and-braces final gate
// at render — every surface fed from the xell list drops a xell that demonstrably belongs to a
// different project, at the cost of one pass over an already-small list.
//
// It is deliberately LENIENT: with no project selected (null → the server's default) there is
// nothing to filter against, so every xell passes; a xell that does not carry a project_id passes
// too, because it cannot be PROVEN foreign. The filter only drops what it can vouch for.
export const belongsToProject = (x, projectId) => !projectId || !x?.project_id || x.project_id === projectId;
export const projectScoped = (xells = [], projectId) => (xells || []).filter((x) => belongsToProject(x, projectId));

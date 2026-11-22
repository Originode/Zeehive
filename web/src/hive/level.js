// ── WORK-NODE LEVEL REACHABILITY: can a human ever DRILL to this item's level? ──
//
// The honeycomb draws one LEVEL of the work-node tree, and a xell assigned to a deeper open item
// shows at ITS level, not at the root. That deal only holds if the level is actually openable: an
// open item whose parent is done/cancelled (or missing, or part of a parent cycle) has no level
// anyone can reach — the terminal parent never renders, so nothing can be clicked to open its
// children. A xell assigned to such an item was still COUNTED by the statusline ("16 of 18 xells
// in use") while being drawn NOWHERE, which reads as a miscount to a human. App.jsx uses this rule
// to surface those orphaned xells at the ROOT level instead of hiding them everywhere.
//
// `openItemById` maps id → OPEN item only (kind !== 'project', status not terminal): a parent that
// is not in the map is either terminal or gone, and either way its children cannot be drilled to.
export const itemReachable = (item, openItemById, rootId) => {
  const walked = new Set();
  for (let p = item?.parent_id; p && p !== rootId; ) {
    if (walked.has(p)) return false;      // a parent CYCLE has no openable level either
    walked.add(p);
    const parent = openItemById.get(p);
    if (!parent) return false;            // parent terminal or missing → no level opens this item
    p = parent.parent_id;
  }
  return true;
};

// ── XELLS INSIDE A NODE: every live xell on an item's DESCENDANTS, not just its children ──
//
// A task/activity hexagon used to say "⬡ 3" (open child cards) and nothing about zees, so a xell
// two levels down was invisible until someone happened to drill there. This walks every open item
// that carries a live xell UP through its open ancestors and files the xell under each one — so a
// node knows every xell standing anywhere beneath it. The item's OWN xell is not "inside" it (its
// hexagon already IS that xell). The walk stops at the project root, at a terminal/missing parent
// (nothing above it can be drilled to anyway — hive/level.js#itemReachable) and on a parent cycle.
//
// Returns Map(itemId → [xell, …]) in the order of `xells` (App passes them already ranked).
export const descendantXells = (openItems, xells, rootId) => {
  const openItemById = new Map((openItems || []).map((i) => [i.id, i]));
  const itemByXell = new Map((openItems || []).filter((i) => i.xell_id).map((i) => [i.xell_id, i]));
  const out = new Map();
  for (const x of xells || []) {
    const it = itemByXell.get(x.id);
    if (!it) continue;
    const walked = new Set([it.id]);   // its own card is never "inside" itself, even through a cycle
    for (let p = it.parent_id; p && p !== rootId && !walked.has(p); ) {
      walked.add(p);
      const parent = openItemById.get(p);
      if (!parent) break;
      if (!out.has(p)) out.set(p, []);
      out.get(p).push(x);
      p = parent.parent_id;
    }
  }
  return out;
};

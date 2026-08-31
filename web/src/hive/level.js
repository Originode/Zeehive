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

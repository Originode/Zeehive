// Assign each commit to a lane from its parent topology (newest→oldest), GitLens-style.
// Ported from GitRail's computeGraph so the canvas timeline draws the same branch/merge lanes.
// Returns { rows:[{c,lane,row}], edges:[{fromLane,fromRow,toLane,toRow,dangling}], laneCount }.
export function computeGraph(commits) {
  const lanes = [];              // expected next hash per active lane
  const place = {};              // hash → {lane,row}
  const rows = [];
  const branchLane = new Map();  // `${row}:${parentIndex}` → lane reserved for a merge's Nth parent
  commits.forEach((c, row) => {
    let lane = lanes.indexOf(c.hash);
    if (lane === -1) { lane = lanes.indexOf(null); if (lane === -1) { lane = lanes.length; lanes.push(null); } }
    for (let i = 0; i < lanes.length; i++) if (i !== lane && lanes[i] === c.hash) lanes[i] = null; // merges converge
    place[c.hash] = { lane, row };
    rows.push({ c, lane, row });
    lanes[lane] = c.parents[0] || null;                        // first parent continues the lane
    for (let p = 1; p < c.parents.length; p++) {               // extra parents branch into new lanes
      let f = lanes.indexOf(null); if (f === -1) { f = lanes.length; lanes.push(null); }
      lanes[f] = c.parents[p];
      branchLane.set(`${row}:${p}`, f);                        // remember it so a DANGLING parent
    }                                                           // still draws down its own lane
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
  });
  let laneCount = rows.reduce((m, r) => Math.max(m, r.lane + 1), 1);
  const edges = [];
  for (const { c, lane, row } of rows) {
    c.parents.forEach((ph, p) => {
      const pp = place[ph];
      // A merged branch whose commits fall BELOW the window (no placed parent) used to collapse onto
      // the merge's own lane — invisible, indistinguishable from the trunk. Route it down the lane we
      // reserved for it instead, running to the bottom edge, so every merged branch is its own line.
      const toLane = pp ? pp.lane : (p > 0 ? branchLane.get(`${row}:${p}`) ?? lane : lane);
      laneCount = Math.max(laneCount, toLane + 1);
      edges.push({ fromLane: lane, fromRow: row, toLane, toRow: pp ? pp.row : commits.length, dangling: !pp });
    });
  }
  return { rows, edges, laneCount, place };
}

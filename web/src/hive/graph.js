// Assign each commit to a lane from its parent topology (newest→oldest), GitLens-style.
// Ported from GitRail's computeGraph so the canvas timeline draws the same branch/merge lanes.
// Returns { rows:[{c,lane,row}], edges:[{fromLane,fromRow,toLane,toRow,dangling}], laneCount }.
export function computeGraph(commits) {
  const lanes = [];              // expected next hash per active lane
  const place = {};              // hash → {lane,row}
  const rows = [];
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
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
  });
  const laneCount = rows.reduce((m, r) => Math.max(m, r.lane + 1), 1);
  const edges = [];
  for (const { c, lane, row } of rows) {
    for (const ph of c.parents) {
      const pp = place[ph];
      edges.push({ fromLane: lane, fromRow: row, toLane: pp ? pp.lane : lane, toRow: pp ? pp.row : commits.length, dangling: !pp });
    }
  }
  return { rows, edges, laneCount, place };
}

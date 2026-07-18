// The honeycomb as a maze: its hexagons' edges form a lattice a connector wire can thread through
// without ever crossing a hex interior. Because every pointy-top hex edge already runs vertical or
// at ±30°, a path that follows edges is automatically angle-legal (parallel to hex sides), and it
// naturally turns only at hex vertices. We build the vertex/edge graph from the live hex centres,
// then Dijkstra from an entry vertex to the target hex's vertex nearest the source.

// Pointy-top hex corners, matching hex.js hexCorners: angle = (60·i − 30)°, i = 0..5.
export function hexVertices(cx, cy, size) {
  const out = [];
  for (let i = 0; i < 6; i++) {
    const a = ((60 * i - 30) * Math.PI) / 180;
    out.push([cx + size * Math.cos(a), cy + size * Math.sin(a)]);
  }
  return out;
}

// "Assume an infinite maze": the honeycomb's cell lattice extends past the drawn hexes so a wire can
// thread corridors through the empty gap between the graph and the honeycomb too. Generate the cell
// centres of that lattice covering `bbox`, aligned to an anchor cell (any real hex centre) — pointy-
// top axial tiling with basis (√3·s, 0) and (√3·s/2, 1.5·s), which coincides with the offset grid.
export function latticeCells(anchorX, anchorY, size, bbox, ids = 'v') {
  const W = Math.sqrt(3) * size, H = 1.5 * size;
  const cells = [];
  const rMin = Math.floor((bbox.y0 - anchorY) / H) - 1;
  const rMax = Math.ceil((bbox.y1 - anchorY) / H) + 1;
  let n = 0;
  for (let r = rMin; r <= rMax; r++) {
    const rowX = anchorX + r * (W / 2);
    const qMin = Math.floor((bbox.x0 - rowX) / W) - 1;
    const qMax = Math.ceil((bbox.x1 - rowX) / W) + 1;
    for (let q = qMin; q <= qMax; q++) {
      cells.push({ id: `${ids}${n++}`, cx: rowX + q * W, cy: anchorY + r * H, size });
    }
  }
  return cells;
}

// Build the shared vertex graph from a list of hexes ({id, cx, cy, size}). Coincident vertices of
// adjacent hexes are merged by quantised key so the lattice is connected. Returns
// { nodes: Map(key→{x,y}), adj: Map(key→Set(key)), vertsById: Map(id→[{x,y,key}]) }.
export function buildHexGraph(hexes, quant = 1.5) {
  const nodes = new Map();
  const adj = new Map();
  const vertsById = new Map();
  const keyOf = (x, y) => `${Math.round(x / quant)}_${Math.round(y / quant)}`;
  const addNode = (x, y) => {
    const k = keyOf(x, y);
    if (!nodes.has(k)) { nodes.set(k, { x, y }); adj.set(k, new Set()); }
    return k;
  };
  const addEdge = (a, b) => { if (a !== b) { adj.get(a).add(b); adj.get(b).add(a); } };

  for (const h of hexes) {
    const vs = hexVertices(h.cx, h.cy, h.size).map(([x, y]) => ({ x, y, key: addNode(x, y) }));
    for (let i = 0; i < 6; i++) addEdge(vs[i].key, vs[(i + 1) % 6].key);
    vertsById.set(h.id, vs);
  }
  return { nodes, adj, vertsById };
}

// Dijkstra along the lattice. Small graphs (≤ a few hundred nodes) → a sorted-array frontier is fine.
// Returns an array of {x,y,key} from start to goal (inclusive), or null if disconnected.
export function shortestPath(graph, startKey, goalKey) {
  const { nodes, adj } = graph;
  if (!nodes.has(startKey) || !nodes.has(goalKey)) return null;
  if (startKey === goalKey) return [{ ...nodes.get(startKey), key: startKey }];
  const dist = new Map([[startKey, 0]]);
  const prev = new Map();
  const done = new Set();
  const frontier = [[0, startKey]];
  const dOf = (k) => (dist.has(k) ? dist.get(k) : Infinity);
  while (frontier.length) {
    frontier.sort((a, b) => a[0] - b[0]);
    const [d, k] = frontier.shift();
    if (done.has(k)) continue;
    done.add(k);
    if (k === goalKey) break;
    const pk = nodes.get(k);
    for (const nb of adj.get(k) || []) {
      if (done.has(nb)) continue;
      const pn = nodes.get(nb);
      const nd = d + Math.hypot(pk.x - pn.x, pk.y - pn.y);
      if (nd < dOf(nb)) { dist.set(nb, nd); prev.set(nb, k); frontier.push([nd, nb]); }
    }
  }
  if (!prev.has(goalKey)) return null;
  const path = [];
  for (let cur = goalKey; cur != null; cur = prev.get(cur)) {
    path.unshift({ ...nodes.get(cur), key: cur });
    if (cur === startKey) return path;
  }
  return null;
}

const edgeKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

// When several wires traverse the same corridor (lattice edge), give each its own channel: assign a
// lane per (edge, wire) and return, per wire, a perpendicular offset VECTOR for each of its segments.
// The offset is taken from the edge's canonical orientation (low→high key) so wires crossing an edge
// in opposite directions still separate onto consistent sides. `wires`: [{id, pts:[{x,y,key}]}].
export function assignLanes(wires, pitch) {
  const users = new Map();                       // edgeKey → [wireId…]
  for (const w of wires) {
    for (let i = 0; i < w.pts.length - 1; i++) {
      const k = edgeKey(w.pts[i].key, w.pts[i + 1].key);
      if (!users.has(k)) users.set(k, []);
      users.get(k).push(w.id);
    }
  }
  const laneOff = new Map();                      // edgeKey → Map(wireId → signed offset)
  for (const [k, list] of users) {
    const uniq = [...new Set(list)].sort();
    const m = new Map();
    uniq.forEach((id, l) => m.set(id, (l - (uniq.length - 1) / 2) * pitch));
    laneOff.set(k, m);
  }
  const out = new Map();
  for (const w of wires) {
    const offs = [];
    for (let i = 0; i < w.pts.length - 1; i++) {
      const a = w.pts[i], b = w.pts[i + 1];
      const s = laneOff.get(edgeKey(a.key, b.key)).get(w.id) || 0;
      const [lo, hi] = a.key < b.key ? [a, b] : [b, a];   // canonical orientation
      const dx = hi.x - lo.x, dy = hi.y - lo.y, L = Math.hypot(dx, dy) || 1;
      offs.push([(-dy / L) * s, (dx / L) * s]);           // perpendicular × signed lane offset
    }
    out.set(w.id, offs);
  }
  return out;
}

function lineIntersect(p1, d1, p2, d2) {
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-6) return null;         // parallel → no miter
  const t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / den;
  return [p1[0] + d1[0] * t, p1[1] + d1[1] * t];
}

// Offset a vertex polyline by a per-segment offset vector, mitring interior corners so the lanes stay
// continuous. pts: [{x,y}], offs: [[ox,oy]] (one per segment). Returns [[x,y]].
export function offsetPolyline(pts, offs) {
  const n = pts.length;
  if (n < 2) return pts.map((p) => [p.x, p.y]);
  const out = [[pts[0].x + offs[0][0], pts[0].y + offs[0][1]]];
  for (let i = 1; i < n - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1], o1 = offs[i - 1], o2 = offs[i];
    const p1 = [b.x + o1[0], b.y + o1[1]], d1 = [b.x - a.x, b.y - a.y];
    const p2 = [b.x + o2[0], b.y + o2[1]], d2 = [c.x - b.x, c.y - b.y];
    out.push(lineIntersect(p1, d1, p2, d2) || [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2]);
  }
  out.push([pts[n - 1].x + offs[n - 2][0], pts[n - 1].y + offs[n - 2][1]]);
  return out;
}

// The vertex of a hex (its verts list) nearest to point (px,py).
export function nearestVertex(verts, px, py) {
  let best = verts[0], bd = Infinity;
  for (const v of verts) {
    const d = Math.hypot(v.x - px, v.y - py);
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}

// The graph node nearest to point (px,py) — where a wire enters the lattice from open space.
export function nearestNode(graph, px, py) {
  let bestKey = null, bd = Infinity;
  for (const [k, p] of graph.nodes) {
    const d = Math.hypot(p.x - px, p.y - py);
    if (d < bd) { bd = d; bestKey = k; }
  }
  return bestKey;
}

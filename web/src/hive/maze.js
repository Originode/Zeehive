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
// Returns an array of {x,y} from start to goal (inclusive), or null if disconnected.
export function shortestPath(graph, startKey, goalKey) {
  const { nodes, adj } = graph;
  if (!nodes.has(startKey) || !nodes.has(goalKey)) return null;
  if (startKey === goalKey) return [nodes.get(startKey)];
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
    path.unshift(nodes.get(cur));
    if (cur === startKey) return path;
  }
  return null;
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

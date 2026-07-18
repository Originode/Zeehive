// Pointy-top hexagon geometry for the honeycomb canvas.
//
// A pointy-top hex has vertices at the top and bottom and flat vertical edges on the left/right.
// With circumradius `size` (center → corner):
//   width  = √3 · size   (flat-to-flat, the horizontal footprint)
//   height = 2  · size   (vertex-to-vertex)
// Rows step by 1.5·size vertically and every other row shifts half a width, which is what makes the
// tessellation gapless. The six neighbour directions (0,60,…,300°) are also the flower petals — a
// centre hex plus a ring of six is one hex and all of its neighbours, so it tiles perfectly.

export const SQRT3 = Math.sqrt(3);
export const hexWidth = (size) => SQRT3 * size;
export const rowStep = (size) => 1.5 * size;

// The six corners of a pointy-top hex, starting upper-right, going clockwise (y grows downward).
export function hexCorners(cx, cy, size) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = ((60 * i - 30) * Math.PI) / 180;
    pts.push([cx + size * Math.cos(a), cy + size * Math.sin(a)]);
  }
  return pts;
}

// Trace a hex path onto a 2D context (does not fill/stroke — caller decides).
export function hexPath(ctx, cx, cy, size) {
  const c = hexCorners(cx, cy, size);
  ctx.beginPath();
  ctx.moveTo(c[0][0], c[0][1]);
  for (let i = 1; i < 6; i++) ctx.lineTo(c[i][0], c[i][1]);
  ctx.closePath();
}

// Point-in-hex. Cheap and exact enough: a pointy-top hex is the intersection of |dx| ≤ w/2 (the
// vertical side edges) and the two slanted-edge half-planes. Using the analytic form avoids a full
// polygon walk on every mousemove.
export function pointInHex(px, py, cx, cy, size) {
  const dx = Math.abs(px - cx);
  const dy = Math.abs(py - cy);
  const w = hexWidth(size) / 2;         // half flat-to-flat
  if (dx > w || dy > size) return false;
  // slanted edge: from (w, size/2) to (0, size). Inside ⟺ below that line.
  return size * w - (size / 2) * dx - w * dy >= 0;
}

// The seven hex centres of a flower: [centre, …6 petals] at the pointy-top neighbour directions.
// Petals sit one neighbour-step (√3·size) out, so centre + petals tessellate among themselves.
export function flowerCenters(cx, cy, size) {
  const d = hexWidth(size);
  const out = [[cx, cy]];
  for (let i = 0; i < 6; i++) {
    const a = ((60 * i) * Math.PI) / 180;
    out.push([cx + d * Math.cos(a), cy + d * Math.sin(a)]);
  }
  return out;
}

// Choose a hex `size` and column count that pack `count` pointy-top hexes into a w×h area, then
// return the centre of each hex (row-major, odd rows offset), centred within the area.
//
// We try every plausible column count and keep the one that yields the largest legible hex — a few
// wide rows vs many short columns is a real trade-off and the best answer depends on the area's
// aspect ratio, so we let the geometry decide rather than guessing a grid.
export function layoutHoneycomb(count, w, h, { min = 26, max = 132, pad = 10 } = {}) {
  if (count <= 0 || w <= 0 || h <= 0) return { size: min, cells: [], cols: 0, rows: 0 };
  const availW = Math.max(1, w - pad * 2);
  const availH = Math.max(1, h - pad * 2);

  let best = null;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    // width limit: cols hexes plus the half-width offset row must fit across.
    const sizeW = availW / ((cols + 0.5) * SQRT3);
    // height limit: first+last vertex plus (rows-1) row steps must fit down.
    const sizeH = availH / (1.5 * rows + 0.5);
    const size = Math.min(sizeW, sizeH);
    if (!best || size > best.size) best = { size, cols, rows };
  }
  let { size, cols, rows } = best;
  size = Math.max(min, Math.min(max, size));

  const width = hexWidth(size);
  // True laid-out extent (so we can centre the block in the area).
  const usedRows = Math.ceil(count / cols);
  const blockH = 2 * size + (usedRows - 1) * rowStep(size);
  const offsetRows = usedRows > 1;                       // only offset when there IS a second row
  const blockW = cols * width + (offsetRows ? width / 2 : 0);
  const originX = pad + Math.max(0, (availW - blockW) / 2);
  const originY = pad + Math.max(0, (availH - blockH) / 2);

  const cells = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const cx = originX + width / 2 + col * width + (row % 2 ? width / 2 : 0);
    const cy = originY + size + row * rowStep(size);
    cells.push({ i, row, col, cx, cy });
  }
  return { size, cols, rows: usedRows, cells };
}

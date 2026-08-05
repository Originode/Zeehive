// HARNESS GEAR — what a harness looks like when it is WORN over an AI provider's coin.
//
// The first cut of this drew every harness the same way: a ring plus a small disc at 4 o'clock with
// the harness's glyph in it. That is a LABEL, not a costume — six roles came out as six identical
// badges you had to squint at to tell apart, and at hexagon size the glyph was three grey pixels.
//
// So a harness now gets ARTWORK, framed around the coin and shaped like the job:
//
//        scout      builder     manager     reviewer     worker
//        \|/ wings   hammer      necktie     glasses      shovel
//        (coin)      (coin)⚒     (coin)      (co⊙⊙n)      (coin)⛏
//                                  ▼
//
// Three rules hold the set together:
//   1. ONE DEFINITION, TWO RENDERERS. Each gear is a list of PATH COMMANDS in a unit space centred
//      on the coin (coin radius = 1, art may reach ±GEAR_EXTENT). The canvas walks them as
//      moveTo/lineTo/quadraticCurveTo; the DOM turns the identical list into an SVG `d`. Neither
//      renderer owns a shape, so the honeycomb and the cards cannot drift apart.
//   2. IT IS THE HARNESS'S COLOUR, ALWAYS. Every part is drawn in the harness's own colour (tones
//      of it for depth), so "same job, different vendor" reads as the same silhouette in the same
//      colour over two different coins — which is the whole point of the badge.
//   3. SOME OF IT SITS BEHIND. Wings tuck behind the coin, glasses sit ON the face, a necktie hangs
//      below: parts declare `behind`, and both renderers draw those first. Without that, wings look
//      pasted on top of a logo instead of attached to what is wearing them.
//
// WHICH gear a harness gets is derived from its key/label (GEAR_RULES) unless the harness row names
// one explicitly (`bundle.gear`, editable in the harness manager). Derivation first, because the
// dev crew already reads as job titles — dev-scout, dev-builder, dev-reviewer — and a set of good
// defaults beats a field every author has to remember to fill in.

// How far out the art may reach, in coin radii — every renderer sizes its box off this, so it is
// also the LOGO'S share of the badge: the coin is 1/GEAR_EXTENT of the half-box, and the costume
// gets the rest. 1.7 rather than 2 because the coin is the identity — a costume that starts a full
// radius away from the logo it dresses reads as two objects near each other, not as one wearing the
// other. Every costume's inner anchor is on or inside the coin for the same reason.
export const GEAR_EXTENT = 1.7;

// ── path helpers: authoring these by hand as raw arrays is how you get a wing that looks like a
//    banana, so the shapes are BUILT with a little vocabulary and stay declarative at the far end ──
const M = (x, y) => ['M', x, y];
const L = (x, y) => ['L', x, y];
const Q = (cx, cy, x, y) => ['Q', cx, cy, x, y];
const Z = () => ['Z'];
// mirror a subpath across the vertical axis (every x negated) — the second wing, the other lens
const flip = (cmds) => cmds.map((c) => (c[0] === 'Z' ? c : [c[0], ...c.slice(1).map((v, i) => (i % 2 === 0 ? -v : v))]));
// the DIAGONAL frame a hanging tool is authored in: u runs out along 4 o'clock, v across it.
// Authoring a hammer as "a shaft from u=1 to u=1.7 with a head 0.8 wide" beats rotating rectangles
// by hand, and every tool in the set then hangs at the same angle from the same place.
const D = Math.SQRT1_2;
const dg = (u, v) => [(u - v) * D, (u + v) * D];
const dM = (u, v) => M(...dg(u, v));
const dL = (u, v) => L(...dg(u, v));
const dQ = (cu, cv, u, v) => Q(...dg(cu, cv), ...dg(u, v));
// a straight shaft along the diagonal, drawn as a stroked two-point path
const shaft = (u0, u1, width, tone = 'dark') => ({ d: [dM(u0, 0), dL(u1, 0)], stroke: tone, width, cap: 'round' });
const poly = (pts, fill = 'main') => ({ d: [M(...pts[0]), ...pts.slice(1).map((p) => L(...p)), Z()], fill });
const dpoly = (pts, fill = 'main') => poly(pts.map(([u, v]) => dg(u, v)), fill);

// ── the set ───────────────────────────────────────────────────────────────────
// Each entry: { label, parts[] } where a part is { d, fill|stroke, width?, cap?, behind?, detail? }.
// `detail` parts are dropped at small sizes (a feather notch is noise at 10px); `behind` parts are
// painted before the coin.
export const GEAR_ART = {
  // WINGS — the scout (and any messenger). They SPROUT from behind the coin's shoulders: the inner
  // end is well inside the logo's silhouette, so the pair reads as strapped to it rather than
  // hovering beside it.
  wings: {
    label: 'wings',
    parts: [
      { behind: true, fill: 'main', d: [
        M(-0.34, -0.30),
        Q(-0.86, -0.94, -1.52, -0.78),
        Q(-1.26, -0.54, -1.12, -0.40),
        Q(-1.40, -0.30, -1.48, -0.12),
        Q(-1.10, -0.20, -0.92, -0.06),
        Q(-1.10, 0.10, -1.12, 0.28),
        Q(-0.78, 0.06, -0.46, 0.18),
        Z()] },
      { behind: true, fill: 'main', d: flip([
        M(-0.34, -0.30),
        Q(-0.86, -0.94, -1.52, -0.78),
        Q(-1.26, -0.54, -1.12, -0.40),
        Q(-1.40, -0.30, -1.48, -0.12),
        Q(-1.10, -0.20, -0.92, -0.06),
        Q(-1.10, 0.10, -1.12, 0.28),
        Q(-0.78, 0.06, -0.46, 0.18),
        Z()]) },
      // the shoulder line that makes the two wings read as ONE pair rather than two leaves
      { behind: true, detail: true, stroke: 'light', width: 0.09, cap: 'round',
        d: [M(-1.00, -0.38), Q(-0.62, -0.58, -0.34, -0.40)] },
      { behind: true, detail: true, stroke: 'light', width: 0.09, cap: 'round',
        d: flip([M(-1.00, -0.38), Q(-0.62, -0.58, -0.34, -0.40)]) },
    ],
  },

  // NECKTIE — the manager. The collar sits ON the coin's lower face and the knot straddles its edge,
  // so the logo is the one wearing the tie.
  necktie: {
    label: 'necktie',
    parts: [
      { fill: 'dark', d: [M(-0.52, 0.36), L(-0.13, 0.52), L(-0.24, 0.86), Z()] },       // collar, left
      { fill: 'dark', d: flip([M(-0.52, 0.36), L(-0.13, 0.52), L(-0.24, 0.86), Z()]) }, // collar, right
      { fill: 'main', d: [M(-0.18, 0.50), L(0.18, 0.50), L(0.14, 0.80), L(-0.14, 0.80), Z()] },  // knot
      { fill: 'main', d: [M(-0.14, 0.82), L(0.14, 0.82), L(0.26, 1.32), L(0, 1.60), L(-0.26, 1.32), Z()] },
      { detail: true, stroke: 'light', width: 0.07, cap: 'round', d: [M(-0.08, 1.02), L(0.08, 1.20)] },
    ],
  },

  // HAMMER — the builder. Every hand TOOL is carried the same way: the shaft crosses the coin's
  // lower-right face (it starts inside the logo, not beside it) and only the head clears the edge.
  hammer: {
    label: 'hammer',
    parts: [
      shaft(0.40, 1.10, 0.16),
      dpoly([[1.04, -0.44], [1.46, -0.44], [1.46, 0.44], [1.04, 0.44]]),                        // head
      { detail: true, fill: 'light', d: dpoly([[1.34, -0.44], [1.46, -0.44], [1.46, 0.44], [1.34, 0.44]], 'light').d },
      { detail: true, fill: 'dark', d: dpoly([[1.04, -0.14], [1.18, -0.14], [1.18, 0.14], [1.04, 0.14]], 'dark').d },
    ],
  },

  // SHOVEL — the worker. Grip on the coin, blade past its edge.
  shovel: {
    label: 'shovel',
    parts: [
      shaft(0.34, 1.06, 0.13),
      dpoly([[0.26, -0.26], [0.40, -0.26], [0.40, 0.26], [0.26, 0.26]], 'dark'),        // grip
      { fill: 'main', d: [dM(1.00, -0.36), dL(1.32, -0.32), dQ(1.52, 0, 1.32, 0.32), dL(1.00, 0.36), Z()] },
      { detail: true, stroke: 'light', width: 0.07, cap: 'round', d: [dM(1.08, 0), dL(1.38, 0)] },
    ],
  },

  // WRENCH — the fixer. Open jaw clearing the edge.
  wrench: {
    label: 'wrench',
    parts: [
      shaft(0.34, 1.00, 0.13),
      dpoly([[0.92, -0.38], [1.52, -0.38], [1.52, -0.15], [1.16, -0.15],
             [1.16, 0.15], [1.52, 0.15], [1.52, 0.38], [0.92, 0.38]]),
    ],
  },

  // GLASSES — the reviewer. The one costume that was always on the face; the lenses now sit on the
  // logo's middle rather than under its chin.
  glasses: {
    label: 'glasses',
    parts: [
      { stroke: 'main', width: 0.13, cap: 'round', d: [M(-0.86, -0.16), Q(-1.20, -0.22, -1.42, -0.44)] },
      { stroke: 'main', width: 0.13, cap: 'round', d: flip([M(-0.86, -0.16), Q(-1.20, -0.22, -1.42, -0.44)]) },
      { stroke: 'main', width: 0.14, d: [M(-0.15, -0.10), Q(0, -0.20, 0.15, -0.10)] },   // bridge
      { stroke: 'main', width: 0.14, d: [                                                // left lens
        M(-0.15, -0.10), Q(-0.19, 0.42, -0.51, 0.46), Q(-0.86, 0.44, -0.88, 0.00),
        Q(-0.86, -0.20, -0.51, -0.20), Q(-0.21, -0.20, -0.15, -0.10), Z()] },
      { stroke: 'main', width: 0.14, d: flip([
        M(-0.15, -0.10), Q(-0.19, 0.42, -0.51, 0.46), Q(-0.86, 0.44, -0.88, 0.00),
        Q(-0.86, -0.20, -0.51, -0.20), Q(-0.21, -0.20, -0.15, -0.10), Z()]) },
    ],
  },

  // FLASK — the tester. Stood against the coin's corner, its neck overlapping the face.
  flask: {
    label: 'flask',
    parts: [
      { fill: 'main', d: [
        M(0.52, 0.42), L(0.84, 0.42), L(0.84, 0.72), L(1.20, 1.36), L(0.16, 1.36), L(0.52, 0.72), Z()] },
      { detail: true, fill: 'light', d: [M(0.34, 1.04), L(1.02, 1.04), L(1.16, 1.30), L(0.20, 1.30), Z()] },
      { stroke: 'dark', width: 0.10, cap: 'round', d: [M(0.46, 0.40), L(0.90, 0.40)] },   // lip
    ],
  },

  // QUILL — the scribe. Nib on the coin, vane sweeping off it.
  quill: {
    label: 'quill',
    parts: [
      { fill: 'main', d: [                                    // the vane, a long leaf on the shaft
        dM(0.56, 0.02), dQ(0.84, -0.56, 1.46, -0.14), dQ(1.02, 0.14, 0.56, 0.02), Z()] },
      { fill: 'main', detail: true, d: [
        dM(0.68, 0.04), dQ(0.96, 0.42, 1.38, 0.02), dQ(1.00, 0.10, 0.68, 0.04), Z()] },
      { stroke: 'dark', width: 0.09, cap: 'round', d: [dM(0.30, 0.14), dL(1.50, -0.12)] },
      { fill: 'dark', d: dpoly([[0.20, 0.18], [0.42, 0.04], [0.40, 0.26]], 'dark').d },   // the nib
    ],
  },

  // ANCHOR — the shipwright. Its ring sits on the coin's foot; the flukes swing below it.
  anchor: {
    label: 'anchor',
    parts: [
      { stroke: 'main', width: 0.11, d: [M(0, 0.50), Q(0.17, 0.62, 0, 0.74), Q(-0.17, 0.62, 0, 0.50), Z()] },
      { stroke: 'main', width: 0.13, cap: 'round', d: [M(0, 0.72), L(0, 1.44)] },
      { stroke: 'main', width: 0.11, cap: 'round', d: [M(-0.44, 0.88), L(0.44, 0.88)] },
      { stroke: 'main', width: 0.12, cap: 'round', d: [M(-0.56, 1.06), Q(-0.50, 1.48, 0, 1.46)] },
      { stroke: 'main', width: 0.12, cap: 'round', d: flip([M(-0.56, 1.06), Q(-0.50, 1.48, 0, 1.46)]) },
    ],
  },

  // SET SQUARE — the architect. A drafting triangle laid ACROSS the coin's corner rather than an L
  // parked outside it: an axis-aligned L at this reach can never touch the coin (every point on its
  // arm is ≥ its offset from centre), and a costume that cannot touch what it dresses is an ornament.
  setsquare: {
    label: 'set square',
    parts: [
      { stroke: 'main', width: 0.19, cap: 'square',
        d: [dM(0.42, -0.78), dL(1.50, 0), dL(0.42, 0.78)] },
      { stroke: 'main', width: 0.11, cap: 'round', d: [dM(0.42, -0.78), dL(0.42, 0.78)] },  // hypotenuse
      { detail: true, stroke: 'light', width: 0.07, cap: 'butt',
        d: [dM(0.78, -0.52), dL(0.90, -0.40), dM(1.06, -0.26), dL(1.18, -0.14),
            dM(0.78, 0.52), dL(0.90, 0.40), dM(1.06, 0.26), dL(1.18, 0.14)] },
    ],
  },

  // MAGNIFIER — the analyst. Held over the logo, which is the point of one.
  magnifier: {
    label: 'magnifier',
    parts: [
      { stroke: 'main', width: 0.14, d: [
        M(0.44, 0.44), Q(0.86, 0.16, 1.14, 0.44), Q(1.36, 0.80, 1.04, 1.08),
        Q(0.66, 1.30, 0.42, 0.94), Q(0.30, 0.66, 0.44, 0.44), Z()] },
      { stroke: 'dark', width: 0.16, cap: 'round', d: [M(0.44, 1.04), L(0.14, 1.32)] },
    ],
  },

  // GAVEL — the minister: it reviews the queenzee's own operations and rules on them.
  gavel: {
    label: 'gavel',
    parts: [
      shaft(0.36, 0.98, 0.14),
      dpoly([[0.92, -0.38], [1.32, -0.38], [1.32, 0.38], [0.92, 0.38]]),
      { fill: 'dark', d: dpoly([[1.40, -0.50], [1.52, -0.50], [1.52, 0.50], [1.40, 0.50]], 'dark').d },  // block
    ],
  },

  // SHIELD — anything guarding (security, the prod-guard personas). Held across the corner.
  shield: {
    label: 'shield',
    parts: [
      { fill: 'main', d: [
        M(0.86, 0.30), L(1.36, 0.54), Q(1.36, 1.14, 0.86, 1.36),
        Q(0.36, 1.14, 0.36, 0.54), Z()] },
      { detail: true, stroke: 'light', width: 0.10, cap: 'round',
        d: [M(0.64, 0.82), L(0.80, 1.00), L(1.12, 0.62)] },
    ],
  },

  // RIBBON — the fallback: a sash across the coin's foot carrying whatever glyph the harness
  // authored. Deliberately NOT another disc: an unrecognised harness should read as "a harness with
  // no costume yet", not as one more identical pip.
  ribbon: {
    label: 'ribbon',
    glyphOn: [0, 0.86],                       // where the renderer paints gear.mark, if any
    parts: [
      { fill: 'dark', d: [M(-1.06, 0.62), L(-0.62, 0.70), L(-0.62, 1.20), L(-1.06, 1.06), Z()] },
      { fill: 'dark', d: flip([M(-1.06, 0.62), L(-0.62, 0.70), L(-0.62, 1.20), L(-1.06, 1.06), Z()]) },
      { fill: 'main', d: [M(-0.74, 0.62), L(0.74, 0.62), L(0.74, 1.14), L(0, 1.02), L(-0.74, 1.14), Z()] },
    ],
  },
};

// ── the bound, ENFORCED rather than trusted ──────────────────────────────────
// Every surface reserves a box of GEAR_EXTENT coin-radii for the costume and fits itself around it:
// the hexagon badge is placed so its wingtips clear two converging edges, the DOM's viewBox is
// exactly that box. So a costume that reaches further does not just look big — it gets clipped by a
// hex edge, or it overlaps the machine line, in ONE of the two renderers and not the other.
// Authoring by hand cannot hold that invariant (a tool hung on the diagonal reaches √(u²+v²), which
// is not the number you typed), so it is measured and corrected here, once, at module load.
const scaleCmd = (c, k) => (c[0] === 'Z' ? c : [c[0], ...c.slice(1).map((v) => Number((v * k).toFixed(4)))]);
const radiusOf = (parts) => Math.max(...parts.flatMap((prt) => {
  const out = [];
  for (const c of prt.d) {
    if (c[0] === 'Z') continue;
    for (let i = 1; i < c.length; i += 2) out.push(Math.hypot(c[i], c[i + 1]));
  }
  return out.length ? out : [0];
}));
for (const gear of Object.values(GEAR_ART)) {
  const reach = radiusOf(gear.parts);
  if (reach <= GEAR_EXTENT) continue;
  const k = GEAR_EXTENT / reach;
  gear.parts = gear.parts.map((prt) => ({ ...prt, d: prt.d.map((c) => scaleCmd(c, k)),
    ...(prt.width ? { width: Number((prt.width * k).toFixed(4)) } : {}) }));
  if (gear.glyphOn) gear.glyphOn = gear.glyphOn.map((v) => Number((v * k).toFixed(4)));
}

// ── which gear, for which harness ────────────────────────────────────────────
// Matched against `<key> <label>`, in order — first hit wins, so the specific rules come first
// ('minister' before 'manager', 'shipwright' before nothing at all).
const GEAR_RULES = [
  [/minister|ops[-_ ]?review|tribunal|judge/, 'gavel'],
  [/scout|recon|hermes|messenger|courier|explor|herald/, 'wings'],
  [/review|critic|inspector|proofread/, 'glasses'],
  [/build|smith|maker|forge|carpent/, 'hammer'],
  [/ship|deploy|release|wright|sail|dock/, 'anchor'],
  [/fix|repair|debug|patch|mechanic|maint/, 'wrench'],
  [/test|qa\b|verif|assur/, 'flask'],
  [/scribe|writ|doc|author|editor|report/, 'quill'],
  [/architect|design|blueprint|planner/, 'setsquare'],
  [/secur|guard|shield|defen|sentr/, 'shield'],
  [/search|find|analy|survey|audit|research/, 'magnifier'],
  [/manager|lead|chief|boss|director|foreman/, 'necktie'],
  [/worker|labour|labor|hand|digger|grunt/, 'shovel'],
];

// The keys a human may pick from in the harness manager (plus '' = derive from the name).
export const GEAR_KEYS = Object.keys(GEAR_ART);

export function gearKeyFor(h) {
  const named = String(h?.gear || h?.harness_gear || '').trim().toLowerCase();
  if (GEAR_ART[named]) return named;
  const hay = `${h?.key || h?.harness_key || ''} ${h?.label || h?.harness_label || ''}`.toLowerCase();
  for (const [re, gear] of GEAR_RULES) if (re.test(hay)) return gear;
  return 'ribbon';
}

// ── colour: one hue, three tones ─────────────────────────────────────────────
const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
export function shade(hex, amt) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const t = amt < 0 ? 0 : 255, k = Math.abs(amt);
  const mix = (c) => clamp(c + (t - c) * k);
  const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
export const toneColor = (color, tone) => (tone === 'dark' ? shade(color, -0.38)
  : tone === 'light' ? shade(color, 0.42) : color);

export const GEAR_FALLBACK_COLOR = '#c8d3e8';

// ── the gear a surface draws ─────────────────────────────────────────────────
// Everything a renderer needs about the harness, resolved once: its colour, its artwork, the mark
// the ribbon falls back to, and whether the harness is EMPTY (which recolours the whole costume red
// — the fault has to be visible wherever a harness is drawn, and now it is the costume that says it).
export function harnessGear(h) {
  if (!h) return null;
  const glyph = String(h.glyph || h.harness_glyph || '').trim();
  const label = String(h.label || h.harness_label || h.key || h.harness_key || 'harness');
  const gearKey = gearKeyFor(h);
  return {
    key: h.key || h.harness_key || null,
    label,
    color: h.color || GEAR_FALLBACK_COLOR,
    glyph: glyph ? glyph.slice(0, 2) : null,
    mark: glyph ? glyph.slice(0, 2) : label.trim().slice(0, 1).toUpperCase(),
    empty: !!h.bundle_empty,
    gear: gearKey,
    art: GEAR_ART[gearKey],
  };
}

// ── renderer half 1: SVG (the DOM) ───────────────────────────────────────────
export const gearPathD = (part) => part.d
  .map((c) => (c[0] === 'Z' ? 'Z' : `${c[0]}${c.slice(1).map((n) => Number(n).toFixed(3)).join(' ')}`))
  .join(' ');

// ── renderer half 2: canvas ──────────────────────────────────────────────────
// Walks the SAME command list. `r` is the coin radius; unit space scales by it.
export function traceGearPart(ctx, part, cx, cy, r) {
  const X = (x) => cx + x * r, Y = (y) => cy + y * r;
  ctx.beginPath();
  for (const c of part.d) {
    if (c[0] === 'M') ctx.moveTo(X(c[1]), Y(c[2]));
    else if (c[0] === 'L') ctx.lineTo(X(c[1]), Y(c[2]));
    else if (c[0] === 'Q') ctx.quadraticCurveTo(X(c[1]), Y(c[2]), X(c[3]), Y(c[4]));
    else if (c[0] === 'Z') ctx.closePath();
  }
}

// Draw one layer of a gear (behind the coin, or in front of it). Returns how many parts it painted,
// so a caller can tell "nothing to draw" from "drew nothing because it is all detail".
export function drawGearLayer(ctx, cx, cy, r, gear, { behind = false, detail = true } = {}) {
  if (!gear?.art) return 0;
  const color = gear.empty ? '#e5554e' : gear.color;
  let n = 0;
  for (const part of gear.art.parts) {
    if (!!part.behind !== behind) continue;
    if (part.detail && !detail) continue;
    traceGearPart(ctx, part, cx, cy, r);
    if (part.fill) { ctx.fillStyle = toneColor(color, part.fill); ctx.fill(); }
    if (part.stroke) {
      ctx.strokeStyle = toneColor(color, part.stroke);
      ctx.lineWidth = Math.max(0.6, (part.width || 0.12) * r);
      ctx.lineCap = part.cap || 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
    n++;
  }
  return n;
}

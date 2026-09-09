// THE CONSOLE'S URL — a work-NODE PATH, not a query string.
//
//   /                              the PROJECTS level (every hexagon is a project)
//   /<project>                     that project, at its root level
//   /<project>/<child>/<child>     drilled into the work-node hierarchy, one segment per node
//   /m  ·  /m/<project>/<child>    the same address, phone-first (MobileChat, split in main.jsx)
//
// WHY: the honeycomb became work-node centric — `hiveMode` + `nodePath` in App.jsx ARE the address
// of what you are looking at — while the URL still said `?project=<name>` and nothing else. So the
// two deepest facts about the screen (which node level, how deep) could not be linked, shared, or
// restored by a refresh. A path says both, and reads like the hierarchy it names.
//
// TITLES, NOT IDS, are the segments: a URL a human can read is the whole point, and the node's
// title is what they see in the rail and on the crumb. Titles are not unique, so `slugsFor()`
// disambiguates COLLIDING SIBLINGS (and only those) with a short id suffix — deterministically, so
// the same tree always produces the same URL. Resolution also accepts a raw id or an id prefix, so
// an older link or a hand-typed id still lands.
//
// This module is PURE (no window, no fetch, no React) — every caller passes the pathname in and
// gets a string or a plain object back. That is what lets test/url-work-node-path.test.mjs exercise
// the whole address scheme in node, with no browser and no bundle.

export const MOBILE_PREFIX = 'm';

// A URL segment from a human's title. Lowercase, ASCII-ish, dashes for runs of anything else, and
// CAPPED — a work-item title is a sentence often enough ("since we are now work node centric…")
// that an uncapped slug would make a 300-character URL. The cap is on the slug, never on the match:
// a title's slug is compared to a title's slug, so both sides are truncated the same way.
export const SLUG_MAX = 48;
export function slugify(text, max = SLUG_MAX) {
  const s = String(text ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // strip accents, keep the letter
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, max).replace(/-+$/g, '');
}

const short = (id) => String(id || '').replace(/-/g, '').slice(0, 6);

// Every item's URL segment, keyed by id. Siblings whose titles slug to the SAME thing both get a
// `~<id6>` suffix — both of them, not just the loser, so a segment never changes meaning because a
// sibling was renamed or created later. An empty/symbol-only title falls back to the id alone.
export function slugsFor(items) {
  const byParent = new Map();
  for (const it of items || []) {
    const k = it.parent_id || '';
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(it);
  }
  const out = new Map();
  for (const sibs of byParent.values()) {
    const count = new Map();
    for (const it of sibs) {
      const base = slugify(it.title) || short(it.id);
      count.set(base, (count.get(base) || 0) + 1);
    }
    for (const it of sibs) {
      const base = slugify(it.title) || short(it.id);
      out.set(it.id, count.get(base) > 1 ? `${base}~${short(it.id)}` : base);
    }
  }
  return out;
}

// Split a pathname into the address the console understands. Empty segments and a trailing slash
// are ignored; every segment is decoded, so a project named "my project" round-trips.
export function parsePath(pathname) {
  let segs = [];
  try {
    segs = String(pathname || '/').split('/').filter(Boolean).map((s) => {
      try { return decodeURIComponent(s); } catch { return s; }
    });
  } catch { segs = []; }
  const mobile = segs[0] === MOBILE_PREFIX;
  if (mobile) segs = segs.slice(1);
  return { mobile, project: segs[0] || null, nodes: segs.slice(1) };
}

// The inverse. `project` is a project NAME (or null → the projects level), `nodes` a list of
// segments already produced by slugsFor(). Always absolute, never a trailing slash.
export function formatPath({ mobile = false, project = null, nodes = [] } = {}) {
  const parts = [];
  if (mobile) parts.push(MOBILE_PREFIX);
  if (project) {
    parts.push(project);
    for (const n of nodes || []) if (n) parts.push(n);
  }
  return '/' + parts.map((p) => encodeURIComponent(p)).join('/');
}

// A project from a URL token, by id or by name (case-insensitive) — the rule the console has always
// used for `?project=`, kept here so the path and the legacy param resolve identically.
export function findProject(projects, token) {
  if (!token) return null;
  const t = String(token);
  return (projects || []).find((p) => p.id === t || p.name?.toLowerCase() === t.toLowerCase()) || null;
}

// The pre-path URL: `?project=<name>`. Still read on load (an old bookmark, a link in a chat) and
// then rewritten as a path — never written again.
export function legacyProjectParam(search) {
  try { return new URLSearchParams(search || '').get('project'); } catch { return null; }
}

// Walk the flat work-item list from the project ROOT down the slug segments.
// Returns `{ nodes, exact }`: `nodes` is the [{id,title}] nodePath App.jsx holds — as deep as the
// URL actually resolved — and `exact` says whether every segment matched. A URL that names a node
// that has since been deleted (or is not loaded yet) resolves to its longest valid prefix rather
// than to nothing: landing one level up is a far better answer than a blank level, and `exact:false`
// tells the caller to normalise the address to what it really shows.
export function resolveNodes(items, slugs, opts = {}) {
  const list = items || [];
  const want = (slugs || []).filter(Boolean);
  if (!want.length) return { nodes: [], exact: true };
  const bySlug = slugsFor(list);
  const root = opts.rootId || list.find((i) => i.kind === 'project')?.id || null;
  const nodes = [];
  let parent = root;
  for (const seg of want) {
    const kids = list.filter((i) => i.parent_id === parent);
    const s = String(seg).toLowerCase();
    const hit = kids.find((i) => bySlug.get(i.id) === s)
      // an id, or a long-enough id prefix — an older link, or one a human pasted from the API
      || kids.find((i) => i.id === seg)
      || (s.length >= 8 ? kids.find((i) => String(i.id).startsWith(s)) : null);
    if (!hit) return { nodes, exact: false };
    nodes.push({ id: hit.id, title: hit.title });
    parent = hit.id;
  }
  return { nodes, exact: true };
}

// The URL segments for a nodePath ([{id,title}] from App.jsx) against the loaded plan. Falls back to
// slugging the title we already hold, so the address is right on the very first frame after a drill
// — before any refetch — and never renders `undefined` into the location bar.
export function pathSegments(items, nodePath) {
  const bySlug = slugsFor(items || []);
  return (nodePath || []).map((n) => bySlug.get(n.id) || slugify(n.title) || short(n.id));
}

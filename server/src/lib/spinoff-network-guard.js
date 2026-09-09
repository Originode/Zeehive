// SPINOFF → PROD-NETWORK GUARD — refuse to bring up a spin_* stack that attaches any service to
// an external network the project's PRODUCTION tier also uses.
//
// Why this exists (incident 2026-08-25/26, "/xell-web public base URL" on prod): a spinoff webapp
// joined the production docker network, kept its compose service name `webapp` as a DNS alias, and
// Docker DNS round-robined real user traffic into the spinoff's Vite. The project's own
// docker-compose.spinoff.yml carried a COMMENT advising against that attach; a comment is advice,
// not enforcement. This module is the enforcement, at the ONE door that brings a spinoff up
// (`buildContainer` → build-container.sh).
//
// Pure — no I/O. The caller reads the compose files (spinoff from the worktree, prod from the
// project repo_root) and hands the text in. Tests drive it with fixtures; buildContainer is the
// only production caller.
//
// What counts as a production network (union, never invent):
//   • manifest.tiers.prod.requires.networks (the declared list — same source guardDevOnly reads)
//   • every EXTERNAL network declared/attached in the prod compose file (covers projects whose
//     prod tier does not list networks under requires — OmniBiz's seeded shape)
//
// What counts as a spinoff attach: an EXTERNAL network that at least one service in the spinoff
// compose lists under `networks:`. Project-local / default networks are fine — they cannot collide
// with prod DNS. Undeclared names listed on a service are compose-local too (compose creates them
// under the project), so they are not refused.
import { parse } from 'yaml';

// Actual docker network name for one top-level `networks:` entry. External entries may rename:
//   foo: { external: true }                 → "foo"
//   foo: { external: { name: real-name } }  → "real-name"
// Non-external / missing → null (not a production-collision candidate).
export function externalNetworkActualName(key, decl) {
  if (!decl || typeof decl !== 'object') return null;
  const ext = decl.external;
  if (ext === true) return String(key);
  if (ext && typeof ext === 'object' && ext.name) return String(ext.name);
  return null;
}

// Every EXTERNAL network name a compose document declares at the top level.
export function declaredExternalNetworks(doc) {
  const out = new Set();
  const nets = doc?.networks;
  if (!nets || typeof nets !== 'object') return out;
  for (const [key, decl] of Object.entries(nets)) {
    const name = externalNetworkActualName(key, decl);
    if (name) out.add(name);
  }
  return out;
}

// Service → list of network keys it attaches to (compose accepts an array or a map).
function serviceNetworkKeys(svc) {
  const n = svc?.networks;
  if (!n) return [];
  if (Array.isArray(n)) return n.map(String);
  if (typeof n === 'object') return Object.keys(n);
  return [];
}

// EXTERNAL networks that at least one service in this compose actually attaches to. That is the
// attach surface a `compose up` would put onto the docker network — the DNS-collision risk.
export function attachedExternalNetworks(doc) {
  const declared = new Map(); // key → actual name (external only)
  const nets = doc?.networks;
  if (nets && typeof nets === 'object') {
    for (const [key, decl] of Object.entries(nets)) {
      const actual = externalNetworkActualName(key, decl);
      if (actual) declared.set(key, actual);
    }
  }
  const out = new Set();
  for (const svc of Object.values(doc?.services || {})) {
    for (const key of serviceNetworkKeys(svc)) {
      const actual = declared.get(key);
      if (actual) out.add(actual);
    }
  }
  return out;
}

// Forbidden set for a project: prod requires.networks ∪ external networks in the prod compose.
export function prodNetworkNames(manifest, prodComposeDoc = null) {
  const out = new Set();
  const req = manifest?.tiers?.prod?.requires?.networks || [];
  for (const n of req) {
    const name = typeof n === 'string' ? n : n?.name;
    if (name) out.add(String(name));
  }
  if (prodComposeDoc) {
    for (const name of declaredExternalNetworks(prodComposeDoc)) out.add(name);
  }
  return out;
}

function asDoc(yamlOrDoc) {
  if (yamlOrDoc == null) return null;
  if (typeof yamlOrDoc === 'string') {
    const text = yamlOrDoc.trim();
    if (!text) return null;
    return parse(text);
  }
  return yamlOrDoc;
}

// The gate. Returns { ok:true } or { ok:false, overlap, attached, forbidden, error }.
// Never throws — the caller decides whether to throw (buildContainer does).
export function checkSpinoffProdNetworkAttach({
  spinComposeYaml = null,
  spinComposeDoc = null,
  manifest = null,
  prodComposeYaml = null,
  prodComposeDoc = null,
} = {}) {
  const spinDoc = spinComposeDoc || asDoc(spinComposeYaml);
  if (!spinDoc) return { ok: true, attached: [], forbidden: [], overlap: [] };

  const prodDoc = prodComposeDoc || asDoc(prodComposeYaml);
  const attached = [...attachedExternalNetworks(spinDoc)].sort();
  const forbidden = [...prodNetworkNames(manifest, prodDoc)].sort();
  if (!attached.length || !forbidden.length) {
    return { ok: true, attached, forbidden, overlap: [] };
  }
  const forbidSet = new Set(forbidden);
  const overlap = attached.filter((n) => forbidSet.has(n));
  if (!overlap.length) return { ok: true, attached, forbidden, overlap: [] };

  const error =
    `refusing to bring up spinoff: service(s) attach to external production network `
    + `${overlap.map((n) => `'${n}'`).join(', ')}. A spin_* container on a prod network shares `
    + `Docker DNS with production (service names like \`webapp\` collide) — that is the `
    + `2026-08-25/26 outage engine. Remove the network attach from the spinoff compose `
    + `(or move shared-dev reachability off the prod network).`;
  return { ok: false, attached, forbidden, overlap, error };
}

// Throw-on-refuse wrapper for the build path — same shape as the other buildContainer guards.
export function assertSpinoffNotOnProdNetworks(args) {
  const r = checkSpinoffProdNetworkAttach(args);
  if (!r.ok) {
    const err = new Error(r.error);
    err.code = 'SPINOFF_PROD_NETWORK';
    err.overlap = r.overlap;
    throw err;
  }
  return r;
}

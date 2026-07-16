// zeehive.yml — the project's own declaration of its SHAPE (docs/deploy-topology-spec.md §3.1):
// which compose file serves each tier, how roles map to services, naming templates for per-xell
// containers/images, env conventions, port scheme, db identity, ship entry point.
//
// The repo file is the truth; the project row carries a parsed CACHE (project.manifest jsonb +
// manifest_hash) stamped at onboarding/refresh so the queenzee answers naming/compose questions
// without reading the repo per decision. Everything here degrades gracefully: no manifest → the
// OmniBiz-era defaults derived from the project name, exactly as before manifests existed.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parse, stringify } from 'yaml';

export const MANIFEST_FILES = ['zeehive.yml', 'zeehive.yaml'];
const TIERS = ['dev', 'spinoff', 'prod'];

export function manifestHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// docker-safe project token: "OmniBiz" → "omnibiz", "My Project" → "myproject"
export function sanitizeName(name) {
  return String(name || 'project').toLowerCase().replace(/[^a-z0-9]/g, '') || 'project';
}

// The naming templates used when the manifest doesn't override them. {slug}/{role}/{project}
// are the placeholders; a new project named "Acme" gets acme_spin_server_<slug> etc.
export function defaultNaming(projectName) {
  const p = sanitizeName(projectName);
  return {
    container: { default: `${p}_spin_{role}_{slug}` },
    image: { default: `${p}-spin-{role}:{slug}` },
    compose_project: `${p}-spin-{slug}`,
  };
}

function fill(tpl, { project, role, slug }) {
  return String(tpl)
    .replaceAll('{project}', project)
    .replaceAll('{role}', role)
    .replaceAll('{slug}', slug);
}

// Resolve the names for one per-xell (role, slug) of a project row. Precedence: the project's
// cached manifest naming → name-derived defaults. Role-specific template beats the 'default' one.
export function namingFor(project, role, slug) {
  const p = sanitizeName(project?.name);
  const naming = project?.manifest?.naming || {};
  const defs = defaultNaming(project?.name);
  const pick = (section) => {
    const m = { ...defs[section], ...(naming[section] || {}) };
    return m[role] || m.default;
  };
  const vars = { project: p, role, slug };
  return {
    container: fill(pick('container'), vars),
    image: fill(pick('image'), vars),
    composeProject: fill(naming.compose_project || defs.compose_project, vars),
  };
}

// ── validation ────────────────────────────────────────────────────────────────
// Structural problems are errors (the manifest cannot be used); referenced-file checks are
// warnings (the caller may be looking at a different branch than the checkout on disk).
export function parseManifest(text, { dir = null } = {}) {
  const errors = [], warnings = [];
  let m;
  try { m = parse(text); } catch (e) { return { manifest: null, errors: [`not valid YAML: ${e.message}`], warnings }; }
  if (!m || typeof m !== 'object') return { manifest: null, errors: ['manifest is empty'], warnings };

  if (m.version !== 1) errors.push(`version must be 1 (got ${JSON.stringify(m.version)})`);
  if (m.tiers != null && typeof m.tiers !== 'object') errors.push('tiers must be a map');
  for (const [tier, t] of Object.entries(m.tiers || {})) {
    if (!TIERS.includes(tier)) { warnings.push(`unknown tier "${tier}" (known: ${TIERS.join(', ')})`); continue; }
    if (!t || typeof t !== 'object') { errors.push(`tiers.${tier} must be a map`); continue; }
    if (t.compose && typeof t.compose !== 'string') errors.push(`tiers.${tier}.compose must be a path string`);
    if (t.compose && dir && !existsSync(resolve(dir, t.compose))) {
      warnings.push(`tiers.${tier}.compose "${t.compose}" not found in ${dir} (different branch?)`);
    }
    for (const [role, p] of Object.entries(t.ports || {})) {
      if (p == null || typeof p !== 'object' || !Number.isFinite(Number(p.base))) {
        errors.push(`tiers.${tier}.ports.${role} needs a numeric base (got ${JSON.stringify(p)})`);
      }
    }
    for (const key of ['networks', 'volumes']) {
      const v = t.requires?.[key];
      if (v != null && !Array.isArray(v)) errors.push(`tiers.${tier}.requires.${key} must be a list`);
    }
  }
  for (const [role, r] of Object.entries(m.roles || {})) {
    if (!r || typeof r !== 'object' || typeof r.service !== 'string') {
      errors.push(`roles.${role} needs a {service: <compose service name>} map`);
    }
  }
  for (const section of ['container', 'image']) {
    for (const [role, tpl] of Object.entries(m.naming?.[section] || {})) {
      if (!String(tpl).includes('{slug}')) errors.push(`naming.${section}.${role} must contain {slug}`);
    }
  }
  if (m.naming?.compose_project && !String(m.naming.compose_project).includes('{slug}')) {
    errors.push('naming.compose_project must contain {slug}');
  }
  if (m.ship?.script && dir && !existsSync(resolve(dir, m.ship.script))) {
    warnings.push(`ship.script "${m.ship.script}" not found in ${dir}`);
  }
  if (m.env?.file && typeof m.env.file !== 'string') errors.push('env.file must be a path string');
  if (m.db && (m.db.name != null && typeof m.db.name !== 'string')) errors.push('db.name must be a string');

  return { manifest: errors.length ? null : m, errors, warnings };
}

// Read + parse a repo's manifest. found:false is a normal condition (pre-manifest project),
// never an error.
export function loadManifest(repoRoot) {
  const dir = String(repoRoot || '').replace(/\\/g, '/');
  for (const f of MANIFEST_FILES) {
    const path = resolve(dir, f);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    const { manifest, errors, warnings } = parseManifest(text, { dir });
    return { found: true, file: f, path, text, hash: manifestHash(text), manifest, errors, warnings };
  }
  return { found: false };
}

// What a manifest contributes to the project row at onboarding — only the columns it actually
// declares; everything else keeps the caller's value.
export function projectDefaultsFromManifest(m) {
  if (!m) return {};
  const out = {};
  const t = m.tiers || {};
  if (t.dev?.compose) out.compose_dev = t.dev.compose;
  if (t.spinoff?.compose) out.compose_spinoff = t.spinoff.compose;
  if (t.prod?.compose) out.compose_prod = t.prod.compose;
  if (m.env?.file) out.env_file = m.env.file;
  const ports = t.spinoff?.ports || {};
  if (ports.server?.base != null) out.port_server_base = Number(ports.server.base);
  if (ports.webapp?.base != null) out.port_web_base = Number(ports.webapp.base);
  const mods = [ports.server?.mod, ports.webapp?.mod].filter((x) => x != null).map(Number);
  if (mods.length) out.port_slot_mod = mods[0];
  if (m.db?.name) out.db_name = m.db.name;
  if (m.db?.user) out.db_user = m.db.user;
  return out;
}

// ── draft generation (spec §7 Phase 2.3) ─────────────────────────────────────
// A best-effort zeehive.yml for a repo that hasn't got one: scan compose files, guess the
// tier of each by filename, guess role→service from service names. A HUMAN reviews and
// commits it — this never writes into the repo by itself.
const TIER_HINTS = [[/spin/i, 'spinoff'], [/prod/i, 'prod'], [/dev/i, 'dev']];
const ROLE_HINTS = [
  [/^(server|api|backend|app)$/i, 'server'],
  [/^(web|webapp|frontend|ui|client)$/i, 'webapp'],
  [/^(postgres|postgresql|db|database|mysql|mariadb)$/i, 'db'],
];

export function draftManifest(repoRoot, projectName) {
  const dir = String(repoRoot || '').replace(/\\/g, '/');
  const composeFiles = readdirSync(dir).filter((f) => /^docker-compose.*\.ya?ml$/.test(f)).sort();
  const tiers = {};
  const services = new Set();
  for (const f of composeFiles) {
    const tier = (TIER_HINTS.find(([re]) => re.test(f)) || [null, null])[1];
    if (!tier || tiers[tier]) continue; // first match per tier wins; the human can re-point it
    tiers[tier] = { compose: f };
    try {
      for (const s of Object.keys(parse(readFileSync(resolve(dir, f), 'utf8'))?.services || {})) services.add(s);
    } catch { /* unparseable compose — the human will notice */ }
  }
  const roles = {};
  for (const s of services) {
    const role = (ROLE_HINTS.find(([re]) => re.test(s)) || [null, null])[1];
    if (role && !roles[role]) roles[role] = { service: s, buildable: role !== 'db' };
  }
  const p = sanitizeName(projectName);
  const draft = {
    version: 1,
    project: p,
    env: { file: '.env', generated: '.zeehive.env' },
    tiers: {
      ...tiers,
      ...(tiers.spinoff ? {
        spinoff: {
          ...tiers.spinoff,
          project_name: `${p}-spin-{slug}`,
          ports: { server: { base: 3100, mod: 90 }, webapp: { base: 5200, mod: 90 } },
        },
      } : {}),
    },
    roles,
    naming: defaultNaming(projectName),
  };
  return '# zeehive.yml — DRAFT generated by ZEEHIVE from a compose-file scan. Review, correct, commit.\n'
    + '# Docs: <zeehive>/docs/deploy-topology-spec.md §3.1\n'
    + stringify(draft);
}

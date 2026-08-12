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
      // A DEVICE xhip publishes two ports (adb + web viewer), so its port block is {adb_base,
      // viewer_base}, not a single {base} like server/webapp/db. Both default in the device driver,
      // so either may be omitted — only reject a value that is present but non-numeric.
      if (role === 'device') {
        for (const k of ['adb_base', 'viewer_base']) {
          if (p?.[k] != null && !Number.isFinite(Number(p[k]))) {
            errors.push(`tiers.${tier}.ports.device.${k} must be numeric (got ${JSON.stringify(p[k])})`);
          }
        }
        continue;
      }
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
  // device: opt-in mobile-device xhip (035). Only `enabled` is required to turn it on; the rest
  // default in lib/devices.js. Validated lightly — a bad kind/image shouldn't be silently ignored.
  if (m.device != null) {
    if (typeof m.device !== 'object') errors.push('device must be a map (e.g. { enabled: true })');
    else {
      if (m.device.kind != null && !['emulator', 'physical'].includes(m.device.kind)) {
        errors.push(`device.kind must be "emulator" or "physical" (got ${JSON.stringify(m.device.kind)})`);
      }
      if (m.device.image != null && typeof m.device.image !== 'string') errors.push('device.image must be a string');
      if (m.device.cxell_image != null && typeof m.device.cxell_image !== 'string') errors.push('device.cxell_image must be a string (a zee-agent image with the Android SDK)');
    }
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

// Is THIS project's per-xell server a bare process (spec §6.1), not a docker container?
// Same signal provision.js / build.js / fleet.js already read: roles.server.runner, falling
// back to the spinoff tier's runner. A process server gets docker_ctx=NULL at provision, so
// machine-mode ready counts (JOIN on container.role='server' AND docker_ctx) are always zero
// for it — that is the 167-xell runaway the pool guard exists to stop. Compose-shaped projects
// (no process runner) stamp docker_ctx even when compose_spinoff is unset, so they ARE
// machine-placeable; the compose file is a build detail (build-container.sh defaults to
// docker-compose.spinoff.yml), not the placement predicate.
export function serverRoleIsProcess(manifest) {
  const m = manifest || {};
  return (m?.roles?.server?.runner || m?.tiers?.spinoff?.runner || null) === 'process';
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

// Filename → tier guess. First match wins per tier when several files look alike.
export function guessComposeTier(filename) {
  return (TIER_HINTS.find(([re]) => re.test(filename)) || [null, null])[1];
}

// Compose files at the repo root (same scan draftManifest and probeRepo use).
export function listComposeFiles(repoRoot) {
  const dir = String(repoRoot || '').replace(/\\/g, '/');
  if (!dir || !existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => /^docker-compose.*\.ya?ml$/.test(f)).sort();
  } catch { return []; }
}

// Parse one compose file's service names (best-effort; unparseable → []).
function composeServices(dir, file) {
  try {
    const m = parse(readFileSync(resolve(dir, file), 'utf8'));
    return Object.keys(m?.services || {});
  } catch { return []; }
}

// Suggest tier→compose + role→service values from a compose-file scan — the "no manifest yet"
// wizard's pre-fill, so a human who HAS compose files doesn't have to type service names. Pure
// read of the repo; never writes.
export function detectComposeSuggestions(repoRoot) {
  const dir = String(repoRoot || '').replace(/\\/g, '/');
  const out = { compose: {}, roles: {}, files: [] };
  const files = listComposeFiles(dir);
  for (const f of files) {
    const tier = guessComposeTier(f);
    const svcs = composeServices(dir, f);
    out.files.push({ file: f, tier_guess: tier, services: svcs });
    if (tier && !out.compose[tier]) out.compose[tier] = f;
  }
  const services = new Set();
  for (const f of files) {
    for (const s of composeServices(dir, f)) services.add(s);
  }
  for (const s of services) {
    const role = (ROLE_HINTS.find(([re]) => re.test(s)) || [null, null])[1];
    if (role && !out.roles[role]) out.roles[role] = s;
  }
  return out;
}

// Build the draft object (not the YAML string) from a compose-file scan. Shared by
// draftManifest and planComposeOnboarding so the plan and the written file agree.
export function draftManifestObject(repoRoot, projectName) {
  const dir = String(repoRoot || '').replace(/\\/g, '/');
  const composeFiles = listComposeFiles(dir);
  const tiers = {};
  const services = new Set();
  const detected = [];
  for (const f of composeFiles) {
    const tier = guessComposeTier(f);
    const svcs = composeServices(dir, f);
    detected.push({ file: f, tier_guess: tier, services: svcs });
    if (!tier || tiers[tier]) continue; // first match per tier wins; the human can re-point it
    tiers[tier] = { compose: f };
    for (const s of svcs) services.add(s);
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
  return { draft, detected, composeFiles };
}

export function draftManifest(repoRoot, projectName) {
  const { draft } = draftManifestObject(repoRoot, projectName);
  return '# zeehive.yml — DRAFT generated by ZEEHIVE from a compose-file scan. Review, correct, commit.\n'
    + '# Docs: <zeehive>/docs/deploy-topology-spec.md §3.1\n'
    + stringify(draft);
}

// ── knob-driven draft (the "no manifest yet" onboarding wizard) ──────────────
// Where draftManifestObject scans compose files, buildManifestFromKnobs builds the
// manifest from what the HUMAN picked in the console's guided form: which compose file
// serves each tier, which service plays each role, the port scheme. Each value is
// optional — a blank knob just omits that section, so the wizard works for a repo with
// no compose files at all (the "generic yaml that does nothing" complaint: the old draft
// was empty unless compose files existed).
const KNOB_TIERS = ['dev', 'spinoff', 'prod'];
const KNOB_ROLES = ['server', 'webapp', 'db'];

export function buildManifestFromKnobs(projectName, knobs = {}) {
  const p = sanitizeName(projectName);
  const tiers = {};
  for (const tier of KNOB_TIERS) {
    const compose = String(knobs?.tiers?.[tier]?.compose || '').trim();
    if (compose) tiers[tier] = { compose };
  }
  if (tiers.spinoff) {
    const ports = {};
    const sb = Number(knobs?.ports?.server_base);
    const wb = Number(knobs?.ports?.webapp_base);
    const mod = Number(knobs?.ports?.slot_mod);
    if (Number.isFinite(sb) && sb > 0) ports.server = { base: sb };
    if (Number.isFinite(wb) && wb > 0) ports.webapp = { base: wb };
    if (Number.isFinite(mod) && mod > 0) {
      if (ports.server) ports.server.mod = mod;
      if (ports.webapp) ports.webapp.mod = mod;
    }
    if (Object.keys(ports).length) tiers.spinoff.ports = ports;
  }
  const roles = {};
  for (const role of KNOB_ROLES) {
    const svc = String(knobs?.roles?.[role]?.service || '').trim();
    if (svc) roles[role] = { service: svc };
  }
  return {
    version: 1,
    project: p,
    env: { file: String(knobs?.env_file || '.env').trim() || '.env', generated: '.zeehive.env' },
    ...(Object.keys(tiers).length ? { tiers } : {}),
    ...(Object.keys(roles).length ? { roles } : {}),
    naming: defaultNaming(projectName),
  };
}

export function draftManifestFromKnobs(projectName, knobs = {}) {
  const manifest = buildManifestFromKnobs(projectName, knobs);
  return {
    manifest,
    yaml: '# zeehive.yml — built from the project setup form. Review, correct, commit.\n'
      + '# Docs: <zeehive>/docs/deploy-topology-spec.md §3.1\n'
      + stringify(manifest),
  };
}

// Merge detected tier compose paths into an EXISTING manifest without clobbering what the
// human already set. In particular: never strip runner:process, never replace an existing
// tiers.*.compose, never drop roles. Only FILLS gaps — so a Zeehive process project that also
// has docker-compose.prod.yml gains tiers.prod.compose and keeps its process spinoff.
export function mergeComposeIntoManifest(existing, detectedTiers) {
  const base = existing && typeof existing === 'object'
    ? JSON.parse(JSON.stringify(existing)) : { version: 1 };
  if (base.version == null) base.version = 1;
  if (!base.tiers || typeof base.tiers !== 'object') base.tiers = {};
  const added = [];
  for (const [tier, file] of Object.entries(detectedTiers || {})) {
    if (!TIERS.includes(tier) || !file) continue;
    const cur = base.tiers[tier];
    if (cur && typeof cur === 'object' && cur.compose) continue; // already declared — leave it
    base.tiers[tier] = { ...(cur && typeof cur === 'object' ? cur : {}), compose: file };
    added.push({ tier, compose: file });
  }
  return { manifest: base, added };
}

// ── compose → meta-DB onboarding plan (human-gated) ──────────────────────────
// Detect compose files, propose what the meta-DB row (and optionally zeehive.yml) should
// carry, and list every file that would be touched. The apply path refuses without
// `approved: true`. Production container rows and deploy_site.compose_file are NEVER in
// the change set — live stacks keep the compose_file stamped on them at provision/ship.
//
// currentProject supplies today's columns + cached manifest so the plan is a diff, not a
// guess. Returns { applicable, reason?, compose_files, yml, meta_changes, files_to_modify,
// containers_untouched, warnings, proposed_manifest, proposed_yml }.
export function planComposeOnboarding(repoRoot, projectName, currentProject = {}) {
  const dir = String(repoRoot || '').replace(/\\/g, '/');
  const warnings = [];
  const { draft: scanned, detected } = draftManifestObject(dir, projectName || currentProject.name);
  const existing = loadManifest(dir);

  // Tier → compose file from the scan (first guess per tier).
  const detectedTiers = {};
  for (const d of detected) {
    if (d.tier_guess && !detectedTiers[d.tier_guess]) detectedTiers[d.tier_guess] = d.file;
  }
  if (!detected.length) {
    return {
      applicable: false,
      reason: 'no docker-compose*.yml files at the repo root',
      compose_files: [],
      yml: { exists: existing.found, path: existing.file || 'zeehive.yml', action: 'none' },
      meta_changes: [],
      files_to_modify: [],
      containers_untouched: true,
      warnings: [],
      proposed_manifest: currentProject.manifest || null,
      proposed_yml: null,
    };
  }

  // Build the proposed manifest: start from the repo file (or the scan draft), then fill any
  // tier.compose gaps the scan found. Process runners and existing compose paths stay put.
  let proposed;
  let ymlAction; // 'create' | 'update' | 'unchanged'
  let added = [];
  if (existing.found && existing.manifest) {
    const merged = mergeComposeIntoManifest(existing.manifest, detectedTiers);
    proposed = merged.manifest;
    added = merged.added;
    ymlAction = added.length ? 'update' : 'unchanged';
  } else {
    proposed = scanned;
    added = Object.entries(detectedTiers).map(([tier, compose]) => ({ tier, compose }));
    ymlAction = 'create';
  }

  // Roles: only fill missing ones from the scan (never overwrite a human's role map).
  if (scanned.roles) {
    if (!proposed.roles) proposed.roles = {};
    for (const [role, r] of Object.entries(scanned.roles)) {
      if (!proposed.roles[role]) {
        proposed.roles[role] = r;
        if (!added.find((a) => a.tier === `role:${role}`)) {
          warnings.push(`role "${role}" → service "${r.service}" inferred from compose services`);
        }
      }
    }
  }

  const proposedYml = '# zeehive.yml — proposed by ZEEHIVE compose onboarding. Review before apply.\n'
    + '# Docs: <zeehive>/docs/deploy-topology-spec.md §3.1\n'
    + stringify(proposed);

  // Meta-DB column diffs (project row only).
  const md = projectDefaultsFromManifest(proposed);
  const colMap = [
    ['compose_dev', md.compose_dev],
    ['compose_spinoff', md.compose_spinoff],
    ['compose_prod', md.compose_prod],
    ['env_file', md.env_file],
    ['port_server_base', md.port_server_base],
    ['port_web_base', md.port_web_base],
    ['port_slot_mod', md.port_slot_mod],
    ['db_name', md.db_name],
    ['db_user', md.db_user],
  ];
  const meta_changes = [];
  for (const [col, to] of colMap) {
    if (to === undefined || to === null) continue;
    const from = currentProject[col] ?? null;
    // Don't "change" env_file from null/.env to .env noise
    if (String(from ?? '') === String(to ?? '')) continue;
    // Don't overwrite a non-empty column with a different value silently — flag it
    if (from != null && from !== '' && String(from) !== String(to)) {
      warnings.push(`meta-DB ${col}: currently "${from}", proposal wants "${to}" — apply will update the project row (NOT live containers)`);
    }
    meta_changes.push({ column: col, from, to });
  }

  // Manifest cache: only count as a change when the cache is empty OR the compose-tier
  // declarations actually differ. A pure YAML re-stringify of the same shape must NOT make
  // the plan applicable again (idempotent second plan after a successful apply).
  const curHash = currentProject.manifest_hash || null;
  const newHash = manifestHash(proposedYml);
  const tierComposeOf = (m) => {
    const out = {};
    for (const t of TIERS) {
      const c = m?.tiers?.[t]?.compose;
      if (c) out[t] = c;
    }
    return out;
  };
  const curTierCompose = JSON.stringify(tierComposeOf(currentProject.manifest));
  const propTierCompose = JSON.stringify(tierComposeOf(proposed));
  const manifestNeedsCache = !currentProject.manifest
    || curTierCompose !== propTierCompose;
  if (manifestNeedsCache) {
    meta_changes.unshift({
      column: 'manifest',
      from: curHash ? `cached @ ${curHash}` : '(empty)',
      to: `proposed @ ${newHash.slice(0, 16)}`,
    });
  }

  const ymlPath = existing.file || 'zeehive.yml';
  const files_to_modify = [];
  if (ymlAction === 'create') {
    files_to_modify.push({
      path: ymlPath,
      action: 'create',
      exists: false,
      detail: 'new zeehive.yml from the compose-file scan (the ONE file ZEEHIVE may write into a project repo)',
    });
  } else if (ymlAction === 'update') {
    files_to_modify.push({
      path: ymlPath,
      action: 'update',
      exists: true,
      detail: `add missing tier compose path(s): ${added.map((a) => `${a.tier}→${a.compose}`).join(', ')} — existing keys (including runner:process) are preserved`,
    });
  }

  // Nothing to do? File writes or real column/tier-compose gaps only — not a cosmetic re-hash.
  const applicable = files_to_modify.length > 0 || meta_changes.length > 0;
  if (!applicable) {
    warnings.push('compose files are already reflected in the meta-DB and zeehive.yml — nothing to apply');
  }

  // Process-runner callout: adopting a spinoff compose does NOT strip process mode unless the
  // human edits the yml themselves. Remote machine placement stays off for process servers —
  // the queenzee-host machine's pool still governs them (pool.js;
  // docs/process-machine-pooling-decision-record.md).
  if (serverRoleIsProcess(proposed) && detectedTiers.spinoff) {
    warnings.push('spinoff server stays runner:process — remote machine placement will remain off until the server role is a compose service (the queenzee-host machine\'s pool size still governs; see pool.js)');
  }
  if (detectedTiers.prod) {
    warnings.push('production containers are NOT modified: live prod stacks keep the compose_file already stamped on each container row; only the project.compose_prod column (and the yml, if written) change');
  }

  return {
    applicable,
    reason: applicable ? null : 'already configured',
    compose_files: detected,
    yml: {
      exists: !!existing.found,
      path: ymlPath,
      action: ymlAction,
      added_tiers: added,
    },
    meta_changes,
    files_to_modify,
    // Hard guarantee the apply path also enforces: no container / deploy_site writes.
    containers_untouched: true,
    deploy_sites_untouched: true,
    warnings,
    proposed_manifest: proposed,
    proposed_yml: proposedYml,
    proposed_hash: newHash.slice(0, 16),
  };
}

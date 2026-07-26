// HARNESSES — shared, system-wide config layers assigned to xells (docs/harness-proposal.md).
//
// A harness carries a config BUNDLE (personality, skills, memory, tools, bridge) parsed from files
// in the Zeehive project under harnesses/<key>/. The DB row (migration 044) is a parsed, hashed
// PROJECTION of those files — the repo is truth, drift is surfaced (same pattern as project.manifest).
//
// LAW: the `core` harness is the built-in, undeletable law layer (the cxell-zee manual + the binding
// rules), assembled in bindingFor()/spawnCxell(). Every xell always gets core; an assigned harness
// (e.g. hermes) layers BELOW it and may ADD, never OVERRIDE, the queenzee-interaction rules. That
// non-override is enforced HERE, structurally: parseHarness() REJECTS a bundle that names a reserved
// (law) key — a harness bundle simply has nowhere to express a land/ship/prod/gate rule. A harness
// never ships or lands; it is only a guide (the zee is the one to ship/land).
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { q, one } from '../db/pool.js';
import { config } from '../config.js';
import { logline } from './logbus.js';
import { cleanGitEnv } from './git.js';

export const HARNESS_MANIFEST = 'HARNESS.yml';

// Keys a harness bundle may NOT define — anything that would redefine how a zee talks to
// zeehive/queenzee, or a gate. The manual + binding rules own these; a harness that names one is
// rejected at parse time, so "the manual is law" holds by construction, not by prompt order.
const RESERVED_LAW_KEYS = new Set([
  'land', 'ship', 'prod', 'done', 'gate', 'gates', 'rules', 'rule', 'manual',
  'queenzee', 'binding', 'law', 'landing', 'shipping', 'deploy',
]);

// Keys a harness bundle MAY define (everything else is ignored with a warning).
const ALLOWED_KEYS = new Set([
  'version', 'label', 'summary', 'description', 'personality', 'voice',
  'skills', 'memory', 'tools', 'avatar', 'bridge',
]);

const hashOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

// ── parse + validate a harness manifest ──────────────────────────────────────
// Structural problems and any RESERVED law key are errors (the bundle cannot be used); an unknown
// key is a warning. Returns { bundle, errors, warnings }.
export function parseHarness(text) {
  const errors = [], warnings = [];
  let m;
  try { m = parse(text); } catch (e) { return { bundle: null, errors: [`not valid YAML: ${e.message}`], warnings }; }
  if (m == null) return { bundle: {}, errors, warnings };            // an empty manifest is a valid no-op harness
  if (typeof m !== 'object' || Array.isArray(m)) return { bundle: null, errors: ['manifest must be a map'], warnings };

  for (const k of Object.keys(m)) {
    if (RESERVED_LAW_KEYS.has(k.toLowerCase())) {
      errors.push(`"${k}" is a reserved LAW key — a harness may add guidance but never redefine how a zee interacts with zeehive/queenzee (land/ship/prod/gates). Remove it.`);
    } else if (!ALLOWED_KEYS.has(k.toLowerCase())) {
      warnings.push(`unknown key "${k}" ignored (allowed: ${[...ALLOWED_KEYS].join(', ')})`);
    }
  }
  if (m.skills != null && !Array.isArray(m.skills)) errors.push('skills must be a list');
  if (m.memory != null && !Array.isArray(m.memory)) errors.push('memory must be a list of file paths');
  if (m.tools != null && !Array.isArray(m.tools)) errors.push('tools must be a list (it may only NARROW the mode\'s tools, never widen them)');
  if (m.bridge != null && (typeof m.bridge !== 'object' || Array.isArray(m.bridge))) errors.push('bridge must be a map');

  return { bundle: errors.length ? null : m, errors, warnings };
}

// Last commit that touched a harness's folder — the graph anchors the harness node here. Best-effort
// (a fresh repo / uncommitted folder → null, and the timeline falls back to the tip).
function dirHeadCommit(repoRoot, dir) {
  try {
    const r = spawnSync('git', ['-C', repoRoot, 'log', '-1', '--format=%H', '--', dir],
      { encoding: 'utf8', timeout: 8000, windowsHide: true, env: cleanGitEnv() });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  } catch { return null; }
}

// Read a skill folder (skills/<name>/SKILL.md) into { name, when, body }. A SKILL.md may lead with a
// YAML frontmatter block (--- ... ---) carrying name/description; if absent we derive name from the
// folder and use the first paragraph as the "when to use" line. Delivery is provider-neutral here —
// the adapter decides SKILL.md-file vs prompt-injection (docs §6.2).
function readSkill(skillDir, folderName) {
  const md = join(skillDir, 'SKILL.md');
  if (!existsSync(md)) return null;
  const raw = readFileSync(md, 'utf8');
  let name = folderName, when = '', body = raw;
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fm) {
    try { const meta = parse(fm[1]) || {}; name = meta.name || name; when = meta.description || meta.when || ''; } catch { /* ignore bad frontmatter */ }
    body = fm[2].trim();
  }
  if (!when) when = body.split('\n\n')[0].replace(/\s+/g, ' ').slice(0, 240);
  return { name, when, body, path: `${skillDir.replace(config.repoRoot + '/', '')}/SKILL.md` };
}

// Assemble a bundle object from a harness folder: HARNESS.yml (validated) + PERSONALITY.md +
// skills/*/SKILL.md + memory/*.md + avatar. Returns { bundle, hash, errors, warnings, files }.
export function loadHarnessDir(dir) {
  const abs = resolve(config.repoRoot, dir);
  if (!existsSync(abs)) return { bundle: null, hash: null, errors: [`harness dir not found: ${dir}`], warnings: [], files: [] };

  const files = [];
  let text = '{}';
  const man = join(abs, HARNESS_MANIFEST);
  if (existsSync(man)) { text = readFileSync(man, 'utf8'); files.push(`${dir}/${HARNESS_MANIFEST}`); }
  const { bundle: parsed, errors, warnings } = parseHarness(text);
  if (!parsed) return { bundle: null, hash: null, errors, warnings, files };
  const bundle = { ...parsed };

  // personality: inline in the manifest, or PERSONALITY.md beside it
  const pmd = join(abs, 'PERSONALITY.md');
  if (typeof bundle.personality === 'string' && bundle.personality.trim() && !bundle.personality.endsWith('.md')) {
    /* inline text — keep as-is */
  } else if (existsSync(pmd)) {
    bundle.personality = readFileSync(pmd, 'utf8').trim();
    files.push(`${dir}/PERSONALITY.md`);
  } else if (bundle.personality) {
    const p = join(abs, bundle.personality);
    if (existsSync(p)) { bundle.personality = readFileSync(p, 'utf8').trim(); files.push(`${dir}/${bundle.personality}`); }
  }

  // skills: each declared skill folder, or every folder under skills/
  const skillsRoot = join(abs, 'skills');
  const declared = Array.isArray(bundle.skills) ? bundle.skills.map((s) => (typeof s === 'string' ? s : s?.name)).filter(Boolean) : null;
  const skills = [];
  if (existsSync(skillsRoot) && statSync(skillsRoot).isDirectory()) {
    const names = declared || readdirSync(skillsRoot).filter((n) => statSync(join(skillsRoot, n)).isDirectory());
    for (const n of names) {
      const s = readSkill(join(skillsRoot, n), n);
      if (s) { skills.push(s); files.push(s.path); }
    }
  }
  bundle.skills = skills;

  // memory files → inline text (a small curated set; large files are the harness author's problem)
  if (Array.isArray(bundle.memory)) {
    bundle.memory = bundle.memory.map((rel) => {
      const p = join(abs, rel);
      if (existsSync(p)) { files.push(`${dir}/${rel}`); return { path: rel, text: readFileSync(p, 'utf8').trim() }; }
      return { path: rel, text: null, missing: true };
    });
  }

  const hash = hashOf(files.map((f) => `${f}:${existsSync(resolve(config.repoRoot, f)) ? readFileSync(resolve(config.repoRoot, f), 'utf8') : ''}`).join('\0'));
  return { bundle, hash, errors, warnings, files };
}

// ── refresh: reconcile every harness row with its folder (boot / seed) ───────
// Mirrors the manifest refresh: read the folder, re-validate, store the parsed bundle + hash +
// anchor commit + avatar. Loud on validation errors (a broken harness stays with its LAST good
// bundle rather than a half-parsed one), quiet when unchanged.
export async function refreshHarnesses() {
  const rows = await q(`SELECT id, key, dir, bundle_hash, is_law_core FROM harness WHERE dir IS NOT NULL`);
  for (const h of rows) {
    if (h.is_law_core) continue;   // core's text is code-assembled; nothing to read from a folder
    const { bundle, hash, errors, warnings } = loadHarnessDir(h.dir);
    if (!bundle) { logline('harness', `${h.key}: INVALID (${errors.join('; ')}) — keeping last good bundle`); continue; }
    for (const w of warnings) logline('harness', `${h.key}: ${w}`);
    // The anchor commit is reconciled every refresh even when the bundle content is unchanged — the
    // folder's last-touch commit moves as OTHER commits land, and the timeline anchors the node here.
    const head = dirHeadCommit(config.repoRoot, h.dir);
    if (hash === h.bundle_hash) {
      if (head && head !== h.head_commit) await q(`UPDATE harness SET head_commit=$2 WHERE id=$1`, [h.id, head]);
      continue;   // bundle unchanged
    }
    const avatar = existsSync(resolve(config.repoRoot, h.dir, 'avatar.svg')) ? `${h.dir}/avatar.svg` : null;
    await q(`UPDATE harness SET bundle=$2, bundle_hash=$3, head_commit=$4, avatar_path=COALESCE($5, avatar_path), label=COALESCE($6, label) WHERE id=$1`,
      [h.id, JSON.stringify(bundle), hash, head, avatar, bundle.label || null]);
    logline('harness', `${h.key}: refreshed (${bundle.skills?.length || 0} skill(s), hash ${hash})`);
  }
}

// ── resolution + assembly (used by the briefing) ─────────────────────────────
export async function coreHarness() {
  return one(`SELECT * FROM harness WHERE is_law_core LIMIT 1`);
}

// The harness assigned to a xell (NULL harness_id → none; core is layered separately and always).
export async function harnessForXell(xellId) {
  const x = await one(`SELECT harness_id FROM xell WHERE id=$1`, [xellId]);
  if (!x?.harness_id) return null;
  return one(`SELECT * FROM harness WHERE id=$1 AND enabled`, [x.harness_id]);
}

// The default harness a bare dispatch attaches for a project (pool_config.default_harness_id).
export async function defaultHarnessId(projectId) {
  const r = await one(`SELECT default_harness_id FROM pool_config WHERE project_id=$1`, [projectId]);
  return r?.default_harness_id || null;
}

// Resolve a harness key OR id to its row (for --harness / API assign). NULL/'none' → null (core only).
export async function resolveHarness(keyOrId) {
  if (!keyOrId || keyOrId === 'none' || keyOrId === 'core-only') return null;
  const byId = /^[0-9a-f-]{36}$/i.test(String(keyOrId));
  return one(`SELECT * FROM harness WHERE ${byId ? 'id' : 'key'}=$1`, [keyOrId]);
}

// Assign (or clear) a xell's harness — a human switch. Mutable by design (a harness decides config,
// never a landing target). Returns { harness }.
export async function assignHarness(xellId, keyOrId) {
  const h = await resolveHarness(keyOrId);
  await one(`UPDATE xell SET harness_id=$2 WHERE id=$1 RETURNING id`, [xellId, h?.id || null]);
  logline('harness', `xell ${String(xellId).slice(0, 8)} → harness ${h?.key || '(core only)'}`);
  return { harness: h ? { id: h.id, key: h.key, label: h.label } : null };
}

// List enabled harnesses for the picker/UI (core last — it is implicit/always-on).
export async function listHarnesses() {
  const rows = await q(
    `SELECT id, key, label, is_law_core, enabled, avatar_path, head_commit,
            (bundle->'skills') AS skills, bundle->>'summary' AS summary
       FROM harness WHERE enabled ORDER BY is_law_core, key`);
  return rows.map((h) => ({
    id: h.id, key: h.key, label: h.label, is_law_core: h.is_law_core,
    avatar_path: h.avatar_path, head_commit: h.head_commit, summary: h.summary,
    skill_count: Array.isArray(h.skills) ? h.skills.length : 0,
  }));
}

// Build the HARNESS-LAYER text block for a briefing (personality + skills-as-text + memory). This is
// the provider-neutral prompt-injection path (docs §6.2) — it works for every runtime today. Real
// SKILL.md file-loading (Claude) is layered on top of this by the cxell materializer, not instead of
// it. Returns '' when there is no assigned harness (core alone adds no new TEXT — its content is the
// manual + rules, already in the briefing).
export function harnessLayerText(harness) {
  if (!harness || !harness.bundle) return '';
  const b = typeof harness.bundle === 'string' ? JSON.parse(harness.bundle) : harness.bundle;
  const out = [];
  out.push(`## Your harness: ${harness.label}${b.summary ? ` — ${b.summary}` : ''}`);
  out.push(`You are wearing the **${harness.label}** harness — a shared persona/skill set the queenzee`);
  out.push('assigned to this xell. It ADDS to, and never overrides, the law above (the manual + your');
  out.push('binding rules on how you interact with zeehive/queenzee remain authoritative).');
  if (b.personality) { out.push('', '### Personality / voice', b.personality.trim()); }
  if (Array.isArray(b.skills) && b.skills.length) {
    out.push('', `### Your skills (${b.skills.length}) — use them when they fit`);
    for (const s of b.skills) {
      out.push('', `#### ${s.name}`, `_When:_ ${s.when}`, '', (s.body || '').trim());
    }
  }
  if (Array.isArray(b.memory) && b.memory.length) {
    out.push('', '### Harness memory');
    for (const mem of b.memory) if (mem.text) out.push('', `_(${mem.path})_`, mem.text.trim());
  }
  return out.join('\n').trim();
}

// The SKILL.md files a harness wants materialized into a cxell (Claude path). Provider adapters that
// have no SKILL.md loader skip this and rely on harnessLayerText instead.
export function harnessSkillFiles(harness) {
  if (!harness) return [];
  const b = typeof harness.bundle === 'string' ? JSON.parse(harness.bundle) : (harness.bundle || {});
  return (b.skills || []).filter((s) => s.body).map((s) => ({
    relPath: `.claude/skills/${String(s.name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}/SKILL.md`,
    text: `---\nname: ${s.name}\ndescription: ${String(s.when).replace(/\n/g, ' ')}\n---\n\n${s.body}\n`,
  }));
}

// The EFFECTIVE bridge config for a harness (docs §7) — the HARNESS.yml `bridge:` block (file
// default) with the operator's live DB override (migration 045) layered on top, so a dashboard edit
// wins over the file without a land/ship. Returns null when neither declares a bridge.
export function harnessBridge(harness) {
  if (!harness) return null;
  const b = typeof harness.bundle === 'string' ? JSON.parse(harness.bundle) : (harness.bundle || {});
  const file = b.bridge || null;
  const ov = harness.bridge_override
    ? (typeof harness.bridge_override === 'string' ? JSON.parse(harness.bridge_override) : harness.bridge_override)
    : null;
  if (!file && !ov) return null;
  return { ...(file || {}), ...(ov || {}) };
}

// ── bridge setup surface (dashboard) ─────────────────────────────────────────
// Read the effective bridge config + the last probe result for the setup UI.
export async function getBridge(key) {
  const h = await one(`SELECT * FROM harness WHERE key=$1`, [key]);
  if (!h) throw new Error(`no harness "${key}"`);
  return { key: h.key, label: h.label, config: harnessBridge(h) || {}, probe: h.bridge_probe || null };
}

// Persist an operator edit to the live bridge connection (only known keys; the file block stays the
// default underneath). Does NOT ship — it is live config, applied to the next dispatched zee.
const BRIDGE_KEYS = ['base_url', 'enabled', 'inbound', 'session_key', 'append_path', 'viewer_url_template', 'mode'];
export async function setBridge(key, patch = {}) {
  const h = await one(`SELECT bridge_override FROM harness WHERE key=$1`, [key]);
  if (!h) throw new Error(`no harness "${key}"`);
  const cur = h.bridge_override
    ? (typeof h.bridge_override === 'string' ? JSON.parse(h.bridge_override) : h.bridge_override)
    : {};
  const next = { ...cur };
  for (const k of BRIDGE_KEYS) if (k in patch) next[k] = patch[k];
  await q(`UPDATE harness SET bridge_override=$2 WHERE key=$1`, [key, JSON.stringify(next)]);
  logline('harness', `${key}: bridge config updated (base_url=${next.base_url || '—'}, enabled=${!!next.enabled}, inbound=${!!next.inbound})`);
  return getBridge(key);
}

// TEST CONNECTION — actually probe the configured Hermes instance's discovery endpoint and record
// the result. This is the honest "did Hermes answer?" check (real network round-trip from the
// queenzee), the thing that turns "wired" into "verified against a live instance".
export async function probeBridge(key) {
  const h = await one(`SELECT * FROM harness WHERE key=$1`, [key]);
  if (!h) throw new Error(`no harness "${key}"`);
  const cfg = harnessBridge(h) || {};
  const stamp = (p) => q(`UPDATE harness SET bridge_probe=$2 WHERE key=$1`, [key, JSON.stringify(p)]).then(() => p);
  if (!cfg.base_url) return stamp({ ok: false, at: new Date().toISOString(), detail: 'no base_url configured — set the Hermes instance URL first' });
  const url = `${String(cfg.base_url).replace(/\/$/, '')}/v1/discovery`;
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(6000) });
    const body = await res.text().catch(() => '');
    return stamp({ ok: res.ok, status: res.status, url, at: new Date().toISOString(),
      detail: res.ok ? (body.slice(0, 400) || 'reachable (empty body)') : `HTTP ${res.status} — ${body.slice(0, 200)}` });
  } catch (e) {
    return stamp({ ok: false, url, at: new Date().toISOString(), detail: `unreachable: ${String(e.message).slice(0, 200)}` });
  }
}

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
import { resolve, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { q, one } from '../db/pool.js';
import { config } from '../config.js';
import { logline } from './logbus.js';
import { cleanGitEnv } from './git.js';

export const HARNESS_MANIFEST = 'HARNESS.yml';

// Same switch every other real-side-effect module reads (intake, pool, xell-db, machines, and the
// .zeehive.env reconcile in provision.js): 'real' touches machines, anything else models. The live
// re-injection below obeys it — see reinjectHarnessIntoLiveXells for why that matters.
const PROVISION_MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

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
  'skills', 'memory', 'tools', 'avatar', 'bridge', 'parent', 'glyph',
  // Which ZEE TYPE this harness is for (054). A harness carries the MANUAL for a type's verbs and
  // refusals, so wearing the wrong one briefs an agent for doors it does not have. `zee_type:` in
  // HARNESS.yml (or `type:`) declares it; the pairing is enforced in the DB.
  'zee_type', 'type',
]);

// Every type a XELL can be, and every type a HARNESS can declare. 'any' is the law layer (core),
// which applies to every zee whatever its type.
export const ZEE_TYPES = ['worker', 'manager'];
export const HARNESS_TYPES = ['worker', 'manager', 'any'];
export function normalizeZeeType(v, fallback = 'worker') {
  const t = String(v || '').trim().toLowerCase();
  return HARNESS_TYPES.includes(t) ? t : fallback;
}

// PURE: may a xell of `zeeType` wear a harness declared for `harnessType`? One rule in one place, so
// the DB trigger, the assign path, dispatch and every console picker agree on the same answer.
export function harnessFitsType(harnessType, zeeType) {
  const h = normalizeZeeType(harnessType, 'worker');
  return h === 'any' || h === normalizeZeeType(zeeType, 'worker');
}
export function typeMismatchReason(harness, zeeType) {
  return `harness "${harness.key}" is for ${harness.zee_type} zees, but this xell is a `
    + `${normalizeZeeType(zeeType)} zee. A harness carries the manual for a type's verbs and refusals `
    + "(a manager's teaches dispatch/say/suggest-done; a worker's teaches landing), so the wrong one "
    + "briefs an agent for doors it does not have. Pick a harness of the right type, or change the "
    + "xell's type.";
}

const hashOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

// ── WHERE the harness folders actually live ──────────────────────────────────
// A file-backed harness's `dir` ('harnesses/manager') is relative to the ZEEHIVE PROJECT's REPO —
// the clone the queenzee manages and the DB row projects (self-onboard.js onboards it as the
// `Zeehive` project; its repo_root is /repos/Zeehive in the container era). It is NOT relative to
// config.repoRoot, which is merely where the running server's code sits.
//
// On a checkout those are the same folder, which is why every test passed while the DEPLOYED
// queenzee was broken: Dockerfile.server copies server/ scripts/ db/ hooks/ skill/ into /app and
// deliberately NOT harnesses/ (a second copy in the image would drift from the repo the row claims
// to project — the same reasoning as the single copy of scripts/zee). So config.repoRoot=/app had
// no harnesses/ at all, refreshHarnesses() found nothing, and every file-backed harness — the
// manager's manual included — stayed EMPTY in production.
//
// Resolution: the project repo roots first (self project first), then config.repoRoot as the
// fallback for host-process mode (where the runtime dir IS the repo) and for tests. A root only
// wins if the folder is actually THERE, so a stale/unreachable repo_root falls through instead of
// blanking a harness.
const SELF_PROJECT = 'Zeehive';
const ROOTS_TTL_MS = 30_000;
let rootsCache = { at: 0, roots: [] };

const normRoot = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');

// Re-read the candidate repo roots from the DB (cheap, cached). Never throws: with no DB/schema
// yet (a very early boot, a unit test) we simply fall back to config.repoRoot.
export async function refreshHarnessRoots() {
  try {
    const rows = await q(
      `SELECT repo_root FROM project WHERE repo_root IS NOT NULL
        ORDER BY (lower(name) = lower($1)) DESC, created_at`, [SELF_PROJECT]);
    rootsCache = { at: Date.now(), roots: rows.map((r) => normRoot(r.repo_root)).filter(Boolean) };
  } catch {
    rootsCache = { at: Date.now(), roots: [] };
  }
  return harnessRoots();
}

// Warm the cache only when it has gone stale — for read paths (list, avatar) that must not fire a
// query per call.
export async function ensureHarnessRoots() {
  if (Date.now() - rootsCache.at > ROOTS_TTL_MS) await refreshHarnessRoots();
  return harnessRoots();
}

// Every root a harness folder may live under, best first. config.repoRoot is ALWAYS last, never
// absent — the fallback is what keeps a checkout-run (tests, host process) working unchanged.
export function harnessRoots() {
  return [...new Set([...(rootsCache.roots || []), normRoot(config.repoRoot)])];
}

// The root a given repo-relative path resolves under (the first that actually has it). Falls back
// to config.repoRoot so error messages and hashes stay stable when nothing has it.
export function harnessBase(rel) {
  if (rel) for (const root of harnessRoots()) if (existsSync(resolve(root, rel))) return root;
  return normRoot(config.repoRoot);
}

// The avatar SVG on disk for a harness's avatar_path, or null. Containment-guarded: the file must
// live under <base>/harnesses/, so a crafted avatar_path can never read outside it. Shared by the
// API route so the route and the loader agree on the base (they used to disagree — see above).
export async function harnessAvatarFile(avatarPath) {
  const rel = String(avatarPath || '').trim();
  if (!rel) return null;
  const base = await ensureHarnessRoots().then(() => harnessBase(rel));
  const abs = resolve(base, rel);
  if (!abs.startsWith(resolve(base, 'harnesses') + sep)) return null;
  return existsSync(abs) ? abs : null;
}

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
function readSkill(skillDir, folderName, base) {
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
  return { name, when, body, path: `${skillDir.replace(normRoot(base) + '/', '')}/SKILL.md` };
}

// Assemble a bundle object from a harness folder: HARNESS.yml (validated) + PERSONALITY.md +
// skills/*/SKILL.md + memory/*.md + avatar. Returns { bundle, hash, errors, warnings, files }.
// `base` is the repo root the dir hangs off — the Zeehive project's repo_root in the deployed
// queenzee, config.repoRoot on a checkout. Callers that already resolved it (refreshHarnesses)
// pass it in so every read + the hash below agree on ONE base.
export function loadHarnessDir(dir, base = harnessBase(dir)) {
  const root = normRoot(base);
  const abs = resolve(root, dir);
  if (!existsSync(abs)) {
    return { bundle: null, hash: null, missing: true, base: root, files: [], warnings: [],
      errors: [`harness dir not found: ${dir} (looked under ${harnessRoots().join(', ')})`] };
  }

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

  // skills: an entry may be INLINE ({name, when/description, body}) in the manifest, or a NAME that
  // resolves to a skills/<name>/SKILL.md folder. With no declared list, every folder under skills/.
  const skillsRoot = join(abs, 'skills');
  const skills = [];
  const fromFolder = (n) => {
    if (!existsSync(skillsRoot)) return;
    const s = readSkill(join(skillsRoot, n), n, root);
    if (s) { skills.push(s); files.push(s.path); }
  };
  if (Array.isArray(bundle.skills)) {
    for (const entry of bundle.skills) {
      if (entry && typeof entry === 'object' && (entry.body || entry.when || entry.description)) {
        skills.push({ name: String(entry.name || 'skill'), when: String(entry.when || entry.description || ''), body: String(entry.body || '') });
      } else {
        const n = typeof entry === 'string' ? entry : entry?.name;
        if (n) fromFolder(n);
      }
    }
  } else if (existsSync(skillsRoot) && statSync(skillsRoot).isDirectory()) {
    for (const n of readdirSync(skillsRoot).filter((x) => statSync(join(skillsRoot, x)).isDirectory())) fromFolder(n);
  }
  bundle.skills = skills;

  // memory files → inline text. A path resolves against the harness folder first, then the REPO ROOT
  // (containment-guarded) — so a file-backed harness can incorporate a repo doc live, no copy, no
  // drift. (Zee Base used to do exactly that with a repo copy of the cxell-zee manual; migration 047
  // moved that manual INTO the meta DB and made Zee Base DB-owned, so it no longer comes through
  // here — but the mechanism stands for any other harness that wants a live repo doc.)
  if (Array.isArray(bundle.memory)) {
    bundle.memory = bundle.memory.map((rel) => {
      const local = join(abs, rel);
      const rooted = resolve(root, rel);
      let p = null;
      if (existsSync(local)) p = local;
      else if (rooted.startsWith(root) && existsSync(rooted)) p = rooted;
      if (p) { files.push(p.replace(root + '/', '')); return { path: rel, text: readFileSync(p, 'utf8').trim() }; }
      return { path: rel, text: null, missing: true };
    });
  }

  // The hash re-reads every collected file — against the SAME base the bundle was read from. It
  // used to re-resolve against config.repoRoot, so in the container it hashed a list of empty
  // strings: two different harnesses would have hashed identical.
  const hash = hashOf(files.map((f) => `${f}:${existsSync(resolve(root, f)) ? readFileSync(resolve(root, f), 'utf8') : ''}`).join('\0'));
  return { bundle, hash, base: root, errors, warnings, files };
}

// ── refresh: reconcile every harness row with its folder (boot / seed) ───────
// Mirrors the manifest refresh: read the folder, re-validate, store the parsed bundle + hash +
// anchor commit + avatar. Loud on validation errors (a broken harness stays with its LAST good
// bundle rather than a half-parsed one), quiet when unchanged.
//
// An UNREADABLE folder keeps the last good bundle too — but it is no longer silent. That silence
// is exactly how the deployed queenzee shipped manager zees with no manual for weeks: the refresh
// logged nothing a human would read, and /api/harnesses reported a harness that looked fine and
// carried nothing. Now it screams (stdout + the queenzee log), and the read models carry
// files_missing / bundle_empty so the console can show it.
export async function refreshHarnesses({ mode = PROVISION_MODE } = {}) {
  await refreshHarnessRoots();      // the Zeehive project's repo_root is where the folders live
  const rows = await q(`SELECT id, key, dir, bundle_hash, is_law_core, zee_type FROM harness WHERE dir IS NOT NULL`);
  const changed = [];               // harnesses whose bundle actually moved — see the loop's tail
  for (const h of rows) {
    if (h.is_law_core) continue;   // core's text is code-assembled; nothing to read from a folder
    const base = harnessBase(h.dir);
    const { bundle, hash, missing, errors, warnings } = loadHarnessDir(h.dir, base);
    if (missing) { await reportMissingHarness(h); continue; }
    if (!bundle) { logline('harness', `${h.key}: INVALID (${errors.join('; ')}) — keeping last good bundle`); continue; }
    for (const w of warnings) logline('harness', `${h.key}: ${w}`);
    // The anchor commit is reconciled every refresh even when the bundle content is unchanged — the
    // folder's last-touch commit moves as OTHER commits land, and the timeline anchors the node here.
    const head = dirHeadCommit(base, h.dir);
    if (hash === h.bundle_hash) {
      if (head && head !== h.head_commit) await q(`UPDATE harness SET head_commit=$2 WHERE id=$1`, [h.id, head]);
      continue;   // bundle unchanged
    }
    const avatar = existsSync(resolve(base, h.dir, 'avatar.svg')) ? `${h.dir}/avatar.svg` : null;
    // resolve a declared `parent:` key → parent_id (the trigger blocks cycles). Missing parent → null.
    let parentId = null;
    if (bundle.parent) {
      const p = await one(`SELECT id FROM harness WHERE key=$1`, [bundle.parent]);
      if (p) parentId = p.id; else logline('harness', `${h.key}: parent "${bundle.parent}" not found — ignored`);
    }
    // The folder's declared type is authoritative for a file-backed harness, exactly like its skills
    // and memory. The DB trigger still refuses a retype that would strand a xell already wearing it,
    // so a bad edit fails loudly instead of silently re-pointing a live manager at a worker manual.
    const declared = normalizeZeeType(bundle.zee_type ?? bundle.type, h.zee_type || 'worker');
    await q(`UPDATE harness SET bundle=$2, bundle_hash=$3, head_commit=$4, avatar_path=COALESCE($5, avatar_path), label=COALESCE($6, label), parent_id=$7, zee_type=$8 WHERE id=$1`,
      [h.id, JSON.stringify(bundle), hash, head, avatar, bundle.label || null, parentId, declared]);
    logline('harness', `${h.key}: refreshed (${bundle.skills?.length || 0} skill(s), ${bundle.parent ? `parent ${bundle.parent}, ` : ''}hash ${hash})`);
    // The bundle really CHANGED, so every zee ALREADY RUNNING in a xell that wears it is now holding
    // stale files. Push the repaired persona into them (below) — "new zees only" is precisely what
    // left the running fleet briefed on nothing while a fix sat in the DB.
    changed.push(h.id);
  }
  for (const id of changed) await reinjectHarnessIntoLiveXells(id, { mode });
  await logHarnessSummary();
}

// Re-inject a harness's files into every LIVE xell whose effective persona just changed — the xells
// wearing it, AND the xells wearing a harness that INHERITS it (a child's effective bundle is the
// merged chain, so a parent's repair changes the child's files too).
//
// Called ONLY from the changed-bundle branch above: a refresh that no-ops must write nothing into a
// running zee's worktree. And every write is logged, because a file appearing under a live zee is
// otherwise indistinguishable from the zee having written it — which is how a "did I do that?"
// half-hour gets spent.
//
// AND IT OBEYS PROVISION_MODE, exactly as the .zeehive.env reconcile does (provision.js). The
// injection is a `docker exec` into `cxell_<slug>`, and the slug comes STRAIGHT OUT OF A FLEET ROW.
// A xell's database is a CLONE of the meta-DB, so the rows a NESTED queenzee walks (every zee that
// boots the server inside its own xell — PROVISION_MODE=simulate by manifest default) are the REAL
// fleet's rows, real container names and all. Unguarded, the first zee to edit a harness folder and
// boot the server would have written its own harness files into every OTHER zee's live cxell, over
// the top of the personas they are actually running on. In simulate this REPORTS the xells it would
// have injected and execs nothing; in real mode nothing about it changes.
export async function reinjectHarnessIntoLiveXells(harnessId, { mode = PROVISION_MODE } = {}) {
  const dryRun = mode !== 'real';
  const ids = await harnessAndDescendants(harnessId);
  // A xell counts as LIVE if it holds a cxell zee that is still running; reinjectHarnessIntoXell
  // itself re-checks and answers 'no live cxell zee' otherwise, so this query is only a narrowing.
  const xells = await q(
    `SELECT x.id, x.slug, h.key FROM xell x JOIN harness h ON h.id = x.harness_id
      WHERE x.harness_id = ANY($1::uuid[]) AND x.status NOT IN ('retired','tearing-down','husk')`,
    [ids]);
  if (!xells.length) return { xells: 0, injected: 0 };
  // REPORT-ONLY, never a silent skip: name every xell this queenzee would have reached into, and say
  // why it did not. A simulate run that logged nothing would read exactly like a fleet with nothing
  // to inject.
  if (dryRun) {
    logline('harness', `harness change NOT injected into ${xells.length} live xell(s) — PROVISION_MODE=`
      + 'simulate: this queenzee models the fleet, it does not exec into its cxells. Would have '
      + `re-injected: ${xells.map((x) => `${x.slug} ("${x.key}")`).join(', ')}`);
    return { xells: xells.length, injected: 0, failed: 0, skipped: 0,
             would_inject: xells.length, dry_run: true };
  }
  // Lazily imported: intake.js imports THIS module, so a static import would close a cycle.
  const { reinjectHarnessIntoXell } = await import('../queenzee/intake.js');
  let injected = 0, failed = 0;
  const skipped = [];
  for (const x of xells) {
    const r = await reinjectHarnessIntoXell(x.id).catch((e) => ({ injected: false, error: e.message }));
    if (r?.injected && r.files) {
      injected++;
      logline('harness', `${x.slug}: harness "${x.key}" changed — re-injected ${r.files} file(s) into the LIVE zee`);
    } else if (r?.injected) {
      // nothing to write (a core-only xell): true, and worth one quiet line rather than a claim
      logline('harness', `${x.slug}: harness "${x.key}" changed — no files to inject`);
    } else if (r?.failed) {
      failed++;
      // the zee IS live and we could not reach it: loud, because this one leaves a running zee
      // holding a stale persona and nothing else will notice
      logline('harness', `${x.slug}: harness "${x.key}" changed but injection FAILED (${r.failed}/${r.wanted} file(s) unwritten) — that zee is still on its OLD persona`);
      console.error(`[harness] ${x.slug}: harness "${x.key}" changed but re-injection FAILED — the live zee keeps its old persona`);
    } else {
      // NOT a failure in the common case: a xell with no running zee gets the new files at its next
      // dispatch anyway. Collected into one line rather than one per xell, so a fleet of idle xells
      // cannot bury the injections that DID happen.
      skipped.push(`${x.slug} (${r?.reason || r?.error || 'unknown'})`);
    }
  }
  if (skipped.length) logline('harness', `harness change not injected into ${skipped.length} xell(s) — they pick it up on their next dispatch: ${skipped.join(', ')}`);
  return { xells: xells.length, injected, failed, skipped: skipped.length };
}

// A harness and every harness that inherits from it, transitively (the parent_id trigger blocks
// cycles, and the hop cap is belt-and-braces for a DB edited by hand).
async function harnessAndDescendants(rootId) {
  const ids = [rootId];
  let frontier = [rootId], hops = 0;
  while (frontier.length && hops++ < 32) {
    const kids = await q(`SELECT id FROM harness WHERE parent_id = ANY($1::uuid[])`, [frontier]);
    frontier = kids.map((k) => k.id).filter((id) => !ids.includes(id));
    ids.push(...frontier);
  }
  return ids;
}

// ONE line at the end of every refresh: how many file-backed harnesses carry something, how many
// carry NOTHING, which ones, and how many live xells are wearing an empty one.
//
// The per-harness loglines above are each true and each easy to miss — a queenzee can boot looking
// perfectly healthy with every file-backed harness empty, which is exactly how manager zees walked
// around blind for weeks. A boot is not "clean" if a zee's persona is a blank page, so this line is
// always emitted, and goes to stdout (the docker log a human actually reads) the moment it isn't 0.
export async function logHarnessSummary() {
  await ensureHarnessRoots();
  const rows = await q(
    `SELECT h.key, h.dir, h.is_law_core,
            h.bundle->>'personality' AS personality, (h.bundle->'skills') AS skills, (h.bundle->'memory') AS memory,
            (SELECT count(*)::int FROM xell x
               WHERE x.harness_id = h.id AND x.status NOT IN ('retired','tearing-down','husk')) AS worn
       FROM harness h WHERE h.dir IS NOT NULL AND NOT h.is_law_core AND h.enabled ORDER BY h.key`);
  const empty = [], loaded = [];
  let wornEmpty = 0;
  for (const h of rows) {
    const health = harnessHealth(h);
    if (health.bundle_empty || health.files_missing) {
      empty.push(`${h.key}${health.files_missing ? ' (no files)' : ''}${h.worn ? ` ×${h.worn}` : ''}`);
      wornEmpty += Number(h.worn || 0);
    } else loaded.push(h.key);
  }
  const line = `harnesses: ${loaded.length} loaded, ${empty.length} EMPTY`
    + (empty.length ? ` — ${empty.join(', ')}` : '')
    + (wornEmpty ? ` · ${wornEmpty} live xell(s) are wearing an EMPTY harness — those zees get no persona, no skills, no manual` : '');
  logline('harness', line);
  if (empty.length) console.error(`[harness] ${line}`);
  return { loaded: loaded.length, empty: empty.length, worn_empty: wornEmpty, empty_keys: empty, line };
}

// A file-backed harness whose folder cannot be read. Keep the last good bundle (never blank a live
// harness on a bad mount), but say so LOUDLY and name the cost: how many zees are wearing a harness
// that carries nothing, and where we looked.
async function reportMissingHarness(h) {
  let worn = 0;
  try {
    worn = Number((await one(
      `SELECT count(*)::int AS n FROM xell WHERE harness_id=$1
         AND status NOT IN ('retired','tearing-down','husk')`, [h.id]))?.n || 0);
  } catch { /* count is colour, not the message */ }
  const msg = `${h.key}: FOLDER MISSING — "${h.dir}" is not under any known repo root `
    + `(${harnessRoots().join(' , ')}). Keeping the last stored bundle`
    + `${worn ? `, but ${worn} live xell(s) wear this harness and get whatever that bundle holds` : ''}`
    + '. A file-backed harness lives in the ZEEHIVE PROJECT repo (project.repo_root), not in the '
    + 'server image — check that the project is onboarded and its repo_root is mounted/readable.';
  logline('harness', msg);
  console.error(`[harness] ${msg}`);
}

// NOTE: the cxell manual now lives INSIDE the meta DB — seeded directly into Zee Base's
// harness.bundle.memory by migration 047, and Zee Base is DB-owned (dir=NULL) so refreshHarnesses
// never touches it. There is no boot-time file ingest (that depended on a repo file and was fragile);
// the manual is editable in the manager and injected into a xell only via harness assignment.

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
export async function defaultHarnessId(projectId, { zeeType = 'worker' } = {}) {
  const r = await one(`SELECT default_harness_id FROM pool_config WHERE project_id=$1`, [projectId]);
  if (!r?.default_harness_id) return null;
  // The project default is a WORKER default by construction — it is what a bare dispatch attaches.
  // Never hand it to a manager: that would strip the manual its verbs come from, and the assign
  // would be refused anyway. A manager with no explicit harness gets the manager one instead.
  const h = await one(`SELECT zee_type FROM harness WHERE id=$1`, [r.default_harness_id]);
  return harnessFitsType(h?.zee_type, zeeType) ? r.default_harness_id : null;
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
  // TYPE FIRST (054): a harness is only assignable to a xell of its own type. The DB trigger is the
  // real wall; this check exists so the caller gets a sentence explaining WHY, rather than a raw
  // postgres exception the console would have to render as gibberish.
  if (h) {
    const x = await one(`SELECT zee_type FROM xell WHERE id=$1`, [xellId]);
    if (!harnessFitsType(h.zee_type, x?.zee_type)) throw new Error(typeMismatchReason(h, x?.zee_type));
  }
  await one(`UPDATE xell SET harness_id=$2 WHERE id=$1 RETURNING id`, [xellId, h?.id || null]);
  logline('harness', `xell ${String(xellId).slice(0, 8)} → harness ${h?.key || '(core only)'}`);
  return { harness: h ? { id: h.id, key: h.key, label: h.label } : null };
}

// List enabled harnesses for the picker/UI (core last — it is implicit/always-on).
export async function listHarnesses({ zeeType = null } = {}) {
  const rows = await q(
    `SELECT h.id, h.key, h.label, h.is_law_core, h.enabled, h.avatar_path, h.head_commit, h.dir, h.zee_type,
            (h.bundle->'skills') AS skills, (h.bundle->'memory') AS memory,
            h.bundle->>'summary' AS summary, h.bundle->>'glyph' AS glyph,
            h.bundle->>'personality' AS personality,
            p.key AS parent
       FROM harness h LEFT JOIN harness p ON p.id = h.parent_id
      WHERE h.enabled ORDER BY h.is_law_core, h.key`);
  await ensureHarnessRoots();
  // `zeeType` narrows the list to what a xell of that type may actually WEAR — what every picker
  // must offer, so an operator is never shown a choice the assign path would then refuse.
  return rows.filter((h) => !zeeType || harnessFitsType(h.zee_type, zeeType)).map((h) => ({
    id: h.id, key: h.key, label: h.label, is_law_core: h.is_law_core, parent: h.parent,
    zee_type: h.zee_type,
    avatar_path: h.avatar_path, head_commit: h.head_commit, summary: h.summary, glyph: h.glyph,
    file_backed: !!h.dir,
    skill_count: Array.isArray(h.skills) ? h.skills.length : 0,
    // HONESTY about what this harness actually carries. A file-backed harness whose folder is not
    // readable from here, and a harness that would brief a zee with nothing, are both invisible
    // problems otherwise — the row looks perfectly healthy while the zee wearing it gets an empty
    // persona (the deployed-queenzee bug). Computed at read time, so it is never a stale flag.
    ...harnessHealth(h),
  }));
}

// files_missing: a file-backed harness whose folder is not under any known repo root.
// bundle_empty: it would brief a zee with NOTHING — no personality, no skills, no memory.
// core is excluded from both: its text is code-assembled, so an empty bundle there is correct.
export function harnessHealth(h) {
  if (h.is_law_core) return { files_missing: false, bundle_empty: false };
  const skills = Array.isArray(h.skills) ? h.skills : [];
  const memory = Array.isArray(h.memory) ? h.memory : [];
  return {
    files_missing: !!h.dir && !existsSync(resolve(harnessBase(h.dir), h.dir)),
    bundle_empty: !String(h.personality || '').trim() && !skills.length
      && !memory.some((m) => m && String(m.text || '').trim()),
  };
}

// ── harness authoring (DB-owned personas — unlimited, created from the dashboard) ────────────────
// A harness is a PERSONA an AI assumes as a zee: personality + skills + memory. The `core` law
// harness is off-limits. File-backed harnesses (a `dir`) are repo-managed; EDITING one detaches it
// to DB ownership (dir → NULL) so refreshHarnesses can no longer clobber the operator's edits.
const slugKey = (s) => String(s || '').toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'harness';

function normalizeSkills(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((s) => ({ name: String(s?.name || '').slice(0, 60), when: String(s?.when || '').slice(0, 400), body: String(s?.body || '') }))
    .filter((s) => s.name);
}
function normalizeMemory(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((m) => ({ path: String(m?.path || m?.name || 'note').slice(0, 80), text: String(m?.text || '') }))
    .filter((m) => m.text);
}

export async function createHarness({ key, label, glyph, zee_type } = {}) {
  const k = slugKey(key || label);
  if (k === 'core') throw new Error('"core" is reserved for the law harness');
  if (await one(`SELECT id FROM harness WHERE key=$1`, [k])) throw new Error(`a harness "${k}" already exists`);
  // Which TYPE of zee this persona is for. Worker is the default — the overwhelming majority, and
  // the safe one: a manager harness handed to a worker teaches verbs the worker does not have.
  const type = normalizeZeeType(zee_type, 'worker');
  const bundle = { label: label || k, zee_type: type, ...(glyph ? { glyph: String(glyph).slice(0, 4) } : {}) };
  await one(`INSERT INTO harness (key,label,bundle,enabled,is_law_core,zee_type) VALUES ($1,$2,$3,true,false,$4) RETURNING id`,
    [k, label || k, JSON.stringify(bundle), type]);
  logline('harness', `created ${type} harness "${k}"`);
  return getHarnessFull(k);
}

export async function updateHarness(key, patch = {}) {
  const h = await one(`SELECT * FROM harness WHERE key=$1`, [key]);
  if (!h) throw new Error(`no harness "${key}"`);
  if (h.is_law_core) throw new Error('the core (law) harness is not editable');
  const bundle = (typeof h.bundle === 'string' ? JSON.parse(h.bundle) : h.bundle) || {};
  if ('personality' in patch) bundle.personality = String(patch.personality || '');
  if ('summary' in patch) bundle.summary = String(patch.summary || '').slice(0, 200);
  if ('glyph' in patch) bundle.glyph = String(patch.glyph || '').slice(0, 4);
  if ('skills' in patch) bundle.skills = normalizeSkills(patch.skills);
  if ('memory' in patch) bundle.memory = normalizeMemory(patch.memory);
  const label = 'label' in patch ? (String(patch.label || '').trim() || h.label) : h.label;
  const enabled = 'enabled' in patch ? !!patch.enabled : h.enabled;
  // Retyping is allowed only while no xell of the other type is wearing it — the DB trigger decides
  // and its message names the xells that block it, so an operator is told what to move first.
  const type = 'zee_type' in patch ? normalizeZeeType(patch.zee_type, h.zee_type) : h.zee_type;
  if (type !== h.zee_type) {
    bundle.zee_type = type;
    await q(`UPDATE harness SET zee_type=$2 WHERE key=$1`, [key, type]);
  }
  // parent: resolve a key → parent_id ('' / null clears). The trigger blocks cycles/self-parent.
  if ('parent' in patch) {
    let pid = null;
    if (patch.parent) {
      if (patch.parent === key) throw new Error('a harness cannot inherit itself');
      const p = await one(`SELECT id FROM harness WHERE key=$1`, [patch.parent]);
      if (!p) throw new Error(`no parent harness "${patch.parent}"`);
      pid = p.id;
    }
    await q(`UPDATE harness SET parent_id=$2 WHERE key=$1`, [key, pid]);
  }
  // detach from any file backing so refreshHarnesses can't overwrite this edit
  await q(`UPDATE harness SET bundle=$2, label=$3, enabled=$4, bundle_hash=$5, dir=NULL WHERE key=$1`,
    [key, JSON.stringify(bundle), label, enabled, hashOf(JSON.stringify(bundle))]);
  logline('harness', `updated harness "${key}" (${(bundle.skills || []).length} skill(s), ${(bundle.memory || []).length} memory)`);
  return getHarnessFull(key);
}

export async function deleteHarness(key) {
  const h = await one(`SELECT is_law_core FROM harness WHERE key=$1`, [key]);
  if (!h) return { deleted: false };
  if (h.is_law_core) throw new Error('the core (law) harness cannot be deleted');
  await q(`DELETE FROM harness WHERE key=$1`, [key]);   // xell.harness_id is ON DELETE SET NULL
  logline('harness', `deleted harness "${key}"`);
  return { deleted: true };
}

// The full editable persona for the authoring UI.
export async function getHarnessFull(key) {
  const h = await one(`SELECT * FROM harness WHERE key=$1`, [key]);
  if (!h) throw new Error(`no harness "${key}"`);
  const b = typeof h.bundle === 'string' ? JSON.parse(h.bundle) : (h.bundle || {});
  const parent = h.parent_id ? (await one(`SELECT key FROM harness WHERE id=$1`, [h.parent_id]))?.key || null : null;
  // inherited = the merged parent chain (so the editor can SHOW what this harness gets from its
  // parents — e.g. the cxell manual carried by Zee Base — even though it is not this row's OWN memory)
  let inherited = { skills: [], memory: [], chain: [] };
  if (h.parent_id) {
    const eff = await effectiveHarness(await one(`SELECT * FROM harness WHERE id=$1`, [h.parent_id]));
    if (eff) inherited = { skills: eff.skills, memory: eff.memory, chain: eff.chain };
  }
  await ensureHarnessRoots();
  return {
    key: h.key, label: h.label, enabled: h.enabled, is_law_core: h.is_law_core, file_backed: !!h.dir,
    parent, zee_type: h.zee_type, glyph: b.glyph || null, summary: b.summary || '', personality: b.personality || '',
    skills: Array.isArray(b.skills) ? b.skills : [], memory: Array.isArray(b.memory) ? b.memory : [],
    inherited,
    // same honesty as the list: is the folder readable from here, and does this bundle carry anything?
    ...harnessHealth({ ...h, ...b }),
  };
}

// The FILES an effective harness materializes into a xell (docs §6) — its persona, skills, and
// memory (incl. the cxell manual carried by Zee Base). Injected into the cxell at dispatch AND when a
// harness is (re)assigned to a live zee, so the persona is real files in the workspace, not just
// prompt text. Skills also load as Claude SKILL.md; persona + memory land under .zeehive/harness/.
const fileSafe = (s) => String(s || 'note').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'note';
export function harnessFiles(eff) {
  if (!eff) return [];
  const files = [];
  if (eff.personality && eff.personality.trim()) {
    files.push({ relPath: '.zeehive/harness/PERSONA.md', text: `# ${eff.label} — persona\n\n${eff.personality.trim()}\n` });
  }
  for (const s of eff.skills || []) {
    if (!s.body) continue;
    files.push({ relPath: `.claude/skills/${fileSafe(s.name)}/SKILL.md`, text: `---\nname: ${s.name}\ndescription: ${String(s.when).replace(/\n/g, ' ')}\n---\n\n${s.body}\n` });
  }
  for (const m of eff.memory || []) {
    if (!m.text) continue;
    const base = fileSafe(String(m.path).split('/').pop() || 'memory').replace(/\.md$/, '') + '.md';
    files.push({ relPath: `.zeehive/harness/memory/${base}`, text: m.text });
  }
  return files;
}

// Resolve a harness's INHERITANCE CHAIN (root → … → leaf) by walking parent_id, and MERGE it into one
// effective persona: personality concatenated with attribution, skills + memory unioned, glyph/summary
// from the nearest that sets them (leaf wins). The core law layer is applied separately, always on top.
export async function effectiveHarness(leafRow) {
  if (!leafRow) return null;
  const chain = [];
  let cur = leafRow, hops = 0;
  while (cur && hops++ < 32) {
    chain.unshift(cur);                                   // root first
    if (!cur.parent_id) break;
    cur = await one(`SELECT * FROM harness WHERE id=$1 AND enabled`, [cur.parent_id]);
  }
  const merged = { label: leafRow.label, glyph: null, summary: null, personality: '', skills: [], memory: [], chain: chain.map((c) => c.label) };
  const bundleOf = (r) => (typeof r.bundle === 'string' ? JSON.parse(r.bundle) : (r.bundle || {}));
  for (const row of chain) {
    const b = bundleOf(row);
    if (b.glyph) merged.glyph = b.glyph;
    if (b.summary) merged.summary = b.summary;
    if (b.personality && b.personality.trim()) {
      merged.personality += (merged.personality ? '\n\n' : '')
        + (chain.length > 1 ? `— from ${row.label}:\n` : '') + b.personality.trim();
    }
    if (Array.isArray(b.skills)) merged.skills.push(...b.skills.filter((s) => s && s.name));
    if (Array.isArray(b.memory)) merged.memory.push(...b.memory.filter((m) => m && m.text));
  }
  return merged;
}

// Build the HARNESS-LAYER text block for a briefing from an EFFECTIVE (merged) harness — personality
// + skills-as-text + memory. Provider-neutral prompt-injection (docs §6.2); SKILL.md files (Claude)
// layer on top via the cxell materializer. Returns '' when there is no assigned harness (the core law
// layer adds no new TEXT here — the manual + rules are already in the briefing).
export function harnessLayerText(eff) {
  if (!eff) return '';
  const out = [];
  const inherits = (eff.chain || []).filter((l) => l !== eff.label);
  out.push(`## Your harness: ${eff.label}${eff.summary ? ` — ${eff.summary}` : ''}`);
  out.push(`You are wearing the **${eff.label}** harness — the persona/skill set the queenzee assigned`);
  out.push(`to this xell${inherits.length ? ` (inheriting: ${inherits.join(' → ')})` : ''}. It ADDS to, and never`);
  out.push('overrides, the law above (the manual + your binding rules on interacting with zeehive/queenzee).');
  if (eff.personality) { out.push('', '### Personality / voice', eff.personality.trim()); }
  if (eff.skills.length) {
    out.push('', `### Your skills (${eff.skills.length}) — use them when they fit`);
    for (const s of eff.skills) out.push('', `#### ${s.name}`, `_When:_ ${s.when}`, '', (s.body || '').trim());
  }
  if (eff.memory.length) {
    out.push('', '### Harness memory');
    for (const mem of eff.memory) if (mem.text) out.push('', `_(${mem.path})_`, mem.text.trim());
  }
  return out.join('\n').trim();
}

// The SKILL.md files an effective harness wants materialized into a cxell (Claude path). Adapters
// with no SKILL.md loader skip this and rely on harnessLayerText instead.
export function harnessSkillFiles(eff) {
  if (!eff) return [];
  return (eff.skills || []).filter((s) => s.body).map((s) => ({
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
const BRIDGE_KEYS = ['base_url', 'enabled', 'inbound', 'session_key', 'append_path', 'viewer_url_template', 'mode', 'auth_token'];
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
  const url = `${String(cfg.base_url).replace(/\/$/, '')}/v1/models`;
  const headers = cfg.auth_token ? { authorization: `Bearer ${cfg.auth_token}` } : {};
  try {
    // redirect:'manual' is load-bearing — Node's fetch FOLLOWS redirects by default, so a
    // login-gated instance would follow the 302 into its login PAGE and return 200, falsely reading
    // as "reachable". We must SEE the 3xx to report "auth required / wrong port" honestly.
    const res = await fetch(url, { method: 'GET', redirect: 'manual', headers, signal: AbortSignal.timeout(6000) });
    const loc = res.headers.get('location') || '';
    if (res.status >= 300 && res.status < 400) {
      const toLogin = /login/i.test(loc);
      return stamp({ ok: false, status: res.status, url, at: new Date().toISOString(),
        detail: toLogin
          ? `redirected to login (${loc}) — this port wants a web login, so it is the Hermes WEB UI, not the API server. Point base_url at the API server's API_SERVER_PORT (Bearer auth), not the UI port.`
          : `redirect to ${loc}` });
    }
    if (res.status === 401 || res.status === 403) {
      return stamp({ ok: false, status: res.status, url, at: new Date().toISOString(),
        detail: cfg.auth_token ? 'auth rejected — the API key was not accepted (check API_SERVER_KEY matches)' : 'auth required — set the API key (API_SERVER_KEY) in the auth token field' });
    }
    const body = await res.text().catch(() => '');
    return stamp({ ok: res.ok, status: res.status, url, at: new Date().toISOString(),
      detail: res.ok ? `authenticated ✓ (${body.slice(0, 200) || 'ok'})` : `HTTP ${res.status} — ${body.slice(0, 160)}` });
  } catch (e) {
    return stamp({ ok: false, url, at: new Date().toISOString(), detail: `unreachable: ${String(e.message).slice(0, 200)}` });
  }
}

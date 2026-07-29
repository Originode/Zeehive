// HARNESSES — shared, system-wide config layers assigned to xells (docs/harness-proposal.md).
//
// A harness carries a config BUNDLE (personality, skills, memory) and **the meta-DB owns it**. The
// row IS the harness: nothing on any filesystem is a source of its text. It is authored in the
// console's harness manager or by migration (harness_memory_put — house rule 9), and the queenzee
// GENERATES the files it injects into a xell from the row when a zee is assigned (harnessFiles).
//
// It was not always so, and the split is what taught the rule (migration 080). `core`/`zee-base`
// were DB-owned while every other harness was FILE-BACKED — its bundle a projection that a boot
// refresh overwrote from harnesses/<key>/. The deployed server image deliberately carries no
// harnesses/, so in production every file-backed harness was EMPTY for weeks and manager zees were
// briefed with nothing; and a migration patching a projected bundle left row and folder disagreeing
// behind a hash that claimed they agreed. Two sources, one of them silently winning, is the bug.
//
// Nothing about a harness is on disk — not even the badge: an avatar is an SVG, and an SVG is text
// (migration 082, harnessAvatarSvg). A harness is complete wherever the meta-DB is reachable.
//
// LAW: the `core` harness is the built-in, undeletable law layer (the cxell-zee manual + the binding
// rules), assembled in bindingFor()/spawnCxell(). Every xell always gets core; an assigned harness
// (e.g. hermes) layers BELOW it and may ADD, never OVERRIDE, the queenzee-interaction rules. That
// non-override is structural: a bundle is only ever written through the authoring functions below,
// which accept personality/summary/glyph/skills/memory and NOTHING else — so a harness has nowhere
// to express a land/ship/prod/gate rule. A harness never ships or lands; it is only a guide.
import { createHash } from 'node:crypto';
import { q, one, pool } from '../db/pool.js';
import { logline } from './logbus.js';

// Same switch every other real-side-effect module reads (intake, pool, xell-db, machines, and the
// .zeehive.env reconcile in provision.js): 'real' touches machines, anything else models. The live
// re-injection below obeys it — see reinjectHarnessIntoLiveXells for why that matters.
const PROVISION_MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

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

// SCOPE (084) — the same shape as the type rule, for the other axis. A harness with no project_id is
// SYSTEM-WIDE (the default, and what every harness seeded before 084 is); one with a project_id is
// visible to that project only. A xell may wear a global harness or its OWN project's, and nothing
// else. The DB trigger is the wall; this is the one predicate every list, picker and assign path
// shares so none of them can offer a choice the wall would then refuse.
export function harnessFitsProject(harnessProjectId, projectId) {
  return !harnessProjectId || String(harnessProjectId) === String(projectId || '');
}
export function scopeMismatchReason(harness, projectName = null) {
  return `harness "${harness.key}" belongs to ${projectName ? `project "${projectName}"` : 'another project'} `
    + 'and this xell does not. A project-scoped persona is visible to its own project only (that is what '
    + 'scoping one means) — pick a system-wide harness, or one of this project\'s own.';
}
export function typeMismatchReason(harness, zeeType) {
  return `harness "${harness.key}" is for ${harness.zee_type} zees, but this xell is a `
    + `${normalizeZeeType(zeeType)} zee. A harness carries the manual for a type's verbs and refusals `
    + "(a manager's teaches dispatch/say/suggest-done; a worker's teaches landing), so the wrong one "
    + "briefs an agent for doors it does not have. Pick a harness of the right type, or change the "
    + "xell's type.";
}

const hashOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

// THE AVATAR IS IN THE ROW TOO (migration 082) — so this module reads no filesystem at all.
//
// A harness's badge SVG used to be `harnesses/<key>/avatar.svg`, resolved against the ZEEHIVE
// PROJECT's repo because the server image deliberately carries no harnesses/. That kept a whole
// repo-root resolution machinery alive for one asset, and it 404'd on any queenzee that could not read
// that repo. An SVG is text, so it lives in `bundle.avatar_svg` and the route serves it from there.
//
// What that buys, beyond the badge: a harness is now COMPLETE on any machine that can reach the
// meta-DB. Nothing about it can be "missing files", on any project, in any container.
export function harnessAvatarSvg(bundle) {
  const b = typeof bundle === 'string' ? JSON.parse(bundle) : (bundle || {});
  const svg = String(b.avatar_svg || '').trim();
  // A stored badge must be an SVG document and nothing else: this is served to a browser, and the row
  // is operator-editable, so the check belongs here rather than in the one route that reads it.
  return /^<svg[\s>]/i.test(svg) ? svg : null;
}

// Re-inject a harness's files into every LIVE xell whose effective persona just changed — the xells
// wearing it, AND the xells wearing a harness that INHERITS it (a child's effective bundle is the
// merged chain, so a parent's repair changes the child's files too).
//
// Called when a harness's bundle actually CHANGES (the console's harness manager saving an edit, a
// migration amending a manual): "new zees only" is precisely what left a running fleet briefed on
// stale text while the repair sat in the DB. Every write is logged, because a file appearing under a
// live zee is otherwise indistinguishable from the zee having written it — which is how a "did I do
// that?" half-hour gets spent.
//
// AND IT OBEYS PROVISION_MODE, exactly as the .zeehive.env reconcile does (provision.js). The
// injection is a `docker exec` into `cxell_<slug>`, and the slug comes STRAIGHT OUT OF A FLEET ROW.
// A xell's database is a CLONE of the meta-DB, so the rows a NESTED queenzee walks (every zee that
// boots the server inside its own xell — PROVISION_MODE=simulate by manifest default) are the REAL
// fleet's rows, real container names and all. Unguarded, the first zee to edit a harness and boot
// the server would have written its own harness files into every OTHER zee's live cxell, over the
// top of the personas they are actually running on. In simulate this REPORTS the xells it would
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
//
// EXPORTED because "and its descendants" is the correct reach for every question of the form "who
// would this change reach?" — the live re-injection above, and the wearer guards on delete/disable.
// A guard that asked only about the harness ITSELF was one level deep: deleting a PARENT collapsed a
// live wearer's chain just as thoroughly, and returned ok.
export async function harnessAndDescendants(rootId, { run = q } = {}) {
  const ids = [rootId];
  let frontier = [rootId], hops = 0;
  while (frontier.length && hops++ < 32) {
    const kids = await run(`SELECT id FROM harness WHERE parent_id = ANY($1::uuid[])`, [frontier]);
    frontier = kids.map((k) => k.id).filter((id) => !ids.includes(id));
    ids.push(...frontier);
  }
  return ids;
}

// The LIVE xells wearing a harness or anything that inherits it, and which of the two they wear. The
// one predicate behind "you cannot delete this" and "you cannot disable this": both end in the same
// place — a running zee whose next briefing has lost the chain — so they must ask the same question.
export async function liveHarnessWearers(harnessId, { run = q, scope = null } = {}) {
  const ids = scope || await harnessAndDescendants(harnessId, { run });
  return run(
    `SELECT x.slug, h.key AS harness, h.id = $2 AS direct FROM xell x JOIN harness h ON h.id = x.harness_id
      WHERE x.harness_id = ANY($1::uuid[]) AND x.status NOT IN ('retired','tearing-down','husk')
      ORDER BY x.slug`, [ids, harnessId]);
}

// How a wearer list is said out loud: the xell, and — when it is wearing a DESCENDANT — the harness
// in between, because "why is xyz in the way?" is otherwise unanswerable from the message.
export function wearerList(worn) {
  return worn.map((w) => (w.direct ? w.slug : `${w.slug} (wearing "${w.harness}", which inherits it)`)).join(', ');
}

// ONE line at the end of every refresh: how many file-backed harnesses carry something, how many
// carry NOTHING, which ones, and how many live xells are wearing an empty one.
//
// A harness carrying nothing is invisible otherwise — the row looks perfectly healthy while the zee
// wearing it is briefed with a blank page, which is exactly how manager zees walked around blind for
// weeks when the text still lived in files the deployed queenzee could not read. A boot is not "clean" if a zee's persona is a blank page, so this line is
// always emitted, and goes to stdout (the docker log a human actually reads) the moment it isn't 0.
export async function logHarnessSummary() {
  const rows = await q(
    `SELECT h.key, h.is_law_core,
            h.bundle->>'personality' AS personality, (h.bundle->'skills') AS skills, (h.bundle->'memory') AS memory,
            (SELECT count(*)::int FROM xell x
               WHERE x.harness_id = h.id AND x.status NOT IN ('retired','tearing-down','husk')) AS worn
       FROM harness h WHERE NOT h.is_law_core AND h.enabled ORDER BY h.key`);
  const empty = [], loaded = [];
  let wornEmpty = 0;
  for (const h of rows) {
    const health = harnessHealth(h);
    if (health.bundle_empty) {
      empty.push(`${h.key}${h.worn ? ` ×${h.worn}` : ''}`);
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

// NOTE: the cxell manual lives INSIDE the meta DB — seeded into Zee Base's harness.bundle.memory by
// migration 047 and amended by migration since. There is no file ingest anywhere: the manual is
// editable in the console's harness manager and injected into a xell only via harness assignment.

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
  //
  // The SCOPE check is belt-and-braces (pool_default_harness_scope_guard refuses the column being set
  // to another project's harness at all), and it fails the way this function already fails: no
  // default, so the dispatch attaches nothing — never another project's persona.
  const h = await one(`SELECT zee_type, project_id FROM harness WHERE id=$1`, [r.default_harness_id]);
  if (!harnessFitsType(h?.zee_type, zeeType)) return null;
  return harnessFitsProject(h?.project_id, projectId) ? r.default_harness_id : null;
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
    const x = await one(`SELECT zee_type, project_id FROM xell WHERE id=$1`, [xellId]);
    if (!harnessFitsType(h.zee_type, x?.zee_type)) throw new Error(typeMismatchReason(h, x?.zee_type));
    // SCOPE next (084), same reasoning: the trigger refuses it either way, but a caller deserves the
    // sentence rather than a postgres exception — and this one names the project that owns it.
    if (!harnessFitsProject(h.project_id, x?.project_id)) {
      const owner = await one(`SELECT name FROM project WHERE id=$1`, [h.project_id]);
      throw new Error(scopeMismatchReason(h, owner?.name || null));
    }
  }
  await one(`UPDATE xell SET harness_id=$2 WHERE id=$1 RETURNING id`, [xellId, h?.id || null]);
  logline('harness', `xell ${String(xellId).slice(0, 8)} → harness ${h?.key || '(core only)'}`);
  return { harness: h ? { id: h.id, key: h.key, label: h.label } : null };
}

// List enabled harnesses for the picker/UI (core last — it is implicit/always-on).
export async function listHarnesses({ zeeType = null, projectId = null } = {}) {
  const rows = await q(
    `SELECT h.id, h.key, h.label, h.is_law_core, h.enabled, h.head_commit, h.zee_type, h.project_id,
            (h.bundle->>'avatar_svg') IS NOT NULL AS has_avatar,
            (h.bundle->'skills') AS skills, (h.bundle->'memory') AS memory,
            h.bundle->>'summary' AS summary, h.bundle->>'glyph' AS glyph,
            h.bundle->>'personality' AS personality,
            p.key AS parent, pr.name AS project_name
       FROM harness h LEFT JOIN harness p ON p.id = h.parent_id
            LEFT JOIN project pr ON pr.id = h.project_id
      WHERE h.enabled ORDER BY h.is_law_core, h.key`);
  // `zeeType` narrows the list to what a xell of that type may actually WEAR — what every picker
  // must offer, so an operator is never shown a choice the assign path would then refuse.
  //
  // `projectId` narrows it the same way on the SCOPE axis (084): a project's list is the system-wide
  // harnesses PLUS that project's own, and never another project's. Omitting it returns everything —
  // that is the console's harness manager, which edits them all and says which scope each row is.
  return rows.filter((h) => (!zeeType || harnessFitsType(h.zee_type, zeeType))
                         && (!projectId || harnessFitsProject(h.project_id, projectId))).map((h) => ({
    id: h.id, key: h.key, label: h.label, is_law_core: h.is_law_core, parent: h.parent,
    zee_type: h.zee_type,
    // SCOPE, on every row: a picker that shows a project persona and a global one identically invites
    // an operator to edit the fleet's shared vocabulary thinking it is their own.
    project_id: h.project_id || null, project_name: h.project_name || null,
    scope: h.project_id ? 'project' : 'global',
    has_avatar: !!h.has_avatar, avatar_url: h.has_avatar ? `/api/harnesses/${h.key}/avatar` : null,
    head_commit: h.head_commit, summary: h.summary, glyph: h.glyph,
    skill_count: Array.isArray(h.skills) ? h.skills.length : 0,
    // HONESTY about what this harness actually carries: a row that would brief a zee with NOTHING
    // looks identical to one carrying a 15k manual in every picker otherwise. Computed at read time,
    // so it is never a stale flag.
    ...harnessHealth(h),
  }));
}

// bundle_empty is the ONE health question now that the meta-DB owns the text: there is no folder
// that can go missing, only a row that says nothing — no personality, no skills, no memory. core is
// excluded: its text is code-assembled, so an empty bundle there is correct.
export function harnessHealth(h) {
  if (h.is_law_core) return { bundle_empty: false };
  const skills = Array.isArray(h.skills) ? h.skills : [];
  const memory = Array.isArray(h.memory) ? h.memory : [];
  return {
    bundle_empty: !String(h.personality || '').trim() && !skills.length
      && !memory.some((m) => m && String(m.text || '').trim()),
  };
}

// ── harness authoring — the ONLY way a harness's text changes ────────────────────────────────────
// A harness is a PERSONA an AI assumes as a zee: personality + skills + memory, owned by the meta-DB
// (migration 080). These functions and `harness_memory_put` in a migration are the whole surface;
// there is no file to edit. The `core` law harness is off-limits.
//
// The field whitelist below is also the LAW guard: a bundle can only ever carry
// personality/summary/glyph/label/skills/memory/zee_type/parent, so no harness — however it is
// authored — has anywhere to express a land/ship/prod/gate rule.
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

export async function createHarness({ key, label, glyph, zee_type, project_id = null } = {}) {
  const k = slugKey(key || label);
  if (k === 'core') throw new Error('"core" is reserved for the law harness');
  // Keys are UNIQUE across the fleet, scoped or not: a key is how a harness is named on a dispatch
  // (`--harness <key>`) and in the meta-DB, so two harnesses answering to one key would make that
  // reference ambiguous. Say so, rather than let the raw constraint speak.
  if (await one(`SELECT id FROM harness WHERE key=$1`, [k])) {
    throw new Error(`a harness "${k}" already exists — harness keys are unique across the hive `
      + '(they are how a harness is named on a dispatch), so pick another name');
  }
  // Which TYPE of zee this persona is for. Worker is the default — the overwhelming majority, and
  // the safe one: a manager harness handed to a worker teaches verbs the worker does not have.
  const type = normalizeZeeType(zee_type, 'worker');
  // SCOPE (084): NULL = system-wide, and that is the DEFAULT — a harness created without a project is
  // the fleet's shared vocabulary, exactly as every harness was before scoping existed. A project_id
  // makes it that project's own, visible nowhere else and deleted with the project.
  const bundle = { label: label || k, zee_type: type, ...(glyph ? { glyph: String(glyph).slice(0, 4) } : {}) };
  await one(`INSERT INTO harness (key,label,bundle,enabled,is_law_core,zee_type,project_id)
               VALUES ($1,$2,$3,true,false,$4,$5) RETURNING id`,
    [k, label || k, JSON.stringify(bundle), type, project_id || null]);
  logline('harness', `created ${type} harness "${k}"${project_id ? ` scoped to project ${String(project_id).slice(0, 8)}` : ' (system-wide)'}`);
  return getHarnessFull(k);
}

// `mode` rides through to the live re-injection for the same reason refreshHarnesses took one: the
// write into a running cxell is a real side effect, and a NESTED queenzee (a zee running the server
// inside its own xell, whose fleet rows are the REAL fleet's) must only ever report it.
export async function updateHarness(key, patch = {}, { mode = PROVISION_MODE } = {}) {
  const h = await one(`SELECT * FROM harness WHERE key=$1`, [key]);
  if (!h) throw new Error(`no harness "${key}"`);
  if (h.is_law_core) throw new Error('the core (law) harness is not editable');
  const bundle = (typeof h.bundle === 'string' ? JSON.parse(h.bundle) : h.bundle) || {};
  if ('personality' in patch) bundle.personality = String(patch.personality || '');
  if ('summary' in patch) bundle.summary = String(patch.summary || '').slice(0, 200);
  if ('glyph' in patch) bundle.glyph = String(patch.glyph || '').slice(0, 4);
  // The badge, as text. Refused unless it is an SVG document — this is served to a browser, and an
  // operator pasting the wrong thing should be told at the save, not by a broken image everywhere.
  if ('avatar_svg' in patch) {
    const svg = String(patch.avatar_svg || '').trim();
    if (svg && !/^<svg[\s>]/i.test(svg)) throw new Error('an avatar must be an SVG document (it starts with <svg …>)');
    if (svg.length > 200_000) throw new Error('that SVG is too large for a badge (200k max)');
    if (svg) bundle.avatar_svg = svg; else delete bundle.avatar_svg;
  }
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
  let parentId = h.parent_id;
  if ('parent' in patch) {
    parentId = null;
    if (patch.parent) {
      if (patch.parent === key) throw new Error('a harness cannot inherit itself');
      const p = await one(`SELECT id FROM harness WHERE key=$1`, [patch.parent]);
      if (!p) throw new Error(`no parent harness "${patch.parent}"`);
      parentId = p.id;
    }
  }
  // NO LEAF MAY CLAIM AN INHERITED FILE PATH — checked against the parent chain this save ENDS with,
  // so re-parenting onto a harness that already owns one of these paths is refused too. Before any
  // write, because a refused save must leave the stored persona exactly as it was.
  await assertNoInheritedPathCollision(key, bundle, parentId);
  if ('parent' in patch) await q(`UPDATE harness SET parent_id=$2 WHERE key=$1`, [key, parentId]);
  const hash = hashOf(JSON.stringify(bundle));
  await q(`UPDATE harness SET bundle=$2, label=$3, enabled=$4, bundle_hash=$5 WHERE key=$1`,
    [key, JSON.stringify(bundle), label, enabled, hash]);
  logline('harness', `updated harness "${key}" (${(bundle.skills || []).length} skill(s), ${(bundle.memory || []).length} memory)`);
  // A SAVE IS NOW THE ONLY WAY THE TEXT MOVES, so it is also what has to reach the zees ALREADY
  // RUNNING. While a folder was the source, the boot refresh noticed the change and pushed it in;
  // with the row as the source that path is gone, and without this an operator fixing a manual would
  // fix it for the NEXT zee only — the exact "new zees only" failure that left a whole fleet briefed
  // on stale text (test/harness-reinject-live.test.mjs). Guarded on the hash so a no-op save writes
  // nothing into anyone's workspace, and PROVISION_MODE-guarded inside.
  //
  // AND THE CALLER IS TOLD WHETHER IT RAN: `reinjected: null` means the text did not change, so no
  // workspace was touched at all; otherwise it is the real outcome (how many xells, how many files
  // written, whether this queenzee only modelled it). The manager API used to print "every live zee
  // wearing it has had its persona files rewritten" on EVERY save — including the enabled-only saves
  // that leave bundle_hash identical and skip this line entirely. An answer that overstates what
  // happened is its own defect: the repo's whole posture is to say what really happened.
  const reinjected = hash !== h.bundle_hash ? await reinjectHarnessIntoLiveXells(h.id, { mode }) : null;
  return { ...(await getHarnessFull(key)), reinjected };
}

// DELETE, refused while any LIVE xell wears this harness OR anything that INHERITS it — and decided
// inside ONE transaction, so the answer cannot be overtaken by a dispatch.
//
// Both halves are paid-for. `xell.harness_id` is ON DELETE SET NULL and `harness.parent_id` is too,
// so deleting a harness either strips a running zee back to core-only or collapses its chain to the
// leaf alone — the same end state, one level up, and the guard that only asked about direct wearers
// returned ok for it. And the check was a SELECT followed by a DELETE with nothing holding the rows
// in between: a dispatch landing in that window assigned a harness that was already going. The
// `FOR UPDATE` conflicts with the FOR KEY SHARE lock that a xell's `harness_id` write takes on the
// referenced row, so only two orders remain — we see the wearer and refuse, or the assign waits and
// then fails its foreign key loudly, which is not the same as a zee quietly losing its persona.
//
// Returns the wearers instead of throwing: the caller writes the sentence (it knows who is asking).
export async function deleteHarnessUnlessWorn(key) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = async (text, params) => (await client.query(text, params)).rows;
    const [h] = await run(`SELECT id, is_law_core FROM harness WHERE key=$1`, [key]);
    if (!h) { await client.query('ROLLBACK'); return { deleted: false, missing: true, worn: [] }; }
    if (h.is_law_core) { await client.query('ROLLBACK'); throw new Error('the core (law) harness cannot be deleted'); }
    const scope = await harnessAndDescendants(h.id, { run });
    await run(`SELECT id FROM harness WHERE id = ANY($1::uuid[]) FOR UPDATE`, [scope]);
    const worn = await liveHarnessWearers(h.id, { run, scope });
    if (worn.length) { await client.query('ROLLBACK'); return { deleted: false, worn }; }
    await run(`DELETE FROM harness WHERE id=$1`, [h.id]);
    await client.query('COMMIT');
    logline('harness', `deleted harness "${key}" (nothing live was wearing it or anything inheriting it)`);
    return { deleted: true, worn: [] };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
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
  // Which SCOPE this persona is in (084) — the editor states it, and its parent picker needs it: a
  // harness may only inherit a global one or one in its own project.
  const owner = h.project_id ? await one(`SELECT name FROM project WHERE id=$1`, [h.project_id]) : null;
  return {
    key: h.key, label: h.label, enabled: h.enabled, is_law_core: h.is_law_core,
    project_id: h.project_id || null, project_name: owner?.name || null,
    scope: h.project_id ? 'project' : 'global',
    avatar_svg: harnessAvatarSvg(b) || '',
    parent, zee_type: h.zee_type, glyph: b.glyph || null, summary: b.summary || '', personality: b.personality || '',
    skills: Array.isArray(b.skills) ? b.skills : [], memory: Array.isArray(b.memory) ? b.memory : [],
    inherited,
    // same honesty as the list: is the folder readable from here, and does this bundle carry anything?
    ...harnessHealth({ ...h, ...b }),
  };
}

// The FILES an effective harness materializes into a xell (docs §6) — its persona, skills, and
// memory (incl. the cxell manual carried by Zee Base). GENERATED from the harness rows when a zee is
// assigned the harness (at dispatch, and again whenever the harness changes under a live zee), so the
// persona is real files in the workspace and not only prompt text. Skills also load as Claude
// SKILL.md; persona + memory land under .zeehive/harness/.
const fileSafe = (s) => String(s || 'note').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'note';

// THE FILE AN ENTRY LANDS ON — derived in ONE place, because every other question about it (may this
// leaf claim that path? did two entries claim the same one?) has to be asked about the path the
// injector actually writes. A memory entry is keyed on its BASENAME (`memory/x.md` and `x.md` are the
// same file), a skill on its slugged name.
export const memoryRelPath = (path) => `.zeehive/harness/memory/`
  + `${fileSafe(String(path).split('/').pop() || 'memory').replace(/\.md$/, '')}.md`;
export const skillRelPath = (name) => `.claude/skills/${fileSafe(name)}/SKILL.md`;

// EVERY GENERATED FILE SAYS SO, AND SAYS WHERE THE SOURCE IS.
//
// These files look exactly like checked-in repo files to whoever opens one — and a zee that treats
// its manual as editable repo text will "fix" a page that is regenerated from the meta-DB on the next
// assignment: the edit lands in no diff, reaches no other zee, and disappears without an error. One
// header removes that whole class of wasted turn, and it is also how a reader learns where the real
// source is. `from` names the harness in the chain that OWNS the entry (a dev-crew wearer's manual
// comes from `zee-base`, not from the harness it is wearing).
export function generatedBanner({ from, kind, path }) {
  return `<!-- GENERATED by ZEEHIVE from the meta-DB — harness \`${from}\`, ${kind}${path ? ` \`${path}\`` : ''}.\n`
    + '     Written into this xell when the harness was assigned, and rewritten whenever it changes.\n'
    + '     Editing THIS copy changes nothing: it is git-ignored, lands in no diff and is overwritten.\n'
    + "     The source is the harness row — edit it in the console's harness manager, or by migration. -->";
}

export function harnessFiles(eff) {
  if (!eff) return [];
  const files = [];
  const key = eff.key || fileSafe(eff.label);
  if (eff.personality && eff.personality.trim()) {
    files.push({ relPath: '.zeehive/harness/PERSONA.md',
      text: `${generatedBanner({ from: key, kind: 'personality' })}\n\n# ${eff.label} — persona\n\n${eff.personality.trim()}\n` });
  }
  for (const s of eff.skills || []) {
    if (!s.body) continue;
    // The banner goes AFTER the frontmatter block: a SKILL.md's `---` must be the first line or the
    // provider stops seeing it as a skill at all.
    files.push({ relPath: skillRelPath(s.name),
      text: `---\nname: ${s.name}\ndescription: ${String(s.when).replace(/\n/g, ' ')}\n---\n\n`
        + `${generatedBanner({ from: s.from || key, kind: 'skill', path: s.name })}\n\n${s.body}\n` });
  }
  for (const m of eff.memory || []) {
    if (!m.text) continue;
    files.push({ relPath: memoryRelPath(m.path),
      text: `${generatedBanner({ from: m.from || key, kind: 'memory', path: m.path })}\n\n${m.text}` });
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
  const merged = { key: leafRow.key, label: leafRow.label, glyph: null, summary: null, personality: '', skills: [], memory: [], chain: chain.map((c) => c.label) };
  const bundleOf = (r) => (typeof r.bundle === 'string' ? JSON.parse(r.bundle) : (r.bundle || {}));
  // ONE ENTRY PER FILE, AND THE ANCESTOR OWNS IT (root wins).
  //
  // The union used to be a plain concatenation, while harnessFiles() keys a file on the entry's
  // BASENAME — so a leaf with a memory entry called `cxell-zee-manual.md` produced a SECOND
  // .zeehive/harness/memory/cxell-zee-manual.md, and reinjectHarnessIntoXell writes that list in
  // order with no dedup: the LEAF's text landed last and became the manual the worker was told to
  // trust (same trick for a skill's SKILL.md, and harnessLayerText carried the second copy in the
  // prompt as well). A manager may author a project persona, so this was a forgeable law layer.
  //
  // The authoring path now refuses such a save with the collision named, but this is the half that
  // does not depend on how the row got here — a migration or a hand-edited bundle cannot shadow an
  // inherited file either. Precedence is root-most, deliberately: the ancestor's entry is the one
  // every wearer of every descendant already relies on.
  const claimed = new Map();
  const claim = (relPath, ownerKey, what) => {
    if (!claimed.has(relPath)) { claimed.set(relPath, ownerKey); return true; }
    logline('harness', `${leafRow.key}: ${what} from "${ownerKey}" was DROPPED from the effective persona — `
      + `"${claimed.get(relPath)}" already owns ${relPath}, and an inherited file path cannot be shadowed`);
    return false;
  };
  for (const row of chain) {
    const b = bundleOf(row);
    if (b.glyph) merged.glyph = b.glyph;
    if (b.summary) merged.summary = b.summary;
    if (b.personality && b.personality.trim()) {
      merged.personality += (merged.personality ? '\n\n' : '')
        + (chain.length > 1 ? `— from ${row.label}:\n` : '') + b.personality.trim();
    }
    // `from` is provenance, carried so a generated file can name the harness that actually owns the
    // entry rather than the one being worn (the manual belongs to zee-base, whoever inherits it).
    if (Array.isArray(b.skills)) {
      for (const s of b.skills) {
        if (!s || !s.name) continue;
        if (claim(skillRelPath(s.name), row.key, `skill "${s.name}"`)) merged.skills.push({ ...s, from: s.from || row.key });
      }
    }
    if (Array.isArray(b.memory)) {
      for (const m of b.memory) {
        if (!m || !m.text) continue;
        if (claim(memoryRelPath(m.path), row.key, `memory "${m.path}"`)) merged.memory.push({ ...m, from: m.from || row.key });
      }
    }
  }
  return merged;
}

// The file paths a harness INHERITS, and which ancestor owns each — what a leaf may not occupy.
//
// Walked WITHOUT effectiveHarness's `enabled` filter: a path a DISABLED ancestor owns is still that
// ancestor's, and a leaf allowed to take it would start shadowing the moment somebody re-enabled it.
// The map keeps the ROOT-MOST owner, which is the one that actually wins the merge above.
async function inheritedFilePaths(parentId) {
  const owner = new Map();
  let cur = parentId ? await one(`SELECT id, key, parent_id, bundle FROM harness WHERE id=$1`, [parentId]) : null;
  let hops = 0;
  while (cur && hops++ < 32) {
    const b = typeof cur.bundle === 'string' ? JSON.parse(cur.bundle) : (cur.bundle || {});
    for (const s of b.skills || []) if (s?.name) owner.set(skillRelPath(s.name), cur.key);
    for (const m of b.memory || []) if (m?.path) owner.set(memoryRelPath(m.path), cur.key);
    cur = cur.parent_id ? await one(`SELECT id, key, parent_id, bundle FROM harness WHERE id=$1`, [cur.parent_id]) : null;
  }
  return owner;
}

// REFUSE a save that would claim an inherited file path, and NAME the collision — the author is the
// one person who can fix it, and a silent drop (which is what the merge now does underneath) reads to
// them like their text saved. Both routes matter: memory and skills materialize into files.
async function assertNoInheritedPathCollision(key, bundle, parentId) {
  if (!parentId) return;
  const owner = await inheritedFilePaths(parentId);
  if (!owner.size) return;
  const clashes = [];
  for (const s of bundle.skills || []) {
    const p = skillRelPath(s.name);
    if (owner.has(p)) clashes.push(`skill "${s.name}" would land on ${p}, which it INHERITS from "${owner.get(p)}"`);
  }
  for (const m of bundle.memory || []) {
    const p = memoryRelPath(m.path);
    if (owner.has(p)) clashes.push(`memory "${m.path}" would land on ${p}, which it INHERITS from "${owner.get(p)}"`);
  }
  if (!clashes.length) return;
  throw new Error(`"${key}" cannot occupy a file path it inherits — ${clashes.join('; ')}. `
    + 'A harness materializes into REAL FILES in a xell, and a file is keyed on its basename, so this '
    + "entry would overwrite the ancestor's copy in every wearer's workspace — a worker is told those "
    + 'files are its law. Rename yours; changing what the ancestor says is done on the ancestor.');
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
  // Same path derivation as harnessFiles (skillRelPath): two spellings of "where does this skill go"
  // is one more place a file can be shadowed by an entry the other writer keys differently.
  return (eff.skills || []).filter((s) => s.body).map((s) => ({
    relPath: skillRelPath(s.name),
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

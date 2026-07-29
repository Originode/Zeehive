// HARNESS PROJECT SCOPE — a manager mints its OWN specialised worker personas (TKT-23-8EE4).
//
// A harness used to be system-wide and only a human could add one (044: "it has NO project_id … it is
// visible to EVERY project"). That is still the default and every existing row still is one — core,
// zee-base, manager, the dev-* crew are the fleet's shared vocabulary. What 084 adds is the other
// half: `harness.project_id`, so a MANAGER zee can create a specialist for its own project through
// the API, without a human, and without ever being able to widen what a worker may do.
//
// This test stands up two ISOLATED throwaway projects in the real meta DB (a manager xell and a
// worker xell in one, a worker xell in the other) and proves BOTH directions:
//
//   1. the DEFAULT is unchanged — every seeded harness is global, and a create with no project is too;
//   2. VISIBILITY — a project's list is the global rows plus its own, never another project's, and an
//      unfiltered list SAYS which scope each row is;
//   3. WEARING, enforced in the DB (084's triggers, 054's shape) from both directions: the assign
//      path, a raw UPDATE, re-scoping a harness somebody else's xell already wears, cross-project
//      INHERITANCE (which would merge one project's text into another's briefings), and the law layer;
//   4. THE HAPPY PATH — the manager creates a project-scoped worker persona inheriting a GLOBAL one, a
//      xell of that project wears it, and the briefing it is given carries the INHERITED manual;
//   5. EVERY REFUSAL on the manager API, each asserted on its own: a manager persona, any system-wide
//      harness, another project's harness, a non-persona field (is_law_core included), a foreign or
//      cross-type parent, deleting a harness a live xell is wearing, and a worker calling the verb;
//   6. the per-project DEFAULT harness (pool_config) cannot be pointed at another project's persona;
//   7. DISPATCH — a manager may hand a worker its own project's persona, and not another's.
//
// No agents are spawned and no containers are touched. Everything it creates is removed in a finally.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.PROVISION_MODE = 'simulate';      // never exec into a cxell (harness re-injection)

const { q, one, pool } = await import('../server/src/db/pool.js');
const H = await import('../server/src/lib/harness.js');
const S = await import('../server/src/queenzee/self.js');
const { getPoolConfig, updatePoolConfig } = await import('../server/src/lib/projects.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
// A refusal is only a refusal if it SAYS something a zee can act on. Assert both halves every time.
const refused = (r, re, m) => ok(r?.ok === false && re.test(r.error || ''), `${m}\n      → ${String(r?.error || '(no message)').slice(0, 150)}`);

const tag = randomUUID().slice(0, 8);
const P1 = { name: `zt-hscope-a-${tag}` };      // the manager's own project
const P2 = { name: `zt-hscope-b-${tag}` };      // somebody else's project
const keys = { mine: `zt-own-${tag}`, theirs: `zt-other-${tag}`, global: `zt-global-${tag}`,
               mgr: `zt-mgrpersona-${tag}` };

// The console components are .jsx, so compile them to a temp .mjs and import that — same trick as
// harness-authoring-ui. The build files are removed in the finally with everything else.
const compiled = [];
function compile(rel, name) {
  const file = join(dirname(rel), `.${name}.test-build.mjs`);
  writeFileSync(file, transformSync(readFileSync(rel, 'utf8'), { loader: 'jsx', format: 'esm', jsx: 'transform' }).code);
  compiled.push(file);
  return `file://${process.cwd()}/${file}`;
}

async function cleanup() {
  for (const f of compiled) rmSync(f, { force: true });
  for (const k of Object.values(keys)) await q(`DELETE FROM harness WHERE key=$1`, [k]).catch(() => {});
  await q(`DELETE FROM harness WHERE key LIKE $1`, [`zt-new-${tag}%`]).catch(() => {});
  for (const p of [P1, P2]) if (p.id) await q(`DELETE FROM project WHERE id=$1`, [p.id]).catch(() => {});
}

try {
  await cleanup();

  // ── fixtures: two projects, three xells, one harness in each scope ──────────
  for (const p of [P1, P2]) {
    p.id = (await one(`INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'master') RETURNING id`,
      [p.name, `/tmp/${p.name}`])).id;
    await q(`INSERT INTO pool_config (project_id) VALUES ($1)`, [p.id]);
    p.xource = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [p.id])).id;
  }
  // The verbs take a xell ROW (routes.js resolves it from the token), so hand them the real thing.
  const mkXell = (p, slug, type = 'worker') => one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, zee_type)
       VALUES ($1,$2,$3,$4,$5,'working',false,$6) RETURNING *`,
    [p.id, p.xource, slug, `spinoff/${slug}`, `/tmp/${slug}`, type]);
  const mgr = await mkXell(P1, `zt-mgr-${tag}`, 'manager');
  const w1 = await mkXell(P1, `zt-w1-${tag}`);
  const w2 = await mkXell(P2, `zt-w2-${tag}`);

  // ── 1. the DEFAULT is global, and nothing was migrated off it ──────────────
  console.log('\n── NULL project_id = system-wide, and that is still the default ──');
  const seeded = await q(`SELECT key, project_id FROM harness WHERE key IN ('core','zee-base','manager','dev-base','dev-builder')`);
  ok(seeded.length >= 4 && seeded.every((h) => h.project_id === null),
     `every harness the fleet ships with is system-wide (${seeded.map((h) => h.key).join(', ')})`);
  const globalOne = await H.createHarness({ key: keys.global, label: `ZT Global ${tag}` });
  ok(globalOne.scope === 'global' && globalOne.project_id === null,
     'a harness created with no project is GLOBAL — the default is unchanged for every caller');
  const theirs = await H.createHarness({ key: keys.theirs, label: `ZT Theirs ${tag}`, project_id: P2.id });
  ok(theirs.scope === 'project' && theirs.project_id === P2.id && theirs.project_name === P2.name,
     'a harness created with a project is scoped to it, and says whose it is');

  // ── 2. VISIBILITY ──────────────────────────────────────────────────────────
  console.log('\n── a project sees the global harnesses + its own, and nobody else\'s ──');
  const mine = await H.createHarness({ key: keys.mine, label: `ZT Mine ${tag}`, project_id: P1.id });
  const listP1 = await H.listHarnesses({ projectId: P1.id });
  const listP2 = await H.listHarnesses({ projectId: P2.id });
  ok(listP1.some((h) => h.key === keys.global), "P1's list carries the system-wide harness");
  ok(listP1.some((h) => h.key === keys.mine), "and its own project-scoped one");
  ok(!listP1.some((h) => h.key === keys.theirs), "and NOT the other project's");
  ok(listP2.some((h) => h.key === keys.theirs) && !listP2.some((h) => h.key === keys.mine),
     'and the other project sees exactly the mirror image');
  const unfiltered = await H.listHarnesses();
  ok(unfiltered.some((h) => h.key === keys.mine) && unfiltered.some((h) => h.key === keys.theirs),
     'the unfiltered list (the console harness manager) still returns every harness');
  const rowMine = unfiltered.find((h) => h.key === keys.mine);
  const rowGlobal = unfiltered.find((h) => h.key === keys.global);
  ok(rowMine.scope === 'project' && rowMine.project_name === P1.name && rowGlobal.scope === 'global',
     'but every row SAYS its scope (and names the project that owns it) — a picker cannot show them alike');
  ok((await H.getHarnessFull(keys.mine)).scope === 'project'
     && (await H.getHarnessFull(keys.global)).scope === 'global',
     'the editor read model carries the scope too');

  // ── 3. WEARING — the DB is the wall, from both directions ──────────────────
  console.log('\n── a xell may only wear a global harness or its OWN project\'s (084 triggers) ──');
  ok((await H.assignHarness(w1.id, keys.mine)).harness?.key === keys.mine,
     "a xell wears its own project's persona");
  ok((await H.assignHarness(w2.id, keys.global)).harness?.key === keys.global,
     'and any xell wears a system-wide one');
  const crossAssign = await H.assignHarness(w2.id, keys.mine).catch((e) => ({ ok: false, error: e.message }));
  refused(crossAssign, /belongs to project/, "assigning another project's persona is refused with a sentence");
  try {
    await q(`UPDATE xell SET harness_id=(SELECT id FROM harness WHERE key=$2) WHERE id=$1`, [w2.id, keys.mine]);
    ok(false, 'a raw UPDATE bypassing the assign path is refused by the DB');
  } catch (e) { ok(/belongs to project/.test(e.message), `a raw UPDATE bypassing the assign path is refused by the DB (${e.message.split('\n')[0].slice(0, 60)})`); }
  try {
    await q(`UPDATE harness SET project_id=$2 WHERE key=$1`, [keys.global, P1.id]);
    ok(false, "a harness cannot be scoped out from under another project's xell that wears it");
  } catch (e) { ok(/worn by 1 xell\(s\) of another project/.test(e.message),
    `a harness cannot be scoped out from under another project's xell that wears it (${e.message.split('\n')[0].slice(0, 70)})`); }
  try {
    await q(`UPDATE harness SET parent_id=(SELECT id FROM harness WHERE key=$2) WHERE key=$1`, [keys.theirs, keys.mine]);
    ok(false, 'a harness cannot INHERIT another project\'s harness');
  } catch (e) { ok(/may only inherit a SYSTEM-WIDE harness/.test(e.message),
    'a harness cannot INHERIT another project\'s harness (it would merge that project\'s text into these briefings)'); }
  try {
    await q(`UPDATE harness SET project_id=$1 WHERE is_law_core`, [P1.id]);
    ok(false, 'the core (law) harness cannot be scoped to one project');
  } catch (e) { ok(/law layer for every zee/.test(e.message), 'the core (law) harness cannot be scoped to one project'); }

  // ── 4. THE HAPPY PATH: the manager mints a specialist that INHERITS a global one ──
  console.log('\n── a manager creates a project persona inheriting a GLOBAL one, and a worker wears it ──');
  const created = await S.selfHarnessCreate(mgr, {
    key: `zt-new-${tag}`, label: `ZT Migration Specialist ${tag}`, parent: 'zee-base',
    summary: 'knows this project\'s migration discipline',
    personality: 'You write migrations forward-only and you never renumber one.',
    memory: [{ path: 'migrations.md', text: 'Number clear of the highest in db/migrations/.' }],
  });
  ok(created.ok === true, `the create is accepted: ${String(created.message || created.error).slice(0, 90)}`);
  const newKey = created.harness?.key;
  ok(created.harness?.scope === 'project' && created.harness?.project_id === P1.id,
     "and the row is scoped to the MANAGER'S OWN project (taken from its token, not from the body)");
  ok(created.harness?.zee_type === 'worker', 'it is a WORKER persona');
  ok(created.harness?.parent === 'zee-base', 'it inherits the global harness it named');
  ok(!(await H.listHarnesses({ projectId: P2.id })).some((h) => h.key === newKey),
     'and it is invisible to every other project');
  // What comes BACK matters as much as what was written: a manager's context is the one budget it
  // cannot refill, and getHarnessFull() carries every inherited BODY (zee-base's 32k manual here).
  ok(!JSON.stringify(created.harness).includes('You are a **cxell zee**'),
     'the answer does not recite the inherited manual back at the caller');
  ok(created.harness.briefing_chars > 30000
     && created.harness.inherited.memory.some((m) => /cxell-zee-manual\.md \(zee-base, \d+ chars\)/.test(m)),
     `but it says what was inherited, from whom, and how big the briefing now is (${created.harness.briefing_chars} chars)`);

  ok((await H.assignHarness(w1.id, newKey)).harness?.key === newKey, 'a xell of that project wears it');
  const eff = await H.effectiveHarness(await one(`SELECT * FROM harness WHERE key=$1`, [newKey]));
  ok(eff.chain.length === 2 && /Zee Base/.test(eff.chain[0]),
     `the effective persona is the merged chain (${eff.chain.join(' → ')})`);
  const layer = H.harnessLayerText(eff);
  const manual = (eff.memory || []).find((m) => /cxell-zee-manual/.test(m.path));
  ok(!!manual && manual.from === 'zee-base' && manual.text.length > 3000,
     `the INHERITED manual comes down the chain from zee-base (${manual?.text.length || 0} chars)`);
  ok(layer.includes('zee build') && layer.includes('zee land'),
     'so the briefing block a wearer is given carries the manual it inherited, verbatim');
  ok(layer.includes('You write migrations forward-only'), "and the manager's own persona text on top of it");
  const files = H.harnessFiles(eff);
  ok(files.some((f) => f.relPath === '.zeehive/harness/memory/cxell-zee-manual.md'),
     'and the files materialized into the xell include the inherited manual');
  ok(files.some((f) => f.relPath === '.zeehive/harness/memory/migrations.md'),
     "plus the memory the manager wrote");

  // reading one back — its own text in full, the inherited chain described
  const readBack = await S.selfHarnessGet(mgr, newKey);
  ok(readBack.ok === true && readBack.editable === true
     && readBack.harness.personality.includes('forward-only')
     && readBack.harness.memory[0].text.includes('Number clear'),
     'the manager reads its own persona back in full (personality + memory bodies)');
  const readGlobal = await S.selfHarnessGet(mgr, 'dev-base');
  ok(readGlobal.ok === true && readGlobal.editable === false && /Inherit it instead/.test(readGlobal.message),
     'it can READ a system-wide persona (that is how it decides whether to inherit one) but is told it is not editable');
  refused(await S.selfHarnessGet(mgr, keys.theirs), /belongs to project/,
          "and reading another project's persona is refused like everything else");

  // editing it works, and stays scoped
  const edited = await S.selfHarnessUpdate(mgr, newKey, { summary: 'edited by its manager' });
  ok(edited.ok === true && edited.harness.summary === 'edited by its manager',
     'the manager can edit its own persona');
  ok(edited.harness.scope === 'project' && edited.harness.project_id === P1.id,
     'and editing does not change its scope');

  // ── 5. EVERY REFUSAL on the manager API, one at a time ─────────────────────
  console.log('\n── what the manager API refuses (each on its own) ──');
  refused(await S.selfHarnessList(w1), /MANAGER verb/, 'a WORKER calling the harness verb is told what it is');
  refused(await S.selfHarnessCreate(w1, { label: 'x' }), /MANAGER verb/, 'and cannot create one either');
  refused(await S.selfHarnessCreate(mgr, {}), /--label/, 'a create with no label is refused');
  refused(await S.selfHarnessCreate(mgr, { label: 'dup', key: newKey }),
          /already exists/, 'a duplicate key is refused, not silently reused');
  refused(await S.selfHarnessCreate(mgr, { label: 'boss', zee_type: 'manager' }),
          /may not create or edit a MANAGER persona/, 'creating a MANAGER persona is refused');
  refused(await S.selfHarnessUpdate(mgr, newKey, { zee_type: 'manager' }),
          /may not create or edit a MANAGER persona/, 'and so is retyping its own persona into one');

  // a manager persona that already exists in this project (a human added it) is untouchable too
  await H.createHarness({ key: keys.mgr, label: `ZT Mgr Persona ${tag}`, zee_type: 'manager', project_id: P1.id });
  refused(await S.selfHarnessUpdate(mgr, keys.mgr, { summary: 'mine now' }),
          /is a MANAGER persona/, "editing this project's own MANAGER persona is refused");
  refused(await S.selfHarnessDelete(mgr, keys.mgr), /is a MANAGER persona/, 'and so is deleting it');

  for (const g of ['zee-base', 'dev-base', 'manager', keys.global]) {
    refused(await S.selfHarnessUpdate(mgr, g, { summary: 'hijacked' }),
            /SYSTEM-WIDE harness|MANAGER persona/, `editing the global harness "${g}" is refused`);
  }
  refused(await S.selfHarnessDelete(mgr, keys.global), /SYSTEM-WIDE harness/,
          'deleting a global harness is refused');
  refused(await S.selfHarnessUpdate(mgr, 'core', { summary: 'x' }), /SYSTEM-WIDE harness/,
          'and the core law harness is refused as the global harness it is');
  refused(await S.selfHarnessUpdate(mgr, keys.theirs, { summary: 'x' }), /belongs to project/,
          "editing another project's harness is refused, and names the owner");
  refused(await S.selfHarnessDelete(mgr, keys.theirs), /belongs to project/,
          "and so is deleting another project's harness");
  refused(await S.selfHarnessUpdate(mgr, `zt-nope-${tag}`, { summary: 'x' }), /no harness/,
          'a harness that does not exist is refused with the list verb to run');

  refused(await S.selfHarnessUpdate(mgr, newKey, { is_law_core: true }), /`is_law_core`/,
          'setting is_law_core is refused BY NAME (not silently dropped)');
  refused(await S.selfHarnessCreate(mgr, { label: 'x', is_law_core: true }), /`is_law_core`/,
          'on the create path too');
  refused(await S.selfHarnessUpdate(mgr, newKey, { bridge: { base_url: 'http://evil' } }), /`bridge`/,
          'and so is any other non-persona field');
  refused(await S.selfHarnessCreate(mgr, { label: 'x', project_id: P2.id }),
          /resolved from your own token/, 'naming a project is refused — the token decides, always');
  refused(await S.selfHarnessUpdate(mgr, newKey, {}), /nothing to change/,
          'an empty edit is refused rather than logged as a save');
  ok((await one(`SELECT project_id, is_law_core FROM harness WHERE key=$1`, [newKey])).project_id === P1.id,
     'after all of that the row is still this project\'s, and still not law-core');

  refused(await S.selfHarnessUpdate(mgr, newKey, { parent: keys.theirs }), /belongs to project/,
          "a parent in another project is refused");
  refused(await S.selfHarnessUpdate(mgr, newKey, { parent: 'manager' }), /MANAGER persona/,
          'a MANAGER parent is refused (it would merge the manager manual into a worker briefing)');
  refused(await S.selfHarnessUpdate(mgr, newKey, { parent: 'core' }), /core \(law\) harness is not a parent/,
          'and the law layer is not a parent — every zee gets it anyway');
  ok((await S.selfHarnessUpdate(mgr, newKey, { parent: keys.mine })).ok === true,
     "but a parent in its OWN project is allowed (mine → mine)");
  ok((await S.selfHarnessUpdate(mgr, newKey, { parent: 'dev-base' })).harness.parent === 'dev-base',
     'and so is any global WORKER harness — that is the whole point of the verb');

  // deleting one a live xell is wearing
  refused(await S.selfHarnessDelete(mgr, newKey), new RegExp(w1.slug),
          'deleting a harness a LIVE xell is wearing is refused, and names the xell');
  await H.assignHarness(w1.id, null);
  const gone = await S.selfHarnessDelete(mgr, newKey);
  ok(gone.ok === true && gone.deleted === true, 'once nothing wears it, the manager deletes its own persona');
  ok(!(await one(`SELECT id FROM harness WHERE key=$1`, [newKey])), 'and the row is really gone');

  // the LIST verb a manager orients from
  const listed = await S.selfHarnessList(mgr);
  ok(listed.ok === true && listed.harnesses.every((h) => h.scope === 'global' || h.project_id === P1.id),
     `\`zee harness\` lists only what this project may use (${listed.count} personas)`);
  ok(listed.harnesses.find((h) => h.key === keys.mine)?.editable === true
     && listed.harnesses.find((h) => h.key === 'zee-base')?.editable === false,
     'and marks which of them are the manager\'s to edit');
  ok(!listed.harnesses.some((h) => h.zee_type === 'manager'),
     'no manager persona is offered at all — a manager dispatches workers');

  // ── 6. the per-project DEFAULT harness ─────────────────────────────────────
  console.log('\n── pool_config.default_harness_id cannot point at another project\'s persona ──');
  let threw = null;
  try { await updatePoolConfig(P1.id, { default_harness_key: keys.theirs }); } catch (e) { threw = e; }
  ok(!!threw && /belongs to another project/.test(threw.message),
     `setting another project's harness as the default is refused ("${String(threw?.message).slice(0, 70)}…")`);
  try {
    await q(`UPDATE pool_config SET default_harness_id=(SELECT id FROM harness WHERE key=$2) WHERE project_id=$1`,
      [P1.id, keys.theirs]);
    ok(false, 'and the DB refuses it even without the library');
  } catch (e) { ok(/belongs to another project/.test(e.message), 'and the DB refuses it even without the library'); }
  await updatePoolConfig(P1.id, { default_harness_key: keys.mine });
  ok((await getPoolConfig(P1.id)).harness_key === keys.mine, "its OWN project's persona is a legal default");
  ok(await H.defaultHarnessId(P1.id) === (await one(`SELECT id FROM harness WHERE key=$1`, [keys.mine])).id,
     'and a bare dispatch in that project attaches it');

  // ── 7. DISPATCH ────────────────────────────────────────────────────────────
  console.log('\n── dispatch: a manager hands out its own project\'s persona, never another\'s ──');
  refused(await S.selfDispatch(mgr, { task: 'do a thing', harness: keys.theirs }),
          /belongs to project/, "dispatching a worker into another project's persona is refused");
  refused(await S.selfDispatch(mgr, { task: 'do a thing', harness: 'manager' }),
          /added by a human/, 'and the existing manager-harness refusal is untouched');
  refused(await S.selfDispatch(mgr, {}), /--task/, 'and so is a dispatch with no brief');

  // ── a project's personas die WITH the project ───────────────────────────────
  console.log('\n── scoped personas are cascaded with their project ──');
  await q(`DELETE FROM project WHERE id=$1`, [P2.id]);
  P2.id = null;
  ok(!(await one(`SELECT id FROM harness WHERE key=$1`, [keys.theirs])),
     "deleting a project takes its scoped personas with it (nothing is left pointing at a project that is gone)");
  ok(!!(await one(`SELECT id FROM harness WHERE key=$1`, [keys.global])),
     'while the system-wide ones are untouched — they were never that project\'s');

  // ── the routes exist and are token-scoped like every other self verb ───────
  console.log('\n── the API surface ──');
  const routes = readFileSync('server/src/api/routes.js', 'utf8');
  for (const [method, path] of [['get', '/xell/self/harnesses'], ['get', '/xell/self/harness/:key'],
                                ['post', '/xell/self/harness'],
                                ['put', '/xell/self/harness/:key'], ['delete', '/xell/self/harness/:key']]) {
    const re = new RegExp(`router\\.${method}\\('${path.replace(/[/:]/g, (c) => `\\${c}`)}'`);
    ok(re.test(routes), `${method.toUpperCase()} ${path} is wired`);
  }
  const block = routes.slice(routes.indexOf("router.get('/xell/self/harnesses'"),
                             routes.indexOf("router.get('/xell/self/harnesses'") + 1800);
  ok((block.match(/resolveSelf\(req, res\)/g) || []).length === 5,
     'and all four resolve the caller from its own TOKEN (never a xell id in the body)');
  const cli = readFileSync('scripts/zee', 'utf8');
  ok(/case 'harness':/.test(cli) && /zee harness/.test(cli),
     'the cxell CLI carries the verb (usage + case — cxell-cli-drift holds them together)');

  // ── the CONSOLE: it SAYS the scope, and offers no other project's persona ───
  // The real components, compiled and rendered (the trick harness-authoring-ui/harness-empty-visible
  // use), because "the picker does not offer it" is a rendering claim.
  console.log('\n── the console shows scope, and offers no other project\'s harness ──');
  const HM = await import(compile('web/src/HarnessManager.jsx', 'hmscope'));
  const mineRow = renderToStaticMarkup(React.createElement(HM.HarnessRow,
    { h: { key: keys.mine, label: 'ZT Mine', scope: 'project', project_name: P1.name, skill_count: 1, zee_type: 'worker' } }));
  ok(mineRow.includes(P1.name) && /harness-scope-/.test(mineRow),
     "a project-scoped row in the (unfiltered) harness manager names the project that owns it");
  const globalRow = renderToStaticMarkup(React.createElement(HM.HarnessRow,
    { h: { key: 'zee-base', label: 'Zee Base', scope: 'global', project_name: null, skill_count: 2, zee_type: 'worker' } }));
  ok(!/harness-scope-/.test(globalRow), 'and a system-wide row carries no scope chip — global is the default, not a label');

  const catalogue = [
    { key: 'zee-base', label: 'Zee Base', zee_type: 'worker', project_id: null, scope: 'global' },
    { key: 'manager', label: 'Manager', zee_type: 'manager', project_id: null, scope: 'global' },
    { key: keys.mine, label: 'Mine', zee_type: 'worker', project_id: P1.id, scope: 'project' },
    { key: keys.theirs, label: 'Theirs', zee_type: 'worker', project_id: 'other-project', scope: 'project' },
  ];
  const offered = HM.parentOptions(catalogue, { key: newKey, zee_type: 'worker', project_id: P1.id }).map((h) => h.key);
  ok(offered.includes('zee-base') && offered.includes(keys.mine),
     `the parent picker offers the global and own-project worker harnesses (${offered.join(', ')})`);
  ok(!offered.includes(keys.theirs), "and NEVER another project's — the save and the DB would refuse it");
  ok(!offered.includes('manager'), 'nor a manager persona (054, unchanged)');

  const disp = readFileSync('web/src/Dispatch.jsx', 'utf8');
  const setup = readFileSync('web/src/ProjectSetup.jsx', 'utf8');
  ok(/getHarnesses\(manager \? 'manager' : 'worker', projectId\)/.test(disp),
     'the dispatch composer asks for ITS PROJECT\'S list, so a foreign persona is never a button');
  ok(/getHarnesses\('worker', project\.id\)/.test(setup),
     "and so does the spawn template's default-harness picker");
  ok(/scope === 'project'/.test(disp) && /scope === 'project'/.test(setup),
     'and both mark a project-scoped persona as one');
} finally {
  await cleanup();
  await pool.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);

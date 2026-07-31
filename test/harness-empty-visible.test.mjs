// AN UNLOADED HARNESS MUST BE IMPOSSIBLE TO MISS.
//
// The fix that came before this one made a harness's folder resolve correctly and made a MISSING
// folder log a line. It did not make an EMPTY harness visible: refreshHarnesses ended with nothing
// to read at a glance, so a queenzee could boot looking perfectly healthy while every file-backed
// harness was blank; and in the console a harness carrying nothing rendered identically to one
// carrying a 12.9k manual — same list row, same picker segment, same honeycomb badge. That is how
// a whole fleet of manager zees ran with an empty persona and nobody could see it.
//
// So there are two halves here, and this test covers both against the REAL code:
//   1. BOOT LINE — refreshHarnesses() ends with one summary: N loaded, M EMPTY, which keys, and how
//      many LIVE xells are wearing an empty one. Loud (stderr) when M > 0, always logged.
//   2. CONSOLE — the state is a WORD, never a shade: the harness manager list + editor banner, the
//      dispatch picker (where a human CHOOSES what a zee wears), and the canvas badge/manager
//      hexagon all say "empty" / "no files". Rendered for real (esbuild + react-dom/server), and
//      the canvas half is the REAL exported function, not a re-typed copy.
// Throwaway rows in the real meta DB, torn down in a finally.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const { q, one, pool } = await import('../server/src/db/pool.js');
const { recentLogs } = await import('../server/src/lib/logbus.js');
const H = await import('../server/src/lib/harness.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
// Since migration 080 there is ONE way a harness can be empty: its row says nothing. (There used to
// be a second — a file-backed harness whose folder was unreadable — and this test carried a "ghost"
// fixture for it. No folder is a source any more, so that state cannot exist and its fixture is gone.)
const hollowKey = `zt-hollow-${tag}`;    // nothing in the bundle → bundle_empty
const fullKey = `zt-full-${tag}`;        // a real persona, for the contrast
const KEYS = [hollowKey, fullKey];
const PID = `00000000-0000-4000-8000-0000000eb${tag.slice(0, 3)}`.slice(0, 36);
let projId = null, xellId = null;

try {
  // ── fixtures: an empty harness and a full one, and a live xell WEARING the empty one ────────
  const hollow = await one(
    `INSERT INTO harness (key,label,bundle,enabled,is_law_core) VALUES ($1,$2,'{}'::jsonb,true,false) RETURNING id`,
    [hollowKey, `Hollow ${tag}`]);
  await q(`INSERT INTO harness (key,label,bundle,enabled,is_law_core) VALUES ($1,$2,$3::jsonb,true,false)`,
    [fullKey, `Full ${tag}`, JSON.stringify({ personality: 'a real persona', skills: [{ name: 's', when: 'w', body: 'b' }] })]);

  projId = (await one(`INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`,
    [`zt-hev-${tag}`, `/tmp/zt-hev-${tag}`])).id;
  const xource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [projId]);
  xellId = (await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, harness_id)
       VALUES ($1,$2,$3,'spinoff/hev','/tmp/hev','working',false,$4) RETURNING id`,
    [projId, xource.id, `hev-${tag}`, hollow.id])).id;

  // ── 1. the boot readiness line ──────────────────────────────────────────────────────────────
  console.log('\n── the boot ends with ONE line a human can read ──');
  const before = recentLogs(500).length;
  await H.logHarnessSummary();                // the real boot path (index.js calls exactly this)
  const lines = recentLogs(500).slice(before).filter((l) => l.scope === 'harness').map((l) => l.msg);
  const summary = lines.filter((m) => /^harnesses: /.test(m)).pop();
  ok(!!summary, `boot emits a summary line (${summary || 'NONE — the whole point'})`);
  ok(/\d+ loaded, \d+ EMPTY/.test(summary || ''), 'it counts both halves: N loaded, M EMPTY');
  ok((summary || '').includes(hollowKey), 'and NAMES the empty harness, so nobody has to go hunting');
  ok(/1 live xell\(s\) are wearing an EMPTY harness/.test(summary || ''),
     'and how many live xells are wearing one — the cost, not just the count');
  ok(!(summary || '').includes(fullKey), 'a healthy harness is not named in the empty list');

  const direct = await H.logHarnessSummary();  // callable on its own (a boot/health probe)
  ok(direct.empty >= 1 && direct.worn_empty >= 1 && Array.isArray(direct.empty_keys),
     `logHarnessSummary() returns the counts too (${direct.loaded} loaded, ${direct.empty} empty, ${direct.worn_empty} worn)`);

  // ── 2. the read models still carry the fields the console renders ───────────────────────────
  console.log('\n── the API fields the badge reads ──');
  const list = await H.listHarnesses();
  const byKey = Object.fromEntries(list.map((h) => [h.key, h]));
  ok(byKey[hollowKey]?.bundle_empty === true, 'a harness whose row says nothing: bundle_empty');
  ok(!('files_missing' in (byKey[hollowKey] || {})),
     'and the read model no longer reports files_missing at all — there is no folder to miss');
  ok(byKey[fullKey]?.bundle_empty === false, 'a harness with a persona is not flagged');

  // the honeycomb read model carries them too — that is where a xell SHOWS the harness it wears
  const { getTimeline } = await import('../server/src/lib/timeline.js');
  const tl = await getTimeline(projId).catch(() => null);
  const tlH = (tl?.harnesses || []).find((h) => h.key === hollowKey);
  ok(!!tlH && tlH.bundle_empty === true,
     'getTimeline() emits bundle_empty on the harness a xell wears (the badge reads this)');

  // ── 3. the console SAYS it, in words ────────────────────────────────────────────────────────
  console.log('\n── the harness manager: list row + editor banner ──');
  // compiled BESIDE its source, so the component's own relative imports ('./api.js', './hex.js')
  // still resolve — the same trick test/harness-manager-cell.test.mjs uses on this canvas module.
  const compiled = [];
  const compile = (rel, name) => {
    const file = join(ROOT, dirname(rel), `.${name}.test-build.mjs`);
    writeFileSync(file, transformSync(read(rel), { loader: 'jsx', format: 'esm', jsx: 'transform' }).code);
    compiled.push(file);
    return `file://${file}`;
  };
  // harnessHealth.js is plain JS and side-effect free — the ONE place the words live
  const { emptyWarning } = await import(`file://${join(ROOT, 'web/src/harnessHealth.js')}`);
  ok(emptyWarning({ bundle_empty: true }).chip === '⚠ empty', 'an empty bundle says "empty"');
  ok(emptyWarning({}) === null && emptyWarning(null) === null, 'a healthy harness gets no warning at all');

  // The REAL row + banner components, rendered with props (react-dom/server). Static reading
  // cannot tell whether a component SAYS anything — this reads the markup a human would see.
  const HM = await import(compile('web/src/HarnessManager.jsx', 'hm'));
  const row = (h) => renderToStaticMarkup(React.createElement(HM.HarnessRow, { h, onOpen: () => {} }));
  const hollowRow = row({ key: hollowKey, label: 'Hollow', skill_count: 0, bundle_empty: true });
  const fullRow = row({ key: fullKey, label: 'Full', skill_count: 1 });
  ok(hollowRow.includes('⚠ empty'), 'the list row for an empty harness SAYS "empty" — a word, not a shade');
  ok(!fullRow.includes('⚠'), 'a healthy harness carries no warning (it shows its skill count as before)');
  ok(fullRow.includes('1★'), 'and still shows what it does carry');
  ok(/title="[^"]*no personality[^"]*"/.test(hollowRow), 'the row explains itself on hover');
  ok(hollowRow.includes('hm-hollow') && hollowRow.includes(`data-testid="harness-empty-${hollowKey}"`),
     'with the class + testid the stylesheet and the console tests hang off');

  const banner = (h) => renderToStaticMarkup(React.createElement(HM.HarnessEmptyBanner, { h }));
  const hollowBanner = banner({ key: hollowKey, bundle_empty: true });
  ok(hollowBanner.includes('harness-empty-banner') && /carries nothing/.test(hollowBanner),
     'the EDITOR banner states it outright when you open that harness');
  ok(/meta-DB/.test(hollowBanner) && /right here/.test(hollowBanner),
     'and tells an operator where the text lives and that they can fill it in here');
  ok(banner({ key: fullKey }) === '', 'a healthy harness renders NO banner (no crying wolf)');

  // and the whole dialog still renders (a free identifier / bad hook would surface here)
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => [], text: async () => '[]' });
  let html;
  try { html = renderToStaticMarkup(React.createElement(HM.default, { onClose: () => {} })); }
  finally { globalThis.fetch = realFetch; }
  ok(html.includes('hm-list'), 'the harness manager dialog itself renders (no crash on first paint)');

  console.log('\n── the dispatch picker: where a human chooses what a zee will wear ──');
  const dispSrc = read('web/src/Dispatch.jsx');
  ok(/import \{ emptyWarning \} from '\.\/harnessHealth\.js'/.test(dispSrc),
     'Dispatch uses the SAME helper (one vocabulary across the console)');
  ok(/warn \? ` \$\{warn\.chip\}`/.test(dispSrc), 'an empty harness is labelled ⚠ in the picker itself');
  ok(/seg-hollow/.test(dispSrc), 'and marked on the segment');

  console.log('\n── the honeycomb: the badge and the manager hexagon ──');
  const hive = await import(compile('web/src/hive/HiveCanvas.jsx', 'hive'));
  ok(hive.harnessWarning({ bundle_empty: true }) === '⚠ empty' && hive.harnessWarning({}) === null,
     'the canvas exports the same verdict for the same field');
  // DRAW it for real against a recording 2D context and read back what was written. A regex over
  // the source cannot tell whether the branch is reachable; this runs the actual draw call.
  const recorder = () => {
    const texts = [];
    const ctx = new Proxy({ texts, canvas: { width: 800, height: 600 } }, {
      get(t, k) {
        if (k in t) return t[k];
        if (k === 'fillText' || k === 'strokeText') return (s) => { t.texts.push(String(s)); };
        if (k === 'measureText') return (s) => ({ width: String(s).length * 6 });
        if (k === 'createLinearGradient') return () => ({ addColorStop() {} });
        if (k === 'createRadialGradient') return () => ({ addColorStop() {} });
        return () => {};                       // every other canvas verb is a no-op here
      },
      set(t, k, v) { t[k] = v; return true; },
    });
    return ctx;
  };
  const drawnFor = (h) => {
    const ctx = recorder();
    hive.drawHarnessBadge(ctx, 100, 100, 60, { label: 'Ghost', wearer_ids: ['a', 'b'], ...h }, null, {});
    return ctx.texts.join(' | ');
  };
  ok(drawnFor({ bundle_empty: true }).includes('⚠ empty'),
     'the honeycomb BADGE writes "⚠ empty" where the ×N count goes');
  ok(drawnFor({ bundle_empty: true }).includes('×2'), 'without losing the wearer count — 2 zees are wearing this');
  ok(!drawnFor({}).includes('⚠') && drawnFor({}).includes('×2'), 'a healthy harness draws just its count, as before');

  const mgrCtx = recorder();
  hive.drawManagerHex(mgrCtx, { cx: 200, cy: 200, size: 70, x: { slug: 'mgr', status: 'working', zee_type: 'manager' } },
    { hover: false, dim: false, crew: [], harness: { label: 'Ghost', bundle_empty: true }, img: null });
  ok(mgrCtx.texts.join(' | ').includes('⚠ empty harness'),
     'and a MANAGER hexagon — which IS its persona — says it on the hexagon itself');

  console.log('\n── the stylesheet backs it, but never carries it alone ──');
  const css = read('web/src/styles.css');
  ok(/\.hm-warn\b/.test(css) && /\.hm-empty\b/.test(css) && /\.disp-seg\.seg-hollow/.test(css),
     'every class the components emit is actually styled');
  ok(/\.hm-item\.hm-hollow/.test(css), 'including the row tint');

  for (const f of compiled) rmSync(f, { force: true });
} finally {
  if (xellId) await q(`DELETE FROM xell WHERE id=$1`, [xellId]).catch(() => {});
  if (projId) await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  await q(`DELETE FROM harness WHERE key = ANY($1)`, [KEYS]).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

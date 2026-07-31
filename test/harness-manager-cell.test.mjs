// A MANAGER'S HARNESS TAKES NO CELL — the honeycomb says a thing once.
//
// A harness normally seats itself in the grid as its OWN hexagon cell (docs/harness-proposal.md §5)
// and every xell wearing it gets its wire routed through that cell. A MANAGER is the exception: its
// hexagon is ALREADY drawn in the harness badge's language (dashed seat + the same persona disc,
// drawManagerHex), so a cell beside it seats the identical avatar twice and spends a grid cell
// restating what the manager xell already says.
//
// The split that makes that true lives in getTimeline():
//     wearer_ids   — every xell WEARING the harness (managers included) → art, ×N, hover
//     consumer_ids — the wearers the BADGE is for (wearers minus managers) → the cell + the wire
// so a harness worn by managers ONLY is emitted with no consumers: no cell, no wire, but still in
// the payload, because the manager hexagon reads its art out of it.
//
// This runs the REAL read model against this xell's postgres (its own throwaway project + git repo)
// and the REAL HiveCanvas.jsx (esbuild-transformed, then imported) — no re-typed copies of either.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transformSync } from 'esbuild';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

const client = new pg.Client({ connectionString: url });
const tmp = mkdtempSync(join(tmpdir(), 'harncell-'));
const PID = '00000000-0000-4000-8000-0000000ce111';
const XID = '00000000-0000-4000-8000-0000000ce222';
const KEYS = ['zt-cell-mgr', 'zt-cell-worker', 'zt-cell-any'];

async function cleanup({ files = false } = {}) {
  try { await client.query(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* */ }
  try { await client.query(`DELETE FROM harness WHERE key = ANY($1)`, [KEYS]); } catch { /* */ }
  if (files) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } }
}

try {
  await client.connect();
  await cleanup();

  // ── a real repo: three commits on master, so the timeline has a trunk to anchor to ──
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  for (const n of [1, 2, 3]) {
    writeFileSync(join(repo, `f${n}.md`), `${n}\n`);
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', `c${n}`);
  }
  const tip = git(repo, 'rev-parse', 'HEAD');

  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,'harncell-test',$2,'master','harncell','postgres')`, [PID, repo]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [PID === XID ? PID : XID, PID]);

  // three harnesses: one per zee_type the 054 guard recognises
  const mkHarness = async (key, type) => (await client.query(
    `INSERT INTO harness (key, label, enabled, is_law_core, zee_type, head_commit)
       VALUES ($1,$2,true,false,$3,$4) RETURNING id`, [key, key, type, tip])).rows[0].id;
  const hMgr = await mkHarness('zt-cell-mgr', 'manager');
  const hWork = await mkHarness('zt-cell-worker', 'worker');
  const hAny = await mkHarness('zt-cell-any', 'any');

  const mkXell = async (slug, zeeType, harnessId) => (await client.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status, is_pooled, zee_type, harness_id, head_commit)
       VALUES ($1,$2,$3,$4,'working',false,$5,$6,$7) RETURNING id`,
    [PID, XID, slug, `spinoff/${slug}`, zeeType, harnessId, tip])).rows[0].id;

  const mgr = await mkXell('mgr-solo', 'manager', hMgr);      // wears a manager-ONLY harness
  const mgrAny = await mkXell('mgr-any', 'manager', hAny);    // wears a harness a worker also wears
  const w1 = await mkXell('w-one', 'worker', hWork);
  const w2 = await mkXell('w-two', 'worker', hWork);
  const wAny = await mkXell('w-any', 'worker', hAny);

  const { getTimeline } = await import('../server/src/lib/timeline.js');
  const t = await getTimeline(PID);
  const byId = Object.fromEntries((t.harnesses || []).map((h) => [h.id, h]));
  const ids = (a = []) => [...a].sort().join(',');

  console.log('\n── the manager-only harness: in the payload, but nothing to draw ──');
  ok(!!byId[hMgr], 'a manager-only harness is STILL emitted — the manager hexagon needs its art');
  ok(ids(byId[hMgr].wearer_ids) === ids([mgr]), 'the manager is listed as a WEARER of it');
  ok((byId[hMgr].consumer_ids || []).length === 0,
     'and as NO consumer — so it gets no cell and no wire (the manager xell already indicates it)');
  ok(byId[hMgr].avatar_url !== undefined && 'label' in byId[hMgr],
     'it still carries the art fields the manager hexagon draws from');

  console.log('\n── a worker harness is untouched: every wearer is a consumer ──');
  ok(ids(byId[hWork].wearer_ids) === ids([w1, w2]), 'both workers wear it');
  ok(ids(byId[hWork].consumer_ids) === ids([w1, w2]), 'both workers consume it — cell + two wires, as before');

  console.log('\n── a harness worn by BOTH: the badge is for the worker only ──');
  ok(ids(byId[hAny].wearer_ids) === ids([mgrAny, wAny]), 'wearer_ids holds the manager AND the worker');
  ok(ids(byId[hAny].consumer_ids) === ids([wAny]),
     'consumer_ids drops the manager — one wire to the worker, none doubling back to the persona');

  console.log('\n── the xells the timeline anchors carry their type, so the canvas can tell ──');
  const tx = Object.fromEntries((t.xells || []).map((x) => [x.id, x]));
  ok(tx[mgr]?.zee_type === 'manager' && tx[w1]?.zee_type === 'worker',
     'zee_type rides along on each anchored xell');

  // ── the canvas side: the REAL module's pure helpers ─────────────────────────
  console.log('\n── HiveCanvas: which harnesses earn a cell, and who wears one ──');
  const SRC = 'web/src/hive/HiveCanvas.jsx';
  const src = readFileSync(SRC, 'utf8');
  const tmpMod = 'web/src/hive/.harness-cell.test-build.mjs';
  writeFileSync(tmpMod, transformSync(src, { loader: 'jsx', format: 'esm' }).code);
  let mod;
  try { mod = await import('../' + tmpMod); } finally { rmSync(tmpMod, { force: true }); }
  const { wearersOf, badgedHarnesses } = mod;

  const drawn = badgedHarnesses(t.harnesses);
  ok(drawn.length === 2 && !drawn.some((h) => h.id === hMgr),
     'badgedHarnesses seats the worker + shared harnesses, and NOT the manager-only one');
  ok(wearersOf(byId[hMgr]).includes(mgr), 'wearersOf finds the manager — that is how its hexagon gets its avatar');
  ok(ids(wearersOf({ consumer_ids: ['a', 'b'] })) === 'a,b',
     'wearersOf falls back to consumer_ids, so an older payload still renders');
  ok(badgedHarnesses().length === 0 && wearersOf(null).length === 0, 'both tolerate nothing at all');

  console.log('\n── the wiring reads the right list ──');
  ok(/harnessOf = \(id\) => harnesses\.find\(\(h\) => wearersOf\(h\)\.includes\(id\)\)/.test(src),
     'the manager hexagon looks its harness up by WEARER (HiveCanvas)');
  ok(/for \(const h of badged\)/.test(src), 'only badged harnesses are seated in the grid (HiveCanvas)');
  const conn = readFileSync('web/src/Connectors.jsx', 'utf8');
  ok(/for \(const id of h\.consumer_ids \|\| \[\]\) consumerHarness\.set/.test(conn),
     'the series wire is routed for CONSUMERS only (Connectors) — a manager wire runs straight to its hex');
  ok(/hovHarness\?\.wearer_ids/.test(conn) && /wearer_ids/.test(readFileSync('web/src/GraphPane.jsx', 'utf8')),
     'hover still lights every WEARER, in both the wire overlay and the graph');
} catch (e) {
  console.error('\n✗ threw:', e?.stack || e?.message || e);
  fail++;
} finally {
  await cleanup({ files: true });
  try { await client.end(); } catch { /* */ }
  try { const { pool } = await import('../server/src/db/pool.js'); await pool.end(); } catch { /* */ }
}

console.log(fail ? `\n✗ ${fail} failure(s)` : '\n✓ a manager wears its harness without seating it');
process.exit(fail ? 1 : 0);

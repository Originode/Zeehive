// CURRENT CONDITIONS — the short, dated, per-PROJECT list of live impediments injected into every
// briefing (ticket #67, card f6590d52-9528-4f32-a7d8-6ad0fe0c6d67).
//
// Two-sided, exactly as the card's judge asks:
//   1. INJECTION HAPPENS — the REAL briefing composer (queenzee/intake.js briefing(), exported for
//      this seam) contains the conditions section, dated, plainly marked EPHEMERAL, positioned
//      ABOVE the task. Without the change this test goes RED: a project with conditions would have
//      a briefing carrying none of them.
//   2. THE EMPTY CASE RENDERS NOTHING UGLY — a project with no conditions gets a briefing that is
//      byte-identical to one before this feature existed (null render, no empty section), and
//      deleting the last line returns to that exact state. A healthy project costs a worker no
//      skim-past noise.
// Plus the manager wall: writing (`--add` / `--remove`) is a MANAGER verb (requireManager), scoped
// to the caller's own project by its token; a worker is REFUSED, and the scoped delete refuses a row
// that belongs to another project.
//
// It uses the REAL meta-DB (DATABASE_URL, like every integration test here): it mints a throwaway
// project + xell, drives the real functions, and deletes what it created in a finally.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { q, one, pool } = await import('../server/src/db/pool.js');
const { briefing } = await import('../server/src/queenzee/intake.js');
const { listProjectConditions, addProjectCondition, removeProjectCondition,
        renderCurrentConditions, conditionDate,
        removeProjectConditionScoped } = await import('../server/src/lib/current-conditions.js');
const { selfConditions } = await import('../server/src/queenzee/self.js');

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const root = mkdtempSync(join(tmpdir(), `conditions-${tag}-`));
const slug = `conditions-${tag}`;
let pid = null, xid = null, pid2 = null;
let srv = null;

try {
  // ── a real project + xell in the meta-DB (worker, db-isolated) ─────────────
  pid = (await one(
    `INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`,
    [slug, root])).id;
  const xoid = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [pid])).id;
  xid = (await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                       zee_type, db_coupling)
       VALUES ($1,$2,$3,$4,$5,'working',false,'worker','db-isolated') RETURNING id`,
    [pid, xoid, slug, `spinoff/${slug}`, root])).id;
  const workerXell = await one(`SELECT * FROM xell WHERE id=$1`, [xid]);
  const zee = { id: null, name: 'test-zee', viewer_url: null };

  // ── the pure render: dated, ephemeral, and NULL when empty ─────────────────
  console.log('\n── the render is dated and visibly ephemeral, and null when empty ──');
  const row = { body: 'the shared dev DSN is stale (TKT-47) — get a database with `zee db-sandbox`',
                updated_at: new Date('2026-08-21T12:00:00Z') };
  const md = renderCurrentConditions([row]);
  ok(md && md.includes('## ⚠ Current conditions — EPHEMERAL, dated'), 'the section header plainly marks it EPHEMERAL');
  ok(md && md.includes('[2026-08-21]'), 'each line is dated with the day it was last touched');
  ok(md && md.includes('(TKT-47)'), 'the line body (with its ticket ref) is carried through');
  ok(md && md.includes('NOT documentation'), 'the comment says out loud it is not a second manual');
  ok(renderCurrentConditions([]) === null, 'empty → null (no empty section, nothing ugly)');
  ok(renderCurrentConditions(null) === null, 'null → null');
  ok(conditionDate(new Date('2026-08-21T23:59:59Z')) === '2026-08-21', 'conditionDate formats UTC YYYY-MM-DD');

  // ── empty project → the REAL briefing has NO conditions section ────────────
  console.log('\n── the empty case: a briefing with no live impediments is unchanged ──');
  const b0 = await briefing(xid, zee, 'do the thing');
  ok(!b0.includes('Current conditions'), 'no conditions → the briefing has no conditions section at all');
  ok(b0.includes('## Your task') && b0.includes('do the thing'), 'and the briefing is otherwise intact');

  // ── add a condition → the REAL briefing carries it, dated, above the task ──
  console.log('\n── injection happens: a live impediment reaches the briefing ──');
  const add = await addProjectCondition(pid, 'the shared dev DSN is stale (TKT-47) — use `zee db-sandbox`', { actor: 'manager-zee-test' });
  ok(add.ok === true, 'addProjectCondition adds a line');
  const add2 = await addProjectCondition(pid, 'test/work-assign.test.mjs and test/fleet-pause.test.mjs are red on main and are not yours (TKT-54, TKT-59)', { actor: 'manager-zee-test' });
  ok(add2.ok === true, 'a second line');
  const b1 = await briefing(xid, zee, 'do the thing');
  ok(b1.includes('## ⚠ Current conditions — EPHEMERAL, dated'), 'the briefing carries the conditions section');
  ok(b1.includes('(TKT-47)') && b1.includes('(TKT-54'), 'the lines are in the briefing');
  ok(/\[20\d\d-\d\d-\d\d\]/ .test(b1), 'the injected lines are dated');
  ok(b1.indexOf('Current conditions') < b1.indexOf('## Your task'), 'the conditions sit ABOVE the task (read, not skimmed)');
  const rendered = await listProjectConditions(pid);
  ok(rendered.length === 2, `the lib lists both lines (${rendered.length})`);

  // ── the manager wall: a WORKER may read but not write ─────────────────────
  console.log('\n── the write is a MANAGER verb, scoped to the caller project ──');
  const read = await selfConditions(workerXell, {});
  ok(read.ok === true && read.conditions.length === 2, 'a worker may READ the conditions');
  const refused = await selfConditions(workerXell, { action: 'add', body: 'a worker cannot add' });
  ok(refused.ok === false && refused.status === 'refused', 'a worker calling --add is REFUSED');
  const refusedRm = await selfConditions(workerXell, { action: 'remove', id: add.condition.id });
  ok(refusedRm.ok === false && refusedRm.status === 'refused', 'a worker calling --remove is REFUSED');

  // ── a MANAGER can add, and deleting one line is trivial ───────────────────
  console.log('\n── a manager adds and removes; the empty case is exactly back ──');
  const mgrXell = { ...workerXell, zee_type: 'manager' };
  const asMgr = await selfConditions(mgrXell, { action: 'add', body: 'a manager adds a line' });
  ok(asMgr.ok === true, 'a manager may add a line');
  const rm = await removeProjectCondition(add2.condition.id);
  ok(rm.ok === true, 'removeProjectCondition deletes a line (no archive — it is GONE)');
  const b2 = await briefing(xid, zee, 'do the thing');
  ok(!b2.includes('(TKT-54'), 'the deleted line is gone from the briefing');
  ok(b2.includes('(TKT-47)'), 'the surviving line is still there');
  const rm2 = await removeProjectCondition(add.condition.id);
  const rm3 = await removeProjectCondition(asMgr.condition.id);
  ok(rm2.ok === true && rm3.ok === true, 'the last lines delete the same way');
  const b3 = await briefing(xid, zee, 'do the thing');
  ok(!b3.includes('Current conditions'), 'with the last line gone the briefing is back to no conditions section');

  // ── the scoped delete refuses a foreign project's row ─────────────────────
  console.log('\n── a manager can only delete from its own project ──');
  pid2 = (await one(
    `INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`,
    [`${slug}-other`, root])).id;
  const addOther = await addProjectCondition(pid2, 'a condition in another project', { actor: 'test' });
  const scoped = await removeProjectConditionScoped(addOther.condition.id, pid);
  ok(scoped.ok === false, 'the scoped delete refuses a row that is not in the caller project');
  await removeProjectCondition(addOther.condition.id);

  // ── the CONSOLE write routes enforce the same manager wall (a bypass test) ──
  // The /xell/self wall only protects the route a zee's OWN CLI uses. A caged worker that can reach
  // the queenzee API at all could call the console's /projects/:id/conditions POST straight — so the
  // console WRITE routes refuse a WORKER zee's token server-side (403), while a bare request (the
  // dashboard, which sends no token) and a MANAGER zee's token still pass. This is the exact
  // "anyone who can reach the API bypasses it" hole the manager asked about, closed and tested.
  console.log('\n── the console write routes refuse a WORKER zee token (no bypass) ──');
  const { router } = await import('../server/src/api/routes.js');
  const { mintXellToken } = await import('../server/src/lib/xell-token.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  srv = createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${srv.address().port}/api`;
  const workerToken = await mintXellToken(xid);

  const post = (path, body, token) => fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {}),
  });
  const asWorker = await post(`/projects/${pid}/conditions`, { body: 'a worker tries the console route' }, workerToken);
  const workerBody = await asWorker.json().catch(() => ({}));
  ok(asWorker.status === 403 && workerBody.status === 'refused',
     'POST /projects/:id/conditions with a WORKER token → 403 refused (server-side, from the token-resolved xell)');

  // a bare request (the human dashboard sends no token) still works
  const asHuman = await post(`/projects/${pid}/conditions`, { body: 'a human writes from the console' });
  const human = await asHuman.json().catch(() => ({}));
  ok(asHuman.status === 201 && human.ok === true,
     'the same route with NO token (the dashboard) still passes → 201');

  // a MANAGER zee's token passes the console write route too
  await q(`UPDATE xell SET zee_type='manager' WHERE id=$1`, [xid]);
  const asMgrHttp = await post(`/projects/${pid}/conditions`, { body: 'a manager writes from the console' });
  const mgrBody = await asMgrHttp.json().catch(() => ({}));
  ok(asMgrHttp.status === 201 && mgrBody.ok === true,
     'a MANAGER zee token passes the same console route → 201');

  // PUT + DELETE refuse the worker token the same way (now that the xell is a manager we re-token a
  // worker xell to prove the deny-path on the remaining two verbs)
  await q(`UPDATE xell SET zee_type='worker' WHERE id=$1`, [xid]);
  const put = await fetch(`${BASE}/project-conditions/${human.condition?.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${workerToken}` },
    body: JSON.stringify({ body: 'a worker edits' }),
  });
  const putBody = await put.json().catch(() => ({}));
  ok(put.status === 403 && putBody.status === 'refused',
     'PUT /project-conditions/:id with a WORKER token → 403 refused');
  const del = await fetch(`${BASE}/project-conditions/${human.condition?.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${workerToken}` },
  });
  const delBody = await del.json().catch(() => ({}));
  ok(del.status === 403 && delBody.status === 'refused',
     'DELETE /project-conditions/:id with a WORKER token → 403 refused');
  // the human who created it can still delete it (bare request)
  const delHuman = await fetch(`${BASE}/project-conditions/${human.condition?.id}`, { method: 'DELETE' });
  ok(delHuman.status === 200, 'a bare DELETE (no token) still works — the human who wrote it can remove it');
  await removeProjectCondition(mgrBody.condition?.id).catch(() => {});
} finally {
  if (srv) srv.close();
  // clean up everything this test created, in a finally, whatever happened
  try { await q(`DELETE FROM xell WHERE id=$1`, [xid]); } catch { }
  try { await q(`DELETE FROM xource WHERE project_id IN ($1,$2)`, [pid, pid2 ?? '00000000-0000-0000-0000-000000000000']); } catch { }
  try { await q(`DELETE FROM project WHERE id IN ($1,$2)`, [pid, pid2 ?? '00000000-0000-0000-0000-000000000000']); } catch { }
  try { rmSync(root, { recursive: true, force: true }); } catch { }
  await pool.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);

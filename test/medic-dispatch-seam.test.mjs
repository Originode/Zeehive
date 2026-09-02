// THE DISPATCH SEAM UNDER THE KNOB — what the ⛑ button creates (api/routes.js
// POST /project-conditions/:id/dispatch-medic; docs/medic-meta-plane-plan.md §6, DR-7; kit stage 4).
//
// The correction's cutover point is exactly one route: the same button, the same guards, but the
// condition's project's `medic_plane` knob (248) decides WHAT answers —
//
//   'meta' (default)  → a MEDIC ROW + a background in-process turn. Proven DYNAMICALLY here: the
//                       real route on a real ephemeral server creates a real medic row with the
//                       card verbatim in its brief, and NO xell/cage/worktree anywhere in the story
//                       (the response carries medic_id and plane:'meta', never a slug).
//   'manager-zee'     → the superseded stage-3 path (createManagerZee). Proven STATICALLY (the
//                       medic-bar-wiring discipline): invoking it for real spawns a provider zee,
//                       which no test may do — so the branch is asserted in the route source, and
//                       the knob's CHECK is asserted on the live schema (a typo cannot invent a
//                       third plane).
//
// MEDICRW_MODE=simulate: the medic's SQL surface is inert; the background turn errs on creds
// harmlessly (asserted: the medic row survives with a legal status — an errored first turn is a
// visible state, not a vanished medic).
//
// RUN:  DATABASE_URL=... node test/medic-dispatch-seam.test.mjs
process.env.QUEENZEE_INPROC = 'true';
process.env.MEDICRW_MODE = 'simulate';
process.env.SHIP_MODE = 'simulate';
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { q, one, pool } = await import('../server/src/db/pool.js');
const { randomUUID } = await import('node:crypto');
const express = (await import('express')).default;

const tag = randomUUID().slice(0, 8);
const clean = [];
const proj = await one(
  `INSERT INTO project (name, repo_root, main_branch, db_user, db_name, manifest)
     VALUES ($1,$2,'main','postgres','postgres','{}') RETURNING id, medic_plane`,
  [`seam-${tag}`, `/tmp/seam-${tag}`]);
clean.push(() => q(`DELETE FROM project WHERE id=$1`, [proj.id]));
const card = `PROVISION-INFRA: seam-${tag} cannot build on machine 'm-x' — shared-dev-db down.`;
const cond = await one(
  `INSERT INTO project_condition (project_id, body, created_by, updated_by)
     VALUES ($1,$2,'test','test') RETURNING id`, [proj.id, card]);
clean.push(() => q(`DELETE FROM project_condition WHERE id=$1`, [cond.id]));

const { router } = await import('../server/src/api/routes.js');
const app = express();
app.use(express.json());
app.use('/api', router);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
clean.push(async () => { await new Promise((r) => server.close(r)); });

try {
  console.log("\n── the knob itself ──");
  ok(proj.medic_plane === 'meta', `a fresh project defaults to the META plane [got '${proj.medic_plane}']`);
  const typo = await q(`UPDATE project SET medic_plane='xell' WHERE id=$1`, [proj.id]).then(() => null, (e) => e);
  ok(typo?.code === '23514', 'the CHECK refuses a third plane (a typo cannot re-cage the medic)');

  console.log("\n── 'meta' (default): the button creates a MEDIC, not a xell ──");
  const r = await fetch(`${base}/api/project-conditions/${cond.id}/dispatch-medic`, { method: 'POST' });
  const body = await r.json().catch(() => ({}));
  ok(r.status === 200 && body.ok === true, `the dispatch answers ok [${r.status} ${JSON.stringify(body).slice(0, 120)}]`);
  ok(body.plane === 'meta', `the receipt names the plane [got '${body.plane}']`);
  ok(!!body.medic_id, 'the receipt carries the medic id');
  ok(!body.slug, 'no slug: nothing xell-shaped was created for the medic itself');

  const medic = await one(`SELECT * FROM medic WHERE id=$1`, [body.medic_id]);
  clean.push(() => q(`DELETE FROM medic WHERE id=$1`, [body.medic_id]));
  ok(!!medic, 'the medic row exists');
  ok(medic?.target_project_id === proj.id, 'it targets the condition\'s project');
  ok(medic?.condition_id === cond.id, 'it remembers which condition dispatched it');
  ok((medic?.brief || '').includes(card), 'the brief quotes the card verbatim');
  ok(/meta_write|meta_select/.test(medic?.brief || ''), 'the brief speaks the MEDIC registry\'s language, not `zee infra`');

  // The background first turn (no provider account on this db) must leave a VISIBLE state, never a
  // vanished or half-created medic. Give it a beat.
  await new Promise((s) => setTimeout(s, 1200));
  const after = await one(`SELECT status FROM medic WHERE id=$1`, [body.medic_id]);
  ok(!!after, 'the medic row survives its first turn failing');
  ok(['diagnosing', 'acting', 'errored', 'awaiting-human'].includes(after?.status),
     `…in a legal, visible status [got '${after?.status}']`);
  const noXell = await one(`SELECT count(*)::int AS n FROM xell WHERE project_id=$1`, [proj.id]);
  ok(noXell.n === 0, 'and STILL no xell exists for this project — the medic was never caged');

  console.log("\n── 'manager-zee': the rollback branch exists at the seam (static) ──");
  const routes = readFileSync(resolve(here, '..', 'server/src/api/routes.js'), 'utf8');
  ok(/p\.medic_plane/.test(routes), 'the route reads the project\'s knob');
  ok(/medic_plane === 'manager-zee'[\s\S]{0,400}createManagerZee/.test(routes),
     "the 'manager-zee' value still routes to createManagerZee (the one-flip rollback)");
  ok(/dispatchMedic|medic-spawn\.js/.test(routes.slice(routes.indexOf('dispatch-medic'))),
     'the default path routes to the meta-plane driver');

  console.log(fail ? `\n${fail} FAILURE(S)` : '\nall good');
} finally {
  for (const fn of clean.reverse()) { try { await fn(); } catch { /* best effort */ } }
  await pool.end();
}
process.exit(fail ? 1 : 0);

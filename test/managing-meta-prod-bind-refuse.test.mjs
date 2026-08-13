// MANAGING-META PROD BIND REFUSAL — when a project's production database IS the managing
// instance's own meta-DB (ZEEHIVE self-hosting), a writable db-shared-prod bind is structurally
// unsafe: a nested queenzee handed that DSN would reconcile and reap live xells.
//
// Attach already refused (§6.2 / env-follows-binding.test.mjs). This test covers the two surfaces
// that used to leave a human with a BIND button that could not succeed:
//   1. `zee prod` (selfProdRequest) — refuse the ASK up front, name `zee seed` as the write path;
//   2. decideProdBind confirm — refuse BEFORE flipping status to 'confirmed', so a leftover pending
//      ask cannot half-settle.
//
// A project whose prod DSN is NOT the managing meta-DB still gets a normal pending request (the
// control case — the refusal is about identity, not "no prod ever").
//
// Everything it creates is torn down in a finally, whatever happens.
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.PROVISION_MODE = 'simulate';
process.env.TKB_NOTIFY = '0';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { q, one, pool } = await import('../server/src/db/pool.js');
const { config } = await import('../server/src/config.js');
const { projectProdIsManagingMeta, managingMetaWritableRefusal } =
  await import('../server/src/lib/xell-db.js');
const { selfProdRequest, decideProdBind } = await import('../server/src/queenzee/self.js');

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const root = mkdtempSync(join(tmpdir(), `meta-prod-${tag}-`));
let pid = null;

async function cleanup() {
  if (pid) {
    try { await q(`DELETE FROM project WHERE id=$1`, [pid]); } catch { /* */ }
  }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
}

try {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const wt = join(root, 'wt');
  mkdirSync(wt);

  const proj = await one(
    `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,$2,$3,'master','metatest','postgres') RETURNING *`,
    [randomUUID(), `meta-prod-${tag}`, repo]);
  pid = proj.id;
  const xource = await one(
    `INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master') RETURNING *`,
    [randomUUID(), pid]);
  await q(
    `INSERT INTO deploy_site (id, project_id, key, tier, is_default)
       VALUES ($1,$2,'local','prod',true)`, [randomUUID(), pid]);
  // Prod row points at the managing instance's own DATABASE_URL — the self-hosting shape.
  await q(
    `INSERT INTO container (project_id, role, tier, isolation, name, health, conn_ref)
       VALUES ($1,'db','prod','shared',$2,'up',$3)`,
    [pid, `meta_prod_${tag}`, config.databaseUrl]);

  const xell = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, db_coupling)
       VALUES ($1,$2,$3,$4,$5,'working',false,'db-shared-dev') RETURNING *`,
    [pid, xource.id, `worker-${tag}`, `spinoff/worker-${tag}`, wt]);

  // ── helper recognises the meta identity ────────────────────────────────────────────────────
  console.log('projectProdIsManagingMeta detects the managing meta-DB');
  const meta = await projectProdIsManagingMeta(pid);
  ok(meta.isMeta === true, `isMeta=true when prod conn_ref is the managing DATABASE_URL`);
  ok(/zee seed/.test(managingMetaWritableRefusal(xell.slug, meta.dsn)),
     'the shared refusal sentence names zee seed');

  // ── zee prod refuses the ask; no pending row ───────────────────────────────────────────────
  console.log('selfProdRequest refuses before writing a pending row');
  const asked = await selfProdRequest(xell, { reason: 'need to fix a row in prod' });
  ok(asked.ok === false && asked.status === 'refused',
     `zee prod is refused (ok=${asked.ok}, status=${asked.status})`);
  ok(/REFUSING to bind/.test(asked.error || ''),
     `error carries the §6.2 refusal [${(asked.error || '').slice(0, 80)}]`);
  ok(/zee seed/.test(asked.error || ''),
     'and names zee seed as the write path');
  const pending = await one(
    `SELECT id FROM prod_bind_request WHERE xell_id=$1 AND status='pending'`, [xell.id]);
  ok(!pending, 'no pending prod_bind_request was created');

  // ── leftover pending: confirm is refused WITHOUT flipping status ───────────────────────────
  console.log('decideProdBind confirm refuses without half-confirming a leftover ask');
  const leftover = await one(
    `INSERT INTO prod_bind_request (project_id, xell_id, reason, status)
       VALUES ($1,$2,'leftover from before the early-refuse',$3) RETURNING *`,
    [pid, xell.id, 'pending']);
  let confirmErr = null;
  try { await decideProdBind(leftover.id, 'confirmed', 'test@console'); }
  catch (e) { confirmErr = e.message; }
  ok(/REFUSING to bind/.test(confirmErr || ''),
     `confirm throws the same refusal [${(confirmErr || 'no error').slice(0, 80)}]`);
  const still = await one(`SELECT status FROM prod_bind_request WHERE id=$1`, [leftover.id]);
  ok(still.status === 'pending',
     `request stays pending (not half-confirmed) — status=${still.status}`);
  // Reject still works so a human can clear the leftover.
  const rejected = await decideProdBind(leftover.id, 'rejected', 'test@console');
  ok(rejected.status === 'rejected', 'Reject still settles the leftover ask');

  // ── control: a project whose prod is NOT the meta-DB still accepts the ask ─────────────────
  console.log('control: ordinary project still accepts a prod-bind request');
  const otherProd = `postgresql://zeehive@other_prod_${tag}:5432/otherdb`;
  await q(`UPDATE container SET conn_ref=$2 WHERE project_id=$1 AND role='db' AND tier='prod'`,
          [pid, otherProd]);
  const notMeta = await projectProdIsManagingMeta(pid);
  ok(notMeta.isMeta === false, 'isMeta=false when prod DSN is a different database');
  const xell2 = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, db_coupling)
       VALUES ($1,$2,$3,$4,$5,'working',false,'db-shared-dev') RETURNING *`,
    [pid, xource.id, `worker2-${tag}`, `spinoff/worker2-${tag}`, join(root, 'wt2')]);
  mkdirSync(join(root, 'wt2'));
  const normal = await selfProdRequest(xell2, { reason: 'ordinary prod data work' });
  ok(normal.ok === true && normal.request?.status === 'pending',
     `ordinary project still gets a pending request (ok=${normal.ok}, status=${normal.request?.status})`);

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} catch (e) {
  console.error('FATAL', e);
  fail++;
} finally {
  await cleanup();
  await pool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
}

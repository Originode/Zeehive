// DB INSTANCES — the databases INSIDE a db container, first-class (db_instance, migration 019).
//
// One postgres container holds many databases: the PRIMARY (the project's application db), the
// clone TEMPLATE (<db>_zeehive_tpl), and a CLONE per schema-work xell. This module is the one
// place that reads/writes those rows, plus DISCOVERY: pg_database is the ground truth, and the
// table must follow it — a clone whose xell is gone but whose DROP failed must show up as an
// orphan on the books, not vanish into "the container looks fine".
//
// Deliberately a LEAF module (imports only pool/events/logbus), so xell-db, provision, proddiff,
// shipmigrate and intake can all use it without an import cycle.
import { spawn } from 'node:child_process';
import { q, one } from '../db/pool.js';
import { broadcast } from './events.js';
import { logline } from './logbus.js';

// Async psql against a database inside a container. Defaults to the `postgres` maintenance db —
// the only safe place to issue CREATE/DROP DATABASE from. Never rejects: resolves {ok,out,err}.
export function execPsql(ctx, container, user, sql, { db = 'postgres', timeout = 60000 } = {}) {
  return new Promise((res) => {
    let out = '', err = '', child;
    const args = ['--context', ctx, 'exec', '-i', container, 'psql', '-U', user, '-d', db,
      '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql];
    try { child = spawn('docker', args, { windowsHide: true }); }
    catch (e) { return res({ ok: false, out: '', err: String(e?.message || e) }); }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeout);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(t); res({ ok: false, out, err: String(e?.message || e) }); });
    child.on('close', (code) => { clearTimeout(t); res({ ok: code === 0, out, err }); });
  });
}

// The xell's OWN database instance (its clone), or null. The one lookup everything that used to
// read xell.clone_db_name goes through now.
export async function cloneInstanceFor(xellId) {
  return one(`SELECT * FROM db_instance WHERE owner_xell_id=$1 AND kind='clone' LIMIT 1`, [xellId]);
}

export async function templateInstanceFor(containerId) {
  return one(`SELECT * FROM db_instance WHERE container_id=$1 AND kind='template' LIMIT 1`, [containerId]);
}

export async function upsertInstance({ containerId, name, kind, ownerXellId = null, refreshed = false }) {
  const row = await one(
    `INSERT INTO db_instance (container_id, name, kind, owner_xell_id, refreshed_at, last_seen_at)
     VALUES ($1,$2,$3,$4, CASE WHEN $5 THEN now() END, now())
     ON CONFLICT (container_id, name) DO UPDATE
       SET kind=EXCLUDED.kind, owner_xell_id=EXCLUDED.owner_xell_id, last_seen_at=now(),
           refreshed_at=CASE WHEN $5 THEN now() ELSE db_instance.refreshed_at END
     RETURNING *`,
    [containerId, name, kind, ownerXellId, !!refreshed]);
  if (row) broadcast('db_instance', row);
  return row;
}

export async function deleteInstance(containerId, name) {
  const row = await one(
    `DELETE FROM db_instance WHERE container_id=$1 AND name=$2 RETURNING *`, [containerId, name]);
  if (row) broadcast('db_instance', { ...row, deleted: true });
  return row;
}

export async function setInstanceProdDiff(id, payload) {
  const row = await one(
    `UPDATE db_instance SET prod_diff=$2::jsonb, prod_diff_at=now() WHERE id=$1 RETURNING *`,
    [id, JSON.stringify(payload)]);
  if (row) broadcast('db_instance', row);
  return row;
}

// Postgres' own bookkeeping — never application databases.
const SYSTEM_DBS = new Set(['postgres', 'template0', 'template1']);

// What kind is a datname we have no row for? Naming is the only signal discovery has.
function inferKind(name, dbid) {
  if (name === dbid.name) return 'primary';
  if (name === `${dbid.name}_zeehive_tpl`) return 'template';
  if (name.startsWith('zee_')) return 'clone';
  return 'other';
}

// DISCOVERY: reconcile db_instance with what pg_database actually reports for one container.
// Upserts what exists (stamping last_seen_at), deletes rows whose database is gone, and names
// orphaned clones out loud. `real` is the RESOLVED container name (caller resolves; this module
// stays leaf and cannot import resolveRealDbContainer).
export async function syncDbInstances(container, real, dbid) {
  const r = await execPsql(container.docker_ctx, real, dbid.user,
    `SELECT datname FROM pg_database WHERE NOT datistemplate`);
  if (!r.ok) return { ok: false, error: r.err.trim().split('\n').pop()?.slice(0, 160) };

  const live = new Set(r.out.split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((n) => !SYSTEM_DBS.has(n)));
  const rows = await q(`SELECT * FROM db_instance WHERE container_id=$1`, [container.id]);
  const known = new Map(rows.map((x) => [x.name, x]));

  for (const name of live) {
    const had = known.get(name);
    if (had) {
      await q(`UPDATE db_instance SET last_seen_at=now() WHERE id=$1`, [had.id]);
      if (had.kind === 'clone' && !had.owner_xell_id) {
        logline('db-instance', `ORPHAN clone database ${name} in ${container.name} — its xell is `
          + 'gone but the database survived (a drop failed?). It costs disk until someone drops it.');
      }
      continue;
    }
    const kind = inferKind(name, dbid);
    await upsertInstance({ containerId: container.id, name, kind });
    logline('db-instance', `discovered ${kind} database ${name} in ${container.name}`
      + (kind === 'clone' ? ' (no owning xell on record — orphan?)' : ''));
  }
  for (const [name, row] of known) {
    if (live.has(name)) continue;
    await deleteInstance(container.id, name);
    logline('db-instance', `database ${name} is GONE from ${container.name} — dropped its `
      + `${row.kind} instance row`);
  }
  return { ok: true, live: live.size };
}

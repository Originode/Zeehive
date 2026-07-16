// BIND A XELL TO THE PRODUCTION STACK — prod's db + server + webapp become its assigned containers.
//
// WHY THIS EXISTS: a data xell (the DTR CSV import) had verified, correct SQL and could not run it,
// because it was dispatched db-shared-dev and the prod guard — correctly — denied it. The fix was
// "re-dispatch it", i.e. throw the xell away and start over. This re-points a LIVE xell instead.
//
// WHAT IT DOES NOT DO, and this is the point:
//
//   PROD DATA IS NOT PROD CODE. This grants the prod DATABASE (via attachXellDb, so the guard's
//   answer changes the same way it does at dispatch) and it points the xell's app tier AT prod so
//   it stops running a dev pair nobody looks at. It does NOT grant exec into prod's server or
//   webapp: hooks/prod-guard.mjs allows exec/cp against the xell's DB container only, and asking
//   for the app tier here does not change that answer. The xell can SEE prod's app; it cannot
//   reach inside it. Deploying code stays the ship gate's job — see 010_ship_gate.sql.
//
// Nothing here is reversible by the queenzee: a write to the prod DB is a write to the real thing.
// The gate is a human typing the skill, and prod writes remain prompt-gated (HANDOFF: "Hotfix /
// data-manipulation xells").
import { q, one } from '../db/pool.js';
import { broadcast } from '../lib/events.js';
import { logline } from '../lib/logbus.js';
import { attachXellDb, resolveRealDbContainer } from './xell-db.js';

const APP_ROLES = ['server', 'webapp'];

async function ctx(xellId) {
  const xell = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
  if (!xell) throw new Error('unknown xell');
  if (xell.is_production) throw new Error('production is already production');
  if (xell.status === 'retired') throw new Error(`${xell.slug} is retired`);
  const project = await one(`SELECT * FROM project WHERE id=$1`, [xell.project_id]);
  return { xell, project };
}

const sharedByRole = (projectId, role, tier) => one(
  `SELECT * FROM container WHERE project_id=$1 AND role=$2 AND tier=$3 AND isolation='shared' LIMIT 1`,
  [projectId, role, tier]);

// Re-point ONE role's link. The xell's own per-xell containers are unlinked but NOT torn down:
// they still carry owner_xell_id, so the reaper collects them at teardown exactly as it would have.
// Destroying a running container as a side effect of a binding change is not this function's call.
async function relink(xellId, role, target) {
  await q(
    `DELETE FROM xell_uses_container uc USING container c
      WHERE uc.container_id=c.id AND uc.xell_id=$1 AND c.role=$2`, [xellId, role]);
  await q(
    `INSERT INTO xell_uses_container (xell_id, container_id, relation) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`,
    [xellId, target.id, target.owner_xell_id === xellId ? 'owns' : 'uses']);
}

export async function attachProdStack(xellId, { by = 'human@console' } = {}) {
  const { xell, project } = await ctx(xellId);

  // The DB goes through attachXellDb rather than a hand-rolled UPDATE: it is what sets
  // db_coupling AND the link together, and dbAccessForCwd() reads BOTH (coupling='db-shared-prod'
  // AND the linked db being tier='prod'). Setting one without the other yields a xell the guard
  // denies while the card claims it has prod — the exact "instructions that cannot work" trap
  // HANDOFF warns about for `--db prod`.
  const db = await attachXellDb(xellId, { coupling: 'db-shared-prod' });

  // RESOLVE THE REAL CONTAINER, do not hand out the inventory name. The inventory says
  // `omnibiz_db_prod`; the live database is `omnibiz_db_prod_v184`, and `omnibiz_db_prod` is an
  // EXITED husk from before that migration, still sitting on the pre-v184 volume. Handing a zee
  // `docker exec -i omnibiz_db_prod psql` is either a confusing error (it is stopped) or — if
  // anyone ever starts it — a silent write to the WRONG database. resolveRealDbContainer picks the
  // running versioned one; proddiff.js already does this, the zee-facing binding did not.
  const dbRow = await one(
    `SELECT c.name, c.docker_ctx, c.conn_ref FROM container c
       JOIN xell_uses_container uc ON uc.container_id=c.id
      WHERE uc.xell_id=$1 AND c.role='db' LIMIT 1`, [xellId]);
  const realDb = dbRow ? resolveRealDbContainer(dbRow.docker_ctx, dbRow.name) : null;
  const psql = dbRow
    ? (dbRow.conn_ref
      ? `psql "${dbRow.conn_ref}"`
      : `docker --context ${dbRow.docker_ctx} exec -i ${realDb} psql -U postgres -d omnibiz`)
    : null;

  const app = [];
  for (const role of APP_ROLES) {
    const target = await sharedByRole(project.id, role, 'prod');
    if (!target) { app.push({ role, error: `no shared prod ${role} container in the inventory` }); continue; }
    await relink(xellId, role, target);
    app.push({ role, container: target.name });
  }

  const row = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
  broadcast('xell', { id: xellId });
  logline('xell-db',
    `⚠ ${xell.slug} BOUND TO PRODUCTION by ${by} — db ${realDb || db?.container || '?'} (LIVE DATA), `
    + `app tier ${app.map((a) => a.container || `${a.role}:none`).join(' + ')}. `
    + 'Exec is still DB-only; deploys are still the ship gate\'s.');

  return {
    ok: true, xell: row.slug, db_coupling: row.db_coupling,
    db: realDb || db?.container || null, psql, app,
    warning: 'The prod DATABASE is now this xell\'s. Writes are real and irreversible, and are '
      + 'prompt-gated only — state what you will change and get a human to agree BEFORE any write.',
    still_denied: [
      'exec into prod server/webapp (the guard allows exec against your DB container only)',
      'prod code deploys — compose build/up/prodsrc (that is the ship gate: scripts/xell-ship.mjs)',
      'restart of anything, including your own db (that is ops, not data work)',
    ],
  };
}

// The way back. A xell left bound to prod is a loaded gun in the pool: it looks like every other
// card, and its next zee inherits prod write access it never asked for.
export async function detachProdStack(xellId, { by = 'human@console' } = {}) {
  const { xell, project } = await ctx(xellId);
  const db = await attachXellDb(xellId, { coupling: 'db-shared-dev' });

  const app = [];
  for (const role of APP_ROLES) {
    // Prefer the xell's OWN container if it still exists (unlinking never destroyed it); otherwise
    // fall back to the shared dev one so the xell is never left with no app tier at all.
    const own = await one(
      `SELECT * FROM container WHERE project_id=$1 AND role=$2 AND owner_xell_id=$3 LIMIT 1`,
      [project.id, role, xellId]);
    const target = own || await sharedByRole(project.id, role, 'dev');
    if (!target) { app.push({ role, error: `no dev ${role} container to fall back to` }); continue; }
    await relink(xellId, role, target);
    app.push({ role, container: target.name });
  }

  broadcast('xell', { id: xellId });
  logline('xell-db', `${xell.slug} released from production by ${by} → db-shared-dev`);
  return { ok: true, xell: xell.slug, db_coupling: 'db-shared-dev', db: db?.container?.name || null, app };
}

export async function prodStackStatus(xellId) {
  const { xell } = await ctx(xellId);
  const cs = await q(
    `SELECT c.role, c.name, c.tier FROM xell_uses_container uc JOIN container c ON c.id=uc.container_id
      WHERE uc.xell_id=$1 ORDER BY c.role`, [xellId]);
  return {
    xell: xell.slug,
    db_coupling: xell.db_coupling,
    on_prod: xell.db_coupling === 'db-shared-prod',
    containers: cs.map((c) => ({ role: c.role, name: c.name, tier: c.tier })),
  };
}

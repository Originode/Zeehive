import pg from 'pg';
import { readFileSync } from 'node:fs';
import { ROW_COUNT_SQL, parseRowCounts, rowTotal } from './server/src/lib/row-counts.js';
const url = readFileSync('.zeehive.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL=')).slice(13).trim();
const c = new pg.Client({connectionString:url}); await c.connect();
const est = parseRowCounts((await c.query(ROW_COUNT_SQL)).rows.map(r=>Object.values(r)[0]).join('\n'));
const proj = (await c.query(`select id from project where name='Zeehive'`)).rows[0].id;
// MY OWN db container, registered in MY OWN throwaway meta-db so the real server can exercise the
// real path against the real database I own.
await c.query(`DELETE FROM container WHERE name='zeehive_db_spin_swift-summit-de17ba'`);
const cont = (await c.query(
  `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, health)
   VALUES ($1,'db','spinoff','shared','zeehive_db_spin_swift-summit-de17ba','default','up') RETURNING id`, [proj])).rows[0].id;
const snap = (await c.query(
  `INSERT INTO db_snapshot (project_id, source, dump_path, status, mode, taken_at, size_bytes, row_counts, row_total)
   VALUES ($1,'prod','/tmp/e2e.dump','finished','real', now() - interval '1 hour', 1454701, $2::jsonb, $3) RETURNING id`,
  [proj, JSON.stringify(est), rowTotal(est)])).rows[0].id;
await c.query(`UPDATE container SET restored_from=$2, restored_at=now() WHERE id=$1`, [cont, snap]);
console.log(JSON.stringify({ container: cont, snapshot: snap, recorded_tables: Object.keys(est).length, recorded_total: rowTotal(est) }));
await c.end();

import pg from 'pg';
import { readFileSync } from 'node:fs';
const url = readFileSync('.zeehive.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL=')).slice(13).trim();
const c = new pg.Client({connectionString:url}); await c.connect();
const snap='eb5dfa48-b8ef-4105-a6a4-d731e490201b';
// Pretend the SOURCE dump held far more rows than this database now has: zee_message emptied,
// land_request badly short. This is what a restore that silently dropped data looks like.
await c.query(`UPDATE db_snapshot SET row_counts = row_counts
   || jsonb_build_object('public.zee_message', 400, 'public.land_request', 5000, 'public.gone_table', 12)
  WHERE id=$1`, [snap]);
await c.query(`UPDATE db_snapshot SET row_counts = jsonb_set(row_counts,'{public.zee_message}','400') WHERE id=$1`,[snap]);
await c.end(); console.log('reference doctored: zee_message 400 (db has ~346), land_request 5000, gone_table 12 (absent)');

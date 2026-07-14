// Shared pg connection pool + a tiny query helper.
import pg from 'pg';
import { config } from '../config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export async function q(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

export async function one(text, params) {
  const rows = await q(text, params);
  return rows[0] || null;
}

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[pg] idle client error', err.message);
});

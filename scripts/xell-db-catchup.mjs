// The SANCTIONED way to roll a xell's OWN database FORWARD to prod's current schema (host-side twin
// of the cxell's `zee db-catchup`).
//
//   xell-db-catchup.mjs <xell_id> [--restore]
//
// Applies the migrations PROD has run (its zeehive_migrations ledger) that this xell's own db
// (db-clone or db-isolated) does not yet reflect, in filename order, each in its own transaction,
// ledgered in the database itself. This closes the gap `xell-db-migrate.mjs` cannot: that baselines
// at the branch fork point, so a db-isolated restored from a STALE prod dump keeps every migration
// prod shipped since. Reads prod READ-ONLY; never writes prod.
//
// --restore (db-isolated only) rebuilds the db from the latest FULL prod snapshot instead of rolling
// migrations forward — exact schema AND data, but it DISCARDS the db's current contents.
//
// Refused on the shared dev database (schema FROZEN) and on prod (it IS prod). Exit 0 = caught up
// (or nothing to do) · 1 = a migration failed or the request was refused.
import http from 'node:http';

const api = process.env.ZEEHIVE_API || 'http://localhost:4700';
const argv = process.argv.slice(2);
const xellId = argv.find((a) => !a.startsWith('--'));
const restore = argv.includes('--restore');

if (!xellId) { console.log('usage: xell-db-catchup.mjs <xell_id> [--restore]'); process.exit(0); }

const body = JSON.stringify({ restore });
const req = http.request(`${api}/api/xells/${xellId}/db/catchup`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
}, (res) => {
  let b = '';
  res.on('data', (c) => (b += c));
  res.on('end', () => {
    let r; try { r = JSON.parse(b); } catch { console.log(`bad response: ${b.slice(0, 300)}`); process.exit(1); }
    if (r.ok === false || r.error) {
      console.log(`✗ ${r.error || 'catch-up failed'}`);
      if (r.applied?.length) console.log(`  (applied before the failure: ${r.applied.join(', ')})`);
      if (r.recommend_restore) console.log('  → rebuild from the latest full prod snapshot: add --restore');
      process.exit(1);
    }
    if (r.restored) {
      console.log(`✓ re-restored ${r.database || 'the isolated db'} from ${r.restored_from || 'the latest prod snapshot'}`
        + (r.residual_missing === 0 ? ' — 0 schema drift from prod.' : r.residual_missing != null ? ` — ${r.residual_missing} object(s) still differ.` : '.'));
      console.log('  The container was re-provisioned — rebuild the app tier to pick up the new DATABASE_URL.');
      process.exit(0);
    }
    if (!r.applied?.length) {
      console.log(`✓ nothing to catch up — ${r.database} already reflects every migration prod has run.`);
    } else {
      console.log(`✓ caught ${r.database} up to prod — applied ${r.applied.length} migration(s) (baseline: ${r.baseline}):`);
      for (const f of r.applied) console.log(`    ${f}`);
      if (r.residual_missing === 0) console.log('  Schema now matches prod (0 drift).');
      else if (r.residual_missing > 0) console.log(`  ⚠ ${r.residual_missing} object(s) still differ from prod`
        + (r.recommend_restore ? ' — try --restore.' : '.'));
      console.log('  Now apply your OWN branch migrations on top (xell-db-migrate.mjs), then re-verify.');
    }
    process.exit(0);
  });
});
req.on('error', (e) => { console.log(`queenzee API unreachable at ${api}: ${e.message}`); process.exit(1); });
req.write(body);
req.end();

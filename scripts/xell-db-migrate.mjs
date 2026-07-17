// The SANCTIONED way for a zee to apply its migration files to its OWN database.
//
//   xell-db-migrate.mjs <xell_id>
//
// Applies every pending server/sql/migrations/*.sql + server/sql/ops/*.sql at YOUR branch's
// current HEAD to YOUR database (db-clone or db-isolated), in filename order, each file in its
// own transaction, ledgered in the database itself (zeehive_migrations). These are the SAME
// files the queenzee applies to prod when your ship is approved — so a clean run here is the
// deploy tested, and the /ooney schema gate will read your drift as "explained by pending
// migrations" instead of denying.
//
// Refused on the shared dev database (its schema is FROZEN — ad-hoc DDL there trips every other
// xell's ship gate) and on prod (migrations reach prod only through an approved ship).
// Exit 0 = applied clean (or nothing pending) · 1 = a migration failed or was refused.
import http from 'node:http';

const api = process.env.ZEEHIVE_API || 'http://localhost:4700';
const [xellId] = process.argv.slice(2).filter((a) => !a.startsWith('--'));

if (!xellId) { console.log('usage: xell-db-migrate.mjs <xell_id>'); process.exit(0); }

const req = http.request(`${api}/api/xells/${xellId}/db/migrate`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 0 },
}, (res) => {
  let b = '';
  res.on('data', (c) => (b += c));
  res.on('end', () => {
    let r; try { r = JSON.parse(b); } catch { console.log(`bad response: ${b.slice(0, 300)}`); process.exit(1); }
    if (r.ok === false || r.error) {
      console.log(`✗ ${r.error || 'migration run failed'}`);
      if (r.applied?.length) console.log(`  (applied before the failure: ${r.applied.join(', ')})`);
      process.exit(1);
    }
    if (!r.applied?.length) {
      console.log(`✓ nothing pending — ${r.database} already reflects every migration file on your branch.`);
    } else {
      console.log(`✓ applied ${r.applied.length} migration(s) to ${r.database}:`);
      for (const f of r.applied) console.log(`    ${f}`);
      console.log('  Re-verify your change against the migrated schema, then land + /ooney as usual —');
      console.log('  the same files ride your ship and are applied to prod before the containers build.');
    }
    process.exit(0);
  });
});
req.on('error', (e) => { console.log(`queenzee API unreachable at ${api}: ${e.message}`); process.exit(1); });
req.end();

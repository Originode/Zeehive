// The SANCTIONED (and only) way for a zee to get code into PRODUCTION.
//
//   xell-ship.mjs <xell_id> [--reason "..."] [--wait[=secs]] [--status]
//
// You are ASKING, not deploying. What happens:
//   1. This raises a ship request. A HUMAN approves it in the ZEEHIVE console. Nothing you can do
//      speeds that up.
//   2. The QUEENZEE then takes the prod lock and runs the deploy itself, from the xource at main.
//      You never hold the lock and you never run a prod build — deliberately. A zee deploying by
//      hand ships a band-aid: live in prod, absent from main, silently reverted by the next
//      rebuild from main. So it must be main that ships.
//   3. --wait blocks until it is shipped/failed/rejected. Run it in the BACKGROUND: its exit is
//      your nudge (the harness re-invokes you when a background task finishes).
//
// A ship is REFUSED unless your work is already landed on main — land it first (that push is
// itself human-gated). If it refuses, that is the system working, not a bug to route around.
import http from 'node:http';

const api = process.env.ZEEHIVE_API || 'http://localhost:4700';
const args = process.argv.slice(2);
const waitArg = args.find((a) => a === '--wait' || a.startsWith('--wait='));
const waitSecs = waitArg?.includes('=') ? Number(waitArg.split('=')[1]) || 3600 : 3600;
const statusOnly = args.includes('--status');
const ri = args.indexOf('--reason');
const reason = ri >= 0 ? args[ri + 1] : null;
const xellId = args.find((a) => !a.startsWith('--') && a !== reason);

if (!xellId) {
  console.log('usage: xell-ship.mjs <xell_id> [--reason "what you are shipping"] [--wait[=secs]] [--status]');
  process.exit(0);
}

const req = (method, path, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request(`${api}${path}`, {
    method,
    headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
  }, (res) => {
    let b = ''; res.on('data', (c) => (b += c));
    res.on('end', () => { try { resolve({ code: res.statusCode, json: JSON.parse(b || '{}') }); } catch { resolve({ code: res.statusCode, json: {} }); } });
  });
  r.on('error', reject);
  if (data) r.write(data);
  r.end();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForShip() {
  const deadline = Date.now() + waitSecs * 1000;
  let last = '';
  while (Date.now() < deadline) {
    await sleep(4000);
    let s;
    try { s = await req('GET', `/api/ship/status?xell=${encodeURIComponent(xellId)}`); }
    catch (e) { console.log(`  (status unreadable: ${e.message}) — retrying`); continue; }
    if (s.code >= 400) { console.log(`  ✗ ${s.json?.error || 'no ship request'}`); process.exit(1); }

    const st = s.json.status;
    if (st !== last) { console.log(`  … ${st}`); last = st; }

    if (st === 'pending')  continue;                       // a human has not looked yet
    if (st === 'approved') continue;                       // approved; queenzee is taking the lock
    if (st === 'shipping') continue;                       // queenzee is building prod

    if (st === 'shipped') {
      console.log(`\n  ✓ SHIPPED to production: commit ${String(s.json.commit).slice(0, 8)} is live.`);
      console.log('    The queenzee built it from main and holds the prod lock; it auto-releases shortly.');
      console.log('    You do NOT need to release anything.');
      process.exit(0);
    }
    if (st === 'failed') {
      console.log(`\n  ✗ SHIP FAILED: ${s.json.error || 'see the queenzee terminal (▚_) on the dashboard'}`);
      process.exit(1);
    }
    if (st === 'rejected') {
      console.log(`\n  ✗ A human REJECTED this ship${s.json.decided_by ? ` (${s.json.decided_by})` : ''}. Do not re-request without talking to them.`);
      process.exit(1);
    }
  }
  console.log(`\n  ✗ TIMEOUT after ${waitSecs}s — still waiting on a human or the build.`);
  process.exit(1);
}

if (statusOnly) {
  const s = await req('GET', `/api/ship/status?xell=${encodeURIComponent(xellId)}`);
  console.log(s.code >= 400 ? (s.json?.error || 'no ship request') : JSON.stringify(s.json, null, 2));
  process.exit(0);
}

const r = await req('POST', '/api/ship/request', { xell_id: xellId, reason });
if (r.code >= 400) { console.log(`Ship request failed: ${r.json?.error || r.code}`); process.exit(1); }
if (r.json.ok === false) {
  console.log(`\n  ✗ SHIP REFUSED: ${r.json.reason}\n`);
  console.log('  This is the anti-band-aid rule: prod builds from main, so anything not landed');
  console.log('  would NOT be in the ship. Land your work first (a human approves that too).');
  process.exit(1);
}
console.log(`Ship request raised for commit ${String(r.json.request.commit).slice(0, 8)} — a human must approve it in the ZEEHIVE console.`);
if (r.json.note) console.log(`(${r.json.note})`);
if (waitArg) {
  console.log(`Waiting up to ${waitSecs}s. Tell your human it is waiting; nothing you do here speeds it up.`);
  waitForShip();
} else {
  console.log('Re-run with --wait (in the background) to be told when it lands, instead of polling by hand.');
}

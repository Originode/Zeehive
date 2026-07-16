// BIND THIS XELL TO PRODUCTION. `/xell-prod` is a slash command a HUMAN types, so it IS the
// confirmation — same reasoning as xell-done. There is no approval flow, deliberately: this grants
// prod DATA, which is already a human's call to make (`--db shared-prod` at dispatch does the same
// thing). It does NOT grant prod CODE.
//
//   node xell-prod.mjs             # bind THIS session's xell to prod's db + app tier
//   node xell-prod.mjs --status    # what is this xell bound to right now? changes nothing
//   node xell-prod.mjs --release   # give prod back — return to db-shared-dev
//   node xell-prod.mjs --xell <id> # target one explicitly (use this for anything experimental:
//                                  # House rule — never test against a live xell)
//
// After this, the prod DATABASE is this xell's assigned container and the guard stops denying it.
// Writes are REAL and IRREVERSIBLE, and are prompt-gated only: say exactly what you will change
// and get a human to agree BEFORE running it. Still denied, by design: exec into prod's server or
// webapp, prod code deploys (that is scripts/xell-ship.mjs), and restarting anything.
import http from 'node:http';

const api = process.env.ZEEHIVE_API || 'http://localhost:4700';
const sid = process.env.CLAUDE_CODE_SESSION_ID || '';
const argv = process.argv.slice(2);
const statusOnly = argv.includes('--status');
const release = argv.includes('--release');
const xi = argv.indexOf('--xell');
const explicit = xi >= 0 ? argv[xi + 1] : null;

const req = (method, p, obj) => new Promise((res, rej) => {
  const body = obj ? JSON.stringify(obj) : null;
  const r = http.request(`${api}${p}`, {
    method,
    headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
  }, (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res({ code: x.statusCode, body: b })); });
  r.on('error', rej); if (body) r.write(body); r.end();
});
const json = (r) => { try { return JSON.parse(r.body); } catch { return {}; } };

async function resolveXell() {
  if (explicit) return { id: explicit, slug: explicit };
  if (!sid) { console.log('No CLAUDE_CODE_SESSION_ID and no --xell — cannot tell which xell you mean.'); process.exit(1); }
  const st = await req('GET', `/api/xell/status?session_id=${encodeURIComponent(sid)}`);
  if (st.code >= 400) { console.log(`No xell for this session (HTTP ${st.code}).`); process.exit(1); }
  const s = json(st);
  const id = s.xell?.id || s.xell_id;
  if (!id) { console.log('Could not resolve this session\'s xell.'); process.exit(1); }
  return { id, slug: s.xell?.slug || s.slug || '?' };
}

const x = await resolveXell();

if (statusOnly) {
  const r = await req('GET', `/api/xells/${x.id}/prod-stack`);
  const s = json(r);
  if (r.code >= 400) { console.log(s.error || 'status failed'); process.exit(1); }
  console.log(`xell ${s.xell}: db_coupling=${s.db_coupling}${s.on_prod ? '  ⚠ ON PRODUCTION' : ''}`);
  for (const c of s.containers || []) console.log(`  ${c.role.padEnd(7)} ${c.name}  (${c.tier})`);
  process.exit(0);
}

if (release) {
  const r = await req('DELETE', `/api/xells/${x.id}/prod-stack`, {});
  const s = json(r);
  if (r.code >= 400) { console.log(s.error || 'release failed'); process.exit(1); }
  console.log(`\n  ✓ ${s.xell} released from production — back to ${s.db_coupling}.`);
  for (const a of s.app || []) console.log(`    ${a.role.padEnd(7)} ${a.container || a.error}`);
  process.exit(0);
}

const r = await req('POST', `/api/xells/${x.id}/prod-stack`, { by: 'human@/xell-prod' });
const s = json(r);
if (r.code >= 400) { console.log(`\n  ✗ ${s.error || 'failed'}\n`); process.exit(1); }

console.log(`\n  ⚠  ${s.xell} IS NOW BOUND TO PRODUCTION.\n`);
console.log(`  database : ${s.db}   ← LIVE PRODUCTION DATA. Writes are real and irreversible.`);
for (const a of s.app || []) console.log(`  ${a.role.padEnd(9)}: ${a.container || a.error}`);
if (s.psql) console.log(`\n  Run SQL with:\n    ${s.psql}`);
console.log('\n  Writes are PROMPT-GATED ONLY — there is no gate to catch you. Before any');
console.log('  INSERT/UPDATE/DELETE/migration: say exactly what it changes, how many rows, and');
console.log('  how to undo it. Then get a human to agree. Read freely.');
console.log('\n  Still denied (by design):');
for (const d of s.still_denied || []) console.log(`    • ${d}`);
console.log('\n  When the data work is done: node scripts/xell-prod.mjs --release');
console.log('  A xell left on prod is a loaded gun in the pool — its next zee inherits this.\n');

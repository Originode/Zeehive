// LANGFUSE REVEAL — one-time-token redemption + caged-zee + origin refusal (TKT-104 / TKT-108-E589).
//
// The defect: POST /api/langfuse/reveal returned the full Langfuse credential set (admin_password
// included) to ANY caller that could reach the API — no auth, no origin check. Found by the worker
// that closed TKT-95 (the /signin password disclosure); deliberately left as a separate surface.
// Verified against this branch before the fix (the same repro the ticket quotes):
//
//   POST /api/langfuse/reveal        → 200 { public_key, secret_key, admin_email, admin_password, … }
//   POST /api/langfuse/reveal (cage) → 200 { …admin_password… }   ← isCagedZee alone is NOT enough
//
// The fix (this file fences it) applies the eb39e47 signin-token pattern to /reveal:
//   (1) a caged zee presenting its ZEEHIVE_XELL_TOKEN is refused (403) on both /langfuse/reveal and
//       the new /langfuse/reveal/redeem;
//   (2) /langfuse/reveal no longer returns the credential — it mints a ONE-TIME, short-TTL reveal
//       token (migration 144) and refuses (403) any caller that cannot present the console's own
//       origin (by hostname — the vite dev proxy rewrites Host to the API target, so the port
//       differs between dev and prod but the host never does);
//   (3) the credential leaves the server only on a same-origin redemption at /langfuse/reveal/redeem
//       that atomically claims the single-use token before its 60s TTL.
//
// House rule 1: everything created is cleaned up in a finally. The langfuse_config row and the
// throwaway project/xource/xell/token rows are snapshotted/restored exactly.
import http, { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import { q, one, pool } from '../server/src/db/pool.js';
import { hashToken } from '../server/src/lib/xell-token.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// ── fixture state ────────────────────────────────────────────────────────────
const _beforeConfig = await one(`SELECT * FROM langfuse_config WHERE id=true`).catch(() => null);
// throwaway rows this test creates, deleted in the finally
let _projId = null, _xourceId = null, _xellId = null;
const ADMIN_EMAIL = 'admin@test.local';
const ADMIN_PASSWORD = 'ZeeSUPERSECRET!';
const SECRET_KEY = 'sk-lf-tkt104';

// fake Langfuse so probeLangfuse() answers 'up' (a READ the module deliberately never mode-gates)
const fake = createServer((req, res) => {
  if (req.url.startsWith('/api/public/health')) { res.writeHead(200); res.end('{"ok":true}'); }
  else { res.writeHead(404); res.end('nope'); }
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const FAKE_PORT = fake.address().port;
const FAKE_BASE = `http://127.0.0.1:${FAKE_PORT}`;

try {
  await q(`DELETE FROM langfuse_signin_token`);   // clean slate — a fresh table, only ours
  await q(`UPDATE langfuse_config SET enabled=true, status='up', base_url=$1, ui_url=$2,
             client_base_url=$1, admin_email=$3, admin_password=$4,
             public_key='pk-lf-tkt104', secret_key=$5,
             public_key_hint='pk-…tkt104', secret_key_hint='sk-…tkt104' WHERE id=true`,
    [FAKE_BASE, `http://localhost:${FAKE_PORT}`, ADMIN_EMAIL, ADMIN_PASSWORD, SECRET_KEY]);

  // ── A. the HTTP route: unauthenticated + caged-zee POSTs refused ──────────
  console.log('\n── A. HTTP route: unauthenticated + caged-zee POSTs refused, no credential ──');
  const { router } = await import('../server/src/api/routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const API = `http://127.0.0.1:${server.address().port}`;
  const CONSOLE_ORIGIN = API;   // in this harness the browser-facing base == the request Host

  // a throwaway xell with a REAL self-token, so the route's isCagedZee() resolves it.
  // The worktree_path and project name are unique per run: this test runs against the shared dev DB,
  // where a FIXED path/name collides with a concurrent run (duplicate key on xell_worktree_path_key).
  const TAG = randomBytes(4).toString('hex');
  const TOKEN = `tkt104-${randomBytes(24).toString('hex')}`;
  _projId = randomUUID();
  _xourceId = randomUUID();
  _xellId = randomUUID();
  await q(`INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
             VALUES ($1,$2,'/tmp/nonexistent','master','lf-reveal','postgres')`, [_projId, `langfuse-reveal-token-${TAG}`]);
  await q(`INSERT INTO xource (id, project_id, ref) VALUES ($1, $2, 'master')`, [_xourceId, _projId]);
  await q(`INSERT INTO xell (id, project_id, xource_id, slug, branch, worktree_path, status, is_pooled, self_token_hash)
             VALUES ($1, $2, $3, 'tkt104-zee', 'spinoff/tkt104', $4, 'working', false, $5)`,
    [_xellId, _projId, _xourceId, `/tmp/tkt104-${TAG}`, hashToken(TOKEN)]);

  // THE DEFECT (pre-fix): an unauthenticated POST returned the full credential in ONE request.
  // Post-fix it must be refused outright — the mint itself requires the console origin.
  const unauth = await fetch(`${API}/api/langfuse/reveal`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by: 'repro' }),
  });
  ok(unauth.status === 403, `unauthenticated POST /langfuse/reveal is refused (got ${unauth.status})`);
  const unauthBody = await unauth.json();
  ok(!('admin_password' in unauthBody) && !('secret_key' in unauthBody) && !('public_key' in unauthBody),
     '…and the response body carries NO Langfuse credential');

  const caged = await fetch(`${API}/api/langfuse/reveal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ by: 'caged' }),
  });
  ok(caged.status === 403, `a caged zee presenting its token is refused (got ${caged.status})`);

  const wrongOrigin = await fetch(`${API}/api/langfuse/reveal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify({ by: 'evil' }),
  });
  ok(wrongOrigin.status === 403, 'a caller with a foreign Origin is refused');

  // ── B. console flow: mint (token only) then redeem (credential once) ──────
  console.log('\n── B. console reveal flow: one-time token, no credential until redemption ──');
  const mint = await fetch(`${API}/api/langfuse/reveal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: CONSOLE_ORIGIN },
    body: JSON.stringify({ by: 'human@console' }),
  });
  ok(mint.status === 200, `the console (matching Origin) can mint a reveal token (got ${mint.status})`);
  const minted = await mint.json();
  ok(minted.ok === true && typeof minted.token === 'string' && minted.token.length >= 32,
     '…the mint returns a long one-time token');
  ok(!('admin_password' in minted) && !('secret_key' in minted) && !('public_key' in minted),
     '…and NO credential field is in the mint response');
  ok(typeof minted.redeem === 'string' && minted.redeem.includes('/api/langfuse/reveal/redeem'),
     '…and a redemption URL is included');

  // On pre-fix code this never runs: the mint returned the credential directly (no redeem URL),
  // which the assertions above already failed. The guard keeps a pre-fix run a clean assertion
  // failure instead of a TypeError on `fetch(undefined)`.
  if (!minted.redeem) {
    ok(false, 'pre-fix: no redemption URL — the credential was returned directly by the mint');
  } else {
  // The shared dev DB is written by sibling xells' tests (they re-provision langfuse_config
  // mid-run) and the redeem reads that row, so re-assert OUR fixture config before each attempt.
  // The fence assertions above (403s, no credential in the mint) never depend on the config; this
  // retry only keeps the POSITIVE "credential comes back on redemption" check honest under that
  // contention. On a fresh/uncontended DB the first attempt always succeeds.
  const provision = () => q(`UPDATE langfuse_config SET enabled=true, status='up', base_url=$1, ui_url=$2,
             client_base_url=$1, admin_email=$3, admin_password=$4,
             public_key='pk-lf-tkt104', secret_key=$5,
             public_key_hint='pk-…tkt104', secret_key_hint='sk-…tkt104' WHERE id=true`,
    [FAKE_BASE, `http://localhost:${FAKE_PORT}`, ADMIN_EMAIL, ADMIN_PASSWORD, SECRET_KEY]);

  let reveal = null;
  let revealToken = minted.token;
  for (let attempt = 1; attempt <= 3 && !reveal; attempt++) {
    await provision();
    const m = await fetch(`${API}/api/langfuse/reveal`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: CONSOLE_ORIGIN },
      body: JSON.stringify({ by: 'human@console' }),
    });
    const mm = await m.json();
    if (!(mm.ok && mm.token && mm.redeem)) continue;
    revealToken = mm.token;
    const r = await fetch(mm.redeem, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: CONSOLE_ORIGIN },
      body: JSON.stringify({ token: mm.token }),
    });
    if (r.status === 200) reveal = await r.json();
  }
  ok(!!reveal, 'the console flow (mint with the console origin → redeem) returns the credential');
  if (reveal) {
    // Assert the SECURITY property (a non-empty credential came back on redemption) rather than
    // this run's exact fixture values, which a sibling may have swapped mid-run.
    ok(reveal.ok === true && typeof reveal.admin_email === 'string' && reveal.admin_email.length > 0
       && typeof reveal.admin_password === 'string' && reveal.admin_password.length > 0,
       '…admin email + password are returned on redemption');
    ok(typeof reveal.secret_key === 'string' && reveal.secret_key.length > 0
       && typeof reveal.public_key === 'string' && reveal.public_key.length > 0,
       '…and the trace keys are returned too');

    const again = await fetch(minted.redeem, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: CONSOLE_ORIGIN },
      body: JSON.stringify({ token: revealToken }),
    });
    ok(again.status === 400, `the SAME token cannot be redeemed twice (got ${again.status})`);
  }

  // wrong-origin redemption refused (a fresh token, minted by the console)
  const mint2 = await (await fetch(`${API}/api/langfuse/reveal`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: CONSOLE_ORIGIN },
    body: JSON.stringify({ by: 'human@console' }),
  })).json();
  const wrongRedeem = await fetch(minted.redeem, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify({ token: mint2.token }),
  });
  ok(wrongRedeem.status === 403, 'a redemption from a foreign Origin is refused');

  // caged zee refused on the redemption endpoint too
  const cagedRedeem = await fetch(minted.redeem, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: CONSOLE_ORIGIN, authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ token: mint2.token }),
  });
  ok(cagedRedeem.status === 403, 'a caged zee is refused on the redemption endpoint too');

  // expired token refused even though it was never used
  const expMint = await (await fetch(`${API}/api/langfuse/reveal`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: CONSOLE_ORIGIN },
    body: JSON.stringify({ by: 'human@console' }),
  })).json();
  await q(`UPDATE langfuse_signin_token SET expires_at = now() - interval '1 second'
            WHERE token_hash = $1`, [hashToken(expMint.token)]);
  const expRedeem = await fetch(minted.redeem, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: CONSOLE_ORIGIN },
    body: JSON.stringify({ token: expMint.token }),
  });
  ok(expRedeem.status === 400, 'an EXPIRED token is refused even though it was never used');

  } // end if (minted.redeem)

  server.close();
} finally {
  // ── restore everything the test created ───────────────────────────────────
  try {
    if (_xellId) await q(`DELETE FROM xell WHERE id=$1`, [_xellId]).catch(() => {});
    if (_xourceId) await q(`DELETE FROM xource WHERE id=$1`, [_xourceId]).catch(() => {});
    if (_projId) await q(`DELETE FROM project WHERE id=$1`, [_projId]).catch(() => {});
    await q(`DELETE FROM langfuse_signin_token`).catch(() => {});
    if (_beforeConfig) {
      const cols = Object.keys(_beforeConfig);
      const sets = cols.map((c, i) => `${c}=$${i + 1}`).join(', ');
      await q(`UPDATE langfuse_config SET ${sets} WHERE id=true`, cols.map((c) => _beforeConfig[c]));
    }
  } catch (e) { console.log('cleanup error:', e.message); }
  fake.close();
  await pool.end().catch(() => {});
}

console.log(fail ? `\n✗ ${fail} assertion(s) failed` : '\n✓ langfuse reveal one-time-token + origin + caged-zee refusal: all green');
process.exit(fail ? 1 : 0);

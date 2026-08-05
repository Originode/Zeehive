// LANGFUSE SIGNIN — one-time-token flow + caged-zee refusal (TKT-95).
//
// The defect: GET /api/langfuse/signin returned the Langfuse ADMIN email+password in the redirect
// Location (and thus in the auto-login page's query string — browser history, proxy logs, referrer
// chain) to ANY caller that could reach the API, including a caged zee. Verified live from a cxell
// with no token (the ticket repro), reproduced here in-process before the fix:
//
//   REDIRECT: http://127.0.0.1:<port>/generated/zeehive-auto-login.html
//             ?email=admin%40test.local&password=ZeeSUPERSECRET!&callback=…
//
// The fix (this file fences it):
//   (1) the server mints a ONE-TIME, short-TTL signin token and the redirect carries ONLY the
//       token + a redemption URL — the credential never enters a URL, query string or Location
//       header;
//   (2) the route refuses a caged zee ($ZEEHIVE_XELL_TOKEN) — it is a human-console verb, not a
//       fleet verb — and so does the redemption endpoint;
//   (3) the auto-login page POSTs the token back to /api/langfuse/signin/redeem (a human-console
//       verb, same refusal, plus an Origin check against the Langfuse base_url) to obtain the
//       credential once; a token is single-use and expires after 60s.
//
// It also asserts the de691038 open-redirect guard is INTACT: `?next=//evil.com` still falls back
// to the ui_base, because the post-login callback is guarded by safeLangfuseCallback and stored
// WITH the token before the redirect is built.
//
// House rule 1: everything created is cleaned up in a finally. The langfuse_config row and the
// throwaway project/xource/xell/token rows are snapshotted/restored exactly.
import http, { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import { q, one, pool } from '../server/src/db/pool.js';
import { langfuseSigninPage, redeemLangfuseSigninToken, mintLangfuseSigninToken } from '../server/src/lib/langfuse.js';
import { hashToken } from '../server/src/lib/xell-token.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// ── fixture state ────────────────────────────────────────────────────────────
const _beforeConfig = await one(`SELECT * FROM langfuse_config WHERE id=true`).catch(() => null);
// throwaway rows this test creates, deleted in the finally
let _projId = null, _xourceId = null, _xellId = null;
const ADMIN_EMAIL = 'admin@test.local';
const ADMIN_PASSWORD = 'ZeeSUPERSECRET!';

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
             public_key='pk-lf-tkt95', secret_key='sk-lf-tkt95',
             public_key_hint='pk-…tkt95', secret_key_hint='sk-…tkt95' WHERE id=true`,
    [FAKE_BASE, `http://localhost:${FAKE_PORT}`, ADMIN_EMAIL, ADMIN_PASSWORD]);

  // ── A. the signin page mints a token, never the credential ────────────────
  console.log('\n── A. signin redirect carries only a one-time token (no credential) ──');
  const s = await langfuseSigninPage(null, { redeemBase: 'http://10.0.0.1:9999' });
  ok(s.ok === true, 'signin page resolves ok against the fake stack');
  ok(s.redirect?.startsWith(`${FAKE_BASE}/generated/zeehive-auto-login.html`),
     `redirect lands on the same-origin auto-login page (${s.redirect})`);
  ok(!/password=/.test(s.redirect), 'the redirect has NO password query param');
  ok(!/email=/.test(s.redirect), 'the redirect has NO email query param');
  ok(!s.redirect.includes(encodeURIComponent(ADMIN_PASSWORD)) && !s.redirect.includes(ADMIN_PASSWORD),
     'the admin password string appears nowhere in the redirect');
  ok(!s.redirect.includes(encodeURIComponent(ADMIN_EMAIL)),
     'the admin email appears nowhere in the redirect');
  ok(/token=[^&]+/.test(s.redirect) && /redeem=http%3A%2F%2F10\.0\.0\.1%3A9999%2Fapi%2Flangfuse%2Fsignin%2Fredeem/.test(s.redirect),
     'the redirect carries a token + the redemption URL');
  ok(typeof s.token === 'string' && s.token.length >= 32, 'the minted token is a long random string');

  // ── A2. redemption: single-use, then expired ──────────────────────────────
  console.log('\n── A2. redemption is one-time and short-TTL ──');
  const r1 = await redeemLangfuseSigninToken(s.token);
  ok(r1.ok === true && r1.email === ADMIN_EMAIL && r1.password === ADMIN_PASSWORD,
     'redeeming the token returns the credential once');
  ok(r1.callback === `http://localhost:${FAKE_PORT}`,
     'the stored callback is the ui_base when no ?next= is given');
  const r2 = await redeemLangfuseSigninToken(s.token);
  ok(r2.ok === false, 'the SAME token cannot be redeemed twice (single-use)');
  const r3 = await redeemLangfuseSigninToken('not-a-real-token');
  ok(r3.ok === false, 'an unknown token is refused');
  const exp = await mintLangfuseSigninToken('http://localhost:1');
  await q(`UPDATE langfuse_signin_token SET expires_at = now() - interval '1 second'
            WHERE token_hash = $1`, [hashToken(exp)]);
  const r4 = await redeemLangfuseSigninToken(exp);
  ok(r4.ok === false, 'an EXPIRED token is refused even though it was never used');

  // ── B. the HTTP route: a human-console verb, not a fleet verb ─────────────
  console.log('\n── B. HTTP route: caged zee refused, console one-time-token flow works ──');
  const { router } = await import('../server/src/api/routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const API = `http://127.0.0.1:${server.address().port}`;

  // a throwaway xell with a REAL self-token, so the route's isCagedZee() resolves it
  const TOKEN = `tkt95-${randomBytes(24).toString('hex')}`;
  _projId = randomUUID();
  _xourceId = randomUUID();
  _xellId = randomUUID();
  await q(`INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
             VALUES ($1,'langfuse-signin-token-test','/tmp/nonexistent','master','lf-signin','postgres')`, [_projId]);
  await q(`INSERT INTO xource (id, project_id, ref) VALUES ($1, $2, 'master')`, [_xourceId, _projId]);
  await q(`INSERT INTO xell (id, project_id, xource_id, slug, branch, worktree_path, status, is_pooled, self_token_hash)
             VALUES ($1, $2, $3, 'tkt95-zee', 'spinoff/tkt95', '/tmp/tkt95-wt', 'working', false, $4)`,
    [_xellId, _projId, _xourceId, hashToken(TOKEN)]);

  const caged = await fetch(`${API}/api/langfuse/signin`, { headers: { authorization: `Bearer ${TOKEN}` }, redirect: 'manual' });
  ok(caged.status === 403, `a caged zee presenting its token is refused (got ${caged.status})`);
  const cagedBody = await caged.json();
  ok(/human-console verb/.test(cagedBody.error || ''), '…with a sentence, not a bare code');

  const consoleGet = await fetch(`${API}/api/langfuse/signin`, { redirect: 'manual' });
  ok(consoleGet.status === 302, `a console-style caller (no bearer token) is redirected (got ${consoleGet.status})`);
  const location = consoleGet.headers.get('location') || '';
  ok(!/password=/.test(location) && !location.includes(encodeURIComponent(ADMIN_PASSWORD)),
     'the Location header carries NO credential');
  const tokenMatch = /token=([^&]+)/.exec(location);
  ok(!!tokenMatch, 'the Location header carries the one-time token');
  const redeemMatch = /redeem=([^&]+)/.exec(location);
  ok(!!redeemMatch, 'the Location header carries the redemption URL');
  const redeemUrl = decodeURIComponent(redeemMatch[1]);

  // redemption with the Langfuse origin (what the auto-login page's fetch sends) → 200
  const goodRedeem = await fetch(`${API}${redeemUrl.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: FAKE_BASE },
    body: JSON.stringify({ token: tokenMatch[1] }),
  });
  ok(goodRedeem.status === 200, `redeeming with the Langfuse origin works (got ${goodRedeem.status})`);
  const redeemed = await goodRedeem.json();
  ok(redeemed.ok === true && redeemed.email === ADMIN_EMAIL && redeemed.password === ADMIN_PASSWORD,
     '…and returns the credential exactly once');

  // a second redemption of the SAME token via HTTP → 400
  const again = await fetch(`${API}${redeemUrl.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: FAKE_BASE },
    body: JSON.stringify({ token: tokenMatch[1] }),
  });
  ok(again.status === 400, `the same token cannot be redeemed twice over HTTP (got ${again.status})`);

  // redemption WITHOUT the Langfuse origin → refused
  const fresh = (await langfuseSigninPage(null, { redeemBase: API })).token;
  const noOrigin = await fetch(`${API}/api/langfuse/signin/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: fresh }),
  });
  ok(noOrigin.status === 403, 'a redemption without the Langfuse Origin header is refused');
  const wrongOrigin = await fetch(`${API}/api/langfuse/signin/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify({ token: fresh }),
  });
  ok(wrongOrigin.status === 403, 'a redemption from a foreign Origin is refused');

  // caged zee refused on the redemption endpoint too
  const cagedRedeem = await fetch(`${API}/api/langfuse/signin/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: FAKE_BASE, authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ token: fresh }),
  });
  ok(cagedRedeem.status === 403, 'a caged zee is refused on the redemption endpoint too');

  server.close();

  // ── C. the de691038 open-redirect guard is still intact ───────────────────
  console.log('\n── C. ?next= open-redirect guard preserved (de691038) ──');
  const evil = await langfuseSigninPage('//evil.com', { redeemBase: API });
  const evilToken = evil.token;
  const evilRedeem = await redeemLangfuseSigninToken(evilToken);
  ok(evilRedeem.ok === true && evilRedeem.callback === `http://localhost:${FAKE_PORT}`,
     'next=//evil.com falls back to the ui_base — never an off-origin callback');
  const goodNext = await langfuseSigninPage('/project/zeehive/sessions/abc', { redeemBase: API });
  const goodNextRedeem = await redeemLangfuseSigninToken(goodNext.token);
  ok(goodNextRedeem.callback === '/project/zeehive/sessions/abc',
     'a same-origin next path is honoured as the post-login callback');
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

console.log(fail ? `\n✗ ${fail} assertion(s) failed` : '\n✓ langfuse signin one-time-token + caged-zee refusal: all green');
process.exit(fail ? 1 : 0);

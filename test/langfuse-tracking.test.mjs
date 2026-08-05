// PER-XELL LANGFUSE TRACKING SWITCH (default ON) — a human (or a manager) can turn Langfuse
// tracking OFF for one xell. When OFF the queenzee records no trace for that xell's turns and
// injects no LANGFUSE_* env into its cage; the Langfuse plugin itself (provisioning, keys, project
// mapping) is untouched.
//
// This test guards the shape end to end, statically where the surface is source (the CLI, the
// console composer + terminal knob + flower) and against the real meta-DB where the surface is data
// (the per-xell flag, the trace skip, the env injection, the session-link builder, the manuals):
//   1. `setLangfuseTracking` sets/clears the per-xell flag on the xell row;
//   2. `postTurnToLangfuse` SKIPS when the flag is off (even with the plugin enabled) — and
//      attempts (today's behaviour) when on;
//   3. `langfuseClientEnv(projectId, { tracking:false })` injects NO LANGFUSE_* (the spawn guard);
//   4. `xellLangfuseSession` builds ui_url + Langfuse project + the zee's session id →
//      /project/<lfProjectId>/sessions/<id>, and refuses with a reason when the flag is off;
//   5. `dispatchXell` stores the param on the xell (explicit true/false lands; omission preserves);
//   6. the CLI advertises `--langfuse`/`--no-langfuse` on dispatch + assign and implements both;
//   7. the API routes pass langfuse_tracking through (/xell/self/dispatch, /xell/self/work/assign)
//      and expose the human knob route /xells/:id/langfuse-tracking + /xells/:id/langfuse-session;
//   8. the console: Dispatch.jsx sends the explicit boolean and renders the on/off toggle;
//      ZeeTerminal renders the ⚗ knob; HiveCanvas offers 'View Langfuse' only when the plugin is
//      enabled AND the flag is on; App.jsx opens the session via the auto-login signin popup;
//   9. the MANAGER manual documents `--langfuse`/`--no-langfuse` on dispatch/assign (the drift test
//      owns the CLI↔manual agreement; this asserts the flag is present).
//
// Everything it creates is torn down in a finally, whatever happens — and the langfuse_config row
// (enabled/keys) is restored to whatever it was before the test.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.TKB_NOTIFY = '0';              // no desk pings from a test

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const client = new pg.Client({ connectionString: url });
const PID = '00000000-0000-4000-8000-00000000e111';
const XID = '00000000-0000-4000-8000-00000000e222';
const XOURCE = '00000000-0000-4000-8000-00000000e333';
const ZID = '00000000-0000-4000-8000-00000000e444';
const SESSION = 'session-abc-123';
const UI_URL = 'http://localhost:3199';
const LF_PROJECT_ID = 'lf-proj-0001';

async function cleanup() {
  try { await client.query(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* */ }
  // xell/zee rows cascade from the project delete; langfuse_project_map cascades from project too.
}

// The langfuse_config row this test flips. Captured BEFORE the try (a const inside the try is out of
// scope in the finally — the restore would silently no-op) and restored there whatever happens.
let priorLf = null;

try {
  await client.connect();
  await cleanup();

  // ── enable the Langfuse plugin for this test, capturing the prior row for the finally ──
  priorLf = (await client.query(`SELECT * FROM langfuse_config WHERE id=true`)).rows[0] || null;
  await client.query(
    `UPDATE langfuse_config SET enabled=true, status='up', base_url='http://127.0.0.1:9',
            ui_url=$1, client_base_url=$1,
            public_key='pk-test', secret_key='sk-test',
            public_key_hint='pk-…test', secret_key_hint='sk-…test' WHERE id=true`, [UI_URL]);

  // ── the throwaway project + xource + xell + zee ──
  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,'langfuse-tracking-test','/tmp/nonexistent','master','lftest','postgres')`, [PID]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [XOURCE, PID]);
  await client.query(
    `INSERT INTO xell (id, project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                       langfuse_tracking)
       VALUES ($1,$2,$3,'lfy','spinoff/lfy','/tmp/lf-wt','working',false,true)`,
    [XID, PID, XOURCE]);
  await client.query(
    `INSERT INTO zee (id, xell_id, name, status, kind, attach_mode, entrypoint, claude_session_id)
       VALUES ($1,$2,'lfy-zee','working','headless','headless-spawn','cxell-cli',$3)`,
    [ZID, XID, SESSION]);
  // a 1:1 Langfuse project mapping, so the session link needs no live public-API call
  await client.query(
    `INSERT INTO langfuse_project_map
       (project_id, langfuse_project_id, langfuse_project_name, public_key, secret_key, public_key_hint, secret_key_hint)
       VALUES ($1,$2,'Langfuse Tracking Test','pk-map','sk-map','pk-…map','sk-…map')`,
    [PID, LF_PROJECT_ID]);

  const xellRow = async () => (await client.query(`SELECT * FROM xell WHERE id=$1`, [XID])).rows[0];

  const { setLangfuseTracking } = await import('../server/src/queenzee/self.js');
  const { postTurnToLangfuse, langfuseClientEnv, langfuseSessionUrl, xellLangfuseSession,
          safeLangfuseCallback } = await import('../server/src/lib/langfuse.js');
  const { dispatchXell } = await import('../server/src/queenzee/intake.js');
  const { streamXells } = await import('../server/src/lib/fleet.js');

  // The langfuse_config row is GLOBAL — other xells on this shared dev db may provision/tear it
  // down mid-test. Every ON-side assertion sets a sentinel config, runs the call, then re-checks
  // that the sentinel still holds: if a concurrent process reset the row, the assertion is SKIPPED
  // (the environment lied, not the code); if the sentinel holds and the result is wrong, it FAILS.
  const SENT_UI = 'http://localhost:3199';
  const setSentinel = async () => {
    await client.query(
      `UPDATE langfuse_config SET enabled=true, status='up', base_url='http://127.0.0.1:9',
              ui_url=$1, client_base_url=$1, public_key='pk-test', secret_key='sk-test',
              public_key_hint='pk-…test', secret_key_hint='sk-…test' WHERE id=true`, [SENT_UI]);
  };
  const sentinelHolds = async () => {
    const r = (await client.query(
      `SELECT enabled, ui_url, public_key FROM langfuse_config WHERE id=true`)).rows[0];
    return !!(r?.enabled && r?.ui_url === SENT_UI && r?.public_key === 'pk-test');
  };

  // ── 1. setLangfuseTracking sets/clears the per-xell flag ──
  console.log('\n── the per-xell flag ──');
  await setLangfuseTracking(XID, { langfuse_tracking: false });
  ok((await xellRow()).langfuse_tracking === false, 'setLangfuseTracking(false) clears the flag');
  await setLangfuseTracking(XID, { langfuse_tracking: true });
  ok((await xellRow()).langfuse_tracking === true, 'setLangfuseTracking(true) sets the flag');

  // ── 2. postTurnToLangfuse: skip when OFF, attempt when ON ──
  console.log('\n── the trace skip ──');
  const zeeObj = { id: ZID, name: 'lfy-zee', claude_session_id: SESSION };
  await setLangfuseTracking(XID, { langfuse_tracking: false });
  const skippedFull = await postTurnToLangfuse({
    xell: { id: XID, slug: 'lfy', project_id: PID, langfuse_tracking: false }, zee: zeeObj });
  ok(skippedFull.ok === false && skippedFull.skipped === 'langfuse-tracking-off',
     'postTurnToLangfuse skips (langfuse-tracking-off) when the xell flag is off, even with the plugin enabled');
  // the nudge.js call site passes a PARTIAL xell (no flag on the object) — the DB lookup must catch it
  const skippedPartial = await postTurnToLangfuse({
    xell: { id: XID, slug: 'lfy', project_id: PID }, zee: zeeObj });
  ok(skippedPartial.ok === false && skippedPartial.skipped === 'langfuse-tracking-off',
     '…and a partial xell (nudge.js shape) is caught by the DB lookup');
  // flag ON → today's behaviour: it ATTEMPTS the POST (best-effort; base_url is unreachable so it
  // fails, but it is NOT skipped for tracking) — proving the ON path is unchanged.
  await setLangfuseTracking(XID, { langfuse_tracking: true });
  const on = await postTurnToLangfuse({
    xell: { id: XID, slug: 'lfy', project_id: PID, langfuse_tracking: true }, zee: zeeObj });
  ok(on.skipped !== 'langfuse-tracking-off',
     'with the flag ON postTurnToLangfuse attempts the trace (not skipped for tracking)');

  // ── 3. langfuseClientEnv: no LANGFUSE_* when tracking off ──
  console.log('\n── the env injection guard ──');
  const envOff = await langfuseClientEnv(PID, { tracking: false });
  ok(Object.keys(envOff).length === 0,
     'langfuseClientEnv(projectId, { tracking:false }) injects NO LANGFUSE_* (the spawn guard)');
  await setSentinel();
  const envOn = await langfuseClientEnv(PID);
  if (await sentinelHolds()) {
    ok(envOn.LANGFUSE_PUBLIC_KEY === 'pk-map' && envOn.LANGFUSE_SECRET_KEY === 'sk-map'
       && !!envOn.LANGFUSE_BASE_URL,
       'langfuseClientEnv() with tracking ON + the plugin enabled injects the mapped project keys');
  } else {
    console.log('  (skip the ON env assertion — another xell reset the shared langfuse_config mid-test)');
  }

  // ── 4. the session-link builder ──
  console.log('\n── the link builder ──');
  ok(langfuseSessionUrl({ uiUrl: UI_URL, projectId: LF_PROJECT_ID, sessionId: SESSION })
       === `${UI_URL}/project/${LF_PROJECT_ID}/sessions/${SESSION}`,
     'langfuseSessionUrl builds ui_url + project + session → /project/<id>/sessions/<id>');
  ok(langfuseSessionUrl({ uiUrl: UI_URL, projectId: null, sessionId: SESSION }) === null
     && langfuseSessionUrl({ uiUrl: '', projectId: LF_PROJECT_ID, sessionId: SESSION }) === null,
     '…and refuses when a part is missing');
  await setSentinel();
  const link = await xellLangfuseSession({ xellId: XID, zeeId: ZID });
  if (await sentinelHolds()) {
    ok(link.ok === true && link.url === `${SENT_UI}/project/${LF_PROJECT_ID}/sessions/${SESSION}`,
       `xellLangfuseSession resolves the mapped project + the zee's session (${link.url})`);
    ok(link.session_id === SESSION && link.project_id === LF_PROJECT_ID, '…and stamps session + project');
    // no zeeId → the resolver falls back to the xell's latest zee (the route's self-sufficient shape)
    const linkNoZee = await xellLangfuseSession({ xellId: XID });
    ok(linkNoZee.ok === true && linkNoZee.url === `${SENT_UI}/project/${LF_PROJECT_ID}/sessions/${SESSION}`,
       '…and resolves the xell\'s latest zee when no zeeId is passed');
  } else {
    console.log('  (skip the ON link assertions — another xell reset the shared langfuse_config mid-test)');
  }
  await setLangfuseTracking(XID, { langfuse_tracking: false });
  const linkOff = await xellLangfuseSession({ xellId: XID, zeeId: ZID });
  ok(linkOff.ok === false && linkOff.reason === 'langfuse-tracking-off',
     'xellLangfuseSession refuses (langfuse-tracking-off) when the flag is off');
  await setLangfuseTracking(XID, { langfuse_tracking: true });

  // ── 5. dispatchXell stores the param on the xell ──
  console.log('\n── the dispatch param ──');
  await dispatchXell({
    xell_id: XID, project: PID, task: 'test dispatch', mode: 5, headless: true,
    langfuse_tracking: false, rename: false,
  }).catch(() => { /* the spawn will fail inside the cage — the param is stored BEFORE the spawn */ });
  ok((await xellRow()).langfuse_tracking === false, 'dispatchXell({langfuse_tracking:false}) clears the flag');
  await dispatchXell({
    xell_id: XID, project: PID, task: 'test dispatch', mode: 5, headless: true,
    langfuse_tracking: true, rename: false,
  }).catch(() => { /* same — the update happens first */ });
  ok((await xellRow()).langfuse_tracking === true, 'dispatchXell({langfuse_tracking:true}) sets the flag');
  // omission PRESERVES what the xell already has (a re-dispatch that says nothing changes nothing)
  await dispatchXell({
    xell_id: XID, project: PID, task: 'test dispatch', mode: 5, headless: true, rename: false,
  }).catch(() => { /* same — the update happens first */ });
  ok((await xellRow()).langfuse_tracking === true,
     'dispatchXell with NO langfuse_tracking param leaves the flag untouched (preserve on omission)');

  // ── 6. the CLI advertises and implements the flag ──
  console.log('\n── the CLI ──');
  const cli = read('scripts/zee');
  const usageBlock = cli.slice(cli.indexOf('function usage()'), cli.indexOf('switch (cmd)'));
  ok(/--langfuse\|--no-langfuse/.test(usageBlock.slice(usageBlock.indexOf('zee dispatch'))),
     'usage advertises --langfuse|--no-langfuse on dispatch');
  ok(/--langfuse\|--no-langfuse/.test(usageBlock.slice(usageBlock.indexOf('zee assign'))),
     'usage advertises --langfuse|--no-langfuse on assign');
  ok(/rest\.includes\('--no-langfuse'\)/.test(cli.slice(cli.indexOf("case 'dispatch'"), cli.indexOf("case 'dispatch'") + 1400))
     && /langfuse_tracking: false/.test(cli.slice(cli.indexOf("case 'dispatch'"), cli.indexOf("case 'dispatch'") + 1400)),
     'the dispatch case implements --no-langfuse');
  ok(/rest\.includes\('--no-langfuse'\)/.test(cli.slice(cli.indexOf("case 'assign'"), cli.indexOf("case 'assign'") + 1400))
     && /langfuse_tracking: false/.test(cli.slice(cli.indexOf("case 'assign'"), cli.indexOf("case 'assign'") + 1400)),
     'the assign case implements --no-langfuse');

  // ── 6b. the API routes pass langfuse_tracking through ──
  const routes = read('server/src/api/routes.js');
  ok(/selfDispatch\(x, req\.body/.test(routes),
     'POST /xell/self/dispatch passes the whole body (langfuse_tracking rides along)');
  const assignRoute = routes.slice(routes.indexOf("'/xell/self/work/assign'"),
    routes.indexOf("'/xell/self/work/assign'") + 500);
  ok(/langfuse_tracking: b\.langfuse_tracking/.test(assignRoute),
     'POST /xell/self/work/assign passes langfuse_tracking through');
  ok(/\/xells\/:id\/langfuse-tracking/.test(routes),
     'POST /xells/:id/langfuse-tracking (human knob) route exists');
  ok(/\/xells\/:id\/langfuse-session/.test(routes),
     'GET /xells/:id/langfuse-session (View Langfuse link) route exists');
  ok(/langfuseSigninPage\(req\.query\.next/.test(routes),
     'the /langfuse/signin route accepts ?next= (the post-login session callback)');

  // ── 7. the console ──
  console.log('\n── the console ──');
  const dispatch = read('web/src/Dispatch.jsx');
  ok(/langfuse_tracking: !!langfuseTracking/.test(dispatch),
     'Dispatch.jsx sends the EXPLICIT boolean — turning the toggle OFF clears a prior flag on re-dispatch');
  ok(/data-testid="dispatch-lf-on"/.test(dispatch) && /data-testid="dispatch-lf-off"/.test(dispatch),
     'the composer has the Langfuse tracking on/off toggle');
  const zt = read('web/src/ZeeTerminal.jsx');
  ok(/data-testid="langfuse-toggle"/.test(zt), 'ZeeTerminal renders the ⚗ Langfuse tracking knob in the header');
  ok(/setXellLangfuseTracking/.test(zt), '…and the knob calls the setter API');
  const hive = read('web/src/hive/HiveCanvas.jsx');
  ok(/x\.langfuse_enabled && x\.langfuse_tracking !== false/.test(hive),
     'HiveCanvas offers the langfuse verb when the plugin is enabled AND the flag is on');
  ok(/No Langfuse session recorded for this zee yet/.test(hive),
     '…a session-less zee still gets the verb, with a tooltip saying why (TKT-127 — not silently hidden)');
  ok(/⚗ View Langfuse/.test(hive), '…with the right-click menu label "⚗ View Langfuse"');
  const app = read('web/src/App.jsx');
  ok(/kind === 'langfuse'/.test(app), 'App.jsx handles the langfuse flower action');
  ok(/langfuse\/signin\?next=/.test(app),
     '…opening the session THROUGH the auto-login popup (no login page for the human)');

  // ── 7b. the signin popup's open-redirect guard ───────────────────────────────
  // `?next=` becomes the auto-login page's post-login location.href, and GET /api/langfuse/signin
  // is UNAUTHENTICATED, so a crafted link auto-signs a human in with the stored admin credentials
  // and then top-level-navigates them to an attacker's origin. The old startsWith('/') guard let
  // `//evil.com`, `///evil.com` and `/\evil.com` (a browser treats a backslash as a slash) through.
  console.log('\n── the signin open-redirect guard ──');
  ok(safeLangfuseCallback('/project/zeehive/sessions/abc', UI_URL) === '/project/zeehive/sessions/abc',
     'a plain in-origin path is accepted');
  for (const evil of ['//evil.com', '///evil.com', '/\\evil.com', 'http://evil.com',
                      `http://localhost:3199@evil.com`, `http://localhost:3199.evil.com`]) {
    ok(safeLangfuseCallback(evil, UI_URL) === null, `refuses ${JSON.stringify(evil)}`);
  }
  ok(safeLangfuseCallback(null, UI_URL) === null, 'no ?next= → falls back to uiBase');

  // ── 7c. the STREAMED fleet path carries langfuse_enabled ────────────────────
  // streamXells must decorate with the Langfuse plugin flag exactly like getFleet — the console's
  // gridXells prefers STREAMED rows, and without the flag every one renders langfuse_enabled=false
  // so the flower's "⚗ View Langfuse" verb never appears.
  console.log('\n── the fleet STREAMED path ──');
  await setSentinel();
  const streamed = [];
  await streamXells(PID, (x) => streamed.push(x));
  const streamedXell = streamed.find((x) => x.id === XID);
  ok(!!streamedXell, 'streamXells emits the fixture xell');
  if (streamedXell && await sentinelHolds()) {
    ok(streamedXell.langfuse_enabled === true,
       'the STREAMED xell carries langfuse_enabled=true (the console "⚗ View Langfuse" gate)');
  } else if (streamedXell) {
    console.log('  (skip the langfuse_enabled assertion — another xell reset the shared langfuse_config mid-test)');
  }

  // ── 8. the manuals (manager: --langfuse / --no-langfuse) ──
  console.log('\n── the manuals (via the meta-DB) ──');
  const mm = (await client.query(`SELECT harness_memory_get('manager','memory/manager-zee-manual.md') AS txt`)).rows[0].txt;
  ok(mm.includes('--no-langfuse') && mm.includes('--langfuse'), 'the manager manual documents --langfuse / --no-langfuse');
  ok(mm.includes('zee dispatch') && mm.includes('zee assign'), '…on both dispatch and assign');
} finally {
  // restore the langfuse_config row the test flipped
  try {
    if (priorLf) {
      await client.query(
        `UPDATE langfuse_config SET enabled=$1, status=$2, base_url=$3, ui_url=$4, client_base_url=$5,
                public_key=$6, secret_key=$7, public_key_hint=$8, secret_key_hint=$9 WHERE id=true`,
        [priorLf.enabled, priorLf.status, priorLf.base_url, priorLf.ui_url, priorLf.client_base_url,
         priorLf.public_key, priorLf.secret_key, priorLf.public_key_hint, priorLf.secret_key_hint]);
    }
  } catch { /* restore best-effort */ }
  await cleanup();
  await client.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);

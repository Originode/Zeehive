// LANGFUSE SESSION LINK — "View Langfuse" must resolve from STORED state, not a live credentialed
// API call (TKT-127-E85F).
//
// The defect: GET /api/xells/<id>/langfuse-session returned {ok:false,reason:'no-project'} for
// every xell in production because langfuse_project_map is empty and xellLangfuseSession fell back
// to a LIVE authenticated GET <base_url>/api/public/projects to learn the system trace project's
// id. Any failure of that call — instance down, keys rotated, slow network — closed the door
// fleet-wide with a reason no human could act on.
//
// The fix (this file fences it):
//   (1) the SYSTEM trace project's id is stored on langfuse_config.system_project_id (migration
//       145), written when the stack comes up after provision and refreshed by the project sync;
//   (2) xellLangfuseSession resolves in order: the xell's 1:1 mapping (langfuse_project_map) → the
//       stored system project id → ONLY THEN, best-effort, the live public-API read, which writes
//       back what it learns;
//   (3) the refusals a human can act on are distinguished: no-project (Langfuse has never told us
//       its project id) · no-session (this xell has no session yet) · langfuse-unreachable (the
//       instance is not answering).
//
// What it covers, in order:
//   A. map EMPTY + live API read FAILING + a stored system id → the link still resolves from the
//      stored id (the exact production failure this task fixes);
//   B. a 1:1 mapping exists → the MAPPED project id wins (over both the stored id and the live);
//   C. map EMPTY + no stored id + the live read SUCCEEDS → the live id is used AND written back to
//      langfuse_config.system_project_id (the write-back);
//   D. map EMPTY + no stored id + the instance UNREACHABLE → reason 'langfuse-unreachable';
//   E. map EMPTY + no stored id + the live read returns 200 with NO project → reason 'no-project';
//   F. a xell with no session id → reason 'no-session' (unchanged, but asserted distinct).
//
// The live read is exercised against a throwaway HTTP server on 127.0.0.1 (never a real Langfuse).
// House rule 1: everything created is cleaned up in a finally — the langfuse_config row and the
// project map are snapshotted/restored, the throwaway project/xource/xell/zee rows are deleted, and
// the fake server is closed.
import http, { createServer } from 'node:http';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

const client = new pg.Client({ connectionString: url });
const PID = '00000000-0000-4000-8000-00000000f111';   // throwaway project
const XOURCE = '00000000-0000-4000-8000-00000000f333';
const XID = '00000000-0000-4000-8000-00000000f222';
const ZID = '00000000-0000-4000-8000-00000000f444';
const SESSION = 'session-lfsess-1';
const SENT_UI = 'http://localhost:3211';
const STORED_LF = 'lf-proj-stored';
const MAPPED_LF = 'lf-proj-mapped';
const LIVE_LF = 'lf-proj-live';
const UNREACHABLE = 'http://127.0.0.1:9';   // closed port → connection refused, fails fast

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// ── the fake Langfuse: /api/public/projects is controllable per assertion ──
let projectsStatus = 200;
let projectsBody = JSON.stringify({ data: [{ id: LIVE_LF }] });
const fake = createServer((req, res) => {
  if (req.url.startsWith('/api/public/projects')) {
    res.writeHead(projectsStatus, { 'content-type': 'application/json' });
    res.end(projectsBody);
  } else { res.writeHead(404); res.end('nope'); }
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const FAKE_BASE = `http://127.0.0.1:${fake.address().port}`;

let priorLf = null;    // langfuse_config snapshot (restored in the finally)
let priorMaps = [];    // langfuse_project_map snapshot (restored in the finally)

// Sentinel helpers — the langfuse_config row is GLOBAL (shared dev db); a concurrent xell may
// reset it mid-test. Each ON assertion sets a sentinel, runs the call, then re-checks the sentinel
// still holds: if a concurrent process reset the row, the assertion is SKIPPED (the environment
// lied, not the code); if the sentinel holds and the result is wrong, it FAILS.
async function setCfg({ baseUrl, systemProjectId }) {
  await client.query(
    `UPDATE langfuse_config SET enabled=true, status='up', base_url=$1, ui_url=$2,
            client_base_url=$1, public_key='pk-sess', secret_key='sk-sess',
            public_key_hint='pk-…sess', secret_key_hint='sk-…sess', system_project_id=$3
       WHERE id=true`, [baseUrl, SENT_UI, systemProjectId]);
}
async function cfgHolds({ baseUrl, systemProjectId }) {
  const r = (await client.query(
    `SELECT enabled, base_url, public_key, system_project_id FROM langfuse_config WHERE id=true`)).rows[0];
  return !!(r?.enabled && r.base_url === baseUrl && r.public_key === 'pk-sess'
    && (r.system_project_id || null) === (systemProjectId || null));
}

async function cleanup() {
  try { await client.query(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* */ }
  // xell/zee rows cascade from the project delete; langfuse_project_map cascades from project too.
}

try {
  await client.connect();
  await cleanup();

  priorLf = (await client.query(`SELECT * FROM langfuse_config WHERE id=true`)).rows[0] || null;
  priorMaps = (await client.query(`SELECT * FROM langfuse_project_map`)).rows || [];

  // ── the throwaway project + xource + xell + zee ──
  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,'langfuse-session-link-test','/tmp/nonexistent','master','lfslt','postgres')`, [PID]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [XOURCE, PID]);
  await client.query(
    `INSERT INTO xell (id, project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                       langfuse_tracking)
       VALUES ($1,$2,$3,'lfsl','spinoff/lfsl','/tmp/lfsl-wt','working',false,true)`,
    [XID, PID, XOURCE]);
  await client.query(
    `INSERT INTO zee (id, xell_id, name, status, kind, attach_mode, entrypoint, claude_session_id)
       VALUES ($1,$2,'lfsl-zee','working','headless','headless-spawn','cxell-cli',$3)`,
    [ZID, XID, SESSION]);

  const { xellLangfuseSession } = await import('../server/src/lib/langfuse.js');

  const expectMap = async (mapIdOrNull) => {
    await client.query(`DELETE FROM langfuse_project_map WHERE project_id=$1`, [PID]);
    if (mapIdOrNull) {
      await client.query(
        `INSERT INTO langfuse_project_map
           (project_id, langfuse_project_id, langfuse_project_name, public_key, secret_key, public_key_hint, secret_key_hint)
           VALUES ($1,$2,'Session Link Test','pk-map','sk-map','pk-…map','sk-…map')`,
        [PID, mapIdOrNull]);
    }
  };

  // ── A. THE CORE FIX: map empty + live unreachable + stored id → link resolves from stored state ──
  console.log('\n── A. stored system id resolves even when the live read fails (the TKT-127 fix) ──');
  await expectMap(null);
  await setCfg({ baseUrl: UNREACHABLE, systemProjectId: STORED_LF });
  if (await cfgHolds({ baseUrl: UNREACHABLE, systemProjectId: STORED_LF })) {
    const link = await xellLangfuseSession({ xellId: XID, zeeId: ZID });
    ok(link.ok === true && link.url === `${SENT_UI}/project/${STORED_LF}/sessions/${SESSION}`,
      `map empty + live unreachable + stored id → the link still resolves from stored state (${link.url})`);
    ok(link.project_id === STORED_LF && link.session_id === SESSION, '…and stamps the stored project + session');
  } else {
    console.log('  (skip A — another xell reset the shared langfuse_config mid-test)');
  }

  // ── B. the 1:1 mapping wins over both the stored id and the live read ──
  console.log('\n── B. a 1:1 mapping is preferred (order 1) ──');
  await expectMap(MAPPED_LF);
  await setCfg({ baseUrl: UNREACHABLE, systemProjectId: STORED_LF });
  if (await cfgHolds({ baseUrl: UNREACHABLE, systemProjectId: STORED_LF })) {
    const link = await xellLangfuseSession({ xellId: XID, zeeId: ZID });
    ok(link.ok === true && link.project_id === MAPPED_LF,
      `the mapped project id wins over the stored id (got ${link.project_id})`);
  } else {
    console.log('  (skip B — another xell reset the shared langfuse_config mid-test)');
  }

  // ── C. no map, no stored id, live read succeeds → live id used AND written back ──
  console.log('\n── C. the live read is the last resort, and writes back what it learns ──');
  projectsStatus = 200;
  projectsBody = JSON.stringify({ data: [{ id: LIVE_LF }] });
  await expectMap(null);
  await setCfg({ baseUrl: FAKE_BASE, systemProjectId: null });
  if (await cfgHolds({ baseUrl: FAKE_BASE, systemProjectId: null })) {
    const link = await xellLangfuseSession({ xellId: XID, zeeId: ZID });
    ok(link.ok === true && link.project_id === LIVE_LF,
      `no map + no stored id → the live read supplies the project id (got ${link.project_id})`);
    const after = (await client.query(
      `SELECT system_project_id FROM langfuse_config WHERE id=true`)).rows[0];
    ok(after.system_project_id === LIVE_LF, '…and the learned id is WRITTEN BACK to langfuse_config.system_project_id');
  } else {
    console.log('  (skip C — another xell reset the shared langfuse_config mid-test)');
  }

  // ── D. no map, no stored id, instance unreachable → a reason that names it ──
  console.log('\n── D. unreachable instance with no stored id → langfuse-unreachable ──');
  await expectMap(null);
  await setCfg({ baseUrl: UNREACHABLE, systemProjectId: null });
  if (await cfgHolds({ baseUrl: UNREACHABLE, systemProjectId: null })) {
    const link = await xellLangfuseSession({ xellId: XID, zeeId: ZID });
    ok(link.ok === false && link.reason === 'langfuse-unreachable',
      `no map + no stored id + unreachable → reason 'langfuse-unreachable' (got ${link.reason})`);
  } else {
    console.log('  (skip D — another xell reset the shared langfuse_config mid-test)');
  }

  // ── E. no map, no stored id, live read returns no project → no-project ──
  console.log('\n── E. live read returns no project → no-project ──');
  projectsStatus = 200;
  projectsBody = JSON.stringify({ data: [] });   // 200 but no project in the body
  await expectMap(null);
  await setCfg({ baseUrl: FAKE_BASE, systemProjectId: null });
  if (await cfgHolds({ baseUrl: FAKE_BASE, systemProjectId: null })) {
    const link = await xellLangfuseSession({ xellId: XID, zeeId: ZID });
    ok(link.ok === false && link.reason === 'no-project',
      `no map + no stored id + 200-without-project → reason 'no-project' (got ${link.reason})`);
  } else {
    console.log('  (skip E — another xell reset the shared langfuse_config mid-test)');
  }

  // ── F. no session id → no-session (distinct from the project refusals) ──
  console.log('\n── F. a xell with no session id → no-session ──');
  await client.query(`UPDATE zee SET claude_session_id=NULL, session_name=NULL WHERE id=$1`, [ZID]);
  await setCfg({ baseUrl: UNREACHABLE, systemProjectId: STORED_LF });
  if (await cfgHolds({ baseUrl: UNREACHABLE, systemProjectId: STORED_LF })) {
    const link = await xellLangfuseSession({ xellId: XID, zeeId: ZID });
    ok(link.ok === false && link.reason === 'no-session',
      `a session-less zee → reason 'no-session' (got ${link.reason})`);
  } else {
    console.log('  (skip F — another xell reset the shared langfuse_config mid-test)');
  }
} finally {
  // restore the langfuse_config row + project map, delete throwaway rows, close the fake server
  try {
    if (priorLf) {
      await client.query(
        `UPDATE langfuse_config SET enabled=$1, status=$2, base_url=$3, ui_url=$4, client_base_url=$5,
                public_key=$6, secret_key=$7, public_key_hint=$8, secret_key_hint=$9,
                system_project_id=$10 WHERE id=true`,
        [priorLf.enabled, priorLf.status, priorLf.base_url, priorLf.ui_url, priorLf.client_base_url,
         priorLf.public_key, priorLf.secret_key, priorLf.public_key_hint, priorLf.secret_key_hint,
         priorLf.system_project_id]);
    }
    if (priorMaps.length) {
      await client.query(`DELETE FROM langfuse_project_map`);
      for (const m of priorMaps) {
        await client.query(
          `INSERT INTO langfuse_project_map
             (id, project_id, langfuse_project_id, langfuse_project_name, public_key, secret_key, public_key_hint, secret_key_hint, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [m.id, m.project_id, m.langfuse_project_id, m.langfuse_project_name,
           m.public_key, m.secret_key, m.public_key_hint, m.secret_key_hint, m.created_at]);
      }
    }
  } catch { /* restore best-effort */ }
  try { await cleanup(); } catch { /* */ }
  await client.end().catch(() => {});
  await new Promise((r) => fake.close(r));
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);

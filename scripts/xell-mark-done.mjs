// HUMAN says done. `/xell-done` is a slash command a human types, so it IS the confirmation —
// making them then click "Mark done" in the web app is confirming their own confirmation.
// (The zee's autonomous self-report still goes through xell-report-done.mjs → awaiting-done,
// because a zee deciding it is finished is a claim, not a decision.)
//
//   node xell-mark-done.mjs            # mark THIS session's xell done + tear it down
//   node xell-mark-done.mjs --check    # only report unlanded work; change nothing
//
// Tearing down removes the worktree AND its branch, so anything not landed on main is GONE.
// This checks for unlanded work first and refuses unless you pass --force.
import http from 'node:http';

const api = process.env.ZEEHIVE_API || 'http://localhost:4700';
const sid = process.env.CLAUDE_CODE_SESSION_ID || '';
const force = process.argv.includes('--force');
const checkOnly = process.argv.includes('--check');

const get = (p) => new Promise((res, rej) => {
  http.get(`${api}${p}`, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ code: r.statusCode, body: b })); }).on('error', rej);
});
const post = (p, obj) => new Promise((res, rej) => {
  const body = JSON.stringify(obj);
  const r = http.request(`${api}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res({ code: x.statusCode, body: b })); });
  r.on('error', rej); r.write(body); r.end();
});

try {
  const st = await get(`/api/xell/status?session_id=${encodeURIComponent(sid)}`);
  if (st.code >= 400) { console.log(`No xell for this session (HTTP ${st.code}). Nothing to mark done.`); process.exit(0); }
  const s = JSON.parse(st.body);
  const xellId = s.xell?.id || s.xell_id;
  const slug = s.xell?.slug || s.slug || '?';
  if (!xellId) { console.log('Could not resolve this session\'s xell.'); process.exit(0); }

  // Unlanded work check — teardown deletes the worktree + branch.
  const dj = await get('/api/xell/diffs');
  const d = JSON.parse(dj.body)[xellId];
  const unlanded = d ? (d.ahead > 0 || d.dirty > 0) : false;
  if (d) {
    console.log(`xell ${slug}: ${d.ahead} commit(s) ahead of main, ${d.dirty || 0} uncommitted file(s).`);
  }
  if (checkOnly) process.exit(0);
  if (unlanded && !force) {
    console.log(
`REFUSED — this xell has work that is NOT landed on main.
Tearing it down removes the worktree AND the branch, so that work would be lost.
Land it first (commit, then: git push . HEAD:main), or re-run with --force to discard it.`);
    process.exit(0);
  }

  // --force covers BOTH refusals: the local unlanded check above, and the server's active-zee
  // guard (which answers HTTP 200 with ok:false — a refusal, not an error code).
  const r = await post(`/api/xells/${xellId}/reap`, { reason: 'human-marked-done', force });
  if (r.code >= 400) { console.log(`Mark done failed (HTTP ${r.code}): ${r.body}`); process.exit(0); }
  let out = null; try { out = JSON.parse(r.body); } catch { /* non-JSON body */ }
  if (out && out.ok === false) {
    // A refusal is not a DONE — saying so trained a human to believe teardowns that never ran.
    console.log(`REFUSED — ${out.error || r.body}`
      + (out.active && !force ? '\nA typed /xell-done is the confirmation: re-run with --force to proceed.' : ''));
    process.exit(0);
  }
  console.log(`DONE — ${slug} marked done and torn down (worktree, branch and per-xell containers removed).\n${r.body}`);
} catch (e) {
  console.log(`ZEEHIVE API unreachable at ${api}: ${e.message}`);
}

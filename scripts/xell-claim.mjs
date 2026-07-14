// Called by the /xell skill at load time. Claims the freshest ready xell for THIS
// Claude session and prints the binding JSON, which the skill inlines into the prompt.
// Uses only ambient signals: $CLAUDE_CODE_SESSION_ID and the session cwd.
import http from 'node:http';

const api = process.env.XEEHIVE_API || 'http://localhost:4700';
const task = process.argv[2] || '';
const body = JSON.stringify({
  session_id: process.env.CLAUDE_CODE_SESSION_ID || '',
  cwd: process.cwd(),
  task,
});

const req = http.request(`${api}/api/xell/claim`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
}, (res) => {
  let b = '';
  res.on('data', (c) => (b += c));
  res.on('end', () => {
    let j; try { j = JSON.parse(b); } catch { /* non-JSON */ }
    if (j && j.status === 'needs-worktree') {
      // The gate said NO: this session isn't in a xell worktree, so it was NOT claimed.
      const others = (j.also_ready || []).map((x) => `    • ${x.worktree_path}`).join('\n');
      console.log(
`NOT CLAIMED — do not start any work.

Your session is running in ${j.your_cwd || 'a non-xell directory'}, which is NOT an isolated xell
worktree. A zee may only work inside its own worktree, so no xell was claimed for this session.

To proceed: open this worktree folder in a NEW Claude Code session and run /xell there —
    ${j.open_worktree}   (${j.open_slug})
${others ? `\nOther ready worktrees you may open instead:\n${others}\n` : ''}
Work begins ONLY once the API returns status "claimed".`);
      process.exit(0);
    }
    if (res.statusCode >= 400) {
      console.log(`Not claimed (HTTP ${res.statusCode}): ${b}\nDo not start any work.`);
      process.exit(0);
    }
    console.log(b);
  });
});
req.on('error', (e) => { console.log(`queenzee API unreachable at ${api}: ${e.message}`); process.exit(0); });
req.write(body);
req.end();

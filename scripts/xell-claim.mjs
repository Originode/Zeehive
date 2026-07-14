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
      // Not in a worktree → NOT claimed. Offer the confirmed auto-dispatch path.
      const d = j.dispatch || {};
      const home = process.env.XEEHIVE_HOME || 'D:/Repos/Xeehive';
      const others = (j.also_ready || []).map((x) => `    • ${x.worktree_path}`).join('\n');
      console.log(
`NOT CLAIMED — this session is in the main repo (${j.your_cwd || '?'}), NOT a xell worktree.
Do not read/edit/write any files here (it is the read-only xource).

RECOMMENDED — dispatch this task to a ready xell. The queenzee will spawn a zee INSIDE its
worktree to do the work. CONFIRM WITH THE USER first, then run this exact command:

    node "${home}/scripts/xell-dispatch.mjs" ${d.xell_id || ''} ${JSON.stringify(task)}

    → target xell : ${d.slug || '?'}   (runtime: ${d.runtime_label || 'default'})
    → worktree    : ${d.worktree_path || '?'}

ALTERNATIVE — open the worktree yourself and run /xell there:
    ${j.open_worktree}   (${j.open_slug})
${others ? `\nOther ready worktrees:\n${others}\n` : ''}`);
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

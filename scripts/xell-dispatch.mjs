// Called by the /xell skill AFTER the human confirms an auto-dispatch (when /xell was run
// outside a worktree). Tells the queenzee to spawn a zee INTO a ready xell's worktree to run
// the task, and prints the result. Usage: xell-dispatch.mjs <xell_id> "<task>"
import http from 'node:http';

const api = process.env.XEEHIVE_API || 'http://localhost:4700';
const xellId = process.argv[2] || '';
const task = process.argv[3] || '';
if (!task) { console.log('usage: xell-dispatch.mjs <xell_id> "<task>"'); process.exit(0); }

const body = JSON.stringify({ xell_id: xellId || undefined, task });
const req = http.request(`${api}/api/xell/dispatch`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
}, (res) => {
  let b = '';
  res.on('data', (c) => (b += c));
  res.on('end', () => {
    if (res.statusCode >= 400) { console.log(`Dispatch failed (HTTP ${res.statusCode}): ${b}`); process.exit(0); }
    console.log(`DISPATCHED — a zee is spawning in the worktree to do the task:\n${b}`);
  });
});
req.on('error', (e) => { console.log(`queenzee API unreachable at ${api}: ${e.message}`); process.exit(0); });
req.write(body);
req.end();

// The zee calls this to REPORT that it believes its job is finished. It does NOT complete
// the job — it flags the xell for a human to confirm via "Mark done" in the web app.
//   node xell-report-done.mjs "optional note"
import http from 'node:http';
const api = process.env.XEEHIVE_API || process.env.XEEHIVE_API || 'http://localhost:4700';
const body = JSON.stringify({ session_id: process.env.CLAUDE_CODE_SESSION_ID || '', note: process.argv[2] || '' });
const req = http.request(`${api}/api/xell/report-done`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
}, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => console.log(b)); });
req.on('error', (e) => console.log(`XEEHIVE API unreachable at ${api}: ${e.message}`));
req.write(body); req.end();

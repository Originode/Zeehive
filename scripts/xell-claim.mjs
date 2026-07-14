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
    if (res.statusCode >= 400) {
      console.log(`No xell available (HTTP ${res.statusCode}): ${b}`);
      process.exit(0);
    }
    console.log(b);
  });
});
req.on('error', (e) => { console.log(`queenzee API unreachable at ${api}: ${e.message}`); process.exit(0); });
req.write(body);
req.end();

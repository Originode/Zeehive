// Prints the current status of THIS session's xell (used by the /xell-done skill).
import http from 'node:http';
const api = process.env.XEEHIVE_API || process.env.XEEHIVE_API || 'http://localhost:4700';
const sid = process.env.CLAUDE_CODE_SESSION_ID || '';
http.get(`${api}/api/xell/status?session_id=${encodeURIComponent(sid)}`, (res) => {
  let b = ''; res.on('data', (c) => (b += c));
  res.on('end', () => { if (res.statusCode >= 400) console.log(`No xell for this session (HTTP ${res.statusCode}).`); else console.log(b); });
}).on('error', (e) => console.log(`XEEHIVE API unreachable at ${api}: ${e.message}`));

// The SANCTIONED way for a zee to (re)build its xell's app tier. Goes through the queenzee, so
// the built commit, hot flag, container health and the dashboard all stay truthful — instead of
// the zee running docker/compose/spin-env.sh by hand and leaving the orchestrator blind.
//
//   xell-build.mjs <xell_id> [server|webapp|all] [--hot]
//
//   (default)  rebuild the image from THIS worktree's code + recreate the container.
//   --hot      bounce the container from the existing image (fast; does NOT pick up code changes).
//
// Returns immediately: builds run in the background. Watch container health on the dashboard,
// or re-run `xell-status.mjs`. Never blocks.
import http from 'node:http';

const api = process.env.XEEHIVE_API || 'http://localhost:4700';
const args = process.argv.slice(2);
const hot = args.includes('--hot');
const [xellId, roleArg] = args.filter((a) => a !== '--hot');
const role = roleArg || 'all';

if (!xellId) { console.log('usage: xell-build.mjs <xell_id> [server|webapp|all] [--hot]'); process.exit(0); }
if (!['server', 'webapp', 'all'].includes(role)) {
  console.log(`bad role '${role}' — use: server | webapp | all`); process.exit(0);
}

const body = JSON.stringify({ hot, role });
const req = http.request(`${api}/api/xells/${xellId}/build`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
}, (res) => {
  let b = '';
  res.on('data', (c) => (b += c));
  res.on('end', () => {
    if (res.statusCode >= 400) { console.log(`Build request failed (HTTP ${res.statusCode}): ${b}`); process.exit(0); }
    console.log(`${hot ? 'HOT build' : 'Build'} started for ${role} — running in the background.\n${b}\n` +
      `Watch its health on the XEEHIVE dashboard (spinner → up = built, down = failed).`);
  });
});
req.on('error', (e) => { console.log(`queenzee API unreachable at ${api}: ${e.message}`); process.exit(0); });
req.write(body);
req.end();

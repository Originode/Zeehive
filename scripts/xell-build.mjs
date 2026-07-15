// The SANCTIONED way for a zee to (re)build its xell's app tier. Goes through the queenzee, so
// the built commit, hot flag, container health and the dashboard all stay truthful — instead of
// the zee running docker/compose/spin-env.sh by hand and leaving the orchestrator blind.
//
//   xell-build.mjs <xell_id> [server|webapp|all] [--hot] [--wait[=secs]] [--watch]
//
//   (default)  rebuild the image from THIS worktree's code + recreate the container.
//   --hot      bounce the container from the existing image (fast; does NOT pick up code changes).
//   --wait     block until the build SETTLES, then report whether the container is serving the
//              worktree's current HEAD. Exits 0 built / 1 failed-or-timeout (default 20 min).
//   --watch    do NOT build — just wait/report on a build that is already running (or answer
//              "is my code live?" right now). Read-only.
//
// WITHOUT --wait this returns immediately and you must watch the dashboard — which a zee cannot
// do. That gap is why zees invent `curl | grep` poll loops against their own webapp and then hang
// for 45 minutes on a condition that never matches. Use --wait instead: it asks the queenzee,
// which RECORDS the commit each container was built at, so the answer is a fact, not a guess.
//
// Run it in the background and its EXIT is the nudge — the harness re-invokes your session when a
// background task finishes, so you can keep working and get told the moment the build lands.
import http from 'node:http';

const api = process.env.ZEEHIVE_API || 'http://localhost:4700';
const args = process.argv.slice(2);
const hot = args.includes('--hot');
const waitArg = args.find((a) => a === '--wait' || a.startsWith('--wait='));
const watch = args.includes('--watch');   // report on an existing build; never starts one
const waitSecs = waitArg?.includes('=') ? Number(waitArg.split('=')[1]) || 1200 : 1200;
const [xellId, roleArg] = args.filter((a) => !a.startsWith('--'));
const role = roleArg || 'all';

if (!xellId) { console.log('usage: xell-build.mjs <xell_id> [server|webapp|all] [--hot] [--wait[=secs]] [--watch]'); process.exit(0); }
if (!['server', 'webapp', 'all'].includes(role)) {
  console.log(`bad role '${role}' — use: server | webapp | all`); process.exit(0);
}

const getJSON = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => {
    let b = ''; res.on('data', (c) => (b += c));
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(`bad JSON from ${url}`)); } });
  }).on('error', reject);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll the queenzee until no targeted container is 'building' any more. Bounded: a wait that can
// hang forever is the very thing we're replacing.
async function waitForBuild() {
  const deadline = Date.now() + waitSecs * 1000;
  let last = '';
  let first = true;
  while (Date.now() < deadline) {
    // --watch answers "is my code live?" immediately; only a wait-after-build needs a beat first.
    if (!first || !watch) await sleep(3000);
    first = false;
    let st;
    try { st = await getJSON(`${api}/api/xells/${xellId}/build/status`); }
    catch (e) { console.log(`  (status unreadable: ${e.message}) — retrying`); continue; }

    // A 404/error body is valid JSON with no `containers` — say why instead of exploding on it.
    if (!Array.isArray(st?.containers)) {
      console.log(`\n  ✗ Cannot read build status for xell ${xellId}: ${st?.error || 'unexpected response'}`);
      process.exit(1);
    }
    const want = role === 'all' ? st.containers : st.containers.filter((c) => c.role === role);
    if (!want.length) {
      console.log(`\n  ✗ This xell has no ${role} container to build (PROVISION_APP_TIER=false provisions the worktree only).`);
      process.exit(1);
    }
    const line = want.map((c) => `${c.role}=${c.health}`).join(' ');
    if (line !== last) { console.log(`  … ${line}`); last = line; }
    if (want.some((c) => c.health === 'building')) continue;

    // Settled. Report per container, and be explicit about WHY a container isn't serving HEAD —
    // "not serving your code" with no reason is what sends a zee hunting for a phantom bug.
    console.log('');
    let ok = true;
    for (const c of want) {
      if (c.health === 'up' && c.serving_head) {
        console.log(`  ✓ ${c.role} (${c.name}) is UP and serving your HEAD ${String(st.head).slice(0, 8)}`);
      } else if (c.health === 'up' && c.hot_build) {
        console.log(`  ⚠ ${c.role} (${c.name}) is UP but was a --hot bounce: it re-used the old image and is NOT running your code. Rebuild without --hot.`);
        ok = false;
      } else if (c.health === 'up' && c.never_built) {
        console.log(`  ⚠ ${c.role} (${c.name}) is UP but the queenzee has never built it (no recorded commit), so what it serves is unknown — run a build for this role.`);
        ok = false;
      } else if (c.health === 'up') {
        console.log(`  ⚠ ${c.role} (${c.name}) is UP but built at ${String(c.last_build_commit).slice(0, 8)}, not your HEAD ${String(st.head).slice(0, 8)} — your newest commit is not in it. Rebuild.`);
        ok = false;
      } else {
        console.log(`  ✗ ${c.role} (${c.name}) is ${c.health.toUpperCase()} — the build FAILED. Check the queenzee terminal (▚_) on the dashboard.`);
        ok = false;
      }
    }
    process.exit(ok ? 0 : 1);
  }
  console.log(`\n  ✗ TIMEOUT after ${waitSecs}s — still building. Something is wrong; check the dashboard.`);
  process.exit(1);
}

// --watch: report only, start nothing. (Read-only, so it is also the safe way to ask "is what's
// running actually my code?" without kicking off a rebuild you didn't want.)
if (watch) {
  console.log(`Watching ${role} for xell ${xellId} (no build started)…`);
  waitForBuild();
}

const body = JSON.stringify({ hot, role });
const req = watch ? null : http.request(`${api}/api/xells/${xellId}/build`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
}, (res) => {
  let b = '';
  res.on('data', (c) => (b += c));
  res.on('end', () => {
    if (res.statusCode >= 400) { console.log(`Build request failed (HTTP ${res.statusCode}): ${b}`); process.exit(waitArg ? 1 : 0); }
    console.log(`${hot ? 'HOT build' : 'Build'} started for ${role} — running in the background.\n${b}`);
    if (waitArg) {
      console.log(`Waiting up to ${waitSecs}s for it to settle (asking the queenzee, not guessing)…`);
      waitForBuild();
    } else {
      console.log('Watch its health on the ZEEHIVE dashboard (spinner → up = built, down = failed),\n'
        + 'or re-run with --wait to block until it settles instead of polling by hand.');
    }
  });
});
if (req) {
  req.on('error', (e) => { console.log(`queenzee API unreachable at ${api}: ${e.message}`); process.exit(waitArg ? 1 : 0); });
  req.write(body);
  req.end();
}

// A PROCESS ROLE IS PROBED WHERE THE PROCESS IS — ticket #8.
//
// THE DEFECT: the container health sweep probes a `runner: process` row at its recorded `url`.
// That url is built at provision from the dev MACHINE's host_ip (lib/provision.js), and a process
// role does not run there — the queenzee spawns it as its own child (lib/build.js →
// scripts/start-xell-process.sh), so it listens on the QUEENZEE's localhost and nothing is
// published on the machine's ip. The probe therefore could not answer for any process role, and
// every one was flipped to 'down' within 30 seconds of a start the starter had just verified by
// answering on localhost itself. That is where `zee build --wait` gets "the build FAILED" from,
// and why 11 of 12 Zeehive spinoff containers read as never having come up.
//
// Observed live on 2026-08-04: this xell's webapp was UP and serving HTML on the queenzee's
// localhost:5309 while its row said 'down' and the console said the build had failed.
//
// Real HTTP, no database and no docker: the probe is the whole behaviour, and the sweep around it
// is a SQL loop that only stores what the probe returns.
import http from 'node:http';
import { probeProcessRole, processProbeUrls } from '../server/src/queenzee/containers.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// 10.255.255.1 is TEST-NET-ish unroutable space: it stands in for the dev machine's ip, which is a
// real host that simply does not serve this port. Kept in the recorded url so the fallback is real.
const listen = (server) => new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));

const servers = [];
try {
  console.log('\n── 1. a process answering on the queenzee\'s localhost is UP ──');
  const up = http.createServer((_q, r) => r.end('ok'));
  servers.push(up);
  const port = await listen(up);
  const row = { name: 'zeehive_spin_webapp_x', host_port: port, url: `http://10.255.255.1:${port}` };

  // The bug, reproduced rather than asserted: the sweep's old body, verbatim, against that live
  // process. It is the reason a running webapp read 'down' on every dashboard for a month.
  const oldProbe = async (c) => {
    try {
      const r = await fetch(c.url, { signal: AbortSignal.timeout(2000) });
      return r.status < 500 ? 'up' : 'down';
    } catch { return 'down'; }
  };
  ok(await oldProbe(row) === 'down',
     'the OLD probe (recorded url only) calls this live process DOWN — the defect itself');

  ok(processProbeUrls(row)[0] === `http://127.0.0.1:${port}`,
     'localhost is asked FIRST — it is where the queenzee started the process');
  ok(processProbeUrls(row).includes(row.url),
     'and the recorded url is kept as a fallback, so a row whose url is right is unaffected');
  ok(await probeProcessRole(row, { timeout: 2000 }) === 'up',
     'a live process reads UP even though its recorded url answers nothing — the defect, fenced');

  console.log('\n── 2. nothing listening is still DOWN ──');
  const dead = http.createServer((_q, r) => r.end('ok'));
  servers.push(dead);
  const deadPort = await listen(dead);
  await new Promise((res) => dead.close(res));
  ok(await probeProcessRole({ host_port: deadPort, url: `http://10.255.255.1:${deadPort}` }, { timeout: 2000 }) === 'down',
     'a role with no process behind it is DOWN — the probe did not become a rubber stamp');

  console.log('\n── 3. a row with no host_port falls back to the url alone ──');
  const legacy = http.createServer((_q, r) => r.end('ok'));
  servers.push(legacy);
  const legacyPort = await listen(legacy);
  ok(processProbeUrls({ url: `http://127.0.0.1:${legacyPort}` }).length === 1,
     'only the url is probed (host-era rows are not given a second guess)');
  ok(await probeProcessRole({ url: `http://127.0.0.1:${legacyPort}` }, { timeout: 2000 }) === 'up',
     'and it still reads UP exactly as it did before');

  console.log('\n── 4. a 5xx is not "up" ──');
  const broken = http.createServer((_q, r) => { r.statusCode = 502; r.end('bad'); });
  servers.push(broken);
  const brokenPort = await listen(broken);
  ok(await probeProcessRole({ host_port: brokenPort, url: `http://10.255.255.1:${brokenPort}` }, { timeout: 2000 }) === 'down',
     'a process that answers 502 on localhost is still DOWN (the pre-existing rule, kept)');
} finally {
  for (const s of servers) { try { s.close(); } catch { /* */ } }
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

// EXT_API_BASE (TKT-184) — the externally-reachable base URL for /api/ext/v1 must be operator-set
// or null, NEVER the cxell address (http://host.docker.internal:4700, which means "the docker host
// I am running on" — for a deployed project that is ITS OWN host, where no queenzee listens).
//
// config.js is a module singleton read at import, so each scenario here runs in a FRESH child
// process with the env set before the import — the only way to watch the default change.
//
// The contract:
//   1. EXT_API_BASE set → that exact value wins (the operator's one knob);
//   2. EXT_API_BASE unset but DEV_HOST_IP set → derived http://<DEV_HOST_IP>:<PORT>;
//   3. neither set → null ("no external ingress configured"), never host.docker.internal.
//
// No database, no docker — pure config, spawned per scenario.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const section = (t) => console.log(`\n── ${t} ──`);

const SCRIPT = "import { config } from './server/src/config.js'; console.log(JSON.stringify(config.extApiBase));";

function extApiBaseIn(env) {
  return new Promise((resolve2) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', SCRIPT], {
      cwd: ROOT, env: { ...process.env, ...env },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve2({ code, out: out.trim(), err: err.trim() }));
  });
}

// Strip the ambient DEV_HOST_IP/EXT_API_BASE so each scenario starts from a clean slate.
const CLEAN = {};
for (const k of ['EXT_API_BASE', 'DEV_HOST_IP', 'PORT']) if (k in process.env) CLEAN[k] = '';

try {
  section('the default is honest — never the cxell address');
  const none = await extApiBaseIn(CLEAN);
  ok(none.code === 0 && none.out === 'null',
     `neither EXT_API_BASE nor DEV_HOST_IP set → null (got ${none.out || none.err})`);
  ok(!String(none.out).includes('host.docker.internal'),
     'and the null default never points at the local docker host');

  section('an operator-set EXT_API_BASE wins');
  const explicit = await extApiBaseIn({ ...CLEAN, EXT_API_BASE: 'https://tickets.example.com', DEV_HOST_IP: '10.9.9.9' });
  ok(explicit.code === 0 && explicit.out === '"https://tickets.example.com"',
     `EXT_API_BASE is the single knob (got ${explicit.out || explicit.err})`);

  section('DEV_HOST_IP is the honest LAN fallback, on the API port');
  const lan = await extApiBaseIn({ ...CLEAN, DEV_HOST_IP: '10.9.9.9', PORT: '4700' });
  ok(lan.code === 0 && lan.out === '"http://10.9.9.9:4700"',
     `DEV_HOST_IP + PORT derive the LAN address (got ${lan.out || lan.err})`);
} finally {
  /* nothing to clean up — child processes only */
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

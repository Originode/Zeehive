// THE SHELL THE BROWSER CACHES — why a shipped console fix can be invisible.
//
// The ❖ environment panel's 404 was fixed, landed, shipped and verified in the running container
// (the deployed bundle asked for /env/resolved and the API answered 200) — and the human still saw
// the old red box, because their browser was still running the PREVIOUS bundle. index.html is the
// only file that names the current bundle (vite content-hashes every asset), and nginx serves
// static files with NO Cache-Control at all, so a browser is free to apply heuristic freshness and
// keep serving a stale shell without ever revalidating.
//
// So the rule this file guards is one line of nginx and the whole deliverability of the console:
// the SHELL revalidates every load, the HASHED assets are cached forever. There is no nginx binary
// in a cxell (and no docker), so this asserts the CONFIG — the same technique the compose/Dockerfile
// facts elsewhere are held to. What it cannot prove is that nginx parses it; that is proved by the
// webapp ship, which fails to start a container whose config is invalid.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const conf = readFileSync(resolve(ROOT, 'docker/zeehive/nginx-web.conf'), 'utf8');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

console.log('\n── docker/zeehive/nginx-web.conf ──');

// `location = /index.html` is EXACT-match on purpose: it also catches the SPA fallback, because an
// internal redirect from try_files re-runs location matching.
const shell = conf.match(/location\s*=\s*\/index\.html\s*\{[^}]*\}/);
ok(!!shell, 'the shell has its own exact-match location block');
ok(!!shell && /add_header\s+Cache-Control\s+"no-cache"/.test(shell[0]),
   `and it is served no-cache (revalidate every load, 304 on the ETag) — got: ${(shell?.[0] || '').replace(/\s+/g, ' ')}`);

const assets = conf.match(/location\s+\/assets\/\s*\{[^}]*\}/);
ok(!!assets && /max-age=31536000/.test(assets[0]) && /immutable/.test(assets[0]),
   `the content-hashed assets are cached hard, which is what keeps the shell's no-cache cheap — got: ${(assets?.[0] || 'no /assets/ block').replace(/\s+/g, ' ')}`);

ok(/try_files\s+\$uri\s+\/index\.html/.test(conf),
   'the SPA fallback still resolves client-side routes to the shell');
ok(/proxy_pass\s+http:\/\/host\.docker\.internal:4700/.test(conf),
   'and /api still proxies to the queenzee (this file also carries the SSE + websocket contract)');

// The "+ prompt" composer posts pasted screenshots as base64 INSIDE the JSON body. The queenzee's
// express accepts 30mb for exactly that; nginx defaults to 1mb, which made every image-attached
// dispatch 413 at the webapp before the queenzee ever saw it. The webapp nginx must never be the
// smaller door — assert it carries a client_max_body_size >= the server's express limit, so the
// two cannot drift apart.
console.log('\n── the webapp nginx accepts the bodies the composer sends ──');
const serverSrc = readFileSync(resolve(ROOT, 'server/src/index.js'), 'utf8');
const expressLimit = (serverSrc.match(/express\.json\(\{\s*limit:\s*'(\d+)mb'\s*\}\)/) || [])[1];
ok(!!expressLimit, `the queenzee's express json limit is readable (limit=${expressLimit || '?'}mb)`);
const nginxLimit = (conf.match(/client_max_body_size\s+(\d+)m\s*;/) || [])[1];
ok(!!nginxLimit, `the webapp nginx sets client_max_body_size (${nginxLimit || 'missing'}m)`);
ok(expressLimit && nginxLimit && Number(nginxLimit) >= Number(expressLimit),
   `…and it is >= the server's ${expressLimit || '?'}mb so the proxy is not the smaller door`);

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

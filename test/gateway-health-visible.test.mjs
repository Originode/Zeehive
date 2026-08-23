// THE CONSOLE MUST SAY THE GATEWAY IS DOWN — AT THE ADDRESS, IN WORDS.
//
// The 2026-08-22 outage: the gateway address minted into cages moved to host.docker.internal:4701,
// a port no compose file published, and for ~13h every dispatch died while the console's fleet line
// said "N of N xells in use" and gave no surface for "the port cages are pointed at is closed". A
// human reading the console had no way to tell one of OUR ports was closed from "three providers are
// down".
//
// This test covers the pure half of the fix — the one place the fleet.gateway_health snapshot
// (queenzee/gateway-health.js, cached verdict of the health-monitor's probe) becomes words
// (web/src/gatewayHealth.js). It is a pure function on purpose, so it can be tested in plain node
// exactly like this, without a browser: the same words the page renders are the words asserted here.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { gatewayHealthWord } = await import(`file://${join(ROOT, 'web/src/gatewayHealth.js')}`);

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// ── down: the case this exists for ────────────────────────────────────────────────────────────────
const down = gatewayHealthWord({ state: 'down', address: 'http://host.docker.internal:4701', error: 'fetch failed', at: '2026-08-23T00:00:00Z' });
ok(down.kind === 'gateway_down', 'a down gateway is kind gateway_down');
ok(down.chip.includes('unreachable'), 'the word says unreachable');
ok(down.chip.includes('http://host.docker.internal:4701'), 'and NAMES THE ADDRESS cages are given — not 127.0.0.1');
ok(!down.chip.includes('127.0.0.1'), 'never the loopback, which answers even when the published port is closed');
ok(down.why.includes('http://host.docker.internal:4701'), 'the tooltip says the address too, so the reason is copy-pasteable');
ok(/Every cxell CLI in the fleet points its provider base-urls at this gateway/.test(down.why),
   'and says WHAT the down gateway costs — no AI call can reach a provider');

// down carries the probe's error detail when present
const downErr = gatewayHealthWord({ state: 'down', address: 'http://host.docker.internal:4701', error: 'HTTP 502' });
ok(downErr.why.includes('HTTP 502'), 'a probe that got a bad HTTP status names it');

// ── ok: healthy gateway stays quiet ────────────────────────────────────────────────────────────────
const okState = gatewayHealthWord({ state: 'ok', address: 'http://host.docker.internal:4701' });
ok(okState.kind === 'gateway_ok', 'an answering gateway is kind gateway_ok');
ok(okState.chip.includes('ok') && !okState.chip.includes('⚠') && !okState.chip.includes('unreachable'),
   'the word says ok, with no alarm');
ok(okState.chip.includes('http://host.docker.internal:4701'), 'and still names the address it answers at');

// a 404 answer is REACHABLE (the landed address-mint definition) — the chip says ok, never
// "unreachable"; the caveat rides the tooltip so a wrong server is discoverable, not hidden.
const okCaveat = gatewayHealthWord({ state: 'ok', address: 'http://zeehive_server:4701', error: 'HTTP 404 (not the gateway hello)' });
ok(okCaveat.kind === 'gateway_ok' && !okCaveat.chip.includes('unreachable') && !okCaveat.chip.includes('⚠'),
   'a 404-answering address is REACHABLE — the chip says ok, not unreachable');
ok(okCaveat.chip.includes('http://zeehive_server:4701'), 'and names the address it answers at');
ok(okCaveat.why.includes('HTTP 404'), 'while the tooltip says why the hello route was not the gateway service');

// ── unknown / missing: honest, never a false alarm ────────────────────────────────────────────────
const unknown = gatewayHealthWord({ state: 'unknown', address: null });
ok(unknown.kind === 'gateway_unknown', 'not-yet-probed is its own kind');
ok(unknown.chip.includes('not yet probed'), 'and says so in words');
ok(gatewayHealthWord(null).kind === 'gateway_unknown', 'a missing snapshot renders the honest "not yet probed"');
ok(gatewayHealthWord({}).kind === 'gateway_unknown', 'an empty snapshot is not mistaken for healthy');

// ── every result is a WORD, never a shade ─────────────────────────────────────────────────────────
for (const [label, g] of [['down', down], ['ok', okState], ['unknown', unknown]]) {
  ok(typeof g.chip === 'string' && g.chip.length > 0, `${label}: chip is non-empty words`);
  ok(typeof g.why === 'string' && g.why.length > 0, `${label}: the reason is in words too`);
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

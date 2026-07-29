// CXELL LIVE-RENDERER SWEEP test — how a shipped attend-path change reaches cxells that ALREADY
// EXIST.
//
// The feed renderer (zee-live.mjs) is baked into the zee-agent image, and the only refresh was on
// the SPAWN path — so it helped the next cage and no current one. Every cxell created before the
// ✱/⚒ chips shipped kept a renderer that knows nothing about the view file: the chip lit up
// "hidden" and the feed went on showing thinking. That is how this reached a human as "the buttons
// dont work", and it is the same drift class the `zee` CLI hit ("unknown command: dispatch" in
// every cage) — code that shipped but never reached the container.
//
// Two defences, both asserted here:
//   1. the SWEEP — at boot (which is also the moment after a ship, since the queenzee restarts into
//      the new code) the renderer is installed into every RUNNING cxell;
//   2. the ADMISSION — where the sweep cannot help (a feed already mid-stream from the old
//      renderer), the bridge reports it and the header says "older feed" rather than claiming a
//      filter it never applied. (Rendered end of that in terminal-feed-chips.test.mjs.)
//
// Pure unit + static: no docker daemon, so every install FAILS here — which is exactly the path
// worth proving, because a sweep that throws would take the queenzee's boot down with it.
//
// The sweep also obeys PROVISION_MODE now (it installs files into cages named from FLEET ROWS, and
// a nested queenzee's fleet rows are the real fleet's), so the live-behaviour calls below say
// `mode: 'real'` out loud. The simulate half is test/nested-queenzee-fleet-guard.test.mjs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const { refreshZeeLiveInLiveCxells } = await import('../server/src/lib/cxell.js');

// ── it never throws, whatever the fleet does ──────────────────────────────────────────────────
console.log('\n── the sweep is best-effort, per cxell ──');
ok(typeof refreshZeeLiveInLiveCxells === 'function', 'cxell.js exports refreshZeeLiveInLiveCxells');

const none = await refreshZeeLiveInLiveCxells(async () => []);
ok(none.swept === 0 && none.ok === 0, 'an empty fleet sweeps nothing and reports nothing');

// No docker in a test runner ⇒ every install fails. The sweep must still resolve.
const some = await refreshZeeLiveInLiveCxells(async () => ([
  { ctx: 'default', name: 'cxell_zt-one' }, { ctx: 'default', name: 'cxell_zt-two' },
]), { mode: 'real' });
ok(some.swept === 2, 'it visits every cxell it was given');
ok(some.failed.length === 2 && some.ok === 0,
   'an unreachable cage is COUNTED as failed, not thrown — one bad cxell must not stop the sweep');

const brokenLister = await refreshZeeLiveInLiveCxells(async () => { throw new Error('db down'); });
ok(brokenLister.swept === 0, 'a lister that throws is swallowed (boot must not die because the sweep could not read the fleet)');

// ── it runs at boot, over the RIGHT cxells ────────────────────────────────────────────────────
console.log('\n── wired into the queenzee boot ──');
const index = read('server/src/index.js');
ok(index.includes('refreshZeeLiveInLiveCxells('), 'index.js runs the sweep at boot');
ok(/refreshZeeLiveInLiveCxells\([\s\S]{0,600}?\.catch\(/.test(index),
   'with a .catch — a failed sweep is logged, never a boot failure');
const call = index.slice(index.indexOf('refreshZeeLiveInLiveCxells('), index.indexOf('startPool()'));
ok(/viewer_kind = 'ssh-terminal'/.test(call), 'over cxell zees only (the only ones with a feed to render)');
ok(/decommissioned_at IS NULL/.test(call), 'skipping zees that are gone');
ok(/NOT IN \('retired', 'tearing-down'\)/.test(call), 'and xells that are retired or being torn down');
ok(/cxellName\(/.test(call), 'resolving the container name the same way the rest of the driver does');

// ── the renderer it installs is the one that understands the chips ────────────────────────────
console.log('\n── what gets installed ──');
const live = read('docker/zeehive/zee-live.mjs');
ok(live.includes('READY_FILE') && live.includes('writeFileSync(READY_FILE'),
   'the installed renderer announces itself, which is what makes a stale one detectable');
ok(live.indexOf('watchFile(VIEW_FILE') < live.indexOf('writeFileSync(READY_FILE'),
   'and announces AFTER it starts watching — never claiming a filterable feed a moment early');
ok(/unlinkSync\(READY_FILE\)/.test(live), 'clearing the marker on the way out');
ok(/SIGINT[\s\S]{0,80}SIGTERM/.test(live),
   'including when zee-attach.sh kills it at turn end (a signal, not an stdin EOF) — else the marker outlives the feed');

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures ? 1 : 0);

// SHIP-PAYLOAD RENDER test (ticket #65) — the card shows the payload between the last shipped sha
// for the target and the one being deployed, named commit by commit with who landed each. Same
// esbuild pattern as ship-preflight-render.test.mjs: bundle the REAL Ship.jsx and render the real
// ShipPayload to static markup.
//   • a full payload renders the summary ("3 commits from 2 xells … 2 are yours") + the list, each
//     with sha, subject, who landed it, when, and its work item/ticket;
//   • a payload that could not be read renders "could not be read", NOT a blank and never a block;
//   • a first-ship / nothing-new note renders in words;
//   • a row with no payload renders NOTHING (absent is not blank);
//   • the component is actually wired onto the real ship card.
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const esbuild = await import('esbuild');
const tmp = mkdtempSync(join(tmpdir(), 'ship-payload-render-'));
const cleanup = () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} };

const out = join(tmp, 'pl.cjs');
await esbuild.build({
  stdin: {
    contents: `
      const React = require('react');
      const { renderToStaticMarkup } = require('react-dom/server');
      const { ShipPayload } = require('./Ship.jsx');
      module.exports = { React, renderToStaticMarkup, ShipPayload };`,
    resolveDir: join(ROOT, 'web/src'), loader: 'js',
  },
  bundle: true, format: 'cjs', platform: 'node', outfile: out, jsx: 'automatic',
  logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' },
});
const { React, renderToStaticMarkup, ShipPayload } = createRequire(out)(out);

const SHA = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
const SHA2 = '1234567890abcdef1234567890abcdef12345678';

try {
  // ── 1. a full payload — summary + named commits ──
  console.log('\n── a full payload names the commits, who landed each, and what it was for ──');
  const full = renderToStaticMarkup(React.createElement(ShipPayload, { req: {
    payload: {
      ok: true, from: SHA2, to: SHA,
      summary: { commits: 3, xells: 2, yours: 2 },
      commits: [
        { sha: SHA, short: 'abcdefa', subject: 'feat: ship the payload', xell_slug: 'payload-c',
          landed_at: '2026-08-20T10:00:00Z', work_item: { title: 'C ships the payload' },
          ticket: { number: 65, title: 'C ticket' } },
        { sha: SHA2, short: '1234567', subject: 'fix: polish the trim', xell_slug: 'payload-d',
          landed_at: '2026-08-20T11:00:00Z', work_item: { title: 'D polishes the trim' } },
        { sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', short: 'deadbee', subject: 'chore: tidy',
          xell_slug: null, landed_at: null, unattributed: true },
      ],
    },
  } }));
  ok(/data-testid="ship-payload"/.test(full), 'the card mounts the payload verdict');
  ok(/3 commits from 2 xells/.test(full), 'the summary names the count and xell count');
  ok(/2 are yours/.test(full), 'the summary names how many are the requester\'s');
  ok(/abcdefa/.test(full) && /feat: ship the payload/.test(full), 'a commit\'s sha + subject render');
  ok(/landed by payload-c/.test(full), 'the commit says WHO landed it');
  ok(/#65/.test(full) && /C ships the payload/.test(full), 'the commit carries its ticket + work item');
  ok(/landed by unknown/.test(full), 'an unattributed commit degrades to "unknown", not a blank');

  // ── 2. a payload that could not be read — the degrade, in words ──
  console.log('\n── an unreadable payload reads as could-not-be-read, never a block ──');
  const bad = renderToStaticMarkup(React.createElement(ShipPayload, { req: {
    payload: { ok: false, error: 'could not read the commit range' },
  } }));
  ok(/could not be read/.test(bad), 'an unreadable payload says so in words');
  ok(/commit range/.test(bad), '…and names the reason');

  // ── 3. a first-ship note ──
  console.log('\n── a first-ship / nothing-new payload renders its note ──');
  const first = renderToStaticMarkup(React.createElement(ShipPayload, { req: {
    payload: { ok: true, from: null, to: SHA, commits: [],
               summary: { commits: 0, xells: 0, yours: 0 },
               note: 'first ship to this target — no previous shipped sha, so the whole history rides along' },
  } }));
  ok(/first ship to this target/.test(first), 'the first-ship note renders in words');

  // ── 4. a row with no payload renders NOTHING ──
  console.log('\n── no payload recorded → nothing rendered ──');
  const none = renderToStaticMarkup(React.createElement(ShipPayload, { req: { commit: SHA } }));
  ok(none === '', `a row with no payload renders an empty string (${JSON.stringify(none)})`);

  // ── 5. the component is actually wired onto the real ship card ──
  console.log('\n── the payload is mounted on the real ship card ──');
  const shipSrc = readFileSync(join(ROOT, 'web/src/Ship.jsx'), 'utf8');
  ok(/<ShipPayload req=\{req\} \/>/.test(shipSrc), 'Ship.jsx mounts <ShipPayload> on the ship card');

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} finally {
  cleanup();
}
process.exit(fail ? 1 : 0);

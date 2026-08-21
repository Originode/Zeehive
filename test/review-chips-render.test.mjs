// REVIEW-CHIPS-RENDER test — the review chips actually render on the landing and ship cards (ticket #56).
//
// The db-sandbox half of the review-record work proves the READ MODELS carry reviews; this half proves
// the VIEW half of the same story: what a human would SEE on a landing/ship card when a review exists.
// It bundles the REAL Landing.jsx and Ship.jsx (with their real react + react-dom/server) through
// esbuild and renders the REAL ReviewNote / ShipReviewNote components to static markup — the same
// pattern test/app-dialog-jsx.test.mjs uses for Dialog.jsx — and asserts:
//   1. a changes-required review renders the ⚠ chip, the reviewer, the hyphen verdict, and the finding count;
//   2. a clean review renders the ✓ chip and the clean verdict;
//   3. a card with no reviews renders NOTHING (no empty chip container — the record is absent, not blank);
//   4. the chips are actually mounted on the real LandCard / ShipCard (not dead code).
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
const tmp = mkdtempSync(join(tmpdir(), 'rv-chips-'));
const cleanup = () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} };

// Bundle the REAL Landing.jsx + Ship.jsx (and their real react / react-dom/server) into one CJS module.
const out = join(tmp, 'chips.cjs');
await esbuild.build({
  stdin: {
    contents: `
      const React = require('react');
      const { renderToStaticMarkup } = require('react-dom/server');
      const { ReviewNote } = require('./Landing.jsx');
      const { ShipReviewNote } = require('./Ship.jsx');
      module.exports = { React, renderToStaticMarkup, ReviewNote, ShipReviewNote };`,
    resolveDir: join(ROOT, 'web/src'), loader: 'js',
  },
  bundle: true, format: 'cjs', platform: 'node', outfile: out, jsx: 'automatic',
  logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' },
});
const { React, renderToStaticMarkup, ReviewNote, ShipReviewNote } = createRequire(out)(out);

const SHA = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';

try {
  // ── 1. changes-required with findings — the chip a human reads on a card ──
  console.log('\n── a changes-required review renders its chip ──');
  const req = {
    new_sha: SHA, commit: SHA,
    reviews: [{ reviewer: 'reviewer-slug', verdict: 'changes_required', findings_count: 3, report: 'cross-project write hole' }],
  };
  const landMarkup = renderToStaticMarkup(React.createElement(ReviewNote, { req }));
  ok(/data-testid="land-reviews"/.test(landMarkup), 'the landing card mounts the review container');
  ok(/review-changes_required/.test(landMarkup), 'the chip carries the enum verdict as its class');
  ok(/⚠ reviewed by reviewer-slug — changes-required/.test(landMarkup),
     'the chip names the reviewer and the hyphen verdict (enum → display)');
  ok(/· 3 findings/.test(landMarkup), 'the chip shows the findings count');

  const shipMarkup = renderToStaticMarkup(React.createElement(ShipReviewNote, { req }));
  ok(/data-testid="ship-reviews"/.test(shipMarkup), 'the ship card mounts the same review container');
  ok(/⚠ reviewed by reviewer-slug — changes-required/.test(shipMarkup),
     'the ship chip carries the reviewer and verdict too');

  // ── 2. clean — the other verdict renders differently ──
  console.log('\n── a clean review renders the ✓ chip ──');
  const cleanMarkup = renderToStaticMarkup(React.createElement(ReviewNote, {
    req: { new_sha: SHA, reviews: [{ reviewer: 'approver-x', verdict: 'clean', findings_count: 0, report: null }] },
  }));
  ok(/review-clean/.test(cleanMarkup), 'a clean review gets its own chip class');
  ok(/✓ reviewed by approver-x — clean/.test(cleanMarkup), 'a clean review shows the check and verdict');
  ok(!/\d finding/.test(cleanMarkup), 'zero findings renders no finding count');

  // ── 3. no reviews → NOTHING (an unreviewed change is not an empty box on the card) ──
  console.log('\n── no review renders nothing at all ──');
  const none = renderToStaticMarkup(React.createElement(ReviewNote, { req: { new_sha: SHA, reviews: [] } }));
  ok(none === '', `an unreviewed landing renders an empty string, not a blank chip container (${JSON.stringify(none)})`);
  const noneShip = renderToStaticMarkup(React.createElement(ShipReviewNote, { req: { commit: SHA, reviews: null } }));
  ok(noneShip === '', 'a null reviews array renders nothing on the ship card either');

  // ── 4. the components are actually wired onto the cards (not dead code) ──
  console.log('\n── the chips are mounted on the real cards ──');
  const landingSrc = readFileSync(join(ROOT, 'web/src/Landing.jsx'), 'utf8');
  const shipSrc = readFileSync(join(ROOT, 'web/src/Ship.jsx'), 'utf8');
  ok(/<ReviewNote req=\{req\} \/>/.test(landingSrc), 'Landing.jsx mounts <ReviewNote> on the landing card');
  ok(/<ShipReviewNote req=\{req\} \/>/.test(shipSrc), 'Ship.jsx mounts <ShipReviewNote> on the ship card');

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} finally {
  cleanup();
}
process.exit(fail ? 1 : 0);

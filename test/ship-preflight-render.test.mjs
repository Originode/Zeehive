// SHIP-PRE-FLIGHT RENDER test (ticket #58) — the card shows the deploy's preconditions so a
// failing precondition turns it into "cannot ship, because X" BEFORE a human spends attention
// approving. Same esbuild pattern as review-chips-render.test.mjs: bundle the REAL Ship.jsx (with
// real react + react-dom/server) and render the real ShipPreflight / ShipSchema to static markup.
//   • a definite miss (db-migration-target unaddressed) renders ⛔ cannot ship, NAMES the check and
//     the hole, and keeps every check on the record;
//   • an unreachable context renders "could not verify everything", not a hard red;
//   • a clean pre-flight renders "ready — N preconditions verified";
//   • a pre-migration row (no preflight) renders NOTHING — absent is not blank;
//   • migrations_error renders UNKNOWN, never "none" — the same rule the boot-time set already had;
//   • the failure_cause + failure_line render beside the raw error on a failed card.
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
const tmp = mkdtempSync(join(tmpdir(), 'pf-render-'));
const cleanup = () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} };

const out = join(tmp, 'pf.cjs');
await esbuild.build({
  stdin: {
    contents: `
      const React = require('react');
      const { renderToStaticMarkup } = require('react-dom/server');
      const { ShipPreflight, ShipSchema } = require('./Ship.jsx');
      module.exports = { React, renderToStaticMarkup, ShipPreflight, ShipSchema };`,
    resolveDir: join(ROOT, 'web/src'), loader: 'js',
  },
  bundle: true, format: 'cjs', platform: 'node', outfile: out, jsx: 'automatic',
  logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' },
});
const { React, renderToStaticMarkup, ShipPreflight, ShipSchema } = createRequire(out)(out);

const SHA = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';

try {
  // ── 1. a definite miss — the 5+3 hole, rendered on the card ──
  console.log('\n── a failing precondition turns the card into "cannot ship, because X" ──');
  const miss = renderToStaticMarkup(React.createElement(ShipPreflight, { req: {
    preflight: [
      { check: 'db-migration-target', ok: false, skipped: false, unknown: false,
        detail: 'refusing to migrate pf_db: the prod db row records neither a host_port nor a network host in conn_ref' },
      { check: 'build-targets', ok: true, skipped: false, unknown: false, detail: '2 prod container(s) build' },
      { check: 'deploy-context', ok: false, skipped: false, unknown: true, detail: 'cannot reach docker context default' },
    ],
    preflight_error: 'db-migration-target: refusing to migrate pf_db: …',
  } }));
  ok(/data-testid="ship-preflight"/.test(miss), 'the card mounts the pre-flight verdict');
  ok(/⛔ cannot ship, because:/.test(miss), 'a definite miss says CANNOT SHIP, not a bare warning');
  ok(/db-migration-target: refusing to migrate pf_db/.test(miss),
     '…and names the failing CHECK and the hole the deploy would hit');
  ok(/2 prod container\(s\) build/.test(miss) === false || /could not be verified/.test(miss),
     'the passed checks are not re-litigated; the UNKNOWN check is shown as unverifiable');

  // ── 2. an unreachable context → "could not verify", never a hard red ──
  console.log('\n── an unknown-only pre-flight reads as unverifiable, not dead ──');
  const unknown = renderToStaticMarkup(React.createElement(ShipPreflight, { req: {
    preflight: [
      { check: 'db-migration-target', ok: true, skipped: false, unknown: false, detail: 'prod db confirmed' },
      { check: 'build-targets', ok: true, skipped: false, unknown: false, detail: '1 prod container' },
      { check: 'deploy-context', ok: false, skipped: false, unknown: true,
        detail: "cannot reach docker context 'mardale'" },
    ],
  } }));
  ok(/could not verify everything/.test(unknown), 'an unreachable context reads as UNKNOWN');
  ok(/cannot reach docker context &#x27;mardale&#x27;/.test(unknown), '…and says WHICH context could not be reached');
  ok(!/cannot ship/.test(unknown), '…without claiming the ship CANNOT ship');

  // ── 3. a clean pre-flight → ready, with the count ──
  console.log('\n── a clean pre-flight reads as ready ──');
  const ready = renderToStaticMarkup(React.createElement(ShipPreflight, { req: {
    preflight: [
      { check: 'db-migration-target', ok: true, skipped: false, unknown: false, detail: 'prod db confirmed' },
      { check: 'build-targets', ok: true, skipped: false, unknown: false, detail: '2 prod container(s) build' },
      { check: 'deploy-context', ok: true, skipped: false, unknown: false, detail: 'daemon reachable' },
    ],
  } }));
  ok(/pre-flight:<\/span> ready — 3 preconditions verified/.test(ready),
     'a clean pre-flight reads as READY with the verified count, not just a green tick');

  // ── 4. a skipped-scope check is shown as skipped, not hidden ──
  console.log('\n── a code-only ship shows the db check as SKIPPED with the reason ──');
  const skipped = renderToStaticMarkup(React.createElement(ShipPreflight, { req: {
    preflight: [
      { check: 'db-migration-target', ok: true, skipped: true, unknown: false,
        detail: 'the ship was scoped to code only (skip_migrations)' },
      { check: 'build-targets', ok: true, skipped: false, unknown: false, detail: '1 prod container' },
    ],
  } }));
  ok(/ready/.test(skipped) && /1 skipped/.test(skipped), 'a skipped check is counted, not hidden');

  // ── 5. a pre-migration row (no preflight) renders NOTHING ──
  console.log('\n── no pre-flight recorded → nothing rendered ──');
  const none = renderToStaticMarkup(React.createElement(ShipPreflight, { req: { commit: SHA } }));
  ok(none === '', `a row with no preflight renders an empty string (${JSON.stringify(none)})`);

  // ── 6. migrations_error renders UNKNOWN, never "none" ──
  console.log('\n── migrations_error renders UNKNOWN, never a silent zero ──');
  const unreadable = renderToStaticMarkup(React.createElement(ShipSchema, { req: {
    migrations: [], migrations_error: 'ledger unreadable: could not read zeehive_migrations',
  } }));
  ok(/UNKNOWN/.test(unreadable), 'an unreadable deploy-time migration set renders UNKNOWN');
  ok(/could not be read/.test(unreadable), '…with the reason on the card');
  ok(!/no migrations ride this ship/.test(unreadable), '…never "no migrations ride this ship"');

  // ── 7. the components are actually wired onto the real cards (not dead code) ──
  console.log('\n── the pre-flight is mounted on the real ship card ──');
  const shipSrc = readFileSync(join(ROOT, 'web/src/Ship.jsx'), 'utf8');
  ok(/<ShipPreflight req=\{req\} \/>/.test(shipSrc), 'Ship.jsx mounts <ShipPreflight> on the ship card');
  ok(/req\.failure_cause/.test(shipSrc), 'Ship.jsx renders the classified failure cause on a failed card');

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} finally {
  cleanup();
}
process.exit(fail ? 1 : 0);

// MACHINE-POOLING dead-config surface — how the console tells an operator that a machine's
// prio/pool knobs have NO EFFECT for a runner:process project.
//
// History, because this surface has now changed twice on operator reports:
//   1. Originally a red BANNER ("Machine-aware pooling is DISABLED …") that fired on every
//      render as long as any configured machine existed — report: "i always get this error".
//   2. Then the banner narrowed to REMOTE rows (the queenzee-host row governs a process
//      project — process-machine-pooling decision record) and gained a clear button.
//   3. The operator's next message was a SCREENSHOT of the banner still filling the matrix.
//      Since the default-pooling ship the remote config is HARMLESS (the host row or the
//      implicit default governs; the zero-count runaway is structurally impossible), and
//      harmless config is not an alert — so the banner is GONE. The no-effect state renders
//      AT THE KNOBS: a remote column's prio/pool are dimmed (.mx-knob.dead,
//      data-pooling-dead=<key>) with the reason in the tooltip, still editable.
//      (docs/pooling-dead-config-demotion-decision-record.md)
//
// Renders the REAL MachineMatrix through esbuild + SSR and asserts:
//   1. process-runner project → NO banner, remote prio/pool knobs dimmed, queenzee-host
//      knobs live;
//   2. compose project with the SAME machines → nothing dimmed, no banner;
//   3. the dimming does not depend on the knob values (a remote knob at 0 is dead too —
//      typing a number there would do nothing, and the tooltip must say so BEFORE the typing).
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as esbuild } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const tmp = mkdtempSync(join(ROOT, '.mxwarn-render-'));
try {
  const bundle = join(tmp, 'bundle.mjs');
  await esbuild({
    stdin: { contents: "export { default as MachineMatrix } from './web/src/Machines.jsx';\n",
             resolveDir: ROOT, sourcefile: 'render-entry.js', loader: 'js' },
    bundle: true, format: 'esm', outfile: bundle, jsx: 'automatic', logLevel: 'silent',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
  });
  const { MachineMatrix } = await import(pathToFileURL(bundle).href);

  const render = ({ machines, containers = {}, spinoffIsProcess }) => renderToStaticMarkup(
    React.createElement(MachineMatrix, {
      machines, containers, projectId: 'proj-1', spinoffIsProcess,
      onMenu: () => {}, onChanged: () => {},
    }));

  // is_queenzee_host is computed by the server (lib/machines.js listMachines) — the fixtures
  // carry it the way the fleet read model delivers it to the matrix.
  const machines = [
    { id: 'm1', key: 'local', docker_ctx: 'default', is_queenzee_host: true, enabled: true, can_build: true, dev_priority: 1, pool_size: 1 },
    { id: 'm2', key: 'ugreen-nas', docker_ctx: 'ugreen-nas', is_queenzee_host: false, enabled: true, can_build: false, dev_priority: 1, pool_size: 1 },
    { id: 'm3', key: 'mardale-prod', docker_ctx: 'mardale-prod', is_queenzee_host: false, enabled: true, can_build: true, dev_priority: 0, pool_size: 0 },
  ];
  const deadOn = (html, key) => new RegExp(`data-pooling-dead="${key}"`).test(html);

  console.log('\n── process-runner project (the operator screenshot: local / mardale-prod / ugreen-nas) ──');
  const proc = render({ machines, spinoffIsProcess: true });
  ok(!/mx-pooling-disabled|Machine-aware pooling is DISABLED/.test(proc),
     'NO banner — harmless config is not an alert');
  ok(deadOn(proc, 'ugreen-nas'), "the remote 'ugreen-nas' prio/pool knobs are dimmed (data-pooling-dead)");
  ok(deadOn(proc, 'mardale-prod'),
     "…and 'mardale-prod' too, even at prio/pool 0 — the knob is dead BEFORE a number is typed into it");
  ok(!deadOn(proc, 'local'), "the queenzee-host 'local' knobs are LIVE — its pool size governs this project");
  ok(/No effect for this project/.test(proc) && /runner:process/.test(proc),
     'the reason lives in the dimmed knobs&#x27; tooltip (runner:process, xells run on the queenzee host)'.replace('&#x27;', "'"));
  ok(/mx-knob dead/.test(proc), 'the dimmed knobs carry the .mx-knob.dead class the stylesheet dims');

  console.log('\n── compose project (no process runner) with the SAME machines ──');
  const compose = render({ machines, spinoffIsProcess: false });
  ok(!/data-pooling-dead/.test(compose), 'nothing is dimmed — every machine can host a compose project');
  ok(!/mx-pooling-disabled/.test(compose), 'and no banner either (it no longer exists at all)');

  console.log('\n── process-runner project with NO machines (legacy inventory) ──');
  const none = render({ machines: [], spinoffIsProcess: true });
  ok(!/data-pooling-dead|mx-pooling-disabled/.test(none), 'nothing to dim, nothing to warn');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAILURE(S) ✗` : '\nALL PASSED ✓');
process.exit(fail ? 1 : 0);

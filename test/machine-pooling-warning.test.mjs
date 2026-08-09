// MACHINE-POOLING-WARNING test — the console's "Machine-aware pooling is DISABLED" banner.
//
// The user report that started this: "i always get this error in dashboard of zeehive" — a
// process-runner project (e.g. Zeehive itself: server/webapp run as bare processes) that also
// has machine rows configured (dev_priority>0) can never place xells on those machines. The
// banner is the operator-facing half of the pool guard (queenzee/pool.js says the same thing
// in its logline), so the per-machine knobs being dead must not be silent.
//
// The defect this pins: the banner fired on EVERY render with no way to resolve it — the only
// exit it named was "give the server a compose runner", which a process-runner project may
// never want. The fix adds the "clear per-machine pooling" exit: zero dev_priority AND
// pool_size on the named machines for THIS project (the same writers the knobs use), so the
// dead config stops tripping the banner everywhere.
//
// Renders the REAL MachineMatrix through esbuild + SSR in both states and asserts what an
// operator actually reads:
//   1. process-runner + machine dev_priority>0 → the banner AND the clear button draw,
//      naming the machines and the process-runner reason;
//   2. compose project (no process runner) with the same machines → NO banner (placeable);
//   3. process-runner + machines at dev_priority=0 → NO banner (nothing configured to place);
//   4. the clear button is the component's own data-testid so a click path can be driven.
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

  const machines = [
    { id: 'm1', key: 'local', docker_ctx: 'default', enabled: true, can_build: true, dev_priority: 2, pool_size: 1 },
    { id: 'm2', key: 'ugreen-nas', docker_ctx: 'ugreen-nas', enabled: true, can_build: false, dev_priority: 1, pool_size: 2 },
    { id: 'm3', key: 'mardale-prod', docker_ctx: 'mardale-prod', enabled: true, can_build: true, dev_priority: 3, pool_size: 0 },
  ];

  console.log('\n── process-runner project with machines configured (the Zeehive report) ──');
  const warned = render({ machines, spinoffIsProcess: true });
  ok(/mx-pooling-disabled/.test(warned), 'the DISABLED banner draws');
  ok(/Machine-aware pooling is DISABLED/.test(warned), '…with its title');
  ok(/local, ugreen-nas, mardale-prod/.test(warned), '…naming every configured machine (dev_priority>0)');
  ok(/runner:process/.test(warned), '…and the process-runner reason');
  ok(/mx-pooling-clear/.test(warned), '…and offers the "clear per-machine pooling" exit (data-testid=mx-pooling-clear)');
  ok(/clear per-machine pooling/.test(warned), '…whose label says what it does');

  console.log('\n── compose project (no process runner) with the SAME machines ──');
  const placeable = render({ machines, spinoffIsProcess: false });
  ok(!/mx-pooling-disabled/.test(placeable), 'no banner — a compose project is machine-placeable');

  console.log('\n── process-runner project but every machine at dev_priority=0 ──');
  const off = render({
    machines: machines.map((m) => ({ ...m, dev_priority: 0, pool_size: 0 })),
    spinoffIsProcess: true,
  });
  ok(!/mx-pooling-disabled/.test(off), 'no banner — nothing is configured to place (prio 0)');

  console.log('\n── process-runner project with NO machines (legacy inventory) ──');
  const none = render({ machines: [], spinoffIsProcess: true });
  ok(!/mx-pooling-disabled/.test(none), 'no banner — no dead per-machine config to warn about');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAILURE(S) ✗` : '\nALL PASSED ✓');
process.exit(fail ? 1 : 0);

// ADD A MANAGER ZEE — the operator's CLI twin of the console's "⬢ + manager zee" button.
//
//   xell-manager.mjs --task-file <path> [--model sonnet] [--mode 1..5] [--project <name>] [--title "…"]
//   xell-manager.mjs "<brief>"                                  (only for trivial text)
//   xell-manager.mjs                                            (no brief: it studies the project,
//                                                                proposes a plan, and asks you first)
//
// A manager zee runs a CREW: it dispatches worker zees, talks to them in real time, reads their
// post-ship reflections and suggests when one is done (you confirm). It holds the PRODUCTION
// database READ-ONLY — its own postgres role, granted SELECT and nothing else — and it has ZERO
// push/PR access to the xource: it writes no code and lands none.
//
// Adding one is a HUMAN act, and only from here or the console: `zee dispatch` refuses the manager
// role outright, so a manager can never mint another manager. There is no limit on how many you add.
//
// Use --task-file for anything real: a brief typically contains backticks, quotes and `$`, which a
// shell argument mangles (the same reason xell-dispatch.mjs prefers it).
import http from 'node:http';
import { readFileSync } from 'node:fs';

const api = process.env.ZEEHIVE_API || 'http://localhost:4700';
const argv = process.argv.slice(2);

function takeFlag(name) {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = argv[i];
  const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[i + 1];
  argv.splice(i, a.includes('=') ? 1 : 2);
  return v;
}
const taskFile = takeFlag('task-file');
const model = takeFlag('model');
const mode = takeFlag('mode');
const title = takeFlag('title');
const project = takeFlag('project') || process.env.ZEEHIVE_PROJECT;

let task = argv[0] || '';
if (taskFile) {
  try { task = readFileSync(taskFile, 'utf8'); }
  catch (e) { console.log(`cannot read --task-file ${taskFile}: ${e.message}`); process.exit(0); }
}

const body = JSON.stringify({
  cwd: process.cwd(),                      // the project handover, same as a dispatch
  ...(project ? { project } : {}),
  ...(task.trim() ? { task } : {}),        // empty → the default "study, then propose" brief
  ...(model ? { model } : {}),
  ...(mode ? { mode } : {}),
  ...(title ? { title } : {}),
});

console.log('Adding a MANAGER zee: it will hold production READ-ONLY (SELECT-only role) and has no '
  + 'push access to the xource. Its workers land their own work.');

const req = http.request(`${api}/api/managers`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
}, (res) => {
  let b = '';
  res.on('data', (c) => (b += c));
  res.on('end', () => {
    if (res.statusCode >= 400) { console.log(`Could not add a manager zee (HTTP ${res.statusCode}): ${b}`); process.exit(0); }
    console.log(`MANAGER ZEE ADDED:\n${b}`);
  });
});
req.on('error', (e) => { console.log(`queenzee API unreachable at ${api}: ${e.message}`); process.exit(0); });
req.write(body);
req.end();

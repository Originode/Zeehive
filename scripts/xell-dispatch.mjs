// Called by the /xell skill AFTER the human confirms an auto-dispatch (when /xell was run
// outside a worktree). Tells the queenzee to spawn a zee INTO a ready xell's worktree to run
// the task, and prints the result.
//
//   xell-dispatch.mjs <xell_id> --task-file <path> [--mode 1..5] [--project <name>]  ← PREFERRED
//   xell-dispatch.mjs <xell_id> "<task>"           [--mode 1..5]     (only for trivial text)
//
// The project comes from this process's cwd (the invoking session's repo), or --project.
//
// Use --task-file for anything real. A task description typically contains backticks, quotes and
// `$`; passing it as a shell argument gets mangled or fails outright ("unexpected EOF while
// looking for matching"). Write the task to a file with the Write tool (no shell involved), then
// point this at it.
//
// --mode = how much autonomy the zee gets (default 5):
//   1 plan   read-only recon — investigates, changes nothing
//   2 edits  edit files, no shell
//   3 shell  edit files + run shell
//   4 auto   all tools, auto-accept edits
//   5 bypass bypass all permission prompts (fully unattended)
// A headless zee has nobody to answer a prompt, so 2–4 can STALL on a tool outside their
// allow-list; 5 is the one that always runs unattended.
import http from 'node:http';
import { readFileSync } from 'node:fs';

const api = process.env.XEEHIVE_API || 'http://localhost:4700';
const argv = process.argv.slice(2);

// pull `--flag value` / `--flag=value` out of argv without disturbing the positionals
function takeFlag(name) {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = argv[i];
  const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[i + 1];
  argv.splice(i, a.includes('=') ? 1 : 2);
  return v;
}
const mode = takeFlag('mode');
const taskFile = takeFlag('task-file');
// --model: zees default to opus (they run unattended). Pass sonnet for cheap/simple jobs.
const model = takeFlag('model');
// Which database the zee works against (default: the shared dev db).
//   --db shared-dev | shared-prod | isolated
//   --dump latest|<snapshot-id>   with --db isolated: its own postgres restored from that dump
//   --db-container <name|id>      attach a specific db container outright
// --db shared-prod is LIVE PRODUCTION: writes are real and irreversible.
// --project <name|id>: which project to dispatch into. Normally unnecessary — the queenzee
// resolves it from this process's cwd (the invoking session's repo/worktree). Pass it when the
// session is outside any managed repo, or to dispatch into a project you are not standing in.
// A named <xell_id> always wins: its own project is a fact, not an inference.
const project = takeFlag('project') || process.env.XEEHIVE_PROJECT;
const dbArg = takeFlag('db');
const dump = takeFlag('dump');
const dbContainer = takeFlag('db-container');
const db = dbArg ? (dbArg.startsWith('db-') ? dbArg : `db-${dbArg}`) : (dump ? 'db-isolated' : undefined);
// --attended: the zee is told a human CAN open the session and answer, so it may stop and ask on a
// genuinely load-bearing decision. Default (unattended) tells it to decide and keep going.
const attended = argv.includes('--attended');
if (attended) argv.splice(argv.indexOf('--attended'), 1);

const xellId = argv[0] || '';
let task = argv[1] || '';
if (taskFile) {
  try { task = readFileSync(taskFile, 'utf8'); }
  catch (e) { console.log(`cannot read --task-file ${taskFile}: ${e.message}`); process.exit(0); }
}
if (!task.trim()) {
  console.log('usage: xell-dispatch.mjs <xell_id> --task-file <path> [--mode 1..5]');
  process.exit(0);
}

// session_id = the INVOKING session — the spawned headless zee inherits its title (it never
// titles itself, so without this the dashboard's `session` field is just a dash).
const body = JSON.stringify({
  xell_id: xellId || undefined,
  task,
  session_id: process.env.CLAUDE_CODE_SESSION_ID || undefined,
  // the project handover: where the invoking session is standing
  cwd: process.cwd(),
  ...(project ? { project } : {}),
  ...(attended ? { headless: false } : {}),
  ...(mode ? { mode } : {}),
  ...(model ? { model } : {}),
  ...(db ? { db } : {}),
  ...(dump ? { dump } : {}),
  ...(dbContainer ? { db_container: dbContainer } : {}),
});
if (db === 'db-shared-prod' || /(^|_)prod/.test(dbContainer || '')) {
  console.log('⚠ This dispatch attaches the LIVE PRODUCTION database. The zee\'s writes are real and irreversible.');
}
const req = http.request(`${api}/api/xell/dispatch`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
}, (res) => {
  let b = '';
  res.on('data', (c) => (b += c));
  res.on('end', () => {
    if (res.statusCode >= 400) { console.log(`Dispatch failed (HTTP ${res.statusCode}): ${b}`); process.exit(0); }
    console.log(`DISPATCHED — a zee is spawning in the worktree to do the task:\n${b}`);
  });
});
req.on('error', (e) => { console.log(`queenzee API unreachable at ${api}: ${e.message}`); process.exit(0); });
req.write(body);
req.end();

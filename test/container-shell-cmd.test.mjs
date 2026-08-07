// CONTAINER SHELL-CMD test — the copyable docker-exec command a container shell window's footer
// shows (the container analogue of a cxell zee's `ssh -i … zee@host` line).
//
// The command is computed SERVER-side (fleet.js containerShellCmd) because only the server knows
// the REAL shell target (terminal-bridge resolveShellTarget): a db row carries a LOGICAL name that
// must resolve to the versioned container; a PROCESS-ROLE server/webapp has no container of its own
// — its shell is the queenzee's own container at the xell's worktree. This test pins the command
// for all three shapes plus the named-context prefix, against the real function.
//
// Session retention: the footer (and the bridge) open `tmux new -A -s zh-<id>` so closing the
// modal and reopening lands in the SAME pane — the queenzee-node bug this locks. The session name
// is derived from the container row id so process-role xells sharing one queenzee container do not
// collide.
import { containerShellCmd } from '../server/src/lib/fleet.js';
import { containerShellSessionName, containerShellInnerCmd } from '../server/src/lib/terminal-bridge.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// A minimal project whose spinoff tier is a process runner.
const procProject = { manifest: { tiers: { spinoff: { runner: 'process' } } } };
const composeProject = { manifest: { tiers: { spinoff: { runner: 'compose' } } } };

const ID_A = 'a3b56748-74f0-4a31-b4a7-37809849f68f';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sessA = containerShellSessionName(ID_A);
const sessB = containerShellSessionName(ID_B);

console.log('session name is stable, unique per container row, shell-safe:');
ok(sessA === 'zh-a3b5674874f04a31', `hex-prefix form (got ${sessA})`);
ok(sessA !== sessB, 'two container ids never share a session name');
ok(containerShellSessionName(ID_A) === sessA, 'same id → same name every call (reconnect must hit the same pane)');
ok(/^[a-z0-9_-]+$/.test(sessA), 'sanitised for tmux + shell interpolation');
ok(containerShellSessionName('not a uuid!!!') === 'zh-shell'
   || containerShellSessionName('not a uuid!!!').startsWith('zh-'),
   'garbage id still yields a legal fallback name');

console.log('inner cmd is tmux attach-or-create with a bash fallback (images without tmux):');
const inner = containerShellInnerCmd(sessA);
ok(inner.includes(`tmux new-session -d -s ${sessA}`), 'creates the named session detached when missing');
ok(inner.includes(`tmux attach-session -t ${sessA}`), 'every open attaches (session survives the modal)');
ok(/env -u ZEEHIVE_SHELL_MARK tmux new-session/.test(inner),
   'create strips ZEEHIVE_SHELL_MARK so the pane shell is not reaped on modal close');
ok(/exec tmux attach-session/.test(inner),
   'attach keeps the mark on THIS client (exec replaces sh; reap can still detach it)');
ok(/set -g mouse on/.test(inner), 'enables mouse (wheel scroll under alt-screen)');
ok(/window-size latest/.test(inner), 'sizes to the most recent client');
ok(/command -v tmux/.test(inner) && /exec bash/.test(inner),
   'falls back to bash/sh when the image has no tmux (postgres/alpine)');
ok(!inner.includes(';') || inner.includes('\\;'),
   'tmux command separators are escaped for the outer sh -c');

console.log('a real compose server/webapp container — the row name IS the docker name:');
ok(containerShellCmd(composeProject, { id: ID_A, role: 'server', name: 'omnibiz_server_dev', docker_ctx: 'default' })
   === `docker exec -it omnibiz_server_dev tmux new -A -s ${sessA}`,
   'plain form without a named context opens the retained tmux session');
ok(containerShellCmd(composeProject, { id: ID_A, role: 'webapp', name: 'omnibiz_web_dev', docker_ctx: 'ugreen-nas' })
   === `docker --context ugreen-nas exec -it omnibiz_web_dev tmux new -A -s ${sessA}`,
   'a named context rides --context');

console.log('a db row carries a LOGICAL name — the command targets the REAL versioned container:');
const dbCmd = containerShellCmd(composeProject, { id: ID_A, role: 'db', name: 'omnibiz_db_dev', docker_ctx: 'default' });
ok(new RegExp(`^docker exec -it omnibiz_db_dev(_v\\d+)? tmux new -A -s ${sessA}$`).test(dbCmd),
   `logical name resolves to a real name + retained session (got: ${dbCmd})`);
const dbCtxCmd = containerShellCmd(composeProject, { id: ID_A, role: 'db', name: 'omnibiz_db_dev', docker_ctx: 'ugreen-nas' });
ok(dbCtxCmd.startsWith('docker --context ugreen-nas exec -it omnibiz_db_dev')
   && dbCtxCmd.endsWith(`tmux new -A -s ${sessA}`),
   'a db on a named context still rides --context and keeps the session');

console.log('a PROCESS-ROLE server/webapp has no container of its own — the shell is the queenzee at the worktree:');
const proc = containerShellCmd(procProject, {
  id: ID_A, role: 'server', name: 'zeehive_spin_server_x', owner_xell_id: 'x',
  docker_ctx: null, owner_worktree: '/repos/Zeehive/.claude/worktrees/slug',
});
ok(proc.startsWith('docker exec -it ') && proc.includes(` tmux new -A -s ${sessA}`),
   'execs the queenzee into the retained tmux session');
ok(proc.includes(` -w /repos/Zeehive/.claude/worktrees/slug `),
   'and -w the worktree — where the bridge opens the shell (WorkingDir)');
ok(!proc.includes(`--context`), 'no --context for the queenzee container (it is on the local daemon)');
const procNoWt = containerShellCmd(procProject, {
  id: ID_B, role: 'server', name: 'x', owner_xell_id: 'x', docker_ctx: null, owner_worktree: null,
});
ok(procNoWt.endsWith(` tmux new -A -s ${sessB}`) && !procNoWt.includes(' -w '),
   'a process role with no known worktree still gives a retained tmux exec');
ok(containerShellSessionName(ID_A) !== containerShellSessionName(ID_B),
   'two process-role xells on the same queenzee container get DIFFERENT sessions');

console.log('non-owner real containers (shared prod) are plain docker execs, not process-role:');
ok(containerShellCmd(composeProject, {
  id: ID_A, role: 'server', name: 'omnibiz_server_prod', owner_xell_id: null, docker_ctx: 'mardale-prod',
}) === `docker --context mardale-prod exec -it omnibiz_server_prod tmux new -A -s ${sessA}`,
   'a SHARED prod server is a real container with a retained session');

console.log('the bridge openContainerShell path wires the same helpers (source pin):');
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const bridge = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)),
  '../server/src/lib/terminal-bridge.js'), 'utf8');
ok(/containerShellSessionName\(c\.id\)/.test(bridge), 'openContainerShell names the session from the container row id');
ok(/containerShellInnerCmd\(sessionName\)/.test(bridge), 'and runs the attach-or-create inner cmd');
ok(/ZEEHIVE_SHELL_MARK/.test(bridge) && /kill -9/.test(bridge),
   'still reaps THIS attach client on close (tmux session stays; one-shot bash dies)');

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures ? 1 : 0);

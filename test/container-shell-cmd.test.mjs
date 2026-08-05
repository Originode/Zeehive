// CONTAINER SHELL-CMD test — the copyable docker-exec command a container shell window's footer
// shows (the container analogue of a cxell zee's `ssh -i … zee@host` line).
//
// The command is computed SERVER-side (fleet.js containerShellCmd) because only the server knows
// the REAL shell target (terminal-bridge resolveShellTarget): a db row carries a LOGICAL name that
// must resolve to the versioned container; a PROCESS-ROLE server/webapp has no container of its own
// — its shell is the queenzee's own container at the xell's worktree. This test pins the command
// for all three shapes plus the named-context prefix, against the real function.
import { containerShellCmd } from '../server/src/lib/fleet.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// A minimal project whose spinoff tier is a process runner.
const procProject = { manifest: { tiers: { spinoff: { runner: 'process' } } } };
const composeProject = { manifest: { tiers: { spinoff: { runner: 'compose' } } } };

console.log('a real compose server/webapp container — the row name IS the docker name:');
ok(containerShellCmd(composeProject, { role: 'server', name: 'omnibiz_server_dev', docker_ctx: 'default' })
   === 'docker exec -it omnibiz_server_dev bash', 'plain form without a named context');
ok(containerShellCmd(composeProject, { role: 'webapp', name: 'omnibiz_web_dev', docker_ctx: 'ugreen-nas' })
   === 'docker --context ugreen-nas exec -it omnibiz_web_dev bash', 'a named context rides --context');

console.log('a db row carries a LOGICAL name — the command targets the REAL versioned container:');
const dbCmd = containerShellCmd(composeProject, { role: 'db', name: 'omnibiz_db_dev', docker_ctx: 'default' });
ok(/^docker exec -it omnibiz_db_dev(_v\d+)? bash$/.test(dbCmd), `logical name resolves to a real name (got: ${dbCmd})`);
const dbCtxCmd = containerShellCmd(composeProject, { role: 'db', name: 'omnibiz_db_dev', docker_ctx: 'ugreen-nas' });
ok(dbCtxCmd.startsWith('docker --context ugreen-nas exec -it omnibiz_db_dev'),
   'a db on a named context still rides --context');

console.log('a PROCESS-ROLE server/webapp has no container of its own — the shell is the queenzee at the worktree:');
const proc = containerShellCmd(procProject, { role: 'server', name: 'zeehive_spin_server_x', owner_xell_id: 'x', docker_ctx: null, owner_worktree: '/repos/Zeehive/.claude/worktrees/slug' });
ok(proc.startsWith('docker exec -it ') && proc.includes(' bash'), 'execs a docker container (the queenzee)');
ok(proc.includes(`cd /repos/Zeehive/.claude/worktrees/slug`), 'and cd\'s to the worktree — where the bridge opens the shell');
ok(!proc.includes(`--context`), 'no --context for the queenzee container (it is on the local daemon)');
const procNoWt = containerShellCmd(procProject, { role: 'server', name: 'x', owner_xell_id: 'x', docker_ctx: null, owner_worktree: null });
ok(procNoWt.endsWith(' bash') && !procNoWt.includes('cd '), 'a process role with no known worktree still gives a plain bash exec');

console.log('non-owner real containers (shared prod) are plain docker execs, not process-role:');
ok(containerShellCmd(composeProject, { role: 'server', name: 'omnibiz_server_prod', owner_xell_id: null, docker_ctx: 'mardale-prod' })
   === 'docker --context mardale-prod exec -it omnibiz_server_prod bash', 'a SHARED prod server is a real container');

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures ? 1 : 0);

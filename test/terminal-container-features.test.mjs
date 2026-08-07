// TERMINAL CONTAINER-FEATURES test — the container shell window must carry the SAME features as the
// xell ssh window.
//
// The zee door (ZeeTerminal) grew a file explorer, clickable paths, a copyable command footer, feed
// chips and talk. A container shell (ContainerTerminal) shares the SAME TerminalModal body, so it
// already got the clipboard tray and fullscreen — but it used to stop there: no explorer, no
// clickable paths, no footer. This pins that the container door now offers the features that make
// sense for a container (the zee-only feed chips and talk stay on the zee door):
//   1. ContainerTerminal hands TerminalModal an explorer target (explorerContainer) — the same 📁
//      button + clickable-path behaviour the zee door gets;
//   2. its footer carries a copyable docker exec command (the container analogue of the xell ssh
//      command) with a copy button and the Shift+drag clipboard hint;
//   3. the shared TerminalModal renders the explorer for EITHER door, and keeps the feed chips and
//      talk zee-only.
// Static source check (the repo's app-dialog-imports pattern): the terminal is plain JSX.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, '../web/src/ZeeTerminal.jsx'), 'utf8');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const head = src.slice(src.indexOf('<div className={`term-head'), src.indexOf('<div className="zeeterm-main"'));
const main = src.slice(src.indexOf('<div className="zeeterm-main"'));

console.log('\n── the container door passes an explorer target to the shared modal ──');
ok(/export function ContainerTerminal/.test(src), 'ContainerTerminal exists');
ok(/explorerContainer=\{c\}/.test(src), 'hands the container to TerminalModal as the explorer target');
ok(/wsPath=\{`\/api\/containers\/\$\{c\.id\}\/terminal`\}/.test(src), 'and still opens the container shell websocket');
ok(/prod=\{c\.tier === 'prod'\}/.test(src), 'prod styling is untouched');

console.log('\n── the shared modal renders the explorer for EITHER door ──');
ok(/explorerZeeId \|\| explorerContainer/.test(src), 'the explorer (📁 button, clickable paths, panel) is gated on either target');
ok(/<FileExplorer zeeId=\{explorerZeeId\} container=\{explorerContainer\}/.test(src),
   'and the FileExplorer is given whichever target the door carries');
ok(/export function TerminalModal\(\{[^}]*explorerContainer = null/.test(src),
   'the prop defaults to null (a bare terminal stays bare)');

console.log('\n── the zee-only features stay on the zee door ──');
ok(/\{explorerZeeId && <FeedChips/.test(src), 'feed chips still render only for a cxell zee (no feed to filter in a container)');
ok(/\{xell\?\.id && \(/.test(src), 'talk still renders only when a xell is given (no zee to converse with in a container)');

console.log('\n── the container door has a copyable docker exec footer (the ssh-command analogue) ──');
ok(/const dockerCmd = c\.shell_cmd \|\|/.test(src), 'prefers the server-computed shell command (fleet.js containerShellCmd)');
ok(/docker exec -it/.test(src), 'builds a docker exec command');
ok(/exec -it'\) \+ ` \$\{c\.name\} bash`/.test(src),
   'and falls back to a docker exec by container name when the server did not send shell_cmd');
ok(/<div className="zeeterm-foot">/.test(src), 'renders the same footer bar the zee door uses');
ok(/⧉ copy/.test(src) && /copied/.test(src), 'with a copy button + copied feedback');
ok(/Shift\+drag/.test(src) && /📋 clipboard/.test(src), 'and the Shift+drag clipboard hint');
ok(/<input className="mono" readOnly value=\{dockerCmd \|\| ''\}/.test(src), 'the command sits in a selectable read-only input');

console.log('\n── the container explorer is backed by the docker-exec fs bridge ──');
const fe = readFileSync(resolve(here, '../web/src/FileExplorer.jsx'), 'utf8');
ok(/listContainerDir/.test(fe) && /readContainerFile/.test(fe), 'FileExplorer imports the container fs API');
ok(/if \(container\) return listContainerDir\(container\.id, path\)/.test(fe), 'and lists against a container when one is the target');

// PASTE: xterm already turns the browser paste event into onData → the PTY. A custom KeyV handler
// that ALSO read navigator.clipboard and sent {t:'i'} made every Ctrl/Cmd+V land twice. Copy still
// needs the custom path (canvas selection is not a browser selection).
console.log('\n── paste is a single path (no double-paste on Ctrl/Cmd+V) ──');
ok(/attachCustomKeyEventHandler/.test(src), 'custom key handler still installed (for copy)');
ok(/e\.code === 'KeyC'/.test(src) && /capture\(term\.getSelection\(\)\)/.test(src),
   'Ctrl/Cmd+C still captures the xterm selection into the tray');
ok(!/e\.code === 'KeyV'/.test(src) && !/clipboard\?\.readText/.test(src),
   'no KeyV / clipboard.readText path — paste rides onData only, once');
ok(/onData:\s*\(d\)\s*=>\s*\{[^}]*ws\.send\(JSON\.stringify\(\{\s*t:\s*'i'/.test(src)
   || /onData: \(d\) => \{ if \(ws\.readyState === 1\) ws\.send\(JSON\.stringify\(\{ t: 'i', d \}\)\)/.test(src),
   'keystrokes and native paste still go out as {t:\'i\'} frames');

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures ? 1 : 0);

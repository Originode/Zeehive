// TERMINAL FEED-FILTER test — the ✱ thinking / ⚒ moves buttons on the zee terminal, from the
// browser to the cage.
//
// A cxell zee's terminal streams its transcript while it works: ✱ thinking, ● what it says, ⚒ every
// tool call with its ↳ result. That is a firehose, and there was no way to turn either half of it
// down. The buttons are the switch — but the pane they ride on is NOT ours: the moment the turn
// ends, `claude --resume` owns it, and anything we "typed" to filter the feed would land in the
// zee's prompt box. So the design this test pins is: the chips never send KEYSTROKES. They send a
// {t:'v'} frame; the bridge writes a two-boolean view file over a second SSH channel; the renderer
// inside the cage watches that file (test/zee-live-view.test.mjs covers the far end).
//
// Unit assertions on the bridge's pure helpers + a static read of the JSX/CSS, the repo's
// app-dialog-imports / terminal-explorer-button pattern. No DB, no docker, no ssh, no browser.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const { zeeLiveViewCommand, parseZeeLiveViewReply, ZEE_LIVE_VIEW_FILE, CTRL_PREFIX } =
  await import('../server/src/lib/terminal-bridge.js');

// ── the remote command: two booleans, nothing else ────────────────────────────────────────────
console.log('\n── the view command the bridge runs in the cxell ──');
const write = zeeLiveViewCommand({ thinking: false, moves: true }, true);
ok(write.includes(`'{"thinking":false,"moves":true}'`), 'writes the chosen view as JSON');
ok(write.includes(`> ${ZEE_LIVE_VIEW_FILE}.tmp`) && write.includes(`mv -f ${ZEE_LIVE_VIEW_FILE}.tmp ${ZEE_LIVE_VIEW_FILE}`),
   `into ${ZEE_LIVE_VIEW_FILE} ATOMICALLY (a poll landing in a truncate would read an empty view and repaint twice)`);
ok(/pgrep -f 'node \.\*zee-live\[\.\]mjs'/.test(write),
   'and asks whether a live feed is running — matching the INTERPRETER too, so the installer\'s own shell (bash -lc … /tmp/zee-live.mjs) cannot pass for a feed');
ok(write.includes('ZH-LIVE') && write.includes('ZH-READY'),
   'answering TWO questions: is any feed up, and is a view-WATCHING renderer alive');
ok(/kill -0 "\$r"/.test(write),
   'proving the announced pid is still ALIVE (a marker left by a dead feed proves nothing)');
ok(!/ZH-PID/.test(write),
   'and never comparing pgrep\'s pid to the marker: pgrep -f matches whole command lines, so a shell whose argv contains the script name can shadow the real renderer (seen live: PID 10994 vs READY 11002)');
ok(write.includes(`${ZEE_LIVE_VIEW_FILE}.ready`), 'the announcement marker zee-live.mjs writes when it starts watching');
ok(write.includes(`cat ${ZEE_LIVE_VIEW_FILE}`), 'and reads the view back, so the client is told the TRUTH, not its own guess');

const readOnly = zeeLiveViewCommand(null, false);
ok(!readOnly.includes('printf') && !readOnly.includes('mv -f'),
   'the attach-time poll writes NOTHING (it only reports what the cage already holds)');

// The one thing that must never be interpolated: anything a browser sent.
const evil = zeeLiveViewCommand({ thinking: `'; rm -rf / #`, moves: { $ne: 1 } }, true);
ok(/^printf '%s' '\{"thinking":true,"moves":true\}'/.test(evil),
   'a hostile frame is reduced to two booleans — no client string ever reaches the shell');
ok(!evil.includes('rm -rf'), 'nothing of the payload survives into the command');
ok(zeeLiveViewCommand({ thinking: false, moves: false }, true).includes('"thinking":false,"moves":false'),
   'and both-off is expressible (false is a value, not "missing")');

// ── the reply the client is sent ──────────────────────────────────────────────────────────────
console.log('\n── parsing what the cxell answered ──');
const live = parseZeeLiveViewReply('ZH-READY 412\nZH-LIVE\n{"thinking":false,"moves":true}\n');
ok(live.t === 'v' && live.thinking === false && live.moves === true && live.live === true,
   'a running feed with a view file is reported exactly');
ok(live.filterable === true, 'and it is FILTERABLE: the running pid is the one that announced itself');
// The case that reached a human as "the buttons dont work": a cxell from an older image.
const stale = parseZeeLiveViewReply('ZH-READY\nZH-LIVE\n{"thinking":false,"moves":true}\n');
ok(stale.live === true && stale.filterable === false,
   'a feed with NO announcement is live but NOT filterable (an older renderer that ignores the view file)');
ok(parseZeeLiveViewReply('ZH-READY\nZH-LIVE\n').filterable === false,
   'a marker whose pid is no longer alive does not count either — the shell only echoes one it could kill -0');
ok(parseZeeLiveViewReply('ZH-READY 412\nZH-IDLE\n').live === true,
   'and a watching renderer is live even if the loose pgrep missed it — the precise signal wins');
const idle = parseZeeLiveViewReply('ZH-READY\nZH-IDLE\n');
ok(idle.live === false && idle.filterable === false && idle.thinking === true && idle.moves === true,
   'no feed + no view file = idle, showing everything (the renderer\'s own default)');
ok(parseZeeLiveViewReply('ZH-READY\nZH-IDLE\n{ half-writ').thinking === true,
   'a half-written view file falls back to showing everything, never to hiding output');
ok(parseZeeLiveViewReply(null).live === false, 'and a dead channel answers idle instead of throwing');

// ── the control frame cannot be mistaken for terminal output ──────────────────────────────────
console.log('\n── the down-channel: control frames vs terminal bytes ──');
ok(CTRL_PREFIX.charCodeAt(0) === 0, 'control frames are tagged with a NUL (never present in the ANSI a shell emits)');
const jsx = read('web/src/ZeeTerminal.jsx');
ok(jsx.includes("const CTRL_PREFIX = '\\u0000ZH'"), 'and the browser side spells the SAME prefix');
ok(read('server/src/lib/terminal-bridge.js').includes("export const CTRL_PREFIX = '\\u0000ZH'"),
   'as the bridge (one constant, two files — asserted here so they cannot drift apart)');
const onmsg = jsx.slice(jsx.indexOf('ws.onmessage'), jsx.indexOf('ws.onclose'));
ok(/startsWith\(CTRL_PREFIX\)/.test(onmsg), 'onmessage checks the prefix BEFORE writing to xterm');
ok(/return;/.test(onmsg) && onmsg.indexOf('return;') < onmsg.indexOf('term.write'),
   'a control frame returns instead of being painted as garbage in the terminal');
ok(/catch\s*{/.test(onmsg), 'a malformed control frame cannot kill the terminal');
ok(/filterable: m\.filterable !== false/.test(onmsg),
   "and the frame's `filterable` is KEPT — dropping it is how the \"older feed\" warning would silently never appear");

// ── the buttons ───────────────────────────────────────────────────────────────────────────────
// (their LEGIBILITY — the "can't tell if it's pressed" defect — is pinned by
//  test/terminal-feed-chips.test.mjs, which renders the real component in both states.)
console.log('\n── the ✱ / ⚒ buttons in the terminal header ──');
const head = jsx.slice(jsx.indexOf('<div className={`term-head'), jsx.indexOf('<div className="zeeterm-main"'));
ok(/\{explorerZeeId && <FeedChips feed=\{feed\} onToggle=\{setFeedFlag\} \/>\}/.test(head),
   'the header renders FeedChips on the ZEE door only (a container shell has no feed to filter)');
const chips = read('web/src/FeedChips.jsx');
ok(chips.includes('data-testid={`feed-${key}`}'), 'the chips are individually addressable');
ok(chips.includes("chip('thinking', '✱'") && chips.includes("chip('moves', '⚒'"),
   'a ✱ thinking chip and a ⚒ moves chip, labelled with the glyphs the feed itself uses');
ok(/onToggle\(key\)/.test(chips), 'both wired back to the terminal through onToggle');
ok(!/import .*css|@xterm/.test(chips),
   'and the component stays side-effect free, so a test can render it (that is how the legibility bug is now caught)');

const fn = jsx.slice(jsx.indexOf('const setFeedFlag'), jsx.indexOf('const toggleExplorer'));
ok(/t: 'v'/.test(fn), "the toggle sends a {t:'v'} view frame");
ok(!/t: 'i'/.test(fn) && !/sendInput\(/.test(fn),
   'and NEVER a keystroke — the pane belongs to the interactive session once the turn ends');
ok(/readyState === 1/.test(fn), 'only when the socket is open (a closed terminal must not throw)');
ok(/setFeed\(next\)/.test(fn), 'the chip flips immediately (optimistic), and the bridge answers with the truth');

// ── the bridge wires the frame, without disturbing the PTY ────────────────────────────────────
console.log('\n── the bridge: a SECOND channel, not the terminal stream ──');
const bridge = read('server/src/lib/terminal-bridge.js');
const zeeDoor = bridge.slice(bridge.indexOf('async function openTerminal'), bridge.indexOf('// ── container shell'));
ok(/msg\.t === 'v'/.test(zeeDoor), "the zee door handles the {t:'v'} frame");
const apply = zeeDoor.slice(zeeDoor.indexOf('const applyView'), zeeDoor.indexOf("ws.on('message'"));
ok(/conn\.exec\(zeeLiveViewCommand/.test(apply), 'by running the view command on its own exec channel');
ok(!/stream\.write/.test(apply), 'never writing to the PTY stream (no bytes land in whatever owns the pane)');
ok(/if \(!sshReady\)/.test(apply) && /pendingView = view/.test(apply),
   'a chip clicked before SSH is up is QUEUED, not dropped (dropping it would revert the operator a second later)');
ok(/try\s*{/.test(apply) && /catch/.test(apply), 'best-effort: a failed chip must not disturb the terminal it rides on');
ok(/applyView\(null, false\)/.test(zeeDoor), 'on attach it POLLS the cage, so a reopened terminal shows the view in force');
ok(/if \(pendingView\) applyView\(pendingView, true\); else applyView\(null, false\);/.test(zeeDoor),
   'unless a click is already waiting — that wins over the poll');
ok(zeeDoor.indexOf('if (pendingView)') < zeeDoor.indexOf('conn.exec(cmd'),
   'seeded before the PTY exec, so the chips are right from the first frame');

// ── the cage gets a renderer that understands the file ────────────────────────────────────────
console.log('\n── the renderer reaches every cxell, not just freshly-built images ──');
const live_mjs = read('docker/zeehive/zee-live.mjs');
ok(live_mjs.includes('/tmp/zee-live-view.json') && live_mjs.includes('watchFile'),
   'zee-live.mjs watches the same view file the bridge writes');
ok(live_mjs.includes(ZEE_LIVE_VIEW_FILE), 'the exact path, spelled the same on both sides');
const cxell = read('server/src/lib/cxell.js');
ok(/export async function installZeeLiveIntoCxell/.test(cxell),
   'the queenzee installs its OWN zee-live.mjs into each cxell at spawn (the image is a snapshot; the CLI learned this the hard way)');
const { zeeLiveInstallCommands, ZEE_LIVE_DEST, zeeLiveSourcePath } = await import('../server/src/lib/cxell.js');
ok(ZEE_LIVE_DEST === '/usr/local/bin/zee-live.mjs', 'over the path zee-attach.sh actually runs');
ok(resolve(zeeLiveSourcePath()) === resolve(ROOT, 'docker/zeehive/zee-live.mjs'),
   'from the repo\'s authoritative copy (the one the Dockerfile bakes)');
const cmds = zeeLiveInstallCommands({ name: 'cxell_test-slug' });
ok(cmds[0][0] === 'cp' && cmds[0][2].startsWith('cxell_test-slug:'), 'via docker cp');
ok(/-o root -g root/.test(cmds[1].join(' ')), 'root-owned, like the CLI (a zee cannot rewrite its own renderer)');
const intake = read('server/src/queenzee/intake.js');
ok(intake.includes('await installZeeLiveIntoCxell('), 'and the spawn path calls it');

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures ? 1 : 0);

// ZEE-LIVE VIEW test — the ✱ thinking / ⚒ moves chips in the dashboard terminal, at the end where
// they actually take effect: the renderer inside the cxell.
//
// The chips do NOT type into the pane (the interactive session owns it the moment the turn ends —
// a keystroke there would land in the zee's prompt). They write a tiny view file, and zee-live.mjs
// WATCHES it. So the contract this test pins is:
//   a) no view file  → the feed this renderer always drew (thinking + moves + results), unchanged;
//   b) a view file   → the hidden kind is absent, everything else is untouched;
//   c) a change MID-STREAM repaints — what already scrolled past is redrawn under the new view, so
//      "hide" means hidden rather than "quieter from here on", and toggling back brings it back;
//   d) the watcher never wedges the process: stdin ending still ends the renderer (zee-attach.sh
//      kills it too, but a renderer that outlives its transcript would pin a fifo open).
//
// Runs the REAL script as a child process on a REAL temp view file. No DB, no docker, no ssh.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'docker/zeehive/zee-live.mjs');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EV = {
  init: { type: 'system', subtype: 'init', session_id: 'abcdef12-1111-2222-3333-444444444444' },
  turn: { type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'WEIGHING THE OPTIONS' },
    { type: 'text', text: 'Reading the manual first.' },
    { type: 'tool_use', name: 'ReadTheFile', input: { file_path: '/work/repo/HANDOFF.md' } },
  ] } },
  result: { type: 'user', message: { content: [{ type: 'tool_result', content: [{ text: 'THE RESULT TEXT' }] }] } },
  second: { type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'SECOND THOUGHT' },
    { type: 'text', text: 'Now editing.' },
  ] } },
};

// One renderer + its view file. `out()` is everything written so far; `since()` is everything
// after the LAST repaint (a repaint clears the screen and scrollback, so that is what a human
// standing in front of the terminal can see).
function start(viewFile) {
  const p = spawn(process.execPath, [SCRIPT], {
    env: { ...process.env, ZEE_LIVE_VIEW_FILE: viewFile, ZEE_LIVE_VIEW_POLL_MS: '60' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buf = '';
  p.stdout.on('data', (d) => { buf += d.toString(); });
  return {
    proc: p,
    feed: (e) => p.stdin.write(JSON.stringify(e) + '\n'),
    out: () => buf,
    since: () => { const i = buf.lastIndexOf('\x1b[3J'); return i < 0 ? buf : buf.slice(i); },
    end: () => p.stdin.end(),
  };
}

const dir = mkdtempSync(join(tmpdir(), 'zeelive-'));
const viewFile = join(dir, 'view.json');
const setView = (v) => writeFileSync(viewFile, JSON.stringify(v));

try {
  // ── (a) no view file: the feed is exactly what it always was ────────────────────────────────
  console.log('\n── default: no view file, nothing filtered ──');
  const a = start(viewFile);
  a.feed(EV.init); a.feed(EV.turn); a.feed(EV.result);
  await sleep(400);
  ok(a.out().includes('WEIGHING THE OPTIONS'), 'thinking is rendered');
  ok(a.out().includes('ReadTheFile'), 'the tool call (a detailed move) is rendered');
  ok(a.out().includes('THE RESULT TEXT'), 'the tool result is rendered');
  ok(a.out().includes('Reading the manual first.'), "and what the zee SAYS is rendered");
  ok(!a.out().includes('\x1b[3J'), 'and nothing repainted (no view ever changed)');

  // ── (c) a mid-stream change REPAINTS ────────────────────────────────────────────────────────
  console.log('\n── ✱ thinking off, mid-stream: the feed redraws without it ──');
  setView({ thinking: false, moves: true });
  await sleep(400);
  ok(a.out().includes('\x1b[3J'), 'the screen AND scrollback are cleared (hidden must mean unreachable)');
  const afterHide = a.since();
  ok(!afterHide.includes('WEIGHING THE OPTIONS'), 'the thinking that already scrolled past is gone from the redraw');
  ok(afterHide.includes('ReadTheFile') && afterHide.includes('THE RESULT TEXT'),
     'the moves and their results survive the redraw (only thinking was hidden)');
  ok(afterHide.includes('Reading the manual first.'), 'and so does what the zee said');
  ok(/thinking HIDDEN/.test(afterHide), 'the redraw says which view is in force');

  a.feed(EV.second);
  await sleep(300);
  ok(!a.since().includes('SECOND THOUGHT'), 'new thinking stays hidden too');
  ok(a.since().includes('Now editing.'), 'while new text still comes through');

  console.log('\n── ⚒ moves off (thinking back on): the other half of the switch ──');
  setView({ thinking: true, moves: false });
  await sleep(400);
  const afterMoves = a.since();
  ok(afterMoves.includes('WEIGHING THE OPTIONS') && afterMoves.includes('SECOND THOUGHT'),
     'toggling thinking back ON brings back what was hidden (a view, not a discard)');
  ok(!afterMoves.includes('ReadTheFile'), 'the tool call is now hidden');
  ok(!afterMoves.includes('THE RESULT TEXT'), 'and its result with it (a result without its call is nonsense)');
  ok(afterMoves.includes('Reading the manual first.') && afterMoves.includes('Now editing.'),
     "what the zee SAYS is never filtered — it is the thing you came to read");

  // ── (d) the watcher does not outlive the transcript ─────────────────────────────────────────
  console.log('\n── the file watcher never wedges the renderer ──');
  const exited = new Promise((r) => a.proc.on('exit', r));
  a.end();
  const code = await Promise.race([exited, sleep(3000).then(() => 'timeout')]);
  ok(code === 0, `stdin ending still ends the process (exit: ${code})`);

  // ── (b) a view chosen BEFORE the feed starts is honoured ─────────────────────────────────────
  console.log('\n── a view set before the feed opens is already in force ──');
  setView({ thinking: false, moves: false });
  const b = start(viewFile);
  b.feed(EV.init); b.feed(EV.turn); b.feed(EV.result);
  await sleep(400);
  ok(!b.out().includes('WEIGHING THE OPTIONS') && !b.out().includes('ReadTheFile'),
     'the first line rendered already respects the view (no flash of hidden output)');
  ok(b.out().includes('Reading the manual first.'), 'and the feed is not silent');
  b.end();
  await sleep(200);
  try { b.proc.kill(); } catch { /* already gone */ }

  // garbage in the view file must never blank the feed
  console.log('\n── an unreadable view file falls back to showing everything ──');
  writeFileSync(viewFile, '{ not json');
  const c = start(viewFile);
  c.feed(EV.turn);
  await sleep(400);
  ok(c.out().includes('WEIGHING THE OPTIONS') && c.out().includes('ReadTheFile'),
     'a half-written/garbage control file shows everything rather than going dark');
  c.end();
  await sleep(200);
  try { c.proc.kill(); } catch { /* already gone */ }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures ? 1 : 0);

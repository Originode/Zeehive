#!/usr/bin/env node
// Render a cxell zee's transcript (the session .jsonl Claude Code writes on disk, which is the
// same content-block stream the queenzee captures for the SSE feed) into a readable LIVE feed
// for the dashboard terminal. zee-attach.sh pipes a `tail -f` of the running session's transcript
// through this while the headless zee is still working, so an attending human sees the workflow —
// prior turns, thinking, tool calls and results — AS IT HAPPENS, then hands off to `claude
// --resume` for the full interactive session once the turn ends. Additive: it only READS the
// transcript, it does not touch the `-p` stdout the SSE feed depends on and starts no `claude`.
//
// ── VIEW FILTERS (the ✱ thinking / ⚒ moves chips in the dashboard terminal) ───────────────────
// The feed is a firehose: every thought and every tool call with its result. Watching "what is the
// zee actually DOING" meant reading past the thinking; reading the reasoning meant scrolling past
// tool noise. So the render is filterable, and the switch is a FILE this process watches:
//
//   /tmp/zee-live-view.json   {"thinking":true,"moves":true}   (missing/garbage = show everything)
//
// terminal-bridge.js writes that file over the SAME ssh connection the terminal rides on when a
// human clicks a chip. A file (absolute state) rather than a signal (a toggle) so the chip and the
// feed can never disagree about what is on. Because we keep every event we have rendered, a change
// REPAINTS: hiding thinking removes the thinking that already scrolled by, showing it brings it
// back — a real show/hide, not just "quieter from here on".
//
// It also ANNOUNCES ITSELF (the .ready file below). A cxell built from an older image runs an older
// renderer that knows nothing about views: the chips would write the file, the feed would ignore it,
// and the header would confidently claim "hidden" while the thinking kept scrolling. The marker
// lets the bridge tell "a feed is running" from "a feed that can be filtered is running", so the
// terminal can say which — a toggle must never report a state it did not apply.
import { readFileSync, writeFileSync, unlinkSync, watchFile, unwatchFile } from 'node:fs';

const C = { dim:'\x1b[2m', reset:'\x1b[0m', cyan:'\x1b[36m', green:'\x1b[32m', yellow:'\x1b[33m', mag:'\x1b[35m', bold:'\x1b[1m' };
const w = (s) => process.stdout.write(s + '\r\n');
const clip = (s, n = 200) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

// Where the dashboard chips land. Overridable so a test can drive the same file without /tmp.
const VIEW_FILE = process.env.ZEE_LIVE_VIEW_FILE || '/tmp/zee-live-view.json';
// "a renderer that understands views is running, and it is THIS pid". The bridge compares it with
// the pid it finds running: equal = the chips will actually do something; missing/stale = an older
// renderer from an older image, and the terminal says so instead of pretending.
const READY_FILE = `${VIEW_FILE}.ready`;
const VIEW_POLL_MS = Number(process.env.ZEE_LIVE_VIEW_POLL_MS || 400);
// What a repaint can redraw. A long turn is thousands of events; keeping every one of them would
// grow without bound and redraw a wall. The tail is what an attending human is reading anyway.
const MAX_KEPT = Number(process.env.ZEE_LIVE_MAX_KEPT || 2000);

const view = { thinking: true, moves: true };   // defaults = the feed this renderer always drew
const kept = [];

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString(); let nl;
  while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) feed(line); }
});
process.stdin.on('end', () => { if (buf.trim()) feed(buf); shutdown(); });
// Leave nothing behind that would make the NEXT feed look filterable when it is not.
const shutdown = () => {
  unwatchFile(VIEW_FILE);
  try { unlinkSync(READY_FILE); } catch { /* already gone, or never written */ }
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { shutdown(); process.exit(0); });

function feed(line) {
  let e; try { e = JSON.parse(line); } catch { return; } // non-JSON / bookkeeping noise
  kept.push(e);
  if (kept.length > MAX_KEPT) kept.splice(0, kept.length - MAX_KEPT);
  for (const l of render(e)) w(l);
}

// One event → the lines it draws UNDER THE CURRENT VIEW (none when it is filtered out). Pure, so
// the same function serves the live stream and a repaint.
// The transcript carries both stream-json events (system/result) and on-disk turns
// (assistant/user with message.content blocks); render whichever we get.
function render(e) {
  const out = [];
  if (e.type === 'system' && e.subtype === 'init') { out.push(`${C.dim}── session ${String(e.session_id || '').slice(0, 8)} ──${C.reset}`); return out; }
  if (e.type === 'assistant') {
    for (const b of e.message?.content || []) {
      // ✱ thinking — the zee's reasoning. Hidden by the ✱ chip.
      if (b.type === 'thinking' && b.thinking?.trim() && view.thinking) out.push(`${C.mag}${C.dim}✱ thinking${C.reset} ${C.dim}${clip(b.thinking)}${C.reset}`);
      // ● what the zee SAYS — never filtered; it is the thing you came to read.
      if (b.type === 'text' && b.text?.trim()) out.push(`${C.green}●${C.reset} ${clip(b.text, 400)}`);
      // ⚒ the detailed moves — tool calls with their arguments. Hidden by the ⚒ chip.
      if (b.type === 'tool_use' && view.moves) out.push(`${C.cyan}⚒ ${b.name}${C.reset} ${C.dim}${clip(JSON.stringify(b.input || {}), 160)}${C.reset}`);
    }
    return out;
  }
  if (e.type === 'user') {
    const content = e.message?.content;
    if (typeof content === 'string' && content.trim()) { out.push(`${C.bold}❯${C.reset} ${clip(content, 300)}`); return out; }
    for (const b of content || []) {
      // ↳ a tool RESULT belongs to the move that asked for it — same chip, or the feed would show
      // answers to questions it hid.
      if (b.type === 'tool_result' && view.moves) {
        const t = Array.isArray(b.content) ? b.content.map((x) => x.text || '').join(' ') : (b.content || '');
        out.push(`${C.yellow}  ↳${C.reset} ${C.dim}${clip(t, 160)}${C.reset}`);
      }
    }
    return out;
  }
  if (e.type === 'result') out.push(`${C.bold}${C.green}── turn complete ──${C.reset} ${C.dim}${clip(e.result || e.subtype, 200)}${C.reset}`);
  return out;
}

const viewLine = () =>
  `${C.dim}── view: ✱ thinking ${view.thinking ? 'shown' : 'HIDDEN'} · ⚒ moves ${view.moves ? 'shown' : 'HIDDEN'}`
  + ` — the chips in the dashboard terminal ──${C.reset}`;

// A filter change redraws the whole kept feed: clear the screen AND the scrollback (\x1b[3J, which
// tmux honours), print what the view is now, then re-render every event we still hold. Without the
// scrollback clear, hidden lines would still be one wheel-scroll away — "hide" has to mean hidden.
function repaint() {
  process.stdout.write('\x1b[H\x1b[2J\x1b[3J');
  w(viewLine());
  if (kept.length >= MAX_KEPT) w(`${C.dim}   (showing the last ${MAX_KEPT} events)${C.reset}`);
  for (const e of kept) for (const l of render(e)) w(l);
}

// Read the chip file. Anything unreadable/garbage means "show everything" — the feed must never go
// dark because a control file was half-written or absent.
function readView() {
  let next = { thinking: true, moves: true };
  try {
    const j = JSON.parse(readFileSync(VIEW_FILE, 'utf8'));
    next = { thinking: j.thinking !== false, moves: j.moves !== false };
  } catch { /* missing or mid-write — defaults */ }
  if (next.thinking === view.thinking && next.moves === view.moves) return;
  view.thinking = next.thinking; view.moves = next.moves;
  repaint();
}

readView();                                                  // honour a view chosen before we started
watchFile(VIEW_FILE, { interval: VIEW_POLL_MS }, readView);  // polling: survives the atomic-rewrite that fs.watch misses
// Announce LAST: by here we are actually watching, so the marker can never claim a filterable feed
// a moment before it is one. Best-effort — a read-only /tmp costs the hint, not the feed.
try { writeFileSync(READY_FILE, String(process.pid)); } catch { /* the bridge will just report 'older feed' */ }

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import FileExplorer from './FileExplorer.jsx';

// A path-ish token a zee tends to "present" in the terminal: web/src/App.jsx, ./server/x.js,
// /work/repo/…, package.json. Used to offer "show file" on a selection and to strip a pasted
// selection down to the path (trailing :line:col, punctuation, surrounding quotes).
function pathFromSelection(sel) {
  const s = (sel || '').trim().replace(/^['"`]|['"`]$/g, '').split(/\s+/)[0] || '';
  const cleaned = s.replace(/[:,)\].]+$/, '').replace(/:\d+(:\d+)?$/, '');
  if (!cleaned) return null;
  // looks like a path: has a slash, or a bare filename with an extension
  if (cleaned.includes('/') || /^[\w.-]+\.[A-Za-z0-9]+$/.test(cleaned)) return cleaned;
  return null;
}

// Path tokens to make CLICKABLE in terminal output. Two shapes: (1) a multi-segment path (has a
// slash) with an optional leading ./ or /, and an optional :line:col; (2) a bare filename with a
// known code/text extension. Kept deliberately conservative so ordinary prose ("Node.js", "e.g.")
// doesn't turn into a sea of links.
const PATH_RE = /(?:\.{0,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?::\d+(?::\d+)?)?|\b[A-Za-z0-9_-]+\.(?:jsx?|tsx?|mjs|cjs|json|css|md|py|sh|ya?ml|html?|sql|txt|toml|ini|env|lock)\b/g;

// Frames from the bridge that are CONTROL, not terminal bytes: a NUL-tagged JSON string (terminal
// output arrives as binary, so the two can never be confused). Must match CTRL_PREFIX in
// server/src/lib/terminal-bridge.js.
const CTRL_PREFIX = '\u0000ZH';

// One live-terminal modal, two doors (same wire protocol on both — {t:'i'} keystrokes and
// {t:'r'} resizes up, raw bytes down):
//   ZeeTerminal       → /api/zees/:id/terminal       (SSH → tmux inside a cxell)
//   ContainerTerminal → /api/containers/:id/terminal (docker exec shell in ANY container)
// TerminalModal is the shared body: xterm + fit + the resize/refit choreography, fullscreen,
// and the status pill. The flavors differ only in title, footer, and prod styling.
// `explorerZeeId` (cxell zees only) lights up the single 📁 file-explorer button (toggles the panel;
// with a path-shaped selection it opens that file instead).
export function TerminalModal({ wsPath, title, prod = false, foot = null, explorerZeeId = null, onClose }) {
  const holder = useRef(null);
  const termRef = useRef(null);
  const wsRef = useRef(null);
  const clipTaRef = useRef(null);
  const reqN = useRef(0);
  const [status, setStatus] = useState('connecting');
  const [full, setFull] = useState(false);   // maximize the modal; the ResizeObserver refits + resizes the PTY
  const [showFx, setShowFx] = useState(false);       // file-explorer panel open?
  const [fxReq, setFxReq] = useState(null);          // { path, n } — a "show file" request into the explorer
  const [clip, setClip] = useState('');              // the IN-APP clipboard: last selection captured here
  const [clipOpen, setClipOpen] = useState(false);   // the clipboard tray visible?
  const [flash, setFlash] = useState('');
  // The zee's LIVE FEED view (the ✱/⚒ chips). `live` is what the bridge last told us about the
  // cage: true = a feed is running and a chip repaints it now, false = the feed is not up (the
  // turn ended and the interactive session owns the pane), null = we have not been told yet.
  const [feed, setFeed] = useState({ thinking: true, moves: true, live: null });

  // Open a path in the explorer (opening the panel if needed). The bumping `n` makes every request
  // distinct so clicking the SAME path again re-opens it (identity, not value, drives the effect).
  const openInExplorer = (p) => { if (!p) return; setShowFx(true); setFxReq({ path: p, n: ++reqN.current }); };

  // Send text to the PTY as if typed (the clipboard tray's Paste→terminal).
  const sendInput = (d) => { const ws = wsRef.current; if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'i', d })); };

  // OS-clipboard write, best-effort: the async API where allowed (secure ctx / localhost), else a
  // throwaway textarea + execCommand for an insecure http origin. Never throws.
  const clipApi = (t) => { try { return navigator.clipboard?.writeText(t); } catch { return null; } };
  const execCopy = (t) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta); termRef.current?.focus();
    } catch { /* nothing more we can do */ }
  };
  const toOsClipboard = (t) => { const p = clipApi(t); if (p && p.catch) p.catch(() => execCopy(t)); else if (!p) execCopy(t); };

  // Capture a selection into the IN-APP clipboard (the web-ui clipboard the operator asked for): it
  // lives in the page as real, selectable text — reliable even where the OS clipboard is blocked
  // (remote http origin, iframe). We ALSO mirror to the OS clipboard when that's allowed.
  const capture = (t) => { if (!t) return; setClip(t); setClipOpen(true); toOsClipboard(t); };

  useEffect(() => {
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13,
      theme: { background: '#0b0e14' }, cursorBlink: true, scrollback: 5000,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(holder.current);
    const refit = () => { try { fit.fit(); } catch { /* mid-teardown */ } };
    refit();
    term.focus();

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}${wsPath}`);
    wsRef.current = ws;
    ws.binaryType = 'arraybuffer';
    const sendResize = () => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'r', cols: term.cols, rows: term.rows }));

    // The mount-time fit races the modal's layout: measured too early it computes a small grid,
    // tells the PTY that size, and NOTHING corrects it later (the ResizeObserver only fires on
    // changes — the panel is already at its final size). Seen live: the terminal filled half the
    // panel until a fullscreen toggle forced a refit. Refit on the next frame and once more after
    // layout settles, re-sending the PTY size each time.
    const raf = requestAnimationFrame(() => { refit(); sendResize(); });
    const settle = setTimeout(() => { refit(); sendResize(); }, 250);

    ws.onopen = () => { setStatus('live'); refit(); sendResize(); };
    ws.onmessage = (e) => {
      // control frame (the live-feed view) or terminal bytes — never both, see CTRL_PREFIX
      if (typeof e.data === 'string' && e.data.startsWith(CTRL_PREFIX)) {
        try {
          const m = JSON.parse(e.data.slice(CTRL_PREFIX.length));
          if (m.t === 'v') setFeed({ thinking: m.thinking !== false, moves: m.moves !== false, live: !!m.live });
        } catch { /* a malformed control frame must not kill the terminal */ }
        return;
      }
      term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
    };
    ws.onclose = () => setStatus('closed');
    ws.onerror = () => setStatus('error');
    term.onData((d) => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'i', d })));
    term.onResize(sendResize);

    // CLIPBOARD. xterm renders to a canvas, so a highlight is xterm's OWN selection, not a browser
    // text selection — the browser's copy has nothing to grab (reported: "Ctrl+Shift+C doesn't
    // work, I can't copy"). And the OS clipboard is itself unreachable on a remote http origin. So:
    //  • copy-on-select CAPTURES the selection into the IN-APP clipboard tray (real page text the
    //    operator can always read/copy) and mirrors to the OS clipboard where allowed. Shift+drag,
    //    since tmux mouse mode owns a plain drag.
    term.onSelectionChange(() => { const s = term.getSelection(); if (s) capture(s); });
    //  • explicit shortcuts as a fallback: Ctrl+Shift+C / Cmd+C copy the selection; Ctrl+Shift+V /
    //    Cmd+V paste into the PTY. We swallow these so they don't reach the shell (plain Ctrl+C stays
    //    SIGINT — we never touch it). attachCustomKeyEventHandler returning false blocks the key.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const combo = (e.ctrlKey && e.shiftKey) || e.metaKey;   // Linux/Win: Ctrl+Shift+_, mac: Cmd+_
      if (!combo) return true;
      if (e.code === 'KeyC' && term.hasSelection()) { capture(term.getSelection()); return false; }
      if (e.code === 'KeyV') {
        try { navigator.clipboard?.readText().then((t) => t && ws.readyState === 1 && ws.send(JSON.stringify({ t: 'i', d: t }))); } catch { /* denied */ }
        return false;
      }
      return true;
    });

    // CLICKABLE PATHS. A zee constantly names files it touched ("edited web/src/App.jsx"); make
    // those clickable so the human opens them in the explorer with ZERO copy-paste. A custom link
    // provider scans each rendered line for path-shaped tokens and, on click, opens the file. Only
    // for terminals that HAVE an explorer (a cxell zee); a container shell gets no file links.
    let linkDisp = null;
    if (explorerZeeId) {
      linkDisp = term.registerLinkProvider({
        provideLinks(y, cb) {
          const line = term.buffer.active.getLine(y - 1);
          if (!line) return cb(undefined);
          const text = line.translateToString(true);
          const links = [];
          PATH_RE.lastIndex = 0;
          let m;
          while ((m = PATH_RE.exec(text)) !== null) {
            const raw = m[0];
            const x = m.index + 1;   // xterm buffer x is 1-based
            links.push({
              text: raw,
              range: { start: { x, y }, end: { x: x + raw.length - 1, y } },
              activate: (_e, t) => openInExplorer(t.replace(/:\d+(?::\d+)?$/, '')),
            });
          }
          cb(links.length ? links : undefined);
        },
      });
    }

    const onWin = () => { refit(); };
    window.addEventListener('resize', onWin);
    const ro = new ResizeObserver(() => { refit(); });
    if (holder.current) ro.observe(holder.current);

    return () => {
      cancelAnimationFrame(raf); clearTimeout(settle);
      window.removeEventListener('resize', onWin); ro.disconnect();
      try { linkDisp?.dispose(); } catch {}
      try { ws.close(); } catch {} term.dispose();
      termRef.current = null; wsRef.current = null;
    };
  }, [wsPath]);

  // ── clipboard tray actions ──
  const flashMsg = (m) => { setFlash(m); setTimeout(() => setFlash(''), 1200); };
  const copyClipOut = () => {
    // select the tray textarea (so a manual Ctrl+C always works) AND try the OS clipboard.
    clipTaRef.current?.focus(); clipTaRef.current?.select();
    toOsClipboard(clip); flashMsg('copied');
  };
  const pasteClipToTerm = () => { if (clip) { sendInput(clip); termRef.current?.focus(); flashMsg('pasted → terminal'); } };
  const clearClip = () => { setClip(''); setFlash(''); };

  // The right-click CONFLICT fix: xterm forwards mouse events to the terminal app (tmux mouse mode
  // is on for scroll), but the browser ALSO pops its page menu (Back/Reload/Inspect) on top — that
  // is the clash. Just suppress the browser menu so the right-click belongs to the terminal; we do
  // NOT draw a replacement menu. (Because tmux mouse mode owns a plain drag, hold Shift while
  // dragging to make a selection — it is captured into the 📋 clipboard tray.)
  const onContextMenu = (e) => e.preventDefault();

  // ONE explorer button (there used to be two — 📄 "show file" and 📁 "toggle explorer" — which is
  // the same door twice: 📄 with nothing selected just opened the panel, and the panel has its own
  // path box). So 📁 does both: a Shift+drag selection that LOOKS like a path opens that file (and
  // the panel with it); otherwise it plain toggles the panel. The selection is cleared after it is
  // consumed, so the very next click toggles instead of re-opening the same file.
  // ── the live-feed chips: show/hide the zee's thinking, and its detailed moves ──
  // A cxell zee's pane streams its transcript while it works (zee-live.mjs): ✱ thinking, ● what it
  // says, ⚒ every tool call with its ↳ result. That firehose is the point when you want detail and
  // the problem when you want to see what it is DOING. The chip flips a view flag in the cage and
  // the feed REPAINTS — so hiding thinking also removes the thinking that already scrolled past,
  // and showing it brings it back. We never send keystrokes for this: the pane belongs to the
  // interactive session once the turn ends, and a stray keypress there would type into the zee.
  const setFeedFlag = (key) => {
    const next = { ...feed, [key]: !feed[key] };
    setFeed(next);                                   // optimistic; the bridge answers with the truth
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'v', thinking: next.thinking, moves: next.moves }));
    termRef.current?.focus();
  };
  const feedTitle = (on, what) =>
    `${on ? 'Hide' : 'Show'} ${what} in the zee's live feed`
    + (feed.live === false ? ' — no feed is streaming right now, so this is the view the next one starts in' : ' (the feed redraws)');

  const toggleExplorer = () => {
    const term = termRef.current;
    const p = pathFromSelection(term?.getSelection?.() || '');
    if (p) {
      openInExplorer(p);
      try { term?.clearSelection?.(); } catch { /* terminal torn down */ }
      return;
    }
    setShowFx((v) => !v);
  };

  return createPortal(
    <div className="term-overlay" onClick={onClose}>
      <div className={`zeeterm${full ? ' full' : ''}${prod ? ' prod' : ''}${showFx ? ' hasfx' : ''}`}
           onClick={(e) => e.stopPropagation()}>
        <div className={`term-head${prod ? ' prod' : ''}`}>
          <span className="term-title">⌨ {title}
            {prod && <span className="term-prodtag" data-testid="term-prodtag">PRODUCTION</span>}
            <span className={`tstat t-${status}`}>{status}</span>
          </span>
          {/* Only the zee door has a feed to filter — a container shell is just a shell. */}
          {explorerZeeId && (
            <span className="term-filters" data-testid="feed-filters">
              <button className={`term-chip${feed.thinking ? '' : ' off'}${feed.live === false ? ' idle' : ''}`}
                      data-testid="feed-thinking" onClick={() => setFeedFlag('thinking')}
                      title={feedTitle(feed.thinking, "the zee's thinking (the ✱ lines)")}>✱ thinking</button>
              <button className={`term-chip${feed.moves ? '' : ' off'}${feed.live === false ? ' idle' : ''}`}
                      data-testid="feed-moves" onClick={() => setFeedFlag('moves')}
                      title={feedTitle(feed.moves, 'the detailed moves — every ⚒ tool call and its ↳ result')}>⚒ moves</button>
            </span>
          )}
          <span>
            <button className={`term-x${clipOpen ? ' on' : ''}${clip && !clipOpen ? ' dot' : ''}`} data-testid="clip-toggle"
                    onClick={() => setClipOpen((v) => !v)}
                    title="Clipboard — selections you Shift+drag land here (works even when the OS clipboard is blocked)">📋</button>
            {explorerZeeId && (
              <button className={`term-x${showFx ? ' on' : ''}`} data-testid="fx-toggle"
                      onClick={toggleExplorer}
                      title={showFx ? 'Hide file explorer (Shift+drag a path first to open that file)'
                                    : 'File explorer — Shift+drag a path (or click one in the output) to open that file'}>📁</button>
            )}
            <button className="term-x" onClick={() => setFull(!full)} title={full ? 'Exit fullscreen' : 'Fullscreen'}>{full ? '⇲' : '⛶'}</button>
            <button className="term-x" onClick={onClose} title="Close">✕</button>
          </span>
        </div>
        <div className="zeeterm-main">
          {explorerZeeId && showFx && (
            <FileExplorer zeeId={explorerZeeId} openReq={fxReq}
                          onClose={() => setShowFx(false)} />
          )}
          <div className="zeeterm-body" ref={holder} onContextMenu={onContextMenu} />
          {clipOpen && (
            <div className="term-clip" data-testid="term-clip" onClick={(e) => e.stopPropagation()}>
              <div className="tc-head">
                <span className="tc-title">📋 clipboard{flash && <em className="tc-flash">{flash}</em>}</span>
                <button className="fx-x" title="Hide" onClick={() => setClipOpen(false)}>✕</button>
              </div>
              <textarea ref={clipTaRef} className="tc-text" value={clip} readOnly
                        placeholder="Shift+drag in the terminal to capture text here…"
                        onFocus={(e) => e.target.select()} />
              <div className="tc-actions">
                <button disabled={!clip} onClick={copyClipOut} title="Select the text and copy to the OS clipboard">⧉ copy</button>
                <button disabled={!clip} onClick={pasteClipToTerm} title="Type this back into the terminal">⇥ paste → terminal</button>
                <button disabled={!clip} onClick={clearClip} title="Clear">clear</button>
              </div>
            </div>
          )}
        </div>
        {foot}
      </div>
    </div>,
    document.body
  );
}

// A live terminal INTO a cxell zee. The browser xterm talks to /api/zees/:id/terminal (a
// websocket), which the queenzee bridges over SSH to a PTY on `tmux new -A -s zee` inside the
// cxell — so this is the same interactive `claude` you'd get over SSH, prompt by prompt, and
// disconnecting leaves the session running (tmux). The SSH line below is that exact door for
// Claude Code desktop's "Add SSH host" — the deeplink IS the SSH connection.
export default function ZeeTerminal({ zeeId, slug, viewerUrl, onClose }) {
  const [copied, setCopied] = useState(false);

  // ssh://zee@127.0.0.1:PORT → a copy-pasteable ssh command (external attach)
  let sshCmd = null;
  try {
    const u = new URL(viewerUrl);
    sshCmd = `ssh -i ~/.zeehive/ssh/cxell_id_ed25519 -p ${u.port} ${u.username || 'zee'}@${u.hostname}`;
  } catch { /* no url */ }

  const copy = async () => {
    try { await navigator.clipboard.writeText(sshCmd); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* */ }
  };

  const foot = (
    <div className="zeeterm-foot">
      {/* Copy is non-obvious: tmux mouse mode owns a plain drag, so a browser selection needs Shift.
          Surface it so nobody has to guess (reported: "I can't copy text"). */}
      <span className="pc kbd-hint" title="A plain drag goes to the app; Shift+drag makes a selection, captured into the 📋 clipboard tray">
        <b>Shift+drag</b> → 📋 clipboard · click a <b>path</b> to open it · <b>✱ ⚒</b> filter the live feed
      </span>
      <input className="mono" readOnly value={sshCmd || ''} onFocus={(e) => e.target.select()} />
      <button type="button" onClick={copy}>{copied ? '✓ copied' : '⧉ copy'}</button>
    </div>
  );

  return <TerminalModal wsPath={`/api/zees/${zeeId}/terminal`} title={slug} foot={foot}
                        explorerZeeId={zeeId} onClose={onClose} />;
}

// A shell inside a fleet container, opened from the chip's context menu. The bridge runs a
// docker-exec TTY (bash, or sh where the image has no bash) — no sshd required in the target.
// A PRODUCTION container's modal wears the fleet's gold warning, same as its chip.
export function ContainerTerminal({ c, onClose }) {
  return <TerminalModal wsPath={`/api/containers/${c.id}/terminal`} title={c.name}
                        prod={c.tier === 'prod'} onClose={onClose} />;
}

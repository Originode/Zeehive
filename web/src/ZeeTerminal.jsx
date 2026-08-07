import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import FileExplorer from './FileExplorer.jsx';
import FeedChips from './FeedChips.jsx';
import MessageComposer from './MessageComposer.jsx';
import { setXellLangfuseTracking, baseUrl } from './api.js';
import { mountTerm } from './termHost.js';
import { getTermEngine, getTermTheme, setTermTheme } from './termPref.js';

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

// Frames from the bridge that are CONTROL, not terminal bytes: a NUL-tagged JSON string (terminal
// output arrives as binary, so the two can never be confused). Must match CTRL_PREFIX in
// server/src/lib/terminal-bridge.js.
const CTRL_PREFIX = '\u0000ZH';

// One live-terminal modal, two doors (same wire protocol on both — {t:'i'} keystrokes and
// {t:'r'} resizes up, raw bytes down):
//   ZeeTerminal       → /api/zees/:id/terminal       (SSH → tmux inside a cxell)
//   ContainerTerminal → /api/containers/:id/terminal (docker exec shell in ANY container)
// TerminalModal is the shared body: terminal engine (xterm OR wterm — Console settings) + fit +
// the resize/refit choreography, fullscreen, and the status pill. The flavors differ only in
// title, footer, and prod styling.
// `explorerZeeId` (cxell zees) / `explorerContainer` (any container) light up the single 📁
// file-explorer button (toggles the panel; with a path-shaped selection it opens that file instead)
// and make path-shaped tokens in the output clickable. The zee door additionally gets the live-feed
// ✱/⚒ chips (gated on `explorerZeeId` — a container shell has no feed to filter).
// `xell` ({ id, slug }, cxell zees only) lights up 💬 talk — the composer that CONVERSES with the
// zee whether or not it is mid-turn (see the talk block below).
export function TerminalModal({ wsPath, title, prod = false, foot = null, explorerZeeId = null, explorerContainer = null, xell = null, langfuseEnabled = false, onToggleLangfuse = null, onClose }) {
  const holder = useRef(null);
  const termRef = useRef(null);   // termHost handle (xterm or wterm) — write/focus/getSelection/…
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
  const [talkOpen, setTalkOpen] = useState(false);   // the 💬 talk composer open?
  // The zee's LIVE FEED view (the ✱/⚒ chips). `live` is what the bridge last told us about the
  // cage: true = a feed is running and a chip repaints it now, false = the feed is not up (the
  // turn ended and the interactive session owns the pane), null = we have not been told yet.
  const [feed, setFeed] = useState({ thinking: true, moves: true, live: null, filterable: null });
  // Shown in the status pill so the operator can see which engine this session is on without
  // reopening settings. Read once at mount — a live PTY keeps the engine it was born with.
  const [engine] = useState(() => getTermEngine());
  // dark | light — toggled next to the engine pill; applies live via termRef.setTheme and
  // persists for the next open. Default dark (light text on dark bg); light is the inverse.
  const [theme, setTheme] = useState(() => getTermTheme());

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
    let cancelled = false;
    let term = null;
    let unsubSel = null;
    let unsubLinks = null;
    let raf = 0;
    let settle = 0;
    let ro = null;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // baseUrl rides the app's own base so the terminal's websocket targets THIS xell's server
    // through the proxy (/xell-web/<slug>/api/...), not the outer console's — same rule as fetch.
    const ws = new WebSocket(`${proto}://${location.host}${baseUrl(wsPath)}`);
    wsRef.current = ws;
    ws.binaryType = 'arraybuffer';

    // Bytes that arrive before the engine finishes init (wterm loads WASM async) are buffered
    // so a fast first frame is never dropped on the floor.
    const pending = [];
    const sendResize = () => {
      if (!term || ws.readyState !== 1) return;
      ws.send(JSON.stringify({ t: 'r', cols: term.cols, rows: term.rows }));
    };
    const refit = () => { try { term?.fit(); } catch { /* mid-teardown */ } };

    ws.onopen = () => { setStatus('live'); refit(); sendResize(); };
    ws.onmessage = (e) => {
      // control frame (the live-feed view) or terminal bytes — never both, see CTRL_PREFIX
      if (typeof e.data === 'string' && e.data.startsWith(CTRL_PREFIX)) {
        try {
          const m = JSON.parse(e.data.slice(CTRL_PREFIX.length));
          // keep `filterable` too: it is the difference between "your click repainted the feed" and
          // "a feed is running that cannot hear you" (an older renderer) — the chips say which.
          if (m.t === 'v') setFeed({ thinking: m.thinking !== false, moves: m.moves !== false,
                                     live: !!m.live, filterable: m.filterable !== false });
        } catch { /* a malformed control frame must not kill the terminal */ }
        return;
      }
      const chunk = typeof e.data === 'string' ? e.data : new Uint8Array(e.data);
      if (!term) { pending.push(chunk); return; }
      term.write(chunk);
    };
    ws.onclose = () => setStatus('closed');
    ws.onerror = () => setStatus('error');

    (async () => {
      try {
        term = await mountTerm(holder.current, {
          engine,   // frozen at modal open — preference changes apply next time
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 13,
          theme,    // dark|light palette (toggle beside the engine pill)
          cursorBlink: true,
          scrollback: 5000,
          onData: (d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'i', d })); },
          onResize: () => sendResize(),
        });
      } catch (err) {
        console.error('terminal engine failed to mount', err);
        if (!cancelled) setStatus('error');
        return;
      }
      if (cancelled) { try { term.dispose(); } catch { /* */ } return; }
      termRef.current = term;
      for (const c of pending) term.write(c);
      pending.length = 0;
      term.focus();
      refit();
      sendResize();

      // CLIPBOARD. xterm paints to a canvas so a highlight is the engine's own selection (browser
      // copy has nothing to grab). wterm paints to the DOM so native selection works — but we still
      // mirror into the in-app tray, because the OS clipboard is unreachable on a remote http origin.
      // Shift+drag under tmux mouse mode for both engines.
      unsubSel = term.onSelectionChange((s) => capture(s));
      // xterm-only shortcuts (Ctrl+Shift+C/V); wterm already handles native copy/paste.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        const combo = (e.ctrlKey && e.shiftKey) || e.metaKey;
        if (!combo) return true;
        if (e.code === 'KeyC' && term.hasSelection()) { capture(term.getSelection()); return false; }
        if (e.code === 'KeyV') {
          try { navigator.clipboard?.readText().then((t) => t && ws.readyState === 1 && ws.send(JSON.stringify({ t: 'i', d: t }))); } catch { /* denied */ }
          return false;
        }
        return true;
      });

      // CLICKABLE PATHS — only when this door has an explorer (cxell zee or shellable container).
      if (explorerZeeId || explorerContainer) {
        unsubLinks = term.registerPathLinks((p) => openInExplorer(p));
      }

      // The mount-time fit races the modal's layout: measured too early it computes a small grid,
      // tells the PTY that size, and NOTHING corrects it later. Refit next frame + after settle.
      raf = requestAnimationFrame(() => { refit(); sendResize(); });
      settle = setTimeout(() => { refit(); sendResize(); }, 250);
    })();

    const onWin = () => { refit(); };
    window.addEventListener('resize', onWin);
    ro = new ResizeObserver(() => { refit(); });
    if (holder.current) ro.observe(holder.current);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf); clearTimeout(settle);
      window.removeEventListener('resize', onWin);
      try { ro?.disconnect(); } catch { /* */ }
      try { unsubSel?.(); } catch { /* */ }
      try { unsubLinks?.(); } catch { /* */ }
      try { ws.close(); } catch { /* */ }
      try { term?.dispose(); } catch { /* */ }
      termRef.current = null; wsRef.current = null;
    };
  }, [wsPath, engine]); // theme toggles live via setTheme on the handle — do not remount

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setTermTheme(next);
    try { termRef.current?.setTheme?.(next); } catch { /* torn down */ }
  };

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
  // ── 💬 TALK: converse with the zee, whether or not it is mid-turn ────────────────────────────
  //
  // The pane has two owners and only one of them can hear you. Between turns the interactive
  // session holds it and typing here IS the conversation. While the zee works, the pane is the
  // read-only transcript feed: it renders and reads nothing, so keystrokes are swallowed — which
  // is exactly how "the terminal is read-only" was reported, and why a MANAGER (whose whole job is
  // conversation) was unreachable in the one place a human goes to talk to it.
  //
  // So the composer is always available, and the queenzee decides delivery per the cage's actual
  // state: TYPED into the live session, or QUEUED and typed in the moment the turn ends
  // (server/src/lib/cxell.js → cxellTalkCommand; drained by docker/zeehive/zee-attach.sh). We
  // already know which of the two it will be — `feed.live` is the bridge telling us who owns the
  // pane — so the receipt printed into the terminal says the true one instead of a hopeful one.
  const talkReceipt = (r) => {
    // The SERVER decides which of three deliveries this zee's state deserves (lib/zee-turn.js
    // decideMessageDelivery) and says so in the answer, so the receipt reports the decision rather
    // than re-deriving it here. `feed.live` stays as the fallback for an answer with no verdict.
    const delivery = r?.delivery || (feed.live === true ? 'queued' : 'typed');
    const parts = [
      delivery === 'queued'
        ? '── the zee is MID-TURN, so this pane is a read-only feed: your message is QUEUED in its cxell and typed into its session the moment the turn ends ──'
        : delivery === 'resumed'
          ? "── the zee's turn had ENDED, so the queenzee RESUMED its session with your message as the prompt: it is acting on it now, in a headless turn — the answer does not appear in this pane ──"
          : "── your message was typed into the zee's live session — its reply appears in this pane ──",
    ];
    if (r?.attachments?.length) parts.push(`   ${r.attachments.length} attachment(s) handed over in its .zee-inbox`);
    // Dim, and on its own lines, so a receipt is never mistaken for something the zee said.
    termRef.current?.write(`\r\n\x1b[2m${parts.join('\r\n')}\x1b[0m\r\n`);
    termRef.current?.focus();
  };

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
            <span className="term-engine" data-testid="term-engine-pill" title={`Terminal engine: ${engine} (change in Console settings ⚙)`}>{engine}</span>
            <button type="button" className={`term-theme-toggle ${theme}`} data-testid="term-theme-toggle"
                    onClick={toggleTheme}
                    title={theme === 'dark'
                      ? 'Theme: dark (light text on dark bg). Click for light.'
                      : 'Theme: light (dark text on light bg). Click for dark.'}>
              {theme === 'dark' ? '☾ dark' : '☀ light'}
            </button>
          </span>
          {/* Only the zee door has a feed to filter — a container shell is just a shell. */}
          {explorerZeeId && <FeedChips feed={feed} onToggle={setFeedFlag} />}
          <span>
            {/* 💬 TALK — the one door that works in BOTH pane states. Highlighted while a live feed
                owns the pane, because that is precisely when typing into the terminal does nothing
                and a human needs to be shown where to speak instead. */}
            {xell?.id && (
              <button className={`term-x talk${talkOpen ? ' on' : ''}${feed.live === true ? ' urge' : ''}`}
                      data-testid="talk-toggle" onClick={() => setTalkOpen((v) => !v)}
                      title={feed.live === true
                        ? 'Talk to this zee — it is MID-TURN, so this pane is a read-only feed: your message is queued and typed into its session the moment the turn ends'
                        : "Talk to this zee — typed straight into its live session (long text and images are handed over as files in its .zee-inbox)"}>
                💬 talk
              </button>
            )}
            {/* PER-XELL LANGFUSE TRACKING knob (human side): shown when the Langfuse plugin is
                enabled. Clicking flips the xell's switch — OFF means this zee's turns are not traced
                to Langfuse and its cage gets no LANGFUSE_* env. */}
            {xell?.id && langfuseEnabled && onToggleLangfuse && (
              <button className={`term-x lf${xell.langfuse_tracking !== false ? ' on' : ''}`}
                      data-testid="langfuse-toggle" onClick={onToggleLangfuse}
                      title={xell.langfuse_tracking !== false
                        ? 'Langfuse tracking is ON — traces of this zee\'s turns are posted to Langfuse. Click to turn OFF.'
                        : 'Langfuse tracking is OFF — no traces are posted for this zee\'s turns and its cage gets no LANGFUSE_* env. Click to turn ON.'}>
                ⚗ {xell.langfuse_tracking !== false ? 'on' : 'off'}
              </button>
            )}
            <button className={`term-x${clipOpen ? ' on' : ''}${clip && !clipOpen ? ' dot' : ''}`} data-testid="clip-toggle"
                    onClick={() => setClipOpen((v) => !v)}
                    title="Clipboard — selections you Shift+drag land here (works even when the OS clipboard is blocked)">📋</button>
            {(explorerZeeId || explorerContainer) && (
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
          {(explorerZeeId || explorerContainer) && showFx && (
            <FileExplorer zeeId={explorerZeeId} container={explorerContainer} openReq={fxReq}
                          onClose={() => setShowFx(false)} />
          )}
          <div className="zeeterm-body" ref={holder} onContextMenu={onContextMenu} />
          {/* The SAME composer the hexagon's 📨 button opens (one delivery path, one set of rules
              about long text and images) — rendered INSIDE the terminal, because the terminal is
              where a human is standing when they want to say something to this zee. */}
          {talkOpen && xell?.id && (
            <MessageComposer xell={xell} onClose={() => { setTalkOpen(false); termRef.current?.focus(); }}
                             onSent={(r) => { setTalkOpen(false); talkReceipt(r); }} />
          )}
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

// A live terminal INTO a cxell zee. The browser terminal (xterm or wterm — Console settings)
// talks to /api/zees/:id/terminal (a websocket), which the queenzee bridges over SSH to a PTY on
// `tmux new -A -s zee` inside the cxell — so this is the same interactive `claude` you'd get over
// SSH, prompt by prompt, and disconnecting leaves the session running (tmux). The SSH line below
// is that exact door for Claude Code desktop's "Add SSH host" — the deeplink IS the SSH connection.
export default function ZeeTerminal({ zeeId, slug, viewerUrl, xellId = null, langfuseTracking = true, langfuseEnabled = false, onClose }) {
  const [copied, setCopied] = useState(false);
  // The Langfuse tracking switch, kept locally so the header knob reflects the click instantly and
  // reverts if the server refuses. Initialised from the xell row's flag (default ON).
  const [lf, setLf] = useState(!!langfuseTracking);

  // ssh://zee@127.0.0.1:PORT → a copy-pasteable ssh command (external attach)
  let sshCmd = null;
  try {
    const u = new URL(viewerUrl);
    sshCmd = `ssh -i ~/.zeehive/ssh/cxell_id_ed25519 -p ${u.port} ${u.username || 'zee'}@${u.hostname}`;
  } catch { /* no url */ }

  const copy = async () => {
    try { await navigator.clipboard.writeText(sshCmd); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* */ }
  };

  // Flip the per-xell Langfuse tracking switch. Optimistic (the knob reflects the click at once);
  // on a refusal the flag is reverted and the error logged — a console knob must never throw.
  const toggleLangfuse = async () => {
    if (!xellId) return;
    const next = !lf;
    setLf(next);
    try {
      await setXellLangfuseTracking(xellId, next);
    } catch (e) {
      setLf(!next);
      console.error('langfuse tracking toggle failed', e);
    }
  };

  const foot = (
    <div className="zeeterm-foot">
      {/* Copy is non-obvious: tmux mouse mode owns a plain drag, so a browser selection needs Shift.
          Surface it so nobody has to guess (reported: "I can't copy text"). */}
      <span className="pc kbd-hint" title="A plain drag goes to the app; Shift+drag makes a selection, captured into the 📋 clipboard tray">
        <b>Shift+drag</b> → 📋 clipboard · click a <b>path</b> to open it · <b>✱ ⚒</b> filter the live feed
        {' · '}<b>💬 talk</b> to it (works mid-turn)
      </span>
      <input className="mono" readOnly value={sshCmd || ''} onFocus={(e) => e.target.select()} />
      <button type="button" onClick={copy}>{copied ? '✓ copied' : '⧉ copy'}</button>
    </div>
  );

  return <TerminalModal wsPath={`/api/zees/${zeeId}/terminal`} title={slug} foot={foot}
                        explorerZeeId={zeeId}
                        xell={xellId ? { id: xellId, slug, langfuse_tracking: lf } : null}
                        langfuseEnabled={langfuseEnabled} onToggleLangfuse={toggleLangfuse}
                        onClose={onClose} />;
}

// A shell inside a fleet container, opened from the chip's context menu. The bridge runs a
// docker-exec TTY (bash, or sh where the image has no bash) — no sshd required in the target.
// It carries the SAME terminal features the xell door has: a file explorer into the container's
// filesystem, clickable paths in the output, and a footer with a copyable docker-exec command so
// a human can reach the same shell from their own machine. A PRODUCTION container's modal wears
// the fleet's gold warning, same as its chip.
export function ContainerTerminal({ c, onClose }) {
  const [copied, setCopied] = useState(false);

  // The copyable command: a docker exec into the same shell the bridge opens. Computed server-side
  // (fleet.js containerShellCmd) because only the server knows the REAL target — a db's versioned
  // name, a process role's queenzee-container + worktree. Fall back to the row name if the server
  // is older and did not send it.
  const dockerCmd = c.shell_cmd || (() => {
    const ctx = c.docker_ctx && c.docker_ctx !== 'default' ? c.docker_ctx : null;
    return (ctx ? `docker --context ${ctx} exec -it` : 'docker exec -it') + ` ${c.name} bash`;
  })();

  const copy = async () => {
    try { await navigator.clipboard.writeText(dockerCmd); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* */ }
  };

  const foot = (
    <div className="zeeterm-foot">
      {/* Same non-obvious-copy hint as the zee terminal: tmux/readline owns a plain drag, so a
          browser selection needs Shift — and it is captured into the 📋 clipboard tray. */}
      <span className="pc kbd-hint" title="A plain drag goes to the app; Shift+drag makes a selection, captured into the 📋 clipboard tray">
        <b>Shift+drag</b> → 📋 clipboard · click a <b>path</b> to open it in the explorer
      </span>
      <input className="mono" readOnly value={dockerCmd || ''} onFocus={(e) => e.target.select()} />
      <button type="button" onClick={copy} title="Copy the docker exec command to reach this shell from your own machine">
        {copied ? '✓ copied' : '⧉ copy'}
      </button>
    </div>
  );

  return <TerminalModal wsPath={`/api/containers/${c.id}/terminal`} title={c.name}
                        prod={c.tier === 'prod'} foot={foot} explorerContainer={c}
                        onClose={onClose} />;
}

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

// One live-terminal modal, two doors (same wire protocol on both — {t:'i'} keystrokes and
// {t:'r'} resizes up, raw bytes down):
//   ZeeTerminal       → /api/zees/:id/terminal       (SSH → tmux inside a cxell)
//   ContainerTerminal → /api/containers/:id/terminal (docker exec shell in ANY container)
// TerminalModal is the shared body: xterm + fit + the resize/refit choreography, fullscreen,
// and the status pill. The flavors differ only in title, footer, and prod styling.
// `explorerZeeId` (cxell zees only) lights up the 📁 file-explorer panel and the "show file"
// entry in the right-click menu.
export function TerminalModal({ wsPath, title, prod = false, foot = null, explorerZeeId = null, onClose }) {
  const holder = useRef(null);
  const termRef = useRef(null);
  const reqN = useRef(0);
  const [status, setStatus] = useState('connecting');
  const [full, setFull] = useState(false);   // maximize the modal; the ResizeObserver refits + resizes the PTY
  const [showFx, setShowFx] = useState(false);       // file-explorer panel open?
  const [fxReq, setFxReq] = useState(null);          // { path, n } — a "show file" request into the explorer

  // Open a path in the explorer (opening the panel if needed). The bumping `n` makes every request
  // distinct so clicking the SAME path again re-opens it (identity, not value, drives the effect).
  const openInExplorer = (p) => { if (!p) return; setShowFx(true); setFxReq({ path: p, n: ++reqN.current }); };

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
    ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
    ws.onclose = () => setStatus('closed');
    ws.onerror = () => setStatus('error');
    term.onData((d) => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'i', d })));
    term.onResize(sendResize);

    // CLIPBOARD. xterm renders to a canvas, so a highlight is xterm's OWN selection, not a browser
    // text selection — the browser's copy has nothing to grab (reported: "Ctrl+Shift+C doesn't
    // work, I can't copy"). So wire it explicitly:
    //  • copy-on-select — the moment a selection exists (Shift+drag, since tmux mouse mode owns a
    //    plain drag), push it to the system clipboard. This is the no-shortcut path that just works.
    // clipboard API where it exists (secure context incl. localhost); best-effort, never throws.
    const clipApi = (t) => { try { return navigator.clipboard?.writeText(t); } catch { return null; } };
    // legacy fallback for an insecure context (console opened on a bare IP over http, where
    // navigator.clipboard is undefined): a throwaway textarea + execCommand('copy'). It steals
    // focus for an instant, so it is used ONLY on the explicit shortcut, not on copy-on-select.
    const execCopy = (t) => {
      try {
        const ta = document.createElement('textarea');
        ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta); term.focus();
      } catch { /* nothing more we can do */ }
    };
    term.onSelectionChange(() => { const s = term.getSelection(); if (s) clipApi(s); });
    //  • explicit shortcuts as a fallback: Ctrl+Shift+C / Cmd+C copy the selection; Ctrl+Shift+V /
    //    Cmd+V paste into the PTY. We swallow these so they don't reach the shell (plain Ctrl+C stays
    //    SIGINT — we never touch it). attachCustomKeyEventHandler returning false blocks the key.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const combo = (e.ctrlKey && e.shiftKey) || e.metaKey;   // Linux/Win: Ctrl+Shift+_, mac: Cmd+_
      if (!combo) return true;
      if (e.code === 'KeyC' && term.hasSelection()) {
        const s = term.getSelection();
        const p = clipApi(s);
        if (p && p.catch) p.catch(() => execCopy(s)); else if (!p) execCopy(s);
        return false;
      }
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
      termRef.current = null;
    };
  }, [wsPath]);

  // The right-click CONFLICT fix: xterm forwards mouse events to the terminal app (tmux mouse mode
  // is on for scroll), but the browser ALSO pops its page menu (Back/Reload/Inspect) on top — that
  // is the clash. Just suppress the browser menu so the right-click belongs to the terminal; we do
  // NOT draw a replacement menu. (Because tmux mouse mode owns a plain drag, hold Shift while
  // dragging to make a selection — the copy-on-select handler above puts it on the clipboard.)
  const onContextMenu = (e) => e.preventDefault();

  // "Show file" from the header button: read whatever path is selected in the terminal (a Shift+drag
  // selection) and open it. The primary path is now just CLICKING a link in the output; this covers
  // the case where a path isn't on its own token (e.g. selected across words).
  const showFileFromSelection = () => {
    const p = pathFromSelection(termRef.current?.getSelection?.() || '');
    if (p) openInExplorer(p); else setShowFx(true);
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
          <span>
            {explorerZeeId && (
              <button className="term-x" data-testid="fx-showfile" onClick={showFileFromSelection}
                      title="Show file — click a path in the output, or Shift+drag to select one, then this">📄</button>
            )}
            {explorerZeeId && (
              <button className={`term-x${showFx ? ' on' : ''}`} data-testid="fx-toggle"
                      onClick={() => setShowFx((v) => !v)}
                      title={showFx ? 'Hide file explorer' : 'Show file explorer'}>📁</button>
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
      <span className="pc kbd-hint" title="A plain drag scrolls/goes to the app; Shift+drag makes a copyable selection">
        <b>Shift+drag</b> to select &amp; copy · click a <b>path</b> to open it
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

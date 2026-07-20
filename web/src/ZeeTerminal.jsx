import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// One live-terminal modal, two doors (same wire protocol on both — {t:'i'} keystrokes and
// {t:'r'} resizes up, raw bytes down):
//   ZeeTerminal       → /api/zees/:id/terminal       (SSH → tmux inside a cxell)
//   ContainerTerminal → /api/containers/:id/terminal (docker exec shell in ANY container)
// TerminalModal is the shared body: xterm + fit + the resize/refit choreography, fullscreen,
// and the status pill. The flavors differ only in title, footer, and prod styling.
export function TerminalModal({ wsPath, title, prod = false, foot = null, onClose }) {
  const holder = useRef(null);
  const [status, setStatus] = useState('connecting');
  const [full, setFull] = useState(false);   // maximize the modal; the ResizeObserver refits + resizes the PTY

  useEffect(() => {
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13,
      theme: { background: '#0b0e14' }, cursorBlink: true, scrollback: 5000,
    });
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

    const onWin = () => { refit(); };
    window.addEventListener('resize', onWin);
    const ro = new ResizeObserver(() => { refit(); });
    if (holder.current) ro.observe(holder.current);

    return () => {
      cancelAnimationFrame(raf); clearTimeout(settle);
      window.removeEventListener('resize', onWin); ro.disconnect();
      try { ws.close(); } catch {} term.dispose();
    };
  }, [wsPath]);

  return createPortal(
    <div className="term-overlay" onClick={onClose}>
      <div className={`zeeterm${full ? ' full' : ''}${prod ? ' prod' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className={`term-head${prod ? ' prod' : ''}`}>
          <span className="term-title">⌨ {title}
            {prod && <span className="term-prodtag" data-testid="term-prodtag">PRODUCTION</span>}
            <span className={`tstat t-${status}`}>{status}</span>
          </span>
          <span>
            <button className="term-x" onClick={() => setFull(!full)} title={full ? 'Exit fullscreen' : 'Fullscreen'}>{full ? '⇲' : '⛶'}</button>
            <button className="term-x" onClick={onClose} title="Close">✕</button>
          </span>
        </div>
        <div className="zeeterm-body" ref={holder} />
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
      <span className="pc">Attach from Claude Code desktop or a shell (same box, tmux-persisted):</span>
      <input className="mono" readOnly value={sshCmd || ''} onFocus={(e) => e.target.select()} />
      <button type="button" onClick={copy}>{copied ? '✓ copied' : '⧉ copy'}</button>
    </div>
  );

  return <TerminalModal wsPath={`/api/zees/${zeeId}/terminal`} title={slug} foot={foot} onClose={onClose} />;
}

// A shell inside a fleet container, opened from the chip's context menu. The bridge runs a
// docker-exec TTY (bash, or sh where the image has no bash) — no sshd required in the target.
// A PRODUCTION container's modal wears the fleet's gold warning, same as its chip.
export function ContainerTerminal({ c, onClose }) {
  return <TerminalModal wsPath={`/api/containers/${c.id}/terminal`} title={c.name}
                        prod={c.tier === 'prod'} onClose={onClose} />;
}

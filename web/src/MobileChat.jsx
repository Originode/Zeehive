import React, { useEffect, useRef, useState } from 'react';
import {
  getFleet, getProjects, dispatchTask,
  getXellObservability, getTurnEvents, getXellMessages, sendXellMessage,
  nudgeXell, pauseXell, resumeXell,
} from './api.js';
import { hiveColor, hiveStatusLabel } from './hive/status.js';

// ────────────────────────────────────────────────────────────────────────────────
// MOBILE CHAT UI — /m?project=<name>
//
// A phone-first, read-heavy surface over the same API the console uses. No gates, no
// admin panels: one box per xell, a prompt button to deploy a zee, and tapping a box
// opens a detail screen with a clean per-turn observability ledger and a chat input
// that talks to the xell's live cxell zee (the same /xells/:id/message door as the
// console's 📨 composer). A terminal button deep-links into the xell's viewer_url
// (ssh:// for a cxell zee) so an operator can jump into the raw session.
//
// Deliberately plain polling (every 5s) rather than the console's SSE subscribe: this
// page is meant to be small and self-contained, and the fleet read model is cheap.
// ────────────────────────────────────────────────────────────────────────────────

const PROJECT_PARAM = 'project';
const XELL_PARAM = 'xell';
const PROJECT_KEY = 'zeehive.project';
const POLL_MS = 5000;

// Resolve a project from a URL token (?project=…), matched against either the id or the
// name (case-insensitive) — the same rule the console uses.
const findByToken = (ps, token) =>
  token
    ? ps.find((p) => p.id === token || p.name?.toLowerCase() === String(token).toLowerCase())
    : null;

const readParam = (key) => {
  try { return new URLSearchParams(window.location.search).get(key); } catch { return null; }
};

// Keep the URL in step WITHOUT adding history entries, so Back does not walk through
// every xell box you tapped.
const writeParams = (params) => {
  try {
    const url = new URL(window.location.href);
    for (const [k, v] of Object.entries(params)) {
      if (v == null || v === '') url.searchParams.delete(k);
      else url.searchParams.set(k, v);
    }
    window.history.replaceState(null, '', url);
  } catch { /* history unavailable — non-fatal */ }
};

// Hand a custom-scheme URL (ssh://, claude://…) to the OS protocol handler. An anchor
// click instead of window.open avoids a blank tab and never unloads the app.
function openProtocol(url) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ── tiny formatters (same shapes the console uses) ────────────────────────────────
const fmtUsd = (v) => (v === null || v === undefined ? '—' : `$${Number(v).toFixed(4)}`);
const fmtTok = (v) => {
  const n = Number(v || 0);
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
};
const fmtDur = (a, b) => {
  if (!a || !b) return '—';
  const s = (new Date(b) - new Date(a)) / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
};
const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const fmtDt = (d) => (d ? new Date(d).toLocaleString() : '—');
const clip = (s, n = 90) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const shortBranch = (b) => {
  const s = String(b || '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
};
const kindIcon = (k) => ({ spawn: '🚀', resume: '↻', interactive: '⌨' }[k] || '·');
const statusLabel = (s) => ({ started: 'running', ended: 'done', errored: 'errored', paused: 'paused' }[s] || s || '—');

// ── the mobile chat app ──────────────────────────────────────────────────────────
export default function MobileChat() {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(null);
  const [fleet, setFleet] = useState(null);
  const [xells, setXells] = useState([]);
  const [selId, setSelId] = useState(null);
  const [err, setErr] = useState(null);
  const [notice, setNotice] = useState(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptText, setPromptText] = useState('');
  const [dispatching, setDispatching] = useState(false);

  // Load the project list and pick the active project: URL param wins, then the
  // last-used project, then the first.
  useEffect(() => {
    let dead = false;
    getProjects()
      .then((ps) => {
        if (dead) return;
        setProjects(ps);
        const fromUrl = findByToken(ps, readParam(PROJECT_PARAM));
        const stored = localStorage.getItem(PROJECT_KEY);
        const picked = fromUrl || ps.find((p) => p.id === stored) || ps[0] || null;
        setProjectId(picked?.id || null);
      })
      .catch((e) => { if (!dead) setErr(e.message); });
    return () => { dead = true; };
  }, []);

  // Poll the fleet read model for the selected project.
  useEffect(() => {
    if (!projectId) return;
    let dead = false;
    const load = async () => {
      try {
        const f = await getFleet(projectId);
        if (dead) return;
        setFleet(f);
        setXells(f.xells || []);
        setErr(null);
      } catch (e) { if (!dead) setErr(e.message); }
    };
    load();
    const iv = setInterval(load, POLL_MS);
    return () => { dead = true; clearInterval(iv); };
  }, [projectId]);

  // Pick up a deeplinked ?xell= id when the project resolves.
  useEffect(() => {
    setSelId(readParam(XELL_PARAM) || null);
  }, [projectId]);

  const selected = selId ? xells.find((x) => x.id === selId) : null;
  // The selected xell was retired/reaped — drop back to the list.
  useEffect(() => {
    if (selId && fleet && !selected) setSelId(null);
  }, [selId, selected, fleet]);

  const project = projects.find((p) => p.id === projectId) || null;

  const selectProject = (id) => {
    setProjectId(id || null);
    if (id) localStorage.setItem(PROJECT_KEY, id);
    else localStorage.removeItem(PROJECT_KEY);
    writeParams({ [PROJECT_PARAM]: projects.find((p) => p.id === id)?.name || null, [XELL_PARAM]: null });
  };

  const deploy = async () => {
    const task = promptText.trim();
    if (!task) { setNotice('Write a prompt first.'); return; }
    setDispatching(true); setNotice(null); setErr(null);
    try {
      await dispatchTask({ project: projectId, task });
      setNotice('Zee dispatched — it will appear as a box below.');
      setPromptText(''); setPromptOpen(false);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setDispatching(false); }
  };

  const status = fleet?.status || null;

  return (
    <div className="mob">
      {selected ? (
        <XellDetail xell={selected} projectName={project?.name}
                    onBack={() => { setSelId(null); writeParams({ [XELL_PARAM]: null }); }} />
      ) : (
        <div className="mob-list">
          <header className="mob-top">
            <div className="mob-top-l">
              <span className="mob-logo">◇</span>
              <div className="mob-top-txt">
                <div className="mob-title">ZEEHIVE</div>
                {projects.length > 1 ? (
                  <select className="mob-proj" value={projectId || ''}
                          onChange={(e) => selectProject(e.target.value)}
                          aria-label="project">
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                ) : project ? (
                  <div className="mob-proj-static">{project.name}</div>
                ) : null}
              </div>
            </div>
            <button className="mob-new" onClick={() => setPromptOpen((v) => !v)}>
              <span className="mob-new-ic">＋</span><span className="mob-new-lbl">new zee</span>
            </button>
          </header>

          {promptOpen && (
            <div className="mob-prompt">
              <textarea
                className="mob-prompt-ta"
                placeholder="What should the zee do?"
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                rows={3}
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); deploy(); } }}
              />
              <div className="mob-prompt-actions">
                <button className="mob-btn" onClick={deploy} disabled={dispatching || !promptText.trim()}>
                  {dispatching ? 'Deploying…' : 'Deploy zee'}
                </button>
              </div>
            </div>
          )}

          {notice && <div className="mob-notice" onClick={() => setNotice(null)}>{notice} <span className="mob-x">✕</span></div>}
          {err && <div className="mob-err" onClick={() => setErr(null)}>⚠ {err} <span className="mob-x">✕</span></div>}

          <div className="mob-count">
            {status ? `${status.working} working · ${status.total} xells` : project ? 'loading…' : ''}
          </div>

          <div className="mob-boxes">
            {xells.map((x) => (
              <XellBox key={x.id} x={x}
                       onClick={() => { setSelId(x.id); writeParams({ [XELL_PARAM]: x.id }); }} />
            ))}
            {!xells.length && !err && <div className="mob-empty">No xells yet — deploy one.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── list: one box per xell ──────────────────────────────────────────────────────
export function XellBox({ x, onClick }) {
  const color = hiveColor(x.hive_status);
  const label = hiveStatusLabel(x);
  const total = x.stack?.length || 0;
  const up = x.stack?.filter((c) => c.health === 'up').length || 0;
  const task = x.zee_title || x.task_text || null;
  return (
    <button className="mob-box" onClick={onClick}>
      <span className="mob-box-head">
        <span className="mob-box-name">{x.slug}</span>
        <span className="mob-badge" style={{ background: color, color: '#0d1017' }}>{label}</span>
      </span>
      {task && <span className="mob-box-task">{clip(task, 100)}</span>}
      <span className="mob-box-foot">
        <span className="mono mob-branch">{shortBranch(x.branch) || '—'}</span>
        <span className="mob-box-meta">
          {x.burn?.cost ? `$${Number(x.burn.cost).toFixed(2)}` : '$0.00'} · {fmtTok(x.burn?.tokens)} tok
          {total ? ` · ${up}/${total} up` : ''}
        </span>
      </span>
    </button>
  );
}

// ── detail: header + tabs (Activity / Chat) ─────────────────────────────────────
export function XellDetail({ xell, projectName, onBack }) {
  const [tab, setTab] = useState('chat');
  const [turns, setTurns] = useState([]);
  const [msgs, setMsgs] = useState([]);
  const [openTurn, setOpenTurn] = useState(null);
  const [termOpen, setTermOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let dead = false;
    const loadObs = async () => {
      try { const r = await getXellObservability(xell.id, { limit: 30 }); if (!dead) setTurns(r.turns || []); }
      catch (e) { if (!dead) setErr(e.message); }
    };
    const loadMsgs = async () => {
      try { const r = await getXellMessages(xell.id); if (!dead) setMsgs(r || []); }
      catch (e) { if (!dead) setErr(e.message); }
    };
    loadObs(); loadMsgs();
    const iv = setInterval(() => { loadObs(); loadMsgs(); }, POLL_MS);
    return () => { dead = true; clearInterval(iv); };
  }, [xell.id]);

  const color = hiveColor(xell.hive_status);
  const label = hiveStatusLabel(xell);

  return (
    <div className="mob-detail">
      <header className="mob-dtop">
        <button className="mob-back" onClick={onBack} aria-label="back">←</button>
        <div className="mob-dtop-mid">
          <div className="mob-dname">{xell.slug}</div>
          <div className="mob-dsub">
            <span className="mob-badge" style={{ background: color, color: '#0d1017' }}>{label}</span>
            <span className="mono mob-dbranch">{shortBranch(xell.branch)}</span>
          </div>
        </div>
        <div className="mob-dactions">
          <button className="mob-term" onClick={() => setTermOpen((v) => !v)} title="terminal">⌨</button>
          <button className="mob-term mob-menu-btn" onClick={() => setMenuOpen((v) => !v)}
                  title="context actions" aria-label="xell actions" aria-expanded={menuOpen}>⋮</button>
        </div>
      </header>

      {termOpen && <TerminalSheet x={xell} onClose={() => setTermOpen(false)} />}
      {menuOpen && <XellMenu x={xell} projectName={projectName} onClose={() => setMenuOpen(false)} />}

      <div className="mob-tabs">
        <button className={`mob-tab${tab === 'obs' ? ' on' : ''}`} onClick={() => setTab('obs')}>Activity</button>
        <button className={`mob-tab${tab === 'chat' ? ' on' : ''}`} onClick={() => setTab('chat')}>Chat</button>
      </div>

      {err && <div className="mob-err" onClick={() => setErr(null)}>⚠ {err} <span className="mob-x">✕</span></div>}

      {tab === 'obs'
        ? <ObsList turns={turns} openTurn={openTurn} setOpenTurn={setOpenTurn} />
        : <ChatPane xell={xell} msgs={msgs} />}
    </div>
  );
}

// ── observability: the per-turn ledger, compact ────────────────────────────────
export function ObsList({ turns, openTurn, setOpenTurn }) {
  if (!turns.length) return <div className="mob-empty">No turns recorded yet.</div>;
  return (
    <div className="mob-obs">
      {turns.map((t) => (
        <TurnCard key={t.id} turn={t}
                  open={openTurn === t.id}
                  onToggle={() => setOpenTurn(openTurn === t.id ? null : t.id)} />
      ))}
    </div>
  );
}

export function TurnCard({ turn, open, onToggle }) {
  const [events, setEvents] = useState(null);
  const [busy, setBusy] = useState(false);
  const tokens = Number(turn.input_tokens || 0) + Number(turn.output_tokens || 0)
    + Number(turn.cache_read_tokens || 0) + Number(turn.cache_write_tokens || 0);
  const toggle = async () => {
    if (open) { onToggle(); return; }
    onToggle();
    setBusy(true);
    try { const r = await getTurnEvents(turn.id); setEvents(r.events || []); }
    catch { setEvents([]); }
    finally { setBusy(false); }
  };
  return (
    <div className={`mob-turn${open ? ' open' : ''}`}>
      <button className="mob-turn-h" onClick={toggle} aria-expanded={open}>
        <span className="mob-turn-ic">{kindIcon(turn.kind)}</span>
        <span className="mob-turn-main">
          <span className="mob-turn-model">{turn.model || '—'}</span>
          {turn.summary && <span className="mob-turn-sum">{clip(turn.summary, 140)}</span>}
          <span className="mob-turn-meta">
            {fmtDt(turn.started_at)} · {fmtDur(turn.started_at, turn.ended_at)} · {fmtTok(tokens)} tok · {fmtUsd(turn.cost_usd)}
          </span>
        </span>
        <span className={`mob-turn-status ${turn.status || ''}`}>{statusLabel(turn.status)}</span>
        <span className="mob-turn-chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="mob-turn-body">
          {busy && <div className="mob-hint">loading events…</div>}
          {!busy && events && (events.length === 0
            ? <div className="mob-hint">No play-by-play events recorded for this turn.</div>
            : events.map((ev, i) => <EventLine key={i} ev={ev} />))}
        </div>
      )}
    </div>
  );
}

// One play-by-play event, rendered as a readable line (the console's eventLine, compact).
export function EventLine({ ev }) {
  let raw = ev?.raw && typeof ev.raw === 'object' ? ev.raw : {};
  if (!raw || typeof raw !== 'object') { try { raw = JSON.parse(ev?.raw || '{}'); } catch { raw = {}; } }
  const ts = ev?.ts ? new Date(ev.ts).toLocaleTimeString() : '';
  const type = ev?.hook_event_name || raw?.type || 'event';
  switch (type) {
    case 'assistant': {
      const blocks = raw?.message?.content || [];
      const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join(' ').trim();
      const tools = blocks.filter((b) => b?.type === 'tool_use').map((b) => b.name);
      if (text) return <div className="mob-ev"><span className="mob-ev-ts">{ts}</span><span className="mob-ev-text">{text.slice(0, 320)}</span></div>;
      if (tools.length) return <div className="mob-ev"><span className="mob-ev-ts">{ts}</span><span className="mob-ev-tools">⚒ {tools.join(', ')}</span></div>;
      return <div className="mob-ev"><span className="mob-ev-ts">{ts}</span><span>assistant</span></div>;
    }
    case 'tool_use': {
      const name = raw?.name || ev?.tool_name || 'tool';
      const input = raw?.input ? JSON.stringify(raw.input).slice(0, 160) : '';
      return <div className="mob-ev"><span className="mob-ev-ts">{ts}</span><span className="mob-ev-tools">⚒ <b>{name}</b>{input ? <code> {input}</code> : null}</span></div>;
    }
    case 'result': {
      const isErr = raw?.is_error;
      const cost = raw?.total_cost_usd;
      return <div className="mob-ev"><span className="mob-ev-ts">{ts}</span><span>{isErr ? '✗ result (error)' : '✓ result'}{cost != null ? ` · $${Number(cost).toFixed(4)}` : ''}</span></div>;
    }
    default: {
      const snippet = typeof raw === 'string' ? raw.slice(0, 120) : (raw?.subtype || raw?.name || '');
      return <div className="mob-ev"><span className="mob-ev-ts">{ts}</span><span>{type}{snippet ? <code> {String(snippet).slice(0, 120)}</code> : null}</span></div>;
    }
  }
}

// ── chat: message bubbles + input ───────────────────────────────────────────────
export function ChatPane({ xell, msgs }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const endRef = useRef(null);
  // API returns newest-first; a chat reads oldest-first.
  const sorted = [...msgs].reverse();

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [msgs.length]);

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await sendXellMessage(xell.id, { text: t });
      if (r?.sent === false && r?.reason) setErr(r.reason);
      setText('');
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="mob-chat">
      <div className="mob-msgs">
        {sorted.map((m) => {
          const mine = m.from_xell_id !== xell.id;   // operator side (from_xell_id NULL for console)
          return (
            <div key={m.id} className={`mob-msg ${mine ? 'mine' : 'theirs'}`}>
              <div className="mob-msg-bubble">
                <span className="mob-msg-body">{m.body}</span>
                <span className="mob-msg-meta">
                  {mine ? 'you' : (m.from || 'zee')}
                  {m.delivered === false ? ' · unsent' : ''} · {fmtTime(m.at)}
                </span>
              </div>
            </div>
          );
        })}
        {!sorted.length && <div className="mob-empty">No messages yet — say hi.</div>}
        <div ref={endRef} />
      </div>
      <div className="mob-composer">
        {err && <div className="mob-err" onClick={() => setErr(null)}>⚠ {err} <span className="mob-x">✕</span></div>}
        <div className="mob-composer-row">
          <textarea
            className="mob-in"
            placeholder="Message the zee…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={1}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
          <button className="mob-send" onClick={send} disabled={busy || !text.trim()} aria-label="send">➤</button>
        </div>
      </div>
    </div>
  );
}

// ── context actions: the ⋮ menu for one xell ────────────────────────────────────
// A pure item list (like the console's xellContextMenuItems) so the menu can be
// render-tested without a browser. Order: live verbs first (nudge/pause/resume —
// only on a cxell zee, which has a live SSH session to reach), then the escape
// hatch to the full console, then the copy rows.
export function xellMenuItems(x) {
  const items = [];
  const cxell = x.viewer_kind === 'ssh-terminal' && !!x.viewer_url;
  const xPaused = x.hive_status === 'occ-paused' || x.xell_paused === true;
  if (cxell) {
    items.push({ kind: 'nudge', label: '💬 Nudge zee' });
    items.push(xPaused
      ? { kind: 'resume', label: '▶ Resume' }
      : { kind: 'pause', label: '⏸ Pause', danger: true });
  }
  items.push({ kind: 'console', label: '🖥 Open in console' });
  if (x.branch) items.push({ kind: 'copyBranch', label: '⑂ Copy branch', copy: x.branch });
  items.push({ kind: 'copyId', label: '🆔 Copy xell ID', copy: x.id });
  const task = x.zee_title || x.task_text;
  if (task) items.push({ kind: 'copyTask', label: '📋 Copy task', copy: task });
  if (x.viewer_url) items.push({ kind: 'copyUrl', label: '🔗 Copy terminal link', copy: x.viewer_url });
  return items;
}

// The bottom sheet the ⋮ button opens: one row per context action, with inline
// feedback for the async verbs (nudge/pause/resume) and the copy rows.
export function XellMenu({ x, projectName, onClose }) {
  const [busy, setBusy] = useState(null);   // the kind currently running
  const [msg, setMsg] = useState(null);     // { tone: 'ok'|'err', text }
  const items = xellMenuItems(x);

  const done = (tone, text) => { setMsg({ tone, text }); setTimeout(onClose, tone === 'ok' ? 900 : 2600); };

  const run = async (it) => {
    if (busy) return;
    try {
      if (it.kind === 'nudge') {
        setBusy(it.kind);
        const r = await nudgeXell(x.id);
        if (r?.nudged) done('ok', 'Nudged ✓');
        else done('err', r?.reason || r?.error || 'No live zee to reach.');
      } else if (it.kind === 'pause') {
        setBusy(it.kind);
        const r = await pauseXell(x.id);
        if (r?.ok) done('ok', 'Paused ✓');
        else done('err', r?.reason || 'Server refused.');
      } else if (it.kind === 'resume') {
        setBusy(it.kind);
        const r = await resumeXell(x.id);
        if (r?.ok) done('ok', 'Resumed ✓');
        else done('err', r?.reason || 'Server refused.');
      } else if (it.kind === 'console') {
        window.open(`/?project=${encodeURIComponent(projectName || '')}`, '_blank', 'noopener');
        onClose();
      } else if (it.copy) {
        try { await navigator.clipboard.writeText(it.copy); done('ok', 'Copied ✓'); }
        catch { done('err', 'Clipboard unavailable.'); }
      }
    } catch (e) { done('err', e?.message || String(e)); }
    finally { setBusy(null); }
  };

  return (
    <div className="mob-sheet-back" onClick={onClose}>
      <div className="mob-sheet mob-menu" onClick={(e) => e.stopPropagation()}>
        <div className="mob-sheet-title">Actions <span className="mob-menu-sub">{x.slug}</span></div>
        {msg && <div className={`mob-menu-msg ${msg.tone}`}>{msg.text}</div>}
        <div className="mob-menu-items">
          {items.map((it) => (
            <button key={it.kind} className={`mob-menu-item${it.danger ? ' danger' : ''}`}
                    onClick={() => run(it)} disabled={busy !== null}>
              <span className="mob-menu-lbl">{it.label}</span>
              {busy === it.kind ? <span className="mob-menu-busy">…</span> : null}
            </button>
          ))}
        </div>
        <button className="mob-sheet-close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

// ── terminal: deep-link into the xell's viewer ──────────────────────────────────
export function TerminalSheet({ x, onClose }) {
  const url = x.viewer_url;
  const kind = x.viewer_kind;
  const isWeb = kind === 'web' || (url && /^https?:/.test(url));
  const open = () => {
    if (!url) return;
    if (isWeb) window.open(url, '_blank', 'noopener');
    else openProtocol(url);
    onClose();
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); } catch { /* clipboard unavailable */ }
  };
  return (
    <div className="mob-sheet-back" onClick={onClose}>
      <div className="mob-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="mob-sheet-title">Terminal</div>
        {url ? (
          <div className="mob-sheet-body">
            <p className="mob-sheet-hint">
              {kind === 'ssh-terminal'
                ? 'Deep-link into this cxell\'s SSH session. Opens in your terminal app, or copy the address.'
                : isWeb
                  ? 'Open this xell\'s session in a new tab.'
                  : 'Open this xell\'s session via its protocol deeplink.'}
            </p>
            <code className="mob-sheet-url">{url}</code>
            <div className="mob-sheet-actions">
              <button className="mob-btn" onClick={open}>{kind === 'ssh-terminal' ? 'Open deeplink' : 'Open'}</button>
              <button className="mob-btn ghost" onClick={copy}>Copy</button>
            </div>
          </div>
        ) : (
          <div className="mob-sheet-body">
            <p className="mob-sheet-hint">No terminal link for this xell.</p>
          </div>
        )}
        <button className="mob-sheet-close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

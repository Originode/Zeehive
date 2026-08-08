import React, { useCallback, useEffect, useState } from 'react';
import { getXellObservability, getTurnEvents, getXellGatewayRequests } from './api.js';

// XELL OBSERVABILITY — the per-turn ledger behind a xell's right-click action.
//
// WHY IT EXISTS: a human wants to right-click a xell and see, per TURN, what the zee did
// (play-by-play), what it cost, and how many tokens it burned. The zee row carries LIFETIME
// burn; this is the per-turn grain (server/src/lib/turn-ledger.js → zee_turn). Each row is one
// queenzee-started turn (spawn/resume) or one interactive turn; expanding a row fetches its
// play-by-play events (session_event rows with that turn_id — assistant text, tool calls,
// results).
//
// READ-ONLY, like every observability surface: it only reads zee_turn + session_event. Nothing
// here dispatches, approves, or changes state.
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
const fmtDt = (d) => (d ? new Date(d).toLocaleString() : '—');
const kindLabel = (k) => ({ spawn: '🚀 spawn', resume: '↻ resume', interactive: '⌨ interactive' }[k] || k || '—');
const statusLabel = (s) => ({ started: 'running', ended: '✓ done', errored: '✗ errored', paused: '⏸ paused' }[s] || s || '—');

// The play-by-play event renderer — turns a session_event row into a readable line.
function eventLine(ev) {
  const raw = ev?.raw && typeof ev.raw === 'object' ? ev.raw : (() => { try { return JSON.parse(ev?.raw || '{}'); } catch { return {}; } })();
  const ts = ev?.ts ? new Date(ev.ts).toLocaleTimeString() : '';
  const type = ev?.hook_event_name || raw?.type || 'event';
  switch (type) {
    case 'assistant': {
      const blocks = raw?.message?.content || [];
      const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join(' ').trim();
      const tools = blocks.filter((b) => b?.type === 'tool_use').map((b) => b.name);
      if (text) return <div className="ob-ev-text">{text.slice(0, 400)}</div>;
      if (tools.length) return <div className="ob-ev-tools">⚒ called: {tools.join(', ')}</div>;
      return <div className="ob-ev-meta">assistant</div>;
    }
    case 'tool_use': {
      const name = raw?.name || ev?.tool_name || 'tool';
      const input = raw?.input ? JSON.stringify(raw.input).slice(0, 200) : '';
      return <div className="ob-ev-tools">⚒ <b>{name}</b>{input ? <code> {input}</code> : null}</div>;
    }
    case 'result': {
      const err = raw?.is_error;
      const cost = raw?.total_cost_usd;
      return <div className="ob-ev-meta">{err ? '✗ result (error)' : '✓ result'}{cost != null ? ` · $${Number(cost).toFixed(4)}` : ''}</div>;
    }
    case 'system': return <div className="ob-ev-meta">system · {raw?.subtype || ''}</div>;
    default: {
      // A raw feed event we do not special-case — show its type and a small snippet.
      const snippet = typeof raw === 'string' ? raw.slice(0, 120) : (raw?.subtype || raw?.name || '');
      return <div className="ob-ev-meta">{type}{snippet ? <code> {String(snippet).slice(0, 120)}</code> : null}</div>;
    }
  }
}

function TurnRow({ turn, open, onToggle }) {
  const [events, setEvents] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const toggle = async () => {
    if (open) { onToggle(); return; }
    onToggle();
    setBusy(true); setErr(null);
    try { const r = await getTurnEvents(turn.id); setEvents(r.events || []); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  const tokens = Number(turn.input_tokens || 0) + Number(turn.output_tokens || 0)
    + Number(turn.cache_read_tokens || 0) + Number(turn.cache_write_tokens || 0);
  return (
    <div className={`ob-turn${open ? ' open' : ''}`}>
      <button className="ob-turn-h" onClick={toggle} aria-expanded={open}>
        <span className="ob-turn-kind">{kindLabel(turn.kind)}</span>
        <span className="ob-turn-status">{statusLabel(turn.status)}</span>
        <span className="ob-turn-model">{turn.model || '—'}</span>
        <span className="ob-turn-tok">{fmtTok(tokens)} tok</span>
        <span className="ob-turn-cost">{fmtUsd(turn.cost_usd)}</span>
        <span className="ob-turn-dur">{fmtDur(turn.started_at, turn.ended_at)}</span>
        <span className="ob-turn-dt">{fmtDt(turn.started_at)}</span>
        <span className="ob-turn-chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="ob-turn-body">
          {turn.summary && <div className="ob-summary"><b>said:</b> {turn.summary}</div>}
          {turn.stop_reason && turn.stop_reason !== 'end_turn' && (
            <div className="ob-stop"><b>end:</b> {turn.stop_reason}</div>
          )}
          <div className="ob-meta-grid">
            <span>session <code>{turn.session_id || '—'}</code></span>
            <span>input {fmtTok(turn.input_tokens)} · output {fmtTok(turn.output_tokens)}</span>
            <span>cache R {fmtTok(turn.cache_read_tokens)} · W {fmtTok(turn.cache_write_tokens)}</span>
            <span>metered {turn.metered ? 'yes' : 'no'}</span>
          </div>
          {busy && <div className="ob-hint">loading events…</div>}
          {err && <div className="ob-err">{err}</div>}
          {!busy && !err && events && (
            events.length === 0
              ? <div className="ob-hint">No play-by-play events recorded for this turn (the feed was not persisted, or this is an interactive turn with no captured feed).</div>
              : <div className="ob-events">{events.map((ev, i) => (
                  <div key={i} className="ob-event">
                    <span className="ob-ev-ts">{ev?.ts ? new Date(ev.ts).toLocaleTimeString() : ''}</span>
                    {eventLine(ev)}
                  </div>
                ))}</div>
          )}
        </div>
      )}
    </div>
  );
}

// The gateway calls tab — every AI request that crossed the queenzee's transparent gateway,
// newest first. Each row is one HTTP request (a messages or chat-completions POST) with the
// upstream's exact usage. This is the grain that captures ALL turn kinds: a spawn, a resume,
// and an interactive TUI session all make the same calls through the gateway.
function GatewayCalls({ requests }) {
  if (!requests.length) {
    return (
      <div className="xob-empty">
        No gateway calls recorded yet. When the gateway is live, every AI call this xell's CLIs
        make (spawn, resume, or interactive) crosses it and is recorded here with exact usage.
      </div>
    );
  }
  const sum = requests.reduce((a, r) => ({
    cost: a.cost + Number(r.cost_usd || 0),
    tokens: a.tokens + Number(r.total_tokens || 0),
  }), { cost: 0, tokens: 0 });
  return (
    <div className="xob-gw">
      <div className="xob-summary">
        <span><b>{requests.length}</b> call(s)</span>
        <span><b>{fmtTok(sum.tokens)}</b> tok total</span>
        <span><b>{fmtUsd(sum.cost)}</b> cost (shown window)</span>
      </div>
      <div className="xob-turns">
        {requests.map((r) => {
          const tokens = Number(r.total_tokens || 0);
          return (
            <div key={r.id} className="ob-turn">
              <button className="ob-turn-h" aria-expanded={false}>
                <span className="ob-turn-kind">{r.kind === 'chat-completions' ? '⚙ chat' : '📨 messages'}</span>
                <span className="ob-turn-status">{r.status === 200 ? '✓' : `✗ ${r.status || '?'}`}</span>
                <span className="ob-turn-model">{r.provider} · {r.model || '—'}</span>
                <span className="ob-turn-tok">{fmtTok(tokens)} tok</span>
                <span className="ob-turn-cost">{fmtUsd(r.cost_usd)}</span>
                <span className="ob-turn-dur">{r.duration_ms ? `${r.duration_ms}ms` : '—'}</span>
                <span className="ob-turn-dt">{fmtDt(r.requested_at)}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function XellObservability({ xell, onClose }) {
  const [data, setData] = useState(null);
  const [gwData, setGwData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [tab, setTab] = useState('turns');   // 'turns' | 'calls'

  const load = useCallback(async () => {
    if (!xell?.id) return;
    setBusy(true); setErr(null);
    try {
      const [t, g] = await Promise.all([
        getXellObservability(xell.id),
        getXellGatewayRequests(xell.id).catch(() => null),   // the gateway ledger is best-effort
      ]);
      setData(t); setGwData(g);
    }
    catch (e) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [xell?.id]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const turns = data?.turns || [];
  const sum = turns.reduce((a, t) => ({
    cost: a.cost + Number(t.cost_usd || 0),
    tokens: a.tokens + Number(t.input_tokens || 0) + Number(t.output_tokens || 0)
      + Number(t.cache_read_tokens || 0) + Number(t.cache_write_tokens || 0),
  }), { cost: 0, tokens: 0 });

  return (
    <div className="disp-overlay" onClick={onClose}>
      <div className="disp xob" role="dialog" aria-label="Xell observability" onClick={(e) => e.stopPropagation()}>
        <div className="disp-head">
          <span className="disp-title">◉ {xell.slug} — observability</span>
          <button className="disp-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="xob-body">
          {err && <div className="disp-err" data-testid="xob-err">{err}</div>}
          {!err && !data && <div className="disp-note">reading the per-turn ledger…</div>}
          {!err && data && (
            <>
              {/* Two tabs: the per-turn ledger (what a turn cost as a whole) and the LLM gateway
                  calls (every AI request that crossed the queenzee, per request). They are two
                  grains of the same observability — the gateway calls are the individual requests
                  that add up to a turn. */}
              <div className="xob-tabs">
                <button className={`xob-tab${tab === 'turns' ? ' on' : ''}`} onClick={() => setTab('turns')}>
                  Turns <span className="xob-tab-n">{turns.length}</span>
                </button>
                <button className={`xob-tab${tab === 'calls' ? ' on' : ''}`} onClick={() => setTab('calls')}>
                  Gateway calls {gwData?.requests?.length != null && <span className="xob-tab-n">{gwData.requests.length}</span>}
                </button>
              </div>

              {tab === 'turns' && (
                <>
                  <div className="xob-summary">
                    <span><b>{turns.length}</b> turn(s) recorded</span>
                    <span><b>{fmtUsd(sum.cost)}</b> total (shown window)</span>
                    <span><b>{fmtTok(sum.tokens)}</b> tok (shown window)</span>
                  </div>
                  {turns.length === 0
                    ? <div className="xob-empty">
                        No turns recorded yet. A turn appears when a zee starts working in this xell
                        (a spawn, a resume, or an interactive turn). The per-turn ledger was added in
                        migration 153 — turns that ran before then have no row.
                      </div>
                    : <div className="xob-turns">
                        {turns.map((t) => (
                          <TurnRow key={t.id} turn={t} open={openId === t.id}
                                   onToggle={() => setOpenId(openId === t.id ? null : t.id)} />
                        ))}
                      </div>}
                </>
              )}

              {tab === 'calls' && <GatewayCalls requests={gwData?.requests || []} />}
            </>
          )}
        </div>

        <div className="disp-foot">
          <span className="disp-hint" style={{ flex: 1 }}>
            Per-turn ledger — read-only. Play-by-play events are the zee's feed, attributed by turn.
          </span>
          <button className="disp-cancel" onClick={load} disabled={busy}>↻ refresh</button>
          <button className="disp-cancel" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// DELIVERY TELEMETRY — one screen that answers "is this fleet getting faster or slower, and where
// is the waste?" for the selected project, over a window.
//
// WHY IT EXISTS: every number here was already in the meta-DB and answerable only by writing SQL
// against production. Seven questions, seven ad-hoc queries, no two people running the same ones.
// The server owns the arithmetic (server/src/lib/delivery-telemetry.js — percentiles, the
// transient/terminal split, the per-model grouping); this file only renders it. Nothing is computed
// here that could disagree with the API, which is the same rule web/src/work/ follows.
//
// WHY AN OVERLAY: the console has no router, so every heavyweight surface (the work tracker, the
// terminal, the diff viewer) is a portalled overlay onto <body>, and this is one more of those. The
// portal is not decoration: `.hive-split` is position:fixed and the panes create stacking contexts,
// so an overlay rendered inside the tree ranks at z-index 1 whatever number it carries.
//
// THE SAMPLE SIZE IS PART OF EVERY NUMBER, never a tooltip. A $10.80 mean over two xells and one
// over two hundred must not render the same, so `n=…` sits beside the figure it qualifies and an
// empty sample says "no data" rather than drawing a confident zero.
//
// IT READS, AND ONLY READS. There is no action on this screen — no approve, no dispatch, no
// dismiss. It is a measurement of what the gates already recorded.

const WINDOWS = [7, 14, 30, 90];

const fmtUsd = (v) => (v === null || v === undefined ? '—' : `$${Number(v).toFixed(2)}`);
const fmtPct = (v) => (v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(1)}%`);

// Minutes are what the API answers in; hours and days are what a human reads. Null stays null —
// "no data" is a different statement from "zero minutes", and this screen must never blur them.
function fmtMin(v) {
  if (v === null || v === undefined) return '—';
  const m = Number(v);
  if (m < 120) return `${Math.round(m)} min`;   // two hours is where minutes stop being readable
  if (m < 60 * 48) return `${(m / 60).toFixed(1)} h`;
  return `${(m / 1440).toFixed(1)} d`;
}

// n=… — the sample size, beside the number it qualifies, in every single place.
const N = ({ n, unit = '' }) => (
  <span className="dt-n" title={`sample size: ${n} ${unit || 'row(s)'}`}>n={n}</span>
);

function Card({ title, why, children }) {
  return (
    <section className="dt-card">
      <header className="dt-card-h">
        <span className="dt-card-t">{title}</span>
        {why && <span className="dt-card-why" title={why}>?</span>}
      </header>
      {children}
    </section>
  );
}

// A percentile summary ({n, p50, p90, avg, min, max}) — or an honest "no data" when n is 0.
function Percentiles({ s, fmt = fmtMin, label = 'p50 / p90' }) {
  if (!s || !s.n) return <div className="dt-empty">no data in this window <N n={0} /></div>;
  return (
    <div className="dt-row">
      <span className="dt-k">{label}</span>
      <b className="dt-v">{fmt(s.p50)}</b>
      <span className="dt-sep">/</span>
      <b className="dt-v">{fmt(s.p90)}</b>
      <N n={s.n} />
      <span className="dt-sub">avg {fmt(s.avg)} · min {fmt(s.min)} · max {fmt(s.max)}</span>
    </div>
  );
}

export default function DeliveryTelemetry({ projectId, projectName, onClose }) {
  const [days, setDays] = useState(14);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/delivery-telemetry?project=${encodeURIComponent(projectId)}&days=${days}`);
      const body = await r.json().catch(() => ({}));
      // The API's own sentence is the message — never replaced with a bare status.
      if (!r.ok) throw new Error(body.error || `delivery telemetry unavailable (${r.status})`);
      setData(body); setErr(null);
    } catch (e) { setErr(e); }
    finally { setBusy(false); }
  }, [projectId, days]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.dlg-overlay')) onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const d = data;
  const overlay = (
    <div className="dt-overlay" data-testid="delivery-telemetry">
      <div className="dt-shell">
        <header className="dt-head">
          <span className="dt-h-title">◷ Delivery — <b>{projectName || 'project'}</b></span>
          <nav className="dt-windows">
            {WINDOWS.map((w) => (
              <button key={w} className={`dt-win${days === w ? ' on' : ''}`} data-testid={`dt-win-${w}`}
                      onClick={() => setDays(w)} title={`the last ${w} days`}>{w}d</button>
            ))}
          </nav>
          <span className="dt-scope">
            {busy ? 'reading…' : d ? `${d.window_days}-day window · read at ${new Date(d.generated_at).toLocaleTimeString()}` : ''}
          </span>
          <button className="dt-x" data-testid="dt-close" onClick={onClose} title="close (Esc)">✕</button>
        </header>

        {err && (
          <div className="dt-err" data-testid="dt-err">
            {err.message}
            <button className="dt-err-x" onClick={() => { setErr(null); load(); }}>retry</button>
          </div>
        )}

        <div className="dt-main">
          {!d && !err && <div className="dt-empty">reading the meta-DB…</div>}
          {d && <DeliveryTelemetryScreen data={d} />}
        </div>
      </div>
    </div>
  );
  return createPortal(overlay, document.body);
}

// The seven cards, as a function of the payload and NOTHING else — no fetch, no state, no portal.
// Split out for two reasons: it is the whole screen a human reads, so it is worth rendering in a
// test (test/delivery-telemetry.test.mjs renders it to static markup and asserts the numbers and
// their sample sizes are on the page), and a portalled component cannot be server-rendered at all.
export function DeliveryTelemetryScreen({ data: d }) {
  return (
            <div className="dt-grid">

              {/* 1 ── CYCLE TIME */}
              <Card title="1 · Cycle time"
                    why={'A xell being cut → the FIRST time it asked to land. Windowed on the landing, '
                      + 'not on the xell: "of the work delivered in this window, how long did it take". '
                      + 'Xells still in flight are not counted, and would flatter the fleet if they were.'}>
                <Percentiles s={d.cycle_time} />
                {!!d.cycle_time.slowest?.length && (
                  <ul className="dt-list">
                    {d.cycle_time.slowest.map((x) => (
                      <li key={x.xell}><span className="mono">{x.xell}</span><b>{fmtMin(x.minutes)}</b></li>
                    ))}
                  </ul>
                )}
              </Card>

              {/* 2 ── TURN DEATHS */}
              <Card title="2 · Turn deaths"
                    why={'Zees whose last stop reason is a provider/infrastructure error. TRANSIENT '
                      + '(429, 529/overloaded, closed connection, timeout) could have worked on a retry; '
                      + 'TERMINAL (401/auth, invalid key, disabled org, unknown model) never could — '
                      + 'every one of those runs was waste from the moment it was dispatched.'}>
                <div className="dt-row">
                  <span className="dt-k">deaths</span>
                  <b className="dt-v">{d.turn_deaths.deaths_n}</b>
                  <N n={d.turn_deaths.zees_n} unit="zees in the window" />
                  <span className="dt-sub">of every zee in the window</span>
                </div>
                {['transient', 'terminal'].map((k) => (
                  <div className={`dt-row dt-${k}`} key={k}>
                    <span className="dt-k">{k}</span>
                    <b className="dt-v">{d.turn_deaths[k].n}</b>
                    <span className="dt-sep">·</span>
                    <b className="dt-v">{fmtPct(d.turn_deaths[k].share)}</b>
                    <span className="dt-sep">·</span>
                    <b className="dt-v">{fmtUsd(d.turn_deaths[k].cost)}</b>
                    <span className="dt-sub">
                      {d.turn_deaths[k].landed} of them landed something
                    </span>
                  </div>
                ))}
                <ul className="dt-list">
                  {[...d.turn_deaths.terminal.reasons, ...d.turn_deaths.transient.reasons]
                    .sort((a, b) => b.n - a.n).slice(0, 6).map((r) => (
                      <li key={r.reason}><span className="mono dt-reason" title={r.reason}>{r.reason}</span>
                        <b>×{r.n}</b><span className="dt-sub">{fmtUsd(r.cost)}</span></li>
                    ))}
                </ul>
              </Card>

              {/* 3 ── COST PER LANDED XELL */}
              <Card title="3 · Cost per landed xell"
                    why={'Total zee spend on every xell that landed at least once in the window, over '
                      + 'the number of those xells. A xell can host several zees (a swap, a resume), so '
                      + 'its cost is the sum of all of them and it is filed under the model that spent '
                      + 'the most on it — attributing per zee would count one landing several times.'}>
                <div className="dt-row">
                  <span className="dt-k">overall</span>
                  <b className="dt-v">{fmtUsd(d.cost_per_landed.mean)}</b>
                  <N n={d.cost_per_landed.n} unit="landed xells" />
                  <span className="dt-sub">{fmtUsd(d.cost_per_landed.cost)} total</span>
                </div>
                {[['by model', d.cost_per_landed.by_model], ['by harness', d.cost_per_landed.by_harness]].map(([label, rows]) => (
                  <div key={label}>
                    <div className="dt-sublabel">{label}</div>
                    {!rows.length && <div className="dt-empty">nothing landed in this window <N n={0} /></div>}
                    <ul className="dt-list">
                      {rows.map((g) => (
                        <li key={g.key}>
                          <span className="mono">{g.key}</span>
                          <b>{fmtUsd(g.mean)}</b>
                          <N n={g.n} unit="landed xells" />
                          <span className="dt-sub">{fmtUsd(g.cost)} total</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </Card>

              {/* 3b ── USAGE PER PROVIDER (gateway ledger) */}
              <Card title="3b · Usage per provider"
                    why={'Tokens and $ the LLM gateway recorded for each provider in the window. '
                      + 'The gateway is the only door that attributes a call to a provider key '
                      + '(claude / openai / kimi / deepseek / grok). Empty means no call crossed '
                      + 'the gateway in this window — not "free". Sample size is the request count.'}>
                {!(d.usage_by_provider || []).length && (
                  <div className="dt-empty">no gateway calls in this window <N n={0} /></div>
                )}
                <ul className="dt-list" data-testid="usage-by-provider">
                  {(d.usage_by_provider || []).map((r) => (
                    <li key={r.provider}>
                      <span className="mono">{r.provider}</span>
                      <b>{fmtUsd(r.cost)}</b>
                      <N n={r.requests} unit="calls" />
                      <span className="dt-sub">{Number(r.tokens).toLocaleString()} tok</span>
                    </li>
                  ))}
                </ul>
              </Card>

              {/* 4 ── ERROR RATE BY MODEL */}
              <Card title="4 · Error rate by model"
                    why={'Zees that ended in `errored`, over every zee of that model in the window. '
                      + 'The count is shown as "7 of 14" and not as a bare percentage on purpose.'}>
                {!d.error_rate.by_model.length && <div className="dt-empty">no zees in this window <N n={0} /></div>}
                <ul className="dt-list">
                  {d.error_rate.by_model.map((r) => (
                    <li key={r.model}>
                      <span className="mono">{r.model}</span>
                      <b className={r.rate >= 0.25 ? 'dt-bad' : ''}>{r.errored} of {r.n}</b>
                      <span className="dt-sub">{fmtPct(r.rate)} · {fmtUsd(r.cost)}</span>
                    </li>
                  ))}
                </ul>
              </Card>

              {/* 5 ── REWORK */}
              <Card title="5 · Rework"
                    why={'How many times ONE xell had to land. One landing is the healthy case; '
                      + 'everything above it is a re-land. Stale landings are counted apart — those '
                      + 'are pushes a human decision could never have saved (main moved past the sha).'}>
                <div className="dt-row">
                  <span className="dt-k">landings / xell</span>
                  <b className="dt-v">{d.rework.mean ?? '—'}</b>
                  <N n={d.rework.xells_n} unit="xells that landed" />
                  <span className="dt-sub">{d.rework.relanded_n} needed more than one</span>
                </div>
                <ul className="dt-list dt-buckets">
                  {d.rework.buckets.map((b) => (
                    <li key={b.label}><span className="mono">{b.label} landing(s)</span><b>{b.n}</b>
                      <span className="dt-sub">xells</span></li>
                  ))}
                </ul>
                <div className="dt-row">
                  <span className="dt-k">stale</span>
                  <b className="dt-v">{d.rework.stale.n}</b>
                  <span className="dt-sub">over {d.rework.stale.xells} xell(s)</span>
                </div>
                {!!d.rework.worst?.length && (
                  <ul className="dt-list">
                    {d.rework.worst.map((x) => (
                      <li key={x.xell}><span className="mono">{x.xell}</span><b>×{x.landed}</b></li>
                    ))}
                  </ul>
                )}
              </Card>

              {/* 6 ── HUMAN-GATE WAITS */}
              <Card title="6 · Human-gate waits"
                    why={'Asked → decided, for the three gates that hold a zee. Only decisions a HUMAN '
                      + 'made are counted: a landing swept stale carries queenzee@stale and an '
                      + 'auto-approved one auto-approve@policy, and counting those would say "three days" '
                      + 'when nobody was ever asked. They are reported as `auto` instead.'}>
                {[['land', d.gate_waits.land], ['ship', d.gate_waits.ship], ['seed', d.gate_waits.seed]].map(([k, s]) => (
                  <div className="dt-row" key={k}>
                    <span className="dt-k">{k}</span>
                    {s.n ? <>
                      <b className="dt-v">{fmtMin(s.p50)}</b><span className="dt-sep">/</span>
                      <b className="dt-v">{fmtMin(s.p90)}</b>
                      <N n={s.n} unit="human decisions" />
                      <span className="dt-sub">max {fmtMin(s.max)}{s.auto_n ? ` · ${s.auto_n} decided by the queenzee` : ''}</span>
                    </> : <span className="dt-empty">no human decisions in this window <N n={0} />
                      {s.auto_n ? <span className="dt-sub">{s.auto_n} decided by the queenzee</span> : null}</span>}
                  </div>
                ))}
                <div className="dt-row">
                  <span className="dt-k">open tends</span>
                  {d.gate_waits.tends_open.n ? <>
                    <b className="dt-v">{fmtMin(d.gate_waits.tends_open.p50)}</b><span className="dt-sep">/</span>
                    <b className="dt-v">{fmtMin(d.gate_waits.tends_open.p90)}</b>
                    <N n={d.gate_waits.tends_open.n} unit="zees still waiting" />
                    <span className="dt-sub">still waiting — this is age, not a decision time</span>
                  </> : <span className="dt-empty">nobody is waiting on a human <N n={0} /></span>}
                </div>
              </Card>

              {/* 7 ── NEVER LANDED */}
              <Card title="7 · Never raised a landing"
                    why={'Xells cut in the window that never asked to land. NEVER CLAIMED means no zee '
                      + 'ever ran in it (it sat in the pool); CLAIMED THEN ABANDONED means a zee ran and '
                      + 'produced no landing — that is the expensive half. Manager xells are excluded '
                      + 'and counted separately: a manager cannot land at all, by design.'}>
                <div className="dt-row">
                  <span className="dt-k">never landed</span>
                  <b className="dt-v">{d.never_landed.n}</b>
                  <N n={d.never_landed.workers_cut} unit="worker xells cut" />
                  <span className="dt-sub">{fmtUsd(d.never_landed.cost)} burned
                    {d.never_landed.managers_excluded ? ` · ${d.never_landed.managers_excluded} manager(s) excluded` : ''}</span>
                </div>
                <div className="dt-row">
                  <span className="dt-k">never claimed</span>
                  <b className="dt-v">{d.never_landed.never_claimed.n}</b>
                  <span className="dt-sub">{fmtUsd(d.never_landed.never_claimed.cost)} — pooled, no zee ever ran</span>
                </div>
                <div className="dt-row dt-terminal">
                  <span className="dt-k">abandoned</span>
                  <b className="dt-v">{d.never_landed.abandoned.n}</b>
                  <span className="dt-sub">{fmtUsd(d.never_landed.abandoned.cost)} — a zee ran and landed nothing</span>
                </div>
                <ul className="dt-list">
                  {d.never_landed.abandoned.rows.map((x) => (
                    <li key={x.xell}><span className="mono">{x.xell}</span>
                      <b>{fmtUsd(x.cost)}</b><span className="dt-sub">{x.status}</span></li>
                  ))}
                </ul>
              </Card>

            </div>
  );
}

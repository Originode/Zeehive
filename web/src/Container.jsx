// Reusable container chip — the single source of truth for how a container renders anywhere
// (top inventory + each xell's stack). A small square box: 3-hex nickname + health dot.
//
//  • interactive (xell stack): right-click opens the build/context menu; server/webapp
//    per-xell containers are buildable. An UNBUILT buildable container shows a hammer INSIDE
//    the box (click to build). A HOT build shows a lime dot (vs normal green) when up.
//  • non-interactive (inventory): plain display, no build affordances.
//  • BUSY (building, or a db container being restored): the health dot becomes a spinner and
//    all build affordances are withdrawn/disabled — you can't (re)build a container mid-operation
//    and mangle it.
import React, { useState, useEffect } from 'react';
import { buildContainer, getDockerContexts, setContainerBuildCtx, decommissionContainer } from './api.js';
import { nick } from './nick.js';
import { showAlert } from './Dialog.jsx';

// Production is EXCLUDED from decommission entirely (not warned) — a prod container/db is never a
// candidate for this action. Mirrors the server guard in decommissionContainer (tier='prod').
export const isProdContainer = (c) => c?.tier === 'prod';

const BUILDABLE = new Set(['server', 'webapp']); // db is shared infra — not a per-xell build
export const isBuildable = (c) => BUILDABLE.has(c.role) && !!c.owner_xell_id;
const buildErr = (e) => showAlert('Build failed: ' + (e?.error || e?.message || e), { variant: 'error' });

// Why a container is busy right now (null = idle): 'building' (its own health state), or a db
// job — 'backup' (dumping the source) / 'restore' (loading a backup into it), from busy_since/op.
export function busyReason(c) {
  if (c.health === 'building') return 'building';
  if (c.busy_since) return c.busy_op || 'busy';   // 'backup' | 'restore'
  return null;
}
export const isBusy = (c) => busyReason(c) != null;

const BUSY_LABEL = { building: 'building…', backup: 'backing up…', restore: 'restoring from backup…', busy: 'working…' };

// ── schema drift vs production (container.prod_diff, written by queenzee/proddiff.js) ──────────
// null   → never checked, or this IS prod (prod is the ruler, it is compared against nothing)
// 'sync' → total 0
// 'drift'→ total > 0
// 'err'  → could not be compared (db down / mid-restore / unreadable)
export function driftState(c) {
  const d = c.prod_diff;
  if (!d) return null;
  if (!d.ok) return 'err';
  return d.total > 0 ? 'drift' : 'sync';
}

// The drift half of the tooltip. Counts are exact; the lists are a SAMPLE (proddiff truncates), so
// say so rather than let a reader think 8 is the whole story.
function driftText(c) {
  const d = c.prod_diff;
  if (!d) return '';
  const when = c.prod_diff_at ? ` (${new Date(c.prod_diff_at).toLocaleString()})` : '';
  if (!d.ok) return `\n\n⚠ prod diff failed${when}\n${d.error || 'unknown error'}`;
  if (!d.total) return `\n\n✓ schema matches prod${when}`;

  const out = [`\n\n⚠ DRIFTED from prod — ${d.total} difference(s)${when}`];
  for (const [kind, v] of Object.entries(d.kinds || {})) {
    const miss = v.missing_count || 0, extra = v.extra_count || 0;
    if (!miss && !extra) continue;
    out.push(`\n${kind}: ${miss} missing, ${extra} extra`);
    // "missing" first and always: prod has it and this db does not, which is what breaks code.
    for (const x of (v.missing || [])) out.push(`\n  − ${x}`);
    if (miss > (v.missing || []).length) out.push(`\n  … +${miss - v.missing.length} more missing`);
    for (const x of (v.extra || [])) out.push(`\n  + ${x}`);
    if (extra > (v.extra || []).length) out.push(`\n  … +${extra - v.extra.length} more extra`);
  }
  out.push('\n\n− = prod has it, this db does not (code may expect it)');
  out.push('\n+ = this db has it, prod does not');
  return out.join('');
}

// What lives INSIDE a db container (db_instance rows, aggregated onto the row by fleet.js):
// the primary db, the clone template, and each schema-work xell's clone. A clone names its xell;
// a clone with no owner is an ORPHAN (its xell is gone but the database survived) — say so.
function instancesText(c) {
  const list = c.instances;
  if (!Array.isArray(list) || list.length < 2) return '';   // just the primary = nothing to tell
  const out = [`\n\ndatabases (${list.length}):`];
  for (const i of list) {
    const d = i.prod_diff;
    const drift = !d ? '' : d.ok === false ? ' · diff err' : d.total > 0 ? ` · ⚠ ${d.total} drift` : ' · ✓ sync';
    const who = i.kind === 'clone' ? (i.owner_slug ? ` → ${i.owner_slug}` : ' → ORPHAN (xell gone)') : '';
    out.push(`\n  ${i.name} — ${i.kind}${who}${drift}`);
  }
  return out.join('');
}

// Where a buildable container COMPILES vs RUNS. Only interesting when they differ (a split build):
// the image is compiled on build_ctx and handed to docker_ctx via the registry.
export function buildHost(c) {
  if (!isBuildable(c)) return null;
  const run = c.docker_ctx || null;
  const build = c.build_ctx || run;
  return { run, build, split: !!c.build_ctx && c.build_ctx !== run };
}

function tooltip(c, buildable, busy) {
  if (busy) return `${c.name}\n${c.tier} · ${BUSY_LABEL[busy] || 'working…'}`;
  const built = c.last_build_commit
    ? `\nlast build: ${c.last_build_commit}${c.hot_build ? ' (hot)' : ''}${c.last_built_at ? ' · ' + new Date(c.last_built_at).toLocaleString() : ''}`
    : (buildable ? '\nnever built — click the hammer to build' : '');
  const bh = buildHost(c);
  const host = bh
    ? (bh.split ? `\ncompiles on ${bh.build} → runs on ${bh.run}` : (bh.run ? `\nbuilds & runs on ${bh.run}` : ''))
    : '';
  return `${c.name}\n${c.tier} · ${c.health}${c.url ? '\n' + c.url : ''}${built}${host}${driftText(c)}${instancesText(c)}`;
}

// onMenu  → the chip is right-clickable (context menu). Passed by BOTH the inventory and the
//           xell stack, so every container box has a menu.
// hammer  → show the build hammer INSIDE the box for an unbuilt buildable container. Only the
//           xell stack passes this (the top inventory stays icon-free, per spec).

export function ContainerChip({ c, onMenu, hammer = false }) {
  const buildable = isBuildable(c);
  const busy = busyReason(c);
  const unbuilt = hammer && buildable && !c.last_build_commit && !busy;   // no hammer while busy
  const onCtx = onMenu ? (e) => onMenu(e, c) : undefined;
  // Drift is about the DATABASE's schema, not the container process — so it must not masquerade as
  // the health dot. It gets its own corner mark, and only while idle: a chip that is mid-restore is
  // already saying something more urgent, and its drift reading is stale by definition.
  const drift = busy ? null : driftState(c);

  // While busy the health dot is replaced by a spinner (amber = building, blue = restoring).
  const indicator = busy
    ? <span className={`cspin ${busy}`} data-testid="cspin" aria-label={busy} />
    : <span className={`cdot ${c.health}${c.health === 'up' && c.hot_build ? ' hot' : ''}`} />;

  const inner = (
    <>
      <span className="cnick">{nick(c.name)}</span>
      {indicator}
      {drift && drift !== 'sync' && (
        <span className={`cdrift ${drift}`} data-testid="cdrift"
              aria-label={drift === 'drift' ? 'schema drifted from prod' : 'prod diff failed'} />
      )}
      {unbuilt && (
        <button className="cbuild-in" data-testid="build-in" title="Build this container"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); buildContainer(c.id, false).catch(buildErr); }}>🔨</button>
      )}
      {!busy && buildHost(c)?.split && (
        <span className="cbuildhost" data-testid="cbuildhost"
              aria-label={`compiles on ${buildHost(c).build}`}>⇄</span>
      )}
    </>
  );
  const common = {
    // t-prod: PRODUCTION containers wear a gold border wherever a chip renders (matrix, hexes) —
    // the same at-a-glance warning the PRODUCTION hex carries.
    className: `cbox h-${c.health}${busy ? ` busy busy-${busy}` : ''}${drift ? ` d-${drift}` : ''}${c.tier === 'prod' ? ' t-prod' : ''}`,
    // Drives the faint role glyph behind the chip (see .cbox[data-role] in styles.css). Kept as a
    // data attribute rather than a class so it cannot collide with the health/busy/drift classes,
    // which own the chip's border and are the ones that actually mean something.
    'data-role': c.role,
    title: tooltip(c, buildable, busy), onContextMenu: onCtx,
  };

  // a URL chip navigates on click — but not while unbuilt (the hammer owns the click there)
  return c.url && !unbuilt
    ? <a {...common} href={c.url} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>{inner}</a>
    : <span {...common} onClick={(e) => e.stopPropagation()}>{inner}</span>;
}

// Right-click context menu for a container. Build actions only when the container is buildable
// AND idle; a busy container shows a "please wait" note instead so it can't be mangled mid-op.
// Decommission (stop + remove) is offered on every non-production container behind a second-stage
// confirmation — production is never a candidate (it isn't even shown), matching the server guard.
export function ContainerMenu({ menu, onClose, projectName, onDecommissioned, onLoadBackup }) {
  // Hooks must run unconditionally (before any early return). The build-host picker lists the
  // docker contexts this machine can compile on; loaded lazily the first time a buildable+idle
  // container's menu opens, then cached for the life of the menu component.
  const [ctxs, setCtxs] = useState(null);
  // Decommission is a two-stage flow: the menu item flips to an in-menu confirmation panel (a
  // clearly destructive button, not a default-focused OK), and a db additionally requires typing
  // its name. Reset whenever the menu targets a different container so state can't bleed across.
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [busyAct, setBusyAct] = useState(false);
  const [err, setErr] = useState(null);
  const c = menu?.c;
  const cid = c?.id;
  useEffect(() => { setConfirming(false); setTyped(''); setBusyAct(false); setErr(null); }, [cid]);

  const buildable = c ? isBuildable(c) : false;
  const busy = c ? busyReason(c) : null;
  const showPicker = !!c && buildable && !busy && !confirming;
  useEffect(() => {
    if (!showPicker || ctxs) return;
    let live = true;
    getDockerContexts().then((list) => { if (live) setCtxs(list || []); }).catch(() => { if (live) setCtxs([]); });
    return () => { live = false; };
  }, [showPicker, ctxs]);

  if (!menu) return null;
  const { x, y } = menu;
  const act = (hot) => { buildContainer(c.id, hot).catch(buildErr); onClose(); };
  const bh = buildHost(c);
  const runCtx = bh?.run || null;
  const current = bh?.build || runCtx;
  // Build ON a chosen context (set-then-build in one click). Empty → reset to the run host. This is
  // the "optimize build time" action: point the compile at a beefier daemon and rebuild now.
  const buildOn = (ctxName) => {
    const bc = (!ctxName || ctxName === runCtx) ? '' : ctxName;
    buildContainer(c.id, false, bc).catch(buildErr);
    onClose();
  };
  // Contexts to offer: whatever docker reports, always including the run host itself (reset target).
  const picker = [];
  if (runCtx) picker.push({ name: runCtx, run: true });
  for (const k of (ctxs || [])) if (k.name && k.name !== runCtx) picker.push({ name: k.name, endpoint: k.endpoint });

  // Decommission wiring. Production is never a candidate. A db needs its name typed (it deletes
  // data); anything else just needs the destructive button pressed.
  const prod = isProdContainer(c);
  const isDb = c.role === 'db';
  const canConfirm = !isDb || typed.trim() === c.name;
  const runDecommission = async () => {
    if (!canConfirm || busyAct) return;
    setBusyAct(true); setErr(null);
    try {
      await decommissionContainer(c.id, false);
      onDecommissioned?.();
      onClose();
    } catch (e) { setErr(e?.error || e?.message || String(e)); setBusyAct(false); }
  };

  // No blocking scrim — App closes the menu via document-level listeners. Stop propagation so a
  // click INSIDE the menu doesn't also bubble to that closer before the item handler runs.
  return (
    <div className={`ctxmenu${confirming ? ' confirming' : ''}`} style={{ left: x, top: y }} role="menu"
         onClick={(e) => e.stopPropagation()}>
      <div className="ctxhead">{c.name}</div>

      {/* ── decommission confirmation panel (second stage) ─────────────────────── */}
      {confirming ? (
        <div className="ctxconfirm" data-testid="decommission-confirm">
          <div className="ctxwarn-id">
            <b>{c.name}</b>
            <span className="ctxsub">
              {(ROLE_WORD[c.role] || c.role)} · {c.tier}
              {c.owner_slug ? <> · xell <b>{c.owner_slug}</b></> : null}
              {projectName ? <> · {projectName}</> : null}
            </span>
          </div>
          <div className="ctxwarn-body">
            This <b>stops and removes</b> the container.
            {isDb
              ? <div className="ctxwarn-danger">⚠ This is a <b>DATABASE</b>. Its data is
                  <b> permanently deleted</b> — this cannot be undone.</div>
              : <div className="ctxwarn-note">Its built image is reclaimed. This cannot be undone
                  (rebuild to bring it back).</div>}
          </div>
          {isDb && (
            <label className="ctxwarn-type">
              To confirm, type the container name:
              <input autoFocus data-testid="decommission-type" value={typed}
                     placeholder={c.name} spellCheck={false} autoComplete="off"
                     onChange={(e) => setTyped(e.target.value)}
                     onKeyDown={(e) => { if (e.key === 'Enter') runDecommission(); }} />
            </label>
          )}
          {err && <div className="ctxwarn-err" data-testid="decommission-err">{err}</div>}
          <div className="ctxconfirm-actions">
            <button className="ctxcancel" onClick={() => setConfirming(false)} disabled={busyAct}>Cancel</button>
            <button className="ctxdanger" data-testid="decommission-go" disabled={!canConfirm || busyAct}
                    onClick={runDecommission}>
              {busyAct ? 'Decommissioning…' : 'Decommission'}
            </button>
          </div>
        </div>
      ) : (
        <>
      {busy && <div className="ctxbusy" data-testid="ctx-busy"><span className={`cspin ${busy}`} />{busy === 'restoring' ? 'restoring from backup…' : 'building…'}</div>}
      {!busy && buildable && <button role="menuitem" onClick={() => act(false)}>🔨 Build <span className="ctxsub">full rebuild{bh?.split ? ` on ${current}` : ''}</span></button>}
      {!busy && buildable && <button role="menuitem" onClick={() => act(true)}>⚡ Hot build <span className="ctxsub">fast reload</span></button>}
      {showPicker && (
        <>
          <div className="ctxsubhead" data-testid="buildhost-head">compile on {ctxs ? '' : '…'}</div>
          {ctxs && picker.map((p) => (
            <button key={p.name} role="menuitem" data-testid={`buildhost-${p.name}`}
                    className={p.name === current ? 'ctxsel' : ''} onClick={() => buildOn(p.name)}
                    title={p.run ? 'the fleet host — builds & runs here' : (p.endpoint || 'compile here, run on the fleet host')}>
              {p.name === current ? '✓ ' : '  '}{p.name}
              <span className="ctxsub">{p.run ? 'run host' : 'build & ship image'}</span>
            </button>
          ))}
        </>
      )}
      {c.url && <a role="menuitem" href={c.url} target="_blank" rel="noopener" onClick={onClose}>↗ Open URL</a>}

      {/* Load backup: db containers only, never production (you never restore OVER prod, and the
          server's target list excludes it). Opens the backup selector pre-aimed at THIS container,
          so the backup you pick restores straight into it. Withdrawn while busy — a db mid-restore
          can't take another. */}
      {isDb && !prod && (busy ? (
        <div className="ctxsub ctxbusy-note" data-testid="load-backup-busy">load backup unavailable while busy</div>
      ) : (
        <button role="menuitem" data-testid="load-backup-open"
                onClick={() => { onLoadBackup?.(c); onClose(); }}>
          📥 Load backup… <span className="ctxsub">restore a backup into this db (overwrites data)</span>
        </button>
      ))}

      {/* Decommission: every non-production container. Production is excluded outright — it shows a
          protected note instead, never an action. A busy container can't be removed mid-op. */}
      {prod ? (
        <div className="ctxprotected" data-testid="decommission-protected">🛡 production — protected</div>
      ) : busy ? (
        <div className="ctxsub ctxbusy-note">decommission unavailable while busy</div>
      ) : (
        <button role="menuitem" className="ctxitem-danger" data-testid="decommission-open"
                onClick={() => { setConfirming(true); setErr(null); }}>
          🗑 Decommission… <span className="ctxsub">{isDb ? 'stop + remove (deletes data)' : 'stop + remove'}</span>
        </button>
      )}
        </>
      )}
    </div>
  );
}

const ROLE_WORD = { db: 'database', server: 'server', webapp: 'app' };

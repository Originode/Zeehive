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
import React from 'react';
import { buildContainer } from './api.js';
import { nick } from './nick.js';

const BUILDABLE = new Set(['server', 'webapp']); // db is shared infra — not a per-xell build
export const isBuildable = (c) => BUILDABLE.has(c.role) && !!c.owner_xell_id;
const buildErr = (e) => alert('Build failed: ' + (e?.error || e?.message || e));

// Why a container is busy right now (null = idle): 'building' (its own health state), or a db
// job — 'backup' (dumping the source) / 'restore' (loading a backup into it), from busy_since/op.
export function busyReason(c) {
  if (c.health === 'building') return 'building';
  if (c.busy_since) return c.busy_op || 'busy';   // 'backup' | 'restore'
  return null;
}
export const isBusy = (c) => busyReason(c) != null;

const BUSY_LABEL = { building: 'building…', backup: 'backing up…', restore: 'restoring from backup…', busy: 'working…' };

function tooltip(c, buildable, busy) {
  if (busy) return `${c.name}\n${c.tier} · ${BUSY_LABEL[busy] || 'working…'}`;
  const built = c.last_build_commit
    ? `\nlast build: ${c.last_build_commit}${c.hot_build ? ' (hot)' : ''}${c.last_built_at ? ' · ' + new Date(c.last_built_at).toLocaleString() : ''}`
    : (buildable ? '\nnever built — click the hammer to build' : '');
  return `${c.name}\n${c.tier} · ${c.health}${c.url ? '\n' + c.url : ''}${built}`;
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

  // While busy the health dot is replaced by a spinner (amber = building, blue = restoring).
  const indicator = busy
    ? <span className={`cspin ${busy}`} data-testid="cspin" aria-label={busy} />
    : <span className={`cdot ${c.health}${c.health === 'up' && c.hot_build ? ' hot' : ''}`} />;

  const inner = (
    <>
      <span className="cnick">{nick(c.name)}</span>
      {indicator}
      {unbuilt && (
        <button className="cbuild-in" data-testid="build-in" title="Build this container"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); buildContainer(c.id, false).catch(buildErr); }}>🔨</button>
      )}
    </>
  );
  const common = {
    className: `cbox h-${c.health}${busy ? ` busy busy-${busy}` : ''}`,
    title: tooltip(c, buildable, busy), onContextMenu: onCtx,
  };

  // a URL chip navigates on click — but not while unbuilt (the hammer owns the click there)
  return c.url && !unbuilt
    ? <a {...common} href={c.url} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>{inner}</a>
    : <span {...common} onClick={(e) => e.stopPropagation()}>{inner}</span>;
}

// Right-click context menu for a container. Build actions only when the container is buildable
// AND idle; a busy container shows a "please wait" note instead so it can't be mangled mid-op.
export function ContainerMenu({ menu, onClose }) {
  if (!menu) return null;
  const { x, y, c } = menu;
  const buildable = isBuildable(c);
  const busy = busyReason(c);
  const act = (hot) => { buildContainer(c.id, hot).catch(buildErr); onClose(); };
  // No blocking scrim — App closes the menu via document-level listeners. Stop propagation so a
  // click INSIDE the menu doesn't also bubble to that closer before the item handler runs.
  return (
    <div className="ctxmenu" style={{ left: x, top: y }} role="menu" onClick={(e) => e.stopPropagation()}>
      <div className="ctxhead">{c.name}</div>
      {busy && <div className="ctxbusy" data-testid="ctx-busy"><span className={`cspin ${busy}`} />{busy === 'restoring' ? 'restoring from backup…' : 'building…'}</div>}
      {!busy && buildable && <button role="menuitem" onClick={() => act(false)}>🔨 Build <span className="ctxsub">full rebuild</span></button>}
      {!busy && buildable && <button role="menuitem" onClick={() => act(true)}>⚡ Hot build <span className="ctxsub">fast reload</span></button>}
      {c.url && <a role="menuitem" href={c.url} target="_blank" rel="noopener" onClick={onClose}>↗ Open URL</a>}
      {!busy && !buildable && !c.url && <div className="ctxempty">no actions</div>}
    </div>
  );
}

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

function tooltip(c, buildable, busy) {
  if (busy) return `${c.name}\n${c.tier} · ${BUSY_LABEL[busy] || 'working…'}`;
  const built = c.last_build_commit
    ? `\nlast build: ${c.last_build_commit}${c.hot_build ? ' (hot)' : ''}${c.last_built_at ? ' · ' + new Date(c.last_built_at).toLocaleString() : ''}`
    : (buildable ? '\nnever built — click the hammer to build' : '');
  return `${c.name}\n${c.tier} · ${c.health}${c.url ? '\n' + c.url : ''}${built}${driftText(c)}`;
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
    </>
  );
  const common = {
    className: `cbox h-${c.health}${busy ? ` busy busy-${busy}` : ''}${drift ? ` d-${drift}` : ''}`,
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

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
import { previewHref, buildContainer, getDockerContexts, setContainerBuildCtx, decommissionContainer, checkContainerDiff, getDiffCandidates, checkContainerData, getDataCheckReadiness, duplicateProd } from './api.js';
import { nick } from './nick.js';
import { diffReportText, driftDirection, SCOPE_LINE, dataReportText, dataText } from './drift.js';
import { showAlert, showConfirm } from './Dialog.jsx';

// Production is EXCLUDED from decommission entirely (not warned) — a prod container/db is never a
// candidate for this action. Mirrors the server guard in decommissionContainer (tier='prod').
export const isProdContainer = (c) => c?.tier === 'prod';

const BUILDABLE = new Set(['server', 'webapp']); // db is shared infra — not a per-xell build
export const isBuildable = (c) => BUILDABLE.has(c.role) && !!c.owner_xell_id;
const buildErr = (e) => showAlert('Build failed: ' + (e?.error || e?.message || e), { variant: 'error' });

// Best-effort OS-clipboard write: the async API where allowed (secure ctx / localhost), else a
// throwaway textarea + execCommand for an insecure http origin (the ZeeTerminal pattern — the
// console is usually served over plain LAN http, where navigator.clipboard is undefined). Never
// throws; resolves true when the copy landed, false when nothing could be written.
async function toClipboard(t) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(t); return true; }
  } catch { /* fall through to the textarea path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand('copy'); document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

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

// TKT-22-4F0E: this chip answers ONE question and a human read it as answering two. It compares
// catalog SHAPE against production; it never counts a row and never opens a backup. So every reading
// of it — sync, drifted, or empty — carries its scope, at the place the number is read. Both the scope
// caveat and the WHICH-WAY reading come from drift.js: the glance and the investigation must not drift
// apart, and a tooltip is exactly where a worried operator looks first.
const SCOPE = `\n\n${SCOPE_LINE}`;

// The drift half of the tooltip. Counts are exact; the lists are a SAMPLE (proddiff truncates), so
// say so rather than let a reader think 8 is the whole story.
export function driftText(c) {
  const d = c.prod_diff;
  if (!d) return '';
  const when = c.prod_diff_at ? ` (${new Date(c.prod_diff_at).toLocaleString()})` : '';
  if (!d.ok) return `\n\n⚠ prod diff failed${when}\n${d.error || 'unknown error'}`;
  if (!d.total) return `\n\n✓ schema matches prod${when}${SCOPE}`;

  // EMPTY is a different fact from DRIFTED, and the server now distinguishes them: a database with
  // none of prod's tables was never restored. Reporting that as "N differences" is what made a
  // never-used dev clone look like a data-loss event.
  if (d.empty_db) {
    const t = d.kinds?.table || {};
    return `\n\n⚠ this database is EMPTY — it has NO application tables${when}`
      + `\nprod has ${t.ref_count ?? '?'}; this db has ${t.mine_count ?? 0}.`
      + '\nIt was never restored, or its restore failed. This is not drift, and it says nothing'
      + '\nabout production or its backups.'
      + SCOPE;
  }

  const out = [`\n\n⚠ SCHEMA drifted from prod — ${d.total} difference(s)${when}`];
  for (const [kind, v] of Object.entries(d.kinds || {})) {
    const miss = v.missing_count || 0, extra = v.extra_count || 0;
    if (!miss && !extra) continue;
    const have = v.ref_count != null ? ` (prod ${v.ref_count} / here ${v.mine_count})` : '';
    out.push(`\n${kind}: ${miss} missing, ${extra} extra${have}`);
    // "missing" first and always: prod has it and this db does not, which is what breaks code.
    for (const x of (v.missing || [])) out.push(`\n  − ${x}`);
    if (miss > (v.missing || []).length) out.push(`\n  … +${miss - v.missing.length} more missing`);
    for (const x of (v.extra || [])) out.push(`\n  + ${x}`);
    if (extra > (v.extra || []).length) out.push(`\n  … +${extra - v.extra.length} more extra`);
  }
  out.push('\n\n− = prod has it, this db does not (code may expect it)');
  out.push('\n+ = this db has it, prod does not');
  // WHICH WAY it runs, from drift.js — for a restored db "everything missing, nothing extra" is the
  // signature of a copy that is simply OLDER than prod, and that reading is the whole of TKT-22-4F0E's
  // first question. One implementation, so the chip and the report cannot disagree.
  const dir = driftDirection(d);
  if (dir) out.push(`\n\n${dir.text}`);
  out.push(SCOPE);
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
    const drift = !d ? '' : d.ok === false ? ' · diff err'
      : d.empty_db ? ' · ⚠ EMPTY (no app tables)'
      : d.total > 0 ? ` · ⚠ ${d.total} schema drift` : ' · ✓ schema in sync';
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

// ── database identity on a db chip ─────────────────────────────────────────────────────────────
// A db chip says WHICH database it is: the URL it answers at and the published port. The URL is
// the row's recorded conn_ref when it has one, else a DSN derived from its published host:host_port
// (the same rule lib/xell-db.js derivedTcpDsn applies everywhere else). Passwordless by design —
// conn_refs are "parameters, not secrets". Absent both → null: a database with no address is a
// fixable state, and a GUESSED address would point at a silent wrong database (db-dsn-needs-a-host).
export function dbUrl(c) {
  if (c?.role !== 'db') return null;
  if (c.conn_ref) return c.conn_ref;
  if (c.host && c.host_port) return `postgresql://${c.host}:${c.host_port}`;
  return null;
}

// The port a db answers at: its recorded host_port, else the port parsed out of its conn_ref.
export function dbPort(c) {
  if (c?.role !== 'db') return null;
  if (c.host_port) return c.host_port;
  const u = dbUrl(c);
  if (!u) return null;
  try {
    const p = new URL(String(u).replace(/^postgres(ql)?:/, 'http:'));
    return p.port || null;
  } catch { return null; }
}

// The tooltip half of the database identity: the full URL + the port, so hovering a db chip names
// the exact database it refers to. The chip itself stays the compact box — a URL is long, and the
// tooltip is where the full connection string fits (the row's url is empty for a db; its address
// lives in conn_ref / host:host_port, which is what this surfaces).
function dbTooltip(c) {
  if (c?.role !== 'db') return '';
  const url = dbUrl(c);
  const port = dbPort(c);
  if (!url && port == null) return '';
  return `\n\ndatabase: ${url || 'no URL recorded'}${port != null ? `\nport: ${port}` : ''}`;
}

function tooltip(c, buildable, busy) {
  if (busy) return `${c.name}\n${c.tier} · ${BUSY_LABEL[busy] || 'working…'}`;
  const built = c.last_build_commit
    ? `\nlast build: ${c.last_build_commit}${c.hot_build ? ' (hot)' : ''}${c.last_built_at ? ' · ' + new Date(c.last_built_at).toLocaleString() : ''}`
    : (buildable ? '\nnever built — click the hammer to build' : '');
  // Ticket #173: a failed build's reason lives on the row (last_build_error), not only in the
  // log ring. Show it on the chip when the container is down so a human sees why without opening
  // the terminal. The classified cause (INFRA | CODE | UNKNOWN, migration 233) rides beside it.
  const fail = (c.health === 'down' && c.last_build_error)
    ? `\nbuild failed${c.last_build_error_class ? ` [${c.last_build_error_class}]` : ''}: ${String(c.last_build_error).split('\n').filter(Boolean).slice(-3).join(' · ')}`
    : '';
  const bh = buildHost(c);
  const host = bh
    ? (bh.split ? `\ncompiles on ${bh.build} → runs on ${bh.run}` : (bh.run ? `\nbuilds & runs on ${bh.run}` : ''))
    : '';
  return `${c.name}\n${c.tier} · ${c.health}${c.url ? '\n' + c.url : ''}${built}${fail}${host}`
    + `${dbTooltip(c)}${driftText(c)}${dataText(c)}${instancesText(c)}`;
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

  // A PRODUCTION chip carries the same at-a-glance shield the PRODUCTION hex/menu wear (🛡). The
  // gold border alone is easy to miss (health/drift override the border-color, and drift's amber is
  // a near-twin of prod gold) — the shield in the free top-LEFT corner is unmistakable and survives
  // even when a busy state repaints the ring. Non-interactive: it's a badge, not a control.
  const prod = isProdContainer(c);

  const inner = (
    <>
      <span className="cnick">{nick(c.name)}</span>
      {indicator}
      {prod && (
        <span className="cprod" data-testid="cprod" aria-label="production" title="production">🛡</span>
      )}
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
export function ContainerMenu({ menu, onClose, projectName, onDecommissioned, onLoadBackup, onBackup, onShell }) {
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
  // "Check diff" fires an on-demand drift check; `diffing` holds WHICH reference is in flight
  // ('prod' | a container id) so a double-click can't fire two comparisons. `picking` opens the
  // reference picker; `cands` is the lazily-loaded list of db chips it offers (null = not loaded).
  // Reset (with the rest) whenever the menu retargets a container.
  const [diffing, setDiffing] = useState(null);
  const [picking, setPicking] = useState(false);
  const [cands, setCands] = useState(null);
  const [candErr, setCandErr] = useState(null);
  // "Check data" is the OTHER question — did the rows arrive? — so it gets its own in-flight guard and
  // its own readiness answer, fetched with the menu: a db with no recorded source backup cannot be
  // checked, and the item says so instead of being offered and then refusing (TKT-22-4F0E).
  const [dataing, setDataing] = useState(false);
  const [dataReady, setDataReady] = useState(null);
  // "Duplicate prod" streams a fresh prod dump into THIS dev db (backup + restore in one). Guard the
  // in-flight window so a double-click can't fire two overwrites. Reset when the menu retargets.
  const [dupPending, setDupPending] = useState(false);
  // "Copy database URL" feedback: `copied` flips the item's label to "Copied!" for a moment (the
  // same in-menu state pattern as diffing/dupPending), reset whenever the menu retargets.
  const [copied, setCopied] = useState(false);
  const c = menu?.c;
  const cid = c?.id;
  useEffect(() => {
    setConfirming(false); setTyped(''); setBusyAct(false); setErr(null);
    setDiffing(null); setPicking(false); setCands(null); setCandErr(null); setDupPending(false);
    setDataing(false); setDataReady(null); setCopied(false);
  }, [cid]);

  // The reference dbs this container can be measured against, fetched the first time the picker is
  // opened (same lazy pattern as the build-host contexts above). The SERVER orders them — production
  // first — so "what is the default" lives in one place, not in two renderers.
  useEffect(() => {
    if (!picking || !cid || cands) return;
    let live = true;
    getDiffCandidates(cid)
      .then((list) => { if (live) { setCands(list || []); setCandErr(null); } })
      .catch((e) => { if (live) { setCands([]); setCandErr(e?.error || e?.message || String(e)); } });
    return () => { live = false; };
  }, [picking, cid, cands]);

  // Can this db's ROWS be checked, and against which backup? Asked as soon as the menu opens on a
  // non-prod db, because the answer decides what the item says. Failure is not fatal: the item stays
  // available and the server gives the reason if it is clicked.
  useEffect(() => {
    if (!cid || menu?.c?.role !== 'db' || isProdContainer(menu?.c)) return;
    let live = true;
    getDataCheckReadiness(cid)
      .then((r) => { if (live) setDataReady(r || null); })
      .catch(() => { if (live) setDataReady(null); });
    return () => { live = false; };
  }, [cid, menu?.c]);

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
  // A device chip decommissions too (035). Distinguish the two shapes so the wording is honest:
  // a per-xell EMULATOR is a real container (stop + remove); a SHARED physical device is just a
  // registration row (removing it leaves the phone untouched). isolation is authoritative; relation
  // ('uses' = a linked shared device) is the fallback for chips that don't carry isolation.
  const isDevice = c.role === 'device';
  const devicePhysical = isDevice && (c.isolation === 'shared' || c.relation === 'uses');
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

  // Check this db's schema against a REFERENCE database NOW. `against` = null → PRODUCTION (the
  // default); any other db container id → an ad-hoc comparison that is REPORTED and never written to
  // the chip. Comparing dev↔dev is the whole reason the picker exists: "is THIS db drifted, or is
  // every db drifted the same way?" separates a bad restore from a difference the probe itself sees
  // (a different postgres/extension build on the host), and it is the first question worth asking
  // when a freshly restored db still shows drift.
  //
  // The full report is shown in the dialog, not just a total: for a non-prod reference nothing is
  // persisted, so the chip's tooltip cannot be where the breakdown lives. Its WORDING lives in
  // drift.js — including the scope caveat this dialog must carry on every outcome (TKT-22-4F0E: this
  // is the most quoted reading of the number, and "✓ matches production" with nothing after it is
  // exactly how a schema check came to be heard as "production is backed up").
  const runCheckDiff = async (against = null) => {
    if (diffing) return;
    setDiffing(against || 'prod');
    try {
      const r = await checkContainerDiff(c.id, against);
      onClose();
      showAlert(diffReportText(c.name, r), {
        title: r?.ok === false ? 'Check diff failed' : 'Schema comparison',
        variant: (r?.ok === false || r?.total > 0) ? 'error' : 'info',
      });
    } catch (e) {
      setDiffing(null);
      showAlert('Check diff failed: ' + (e?.error || e?.message || e), { variant: 'error' });
    }
  };

  // Copy THIS db's connection URL to the OS clipboard. Uses the SAME dbUrl() the tooltip shows, so
  // the menu can never offer a string that disagrees with what a hovered chip says. The item's label
  // flips to "Copied!" on success; a failure points at the tooltip rather than silently doing nothing.
  const copyDbUrl = async () => {
    const t = dbUrl(c);
    if (!t || copied) return;
    if (await toClipboard(t)) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
    else showAlert('Copy failed — grab the URL from the chip\'s tooltip instead.', { variant: 'error' });
  };

  // Check this db's ROWS against the backup it was restored from. Deliberately NOT folded into
  // runCheckDiff: they answer different questions, they can disagree (a perfect schema over an empty
  // database is the exact case that started this), and a human must be able to tell which answer they
  // are holding. Never persists onto the drift chip — the server keeps it in its own column.
  const runCheckData = async () => {
    if (dataing) return;
    setDataing(true);
    try {
      const r = await checkContainerData(c.id);
      onClose();
      showAlert(dataReportText(c.name, r), {
        title: r?.ok === false ? 'Check data failed' : 'Row-count check',
        variant: (r?.ok === false || r?.verdict === 'incomplete') ? 'error' : 'info',
      });
    } catch (e) {
      setDataing(false);
      showAlert('Check data failed: ' + (e?.error || e?.message || e), { variant: 'error' });
    }
  };

  // Duplicate PRODUCTION into this dev db: a fresh prod backup + restore fused into one action, so
  // the db becomes an exact copy of live prod. It OVERWRITES everything here, so it asks first (a
  // destructive confirm, like the backups panel's restore). The container itself is captured up
  // front because confirming closes the menu underneath the modal.
  const runDuplicateProd = async () => {
    if (dupPending) return;
    const tgt = c;
    const okd = await showConfirm(
      `Duplicate PRODUCTION into ${tgt.name}?\n\n`
      + `This takes a fresh dump of LIVE production and restores it here — OVERWRITING everything `
      + `currently in this database. It cannot be undone.`,
      { okLabel: 'Duplicate prod', cancelLabel: 'Cancel', variant: 'error' });
    if (!okd) return;
    setDupPending(true);
    try {
      await duplicateProd(tgt.id);
      onClose();
    } catch (e) {
      setDupPending(false);
      showAlert('Duplicate prod failed: ' + (e?.error || e?.message || e), { variant: 'error' });
    }
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
            {devicePhysical
              ? <>This <b>removes the device registration</b>.</>
              : isDevice
                ? <>This <b>stops and removes</b> the emulator.</>
                : <>This <b>stops and removes</b> the container.</>}
            {isDb
              ? <div className="ctxwarn-danger">⚠ This is a <b>DATABASE</b>. Its data is
                  <b> permanently deleted</b> — this cannot be undone.</div>
              : devicePhysical
                ? <div className="ctxwarn-note">The physical phone is <b>untouched</b> — only Zeehive's
                    registration is removed. Any xell using it is unlinked. Re-register it anytime.</div>
                : isDevice
                  ? <div className="ctxwarn-note">The emulator container is torn down. This cannot be
                      undone (attach a new device to bring one back).</div>
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
      {c.url && <a role="menuitem" href={previewHref(c.url)} target="_blank" rel="noopener" onClick={onClose}>↗ Open URL</a>}

      {/* Shell: a terminal INSIDE this container. `shellable` is computed server-side (fleet.js):
          a real container needs to be running ('up'); a PROCESS-ROLE server/webapp is always
          shellable — its shell is the queenzee's container at the xell's worktree, which works
          even while the process is down (exactly when you want in to debug it). A down/unbuilt
          real container offers the honest reason instead of a broken terminal. */}
      {c.shellable ? (
        <button role="menuitem" data-testid="shell-open" onClick={() => { onShell?.(c); onClose(); }}>
          ⌨ Shell <span className="ctxsub">terminal inside this container</span>
        </button>
      ) : (
        <div className="ctxsub ctxbusy-note" data-testid="shell-unavailable">
          ⌨ shell unavailable — {buildable && !c.last_build_commit ? 'build it first' : `container is ${c.health}`}
        </div>
      )}

      {/* Copy database URL: the exact connection string this db answers at (conn_ref, or the DSN
          derived from its published host:host_port — the same dbUrl() the chip's tooltip shows). A
          db's address lives in conn_ref, not url, so this is the quick way to grab it without
          hunting the inventory. Hidden when no address is recorded (nothing safe to copy). */}
      {isDb && dbUrl(c) && (
        <button role="menuitem" data-testid="copy-db-url" disabled={copied}
                onClick={(e) => { e.stopPropagation(); copyDbUrl(); }}>
          📋 {copied ? 'Copied!' : 'Copy database URL'}
          <span className="ctxsub">{dbUrl(c)}</span>
        </button>
      )}

      {/* Back up now: dump THIS database to a new backup. Offered only on the PRODUCTION db chip —
          "backup" in this system means the prod snapshot the maintenance loop takes (backupProd),
          the same job the backups panel's "＋ Back up now" fires. Withdrawn while the db is busy
          (a dump/restore already in flight) since two dumps of one DB must not stack. This item
          rides the shared ContainerMenu, so it appears both on the inventory matrix and on the
          production hexagon's db chip. */}
      {isDb && prod && (busy ? (
        <div className="ctxsub ctxbusy-note" data-testid="backup-db-busy">backup unavailable while busy</div>
      ) : (
        <button role="menuitem" data-testid="backup-db-open"
                onClick={() => { onBackup?.(c); onClose(); }}>
          📦 Back up now <span className="ctxsub">dump this production database to a new backup</span>
        </button>
      ))}

      {/* Load backup: any db container. Opens the backup selector pre-aimed at THIS container, so
          the backup you pick restores straight into it. PRODUCTION is allowed but gated — the modal
          makes you type the db name to confirm before it overwrites live prod. Withdrawn while busy
          — a db mid-restore can't take another. */}
      {isDb && (busy ? (
        <div className="ctxsub ctxbusy-note" data-testid="load-backup-busy">load backup unavailable while busy</div>
      ) : (
        <button role="menuitem" data-testid="load-backup-open" className={prod ? 'ctxdanger-item' : ''}
                onClick={() => { onLoadBackup?.(c); onClose(); }}>
          {prod
            ? <>📥 Restore backup over prod… <span className="ctxsub">⚠ overwrites LIVE production — asks you to confirm</span></>
            : <>📥 Load backup… <span className="ctxsub">restore a backup into this db (overwrites data)</span></>}
        </button>
      ))}

      {/* Duplicate prod: on every NON-production db chip (matrix + xell hexagon share this menu).
          One click makes this db an exact copy of LIVE production — a fresh prod dump streamed
          straight into a restore here (backup + restore fused). It overwrites this db, so it's a
          danger item and asks to confirm first. Withdrawn while busy — a mid-restore db can't take
          another overwrite. Prod is the SOURCE, never a target, so it never carries this item. */}
      {isDb && !prod && (busy ? (
        <div className="ctxsub ctxbusy-note" data-testid="duplicate-prod-busy">duplicate prod unavailable while busy</div>
      ) : (
        <button role="menuitem" data-testid="duplicate-prod-open" className="ctxdanger-item"
                disabled={dupPending} onClick={runDuplicateProd}>
          🐝 {dupPending ? 'Duplicating prod…' : 'Duplicate prod'}
          <span className="ctxsub">copy LIVE production into this db (backup + restore in one · overwrites data)</span>
        </button>
      ))}

      {/* Check diff: on every NON-production db chip (matrix + xell hexagon share this menu, so it
          appears in both). Measures this db's schema against production on demand and repaints the
          chip's drift mark, rather than waiting up to 10 minutes for the background tick — handy the
          moment a restore lands or a migration runs. Prod is the ruler (measured against nothing), so
          it never carries this item. Withdrawn while busy: a mid-restore reading is stale by definition. */}
      {isDb && !prod && (busy ? (
        <div className="ctxsub ctxbusy-note" data-testid="check-diff-busy">diff unavailable while busy</div>
      ) : (
        <>
          <button role="menuitem" data-testid="check-diff-open" disabled={!!diffing}
                  onClick={() => runCheckDiff(null)}>
            🔍 {diffing === 'prod' ? 'Checking diff…' : 'Check diff'}
            <span className="ctxsub">compare this db's schema against production now</span>
          </button>
          {/* …or against ANOTHER db. One extra click, because production is the default and the only
              reference that repaints the chip; every other one is a report. */}
          <button role="menuitem" data-testid="check-diff-pick" className={picking ? 'ctxsel' : ''}
                  aria-expanded={picking} disabled={!!diffing}
                  onClick={() => setPicking((v) => !v)}>
            {picking ? '▾' : '▸'} Compare against…
            <span className="ctxsub">pick another database to measure this one against</span>
          </button>
          {picking && (
            <div className="ctxdbpick" data-testid="check-diff-picker">
              <div className="ctxsubhead">compare against {cands ? '' : '…'}</div>
              {candErr && <div className="ctxwarn-err" data-testid="check-diff-picker-err">{candErr}</div>}
              {cands && !cands.length && !candErr && (
                <div className="ctxsub ctxbusy-note">no other database in this project</div>
              )}
              {(cands || []).map((d) => (
                <button key={d.id} role="menuitem" data-testid={`check-diff-against-${d.id}`}
                        className={d.is_prod ? 'ctxsel' : ''} disabled={!!diffing}
                        title={`measure ${c.name} against ${d.name}`}
                        onClick={() => runCheckDiff(d.id)}>
                  {/* the REAL chip, so a db is recognised here exactly as it is everywhere else.
                      pointer-events are off (see .ctxdbpick .cbox) so the click is always the row's,
                      and url is dropped so no anchor is nested inside this button. */}
                  <span className="ctxchip"><ContainerChip c={{ ...d, url: null }} /></span>
                  <span className="ctxdbname">
                    {d.name}
                    <span className="ctxsub">
                      {d.is_prod ? '🛡 production · default · sets the chip' : d.tier}
                      {d.owner_slug ? ` · xell ${d.owner_slug}` : ''}
                      {d.busy_op ? ` · ${d.busy_op}ing…` : ''}
                      {diffing === d.id ? ' · checking…' : ''}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {/* CHECK DATA — the second question, one item down from the first and never merged into it.
              Its sub-label carries the reference (which backup, taken when) or the reason there isn't
              one, so the difference between "your rows are missing" and "nobody recorded what should
              be here" is visible BEFORE the click. TKT-22-4F0E. */}
          <button role="menuitem" data-testid="check-data-open" disabled={dataing || dataReady?.ready === false}
                  onClick={runCheckData}
                  title={dataReady?.ready === false
                    ? `cannot check rows: ${dataReady.reason}`
                    : 'count the rows in this db and compare them against the backup it was restored from'}>
            🧮 {dataing ? 'Counting rows…' : 'Check data'}
            <span className="ctxsub">
              {dataReady?.ready === false
                ? dataReady.reason
                : dataReady?.snapshot
                  ? `vs the backup of ${new Date(dataReady.snapshot.taken_at).toLocaleString()}`
                    + `${dataReady.snapshot.row_total != null ? ` (~${Number(dataReady.snapshot.row_total).toLocaleString()} rows)` : ''}`
                  : 'do the ROWS match the backup this db was restored from?'}
            </span>
          </button>
        </>
      ))}

      {/* Decommission: every non-production container, DEVICES included (035). Production is excluded
          outright — protected note, never an action. A busy container can't be removed mid-op. The
          sub-label tells the truth per kind: a db deletes data, a shared physical device removes only
          its registration (phone untouched), an emulator/anything-else stops + removes the container.
          For a device this is the pool-level "remove it entirely" — distinct from the xell card's ✕,
          which only DETACHES (an emulator is torn down, a shared phone merely unlinked). */}
      {prod ? (
        <div className="ctxprotected" data-testid="decommission-protected">🛡 production — protected</div>
      ) : busy ? (
        <div className="ctxsub ctxbusy-note">decommission unavailable while busy</div>
      ) : (
        <button role="menuitem" className="ctxitem-danger" data-testid="decommission-open"
                onClick={() => { setConfirming(true); setErr(null); }}>
          🗑 Decommission… <span className="ctxsub">{isDb ? 'stop + remove (deletes data)'
            : devicePhysical ? 'remove this device registration (phone untouched)'
            : isDevice ? 'stop + remove the emulator' : 'stop + remove'}</span>
        </button>
      )}
        </>
      )}
    </div>
  );
}

const ROLE_WORD = { db: 'database', server: 'server', webapp: 'app', device: 'device' };

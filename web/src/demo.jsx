import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import HiveCanvas from './hive/HiveCanvas.jsx';
import GraphPane from './GraphPane.jsx';
import Connectors from './Connectors.jsx';
import { beginPaneReposition } from './paneSplit.js';
import './styles.css';

// DEMO-ONLY visual harness (not shipped): the real HiveCanvas + GraphPane + Connectors wired with
// mock data whose xells sit on DIFFERENT base commits, so the connector wires visibly fan out from
// different dots in the graph. Toggle orientation/flip to see both spines.
const SUBJECTS = ['wire honeycomb stream', 'adaptive graph pane', 'fix hex tessellation', 'shell split',
  'process runner boot', 'ship gate order', 'db clone per xell', 'guard budget', 'link recovery',
  'pool reconciler', 'rename regenerates env', 'initial import'];
const commits = Array.from({ length: 12 }, (_, i) => ({
  hash: 'h' + i, short: (i * 1642869 + 0xabc0d).toString(16).slice(0, 7),
  parents: i < 11 ? ['h' + (i + 1)] : [], subject: SUBJECTS[i] || 'commit ' + i,
}));
commits[2].parents = ['h3', 'h5'];          // a merge → a second lane, to show the weave

const LANE = ['#e0a53b', '#e26fae', '#9ccf3f', '#5b8cff', '#35c46b', '#9b8cff'];
// nine xells on heads (prods on h0,h2; the manager on h1 and its reaped worker on h8 — a husk
// needs a dot of its OWN or the "a husk lends nothing" story lands on the manager's dot; the router on h7).
// calm-ridge (x2) and bold-harbor (x3) SHARE h4 on purpose: their wires leave the same commit dot and
// thread the same corridor, so the honeycomb shows the collapsed lane — ONE dashed line alternating
// their two trace colours — instead of two parallel channels.
const BASES = ['h0', 'h2', 'h4', 'h4', 'h9', 'h3', 'h1', 'h8', 'h7'];
const NAMES = ['swift-atlas', 'sunny-ember', 'calm-ridge', 'bold-harbor', 'lucid-fern', 'brave-quill'];

const xells = NAMES.map((slug, i) => ({
  id: 'x' + i, slug: i < 2 ? ['mardale-prod', 'mardale-prod-2'][i] : slug + '-' + (0x7000 + i * 273).toString(16),
  status: ['ready', 'working', 'ready', 'idle', 'ready', 'working'][i],
  is_production: i < 2,   // two prods, adjacent → graph tracks their median
  head_commit: 'ab' + (0x10000 + i * 4099).toString(16), deployed_commit: 'ab00' + i + 'de',
  created_at: new Date(Date.now() - i * 3600e3).toISOString(),
  branch: 'spinoff/' + slug, viewer_url: 'http://x/' + i, viewer_kind: 'web',
  remote_source: { ref: 'master' },
  // one xell per vendor, so the demo shows what the honeycomb actually shows: the AI PROVIDER is the
  // badge (its coin) and the harness is worn over it (web/src/providerArt.js)
  runtime_key: ['claude-code-cxell', 'claude-code-cxell', 'codex-cxell', 'kimi-code-cxell',
                'deepseek-cxell', 'codex-cxell'][i],
  stack: [
    { role: 'db', name: 'db-' + slug, health: 'up', docker_ctx: 'ugreen' },
    { role: 'server', name: 'srv-' + slug, health: ['up', 'up', 'building', 'up', 'up', 'down'][i], docker_ctx: 'ugreen' },
    { role: 'webapp', name: 'web-' + slug, health: 'up', docker_ctx: 'ugreen' },
  ],
}));
// A MANAGER zee and its crew — the one hexagon that is NOT a work-cell. It is drawn as a persona
// (the harness badge's language: dashed seat + avatar disc) with no head sha and no diffstat,
// because a manager has zero push access to the xource; its crew is seated around it by seatXells.
xells.push({
  id: 'x6', slug: 'wise-cove-d6af', zee_type: 'manager', status: 'working', zee_status: 'working',
  cli_active: true, hive_status: 'occ-working', hive_status_label: 'working',
  db_coupling: 'db-prod-readonly', branch: 'spinoff/wise-cove-d6af', created_at: new Date(Date.now() - 5 * 3600e3).toISOString(),
  head_commit: 'ab99f00d', remote_source: { ref: 'master' }, runtime_key: 'claude-code-cxell', viewer_kind: 'ssh-terminal', viewer_url: 'ssh://x6',
  zee_title: 'run the refactor crew', task_id: 'demo-task',
  stack: [{ role: 'db', name: 'db-wise-cove', health: 'up', docker_ctx: 'ugreen' }],
});
// THE ROUTER — a manager-type xell wearing the `router` harness (migration 139): the front door that
// recomposes a human's prompt and decides dispatch. It renders WHITE (HiveCanvas statusColor → COL.router),
// the same IDENTITY treatment production gets in lime green, so the demo can show both identity fills
// side by side.
xells.push({
  id: 'x8', slug: 'router-4f31', zee_type: 'manager', harness_key: 'router', status: 'working',
  zee_status: 'working', cli_active: true, hive_status: 'occ-working', hive_status_label: 'working',
  db_coupling: 'db-prod-readonly', branch: 'spinoff/router-4f31', created_at: new Date(Date.now() - 4 * 3600e3).toISOString(),
  head_commit: 'ab7f00d1', remote_source: { ref: 'master' }, runtime_key: 'claude-code-cxell',
  viewer_kind: 'ssh-terminal', viewer_url: 'ssh://x8', task_id: 'router-task',
  stack: [{ role: 'db', name: 'db-router', health: 'up', docker_ctx: 'ugreen' }],
});
xells[3].manager_xell_id = 'x6';   // bold-harbor reports to it (idle → "1 waiting")
xells[5].manager_xell_id = 'x6';   // brave-quill too (working)
xells[3].hive_status = 'occ-tendRequest'; xells[5].hive_status = 'occ-working';
// A tend is only as useful as the reason on it — the mock hive carries one so the demo shows the
// ask the way a human meets it ("who wants me, and what for"), not a bare amber hexagon.
xells[3].tend = { open: true, at: new Date(Date.now() - 9 * 60e3).toISOString(),
  reason: 'the migration needs prod’s schema — do I ask for a db-catchup or is this a seed?' };
xells[5].zee_status = 'working'; xells[5].cli_active = true;
// …and a REAPED crew member, because the rule easiest to get wrong is the one worth SEEING: a husk
// lends nothing to the highlight (hive/crew.js isLiveXell). Hover or select the manager and this one
// stays dark — hexagon, wire and commit dot — while its two live siblings light up, and the manager's
// hexagon counts 2 crew, not 3.
xells.push({
  id: 'x7', slug: 'stale-glade-7f2c', status: 'husk', hive_status: 'vac-dirty', manager_xell_id: 'x6',
  branch: 'spinoff/stale-glade-7f2c', head_commit: 'ab5510de', remote_source: { ref: 'master' },
  created_at: new Date(Date.now() - 26 * 3600e3).toISOString(),
  stack: [{ role: 'db', name: 'db-stale-glade', health: 'down', docker_ctx: 'ugreen' }],
});

// x0/x1 are the two prods (lime hex fill, orange trace accent), on h0 & h2 → the graph tracks the
// median of the pair
const timeline = {
  branch: 'master', commits,
  xells: xells.map((x, i) => ({ id: x.id, base_commit: BASES[i] || 'h1',
    color: i < 2 ? '#f0913b' : LANE[i % LANE.length] })),
  // The manager wears a manager harness — its badge art is what the manager HEXAGON shows, and that
  // is the whole appearance of this harness in the grid: a manager is a `wearer` but never a
  // `consumer`, so this harness takes NO cell of its own (it would seat the same avatar twice).
  harnesses: [
    { id: 'h-mgr', key: 'manager', label: 'Manager', glyph: '🧭', color: '#9b8cff',
      base_commit: 'h1', wearer_ids: ['x6'], consumer_ids: [] },
    // a WORKER harness with real consumers — the one the show-harness toggle exists to show: its badge
    // takes a grid cell and the wires of these two xells route THROUGH it (one continuous trace), and
    // flipping the toggle off hides the badge and runs those wires straight from each dot to its hex.
    // Its two wearers also run on DIFFERENT vendors (kimi and codex above), which is the provider
    // badge's whole point: the same tool pip hanging off two different provider coins.
    { id: 'h-work', key: 'builder', label: 'Builder', glyph: '⚒', color: '#35c46b',
      base_commit: 'h4', wearer_ids: ['x3', 'x5'], consumer_ids: ['x3', 'x5'] },
  ],
};
const diffs = Object.fromEntries(xells.map((x, i) => {
  const baseRow = commits.findIndex((c) => c.hash === BASES[i]);
  return [x.id, { ahead: i, behind: baseRow, files: i + 1, dirty: i % 2, insertions: i * 7, deletions: i * 2,
    own: { files: i, insertions: i * 3, deletions: i } }];
}));
const machines = [{ docker_ctx: 'ugreen', key: 'ugreen-nas' }];

function Demo() {
  const [orientation, setOrientation] = useState('landscape');
  const [honeySide, setHoneySide] = useState('a');
  const [showHarness, setShowHarness] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [split, setSplit] = useState(null);
  const layoutRef = useRef(null);
  const hexPosRef = useRef({});
  const harnessPosRef = useRef({});
  const geomListeners = useRef(new Set());
  const subscribeGeom = React.useCallback((fn) => { geomListeners.current.add(fn); return () => geomListeners.current.delete(fn); }, []);
  const fireGeom = React.useCallback(() => { geomListeners.current.forEach((fn) => { try { fn(); } catch {} }); }, []);
  const [version, setVersion] = useState(0);
  const prodIds = xells.filter((x) => x.is_production).map((x) => x.id);
  const hoverRef = useRef({ id: null, commit: null });
  const hoverListeners = useRef(new Set());
  const setHover = React.useCallback((h) => {
    const c = hoverRef.current;
    if (c.id === h.id && c.commit === h.commit) return;
    hoverRef.current = h; hoverListeners.current.forEach((fn) => { try { fn(); } catch {} });
  }, []);
  const subscribeHover = React.useCallback((fn) => { hoverListeners.current.add(fn); return () => hoverListeners.current.delete(fn); }, []);

  return (
    <div className={`hive-split o-${orientation} honey-${honeySide}`} ref={layoutRef}>
      <section className="hive-pane honey" style={split != null ? { flex: `${split} 1 0` } : undefined}>
        <HiveCanvas xells={xells} diffs={diffs} timeline={timeline} orientation={orientation} honeySide={honeySide}
                    machines={machines} onOpenSession={() => {}}
                    expandedId={expandedId} onExpand={setExpandedId}
                    hexPosRef={hexPosRef} harnessPosRef={harnessPosRef} onGeometry={fireGeom}
                    hoverRef={hoverRef} setHover={setHover} subscribeHover={subscribeHover}
                    showHarness={showHarness} />
      </section>

      {/* `xells` to BOTH of these as well as the canvas: the manager↔crew relation is drawn in all
          three layers (hive/crew.js), so a demo that withheld the fleet from two of them would show a
          highlight that half works — exactly the state ticket #25 existed to fix. */}
      <GraphPane timeline={timeline} xells={xells} orientation={orientation} honeySide={honeySide}
                 hexPosRef={hexPosRef} prodIds={prodIds} expandedId={expandedId} subscribeGeom={subscribeGeom}
                 hoverRef={hoverRef} setHover={setHover} subscribeHover={subscribeHover}
                 showHarness={showHarness} onToggleHarness={() => { setShowHarness((s) => !s); setVersion((v) => v + 1); }}
                 onFlip={() => { setHoneySide((s) => s === 'a' ? 'b' : 'a'); setVersion((v) => v + 1); }}
                 onReposition={(e) => beginPaneReposition(e, { layoutRef, orientation, honeySide, setSplit })} />

      <Connectors timeline={timeline} xells={xells} layoutRef={layoutRef} version={version}
                  hexPosRef={hexPosRef} harnessPosRef={harnessPosRef} orientation={orientation} honeySide={honeySide}
                  expandedId={expandedId} prodIds={prodIds} subscribeGeom={subscribeGeom}
                  hoverRef={hoverRef} subscribeHover={subscribeHover} showHarness={showHarness} />

      <section className="hive-pane panels" style={split != null ? { flex: `${1 - split} 1 0` } : undefined}>
        <div className="content" style={{ padding: 16 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button className="flip-btn" onClick={() => { setOrientation((o) => o === 'landscape' ? 'portrait' : 'landscape'); setVersion((v) => v + 1); }}>
              ⤢ {orientation}
            </button>
            <button className="flip-btn" onClick={() => { setHoneySide((s) => s === 'a' ? 'b' : 'a'); setVersion((v) => v + 1); }}>
              ⇄ flip (honey {honeySide})
            </button>
            <button className="flip-btn" onClick={() => { setShowHarness((s) => !s); setVersion((v) => v + 1); }}>
              show harness: {showHarness ? 'on' : 'off'}
            </button>
          </div>
          <p style={{ color: 'var(--muted)', font: "13px 'Segoe UI', sans-serif", lineHeight: 1.6 }}>
            Six xells on six different base commits. Each wire leaves the commit dot the xell sits on —
            a xell based on an older commit hangs off a lower dot (it's behind). Pan/zoom the honeycomb;
            the wires re-route live. Click a hex to bloom its flower.
            <br /><br />
            The seventh is a <b>manager</b> (wise-cove): drawn as a persona — dashed seat, its harness
            avatar, a prod-orange double wall — with its crew seated around it, and deliberately
            without a head sha or a diffstat. Bloom it: petals 5/6 are CREW and PROD·AGE, and there is
            no pull/land/PR to click. Note what is <i>not</i> in the grid: its harness gets no cell of
            its own — the manager hexagon already IS that persona.
          </p>
          <ul style={{ color: 'var(--muted)', font: "12px 'Cascadia Code', monospace", lineHeight: 1.8 }}>
            {timeline.xells.map((tx) => {
              const x = xells.find((xx) => xx.id === tx.id);
              return <li key={tx.id}><span style={{ color: tx.color }}>●</span> {x.slug} → base {tx.base_commit}</li>;
            })}
          </ul>
        </div>
      </section>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<Demo />);

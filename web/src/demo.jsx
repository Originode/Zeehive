import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import HiveCanvas from './hive/HiveCanvas.jsx';
import GraphPane from './GraphPane.jsx';
import Connectors from './Connectors.jsx';
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
const BASES = ['h0', 'h2', 'h4', 'h6', 'h9', 'h3'];    // six xells, six different heads (prods on h0,h2)
const NAMES = ['swift-atlas', 'sunny-ember', 'calm-ridge', 'bold-harbor', 'lucid-fern', 'brave-quill'];

const xells = NAMES.map((slug, i) => ({
  id: 'x' + i, slug: i < 2 ? ['mardale-prod', 'mardale-prod-2'][i] : slug + '-' + (0x7000 + i * 273).toString(16),
  status: ['ready', 'working', 'ready', 'idle', 'ready', 'working'][i],
  is_production: i < 2,   // two prods, adjacent → graph tracks their median
  head_commit: 'ab' + (0x10000 + i * 4099).toString(16), deployed_commit: 'ab00' + i + 'de',
  created_at: new Date(Date.now() - i * 3600e3).toISOString(),
  branch: 'spinoff/' + slug, viewer_url: 'http://x/' + i, viewer_kind: 'web',
  remote_source: { ref: 'master' },
  stack: [
    { role: 'db', name: 'db-' + slug, health: 'up', docker_ctx: 'ugreen' },
    { role: 'server', name: 'srv-' + slug, health: ['up', 'up', 'building', 'up', 'up', 'down'][i], docker_ctx: 'ugreen' },
    { role: 'webapp', name: 'web-' + slug, health: 'up', docker_ctx: 'ugreen' },
  ],
}));
// x0/x1 are the two prods (gold), on h0 & h2 → the graph tracks the median of the pair
const timeline = {
  branch: 'master', commits,
  xells: xells.map((x, i) => ({ id: x.id, base_commit: BASES[i],
    color: i < 2 ? '#f2c14e' : LANE[i % LANE.length] })),
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
  const [expandedId, setExpandedId] = useState(null);
  const layoutRef = useRef(null);
  const hexPosRef = useRef({});
  const geomListeners = useRef(new Set());
  const subscribeGeom = React.useCallback((fn) => { geomListeners.current.add(fn); return () => geomListeners.current.delete(fn); }, []);
  const fireGeom = React.useCallback(() => { geomListeners.current.forEach((fn) => { try { fn(); } catch {} }); }, []);
  const [version, setVersion] = useState(0);
  const prodIds = xells.filter((x) => x.is_production).map((x) => x.id);

  return (
    <div className={`hive-split o-${orientation} honey-${honeySide}`} ref={layoutRef}>
      <section className="hive-pane honey">
        <HiveCanvas xells={xells} diffs={diffs} timeline={timeline}
                    machines={machines} onOpenSession={() => {}}
                    expandedId={expandedId} onExpand={setExpandedId}
                    hexPosRef={hexPosRef} onGeometry={fireGeom} />
      </section>

      <GraphPane timeline={timeline} orientation={orientation} honeySide={honeySide}
                 hexPosRef={hexPosRef} prodIds={prodIds} subscribeGeom={subscribeGeom} />

      <Connectors timeline={timeline} layoutRef={layoutRef} version={version}
                  hexPosRef={hexPosRef} orientation={orientation} honeySide={honeySide}
                  expandedId={expandedId} prodIds={prodIds} subscribeGeom={subscribeGeom} />

      <section className="hive-pane panels">
        <div className="content" style={{ padding: 16 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button className="flip-btn" onClick={() => { setOrientation((o) => o === 'landscape' ? 'portrait' : 'landscape'); setVersion((v) => v + 1); }}>
              ⤢ {orientation}
            </button>
            <button className="flip-btn" onClick={() => { setHoneySide((s) => s === 'a' ? 'b' : 'a'); setVersion((v) => v + 1); }}>
              ⇄ flip (honey {honeySide})
            </button>
          </div>
          <p style={{ color: 'var(--muted)', font: "13px 'Segoe UI', sans-serif", lineHeight: 1.6 }}>
            Six xells on six different base commits. Each wire leaves the commit dot the xell sits on —
            a xell based on an older commit hangs off a lower dot (it's behind). Pan/zoom the honeycomb;
            the wires re-route live. Click a hex to bloom its flower.
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

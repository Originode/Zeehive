import React from 'react';

// Distinct lane colors (dark-mode friendly).
const LANE = ['#e0a53b', '#e26fae', '#9ccf3f', '#5b8cff', '#35c46b', '#9b8cff',
  '#e5554e', '#3bc6c0', '#d98c5f', '#7bd0e0', '#c98cff', '#8cd98c'];

const ROW = 26, LANE_W = 13, DOT = 4.5, PAD = 10, GX = 12, TEXT_W = 250;

// Assign each commit to a lane from its parent topology (newest→oldest), GitLens-style.
function computeGraph(commits) {
  const lanes = [];              // expected next hash per active lane
  const place = {};              // hash → {lane,row}
  const rows = [];
  commits.forEach((c, row) => {
    let lane = lanes.indexOf(c.hash);
    if (lane === -1) { lane = lanes.indexOf(null); if (lane === -1) { lane = lanes.length; lanes.push(null); } }
    for (let i = 0; i < lanes.length; i++) if (i !== lane && lanes[i] === c.hash) lanes[i] = null; // merges converge
    place[c.hash] = { lane, row };
    rows.push({ c, lane, row });
    lanes[lane] = c.parents[0] || null;                        // first parent continues the lane
    for (let p = 1; p < c.parents.length; p++) {               // extra parents branch into new lanes
      let f = lanes.indexOf(null); if (f === -1) { f = lanes.length; lanes.push(null); }
      lanes[f] = c.parents[p];
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
  });
  const laneCount = rows.reduce((m, r) => Math.max(m, r.lane + 1), 1);
  const edges = [];
  for (const { c, lane, row } of rows) {
    for (const ph of c.parents) {
      const pp = place[ph];
      edges.push({ fromLane: lane, fromRow: row, toLane: pp ? pp.lane : lane, toRow: pp ? pp.row : commits.length, dangling: !pp });
    }
  }
  return { rows, edges, laneCount };
}

const laneX = (l) => GX + l * LANE_W;
const rowY = (r) => PAD + r * ROW + ROW / 2;

export default function GitRail({ timeline, collapsed, onToggle }) {
  if (!timeline) {
    return <aside className="gitrail"><div className="railhead"><span>GRAPH</span></div></aside>;
  }
  const { commits, xells, branch } = timeline;
  const { rows, edges, laneCount } = computeGraph(commits);
  const anchors = {};
  for (const x of xells) (anchors[x.base_commit] ||= []).push(x.color);

  const graphW = GX + laneCount * LANE_W + 8;
  const width = collapsed ? graphW + 66 : graphW + TEXT_W; // collapsed still shows the hashes (heads)
  const height = PAD * 2 + commits.length * ROW;

  const edgePath = (e) => {
    const xF = laneX(e.fromLane), yF = rowY(e.fromRow);
    const xT = laneX(e.toLane), yT = e.dangling ? height : rowY(e.toRow);
    if (e.fromLane === e.toLane) return `M${xF},${yF} L${xT},${yT}`;
    const ym = yF + ROW / 2;
    return `M${xF},${yF} C${xF},${ym} ${xT},${yF + ROW * 0.4} ${xT},${yF + ROW} L${xT},${yT}`;
  };

  return (
    <aside className={`gitrail ${collapsed ? 'collapsed' : ''}`} style={{ flexBasis: width + 8, width: width + 8 }}>
      <div className="railhead">
        <button className="chev" onClick={onToggle} title={collapsed ? 'Expand history' : 'Collapse to lanes'}>
          {collapsed ? '▸' : '▾'}
        </button>
        <span>⎇ {branch}</span>
      </div>
      <svg className="graph" width={width} height={height} style={{ display: 'block' }}>
        {edges.map((e, i) => (
          <path key={i} d={edgePath(e)} fill="none" stroke={LANE[e.fromLane % LANE.length]}
                strokeWidth="1.8" opacity="0.85" />
        ))}
        {rows.map(({ c, lane, row }) => {
          const cx = laneX(lane), cy = rowY(row);
          const isMerge = c.parents.length > 1;
          const ring = anchors[c.hash]?.[0];
          return (
            <g key={c.hash}>
              {ring && <circle cx={cx} cy={cy} r={DOT + 3} fill="none" stroke={ring} strokeWidth="2" />}
              <circle cx={cx} cy={cy} r={DOT} data-commit={c.hash} data-dot
                      fill={isMerge ? 'var(--bg)' : LANE[lane % LANE.length]}
                      stroke={LANE[lane % LANE.length]} strokeWidth={isMerge ? 2 : 0} />
              {row === 0 && <text className="ghead" x={cx + DOT + 5} y={cy - 6}>{branch}</text>}
              {/* commit head (short hash) shows in BOTH states; subject only when expanded */}
              <text className="gsub" x={graphW} y={cy + 3}>
                <tspan className="ghash">{c.short}</tspan>
                {!collapsed && <tspan dx="7">{c.subject.length > 44 ? c.subject.slice(0, 44) + '…' : c.subject}</tspan>}
              </text>
            </g>
          );
        })}
      </svg>
    </aside>
  );
}

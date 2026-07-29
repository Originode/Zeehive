import React, { useEffect, useState } from 'react';
import { getGantt } from './workApi.js';
import { ErrLine } from './bits.jsx';

// WORK TRACKER — TIMELINE (gantt). **PLACEHOLDER — part 4 replaces the body of this file.**
//
// WHY IT EXISTS NOW, EMPTY: the console container (WorkConsole.jsx) owns the three tabs, and a tab
// that is wired to nothing is a tab that gets wired wrong later. So the seam is cut today and the
// contract is frozen: this module's default export is `Gantt` and its props are `{ projectId,
// rootId }` — exactly what the tree rail's selection produces. Part 4 rewrites everything below the
// header without touching WorkConsole, and a reviewer can see at a glance that the drop-in is a
// drop-in.
//
// What it renders meanwhile is the HONEST thing: the raw `/api/gantt` read model in a plain table.
// `/api/gantt` returns tree-ordered rows with computed dates (a row's dates roll up from its
// children, and dependencies push a start out), so this table is also the fastest way for part 4 to
// see what the server is actually handing it before drawing a single bar.
//
// `rootId` scopes the timeline to a subtree, the same way it scopes the board — a manager looking at
// one activity should get one activity's timeline, not the whole project's.
export default function Gantt({ projectId, rootId }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let live = true;
    getGantt(projectId, rootId)
      .then((r) => { if (live) { setRows(Array.isArray(r) ? r : (r?.rows || [])); setErr(null); } })
      .catch((e) => { if (live) setErr(e); });
    return () => { live = false; };
  }, [projectId, rootId]);

  const cols = ['title', 'kind', 'status', 'starts_on', 'due_on', 'estimate_hours', 'progress', 'depth'];

  return (
    <div className="work-gantt" data-testid="work-gantt">
      <div className="work-gantt-note">
        <b>Timeline — landing in part 4.</b> Below is the raw <code>/api/gantt</code> read model, so
        the data is at least visible while the bars are not.
      </div>
      <ErrLine err={err} />
      {rows === null && !err && <div className="work-empty">loading…</div>}
      {rows !== null && !rows.length && <div className="work-empty">no rows</div>}
      {!!rows?.length && (
        <table className="work-gtable">
          <thead>
            <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id || i}>
                {cols.map((c) => (
                  <td key={c} className={c === 'title' ? 'gt-title' : ''}
                      style={c === 'title' ? { paddingLeft: 6 + (Number(r.depth) || 0) * 14 } : undefined}>
                    {r[c] === null || r[c] === undefined ? '' : String(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

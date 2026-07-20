// Builds the git-timeline payload the web app renders on the left rail, plus each xell's
// anchor commit (its worktree base) so the frontend can draw a connector to the card.
import { existsSync } from 'node:fs';
import { q, one } from '../db/pool.js';
import { gitLog, diffStat, worktreeDiff, worktreeHead, isAncestor, countBehind } from './git.js';
import { cageDiff } from './cage.js';
import { defaultProject } from './fleet.js';

// A caged zee's work lives INSIDE its cage, not in the host worktree (see cageDiff): the host
// worktree stays frozen at the provisioning base until `zee land`, so worktreeDiff reads 0/0 for
// every busy caged zee. cageDiff reads the real numbers over `docker exec`, which costs ~a few
// hundred ms — too much for the raw /xell/diffs poll rate. Cache each cage's answer briefly; a
// dashboard number that lags a work-cadence of seconds is invisible, and the exec load stays flat.
const CAGE_DIFF_TTL_MS = 12_000;
const cageDiffCache = new Map(); // xell id -> { at, val }

// Per-xell divergence vs its tracked xource (ahead/behind + shortstat).
//
// Measured from the WORKTREE, not from the stored head_commit. head_commit is the commit the xell
// was provisioned at — the same value for every xell cut from one tip — so diffing it against main
// made every card show an identical number and hid the zee's actual work entirely (a zee could
// commit, or have a dirty tree, and the card never moved). Falls back to the old base-vs-source
// comparison only when there is no worktree on disk (simulate mode).
//
// CAGED zees are the exception the host worktree can't answer: their work sits in the cage clone
// until landing, so for a xell with a live caged zee we read the diff from the cage (cageDiff) and
// fold in `behind` from the host (how far the source moved since the fork). Anything unreachable or
// non-caged falls through to the host-worktree path below.
export async function getDiffs(projectId) {
  const project = projectId ? await one(`SELECT * FROM project WHERE id=$1`, [projectId]) : await defaultProject();
  if (!project) return {};
  const branch = project.main_branch || 'main';
  const xells = await q(
    `SELECT id, slug, head_commit, worktree_path, is_production FROM xell
       WHERE project_id=$1 AND status<>'retired'`,
    [project.id]);

  // Which of these xells is being driven by a LIVE caged zee right now? (Same live-status set the
  // monitor treats as "a zee is present".) Only these need the cage read; everything else is a
  // host-worktree diff. slug → cage container name; head_commit → the base the cage diffs against.
  const cagedRows = await q(
    `SELECT DISTINCT z.xell_id FROM zee z
       JOIN agent_runtime r ON r.id = z.runtime_id
      WHERE r.key = 'claude-code-caged'
        AND z.status IN ('spawning','online','working','idle')
        AND z.xell_id = ANY($1::uuid[])`,
    [xells.map((x) => x.id)]);
  const caged = new Set(cagedRows.map((r) => r.xell_id));

  // Production is a xell, so it gets a diff too — it was excluded here, which is precisely why it
  // could drift unwatched. Its CONTENT is whatever the last successful ship deployed, and its
  // xource is origin, so its diff answers "has what is live drifted from the backup?".
  //
  // NULL until a ship actually lands: prod's current code predates the ship gate and was deployed
  // by hand, so nothing recorded what it is. A blank beats a guess about production.
  const shipped = await one(
    `SELECT commit FROM ship_request WHERE project_id=$1 AND status='shipped'
       ORDER BY finished_at DESC NULLS LAST LIMIT 1`, [project.id]);

  const out = {};
  for (const x of xells) {
    if (x.is_production) {
      out[x.id] = shipped?.commit
        ? diffStat(project.repo_root, shipped.commit, `origin/${branch}`)
        : null;
      continue;
    }
    let d = null;
    // Live caged zee: read the diff from the cage, where the uncollected work is. `behind` isn't
    // visible in the cage (the source ref isn't cloned in), so it comes from the host — how far the
    // source advanced past the provisioning base. Cached briefly to keep the exec load flat. On any
    // cage failure (unreachable, no base) cageDiff returns null and we fall through to the host path.
    if (caged.has(x.id) && x.head_commit) {
      const hit = cageDiffCache.get(x.id);
      if (hit && Date.now() - hit.at < CAGE_DIFF_TTL_MS) {
        d = hit.val;
      } else {
        const cd = await cageDiff({ ctx: 'default', slug: x.slug, base: x.head_commit });
        if (cd) {
          const behind = await countBehind(project.repo_root, x.head_commit, branch);
          d = { ...cd, behind };
        }
        cageDiffCache.set(x.id, { at: Date.now(), val: d });
      }
    }
    if (!d) {
      d = x.worktree_path && existsSync(x.worktree_path)
        ? await worktreeDiff(x.worktree_path, branch)
        : (x.head_commit ? diffStat(project.repo_root, x.head_commit, branch) : null);
    }
    // Is this xell's landed head already contained in the LIVE prod commit? If so the card should
    // read "shipped", not "ship ready" — its work is already deployed (usually as part of a later
    // combined ship), so offering to ship again is misleading.
    if (d && d.head && shipped?.commit) d.in_prod = isAncestor(project.repo_root, d.head, shipped.commit);
    out[x.id] = d;
  }
  return out;
}

// stable, distinct connector colors per xell
const COLORS = ['#e0a53b', '#e26fae', '#9ccf3f', '#5b8cff', '#35c46b', '#9b8cff', '#e5554e', '#3bc6c0'];
// production's gold — matches its hexagon (COL.prod in HiveCanvas) so its ring + wire read as prod.
const PROD_COLOR = '#f2c14e';

export async function getTimeline(projectId, n = 250) {
  const project = projectId ? await one(`SELECT * FROM project WHERE id=$1`, [projectId]) : await defaultProject();
  if (!project) return null;
  const branch = project.main_branch || 'main';
  // Fetch a deep window, then TRIM it back to the oldest xell fork point below. n is a safety cap,
  // not the display length: the graph only ever shows down to where the oldest live branch left the
  // trunk, so cutting the fetch short (the old n=30) would sometimes stop ABOVE that fork and strand
  // a branch with nowhere to anchor.
  const allCommits = gitLog(project.repo_root, branch, n);
  const known = new Set(allCommits.map((c) => c.hash));
  const rowOf = new Map(allCommits.map((c, i) => [c.hash, i]));

  // The commit production is serving — the last successful ship — so prod can be anchored to it
  // below. NULL until a ship lands (prod's pre-gate deploys were by hand and unrecorded).
  const shipped = await one(
    `SELECT commit FROM ship_request WHERE project_id=$1 AND status='shipped'
       ORDER BY finished_at DESC NULLS LAST LIMIT 1`, [project.id]);

  const xells = await q(
    `SELECT id, slug, branch, head_commit, status, worktree_path
       FROM xell WHERE project_id=$1 AND status<>'retired' AND NOT is_production
       ORDER BY created_at`, [project.id]);

  const anchored = xells.map((x, i) => {
    // Anchor to where the xell ACTUALLY sits now — its live worktree HEAD — not the frozen
    // head_commit (the provisioning base). Once its work lands, HEAD is a real commit on the branch
    // (in `known`), so the connector snaps to the tip instead of dangling at the old fork point and
    // making a level xell look "behind". Fall back to the stored base, then the tip.
    const live = x.worktree_path && existsSync(x.worktree_path) ? worktreeHead(x.worktree_path) : null;
    const base = live && known.has(live) ? live
      : x.head_commit && known.has(x.head_commit) ? x.head_commit
      : allCommits[0]?.hash;
    return {
      id: x.id, slug: x.slug, branch: x.branch, status: x.status,
      worktree_path: x.worktree_path, base_commit: base, head: live, color: COLORS[i % COLORS.length],
    };
  });

  // Production is a xell too, and the graph SCROLLS to keep its dot across from the prod hexagon —
  // but it can only do that if prod has a dot, so it must be in this list. It is anchored to the
  // commit it is actually SERVING (the last shipped commit); prod's gold matches its hexagon so the
  // ring + connector read as production. Excluded before, which is exactly why the graph never
  // tracked it. (getTimeline's other query filters prod out, so it is added explicitly here.)
  const prodRow = await one(
    `SELECT id, slug, branch, head_commit, status, worktree_path
       FROM xell WHERE project_id=$1 AND is_production AND status<>'retired' LIMIT 1`, [project.id]);
  let prod = null;
  if (prodRow) {
    const pbase = shipped?.commit && known.has(shipped.commit) ? shipped.commit
      : prodRow.head_commit && known.has(prodRow.head_commit) ? prodRow.head_commit
      : allCommits[0]?.hash;
    prod = {
      id: prodRow.id, slug: prodRow.slug, branch: prodRow.branch, status: prodRow.status,
      is_production: true, worktree_path: prodRow.worktree_path, base_commit: pbase,
      head: shipped?.commit || null, color: PROD_COLOR,
    };
  }

  const anchors = prod ? [...anchored, prod] : anchored;

  // TRIM to the oldest xell branch: the graph shows the trunk down to the DEEPEST fork point among
  // all live branches (prod included), and no further. Everything below that is history no live
  // branch touches, so it is just noise pushing the interesting rows off the top. Keep one commit of
  // padding past the fork so the oldest branch's dot isn't flush against the bottom edge.
  let cut = 0;
  for (const a of anchors) { const r = rowOf.get(a.base_commit); if (r != null && r > cut) cut = r; }
  // A small floor so a project whose branches all fork near the tip still draws a usable spine
  // instead of two lonely rows; the deepest fork wins whenever it is deeper than the floor.
  const depth = Math.max(cut + 2, Math.min(allCommits.length, 12));
  const commits = allCommits.slice(0, Math.min(allCommits.length, depth));

  return { branch, repo_root: project.repo_root, commits, xells: anchors };
}

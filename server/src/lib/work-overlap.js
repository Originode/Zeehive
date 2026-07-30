// IS SOMEBODY ALREADY IN THIS WORK? — the advisory nobody could answer at dispatch (ticket #33).
//
// THE FAILURE: two zees built the same migration-number guard, on the ticket about two zees taking the
// same migration number, in the same hour. Neither could see the other — a cxell reads its own worktree
// and nothing else — and the manager who dispatched the second one could not either: the board shows
// zees deployed THROUGH the work tracker, and a zee dispatched outside it is invisible on it. git only
// caught the collision because both authors happened to create the same test FILENAME; had either named
// it differently, two parallel guards would have landed and nobody would have known.
//
// THE REACH ALREADY EXISTS. `zee migration-number` (lib/migration-numbers.js) reads every live xell's
// worktree to answer "which numbers have siblings written but not landed" — the same question with a
// different noun. This asks it about PATHS and TICKETS.
//
// ADVISORY, AND THAT IS STRUCTURAL, NOT A SETTING. Two zees legitimately touching one file is ordinary
// work; the failure was not knowing. So nothing here can refuse a dispatch, nothing here throws, and
// every failure mode (an unreadable worktree, a git timeout, a project whose repo is gone) degrades to
// FEWER WARNINGS and a note saying so — never to a blocked dispatch. A coordination hint that can stop
// work is worse than the problem it reports.
//
// AND IT DOES NOT WIDEN A WORKER'S REACH. It is called from the MANAGER's dispatch verb and from the
// human console's dispatch route, both of which already see the fleet. No worker-facing verb calls it,
// and a worker learns nothing about another xell through it.
//
// TWO KEYS, because they catch different halves of the same mistake:
//   • PATHS — cheap, and what would have caught tonight's pair (both briefs named
//     server/src/db/migrate.js). Compared against what each live xell's branch has actually CHANGED,
//     which is a fact rather than an intention.
//   • TICKETS — catches the version paths miss: two zees attacking one ticket from different modules,
//     which tonight's pair also was until the filenames happened to collide. Exact when the tracker
//     links the work (work_item.ticket_id → work_item.xell_id); textual otherwise, because the gap this
//     exists to close is precisely the dispatch that never went through the tracker.
import { spawnSync } from 'node:child_process';
import { q, one } from '../db/pool.js';

// The same liveness rule the dispatch domain already uses (lib/work-assign.js candidatesFor): a
// retired/tearing-down/error/husk xell's branch is history and must never raise a warning about work
// nobody is doing. Fourth place this repo states it; it stays a WHERE clause rather than a hook for the
// reason work-items.js gives — a clause cannot be bypassed by a path nobody has written yet.
const LIVE = `x.status NOT IN ('retired','tearing-down','error','husk')`;

// ── what a brief NAMES ────────────────────────────────────────────────────────
// Repo-relative paths, keyed on this repo's own top-level directories so that prose cannot manufacture
// one: "the honeycomb is a canvas" names no file, `web/src/hive/HiveCanvas.jsx` does. Deliberately
// narrow — a false warning teaches a manager to ignore the true one.
const ROOTS = ['server', 'web', 'db', 'test', 'scripts', 'hooks', 'docker', 'docs', 'mcp', 'skill'];
const PATH_RE = new RegExp(`\\b(?:${ROOTS.join('|')})/[A-Za-z0-9_./-]*[A-Za-z0-9_]`, 'g');

export function pathsIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(PATH_RE)) {
    // strip trailing punctuation a sentence leaves behind, and anything that ended up as a bare dir
    const p = m[0].replace(/[.,;:)\]`'"]+$/, '');
    if (p.includes('/')) out.add(p);
  }
  return [...out];
}

// TKT-24-BC1A / TKT-24, and the form a brief written by a human uses: "TICKET #9", "ticket 9".
// A BARE "#9" is deliberately not matched: it is a PR, an issue, a line number and a heading as often
// as it is a ticket, and this signal is only worth reading if it is quiet when it has nothing to say.
export function ticketRefsIn(text) {
  const s = String(text || '');
  const numbers = new Set();
  for (const m of s.matchAll(/\bTKT-(\d+)(?:-[A-Za-z0-9]+)?/g)) numbers.add(Number(m[1]));
  for (const m of s.matchAll(/\bticket\s*#?\s*(\d+)/gi)) numbers.add(Number(m[1]));
  return [...numbers].sort((a, b) => a - b);
}

// ── what a live xell is actually IN ───────────────────────────────────────────
const git = (repoRoot, args, timeout) => spawnSync('git', ['-C', repoRoot, ...args],
  { encoding: 'utf8', timeout, windowsHide: true });

// The files a branch has changed relative to the trunk — three dots, so a trunk that has moved on does
// not make every landed file look like this xell's work. Tolerant by design: an unreadable repo, a
// branch that no longer exists or a git that takes too long contributes NOTHING and says so, because a
// hole in this answer must never look like "nobody is in there".
export function changedFiles(repoRoot, base, branch, { timeoutMs = 4000 } = {}) {
  if (!repoRoot || !base || !branch) return null;
  const r = git(repoRoot, ['diff', '--name-only', `${base}...${branch}`], timeoutMs);
  if (r.error || r.status !== 0) return null;
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

// ── the check ─────────────────────────────────────────────────────────────────
// Returns { warnings, checked, degraded } and NEVER throws. `warnings` is empty for a clean dispatch —
// silence is the normal answer and the whole reason the noisy cases are worth reading.
export async function overlapForBrief({ projectId, brief = '', excludeXellId = null,
                                       gitTimeoutMs = 4000, budgetMs = 2500 } = {}) {
  const empty = { warnings: [], checked: { xells: 0, paths: [], tickets: [] }, degraded: [] };
  if (!projectId) return empty;
  const started = Date.now();
  const paths = pathsIn(brief);
  const tickets = ticketRefsIn(brief);
  if (!paths.length && !tickets.length) {
    return { ...empty, checked: { xells: 0, paths, tickets } };
  }
  try {
    const project = await one(`SELECT id, repo_root, main_branch FROM project WHERE id=$1`, [projectId]);
    const rows = await q(
      `SELECT x.id, x.slug, x.branch, x.status,
              (SELECT t.prompt_text FROM task t WHERE t.xell_id = x.id
                 ORDER BY t.created_at DESC LIMIT 1) AS brief,
              (SELECT z.title FROM zee z WHERE z.xell_id = x.id
                 ORDER BY z.created_at DESC LIMIT 1) AS title,
              (SELECT jsonb_agg(jsonb_build_object('id', wi.id, 'title', wi.title,
                                                   'ticket', tk.number))
                 FROM work_item wi LEFT JOIN ticket tk ON tk.id = wi.ticket_id
                WHERE wi.xell_id = x.id AND wi.status <> 'done') AS items
         FROM xell x
        WHERE x.project_id = $1 AND ${LIVE} AND NOT x.is_production
          AND COALESCE(x.zee_type,'worker') <> 'manager'
          AND ($2::uuid IS NULL OR x.id <> $2::uuid)
        ORDER BY x.created_at`, [projectId, excludeXellId]);

    const warnings = [];
    const degraded = [];
    const base = project?.main_branch || 'main';
    for (const x of rows) {
      // TICKET overlap: the tracker's link first (a fact), then the xell's own brief (the dispatch that
      // never went through the tracker — the gap this exists to close).
      const theirTickets = new Set([
        ...((x.items || []).map((i) => i.ticket).filter((n) => n != null)),
        ...ticketRefsIn(x.brief),
      ]);
      const sharedTickets = tickets.filter((n) => theirTickets.has(n));
      if (sharedTickets.length) {
        const item = (x.items || []).find((i) => sharedTickets.includes(i.ticket));
        warnings.push({ kind: 'ticket', xell_slug: x.slug, xell_id: x.id, tickets: sharedTickets,
          via: item ? 'work item' : 'its brief',
          detail: item ? `on work item "${item.title}"` : `its own brief names ticket ${sharedTickets.join(', ')}`,
          title: x.title || null });
      }
      // PATH overlap: what its branch has actually changed, plus what its brief said it would touch.
      // Both, because a zee briefed ten minutes ago has changed nothing yet and is still in the work.
      if (paths.length) {
        if (Date.now() - started > budgetMs) {
          degraded.push(`stopped scanning branches after ${budgetMs}ms — ${rows.length} live xell(s) to check`);
          break;
        }
        const changed = changedFiles(project?.repo_root, base, x.branch, { timeoutMs: gitTimeoutMs });
        if (changed == null) degraded.push(`could not read ${x.slug}'s branch (${x.branch})`);
        const theirPaths = new Set([...(changed || []), ...pathsIn(x.brief)]);
        const shared = paths.filter((p) => theirPaths.has(p)
          // a brief naming a directory covers the files under it, and vice versa
          || [...theirPaths].some((t) => t.startsWith(`${p}/`) || p.startsWith(`${t}/`)));
        if (shared.length) {
          warnings.push({ kind: 'path', xell_slug: x.slug, xell_id: x.id, paths: shared.slice(0, 6),
            more: Math.max(0, shared.length - 6),
            via: changed && changed.some((c) => shared.includes(c)) ? 'changed on its branch' : 'named in its brief',
            title: x.title || null });
        }
      }
    }
    return { warnings, checked: { xells: rows.length, paths, tickets }, degraded,
             took_ms: Date.now() - started };
  } catch (e) {
    // A coordination hint must never be the reason a dispatch fails. Say it went wrong and hand back
    // nothing rather than throwing into the caller's path.
    return { ...empty, checked: { xells: 0, paths, tickets }, degraded: [`overlap check failed: ${e.message}`] };
  }
}

// One paragraph a manager (or a human) reads at the moment of the decision. Null when there is nothing
// to say — the caller appends it or does not, and a clean dispatch reads exactly as it always has.
export function overlapNote(overlap) {
  const ws = overlap?.warnings || [];
  if (!ws.length) return null;
  const byXell = new Map();
  for (const w of ws) {
    if (!byXell.has(w.xell_slug)) byXell.set(w.xell_slug, []);
    byXell.get(w.xell_slug).push(w);
  }
  const lines = [`⚠ ${byXell.size} live xell(s) may already be in this work — this is INFORMATION, not a refusal:`];
  for (const [slug, list] of byXell) {
    const t = list.find((w) => w.kind === 'ticket');
    const p = list.find((w) => w.kind === 'path');
    const bits = [];
    if (t) bits.push(`ticket ${t.tickets.join(', ')} (${t.detail})`);
    if (p) bits.push(`${p.paths.join(', ')}${p.more ? ` +${p.more} more` : ''} (${p.via})`);
    lines.push(`  · ${slug}${list[0].title ? ` — "${list[0].title}"` : ''}: ${bits.join('; ')}`);
  }
  lines.push('Two zees on one file is ordinary; two zees on one PROBLEM is a duplicate nobody sees until '
    + 'it lands. Decide with that in front of you: re-brief this one to a different part, talk to the '
    + 'other xell (`zee say`), or carry on knowingly.');
  if (overlap.degraded?.length) {
    lines.push(`(partial answer: ${overlap.degraded.join('; ')} — so this list may be short, never long.)`);
  }
  return lines.join('\n');
}

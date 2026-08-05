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
// AND IT ALSO ANSWERS "IS IT ALREADY DONE?" (ticket #64). The check above reads the FLEET, which only
// knows who is still holding the work; a xell that finished, landed and was reaped is invisible to
// every one of those queries. A manager read a lagging status row, believed the reviewer on it was
// inert, and cut a fresh worker for seven findings that were already on main — a whole xell
// (provisioned, briefed, containers built, database cloned) to re-prove finished work. The fact was in
// the database the entire time: the LAND LEDGER. So the same block now carries what has already landed
// on this work, keyed the same two ways plus the tracker's own link.
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

// ── what has already LANDED on this work (#64) ────────────────────────────────
// Bounds, stated once and used everywhere below. This runs on EVERY dispatch, and one of the ways a
// coordination hint fails is by making the thing it advises slow: there is no unbounded log walk here.
const LANDED_CAP = 5;            // landings a warning block names — a handful, most recent first
const LANDED_WINDOW_DAYS = 14;   // how far back the path scan looks
const LANDED_SCAN = 25;          // landings read for the path scan
const LANDED_DIFFS = 8;          // git diffs it will run — the rest is history, not "was this just done"

// For a manager reading one line at the moment of the decision: "41 min ago" answers "is this the work
// I am about to cut?" in a way a timestamp does not. Local because this is a display detail of this
// warning; queenzee/reaper.js has its own for its own sentences.
const agoText = (ts) => {
  if (!ts) return 'at an unknown time';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)} days ago`;
};

const short = (sha) => String(sha || '').slice(0, 8);

// The landings the TRACKER links to this work: the item being cut, and every item under the same
// ticket. Three sources for the xell, because one link is not durable — `work_item.xell_id` is the
// CURRENT assignment and an unassign clears it (and the task stamp with it), so the ledger's own
// `assigned` events are what still name the zee that did the work weeks later. Exact rather than
// textual, so this half has no time window: a landing on this ticket is a landing on this ticket.
async function trackerLandings(projectId, workItemId, tickets, cap) {
  return q(
    `SELECT * FROM (
     WITH items AS (
       SELECT wi.id, wi.title, tk.number AS ticket
         FROM work_item wi LEFT JOIN ticket tk ON tk.id = wi.ticket_id
        WHERE wi.project_id = $1
          AND (($2::uuid IS NOT NULL AND wi.id = $2::uuid) OR tk.number = ANY($3::int[]))
     ), owners AS (
       SELECT i.id AS item_id, i.title, i.ticket, wi.xell_id
         FROM items i JOIN work_item wi ON wi.id = i.id WHERE wi.xell_id IS NOT NULL
       UNION
       SELECT i.id, i.title, i.ticket, t.xell_id
         FROM items i JOIN task t ON t.work_item_id = i.id WHERE t.xell_id IS NOT NULL
       UNION
       SELECT i.id, i.title, i.ticket, (e.detail->>'xell_id')::uuid
         FROM items i JOIN work_item_event e ON e.work_item_id = i.id
        WHERE e.kind = 'assigned'
          AND e.detail->>'xell_id' ~ '^[0-9a-fA-F-]{36}$'
     )
     -- ONE row per landing (a xell can reach the same sha through several of the links above), and the
     -- row kept is the one that says the most: THIS item beats a sibling under the same ticket.
     SELECT DISTINCT ON (l.new_sha)
            l.new_sha, l.landed_at, l.commits, o.item_id, o.title AS item_title, o.ticket,
            x.slug AS xell_slug, x.id AS xell_id,
            ($2::uuid IS NOT NULL AND o.item_id = $2::uuid) AS same_item
       FROM owners o
       JOIN land_request l ON l.xell_id = o.xell_id AND l.status = 'landed' AND l.project_id = $1
       LEFT JOIN xell x ON x.id = o.xell_id
      ORDER BY l.new_sha, (o.item_id = $2::uuid) DESC NULLS LAST, l.landed_at DESC NULLS LAST
     ) landings
      ORDER BY landings.landed_at DESC NULLS LAST
      LIMIT $4`, [projectId, workItemId, tickets, cap]);
}

// …and the landings the tracker does NOT link, which is the gap that cost the xell: a zee dispatched
// outside the work tracker is on no card, so its BRIEF is the only thing that says which ticket it was
// about — the same fallback the live half already makes. Windowed and capped, because this one is a
// scan rather than a lookup.
async function recentLandings(projectId, windowDays, cap) {
  return q(
    `SELECT l.id, l.new_sha, l.old_sha, l.landed_at, x.id AS xell_id, x.slug AS xell_slug,
            (SELECT t.prompt_text FROM task t WHERE t.xell_id = x.id
               ORDER BY t.created_at DESC LIMIT 1) AS brief
       FROM land_request l LEFT JOIN xell x ON x.id = l.xell_id
      WHERE l.project_id = $1 AND l.status = 'landed'
        AND l.landed_at > now() - ($2 * INTERVAL '1 day')
      ORDER BY l.landed_at DESC
      LIMIT $3`, [projectId, windowDays, cap]);
}

// The subject a manager can recognise, out of the commits the gate recorded. Newest first is how the
// ledger stores them, and one line is all a warning has room for.
const firstSubject = (commits) => {
  const list = Array.isArray(commits) ? commits : [];
  const s = list.find((c) => c && c.subject)?.subject;
  return s ? String(s).slice(0, 80) : null;
};

// ── the check ─────────────────────────────────────────────────────────────────
// Returns { warnings, checked, degraded } and NEVER throws. `warnings` is empty for a clean dispatch —
// silence is the normal answer and the whole reason the noisy cases are worth reading.
export async function overlapForBrief({ projectId, brief = '', excludeXellId = null, workItemId = null,
                                       gitTimeoutMs = 4000, budgetMs = 2500,
                                       landedWindowDays = LANDED_WINDOW_DAYS,
                                       landedCap = LANDED_CAP } = {}) {
  const empty = { warnings: [], checked: { xells: 0, paths: [], tickets: [], landings: 0 }, degraded: [] };
  if (!projectId) return empty;
  const started = Date.now();
  const paths = pathsIn(brief);
  const tickets = ticketRefsIn(brief);
  // A deploy from the board carries the item itself, and that is a stronger key than anything in the
  // prose: briefForWorkItem writes the ticket as a bare "(#64)", which ticketRefsIn deliberately does
  // not read. Without this, `zee assign` — the verb that cuts a worker for a CARD — has no key at all.
  if (!paths.length && !tickets.length && !workItemId) {
    return { ...empty, checked: { xells: 0, paths, tickets, landings: 0 } };
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

    // ── and what has already LANDED on it (#64) ──────────────────────────────
    // Same block, same rules: read-only, capped, and it can only ADD warnings. Each half is wrapped on
    // its own so that the land ledger going wrong costs the landed warnings and not the live ones —
    // "nobody is in this work" is exactly the false answer this ticket exists to stop.
    const seenSha = new Set();
    let scanned = 0;
    if (workItemId || tickets.length) {
      try {
        for (const l of await trackerLandings(projectId, workItemId, tickets, landedCap)) {
          if (seenSha.has(l.new_sha)) continue;
          seenSha.add(l.new_sha);
          warnings.push({ kind: 'landed', sha: l.new_sha, short: short(l.new_sha),
            landed_at: l.landed_at, ago: agoText(l.landed_at),
            xell_slug: l.xell_slug || null, xell_id: l.xell_id || null,
            via: l.same_item ? 'work item' : 'ticket',
            tickets: l.ticket != null ? [l.ticket] : [],
            item: l.item_title || null,
            detail: l.same_item ? 'linked to THIS work item'
              : `linked to this ticket${l.ticket != null ? ` (#${l.ticket})` : ''}`,
            subject: firstSubject(l.commits) });
        }
      } catch (e) { degraded.push(`could not read the land ledger for this item/ticket: ${e.message}`); }
    }
    if (tickets.length || paths.length) {
      try {
        const recent = await recentLandings(projectId, landedWindowDays, LANDED_SCAN);
        scanned = recent.length;
        let diffs = 0;
        for (const l of recent) {
          if (seenSha.has(l.new_sha)) continue;
          // TICKET, from the landing zee's own brief — the dispatch that never went through the tracker.
          const theirs = ticketRefsIn(l.brief);
          const sharedTickets = tickets.filter((n) => theirs.includes(n));
          if (sharedTickets.length) {
            seenSha.add(l.new_sha);
            warnings.push({ kind: 'landed', sha: l.new_sha, short: short(l.new_sha),
              landed_at: l.landed_at, ago: agoText(l.landed_at),
              xell_slug: l.xell_slug || null, xell_id: l.xell_id || null,
              via: 'its brief', tickets: sharedTickets, item: null,
              detail: `its own brief named ticket ${sharedTickets.join(', ')}`, subject: null });
            continue;
          }
          // PATHS the landing actually touched. The ledger records the pushed range and the FILES are
          // in git, so this costs a diff each — hence the caps and the shared budget. A landing whose
          // range cannot be read contributes nothing and says so, never a silent "nothing landed here".
          if (!paths.length || !l.old_sha || /^0+$/.test(l.old_sha)) continue;
          if (diffs >= LANDED_DIFFS || Date.now() - started > budgetMs) {
            degraded.push(`only the ${diffs} most recent landing(s) were read for file overlap`
              + ` (of ${recent.length} in the last ${landedWindowDays} days)`);
            break;
          }
          diffs++;
          const files = changedFiles(project?.repo_root, l.old_sha, l.new_sha, { timeoutMs: gitTimeoutMs });
          if (files == null) { degraded.push(`could not read what ${short(l.new_sha)} changed`); continue; }
          const shared = paths.filter((p) => files.includes(p)
            || files.some((f) => f.startsWith(`${p}/`) || p.startsWith(`${f}/`)));
          if (!shared.length) continue;
          seenSha.add(l.new_sha);
          warnings.push({ kind: 'landed-path', sha: l.new_sha, short: short(l.new_sha),
            landed_at: l.landed_at, ago: agoText(l.landed_at),
            xell_slug: l.xell_slug || null, xell_id: l.xell_id || null,
            paths: shared.slice(0, 6), more: Math.max(0, shared.length - 6),
            via: 'changed by that landing', subject: firstSubject(l.commits) });
          if (warnings.filter((w) => w.kind === 'landed-path').length >= landedCap) break;
        }
      } catch (e) { degraded.push(`could not scan recent landings: ${e.message}`); }
    }

    return { warnings, checked: { xells: rows.length, paths, tickets, landings: scanned }, degraded,
             took_ms: Date.now() - started };
  } catch (e) {
    // A coordination hint must never be the reason a dispatch fails. Say it went wrong and hand back
    // nothing rather than throwing into the caller's path.
    return { ...empty, checked: { xells: 0, paths, tickets, landings: 0 },
             degraded: [`overlap check failed: ${e.message}`] };
  }
}

// One paragraph a manager (or a human) reads at the moment of the decision. Null when there is nothing
// to say — the caller appends it or does not, and a clean dispatch reads exactly as it always has.
export function overlapNote(overlap) {
  const ws = overlap?.warnings || [];
  if (!ws.length) return null;
  // Two families, and they are read differently: WHO IS IN IT (talk to them) versus WHAT IS ALREADY
  // DONE (read the sha before you brief anyone). One list mixing the two puts a retired xell's landing
  // under a "live xell" heading, which is the wrong instruction on the right fact.
  const live = ws.filter((w) => w.kind === 'ticket' || w.kind === 'path');
  const landed = ws.filter((w) => w.kind === 'landed' || w.kind === 'landed-path');
  const lines = [];
  const byXell = new Map();
  for (const w of live) {
    if (!byXell.has(w.xell_slug)) byXell.set(w.xell_slug, []);
    byXell.get(w.xell_slug).push(w);
  }
  if (byXell.size) {
    lines.push(`⚠ ${byXell.size} live xell(s) may already be in this work — this is INFORMATION, not a refusal:`);
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
  }
  if (landed.length) {
    if (lines.length) lines.push('');
    lines.push(`⚠ ${landed.length} landing(s) on main are already in this work — this is INFORMATION, not a refusal:`);
    for (const w of landed) {
      const from = w.xell_slug ? ` from ${w.xell_slug}` : '';
      const why = w.kind === 'landed'
        ? w.detail
        : `it changed ${w.paths.join(', ')}${w.more ? ` +${w.more} more` : ''}`;
      lines.push(`  · ${w.short} landed ${w.ago}${from}, ${why}`
        + (w.subject ? ` — "${w.subject}"` : ''));
    }
    lines.push('Re-cutting landed work is sometimes deliberate — a revert, a second pass, a review — and '
      + 'that is your call. Just do not make it blind: `git show <sha>` says what is already on main, so '
      + 'a worker is never spent re-proving it.');
  }
  // A warning of a kind this note does not render must not produce a note that is only a footnote.
  if (!lines.length) return null;
  if (overlap.degraded?.length) {
    lines.push(`(partial answer: ${overlap.degraded.join('; ')} — so this list may be short, never long.)`);
  }
  return lines.join('\n');
}

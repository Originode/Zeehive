// SHIP PAYLOAD (ticket #65) — THE COMMITS A SHIP CARRIES, NAMED.
//
// The ship confirmation already warns that a deploy carries every landing on main, not only the
// requester's — and never says which. This module closes that: given a ship_request, it computes
// the commits between the last SHIPPED commit for the same target (project + prod site) and the
// one being deployed, and attributes each to the landing that carried it (land_request), so the
// card can say "12 commits from 5 xells; 3 of them are yours" — and name each one.
//
// The data is all in land_request and ship_request already; nothing new is recorded. This is the
// CODE half of the migration list (ticket #12) and is deliberately separate from the ship
// pre-flight (ticket #58): a pre-flight checks PRECONDITIONS, this shows the PAYLOAD.
//
// DEGRADE, NEVER BLOCK — the same contract as ship-preflight.js and work-overlap.js: this is an
// ADVISORY read that must never be the reason a ship cannot be raised (or approved). Every failure
// path returns { ok:false, error } so the card says "payload could not be read", and the ship
// gate's own guards stay the backstop. computeShipPayload never throws.
import { spawnSync } from 'node:child_process';
import { q } from '../db/pool.js';
import { cleanGitEnv, isAncestor } from '../lib/git.js';

const SEP = '\x1f';

// The commits a ship will take live that prod is not running: git log from the last SHIPPED
// commit for the same target to the ship's commit, newest first. Returns null on git failure
// (the caller degrades) — never an empty array that could read as "no payload".
function rangeCommits(repoRoot, from, to) {
  const r = spawnSync('git', ['-C', repoRoot, 'log',
    `--pretty=format:%H${SEP}%h${SEP}%s${SEP}%an${SEP}%aI`,
    `${from}..${to}`],
    { encoding: 'utf8', timeout: 15000, windowsHide: true, env: cleanGitEnv() });
  if (r.status !== 0) return null;
  return (r.stdout || '').split('\n').filter(Boolean).map((line) => {
    const [sha, short, subject, author, date] = line.split(SEP);
    return { sha, short, subject, author, date };
  });
}

// The completed ships for one target (project + site), newest FIRST. The single definition of "what
// production has been given", shared by the payload's "before" (which then picks the newest ANCESTOR
// of the ship being described) and by the direction guard's "what is live NOW" (which must take the
// newest row, ancestor or not — that difference IS the backwards ship). One query so the two
// readers can never disagree about what a completed ship is.
function shippedHistory(projectId, siteId, excludeId, limit = 20) {
  return q(
    `SELECT id, commit, finished_at FROM ship_request
      WHERE project_id=$1 AND status='shipped' AND site_id IS NOT DISTINCT FROM $2 AND id <> $3
      ORDER BY finished_at DESC NULLS LAST LIMIT $4`,
    [projectId, siteId || null, excludeId || null, limit]);
}

// WHAT PRODUCTION IS RUNNING for a target: the most recently COMPLETED ship for the same project +
// site, whatever its ancestry. Returns { id, commit, finished_at } or null when nothing has ever
// shipped there. THROWS on a db failure — the direction guard turns that into "unknown" itself, and
// a swallowed error here would read as "nothing is live", which is the one answer that must never be
// invented (it would wave a backwards ship straight through).
export async function deployedCommitForTarget(projectId, { siteId = null, excludeShipId = null } = {}) {
  const rows = await shippedHistory(projectId, siteId, excludeShipId, 1);
  return rows[0] || null;
}

// The last ship that actually COMPLETED for the same target (project + site), excluding this one.
// Ships are serialized per site by the prod lock, so the latest completed ship is almost always
// the right "before"; the ancestry check guards the odd orderings (a deferred ship re-aimed past a
// newer ship, a re-ship of the same sha). Returns null when there is no previous ship — the
// FIRST ship to this target, whose payload is the whole history (a note, not a list).
//
// The caller verifies the repo is READABLE before trusting a null here: an unreadable repo must
// degrade (ok:false), never read as "first ship".
async function lastShippedForTarget(project, req, { limit = 20 } = {}) {
  const rows = await shippedHistory(project.id, req.site_id || null, req.id, limit);
  for (const r of rows) {
    // isAncestor(a, b) is true for a === b too, so a re-ship of the same sha correctly reads as
    // "nothing new since prod already runs this exact commit".
    if (r.commit && isAncestor(project.repo_root, r.commit, req.commit)) return r;
  }
  return null;
}

// Attach each payload commit to the landing that carried it, and to that landing's xell's current
// work item/ticket. A landing's sha is often a SYNC MERGE, not the feature — the merge's diffstat
// is full of other people's files — so we attribute by the LAND_REQUEST record (who pushed it to
// main), never by the commit's author or diffstat.
async function attributeLandings(projectId, commits) {
  const shas = commits.map((c) => c.sha);
  const landings = await q(
    `SELECT DISTINCT ON (lr.id)
            lr.id, lr.new_sha, lr.commits, lr.landed_at, lr.decided_at, lr.xell_id,
            x.slug AS xell_slug,
            wi.id AS work_item_id, wi.title AS work_item_title,
            t.id AS ticket_id, t.number AS ticket_number, t.title AS ticket_title
       FROM land_request lr
       LEFT JOIN xell x ON x.id = lr.xell_id
       LEFT JOIN work_item wi ON lr.xell_id IS NOT NULL AND wi.xell_id = lr.xell_id
       LEFT JOIN ticket t ON t.id = wi.ticket_id
      WHERE lr.project_id=$1 AND lr.status='landed' AND lr.new_sha = ANY($2::text[])
      ORDER BY lr.id, wi.created_at DESC NULLS LAST`,
    [projectId, shas]);

  return commits.map((c) => {
    // A commit is in exactly one landing's old..new range (main is forward-only); match by the
    // short-sha prefix the landing recorded, which stays correct even when git's abbreviation
    // length has grown since the landing was recorded.
    let hit = null;
    for (const l of landings) {
      const arr = Array.isArray(l.commits) ? l.commits : [];
      if (arr.some((e) => e && e.short && c.sha.startsWith(e.short))) { hit = l; break; }
    }
    if (!hit) {
      return { ...c, landed_at: null, xell_id: null, xell_slug: null, work_item: null, ticket: null,
               unattributed: true };
    }
    return {
      ...c,
      landed_at: hit.landed_at || hit.decided_at || null,
      xell_id: hit.xell_id,
      xell_slug: hit.xell_slug || null,
      work_item: hit.work_item_id ? { id: hit.work_item_id, title: hit.work_item_title } : null,
      ticket: hit.ticket_id
        ? { id: hit.ticket_id, number: hit.ticket_number, title: hit.ticket_title }
        : null,
    };
  });
}

// The recorded review verdicts for a set of commit shas (ticket #56) — sha → review rows, newest
// first. The auto-approve gate (ticket #79) reads whether a commit has a review at all, and the
// card renders the verdicts. THROWS on a db error: the caller decides whether that degrades the
// payload (advisory) or withholds the gate — the point is it must never read as "reviewed".
async function reviewsForCommits(projectId, shas) {
  if (!shas?.length) return new Map();
  const rows = await q(
    `SELECT commit_sha, reviewer, verdict::text AS verdict, findings_count, report, created_at
       FROM review WHERE project_id=$1 AND commit_sha = ANY($2::text[])
       ORDER BY created_at DESC`,
    [projectId, shas]);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.commit_sha)) map.set(r.commit_sha, []);
    map.get(r.commit_sha).push(r);
  }
  return map;
}

// The whole payload for one ship request. NEVER throws — an advisory read must not be a new way
// for the ship gate to break (ship-preflight.js, work-overlap.js). Every failure returns
// { ok:false, error } so the card says "could not be read", in words.
//
// Each payload commit is annotated with whether a REVIEW was recorded for it (ticket #56 → #79):
//   • reviewed: true  → at least one review row exists for that sha;
//   • reviewed: false → the sha is enumerated but NO review was recorded — the auto-approve gate
//                       must hold (a ship may auto-approve only when every commit it carries has
//                       a recorded review verdict);
//   • reviewed: null  → the review record could NOT be read (a db failure). This is the inverse
//                       failure this module was taught twice tonight in ship-preflight.js and
//                       managers.js: unmeasurable must never mean "all reviewed". It is a
//                       deliberate third state, never a silent false.
// `reviewQuery` is a DI seam so tests can prove the unmeasurable case by making the lookup throw.
export async function computeShipPayload(project, req, { reviewQuery = reviewsForCommits } = {}) {
  try {
    if (!project?.repo_root) return { ok: false, error: 'project has no repo_root' };
    if (!req?.commit) return { ok: false, error: 'ship request has no commit' };

    // The repo must be readable BEFORE any "no previous ship" verdict: an unreadable repo would
    // make lastShippedForTarget's ancestry check fail for every row and read as a FIRST ship —
    // a lie. Verify the ship's own commit resolves, so an unreadable/garbage repo degrades
    // (ok:false) instead of misreading.
    const resolve = spawnSync('git', ['-C', project.repo_root, 'rev-parse', '--verify',
      `${req.commit}^{commit}`],
      { encoding: 'utf8', timeout: 15000, windowsHide: true, env: cleanGitEnv() });
    if (resolve.status !== 0) {
      return { ok: false, error: `could not resolve the ship's commit ${String(req.commit).slice(0, 8)} in the repo` };
    }

    const from = await lastShippedForTarget(project, req);
    if (!from) {
      return { ok: true, from: null, to: req.commit, commits: [],
               summary: { commits: 0, xells: 0, yours: 0 },
               note: 'first ship to this target — no previous shipped sha, so the whole history rides along' };
    }

    const commits = rangeCommits(project.repo_root, from.commit, req.commit);
    if (!commits) {
      return { ok: false,
               error: `could not read the commit range ${String(from.commit).slice(0, 8)}..${String(req.commit).slice(0, 8)}` };
    }
    if (!commits.length) {
      return { ok: true, from: from.commit, to: req.commit, commits: [],
               summary: { commits: 0, xells: 0, yours: 0 },
               note: 'nothing new since the last ship to this target — prod already runs this commit' };
    }

    const payload = await attributeLandings(project.id, commits);
    const xellIds = new Set(payload.filter((c) => c.xell_id).map((c) => c.xell_id));
    const yours = payload.filter((c) => c.xell_id === req.xell_id).length;

    // THE REVIEW RECORD (ticket #56 → gate #79). Every commit the ship carries is checked for a
    // recorded review verdict; the auto-approve policy reads `reviewed` and refuses to auto-deploy
    // unread code. This lookup is INSIDE the never-throws contract, but unlike the range it is the
    // gate, so a failure marks the review state UNKNOWN (reviewed=null), never "all reviewed" —
    // unmeasurable must never mean yes.
    let reviewError = null;
    try {
      const reviews = await reviewQuery(project.id, payload.map((c) => c.sha));
      for (const c of payload) {
        const rs = reviews.get(c.sha) || [];
        c.reviewed = rs.length > 0;
        c.reviews = rs;
      }
    } catch (e) {
      reviewError = e.message || String(e);
      for (const c of payload) {
        c.reviewed = null;
        c.reviews = [];
      }
    }
    const unknownCount = reviewError ? payload.length : 0;
    const unread = reviewError ? 0 : payload.filter((c) => !c.reviewed).length;
    return {
      ok: true,
      from: from.commit,
      to: req.commit,
      commits: payload,
      summary: {
        commits: payload.length,
        xells: xellIds.size,
        yours,
        unread,
        unknown: unknownCount,
        review_error: reviewError,
      },
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// The one-line summary phrase the card and the CLI answer both use — "12 commits from 5 xells;
// 3 of them are yours" (the ticket's example). Built here so the two surfaces cannot disagree.
export function shipPayloadSummary(payload, requesterSlug = null) {
  if (!payload || payload.ok === false) {
    return `payload could not be read${payload?.error ? ` — ${payload.error}` : ''}`;
  }
  if (payload.note) return payload.note;
  const s = payload.summary || { commits: 0, xells: 0, yours: 0 };
  const yours = s.yours > 0
    ? `; ${s.yours} ${s.yours === 1 ? 'is' : 'are'} ${requesterSlug ? requesterSlug + "'s" : 'yours'}`
    : '';
  // The review gate (ticket #79): the summary says how many of the carried commits have NO
  // recorded review — the number a policy auto-approve refuses to ignore. `unknown` > 0 means the
  // review record itself could not be read, which is even stronger: unmeasurable must not read as
  // reviewed. Rendered for the human on the card, and for the zee in the CLI answer.
  const unread = Number(s.unknown) > 0
    ? `; ${s.unknown} with an UNREADABLE review record`
    : Number(s.unread) > 0
      ? `; ${s.unread} unread`
      : '';
  return `${s.commits} commit${s.commits === 1 ? '' : 's'} from ${s.xells} xell${s.xells === 1 ? '' : 's'} `
    + `since the last ship to this target${yours}${unread}`;
}

// THE AUTO-APPROVE REVIEW GATE (ticket #79) — a ship may auto-approve only if every commit it
// carries has a recorded review verdict (ticket #56) or a human approves it explicitly. This is
// the POLICY half of that gate: given a payload, does auto-approve fire? It is a pure function of
// the payload so it can be pinned by a unit test without a database.
//
// The direction of safety is the OPPOSITE of this module's advisory reads: the payload display
// degrades to "could not be read" and lets the ask through; THIS gate withholds on unmeasurable.
// The cost of a wrong "yes" is unread code reaching PRODUCTION, so every way the answer can be
// unclear — the payload could not be read, the review record could not be read, a first ship whose
// whole history rides along unenumerated, or commits that were simply never reviewed — resolves to
// { allowed:false } with the reason said out loud, and the human's manual path stays open.
export function shipAutoApproveVerdict(payload) {
  if (!payload || payload.ok === false) {
    return { allowed: false,
      reason: `the payload could not be read — auto-approve is withheld`
        + (payload?.error ? ` (${payload.error})` : '')
        + '. A human can still ship it manually.' };
  }
  if (payload.note && /first ship to this target/.test(payload.note)) {
    return { allowed: false,
      reason: 'first ship to this target — no previous shipped sha, so the whole history rides along '
        + 'and none of it has a verifiable recorded review. A human must approve it manually.' };
  }
  if (!payload.commits?.length) {
    // nothing new since the last ship — there are no commits to be unread, so the gate passes.
    return { allowed: true };
  }
  const unknown = payload.commits.filter((c) => c.reviewed === null);
  if (unknown.length) {
    const err = payload.summary?.review_error || 'the review record could not be read';
    return { allowed: false,
      reason: `${unknown.length} commit(s) have an UNREADABLE review record — unmeasurable must never `
        + `mean "reviewed", so auto-approve is withheld (${err}). A human can still ship it manually.` };
  }
  const unread = payload.commits.filter((c) => !c.reviewed);
  if (unread.length) {
    return { allowed: false,
      reason: `${unread.length} commit(s) have no recorded review: `
        + unread.map((c) => `${c.short || String(c.sha).slice(0, 8)} (landed by ${c.xell_slug || 'unknown'})`).join(', ')
        + '. A human can still ship it manually — or cast a dev-reviewer to read the unread commits.' };
  }
  return { allowed: true };
}

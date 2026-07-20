// PUSH / PULL / PR — the three things a human can do to a xell's git state from the console.
//
// All three are about ONE relationship: a xell and its XOURCE, the thing it tracks. That
// relationship used to have exactly one verb, and it lived in the zee's prompt as an instruction
// ("land locally: git push . HEAD:main"). A human had no way to do it at all — they watched a zee
// be told to do it. These are that verb, plus its two missing siblings, as buttons.
//
// 012 is what makes them general: a xource can BE a xell, so `<xource ref>` is main for a top-level
// xell and spinoff/<parent> for a child. Nothing below hardcodes main.
//
// origin appears nowhere here. It is a backup mirror Mark pushes by hand; the tree is entirely
// local, and a push to `.` is a push into this same repo.
import { spawnSync, spawn } from 'node:child_process';
import { q, one } from '../db/pool.js';
import { broadcast } from '../lib/events.js';
import { logline } from '../lib/logbus.js';
import { cleanGitEnv, worktreeBound } from '../lib/git.js';

function git(cwd, args, timeout = 60000) {
  const r = spawnSync('git', ['-C', cwd, ...args],
    { encoding: 'utf8', timeout, windowsHide: true, env: cleanGitEnv() });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// ASYNC git — for the ONE call that MUST NOT block the event loop: the `git push` to a xource whose
// `update` hook curls BACK into this very server (hooks/land-gate-update.sh → POST /api/land/check).
// spawnSync there is a self-deadlock: the queenzee is single-threaded, so a synchronous push freezes
// the loop while git waits on the hook — and the hook's curl can't be served until the push returns.
// It never does; curl times out (rc=28), the hook fails CLOSED, and the push is declined with NO
// land_request raised. That is a second, quieter cause of "I landed but nothing was raised" (the
// first being the non-fast-forward the catch-up now fixes). landApproved sidesteps it with
// update-ref; a genuine gated PUSH cannot, so it must run async and leave the loop free for the hook.
function gitAsyncPush(cwd, args, timeout = 60000) {
  return new Promise((resolve) => {
    const p = spawn('git', ['-C', cwd, ...args], { windowsHide: true, env: cleanGitEnv() });
    let out = '', err = '';
    const t = setTimeout(() => p.kill(), timeout);
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', (e) => { clearTimeout(t); resolve({ ok: false, out: out.trim(), err: (err + e.message).trim() }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, out: out.trim(), err: err.trim() }); });
  });
}

// A xell, its xource ref, and — if that xource is itself a xell — the worktree that ref is checked
// out in. That worktree is the difference between "push it" and "merge it": git refuses a push to
// a branch someone has checked out, so a xell-backed xource must be merged from the inside.
async function ctx(xellId) {
  const x = await one(
    `SELECT x.*, xo.ref AS xource_ref, xo.xell_id AS xource_xell_id
       FROM xell x JOIN xource xo ON xo.id = x.xource_id WHERE x.id=$1`, [xellId]);
  if (!x) throw new Error('unknown xell');
  if (x.is_production) throw new Error('production does not push, pull or raise PRs — it is shipped to');
  const project = await one(`SELECT * FROM project WHERE id=$1`, [x.project_id]);
  const parent = x.xource_xell_id
    ? await one(`SELECT id, slug, worktree_path FROM xell WHERE id=$1`, [x.xource_xell_id])
    : null;
  if (!x.worktree_path) throw new Error(`${x.slug} has no worktree on disk`);
  // A de-registered worktree (no .git file) makes `git -C` answer for the PARENT repo — push would
  // then move SOMEONE ELSE'S branch toward the xource, and pull would merge into the xource's
  // checkout. Refuse before any verb runs; nothing done in an unbound directory is this xell's.
  const bind = worktreeBound(x.worktree_path, x.branch);
  if (!bind.bound) {
    throw new Error(
      `${x.slug}'s worktree is no longer bound to ${x.branch} (git there answers `
      + `${bind.actual ? `'${bind.actual}'` : 'nothing'}) — its registration or branch is gone. `
      + 'Refusing every git verb: operating there would act on the xource, not this xell.');
  }
  return { x, project, parent, ref: x.xource_ref, fullRef: `refs/heads/${x.xource_ref}` };
}

const dirtyCount = (wt) => {
  const r = git(wt, ['status', '--porcelain']);
  return r.ok ? r.out.split('\n').filter(Boolean).length : 0;
};

// ── CATCH UP: replay the xell's commits onto the CURRENT xource tip ──────────
// A cxell (or host) zee commits on top of the xource AS IT WAS when it started. The xource moves
// while the zee works, so a straight `git push . HEAD:<ref>` is a NON-fast-forward — and the
// landgate's update hook only ever ADVANCES a ref; a non-ff push is simply declined with nothing
// raised. That is the fleet-burn-tracker bug: the commit diverged, no landing card appeared, yet
// the zee was told "held". The fix is to bring the worktree up to the current tip BEFORE pushing,
// so the push that follows is a real fast-forward the gate can actually hold or land.
//
// Pure git, no DB — takes a worktree and the ref to catch up to. Returns { state, head, base } where
// state is:
//   'up-to-date'     — the worktree already contains the tip (a push is already a ff); nothing done.
//   'fast-forwarded' — the worktree had no commits of its own; advanced it to the tip.
//   'merged'         — merged the tip INTO the zee's branch (a merge commit; a ff now). Kept as a
//                      MERGE, not a rebase, so the branch survives as its own lane on the graph.
//   'conflict'       — the merge hit a real conflict; ABORTED, the worktree left exactly as it was.
//   'no-ref'/'no-head' — the ref or HEAD could not be read (nothing to do safely).
export function catchUpWorktree(worktree, ref) {
  const tipR = git(worktree, ['rev-parse', ref]);
  if (!tipR.ok) return { state: 'no-ref', ref };
  const tip = tipR.out;
  const headR = git(worktree, ['rev-parse', 'HEAD']);
  if (!headR.ok) return { state: 'no-head', ref, base: tip };
  const head = headR.out;

  // Our HEAD already contains the tip → at or ahead of the xource; a push is already a ff.
  if (git(worktree, ['merge-base', '--is-ancestor', tip, head]).ok) {
    return { state: 'up-to-date', head, ref, base: tip };
  }

  // We are about to MOVE the branch (ff or rebase), which git refuses over a dirty tree — and that
  // refusal is what kept wedging `zee land` with "cannot rebase: you have unstaged changes", forcing
  // the cxell zee (which cannot touch the host worktree) to tell a human to `git checkout` by hand.
  // First, tell git to IGNORE file-mode changes here — the recurring wedge is a Windows exec-bit flip
  // (mcp/server.js: 644 in the tree, 755 on checkout) git calls dirty forever; ignoring mode makes it
  // vanish without a stash. Then, for any REAL remaining dirt: a cxell zee's work arrives as COMMITS
  // collected from the cxell, so ANY uncommitted change in the host worktree is local noise — park it
  // in a labelled stash and carry on unattended (recoverable via `git stash list`, never lost).
  git(worktree, ['config', 'core.fileMode', 'false']);
  let stashed = false;
  if (dirtyCount(worktree) > 0) {
    const s = git(worktree, ['stash', 'push', '--include-untracked', '-m',
      'zee-land: stray host-worktree changes parked before catch-up']);
    stashed = s.ok;
    if (!s.ok) {
      // couldn't even stash — don't blunder into a rebase that will half-apply; report honestly.
      return { state: 'conflict', ref, base: tip,
        output: `worktree is dirty and could not be stashed before catch-up:\n${s.out}\n${s.err}`.trim().slice(-1200) };
    }
  }

  // Our HEAD is an ancestor of the tip → we added nothing of our own; just fast-forward to it.
  if (git(worktree, ['merge-base', '--is-ancestor', head, tip]).ok) {
    const m = git(worktree, ['merge', '--ff-only', ref]);
    if (!m.ok) return { state: 'conflict', ref, base: tip, stashed, output: `${m.out}\n${m.err}`.trim().slice(-1200) };
    const h = git(worktree, ['rev-parse', 'HEAD']);
    return { state: 'fast-forwarded', head: h.out, ref, base: tip, stashed };
  }
  // Diverged → MERGE the xource tip INTO our branch (NOT rebase). This is the accountability choice:
  // a merge commit records BOTH parents, so the branch survives as its own coloured LANE in the graph
  // — you can see which branch made which change, exactly like OmniBiz's history. A rebase would
  // replay our commits onto the tip and FLATTEN the lane into the trunk, erasing that. On conflict,
  // ABORT and report — never leave a half-merge behind or fabricate a resolution nobody reviewed.
  // (Any dirty tree was parked in the stash above, so the merge starts clean.)
  const branchName = git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).out || 'work';
  const mg = git(worktree, ['merge', '--no-ff', '--no-edit', ref, '-m', `Merge ${ref} into ${branchName}`], 180000);
  if (!mg.ok) {
    git(worktree, ['merge', '--abort']);
    return { state: 'conflict', ref, base: tip, stashed, output: `${mg.out}\n${mg.err}`.trim().slice(-1200) };
  }
  const h = git(worktree, ['rev-parse', 'HEAD']);
  return { state: 'merged', head: h.out, ref, base: tip, stashed };
}

// DB-aware wrapper: resolve the xell's worktree + xource ref, then catch that worktree up. Same
// binding/guard as every other verb here (a de-registered worktree is refused before any git runs).
export async function catchUpToXource(xellId) {
  const { x, ref } = await ctx(xellId);
  const res = catchUpWorktree(x.worktree_path, ref);
  if (res.state === 'rebased' || res.state === 'fast-forwarded') {
    logline('landgate', `${x.slug} caught up to ${ref} (${res.state} → ${String(res.head).slice(0, 8)})`);
  } else if (res.state === 'conflict') {
    logline('landgate', `${x.slug} could NOT catch up to ${ref} — rebase conflict (aborted, worktree untouched)`);
  }
  return { ...res, ref, slug: x.slug };
}

// ── PUSH: the xell's commits → its xource ────────────────────────────────────
// Deliberately NOT special: this runs the same `git push . HEAD:<ref>` a zee runs, so it hits the
// same update hook and gets held the same way. A human clicking it is not an override — it is the
// same request, raised from a nicer place. If it lands, it is because a human had already approved
// this exact sha; if it does not, the hook's own message says why.
export async function pushToXource(xellId, by = 'human@console') {
  const { x, ref, fullRef } = await ctx(xellId);
  const head = git(x.worktree_path, ['rev-parse', 'HEAD']);
  if (!head.ok) throw new Error('cannot read the xell HEAD');

  logline('landgate', `${by} pushed ${x.slug} → ${ref}`);
  // ASYNC push (see gitAsyncPush): this is the call whose `update` hook curls back into this server,
  // so a synchronous push self-deadlocks and the gate raises nothing.
  const r = await gitAsyncPush(x.worktree_path, ['push', '.', `HEAD:${fullRef}`]);
  const text = `${r.out}\n${r.err}`.trim();
  const landed = r.ok;

  if (landed) {
    await one(`UPDATE xell SET head_commit=$2, last_synced_commit=$2 WHERE id=$1 RETURNING id`,
      [x.id, head.out]);
    broadcast('xell', { id: x.id });
    logline('landgate', `${x.slug} LANDED on ${ref} @ ${head.out.slice(0, 8)}`);
  }
  return { landed, ref, head: head.out, output: text.slice(-2000) };
}

// ── PULL: the xource → the xell's worktree ───────────────────────────────────
// REFUSES on a dirty tree, and that is the whole point of it being a separate check rather than
// letting git decide. git will happily merge over a dirty worktree when the changed files do not
// overlap — so the failure mode is not a clean error, it is a zee's uncommitted work quietly
// entangled with a merge it did not ask for. A human clicking this cannot see what the zee is
// mid-way through; the tree can.
export async function pullFromXource(xellId, by = 'human@console') {
  const { x, ref } = await ctx(xellId);
  const dirty = dirtyCount(x.worktree_path);
  if (dirty > 0) {
    return {
      merged: false, ref, dirty,
      reason: `${x.slug} has ${dirty} uncommitted file(s) — commit or stash them first. Merging `
        + 'over a dirty worktree can entangle a zee\'s in-progress work with the merge.',
    };
  }
  // No fetch: the xource ref is a local branch in this same repo, so the worktree can already see
  // it. "Fetch and merge" is just merge, once origin is out of the picture.
  const r = git(x.worktree_path, ['merge', '--no-edit', ref]);
  const head = git(x.worktree_path, ['rev-parse', 'HEAD']);
  if (r.ok && head.ok) {
    await one(`UPDATE xell SET last_synced_commit=$2 WHERE id=$1 RETURNING id`, [x.id, head.out]);
    broadcast('xell', { id: x.id });
    logline('landgate', `${by} pulled ${ref} into ${x.slug} → ${head.out.slice(0, 8)}`);
  }
  return { merged: r.ok, ref, dirty: 0, head: head.out, output: `${r.out}\n${r.err}`.trim().slice(-2000) };
}

// ── PR: ask the xource to pull the xell in ───────────────────────────────────
// The inversion of push: the xell ASKS, and a human accepts on the XOURCE's card — the side that
// receives the code decides to take it. Same land_request table, same gate, same rule that an
// approval is bound to one exact sha.
export async function requestPullIn(xellId, { by = 'human@console', note = null } = {}) {
  const { x, project, ref, fullRef } = await ctx(xellId);
  const head = git(x.worktree_path, ['rev-parse', 'HEAD']);
  if (!head.ok) throw new Error('cannot read the xell HEAD');

  const dirty = dirtyCount(x.worktree_path);
  if (dirty > 0) {
    return { ok: false, reason: `${dirty} uncommitted file(s) — commit them first, or they will not be in the PR.` };
  }

  const tip = git(project.repo_root, ['rev-parse', fullRef]);
  if (tip.ok && tip.out === head.out) {
    return { ok: false, reason: `${x.slug} has nothing ${ref} does not already have.` };
  }

  const existing = await one(
    `SELECT * FROM land_request
       WHERE project_id=$1 AND xell_id=$2 AND ref=$3 AND new_sha=$4
         AND status IN ('pending','approved')`, [project.id, x.id, fullRef, head.out]);
  if (existing) return { ok: true, request: existing, note: 'this PR is already open' };

  const SEP = '\x1f';
  const log = git(project.repo_root, ['log', `--pretty=format:%h${SEP}%s${SEP}%an`, '-n', '50',
    `${tip.out}..${head.out}`]);
  const commits = log.ok ? log.out.split('\n').filter(Boolean).map((l) => {
    const [short, subject, author] = l.split(SEP);
    return { short, subject, author };
  }) : [];

  const ss = git(project.repo_root, ['diff', '--shortstat', tip.out, head.out]);
  const stat = {
    commits: commits.length,
    files: +(ss.out.match(/(\d+) files? changed/)?.[1] || 0),
    insertions: +(ss.out.match(/(\d+) insertions?/)?.[1] || 0),
    deletions: +(ss.out.match(/(\d+) deletions?/)?.[1] || 0),
  };

  const row = await one(
    `INSERT INTO land_request (project_id, xell_id, ref, old_sha, new_sha, commits, stat, kind, note)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'pull',$8) RETURNING *`,
    [project.id, x.id, fullRef, tip.out || null, head.out,
      JSON.stringify(commits), JSON.stringify(stat), note]);
  broadcast('land', row);
  logline('landgate',
    `PR raised by ${by}: ${x.slug} @ ${head.out.slice(0, 8)} → ${ref} (${commits.length} commit(s)) — `
    + `waiting on a human at ${ref}`);
  return { ok: true, request: row };
}

// ── accept a PR: the xource takes it in ──────────────────────────────────────
// FAST-FORWARD ONLY, and that constraint is what keeps this honest rather than convenient. A real
// merge would create a NEW sha that nobody read, which is exactly what the gate's
// approval-bound-to-a-sha rule exists to prevent. A fast-forward moves the ref to the sha on the
// card — no new commit, nothing unreviewed. If it is not a fast-forward, the answer is "pull
// first", which is the button next to this one.
export async function acceptPullIn(requestId, by = 'human@console') {
  const req = await one(`SELECT * FROM land_request WHERE id=$1`, [requestId]);
  if (!req) throw new Error('no such request');
  if (req.status !== 'pending') throw new Error(`this PR is already ${req.status}`);
  const project = await one(`SELECT * FROM project WHERE id=$1`, [req.project_id]);
  const xell = await one(`SELECT * FROM xell WHERE id=$1`, [req.xell_id]);

  // Re-read the tip: it may have moved since the PR was raised, which is precisely when a stale
  // "it was a fast-forward when I asked" would stop being true.
  const tip = git(project.repo_root, ['rev-parse', req.ref]);
  if (!tip.ok) throw new Error(`cannot read ${req.ref}`);

  const ff = git(project.repo_root, ['merge-base', '--is-ancestor', tip.out, req.new_sha]);
  if (!ff.ok) {
    return {
      ok: false,
      reason: `${req.ref.replace('refs/heads/', '')} has moved on since this PR was raised, so `
        + `taking it in would need a merge commit nobody has read. Pull ${req.ref.replace('refs/heads/', '')} `
        + `into ${xell?.slug || 'the xell'} first, then raise it again.`,
    };
  }

  // Approve BEFORE moving the ref: for a main-backed xource the push below goes through the update
  // hook, which looks for exactly this row. The hook spends it and marks it landed.
  const approved = await one(
    `UPDATE land_request SET status='approved', decided_at=now(), decided_by=$2
       WHERE id=$1 AND status='pending' RETURNING *`, [requestId, by]);
  if (!approved) throw new Error('no such pending request (already decided?)');
  broadcast('land', approved);

  const xource = await one(
    `SELECT xo.*, px.slug AS parent_slug, px.worktree_path AS parent_worktree
       FROM xource xo LEFT JOIN xell px ON px.id = xo.xell_id
       WHERE xo.project_id=$1 AND xo.ref=$2`, [project.id, req.ref.replace('refs/heads/', '')]);

  let landed = false, output = '';

  if (xource?.parent_worktree) {
    // The target branch is checked out in the parent's worktree, so it cannot be pushed to — merge
    // from the inside instead. NOTE this path does NOT pass through the update hook (a merge is not
    // a push): the human clicking accept on the parent's card IS the approval. The gate exists to
    // keep unreviewed commits off main; this is a xell taking work into itself, on purpose.
    const dirty = dirtyCount(xource.parent_worktree);
    if (dirty > 0) {
      await q(`UPDATE land_request SET status='pending', decided_at=NULL, decided_by=NULL WHERE id=$1`, [requestId]);
      return {
        ok: false,
        reason: `${xource.parent_slug} has ${dirty} uncommitted file(s) — it cannot take work in `
          + 'while its own tree is dirty. Commit or stash there first.',
      };
    }
    const m = git(xource.parent_worktree, ['merge', '--ff-only', req.new_sha]);
    landed = m.ok;
    output = `${m.out}\n${m.err}`.trim();
  } else {
    // Root xource (local main): nothing has it checked out, so move it with a push — which fires
    // the gate, which finds the approval we just wrote and spends it.
    const p = git(project.repo_root, ['push', '.', `${req.new_sha}:${req.ref}`]);
    landed = p.ok;
    output = `${p.out}\n${p.err}`.trim();
  }

  if (landed) {
    const row = await one(
      `UPDATE land_request SET status='landed', landed_at=now() WHERE id=$1 RETURNING *`, [requestId]);
    broadcast('land', row);
    broadcast('xell', { id: req.xell_id });
    logline('landgate',
      `PR ACCEPTED by ${by}: ${xell?.slug} @ ${req.new_sha.slice(0, 8)} is on ${req.ref.replace('refs/heads/', '')}`);
  } else {
    await q(`UPDATE land_request SET status='pending', decided_at=NULL, decided_by=NULL WHERE id=$1`, [requestId]);
    logline('landgate', `PR accept FAILED for ${xell?.slug}: ${output.split('\n').filter(Boolean).pop()}`);
  }
  return { ok: landed, output: output.slice(-2000) };
}

// Open PRs grouped by the ref they target — the console renders them on THAT xource's card, which
// is the point: the side being asked to take the code is the side that sees the ask.
export async function openPullsByRef(projectId) {
  const rows = await q(
    `SELECT lr.*, x.slug AS xell_slug FROM land_request lr
       LEFT JOIN xell x ON x.id = lr.xell_id
      WHERE lr.project_id=$1 AND lr.kind='pull' AND lr.status IN ('pending','approved')
      ORDER BY lr.requested_at DESC`, [projectId]);
  const out = {};
  for (const r of rows) (out[r.ref] ||= []).push(r);
  return out;
}

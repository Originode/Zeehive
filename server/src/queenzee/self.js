// THE CXELLD-ZEE ↔ QUEENZEE WORKFLOW PROTOCOL — the verbs a CXELLD zee calls to do everything a
// host-side zee does with skills. A cxell zee runs `claude --bare` inside a per-xell container with
// no docker CLI, no host filesystem and no skills; the queenzee API is its ONLY door out of the
// cxell. So every skill — orient, land, ship, bind-prod, done — is ONE authenticated call here.
//
// The shape is deliberate and uniform: the cxell is the WALL, this API is the single narrow DOOR,
// and the human is the LOCK on it. Knowledge is not power — the zee may KNOW every verb, because
// each verb is only a REQUEST that lands on an existing human gate. Nothing here bypasses a gate;
// each function maps the calling xell onto the SAME landgate / shipgate / prod-bind / proposeDone
// path a host-side zee (or a human in the console) uses. The caller is always resolved from the
// per-xell token (routes.js), so a verb can only ever act on the xell that presented it.
import { q, one } from '../db/pool.js';
import { config } from '../config.js';
import { broadcast } from '../lib/events.js';
import { logline } from '../lib/logbus.js';
import { spawnSync } from 'node:child_process';
import { collectCxellDiffToWorktree, sealCxell, cxellName, cxellRunning, syncCxellWithXource } from '../lib/cxell.js';
import { pushToXource, catchUpToXource } from './xellgit.js';
import { cleanGitEnv } from '../lib/git.js';
import { landStatus } from './landgate.js';
import { requestShip, shipStatus } from './shipgate.js';
import { requestProdSeed, seedStatusFor, SEED_DIR } from './seedgate.js';
import { notifyProdBindRequest } from '../lib/notify.js';
import { proposeDone } from './tasks.js';
import { attachProdStack } from '../lib/xell-prod.js';
import { catchUpXellToProd } from './shipmigrate.js';
import { attachXellDb } from '../lib/xell-db.js';
import { diffXellDbAgainstProd } from './proddiff.js';
import { emitXellEnv } from '../lib/provision.js';
import { buildXell, getBuildStatus } from '../lib/build.js';
import { hiveStatus, hiveLabel } from '../lib/hive-status.js';
import { setTend, tendOpen, setHint, hintOpen, pingWorking } from '../lib/status.js';
import { attachDeviceXhip, detachDeviceXhip, deviceForXell, deviceLoop } from '../lib/devices.js';

const liveZee = (xellId) => one(
  `SELECT id, name, status, model FROM zee WHERE xell_id=$1
     AND status IN ('spawning','online','working','idle') ORDER BY created_at DESC LIMIT 1`, [xellId]);

// ── GET /api/xell/self/status — the read model a cxell zee orients from ────────
// Everything it needs to know where it stands: its own status/task, whether a landing/ship/prod-bind
// is pending a human, its containers and db binding. No secrets (the token itself never appears).
export async function selfStatus(xell) {
  const zee = await liveZee(xell.id);
  const task = await one(`SELECT id, status, done_at, done_by FROM task WHERE xell_id=$1 ORDER BY created_at DESC LIMIT 1`, [xell.id]);
  const land = await landStatus(xell.id);
  const ship = await shipStatus(xell.id);
  const prodBind = await one(
    `SELECT id, status, reason, requested_at, decided_at, decided_by FROM prod_bind_request
       WHERE xell_id=$1 ORDER BY requested_at DESC LIMIT 1`, [xell.id]);
  const seed = await seedStatusFor(xell.id);
  const lock = await one(`SELECT container, phase FROM deploy_lock WHERE xell_id=$1`, [xell.id]);
  const containers = await q(
    `SELECT c.role, c.name, c.tier, host(c.host) AS host, c.host_port FROM xell_uses_container uc
       JOIN container c ON c.id = uc.container_id WHERE uc.xell_id=$1 ORDER BY c.role`, [xell.id]);
  const tend = await tendOpen(xell.id);
  const landHint = await hintOpen(xell.id, 'land');
  const shipHint = await hintOpen(xell.id, 'ship');
  // The DISPLAY status the hive shows for this xell — the same derivation the dashboard renders, so
  // a cxell zee sees itself exactly as a human does (and can tell its tend/hint/land/ship pings landed).
  const hive = hiveStatus(
    { ...xell, zee_status: zee?.status },
    {
      landPending: land ? ['pending', 'approved'].includes(land.status) : false,
      // A DEFERRED ship (pending, but a human set it aside for a combined ship) is not "awaiting a
      // human" — it matches how fleet.js derives the hive status, so the zee sees itself as a human does.
      shipPending: ship ? (['pending', 'approved', 'shipping'].includes(ship.status) && !ship.deferred_at) : false,
      tendPending: tend,
      landHint, shipHint,
      // The two PROD-DATA asks, so a cxell zee sees its own `prod?` / `seed?` hexagon exactly as a
      // human does — and can tell that its request actually reached the console.
      prodBindPending: prodBind ? prodBind.status === 'pending' : false,
      seedPending: seed ? ['pending', 'approved', 'running'].includes(seed.status) : false,
      prodUnprotected: xell.is_production && !!lock,
    },
  );
  return {
    xell: {
      id: xell.id, slug: xell.slug, branch: xell.branch, status: xell.status,
      hive_status: hive, hive_status_label: hiveLabel(hive),
      head_commit: xell.head_commit, db_coupling: xell.db_coupling,
      on_prod: xell.db_coupling === 'db-shared-prod',
    },
    tend: { open: tend },
    zee: zee || null,
    task: task ? { id: task.id, status: task.status, done: task.status === 'done' } : null,
    awaiting_done: xell.status === 'awaiting-done',
    landing: land
      ? { status: land.status, new_sha: land.new_sha, decided_by: land.decided_by, pending: land.status === 'pending' }
      : null,
    ship: ship
      ? { status: ship.status, commit: ship.commit, decided_by: ship.decided_by,
          // deferred: a human set this ship aside to batch it into one combined ship; it is NOT
          // rejected and NOT awaiting approval — it goes when they resume it.
          deferred: !!ship.deferred_at,
          pending: ['pending', 'approved', 'shipping'].includes(ship.status) && !ship.deferred_at }
      : null,
    prod_bind: prodBind
      ? { id: prodBind.id, status: prodBind.status, pending: prodBind.status === 'pending' }
      : null,
    // The narrow prod-DATA ask: a landed seed file the queenzee runs on production once a human
    // approves. `seeded`/`failed` carry the outcome, so `zee status` is enough to know it happened.
    prod_seed: seed
      ? { id: seed.id, status: seed.status, files: seed.files || [], commit: seed.commit,
          decided_by: seed.decided_by, error: seed.result?.error || null,
          pending: ['pending', 'approved', 'running'].includes(seed.status) }
      : null,
    holds_prod_lock: !!lock, prod_lock_phase: lock?.phase || null,
    containers,
  };
}

// ── POST /api/xell/self/land — collect the cxell's commits, catch up, and run the gated push ──
// The missing piece for a cxell zee: its commits live INSIDE the container, but the land gate pushes
// from the host worktree. So we (1) pull the cxell's commits onto the worktree, (2) CATCH THE
// WORKTREE UP to the current xource tip — because the zee committed on top of master-as-it-was and
// master moved, so a raw push would be a non-fast-forward the gate silently drops — then (3) run the
// SAME gated `git push . HEAD:main` a host-side zee runs, HELD for a human. We never move main.
//
// And we REPORT THE REAL OUTCOME: `landed` (a human already approved this sha), `held` (a genuine
// pending land_request now exists — verified), or `needs-resolution` (couldn't catch up: a real
// conflict). Never "held" when nothing was actually raised — the fleet-burn-tracker lie.
// The xource ref (e.g. 'master') this xell tracks — needed to deliver/merge it into the cxell.
async function xourceRef(xellId) {
  const row = await one(
    `SELECT xo.ref FROM xource xo JOIN xell x ON x.xource_id = xo.id WHERE x.id=$1`, [xellId]);
  return row?.ref || null;
}
const wtGit = (wt, args) => {
  const r = spawnSync('git', ['-C', wt, args].flat(), { encoding: 'utf8', windowsHide: true, env: cleanGitEnv() });
  return { ok: r.status === 0, out: (r.stdout || '').trim() };
};
// Does the worktree HEAD already contain the xource tip? If so, the push that follows is a real
// fast-forward the land-gate can hold; if not, the zee needs to merge current main (via a cxell sync)
// before it can land. For a LIVE cxell we NEVER merge into the worktree here (Change 1: the worktree
// is read-only for catch-up) — we self-heal by delivering main INTO the cxell instead.
function worktreeContainsRef(wt, ref) {
  if (!wtGit(wt, ['rev-parse', ref]).ok) return true; // ref unreadable → nothing to catch up to
  return wtGit(wt, ['merge-base', '--is-ancestor', ref, 'HEAD']).ok;
}

export async function selfLand(xell) {
  if (!xell.worktree_path) return { ok: false, status: 'error', error: `${xell.slug} has no host worktree to land from` };

  // Is a live cxell driving this xell? If so, reconciliation happens by delivering the xource INTO
  // the container and merging there (self-heal) — never by a behind-the-zee's-back worktree merge.
  const live = await cxellRunning({ ctx: 'default', slug: xell.slug });
  const ref = await xourceRef(xell.id);

  // 1) COLLECT — best-effort: a missing docker/cxell or an already-collected worktree is a no-op,
  // not a failure. A worktree that has DIVERGED from the cxell used to be a dead end (and stranded
  // the work); now, for a live cxell, we SELF-HEAL: sync current main into the cxell, merge there,
  // and retry the collect. We only give up if that merge genuinely CONFLICTS.
  let collected, healed = null;
  try {
    collected = await collectCxellDiffToWorktree({ ctx: 'default', slug: xell.slug, worktree: xell.worktree_path });
  } catch (e) {
    if (/do not fast-forward/i.test(e.message)) {
      if (!live || !ref) {
        return { ok: false, status: 'needs-resolution', stage: 'collect', error: e.message,
          stranded_ref: e.strandedRef || null };
      }
      const heal = await selfHealSync(xell, ref);
      if (!heal.ok) return { ...heal, collected: null, stranded_ref: e.strandedRef || null };
      healed = heal;
      // retry the collect now that the cxell descends from current main
      try {
        collected = await collectCxellDiffToWorktree({ ctx: 'default', slug: xell.slug, worktree: xell.worktree_path });
      } catch (e2) {
        return { ok: false, status: 'needs-resolution', stage: 'collect', healed,
          error: e2.message, stranded_ref: e2.strandedRef || e.strandedRef || null,
          message: `Synced current ${ref} into your cxell and merged it, but the collect still does not `
            + `fast-forward. Your commits are anchored at ${e2.strandedRef || e.strandedRef} — a human should look.` };
      }
    } else {
      collected = { collected: false, warning: `cxell collection skipped: ${e.message}` };
      logline('self', `${xell.slug} land: cxell collection skipped (${e.message})`);
    }
  }

  // 1b) For a LIVE cxell whose worktree does NOT yet contain the current xource tip, the push would
  // be a non-fast-forward the gate silently drops. Do NOT merge into the worktree behind the zee's
  // back (Change 1) — self-heal by merging main INSIDE the cxell, then re-collect so the worktree
  // fast-forwards onto the reconciled HEAD. (Only when we didn't already just heal above.)
  if (live && ref && !healed && !worktreeContainsRef(xell.worktree_path, ref)) {
    const heal = await selfHealSync(xell, ref);
    if (!heal.ok) return { ...heal, collected };
    healed = heal;
    try {
      collected = await collectCxellDiffToWorktree({ ctx: 'default', slug: xell.slug, worktree: xell.worktree_path });
    } catch (e) {
      return { ok: false, status: 'needs-resolution', stage: 'collect', healed, error: e.message,
        stranded_ref: e.strandedRef || null };
    }
  }

  // 2) CATCH UP to the current xource tip so an older-based commit still fast-forwards. For a live
  // cxell the self-heal above already brought the worktree up to main (via the cxell), so this is a
  // no-op 'up-to-date'; for a NON-cxell (host) xell it does the old worktree merge. A conflict here is
  // an honest stop — do NOT silently proceed to a doomed push.
  let caughtUp;
  try {
    caughtUp = await catchUpToXource(xell.id);
  } catch (e) {
    return { ok: false, status: 'needs-resolution', stage: 'catch-up', error: e.message, collected, healed };
  }
  if (caughtUp.state === 'conflict' || caughtUp.state === 'no-head' || caughtUp.state === 'error') {
    const msg = caughtUp.state === 'conflict'
      ? `Could not catch up to ${caughtUp.ref}: your commits CONFLICT with work that landed while you were `
        + 'running. Nothing was pushed and your branch is untouched. Pull the latest into your cxell, resolve '
        + 'the conflict, commit, and `zee land` again.'
      : caughtUp.state === 'error'
        // NOT a content conflict — an operational failure on the queenzee side that a zee cannot fix by
        // editing files. Surface it plainly so nobody hunts a phantom merge conflict.
        ? `Could not catch up to ${caughtUp.ref} — this is NOT a merge conflict but a catch-up error, so `
          + 'there is nothing for you to resolve in the code. Nothing was pushed; your branch is untouched. '
          + `A human should check the queenzee: ${(caughtUp.output || 'no detail').split('\n').filter(Boolean).pop()}`
        : `Could not read HEAD in the worktree for ${xell.slug} — nothing to land.`;
    return {
      ok: false, status: 'needs-resolution', stage: 'catch-up', collected, catch_up: caughtUp, healed,
      conflict: caughtUp.state === 'conflict' ? (caughtUp.output || null) : null,
      error: caughtUp.state === 'error' ? (caughtUp.output || null) : undefined,
      message: msg,
    };
  }

  // 3) PUSH — the same gated `git push . HEAD:<ref>`. The landgate's update hook decides.
  const push = await pushToXource(xell.id, `zee@${xell.slug}`).catch((e) => ({ error: e.message }));
  if (push.error) return { ok: false, status: 'error', stage: 'push', error: push.error, collected, catch_up: caughtUp, healed };

  // 4) REPORT THE REAL OUTCOME.
  const caughtNote = (caughtUp.state === 'merged' || caughtUp.state === 'rebased' || caughtUp.state === 'fast-forwarded')
    ? ` (after catching up to ${caughtUp.ref} — ${caughtUp.state})`
    : (healed && healed.state === 'merged' ? ` (after self-healing: merged current ${ref} into your cxell)` : '');

  if (push.landed) {
    return {
      ok: true, status: 'landed', landed: true, collected, catch_up: caughtUp, healed, request: await landStatus(xell.id),
      message: `LANDED on ${push.ref} @ ${String(push.head).slice(0, 8)} — a human had already approved this exact sha${caughtNote}.`,
    };
  }

  // Push was HELD → a pending land_request for THIS EXACT sha must now exist. Verify it before we
  // dare say "held" — the whole point of the fix is that the status can be trusted.
  const request = await landStatus(xell.id);
  const trulyHeld = request && request.status === 'pending' && request.new_sha === push.head;
  if (trulyHeld) {
    return {
      ok: true, status: 'held', landed: false, collected, catch_up: caughtUp, healed, request,
      message: `Landing REQUESTED — your push is HELD at the gate for a human to approve in the ZEEHIVE console `
        + `(land_request ${String(request.id).slice(0, 8)}, sha ${String(push.head).slice(0, 8)})${caughtNote}. Your commits `
        + 'are safe on your branch; nothing lands until a human agrees. You do NOT need to re-run land: when a human '
        + 'approves, the queenzee lands it AND nudges you to continue. To block meanwhile, `zee land --wait` (or '
        + '`zee status --wait`) in the background — its exit is your nudge.',
    };
  }

  // Push did not land AND there is no fresh pending hold for this sha — this is NOT a clean held
  // landing, so do not pretend it is. Say what actually happened.
  return {
    ok: false, status: request ? request.status : 'unknown', landed: false, collected, catch_up: caughtUp,
    request: request || null,
    push_output: push.output ? String(push.output).slice(-800) : null,
    message: request
      ? (request.status === 'rejected'
        ? `A human REJECTED this exact sha (${String(request.new_sha).slice(0, 8)}) — re-pushing will not help; talk to them.`
        : `Push did not land and the latest land_request is '${request.status}' (sha ${String(request.new_sha).slice(0, 8)}), `
          + `not a fresh pending hold for ${String(push.head).slice(0, 8)}. Check the ZEEHIVE console — this is NOT a clean held landing.`)
      : 'Push did not land and NO land_request was raised — the gate held nothing (a non-fast-forward the catch-up '
        + 'did not resolve, or the gate is unreachable). This is a real failure, not a held landing.',
  };
}

// ── the SELF-HEAL primitive — deliver current main into the cxell and merge it, PURE SCRIPT ──────
// Shared by `zee land`'s automatic recovery and by `zee sync`. It runs syncCxellWithXource (deliver +
// merge, no model) and turns its state into a uniform result. A CLEAN merge (or already-up-to-date)
// is { ok: true }; a genuine CONFLICT or an operational ERROR is { ok: false, status:'needs-resolution' }
// carrying the honest message (Change 4: the zee is told WHICH kind of failure it hit, so it does not
// hunt a phantom conflict). On conflict the merge is LEFT in the cxell for the zee to resolve in place.
async function selfHealSync(xell, ref) {
  const s = await syncCxellWithXource({ ctx: 'default', slug: xell.slug, worktree: xell.worktree_path, ref });
  if (s.state === 'merged' || s.state === 'up-to-date') return { ok: true, ...s };
  if (s.state === 'conflict') {
    return {
      ok: false, status: 'needs-resolution', stage: 'sync', state: 'conflict', ref, sync: s,
      conflict: s.output || null,
      message: `Merging current ${ref} into your cxell hit a real CONTENT CONFLICT — this one is YOURS to resolve. `
        + `The merge is left in progress in your cxell (/work/repo): run \`git status\`, fix the conflicted files, `
        + `\`git add\` them and \`git commit\`, then \`zee land\` again. If you truly cannot resolve it, \`zee tend\` a human.`,
    };
  }
  // operational error (delivery failed, or a non-conflict merge failure) — nothing to fix in code.
  return {
    ok: false, status: 'needs-resolution', stage: 'sync', state: 'error', ref, sync: s,
    error: s.output || s.reason || null,
    message: `Could not sync current ${ref} into your cxell — this is an OPERATIONAL error, NOT a merge conflict, `
      + `so there is nothing for you to resolve in the code. Your commits are untouched. A human should check the `
      + `queenzee: ${String(s.output || s.reason || 'no detail').split('\n').filter(Boolean).pop()}`,
  };
}

// ── POST /api/xell/self/sync — pull current main into the cxell, merge, rebuild ──────────────────
// The verb a caged zee can run AT ANY TIME to reconcile with main on its own: deliver the current
// xource into the cxell, merge it (pure script), and — on a clean merge — kick a rebuild so the
// running stack reflects the merged code. NOT human-gated (it only touches this xell's own cxell and
// throwaway containers). The zee then re-verifies (its tests / `zee build --wait`). A genuine content
// conflict is handed back for the zee to resolve; an operational error is reported as such.
export async function selfSync(xell, { rebuild = true } = {}) {
  if (!xell.worktree_path) return { ok: false, status: 'error', error: `${xell.slug} has no host worktree to sync from` };
  const live = await cxellRunning({ ctx: 'default', slug: xell.slug });
  if (!live) return { ok: false, status: 'error', error: `${xell.slug} has no live cxell to sync into — sync delivers current main INTO the container.` };
  const ref = await xourceRef(xell.id);
  if (!ref) return { ok: false, status: 'error', error: `cannot resolve the xource ref for ${xell.slug}` };

  const heal = await selfHealSync(xell, ref);
  if (!heal.ok) return heal;

  // Clean merge (or already current). On an actual merge, collect the merged HEAD onto the worktree
  // and rebuild so the zee's containers run the reconciled code; re-verification is the zee's to do.
  let collected = null, built = null;
  if (rebuild && heal.state === 'merged') {
    try {
      collected = await collectCxellDiffToWorktree({ ctx: 'default', slug: xell.slug, worktree: xell.worktree_path });
    } catch (e) { collected = { collected: false, warning: e.message }; }
    try { built = await buildXell(xell.id, { hot: false, role: null }); }
    catch (e) { built = { error: e.message }; }
  }
  const note = heal.state === 'up-to-date'
    ? `Already up to date with ${ref} — your cxell already contains the current tip; nothing to merge.`
    : `Merged current ${ref} into your cxell cleanly (HEAD ${String(heal.head).slice(0, 8)}).`
      + (built && !built.error ? ' A rebuild was started — run `zee build --wait` (background) to confirm it serves your HEAD, then re-run your tests.' : '')
      + (built && built.error ? ` (rebuild could not start: ${built.error})` : '');
  return { ok: true, status: heal.state, ref, head: heal.head || null, collected, built, message: note };
}

// ── POST /api/xell/self/catchup — roll THIS cxell's own db up to prod's schema ──
// The verb a schema-work zee runs BEFORE writing migrations: bring its own db (clone/isolated)
// forward to prod's CURRENT schema so its new migration builds on prod's real state and the /ooney
// gate's green condition ("my catalog = prod + my pending migrations") is reachable. NOT human-gated
// — like `zee build` it writes only this xell's throwaway db (and reads prod read-only). `restore`
// (isolated only) rebuilds from the latest full prod snapshot instead of rolling migrations forward:
// exact schema AND data, but it DISCARDS the zee's db work, so it is opt-in.
export async function selfCatchup(xell, { restore = false } = {}) {
  if (restore) {
    if (xell.db_coupling !== 'db-isolated') {
      return { ok: false, error: `--restore rebuilds an isolated db from a prod snapshot, but this xell is `
        + `'${xell.db_coupling}'. For a clone, re-attach a fresh one (\`--db clone\`); for shared dev/prod there `
        + 'is nothing to restore. Run \`zee db-catchup\` (no --restore) to roll migrations forward instead.' };
    }
    let attached;
    try { attached = await attachXellDb(xell.id, { coupling: 'db-isolated', dump: 'latest' }); }
    catch (e) { return { ok: false, error: `re-restore failed: ${e.message}` }; }
    let residual = null;
    try { const diff = await diffXellDbAgainstProd(xell.project_id, xell.id); if (diff?.ok) residual = diff.total; }
    catch { /* best-effort */ }
    return {
      ok: true, restored: true, ...attached, residual_missing: residual,
      message: `Re-restored your isolated db from the latest full prod snapshot (${attached.restored_from || 'unknown'}) — `
        + `schema AND data are now at that snapshot${residual === 0 ? ', with zero schema drift from prod' : residual != null ? `, ${residual} object(s) still differ from prod` : ''}. `
        + 'Your previous db contents were replaced. The container was re-provisioned, so REBUILD your app tier '
        + '(`zee build --wait`, background) to pick up the new DATABASE_URL before you re-verify.',
    };
  }

  const r = await catchUpXellToProd(xell.id);
  if (r.ok === false) {
    return { ...r, message: r.recommend_restore
      ? `${r.error} (You can do that now: \`zee db-catchup --restore\`.)`
      : r.error };
  }
  const applied = r.applied || [];
  const tail = r.residual_missing === 0
    ? ' Your schema now matches prod (0 drift).'
    : r.residual_missing > 0
      ? ` ${r.residual_missing} object(s) STILL differ from prod after the roll-forward`
        + (r.recommend_restore ? ' — the ledger could not close the gap; \`zee db-catchup --restore\` rebuilds from the latest full prod snapshot.' : '.')
      : '';
  return {
    ok: true, ...r,
    message: applied.length
      ? `Caught ${r.database} up to prod — applied ${applied.length} migration(s) prod had run that your db lacked `
        + `(baseline: ${r.baseline}):\n    ${applied.join('\n    ')}\n  Now \`zee db-migrate\` to apply your OWN branch `
        + `migrations on top, then re-verify.${tail}`
      : `${r.note || 'Nothing to catch up.'}${tail}`,
  };
}

// ── POST /api/xell/self/ship — file a ship request (shipgate) ──────────────────
// The zee only ASKS. requestShip refuses unless the work is already landed on main (the anti-band-aid
// rule), holds the request for a human, and the QUEENZEE deploys from main on approval. Identical to
// the host-side scripts/xell-ship.mjs path — this is just the cxell entry to it.
export async function selfShip(xell, { targets = null, reason = null } = {}) {
  const zee = await liveZee(xell.id);
  return requestShip({ xellId: xell.id, zeeId: zee?.id || null, reason, targets });
}

// ── POST /api/xell/self/prod-request — ASK to bind this xell to the prod stack ──
// Records a REQUEST only. It does NOT bind: binding grants prod DATA, a human's call (HANDOFF). The
// human confirms in the console (decideProdBind), and ONLY then does the queenzee attachProdStack
// AND re-seal the cxell firewall to allow the prod db. Until confirmed the cxell cannot reach prod.
export async function selfProdRequest(xell, { reason = null } = {}) {
  const existing = await one(
    `SELECT * FROM prod_bind_request WHERE xell_id=$1 AND status='pending'`, [xell.id]);
  if (existing) return { ok: true, request: existing, note: 'you already have an open prod-bind request' };
  const zee = await liveZee(xell.id);
  const row = await one(
    `INSERT INTO prod_bind_request (project_id, xell_id, zee_id, reason) VALUES ($1,$2,$3,$4) RETURNING *`,
    [xell.project_id, xell.id, zee?.id || null, reason]);
  broadcast('prod-bind', row);
  broadcast('xell', { id: xell.id });
  logline('xell-prod', `${xell.slug} REQUESTED a prod bind — awaiting human confirmation${reason ? `: ${reason}` : ''}`);
  // Reach the human OFF-SCREEN too. A prod-bind request blocks the zee exactly like a held landing
  // does — it sat in the queenzee log only, so a zee could ask and simply never be answered.
  const project = await one(`SELECT id, name FROM project WHERE id=$1`, [xell.project_id]);
  notifyProdBindRequest({ project: project || { name: 'project' }, xell, request: row });
  return {
    ok: true, request: row,
    message: 'Prod-bind REQUESTED — a human must CONFIRM it in the ZEEHIVE console (your hexagon now shows '
      + '`prod?` with the buttons on it). Until then your cxell physically cannot reach prod (the firewall '
      + 'stays sealed). This grants the prod DATABASE only, not prod code — shipping code stays the ship '
      + 'gate (`zee ship`). If all you need is rows in prod, `zee seed` is the narrower ask: the QUEENZEE '
      + 'runs a landed seed file for you and you never hold prod at all.',
  };
}

// ── POST /api/xell/self/seed-request — ASK the queenzee to seed PRODUCTION ─────
// The narrow counterpart to prod-request: some shipments are not usable until rows exist in prod
// (reference data, a lookup the new screen reads). Binding the whole xell to the live database for
// that is a sledgehammer — this asks a human to approve ONE landed .sql file under server/sql/seeds/,
// which the QUEENZEE then runs against production. The zee never touches prod. See seedgate.js.
export async function selfSeedRequest(xell, { files = [], reason = null, site = null } = {}) {
  const zee = await liveZee(xell.id);
  const r = await requestProdSeed({ xellId: xell.id, zeeId: zee?.id || null, files, reason, site });
  broadcast('xell', { id: xell.id });
  return r;
}

// Read-only: where did my seed request get to? (`zee seed --status`)
export async function selfSeedStatus(xell) {
  const row = await seedStatusFor(xell.id);
  if (!row) {
    return { ok: true, request: null,
      note: `no seed request on record. Write an IDEMPOTENT ${SEED_DIR}/<name>.sql, land it, then `
        + '`zee seed --file <name>.sql --reason "..."`.' };
  }
  return { ok: true, request: row };
}

// ── HUMAN side: confirm/reject a prod-bind request (no zee path to this) ────────
export async function listProdBindRequests(projectId, { open = true } = {}) {
  const where = open ? `AND pbr.status = 'pending'` : '';
  return q(
    `SELECT pbr.*, x.slug AS xell_slug FROM prod_bind_request pbr
       JOIN xell x ON x.id = pbr.xell_id
      WHERE pbr.project_id=$1 ${where} ORDER BY pbr.requested_at DESC LIMIT 50`, [projectId]);
}

// The human decides. On CONFIRM: bind the prod stack (attachProdStack — the same call /xell-prod
// makes) AND re-seal the cxell firewall so the cxell can now reach the prod db host:port. Rejection is
// a plain status flip; nothing is bound and the cxell stays sealed.
export async function decideProdBind(id, decision, by = 'human@console') {
  if (!['confirmed', 'rejected'].includes(decision)) throw new Error(`bad decision: ${decision}`);
  const row = await one(
    `UPDATE prod_bind_request SET status=$2, decided_at=now(), decided_by=$3
       WHERE id=$1 AND status='pending' RETURNING *`, [id, decision, by]);
  if (!row) throw new Error('no such pending prod-bind request (already decided?)');
  broadcast('prod-bind', row);
  if (decision !== 'confirmed') {
    logline('xell-prod', `prod-bind for ${row.xell_id} REJECTED by ${by}`);
    return row;
  }
  const bind = await attachProdStack(row.xell_id, { by });
  // Re-seal the cxell so it can now reach the prod db (its stack just changed to include prod). A cxell
  // that isn't running (a purely-host xell, or a torn-down cxell) simply has no firewall to re-seal —
  // best-effort, recorded either way.
  const reseal = await resealCxellForStack(row.xell_id).catch((e) => ({ error: e.message }));
  // The xell now holds the live prod db → it must be loaded with the PRODUCTION environment. The
  // xell's db_coupling just became 'db-shared-prod', so resolveEnvironmentFor now picks the prod
  // env; re-emit .zeehive.env to swap dev secrets for prod ones (migration 043). Best-effort.
  await emitXellEnv(row.xell_id).catch((e) => logline('xell-prod', `${bind.xell}: .zeehive.env not re-emitted with prod env — ${e.message}`));
  const done = await one(
    `UPDATE prod_bind_request SET result=$2::jsonb WHERE id=$1 RETURNING *`,
    [id, JSON.stringify({ bind, reseal })]);
  broadcast('prod-bind', done);
  logline('xell-prod', `prod-bind CONFIRMED by ${by} for ${bind.xell} — cxell re-sealed (${reseal.error ? `reseal error: ${reseal.error}` : 'prod db now reachable'})`);
  return done;
}

// Re-seal the cxell now that this xell is bound to prod: block every prod DB EXCEPT this xell's own
// project's — that one is now reachable, which is the whole point of the bind. Mirrors spawnCxell's
// block-list logic (default-allow egress, drop only prod DBs).
async function resealCxellForStack(xellId) {
  const xell = await one(`SELECT slug, project_id FROM xell WHERE id=$1`, [xellId]);
  const prodDbs = await q(
    `SELECT DISTINCT host(c.host) AS host, c.host_port, c.project_id FROM container c
      WHERE c.tier='prod' AND c.role='db' AND c.host IS NOT NULL AND c.host_port IS NOT NULL`);
  const blockTcp = prodDbs
    .filter((r) => r.project_id !== xell.project_id) // this xell's prod DB is now allowed
    .map((r) => `${r.host}:${r.host_port}`);
  const sealed = await sealCxell({ ctx: 'default', name: cxellName(xell.slug), blockTcp });
  return { blockTcp, tail: sealed[sealed.length - 1] || null };
}

// ── POST /api/xell/self/done — propose done (the human confirms → teardown) ─────
// The zee never despawns itself. proposeDone flags the xell 'awaiting-done'; a human confirms with
// "Mark done" in the dashboard, and THAT is what reaps the cxell (collecting its commits first).
export async function selfDone(xell, { summary = null } = {}) {
  return proposeDone({ xell_id: xell.id, note: summary });
}

// ── POST /api/xell/self/tend — raise (or clear) "I need a human in the console" ─
// A cxell zee's ping for human attention that ISN'T a land/ship/done (a question, a stuck decision,
// a heads-up). Unlike those it opens no gate and blocks nothing — it just flags the xell so the hive
// shows `occ-tendRequest` and the human knows to look. `--clear` (or {clear:true}) lowers it; a zee
// that reports working again clears it automatically.
export async function selfTend(xell, { reason = null, clear = false } = {}) {
  const zee = await liveZee(xell.id);
  const res = await setTend(xell.id, !clear, { reason, zeeId: zee?.id || null });
  logline('self', `${xell.slug} ${clear ? 'CLEARED its tend' : 'raised a TEND'}${reason ? `: ${reason}` : ''}`);
  return {
    ok: true, ...res,
    message: clear
      ? 'Tend cleared — the hive no longer flags this xell for attention.'
      : 'Tend RAISED — the hive now shows this xell as needing a human (occ-tendRequest). Nothing is '
        + 'gated or blocked; a human will see it in the console. It clears when you `zee tend --clear` '
        + 'or report working (`zee working`).',
  };
}

// ── POST /api/xell/self/hint-land · hint-ship — "this looks ready; a human should decide" ──────
// The verb for the 100%-certain rule: a zee only calls the real, gated `zee land` / `zee ship` when
// it is CERTAIN the job is done. Short of that — a landable checkpoint, a plausibly-shippable state
// it wants eyes on — it HINTS instead. A hint opens no gate and pushes nothing; it just lights the
// land? / ship? prompt on the hive so a human sees the button and decides. `{clear:true}` lowers it.
export async function selfHint(xell, kind, { reason = null, clear = false } = {}) {
  const zee = await liveZee(xell.id);
  const res = await setHint(xell.id, kind, !clear, { reason, zeeId: zee?.id || null });
  logline('self', `${xell.slug} ${clear ? `cleared its ${kind} hint` : `HINTED ${kind}-ready`}${reason ? `: ${reason}` : ''}`);
  const verb = kind === 'land' ? 'land' : 'ship';
  return {
    ok: true, ...res,
    message: clear
      ? `${kind} hint cleared — the hive no longer prompts to ${verb} this xell.`
      : `${kind} hint RAISED — the hive now shows this xell as occ-${kind}Hint (${verb}?), surfacing the `
        + `${verb} button for a human. Nothing is gated or pushed. Call the real \`zee ${verb}\` yourself ONLY `
        + `when you are 100% certain the job is done; otherwise leave the decision to the human's button.`,
  };
}

// ── POST /api/xell/self/working — ping "I am actively working" ──────────────────
// Channel A (harness hooks) isn't installed for cxell zees, so a cxell can look idle to the passive
// poller even mid-task. This ping lets a zee assert live activity — the hive shows `occ-working` —
// and clears any open tend.
export async function selfWorking(xell, { note = null } = {}) {
  const zee = await liveZee(xell.id);
  if (!zee) return { ok: false, error: 'no live zee bound to this xell to mark working' };
  const res = await pingWorking(zee, { note });
  return { ok: true, ...res, message: 'Working ping recorded — the hive shows this xell as occ-working.' };
}

// ── POST /api/xell/self/build — (re)build THIS cxell's own app tier ─────────────
// The verb a cxell zee needs to run e2e tests against its OWN change. A host-side zee runs
// scripts/xell-build.mjs; a cxell zee has no host fs and no docker, so that script is unreachable —
// this is its only door to a build. UNLIKE land/ship/prod/done it is NOT human-gated: building your
// own throwaway containers is the whole point of a xell, so it acts immediately.
//
// The catch a cxell zee cannot see: its commits live INSIDE the cxell, but buildXell compiles from
// the HOST worktree. So we first COLLECT the cxell's committed diff onto the worktree (exactly like
// selfLand step 1) — otherwise the build would faithfully rebuild the OLD code and the zee would
// chase a change that never entered its container. Only COMMITTED cxell work is collected (the bundle
// is commits, never the dirty tree), so a zee must commit before it builds.
export async function selfBuild(xell, { role = null, hot = false } = {}) {
  if (!xell.worktree_path) return { ok: false, error: `${xell.slug} has no host worktree to build from` };

  // COLLECT the cxell's commits so the build includes the zee's code. A --hot bounce reuses the
  // existing image and picks up NO code, so collecting for it is pointless — skip it. Best-effort
  // otherwise: an already-collected worktree or an unreachable cxell is a harmless no-op, but a real
  // divergence (the worktree moved since caging) is an honest stop, exactly as landing treats it.
  let collected = null;
  if (!hot) {
    try {
      collected = await collectCxellDiffToWorktree({ ctx: 'default', slug: xell.slug, worktree: xell.worktree_path });
    } catch (e) {
      if (/do not fast-forward/i.test(e.message)) {
        return {
          ok: false, status: 'needs-resolution', stage: 'collect', error: e.message,
          message: `Could not pull your cxell's commits onto the worktree to build from — it diverged since caging. `
            + 'Nothing was built and your branch is untouched. Pull the latest into your cxell, resolve, commit, '
            + 'and `zee build` again.',
        };
      }
      collected = { collected: false, warning: `cxell collection skipped: ${e.message}` };
      logline('self', `${xell.slug} build: cxell collection skipped (${e.message})`);
    }
  }

  let started;
  try { started = await buildXell(xell.id, { hot, role }); }
  catch (e) { return { ok: false, error: e.message, collected }; }

  const roleLabel = role || 'server + webapp';
  const from = collected?.collected ? `collected HEAD ${String(collected.head).slice(0, 8)}` : 'your worktree';
  return {
    ok: true, hot, role: role || 'all', collected, started,
    message: `${hot ? 'HOT build' : 'Build'} started for ${roleLabel} from ${from} — running in the background on `
      + 'the queenzee (this call does NOT block). To find out when it settles and whether the container is '
      + `actually serving your HEAD, run \`zee build ${role || ''} --wait\` (or --watch) in the BACKGROUND — its `
      + `exit is your nudge.${hot ? ' NOTE: --hot reused the old image, so it does NOT contain code changes.' : ''}`,
  };
}

// ── POST /api/xell/self/device — attach / detach / status a mobile DEVICE xhip ──
// UNLIKE land/ship/prod/done this is NOT human-gated: attaching a THROWAWAY Android emulator to run
// your own app is the same class of act as `zee build` — building your own test target needs no
// human. `attach` stands up (or links) a device and hands back the adb address + the exact
// build→install→run→screenshot loop; `detach` gives it back; `status` reports the current one.
export async function selfDevice(xell, { action = 'attach', kind = null } = {}) {
  if (action === 'detach') {
    const r = await detachDeviceXhip(xell.id);
    return { ok: true, ...r, message: r.detached
      ? `Device ${r.name} detached${r.removed ? ' and removed' : ' (physical device left running)'}.`
      : 'No device was attached — nothing to detach.' };
  }
  if (action === 'status') {
    const d = await deviceForXell(xell.id);
    return d ? { ok: true, attached: true, device: d, loop: deviceLoop(d) }
             : { ok: true, attached: false, message: 'No device attached. Run `zee device` to attach one.' };
  }
  // attach (default)
  const r = await attachDeviceXhip(xell.id, { kind });
  const loop = deviceLoop(r.device);
  return {
    ok: true, ...r, loop,
    message: r.already
      ? `You already have a device (${r.device.name}). Reachable at adb ${r.device.adb}${r.device.viewer_url ? `, viewer ${r.device.viewer_url}` : ''}.`
      : `Device ATTACHED (${r.device.kind}, ${r.device.name}). Connect with \`${loop.connect}\`, then build → install → launch → screenshot. `
        + `${r.device.kind === 'emulator' ? 'It boots Android in ~30-60s; run `adb wait-for-device` after connecting. ' : ''}`
        + `${r.device.viewer_url ? `A human can watch the screen live at ${r.device.viewer_url}. ` : ''}`
        + 'It is torn down with this xell.',
  };
}

// ── GET /api/xell/self/build/status — is this cxell's stack built from its HEAD? ─
// Read-only. What `zee build --wait/--watch` polls: per-container health + serving_head, measured
// against the worktree HEAD (the commit the last collect fast-forwarded it to). Starts no build and
// collects nothing — safe to poll on a tight loop.
export async function selfBuildStatus(xell) {
  return getBuildStatus(xell.id);
}

// /OONEY — the one pipeline a zee walks to get its work into PRODUCTION, as a gate cascade.
//
// The zee calls ONE endpoint, repeatedly. Each call re-measures every gate from live state and
// answers with a verdict plus the exact next step — so the procedure lives HERE, in code, and is
// returned to the zee at the moment it applies. Nothing is hardcoded in a skill file: a .md would
// drift from what the queenzee actually enforces (the repo/installed skill copies already have),
// and a zee following stale instructions against a live gate is how band-aids happen.
//
// The cascade, in order — first failure wins and says what to do:
//   1. SYNC    worktree == main, nothing unlanded, nothing dirty. Deny otherwise, with the land
//              procedure (the land itself is the ONLY step a zee performs — with human clearance;
//              the ref move is mutexed by the 'land' lock, held for the move and released at once).
//   2. SCHEMA  the xell's db vs prod: tables/columns/triggers must be IDENTICAL. Measured now,
//              not read from the last background tick.
//   3. BUILDS  each target container (server/webapp, zee's choice) must be built from the
//              worktree's CURRENT commit. Stale → the queenzee builds it (deterministic, its
//              code); the zee polls until clean. A failed build denies.
//   4. HUMAN   all green → a ship_request is raised for the zee's targets. A human approves in
//              the console. Nothing the zee does speeds this up.
//   5. SHIP    on approval runShip takes the prod lock FOR the xell (the build API rejects any
//              non-holder), builds prod from local main, releases on a timer. The zee's poll
//              flips to 'live' — that is its nudge.
//
// Everything here is queenzee work — script, deterministic, no AI. The zee only ever (a) merges
// with clearance and (b) polls this endpoint.
import { existsSync } from 'node:fs';
import { q, one } from '../db/pool.js';
import { worktreeDiff, worktreeBound } from '../lib/git.js';
import { getBuildStatus, buildXell } from '../lib/build.js';
import { diffXellDbAgainstProd } from './proddiff.js';
import { requestShip } from './shipgate.js';
import { logline } from '../lib/logbus.js';

const SHIPPABLE = ['server', 'webapp'];

const gate = (name, verdict, instruction, detail = null) =>
  ({ gate: name, verdict, instruction, ...(detail ? { detail } : {}) });

export async function ooneyCheck({ xellId, targets = null, reason = null, zeeId = null }) {
  const xell = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
  if (!xell) throw new Error('unknown xell');
  if (xell.is_production) throw new Error('production does not ship itself');
  const project = await one(`SELECT * FROM project WHERE id=$1`, [xell.project_id]);
  const main = project.main_branch || 'main';

  const t = (Array.isArray(targets) && targets.length ? targets : SHIPPABLE).map(String);
  const bad = t.filter((r) => !SHIPPABLE.includes(r));
  if (bad.length) throw new Error(`unshippable target(s): ${bad.join(', ')} — only ${SHIPPABLE.join('/')}`);

  const steps = [];
  const deny = (g) => ({ verdict: 'deny', next: g, steps: [...steps, g], targets: t });
  const wait = (g) => ({ verdict: 'wait', next: g, steps: [...steps, g], targets: t });

  // ── 1. SYNC — is this xell's code exactly what production would be built from? ─────────────
  if (!xell.worktree_path || !existsSync(xell.worktree_path)) {
    return deny(gate('sync', 'deny', 'This xell has no worktree on disk — nothing here can ship.'));
  }
  // The directory must actually BE this xell's worktree. A de-registered one (no .git file) makes
  // every git command in it answer for the PARENT repo — so without this check, the numbers below
  // would describe the XOURCE's checkout, and the land procedure would push someone else's branch.
  const bind = worktreeBound(xell.worktree_path, xell.branch);
  if (!bind.bound) {
    return deny(gate('sync', 'deny',
      `Your worktree is NO LONGER BOUND to this xell: it should be on ${xell.branch}, but git there `
      + `answers ${bind.actual ? `'${bind.actual}'` : 'nothing'} — the registration or branch is gone `
      + '(a cleanup ran after your work landed, most likely). Nothing measured from that directory '
      + 'can be trusted, and nothing can ship from it. If your work is already landed on main, it '
      + 'ships with the next ship of main — nothing further is needed from you; tell your human this '
      + 'xell is finished so they can mark it done. If you have UNLANDED work, stop and tell your '
      + 'human exactly that — do not commit or push anything from this directory.'));
  }
  const d = worktreeDiff(xell.worktree_path, main);
  if (d.dirty > 0) {
    return deny(gate('sync', 'deny',
      `${d.dirty} uncommitted file(s) in your worktree. Commit them (or discard them) first — a ship `
      + `builds from ${main}, so anything uncommitted cannot be in it.`, { dirty: d.dirty }));
  }
  if (d.ahead > 0) {
    return deny(gate('sync', 'deny',
      `${d.ahead} commit(s) are not on ${main} yet. Land them now — this is the one step you perform, `
      + `and it is human-cleared:\n`
      + `  1. git push . HEAD:${main}   (the gate HOLDS it and raises it in the console)\n`
      + `  2. tell your human a landing is waiting, then run in the BACKGROUND:\n`
      + `       node "${process.env.ZEEHIVE_HOME || 'D:/Repos/Zeehive'}/scripts/xell-land.mjs" --wait\n`
      + `     its exit is your nudge. On approval the queenzee moves ${main} itself (the merge is\n`
      + `     mutexed by the 'land' lock and released the instant the ref moves).\n`
      + `  3. re-run this check.`, { ahead: d.ahead }));
  }
  if (d.behind > 0) {
    return deny(gate('sync', 'deny',
      `Your worktree is ${d.behind} commit(s) BEHIND ${main} — production would contain work you have `
      + `never seen or tested against. Merge ${main} into your worktree first:\n`
      + `  git merge --no-edit ${main}   (or the dashboard's ↓ pull button)\n`
      + `then rebuild, re-verify your change still works, and re-run this check.`, { behind: d.behind }));
  }
  steps.push(gate('sync', 'pass', `worktree is exactly at ${main} — nothing unlanded, nothing dirty.`));

  // ── 2. SCHEMA — the database this code was verified against must BE prod's schema ──────────
  const diff = await diffXellDbAgainstProd(project.id, xellId);
  if (!diff.ok) {
    return deny(gate('schema', 'deny',
      `Could not compare your database against prod: ${diff.error}. Fix that first — shipping with an `
      + 'unverifiable schema is shipping blind.', diff));
  }
  if (diff.same_db) {
    steps.push(gate('schema', 'pass', 'your database IS the prod database (db-shared-prod) — identical by identity.'));
  } else if (diff.total > 0) {
    const kinds = Object.entries(diff.kinds || {})
      .filter(([, v]) => v.missing_count + v.extra_count)
      .map(([k, v]) => `${k}: ${v.missing_count} missing / ${v.extra_count} extra`).join('; ');
    return deny(gate('schema', 'deny',
      `Your database schema DIFFERS from production (${diff.total} difference(s) — ${kinds}). Your code `
      + 'was verified against a schema prod does not have. Reconcile first (apply the missing objects '
      + 'to prod via a human-cleared data xell, or rebase your schema), then re-run this check.', diff));
  } else {
    steps.push(gate('schema', 'pass', 'tables, columns and triggers are identical to prod.'));
  }

  // ── 3. BUILDS — each target must be built from the commit that is about to ship ─────────────
  const bs = await getBuildStatus(xellId);
  const mine = (bs.containers || []).filter((c) => t.includes(c.role));
  const stale = mine.filter((c) => c.health !== 'building' && !c.serving_head);
  const building = mine.filter((c) => c.health === 'building');
  const down = mine.filter((c) => c.health === 'down' && !c.never_built);

  if (mine.length < t.length) {
    const have = new Set(mine.map((c) => c.role));
    const missing = t.filter((r) => !have.has(r));
    return deny(gate('builds', 'deny',
      `You asked to ship ${missing.join(' + ')}, but this xell has no ${missing.join('/')} container to `
      + 'prove the build with. Drop it from your targets, or have the app tier provisioned.'));
  }
  if (building.length) {
    return wait(gate('builds', 'wait',
      `Building ${building.map((c) => c.role).join(' + ')} from your current commit — poll again; `
      + 'this check kicks nothing twice.', { building: building.map((c) => c.name) }));
  }
  if (stale.length) {
    // Deterministic queenzee build of exactly the stale roles, then the zee polls.
    for (const c of stale) await buildXell(xellId, { role: c.role });
    logline('ooney', `${xell.slug}: ${stale.map((c) => c.role).join('+')} not built from current head — queenzee building`);
    return wait(gate('builds', 'wait',
      `Your ${stale.map((c) => c.role).join(' + ')} ${stale.length === 1 ? 'was' : 'were'} not built from `
      + 'your current commit. The queenzee is building now — poll again until this gate passes.',
      { started: stale.map((c) => c.role) }));
  }
  if (down.length) {
    return deny(gate('builds', 'deny',
      `The last build of ${down.map((c) => c.role).join(' + ')} FAILED (container down). A build that `
      + 'does not come up clean in your xell does not go anywhere near prod. Fix the build, then re-run.',
      { down: down.map((c) => c.name) }));
  }
  steps.push(gate('builds', 'pass',
    `${mine.map((c) => c.role).join(' + ')} built and up from your current commit.`));

  // ── 4 + 5. HUMAN CLEARANCE → SHIP — the existing ship gate, targets attached ────────────────
  const open = await one(
    `SELECT * FROM ship_request WHERE project_id=$1 AND xell_id=$2
       AND status IN ('pending','approved','shipping')`, [project.id, xellId]);
  const last = open || await one(
    `SELECT * FROM ship_request WHERE project_id=$1 AND xell_id=$2
       ORDER BY requested_at DESC LIMIT 1`, [project.id, xellId]);

  if (!open) {
    if (last?.status === 'shipped' && last.finished_at && (Date.now() - new Date(last.finished_at)) < 15 * 60 * 1000) {
      steps.push(gate('ship', 'live',
        `LIVE: commit ${String(last.commit).slice(0, 8)} shipped ${last.targets?.join(' + ') || 'server + webapp'} `
        + 'to production. The queenzee holds the prod lock and auto-releases it — you release nothing.'));
      return { verdict: 'live', next: steps[steps.length - 1], steps, targets: t };
    }
    if (last?.status === 'rejected') {
      return deny(gate('human', 'deny',
        `A human REJECTED your last ship${last.decided_by ? ` (${last.decided_by})` : ''}. Do not re-request `
        + 'without talking to them.'));
    }
    if (last?.status === 'failed') {
      steps.push(gate('ship', 'deny', `Your last ship FAILED: ${last.error || 'see the queenzee terminal'}. `
        + 'Raising a fresh request requires the failure to be understood first — tell your human.'));
      return { verdict: 'deny', next: steps[steps.length - 1], steps, targets: t };
    }
    const r = await requestShip({ xellId, zeeId, reason, targets: t });
    if (r.ok === false) return deny(gate('human', 'deny', `Ship request refused: ${r.reason}`));
    steps.push(gate('human', 'wait',
      `All gates green — ship request raised for ${t.join(' + ')} @ ${String(r.request.commit).slice(0, 8)}. `
      + 'A HUMAN must approve it in the ZEEHIVE console. Tell them it is waiting; nothing you do speeds it up. '
      + 'Keep polling — approval flips this to shipping, then live.'));
    return { verdict: 'wait', next: steps[steps.length - 1], steps, targets: t, request: r.request };
  }

  const m = {
    pending: gate('human', 'wait',
      `Ship request pending (${open.targets?.join(' + ')} @ ${String(open.commit).slice(0, 8)}) — a human has `
      + 'not decided yet. Tell them it is waiting in the console; keep polling.'),
    approved: gate('ship', 'wait',
      'APPROVED — the queenzee is taking the prod lock for your xell (the prod build API rejects any '
      + 'non-holder) and will build from local main. Keep polling.'),
    shipping: gate('ship', 'wait',
      'SHIPPING — the queenzee holds the prod lock for your xell and is building production now. Keep polling.'),
  };
  return { verdict: 'wait', next: m[open.status], steps: [...steps, m[open.status]], targets: t, request: open };
}

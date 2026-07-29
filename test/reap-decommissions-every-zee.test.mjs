// A TEARDOWN MUST LEAVE NO ZEE ROW CLAIMING TO BE ALIVE.
//
// THE BUG. reapXell()'s "stop the zee" step was gated on the statuses that mean a turn is in
// flight — `status IN ('spawning','online','working','idle')`. Everything else was left exactly as
// it was, and 'errored' is everything else: a headless turn that dies on an API 429/529 lands
// there. So retiring such a xell removed the worktree, the containers and the cage, and left the
// zee row with decommissioned_at NULL, name set and cli_active TRUE — a row asserting a live,
// ATTACHED agent inside a cage that no longer exists. Nothing revisits a zee row once its xell is
// retired (the monitor joins on live xells, the boot sweep skips retired ones), so those rows never
// age out: six were in the live meta-DB when this was written, the oldest four days old, and they
// are indistinguishable from the real thing to anyone counting live agents. They are what
// `scripts/audit-agent-sessions.mjs` reports as GHOST ROWS.
//
// WHAT IS ASSERTED, on a real reap of a throwaway xell (PROVISION_MODE=simulate, so the row
// retires and no machine is touched):
//   1. an 'errored' zee is stamped decommissioned_at and loses cli_active — the ghost is gone;
//   2. its status is PRESERVED as 'errored' — that is the diagnosis of how the run ended, and
//      last_stop_reason is the detail; overwriting it with 'stopped' would delete it;
//   3. a mid-turn zee ('working') still becomes 'stopped', exactly as before;
//   4. EVERY non-decommissioned zee of the xell is stamped, not just the newest — a cxell xell can
//      outlive several zees, and one-at-a-time was the other half of the leak;
//   5. an already-decommissioned row is not re-stamped (its timestamp is history, not a fact to
//      overwrite on every idempotent re-reap).
process.env.PROVISION_MODE = 'simulate';        // before any import: no machine may be touched

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { reapXell } = await import('../server/src/queenzee/reaper.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
const tmp = mkdtempSync(join(tmpdir(), 'reapzee-'));
let projId = null;
const madeXells = [];

try {
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'master') RETURNING id`,
    [`zt-reapzee-${tag}`, join(tmp, 'repo')])).id;
  const xource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [projId]);
  const runtime = await one(`SELECT id FROM agent_runtime ORDER BY sort_order LIMIT 1`);

  // worktree_path points at nothing on disk, so no despawn script can ever run against a real folder
  const mkXell = async (slug) => {
    const x = await one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled)
         VALUES ($1,$2,$3,$4,$5,'ready',false) RETURNING id, slug`,
      [projId, xource.id, slug, `spinoff/${slug}`, join(tmp, `gone-${slug}`)]);
    madeXells.push(x.id);
    return x;
  };
  const mkZee = async (xellId, status, extra = {}) => one(
    `INSERT INTO zee (xell_id, runtime_id, attach_mode, status, entrypoint, viewer_kind, name,
                      cli_active, last_stop_reason, decommissioned_at)
       VALUES ($1,$2,'headless-spawn',$3,'cxell-cli','ssh-terminal',$4,true,$5,$6) RETURNING *`,
    [xellId, runtime.id, status, `zt-zee-${tag}`, extra.stopReason || null, extra.decommissionedAt || null]);
  const zeeRow = (id) => one(`SELECT * FROM zee WHERE id=$1`, [id]);

  // ── 1+2. the errored zee: stamped, de-attached, diagnosis intact ─────────────
  console.log("\n── an 'errored' zee is decommissioned like any other ──");
  const x1 = await mkXell(`zt-err-${tag}`);
  const errored = await mkZee(x1.id, 'errored',
    { stopReason: 'API Error: Repeated 529 Overloaded errors.' });
  const r1 = await reapXell(x1.id, 'test-errored');
  ok(r1.ok === true, 'the reap succeeds');
  const after = await zeeRow(errored.id);
  ok(after.decommissioned_at !== null, 'decommissioned_at is stamped (this is the ghost-row fix)');
  ok(after.cli_active === false, 'cli_active is cleared — there is no cage left to be attached to');
  ok(after.name === null, 'the display name is released');
  ok(after.status === 'errored', "the status stays 'errored' — how the run ended is not overwritten");
  ok(after.last_stop_reason === 'API Error: Repeated 529 Overloaded errors.',
     'and last_stop_reason, the actual diagnosis, survives the teardown');
  ok(r1.zees_decommissioned === 1, 'the result reports how many rows it stamped');

  // ── 3. a mid-turn zee still ends up 'stopped' ────────────────────────────────
  console.log('\n── a mid-turn zee is stopped exactly as before ──');
  const x2 = await mkXell(`zt-work-${tag}`);
  const working = await mkZee(x2.id, 'working');
  await reapXell(x2.id, 'test-working', { force: true });     // force: it IS mid-turn by design
  const w = await zeeRow(working.id);
  ok(w.status === 'stopped' && w.decommissioned_at !== null && w.cli_active === false,
     "'working' → 'stopped', stamped and de-attached");

  // ── 4+5. every row, and only the ones that need it ───────────────────────────
  console.log('\n── every non-decommissioned zee of the xell, not just the newest ──');
  const x3 = await mkXell(`zt-many-${tag}`);
  const oldStamp = '2026-01-01T00:00:00.000Z';
  const already = await mkZee(x3.id, 'stopped', { decommissionedAt: oldStamp });
  const ghost1 = await mkZee(x3.id, 'errored');
  const ghost2 = await mkZee(x3.id, 'idle');
  const r3 = await reapXell(x3.id, 'test-many', { force: true });
  ok(r3.zees_decommissioned === 2, `only the two live rows were stamped (${r3.zees_decommissioned})`);
  ok((await zeeRow(ghost1.id)).decommissioned_at !== null
     && (await zeeRow(ghost2.id)).decommissioned_at !== null,
     'both live rows are stamped — a xell that outlived several zees leaves none behind');
  ok((await zeeRow(ghost2.id)).status === 'stopped', "the 'idle' one becomes 'stopped'");
  ok(new Date((await zeeRow(already.id)).decommissioned_at).toISOString() === oldStamp,
     'an already-decommissioned row keeps its original timestamp (re-reap is idempotent)');

  // no zee row anywhere in this fixture may still claim to be live
  const leftovers = await q(
    `SELECT z.id FROM zee z WHERE z.xell_id = ANY($1) AND z.decommissioned_at IS NULL`, [madeXells]);
  ok(leftovers.length === 0, `no ghost rows left behind by any of the teardowns (${leftovers.length})`);
} finally {
  for (const id of madeXells) await q(`DELETE FROM zee WHERE xell_id=$1`, [id]).catch(() => {});
  for (const id of madeXells) await q(`DELETE FROM container WHERE owner_xell_id=$1`, [id]).catch(() => {});
  for (const id of madeXells) await q(`DELETE FROM xell WHERE id=$1`, [id]).catch(() => {});
  if (projId) await q(`DELETE FROM xource WHERE project_id=$1`, [projId]).catch(() => {});
  if (projId) await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  await pool.end().catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

// QUARANTINE A XELL AFTER CONSECUTIVE TURN DEATHS (ticket #81).
//
// THE CARD: three zees died in a row on one xell — ~$14 burned, 468 lines never landed — and every
// recovery path (swap, re-dispatch) happily started another agent in the same unhealthy cage, because
// nothing had ever counted how many times a CAGE had killed its zee. The streak lives on the XELL
// (migration 216), not the zee — the zee row is replaced on every swap, and it is the cage that is sick.
//
// WHAT IS FENCED HERE:
//   A. the PURE DECISION — decideXellQuarantine: 1 death does NOT fire, QUARANTINE_AFTER_DEATHS (2)
//      does, and the count is clamped/zero-safe;
//   B. the STREAK through the real choke point (noteTurnDeath): a real death bumps
//      xell.consecutive_deaths; a 'none' death (a healthy end_turn) RESETS it to 0 — the cage
//      demonstrably carried an agent through a full turn, so the run is honestly broken;
//   C. the QUARANTINE itself: the second consecutive death stamps quarantined_at / quarantine_deaths /
//      quarantine_reason, returns xell_quarantined:true, and raises the TEND — the quarantine is never
//      silent, and the tend names the count, the last death and what has NOT landed;
//   D. the REFUSAL every spawn/recovery path reads — xellQuarantineRefusal answers a sentence for a
//      quarantined xell and null (carry on) for a clean one;
//   E. the RESCUE arm — clearXellQuarantine clears all four columns, lowers the tend, and is
//      idempotent (clearing a clean xell is a no-op).
//
// Everything it creates is deleted in a finally, whatever happens.
process.env.PROVISION_MODE = 'real';
process.env.TKB_NOTIFY = '0';

import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const {
  QUARANTINE_AFTER_DEATHS, decideXellQuarantine, xellQuarantineRefusal, clearXellQuarantine,
} = await import('../server/src/lib/xell-quarantine.js');
const { q, one, pool } = await import('../server/src/db/pool.js');
const { tendState } = await import('../server/src/lib/status.js');
const revive = await import('../server/src/queenzee/revive.js');

// ── A. PURE DECISION ──────────────────────────────────────────────────────────────────────────
console.log('\n── A. the pure decision ──');
ok(QUARANTINE_AFTER_DEATHS === 2, `threshold is 2 (the incident was 3 — one too late), got ${QUARANTINE_AFTER_DEATHS}`);
ok(decideXellQuarantine({}).quarantine === false && decideXellQuarantine({ consecutive_deaths: 0 }).quarantine === false,
   'a fresh xell (0 deaths) does not fire');
ok(decideXellQuarantine({ consecutive_deaths: 1 }).quarantine === false
   && decideXellQuarantine({ consecutive_deaths: 1 }).count === 1,
   'one death does not fire — it is provider weather, not a verdict on the cage');
ok(decideXellQuarantine({ consecutive_deaths: 2 }).quarantine === true
   && decideXellQuarantine({ consecutive_deaths: 2 }).count === 2,
   'two consecutive deaths fire — the exact pattern of the incident');
ok(decideXellQuarantine({ consecutive_deaths: 99 }).quarantine === true
   && decideXellQuarantine({ consecutive_deaths: -3 }).count === 0,
   'already-over threshold stays fired, and a negative streak clamps to 0');

// ── B/C/D/E against a throwaway postgres ─────────────────────────────────────────────────────
const PID = randomUUID();
const cleanup = async () => {
  try { await q(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* already gone */ }
};
let n = 0;
const xellRow = (id) => one(`SELECT * FROM xell WHERE id=$1`, [id]);

try {
  await q(
    `INSERT INTO project (id, name, repo_root, main_branch)
       VALUES ($1, 'xell-quarantine-test', '/tmp/xq', 'main')`, [PID]);
  const xource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'main') RETURNING *`, [PID]);
  const rt = await one(`SELECT id FROM agent_runtime WHERE key='claude-code-cxell'`);
  const mkXell = async (slug) => one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, self_token_hash)
     VALUES ($1,$2,$3,$4,$5,'working',$6) RETURNING *`,
    [PID, xource.id, slug, `spinoff/${slug}`, `/tmp/xq/${slug}`, `hash-${slug}`]);
  const mkZee = async (xellId) => one(
    `INSERT INTO zee (xell_id, attach_mode, entrypoint, kind, runtime_id, viewer_kind,
                      claude_session_id, model, status)
     VALUES ($1,'headless-spawn','cxell-cli','headless',$2,'ssh-terminal',
             $3,'opus','errored') RETURNING *`,
    [xellId, rt?.id || null, `00000000-0000-4000-8000-0000000000${++n}`]);
  // A 529 is a clean TRANSIENT death: it schedules a revive (so it passes the whole noteTurnDeath
  // path) but touches none of the account-quarantine machinery — the fence stays on the XELL.
  const DEATH = 'API Error: 529 overloaded';
  const notADeath = async (xellId) => {
    const z = await mkZee(xellId);
    return revive.noteTurnDeath({ zeeId: z.id, xellId, slug: (await xellRow(xellId)).slug,
      reason: 'end_turn', source: 'turn' });
  };
  const die = async (xellId) => {
    const z = await mkZee(xellId);
    return revive.noteTurnDeath({ zeeId: z.id, xellId, slug: (await xellRow(xellId)).slug,
      reason: DEATH, source: 'turn' });
  };

  // ── B. the streak: death bumps, a healthy turn RESETS ───────────────────────────────────────
  console.log('\n── B. the streak lives on the xell — a death bumps, a healthy turn resets ──');
  const xR = await mkXell('xq-reset');
  const d1 = await die(xR.id);
  ok(d1.kind === 'transient' && d1.signal === '529' && d1.xell_quarantined === false,
     'a 529 death files as transient/529 and does NOT quarantine a fresh cage');
  ok((await xellRow(xR.id)).consecutive_deaths === 1,
     'after one death the xell streak is 1');

  const h = await notADeath(xR.id);
  ok(h.kind === 'none' && !h.xell_quarantined,
     "a healthy 'end_turn' files as a NON-death (kind none) — the classifier's decision");
  ok((await xellRow(xR.id)).consecutive_deaths === 0,
     'and it RESETS the streak to 0 — the cage demonstrably carried a zee through a full turn');
  ok((await xellRow(xR.id)).quarantined_at === null,
     'a healthy turn does not quarantine anything');

  // ── C. the quarantine fires at the threshold, and it is never silent ───────────────────────
  console.log('\n── C. two consecutive deaths → quarantined + a tend naming the unlanded work ──');
  const xQ = await mkXell('xq-quarantine');
  const c1 = await die(xQ.id);
  ok(c1.xell_quarantined === false && (await xellRow(xQ.id)).consecutive_deaths === 1,
     'first death: streak 1, not yet quarantined');
  ok((await tendState(xQ.id)).open === false,
     'and no tend is raised on a single death — one death is provider weather');

  const c2 = await die(xQ.id);
  ok(c2.xell_quarantined === true, 'the SECOND consecutive death returns xell_quarantined:true');
  const qx = await xellRow(xQ.id);
  ok(qx.consecutive_deaths === 2 && !!qx.quarantined_at && qx.quarantine_deaths === 2,
     'the xell row is stamped: consecutive_deaths 2, quarantined_at set, quarantine_deaths 2');
  ok(!!qx.quarantine_reason && /QUARANTINED after 2 consecutive turn deaths/.test(qx.quarantine_reason),
     'quarantine_reason names the count and the word QUARANTINED');
  ok(/529/.test(qx.quarantine_reason || ''), 'and the last death (529) is on the card');
  ok(/what has NOT landed/i.test(qx.quarantine_reason || '') && /0 landing\(s\)/.test(qx.quarantine_reason || ''),
     'and the card shows what is unlanded — 0 landings and the diff brief (unmeasurable here)');

  const tQ = await tendState(xQ.id);
  ok(tQ.open === true, 'the quarantine raised a TEND — never silent');
  ok(tQ.full && /QUARANTINED after 2 consecutive turn deaths/.test(tQ.full)
     && /what has NOT landed/i.test(tQ.full),
     `the tend carries the quarantine card (${(tQ.full || '').slice(0, 100)}…)`);
  ok(tQ.full && /RESCUE the branch/.test(tQ.full) && /REAP it/.test(tQ.full),
     'and it names BOTH arms of the human decision: rescue the branch or reap the cage');

  // A late death on an ALREADY-quarantined xell bumps the count but never re-stamps or re-tends.
  const c3 = await die(xQ.id);
  ok(c3.xell_quarantined === true && (await xellRow(xQ.id)).consecutive_deaths === 3
     && (await xellRow(xQ.id)).quarantine_deaths === 2,
     'a late death bumps the streak to 3 but leaves the quarantine stamp (deaths=2) untouched');

  // ── D. every spawn/recovery path reads the same refusal ────────────────────────────────────
  console.log('\n── D. the refusal every dispatch/swap/revive path reads ──');
  const refusal = xellQuarantineRefusal(qx);
  ok(!!refusal && /QUARANTINED after 2 consecutive turn deaths/.test(refusal)
     && /NOT be given another agent/.test(refusal),
     'a quarantined xell refuses with the sentence (count + the two arms)');
  ok(xellQuarantineRefusal({ slug: 'clean', quarantined_at: null, consecutive_deaths: 1 }) === null,
     'a clean xell — even one with a streak of 1 — gets null (carry on)');
  ok(xellQuarantineRefusal({}) === null, 'an empty row is null — the guard never fails open');

  // ── E. the human rescue arm ────────────────────────────────────────────────────────────────
  console.log('\n── E. clearXellQuarantine is the rescue arm ──');
  const cleared = await clearXellQuarantine(xQ.id, { by: 'test@console' });
  ok(cleared.ok === true && cleared.was_quarantined === true && cleared.cleared === true,
     'clearing a quarantined xell reports it WAS quarantined');
  const qx2 = await xellRow(xQ.id);
  ok(qx2.quarantined_at === null && qx2.quarantine_deaths === null && qx2.quarantine_reason === null
     && qx2.consecutive_deaths === 0,
     'all four columns are cleared and the streak is back to 0 — a fresh agent may be dispatched');
  ok((await tendState(xQ.id)).open === false, 'and the quarantine tend is lowered');
  ok(xellQuarantineRefusal(qx2) === null, 'the xell no longer refuses agents');

  const again = await clearXellQuarantine(xQ.id, { by: 'test@console' });
  ok(again.ok === true && again.was_quarantined === false,
     'clearing a clean xell is an idempotent no-op — a stale console button never 409s');

} finally {
  await cleanup();
  await pool.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILURE(s)` : '\nall ok');
process.exit(fail ? 1 : 0);

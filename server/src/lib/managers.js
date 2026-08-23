// MANAGER ZEES — the fleet's middle layer.
//
// A manager zee is an ordinary xell (`xell.zee_type='manager'`) whose zee coordinates OTHER zees instead
// of writing code. Everything it can do is still a queenzee verb behind the same walls; what changes
// is WHICH verbs, and that split is the whole design:
//
//   GAINS (fleet reach)                          LOSES (repo reach)
//   ─────────────────────────────────            ─────────────────────────────
//   dispatch workers (stamped as its crew)       zero push/PR access to the xource — `zee land`,
//   converse with them in real time              xellgit push/PR and the landgate's git hook all
//   read PRODUCTION (read-only role)             REFUSE a manager outright, and the landgate raises
//   suggest a xell is done (human confirms)      no request, so there is nothing to approve either
//
// SHIPPING IS NOT BLOCKED. Holding the production database is not a reason to withhold the ship
// gate: a ship is still landed-only, human-approved and queenzee-executed. A manager is often the
// right agent to ask for one — it is the one holding the whole picture.
//
// This module owns the manager's DOMAIN (who manages whom, the crew read model, the messages, the
// done suggestions). The verbs that expose it live in queenzee/self.js; the human side lives in
// api/routes.js. Nothing here despawns anything or moves a ref.
import { existsSync } from 'node:fs';
import { q, one } from '../db/pool.js';
import { broadcast } from './events.js';
import { logline } from './logbus.js';
// What a worker has PRODUCED is a git question, and the two helpers that answer it already exist:
// worktreeDiff for a host worktree (queenzee/monitor.js reads stale claims with it) and cxellDiff
// for a caged zee, whose work is not on the host at all. See crewDiff below for which is asked.
import { worktreeDiff } from './git.js';
import { cxellDiff } from './cxell.js';
// briefReason is the house's one-line normaliser (collapse whitespace, ELIDE with …). Quoting an
// error inside our own prose needs exactly that: a hard slice ends the quote mid-word, which reads
// as a truncated MESSAGE rather than a quoted one ("…so a spawn there would fail. Do ").
import { reasonPair, briefReason } from './status.js';
import { hiveStatus, hiveLabel } from './hive-status.js';
import { sendMessageToXell } from '../queenzee/nudge.js';
// The A2A envelope builder — pure (lib/a2a.js); the lookups that feed it live in postMessage's
// envelopeFor below, so the mapping module stays a table you can read against the plan §3.3.
import { buildEnvelope } from './a2a.js';
import { randomUUID } from 'node:crypto';

// ── who is what ──────────────────────────────────────────────────────────────
export const isManager = (xell) => xell?.zee_type === 'manager';

// The single sentence every refusal shares. Written once so the manager reads the SAME explanation
// wherever it hits the wall — a manager that gets three different stories about why it cannot push
// will keep trying the third one.
export const NO_PUSH_REASON =
  'a MANAGER zee has zero push/PR access to the xource — it writes no code and lands none. This is '
  + 'refused by the queenzee itself (the landgate declines a manager push without even raising a '
  + 'request, so there is no approval that could let it through). If something must change in the '
  + 'repo, dispatch a worker to make it: `zee dispatch --task "…"`.';

// Refuse an action for a manager xell, uniformly. Returns null when the xell is a worker (carry on).
export function refuseForManager(xell, verb) {
  if (!isManager(xell)) return null;
  return { ok: false, status: 'refused', refused: verb, error: NO_PUSH_REASON };
}

// ── what a worker has PRODUCED ───────────────────────────────────────────────
//
// Everything else on a crew row comes from the `zee` row, which is written at TURN BOUNDARIES: a
// worker mid-turn reads as the status (and the cost) it had when its last turn ended. A manager read
// `idle` on a reviewer that had restarted and landed a commit eight minutes earlier, concluded it was
// inert, and spent a whole redundant xell redoing landed work. So the crew row also carries the two
// facts that are true AT THE MOMENT OF THE READ, because they are measured rather than remembered:
// what has LANDED (the ledger) and what has not (the diff).
//
// WHICH DIFF. Same fallback order as timeline.getDiffs, for the same reason: a caged worker commits
// in its private clone and the host worktree stays frozen at the provisioning base until a land or a
// build collects it, so a host-side `git diff` reads 0/0 for a worker that has written all day.
// Ask the cxell first (cxellDiff), fall back to the host worktree (worktreeDiff — the helper
// queenzee/monitor.js reads stale claims with), and answer null rather than 0 when neither can be
// read: "I could not measure it" and "it has produced nothing" must not look the same to a manager
// deciding whether to close a worker out.
//
// THROTTLING: cached per xell, because a manager POLLS this (`zee zees`, and `zee status` carries the
// crew too). A docker exec per worker per poll is not free — timeline.getDiffs caches the same read
// for 12s; this one is a little longer because a crew is read at human/agent cadence, not at 60fps.
const CREW_DIFF_TTL_MS = 15_000;
const crewDiffCache = new Map(); // xell id -> { at, val }

async function crewDiff(row, branch) {
  const hit = crewDiffCache.get(row.id);
  if (hit && Date.now() - hit.at < CREW_DIFF_TTL_MS) return hit.val;
  let val = null;
  // `entrypoint='cxell-cli'` is the provider-agnostic marker of a caged zee (the same predicate the
  // poller and the reaper use). Keying on one runtime KEY instead would send a codex or kimi worker
  // down the host path, where its work is invisible.
  if (row.cxell_live && row.head_commit) {
    const d = await cxellDiff({ ctx: 'default', slug: row.slug, base: row.head_commit }).catch(() => null);
    if (d) val = { ...d, source: 'cxell' };
  }
  if (!val && row.worktree_path && existsSync(row.worktree_path)) {
    const d = await worktreeDiff(row.worktree_path, branch).catch(() => null);
    if (d) val = { ...d, source: 'worktree' };
  }
  crewDiffCache.set(row.id, { at: Date.now(), val });
  return val;
}

// The SOURCE-DIFF GATE for executing a done approval (ticket #75). A held approval is applied only
// when the xell is clean — an EMPTY DIFF AGAINST SOURCE and zero dirty files — because the thing
// actually being protected is unlanded WORK: a zee whose every change is in master's content loses
// nothing by being reaped; a zee holding a diff can lose everything.
//
// WHAT IT MEASURES — and deliberately NOT "unlanded commits". `ahead` (rev-list count of
// main..HEAD) stays positive forever after a successful `zee land`, because landing heals by MERGING
// master into the branch: those merge commits are reachable from the branch and not from main, so
// the count never returns to zero even when the branch's content is byte-identical to master. A
// worker that LANDED is verifiably finished but would read `ahead>0` for ever — gating on it turns a
// discarded decision into a permanently stuck one. The DIFF AGAINST SOURCE tells the truth: an empty
// shortstat (the working tree vs merge-base, which IS the source tip once the branch healed) means
// every change in that branch is in master's content and a teardown loses nothing. Non-empty diff OR
// dirty files → refuse. Unmeasurable-from-something-that-exists → refuse ("I could not read it" must
// never mean yes). Unmeasurable with NOTHING to measure (no worktree, no live cxell — the simulate
// shape every test uses) is clean: there is no work on disk to lose.
//
// Returns:
//   { clean: true, ahead, dirty, diff }            — provably empty diff + clean (the counts ride
//                                                    along for the approval-time evidence)
//   { clean: false, reason, ahead, dirty, diff }   — holds a non-empty diff or dirty files (the
//                                                    legible reason), or the diff could not be read
//                                                    from something that exists.
async function xellGate(row, branch) {
  let d = null, existed = false;
  if (row.cxell_live && row.head_commit) {
    d = await cxellDiff({ ctx: 'default', slug: row.slug, base: row.head_commit }).catch(() => null);
    existed = true;
  }
  if (!d && row.worktree_path && existsSync(row.worktree_path)) {
    d = await worktreeDiff(row.worktree_path, branch).catch(() => null);
    existed = true;
  }
  // The DECISION is pure once `d` is in hand — extracted so test/cxell-diff-base.test.mjs can pin
  // "an unresolvable base must refuse" without docker (it feeds the parsed output of a real script
  // run with a bogus base into this).
  return xellGateDecision(d, existed);
}

// The pure half of xellGate, extracted so it is testable without docker. `d` is a cxellDiff / cxell
// worktreeDiff result (or null when nothing on disk could answer); `existed` is whether anything
// (a live cxell or a worktree) WAS present to ask. The rule: unmeasurable-from-something-that-exists
// must never mean yes.
export function xellGateDecision(d, existed) {
  const ahead = d?.ahead || 0, dirty = d?.dirty || 0;
  const diff = { files: d?.files || 0, insertions: d?.insertions || 0, deletions: d?.deletions || 0 };
  if (!d) return existed
    ? { clean: false, reason: "the xell's work could not be measured — cannot confirm it is clean before tearing it down",
        ahead, dirty, diff }
    : { clean: true, ahead: 0, dirty: 0, diff: { files: 0, insertions: 0, deletions: 0 } };
  // The diff's BASE was never resolved — $SRC fell back to HEAD inside the cage (cxellDiff.unresolved,
  // from cxellSourceBase's SRC="${SRC:-HEAD}"), so the empty source shortstat is NOT "resolved and
  // empty", it is "could not be measured against the source": the recorded base was likely rewritten
  // away before the first sync. Committed-but-unlanded work is INVISIBLE to this read. Same family
  // as `!d` above — unmeasurable-from-something-that-exists must never mean yes. The mirror of the
  // clean-approval case: an empty source diff is affirmative only when the base was a REAL fork point.
  if (d.unresolved) return { clean: false,
    reason: "the xell's diff base could not be resolved in its cxell (the recorded commit was likely rewritten away) — cannot confirm it is clean before tearing it down",
    ahead, dirty, diff };
  const parts = [];
  // The source-diff shortstat is measured against the branch's FORK POINT off the source — for the
  // worktree path merge-base(ref, HEAD) (worktreeDiff), for the live-cxell path the same fork point
  // computed inside the cage (cxellDiff, cxellSourceBase): the work the branch adds that is NOT in
  // master's content. Non-zero files/insertions/deletions = unlanded WORK — refuse.
  if (diff.files > 0) parts.push(`a non-empty diff against source (+${diff.insertions}/−${diff.deletions} in ${diff.files} file(s)) — that work has not landed`);
  if (dirty > 0) parts.push(`${dirty} dirty file(s)`);
  return parts.length
    ? { clean: false, reason: `it holds ${parts.join(' and ')}`, ahead, dirty, diff }
    : { clean: true, ahead, dirty, diff };
}

// Evidence captured AT APPROVAL TIME for a HELD decision (ticket #75): what was true when the
// approval landed — the last landed sha on master, the unlanded/dirty counts, the source shortstat —
// so the held row's record says why the close was safe. This is the AUDIT half. The apply-time gate
// (xellGate) STILL re-verifies before tearing down, because a resumed turn (the live repro: a manager
// messaging a finished worker flips it back to working) can dirty the tree after the approval.
async function captureDoneEvidence(target) {
  if (!target?.id) return null;
  const [landed, gate] = await Promise.all([
    one(`SELECT count(*)::int AS n, max(new_sha) AS last_sha, max(landed_at) AS last_at
           FROM land_request WHERE xell_id=$1 AND status='landed'`, [target.id]),
    xellGate(target, target.main_branch || 'main').catch(() => null),
  ]);
  return {
    at: new Date().toISOString(),
    landed: { count: landed?.n || 0, last_sha: landed?.last_sha || null, landed_at: landed?.last_at || null },
    clean: gate?.clean ?? null,
    ahead: gate?.ahead ?? null,
    dirty: gate?.dirty ?? null,
    diff: gate?.diff ?? null,
    ...(gate?.reason ? { reason: gate.reason } : {}),
  };
}

// ── the crew ─────────────────────────────────────────────────────────────────
// Every worker this manager dispatched, with the live signals a manager actually decides on: what
// the hive shows, whether it is waiting on a human, and its git position (unlanded work is the one
// thing that must not be reaped). One query + one per-row signal query — this is polled by an agent,
// not rendered at 60fps, so clarity beats cleverness.
export async function crewFor(managerXellId) {
  const rows = await q(
    `SELECT x.id, x.slug, x.branch, x.status, x.head_commit, x.created_at, x.db_coupling,
            x.worktree_path, x.consecutive_deaths, x.quarantined_at, x.quarantine_deaths,
            x.quarantine_reason, p.main_branch,
            z.status AS zee_status, z.cli_active, z.title AS zee_title, z.model,
            (z.entrypoint = 'cxell-cli'
               AND z.status IN ('spawning','online','working','idle')) AS cxell_live,
            t.prompt_text AS task_text,
            -- WHAT IT LANDED. The land ledger, not the worker's own account of itself: a landed row
            -- is a sha that actually reached main, so a manager can tell a worker that has produced
            -- something from one that has only been busy. LANDED only — pending/approved/withdrawn
            -- are asks, and an ask is not a landing.
            lands.n AS landings, lands.last_sha AS last_landed_sha, lands.last_at AS last_landed_at,
            EXISTS(SELECT 1 FROM land_request lr WHERE lr.xell_id=x.id
                     AND lr.status IN ('pending','approved') AND lr.dismissed_at IS NULL) AS land_pending,
            -- queued for the runway (067) — a manager watching a crew needs to know WHY a worker
            -- has gone quiet with unlanded commits, and "it is 2nd in line" is that answer.
            EXISTS(SELECT 1 FROM land_request lh WHERE lh.xell_id=x.id
                     AND lh.status='holding' AND lh.cleared_at IS NULL) AS land_holding,
            EXISTS(SELECT 1 FROM ship_request sr WHERE sr.xell_id=x.id
                     AND sr.status IN ('pending','approved','shipping') AND sr.dismissed_at IS NULL
                     AND sr.deferred_at IS NULL) AS ship_pending,
            EXISTS(SELECT 1 FROM prod_bind_request pbr WHERE pbr.xell_id=x.id AND pbr.status='pending') AS prod_bind_pending,
            EXISTS(SELECT 1 FROM prod_seed_request psr WHERE psr.xell_id=x.id
                     AND psr.status IN ('pending','approved','running') AND psr.dismissed_at IS NULL) AS seed_pending,
            tnd.hook_event_name = 'tend-request' AS tend_pending,
            -- WHY it raised the tend: a manager reading "it needs a human" and nothing else cannot
            -- tell whether that is its business or a human's, so the brief reason rides along.
            tnd.reason AS tend_reason,
            EXISTS(SELECT 1 FROM done_suggestion ds WHERE ds.target_xell_id=x.id
                     AND ds.status='pending' AND ds.dismissed_at IS NULL) AS done_suggested,
            -- A DECIDED-but-not-yet-applied done: the human (or policy) approved while the xell was
            -- mid-turn and the approval is HELD until the turn ends (ticket #75). This must be told
            -- apart from done_suggested -- 'proposed DONE (a human must confirm)' is FALSE for it:
            -- the decision is already made, and it is waiting for the turn to end / the xell to be
            -- clean, not for a human.
            ds.done_status AS done_suggestion_status,
            ds.done_result AS done_suggestion_result,
            (SELECT zm.body FROM zee_message zm WHERE zm.from_xell_id=x.id AND zm.to_xell_id=$1
               ORDER BY zm.created_at DESC LIMIT 1) AS last_message,
            (SELECT zm.created_at FROM zee_message zm WHERE zm.from_xell_id=x.id AND zm.to_xell_id=$1
               ORDER BY zm.created_at DESC LIMIT 1) AS last_message_at
       FROM xell x
       -- LEFT, not inner: the FK makes a projectless xell impossible, and if that ever stopped
       -- being true a manager must lose a BRANCH NAME here, never a worker off its crew list.
       LEFT JOIN project p ON p.id = x.project_id
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS n, max(l.landed_at) AS last_at,
                (array_agg(l.new_sha ORDER BY l.landed_at DESC NULLS LAST))[1] AS last_sha
           FROM land_request l WHERE l.xell_id = x.id AND l.status = 'landed') lands ON true
       LEFT JOIN LATERAL (
         SELECT * FROM zee zz WHERE zz.xell_id = x.id
          ORDER BY CASE WHEN zz.status IN ('spawning','online','working','idle') THEN 0 ELSE 1 END,
                   zz.created_at DESC LIMIT 1) z ON true
       LEFT JOIN LATERAL (
         SELECT * FROM task tt WHERE tt.xell_id = x.id ORDER BY tt.created_at DESC LIMIT 1) t ON true
       LEFT JOIN LATERAL (
         SELECT se.hook_event_name, se.raw->>'reason' AS reason FROM session_event se
          WHERE se.xell_id=x.id AND se.hook_event_name IN ('tend-request','tend-clear')
          ORDER BY se.ts DESC LIMIT 1) tnd ON true
       LEFT JOIN LATERAL (
         SELECT ds.status AS done_status, ds.result AS done_result
           FROM done_suggestion ds
          WHERE ds.target_xell_id = x.id AND ds.dismissed_at IS NULL
            AND ds.status IN ('pending','approved-held')
          ORDER BY ds.requested_at DESC LIMIT 1) ds ON true
      WHERE x.manager_xell_id = $1 AND x.status <> 'retired'
      ORDER BY x.created_at`, [managerXellId]);

  // The diffs run CONCURRENTLY (independent read-only git reads, mostly served from the cache) —
  // one crew is a handful of workers, and doing them in series would add a docker exec's latency per
  // worker to every poll.
  const diffs = new Map(await Promise.all(
    rows.map(async (r) => [r.id, await crewDiff(r, r.main_branch || 'main').catch(() => null)])));

  return rows.map((r) => {
    const d = diffs.get(r.id);
    // the tend's reason in both forms: one line for the waiting summary, the whole text on the row
    // (a manager has no console to hover and no terminal to open — a clipped tail would be lost).
    const why = reasonPair(r.tend_reason);
    const hive = hiveStatus(
      { ...r, is_production: false },
      { landPending: r.land_pending, shipPending: r.ship_pending, tendPending: r.tend_pending,
        prodBindPending: r.prod_bind_pending, seedPending: r.seed_pending,
        doneSuggested: r.done_suggested, landHolding: r.land_holding },
    );
    // A HELD done approval (ticket #75): the decision is made and the reaper will apply it once the
    // turn ends and the xell is clean — so the legible "what it waits for" is that, NOT a human.
    const doneHeld = r.done_suggestion_status === 'approved-held';
    const doneHeldReason = r.done_suggestion_result?.gate?.reason
      || r.done_suggestion_result?.error
      || (r.done_suggestion_result?.held ? 'the turn has not ended yet' : null);
    const waiting = [
      r.land_pending && 'a landing is HELD for a human',
      r.ship_pending && 'a ship is awaiting a human',
      r.prod_bind_pending && 'it asked for the PROD database',
      r.seed_pending && 'it asked for production to be SEEDED',
      r.tend_pending && `it raised a TEND (needs a human)${why.brief ? `: ${why.brief}` : ''}`,
      r.status === 'awaiting-done' && 'it proposed DONE (a human must confirm)',
      r.done_suggested && 'you already suggested it is done (awaiting a human)',
      doneHeld && `it is APPROVED and HELD for done — ${doneHeldReason || 'waiting for the turn to end'}`,
    ].filter(Boolean);
    return {
      xell_id: r.id, slug: r.slug, branch: r.branch, status: r.status,
      hive_status: hive, hive_status_label: hiveLabel(hive),
      zee_status: r.zee_status || null,
      // WORKING is the zee's own status, and ATTACHED is the monitor's probe — two different facts,
      // reported under two different names. They used to be ORed into `working`, and for a cxell
      // worker that is simply wrong: the probe is a broad pgrep inside the cage, and once anyone has
      // talked to that worker, zee-attach.sh leaves `claude --resume` in its pane for the life of the
      // container, so the flag goes true on the first attach and never comes back down. A manager
      // read five finished workers as busy for a whole session on the strength of it — and this read
      // model is the only instrument a manager has.
      working: r.zee_status === 'working',
      attached: r.cli_active === true,
      model: r.model || null, title: r.zee_title || null,
      task: r.task_text ? String(r.task_text).split('\n')[0].slice(0, 160) : null,
      head_commit: r.head_commit || null,
      // WHAT IT HAS PRODUCED, in the two halves a manager decides on:
      //   landings — what reached main (count, the last sha, when). A worker with landings has
      //     produced something whatever its status says.
      //   diff     — what has NOT: `ahead` unlanded commits and `dirty` uncommitted files, plus the
      //     shortstat, the live head, and WHERE it was read from. null = could not be measured (no
      //     worktree on disk, cxell unreachable) — never silently 0.
      // The manual's own rule ("never suggest done over unlanded work") is checked on diff.ahead.
      landings: { count: r.landings || 0,
                  last_sha: r.last_landed_sha || null,
                  landed_at: r.last_landed_at || null },
      diff: d ? { ahead: d.ahead || 0, dirty: d.dirty || 0, files: d.files || 0,
                  insertions: d.insertions || 0, deletions: d.deletions || 0,
                  head: d.head || null, source: d.source } : null,
      // QUARANTINE (ticket #81) — a cage that killed N zees in a row is refused every agent until a
      // human decides. A manager must see it on the crew row the moment it is true, not discover it
      // as a dispatch refusal; the reason carries the count and the unlanded-work brief.
      quarantined: !!r.quarantined_at,
      consecutive_deaths: r.consecutive_deaths || 0,
      quarantine_deaths: r.quarantine_deaths || null,
      quarantine_reason: r.quarantine_reason || null,
      waiting_on_human: waiting,
      // A HELD done approval is a distinct flag from `done_suggested` (which is only the PENDING,
      // un-decided card): this one is DECIDED and waiting to be APPLIED (ticket #75). The reason the
      // apply is held — still mid-turn, or holding unlanded/dirty work — is legible in the text.
      done_held: doneHeld,
      done_held_reason: doneHeld ? (doneHeldReason || 'the turn has not ended yet') : null,
      tend: r.tend_pending ? { open: true, reason: why.brief, full: why.full } : null,
      last_message: r.last_message ? String(r.last_message).slice(0, 300) : null,
      last_message_at: r.last_message_at || null,
    };
  });
}

// Resolve one of MY workers by slug or id. Refusing to resolve a stranger is what keeps a manager
// scoped to its own crew — there is no verb here that can name a xell it did not dispatch.
export async function workerOf(managerXellId, slugOrId) {
  const key = String(slugOrId || '').trim();
  if (!key) return null;
  const byId = /^[0-9a-f-]{36}$/i.test(key);
  return one(
    `SELECT * FROM xell WHERE manager_xell_id=$1 AND status <> 'retired' AND ${byId ? 'id::text' : 'slug'}=$2`,
    [managerXellId, key]);
}

// ── messages (manager ⇄ worker) ──────────────────────────────────────────────
// STORE, then DELIVER. The row is the durable inbox (a worker mid-turn, or asleep, still finds it);
// delivery types the text into the recipient's live cxell session so a conversation actually happens
// where the agent — and any watching human — is looking. Delivery failure is recorded, never thrown:
// an undelivered message is still a message, and pretending otherwise loses it.
//
// The A2A ENVELOPE (plan §4, DR-3) rides in meta.a2a: ids only, plus the one stored flag (canceled).
// The two lookups below are the ONLY non-pure part of the stamp — the envelope itself is built by
// the pure buildEnvelope (lib/a2a.js). contextId is reused across the ordered (from,to) pair — the
// first exchange mints it, every later one inherits it; referencedTaskId is the most recent
// directive the RECIPIENT sent the SENDER, which is the task a report/message answers.
async function envelopeFor({ messageId, from, to, kind, referencedTaskId = null }) {
  let contextId = null;
  if (from?.id && to?.id) {
    const prior = await one(
      `SELECT meta->'a2a' AS a2a FROM zee_message
        WHERE from_xell_id=$1 AND to_xell_id=$2 AND meta->'a2a'->>'contextId' IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`, [from.id, to.id]);
    contextId = prior?.a2a?.contextId || null;
  }
  // An explicit referencedTaskId (the A2A write side naming the task a reply answers) wins over the
  // derived one — a reply must never be orphaned by an intervening directive. Existing callers pass
  // null and get the derived lookup, unchanged.
  let referenced = referencedTaskId;
  if (!referenced && from?.id && to?.id && kind !== 'directive') {
    const dir = await one(
      `SELECT meta->'a2a'->>'taskId' AS task_id FROM zee_message
        WHERE from_xell_id=$1 AND to_xell_id=$2 AND kind='directive'
          AND meta->'a2a'->>'taskId' IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`, [to.id, from.id]);
    referenced = dir?.task_id || null;
  }
  return buildEnvelope({ messageId, kind, contextId, referencedTaskId: referenced });
}

export async function postMessage({ from, to, body, kind = 'message', by = null, deliver = true, referencedTaskId = null }) {
  const text = String(body || '').trim();
  if (!text) throw new Error('a message needs a body');
  // The row id is minted here, not by the DEFAULT, because the A2A envelope reuses it as
  // messageId (DR-3: the row stays authoritative, the envelope stores identity only).
  const messageId = randomUUID();
  const envelope = await envelopeFor({ messageId, from, to, kind, referencedTaskId });
  const row = await one(
    `INSERT INTO zee_message (id, project_id, from_xell_id, from_slug, to_xell_id, to_slug, kind, body, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`,
    [messageId, from?.project_id || to?.project_id, from?.id || null, from?.slug || by || 'queenzee',
     to?.id || null, to?.slug || null, kind, text.slice(0, 20000),
     JSON.stringify({ by: by || from?.slug || 'queenzee', a2a: envelope })]);

  let delivery = { sent: false, reason: 'delivery not attempted' };
  if (deliver && to?.id) {
    const prefix = kind === 'reflection'
      ? `🪞 REFLECTION from ${from?.slug || 'a worker'}`
      : kind === 'directive' ? `🐝 MANAGER ${from?.slug || ''}`
      : `✉ ${from?.slug || 'zee'}`;
    // `messageId` is what lets a delivery that dies LATER come back and correct this row: every
    // delivery is fire-and-forget, so `sent` below means it started (queenzee/nudge.js).
    delivery = await sendMessageToXell(to.id, { text: `${prefix}: ${text}`, by: from?.slug || 'queenzee',
                                               messageId: row.id });
  }
  // …which is also why this stamp must not clobber a correction that got here first: a resume can
  // fail within a millisecond (no cage, no daemon), i.e. before this line runs. The guard is the
  // marker the correction writes, so the last word belongs to whichever of the two is the truth
  // rather than to whichever won a race — and a blocked stamp still reads its row back to return.
  const done = await one(
    `UPDATE zee_message SET delivered=$2, delivery=$3::jsonb
      WHERE id=$1 AND NOT COALESCE((delivery->>'undelivered')::boolean, false) RETURNING *`,
    [row.id, !!delivery.sent, JSON.stringify(delivery)])
    || await one(`SELECT * FROM zee_message WHERE id=$1`, [row.id]);
  broadcast('zee-message', { id: done.id, to_xell_id: done.to_xell_id, from_xell_id: done.from_xell_id, kind });
  logline('crew', `${done.from_slug || '?'} → ${done.to_slug || 'console'} (${kind}): `
    + `${text.replace(/\s+/g, ' ').slice(0, 120)}`
    + (delivery.sent ? ` [${delivery.delivery || 'delivered'}]` : ` [not delivered: ${delivery.reason || delivery.error || '—'}]`));
  return { ok: true, message: done, delivered: !!delivery.sent, delivery };
}

// WHAT A DELIVERY ACTUALLY PROMISES, in one sentence, for the agent or human that sent the message.
// There are THREE deliveries (queenzee/nudge.js sendMessageToXell → lib/zee-turn.js
// decideMessageDelivery) and only ONE of them means "it is reading this now" — yet `zee say` used to
// answer "Delivered into <slug>'s live session — it will answer there" for every message it managed
// to hand off, including the ones that reached nobody at all. A manager acts on that sentence: it
// stops watching, and the instruction is never carried out.
export function deliveryReceipt(delivery, slug, why = null) {
  switch (delivery) {
    case 'resumed':
      return `RESUMED ${slug} — its turn had already ENDED, so the queenzee restarted its session with `
        + 'your message as the prompt. It is acting on it now; watch its status rather than re-sending.';
    case 'queued':
      return `QUEUED for ${slug} — it is MID-TURN, so the message is held in its cxell and typed into `
        + 'its session the moment this turn ends. It has NOT read it yet.';
    case 'typed':
      return `TYPED into ${slug}'s live session — it will answer there.`;
    default:
      return `Stored for ${slug} but NOT delivered live (${why || 'no live cxell'}) — `
        + 'it will read it with `zee inbox` on its next turn.';
  }
}

// This xell's inbox. Unread by default (an agent polling its own inbox wants what it has not seen);
// `all` returns the recent history. Reading MARKS READ — the read model and the receipt are the same
// call on purpose, so a message cannot be "delivered, seen, and still nagging".
export async function inboxFor(xellId, { all = false, limit = 50 } = {}) {
  const rows = await q(
    `SELECT * FROM zee_message WHERE to_xell_id=$1 ${all ? '' : 'AND read_at IS NULL'}
      ORDER BY created_at DESC LIMIT $2`, [xellId, Math.min(200, Math.max(1, limit))]);
  const unread = rows.filter((r) => !r.read_at).map((r) => r.id);
  if (unread.length) await q(`UPDATE zee_message SET read_at=now() WHERE id = ANY($1::uuid[])`, [unread]);
  return rows.map((r) => ({
    id: r.id, from: r.from_slug, kind: r.kind, body: r.body,
    at: r.created_at, was_unread: unread.includes(r.id),
    // The A2A envelope's ids, additively — present only when the row carries one (plan §5: old
    // rows stay exactly as they were; no backfill, DR-4). taskId is the row's own when it opened
    // the task, else the referencedTaskId — the task the reply belongs to (a2a.js rowToMessage).
    ...(r.meta?.a2a ? { a2a: { taskId: r.meta.a2a.taskId || r.meta.a2a.referencedTaskId || null,
                               contextId: r.meta.a2a.contextId || null } } : {}),
  }));
}

// A xell's MESSAGE HISTORY — the manager⇄worker conversation as the CONSOLE reads it. A worker sees
// the directives its manager sent it (via `zee say`) and the reports it sent back; a manager sees
// the same conversation from its own side. Human-facing, so READING marks NOTHING read — the
// agent's own `zee inbox` is the receipt; this is the audit view, and a human looking at the
// history must not clear an agent's unread flags.
export async function messagesForXell(xellId) {
  const rows = await q(
    `SELECT id, from_xell_id, from_slug, to_xell_id, to_slug, kind, body, delivered, read_at, created_at
       FROM zee_message
      WHERE from_xell_id=$1 OR to_xell_id=$1
      ORDER BY created_at DESC LIMIT 200`,
    [xellId]);
  return rows.map((r) => ({
    id: r.id,
    from: r.from_slug, from_xell_id: r.from_xell_id,
    to: r.to_slug, to_xell_id: r.to_xell_id,
    kind: r.kind, body: r.body,
    delivered: r.delivered, read_at: r.read_at,
    at: r.created_at,
  }));
}

// ── a HUMAN changed a manager's crew underneath it ───────────────────────────
//
// A manager plans around WHO is in each of its xells: it dispatched a Scout there, so it says
// `zee say --to <slug>` expecting a Scout. When a human swaps that zee from the console
// (POST /api/xells/:id/swap) the persona changes and the manager asked for none of it — and until
// this existed, nothing told it. It would keep briefing an agent that had left, and the next thing
// it heard from that xell would arrive in a voice it did not recognise.
//
// So the swap lands in the manager's own inbox, through the same store-then-deliver path a worker's
// report takes: the row is durable (it reads it with `zee inbox` on its next turn) and it is typed
// into its live session if it has one. It is a REPORT, not a directive — nothing is being asked of
// it, and the swap has already happened.
//
// Lives here, beside postMessage, for the same reason the done-suggestion notifications do: what a
// manager is TOLD about its crew is one subject, and the swap path should not be the place that
// invents its own wording for it.
export async function notifyManagerOfSwap({ manager, target, harness, previous = null, by = 'human@console' }) {
  if (!manager || !target || !harness) throw new Error('a swap notification needs a manager, a target xell and a harness');
  const was = previous?.harness_key || previous?.harness_label || null;
  return postMessage({
    from: null, to: manager, kind: 'report', by,
    body: `A HUMAN swapped the zee in your worker ${target.slug}: it now wears "${harness.key}"`
      + `${harness.label ? ` (${harness.label})` : ''}${was ? `, replacing ${was}` : ''}. `
      + `The xell is otherwise untouched — same branch (${target.branch}), same commits, same containers, `
      + 'same database, same work-item card, and it still reports to you. The incoming zee was briefed '
      + 'that it INHERITED the xell: what the previous zee was asked to do, what it last reported, and '
      + 'what is on the branch. You did not ask for this and nothing of yours was lost — re-brief it '
      + `with \`zee say --to ${target.slug} --message "…"\` if your plan for that work has changed.`,
  });
}

// ── a swap that HALF-HAPPENED — the outgoing zee is gone and the new one never started ──────
//
// notifyManagerOfSwap above is the SUCCESS sentence, and for a long time it was the only one: the
// swap core told the manager after the dispatch returned, so the one path where a manager most
// needs telling — the dispatch THREW — said nothing at all. That is not a hypothetical failure
// mode; the spawn is the flakiest step in this system (a transient upstream 529 killed a zee on
// this very feature), and the state it leaves behind is the worst kind: the previous zee is already
// retired, the xell already wears the new persona, and NOTHING is running in it. The human who
// clicked gets an error back. The manager, until now, just watched a crew member go quiet — and a
// quiet worker is the one thing a manager is built to wait patiently for.
//
// So this is its own wording, deliberately not a variation on the success one. It must answer the
// three questions a manager will otherwise burn a turn on: what happened to the COMMITS, what state
// the XELL is in now, and what (if anything) it should do about it.
export async function notifyManagerOfHalfSwap({ manager, target, harness, previous = null,
                                                by = 'human@console', error = null, collected = null }) {
  if (!manager || !target || !harness) throw new Error('a half-swap notification needs a manager, a target xell and a harness');
  const was = previous?.harness_key || previous?.harness_label || null;
  const head = collected?.collected && collected.head ? String(collected.head).slice(0, 8) : null;
  return postMessage({
    from: null, to: manager, kind: 'report', by,
    body: `A HUMAN tried to swap the zee in your worker ${target.slug} and THE NEW ZEE DID NOT START: `
      + `${briefReason(error || 'the dispatch failed', 300)}\n\n`
      + `That leaves ${target.slug} HALF-SWAPPED, and this is the part you cannot see from \`zee zees\` `
      + `alone: the previous zee${was ? ` (${was})` : ''} was already retired before the spawn was `
      + `attempted, so there is NO zee in that xell now. It wears "${harness.key}"`
      + `${harness.label ? ` (${harness.label})` : ''} and nothing is running in it — do not wait for it `
      + 'to report; it has no agent to report with.\n\n'
      // WHAT HAPPENED TO THE COMMITS, and only what is actually known. The no-collect branch must
      // not borrow the reassuring half of the other one: "the branch is as the worktree last saw it"
      // is a sentence about a worktree, and one of the ways to reach this path is that there is no
      // worktree at all (the failure text then contradicts itself in the same paragraph).
      + (head
        ? `Nothing was lost. The outgoing zee's commits were collected onto the host worktree first `
          + `(HEAD ${head}), so the branch (${target.branch}), its commits, the containers, the database `
          + 'and the work-item card are all exactly where they were.'
        : `Nothing was collected from the old cage (${briefReason(collected?.reason || 'no reason recorded', 200)}). `
          + 'The swap destroyed nothing either — it never got as far as recreating a cage — but do not '
          + 'assume anything that zee committed INSIDE its cage is on the branch: it was not collected, '
          + 'and a cage that is recreated later takes its uncollected commits with it.')
      + '\n\nThe xell is flagged for a human in the console (it shows `tend?` with this same reason), so '
      + 'somebody has been asked to look. If it is your crew you can retry it yourself once the reason '
      + `is fixed: \`zee swap --to ${target.slug} --harness ${harness.key}\`. Re-planning around a xell `
      + 'with nobody in it is the mistake this message exists to prevent.',
  });
}

// ── done suggestions (a manager proposes SOMEONE ELSE is finished) ───────────
// Deliberately not `zee done`: that is a zee proposing its own completion. This proposes another
// xell's, so it can never be self-serviceable — it raises a card and a `done?` prompt, and a HUMAN
// confirms (with a typed confirmation in the console). The queenzee does the marking.
export async function suggestDone({ manager, target, reason = null }) {
  if (!manager || !target) throw new Error('suggest-done needs a manager and a target xell');
  if (manager.id === target.id) {
    throw new Error('a manager cannot suggest ITSELF done — use `zee done --summary "…"` for your own job');
  }
  // An 'approved-held' row is the same ask still live — the decision was made but the reap is
  // waiting on the turn to end, so raising a second card would stack a duplicate the human never asked for.
  const open = await one(
    `SELECT * FROM done_suggestion WHERE target_xell_id=$1 AND status IN ('pending','approved-held') AND dismissed_at IS NULL`,
    [target.id]);
  if (open) {
    return { ok: true, suggestion: open, note: open.status === 'approved-held'
      ? 'a done decision for that xell is already made and being held until its turn ends'
      : 'a done suggestion for that xell is already awaiting a human' };
  }
  const row = await one(
    `INSERT INTO done_suggestion (project_id, manager_xell_id, manager_slug, target_xell_id, target_slug, reason)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [target.project_id, manager.id, manager.slug, target.id, target.slug, reason]);
  broadcast('done-suggestion', row);
  broadcast('xell', { id: target.id });

  // Operator policy: auto-DONE — a project can choose to confirm a manager's done suggestion with no
  // human in the loop. It ONLY applies to a manager's recommendation (a done_suggestion row is
  // manager-raised by construction; a worker's OWN `zee done` still needs a human), which is the
  // "only if recommended by manager" of the policy. The reap still runs through the SAME guards:
  // an actively-working xell is refused and the card stays open for a human (decideDoneSuggestion →
  // refuseApproval). Nothing about the teardown is bypassed — only the human decision.
  const project = await one(`SELECT * FROM project WHERE id=$1`, [target.project_id]);
  if (project?.auto_done) {
    logline('crew', `AUTO-CONFIRMING done suggestion for ${target.slug} from ${manager.slug} — auto-done policy (no human review)`);
    const approved = await decideDoneSuggestion(row.id, 'approved', 'auto-done@policy');
    return { ok: true, suggestion: approved, note: 'auto-done by policy — the xell is being marked done' };
  }

  logline('crew', `${manager.slug} SUGGESTS ${target.slug} is done — awaiting human confirmation${reason ? `: ${reason}` : ''}`);
  return {
    ok: true, suggestion: row,
    message: `Suggested that ${target.slug} is done. A HUMAN must confirm it in the console (the xell now `
      + 'shows `done?`), and their confirmation is what marks the task done and tears the cxell down — '
      + 'you cannot do that yourself, and you cannot approve your own suggestion. Its commits are '
      + 'collected first; if it still has unlanded work, tell it to `zee land` before this is confirmed.',
  };
}

export async function listDoneSuggestions(projectId, { open = true } = {}) {
  return q(
    `SELECT ds.*, x.slug AS live_target_slug, x.status AS target_status,
            m.slug AS live_manager_slug
       FROM done_suggestion ds
       LEFT JOIN xell x ON x.id = ds.target_xell_id
       LEFT JOIN xell m ON m.id = ds.manager_xell_id
      WHERE ds.project_id=$1 AND ds.dismissed_at IS NULL
        ${open ? `AND ds.status IN ('pending','approved-held')` : ''}
      ORDER BY ds.requested_at DESC LIMIT 50`, [projectId]);
}

export async function dismissDoneSuggestion(id, by = 'human@console') {
  const row = await one(
    `UPDATE done_suggestion SET dismissed_at=now(), decided_by=COALESCE(decided_by,$2) WHERE id=$1 RETURNING *`,
    [id, by]);
  broadcast('done-suggestion', row);
  return row;
}

// An approval the queenzee could NOT carry out. With `hold` (the reap refused because the target is
// MID-TURN) the decision is HELD: the row becomes 'approved-held' — still a card, the refusal
// attached — and the reaper applies it the moment the turn ends. Without `hold` the suggestion goes
// BACK to pending, exactly as before.
//
// This exists because the opposite was written first and it lost work-hours: the row was flipped out
// of 'pending' BEFORE the reap, and stamped 'failed' when the reap refused. listDoneSuggestions()
// only ever shows 'pending', so the card left the console, the worker stayed alive, the manager
// heard nothing, and the human believed they had closed it. Five of one manager's crew sat in that
// state in a single hour. A decision that did not happen must not consume the ask that raised it.
//
// `notify` gates the manager message. The FIRST hold of an approval tells the manager once ("it was
// approved but the xell is mid-turn; it will close itself"); a re-hold of the SAME held card (a
// human clicking approve again while it is still mid-turn) must not spam a second copy. Success at
// apply time is reported separately by the reaper / the human path that finally closes the xell.
async function refuseApproval({ id, row, manager, by, error, detail = null, hold = false, notify = true }) {
  const status = hold ? 'approved-held' : 'pending';
  // Evidence captured AT APPROVAL TIME for a held decision (ticket #75): what was true then — landed
  // sha, unlanded/dirty counts, source shortstat — so the held row's record says why the close was
  // safe, even if a resumed turn (the live repro: a manager messaging a finished worker flips it back
  // to working) dirties the tree afterwards. The apply-time gate still re-verifies.
  const evidence = hold
    ? await captureDoneEvidence(row.target_xell_id ? await one(
        `SELECT x.*, p.main_branch,
                (z.entrypoint = 'cxell-cli' AND z.status IN ('spawning','online','working','idle')) AS cxell_live
           FROM xell x
           LEFT JOIN project p ON p.id = x.project_id
           LEFT JOIN LATERAL (
             SELECT * FROM zee zz WHERE zz.xell_id = x.id
              ORDER BY CASE WHEN zz.status IN ('spawning','online','working','idle') THEN 0 ELSE 1 END,
                       zz.created_at DESC LIMIT 1) z ON true
          WHERE x.id = $1`, [row.target_xell_id]) : null)
    : null;
  const back = await one(
    // A held decision KEEPS decided_at/decided_by — the decision really was made, it just cannot be
    // applied yet. A plain refusal clears them, so the card reads as undecided again.
    `UPDATE done_suggestion SET status=$2,
            decided_at = CASE WHEN $2 = 'approved-held' THEN decided_at ELSE NULL END,
            decided_by = CASE WHEN $2 = 'approved-held' THEN decided_by ELSE NULL END,
            result = $3::jsonb
       WHERE id=$1 RETURNING *`,
    [id, status, JSON.stringify({ refused: true, held: hold, error, by, at: new Date().toISOString(), detail, evidence })]);
  broadcast('done-suggestion', back);
  if (row.target_xell_id) broadcast('xell', { id: row.target_xell_id });
  logline('crew', `done suggestion for ${row.target_slug} was APPROVED by ${by} but the xell was NOT closed `
    + `(${error}) — the card ${hold ? 'is HELD until the turn ends' : 'stays open'}`);
  if (manager && notify) {
    await postMessage({ from: null, to: manager, kind: 'report', by,
      body: hold
        ? `A human APPROVED your suggestion that ${row.target_slug} is done, but the xell is mid-turn, so `
          + `the queenzee could NOT close it yet: ${error} The decision is HELD — it will be applied `
          + `automatically the moment the turn ends, so nothing more is needed from you.`
        : `A human APPROVED your suggestion that ${row.target_slug} is done, but the queenzee could NOT `
          + `close it: ${error} The suggestion is still open in the console — nothing was decided and `
          + `nothing was lost. Check whether ${row.target_slug} really is finished before it is approved again.` })
      .catch(() => {});
  }
  return { ...back, ok: false, refused: true, held: hold, error };
}

// The HUMAN's decision on a done suggestion. Approve → the queenzee marks the xell's task done and
// reaps it, exactly as the console's own "Mark done" does (same function, same reap, same commit
// collection). Reject → the manager is told, and nothing happens to the xell. An approval the reap
// REFUSES because the target is MID-TURN is HELD ('approved-held') and applied by the reaper once
// the turn ends — the decision is not thrown away. A human can override the hold with force:true,
// which tears the xell down mid-turn deliberately.
//
// tasks.js is imported lazily: it reaches back into provisioning/reaping, and a top-level import
// here would make lib ↔ queenzee circular for a call that runs once per human click.
export async function decideDoneSuggestion(id, decision, by = 'human@console', { force = false } = {}) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error(`bad decision: ${decision}`);
  // An 'approved-held' row is the same decision already made — a re-click (or a force) re-attempts
  // the apply rather than being told "already decided". A held card can only be re-decided as
  // 'approved'; there is nothing to reject.
  const prior = await one(`SELECT status FROM done_suggestion WHERE id=$1`, [id]);
  const wasHeld = prior?.status === 'approved-held';
  if (!prior || !(prior.status === 'pending' || (wasHeld && decision === 'approved'))) {
    throw new Error('no such pending done suggestion (already decided?)');
  }
  const row = await one(
    `UPDATE done_suggestion SET status=$2, decided_at=now(), decided_by=$3
       WHERE id=$1 AND status IN ('pending','approved-held') RETURNING *`, [id, decision, by]);
  if (!row) throw new Error('no such pending done suggestion (already decided?)');
  broadcast('done-suggestion', row);

  const manager = row.manager_xell_id ? await one(`SELECT * FROM xell WHERE id=$1`, [row.manager_xell_id]) : null;
  const target = row.target_xell_id ? await one(`SELECT * FROM xell WHERE id=$1`, [row.target_xell_id]) : null;

  if (decision === 'rejected') {
    logline('crew', `done suggestion for ${row.target_slug} REJECTED by ${by}`);
    if (manager) {
      await postMessage({ from: null, to: manager, kind: 'report', by,
        body: `A human REJECTED your suggestion that ${row.target_slug} is done. It keeps working — `
          + 'ask it what remains, or re-scope its task.' }).catch(() => {});
    }
    return row;
  }

  // The one refusal that can never come right: there is no xell left to close. It stays 'failed'
  // (re-raising a card for a xell that does not exist would ask a human an unanswerable question),
  // but the manager is still told rather than left waiting on a decision it will never hear about.
  if (!target) {
    const gone = await one(`UPDATE done_suggestion SET status='failed', result=$2::jsonb WHERE id=$1 RETURNING *`,
      [id, JSON.stringify({ error: 'the target xell no longer exists' })]);
    broadcast('done-suggestion', gone);
    if (manager) {
      await postMessage({ from: null, to: manager, kind: 'report', by,
        body: `A human approved your suggestion that ${row.target_slug} is done, but that xell no longer `
          + 'exists — there was nothing left to close. Removed from your crew.' }).catch(() => {});
    }
    return gone;
  }

  const { markTaskDone } = await import('../queenzee/tasks.js');
  const task = await one(
    `SELECT id FROM task WHERE xell_id=$1 ORDER BY created_at DESC LIMIT 1`, [target.id]);
  let result;
  try {
    if (task) {
      result = await markTaskDone(task.id, by, { force });
      // The reap refused (an ACTIVE zee, a ship this queenzee is deploying right now). The task is
      // NOT done and the xell is untouched. If the refusal is the ACTIVE-zee guard, HOLD the
      // decision (approved-held) and let the reaper apply it when the turn ends; any other refusal
      // goes back to pending.
      if (result?.blocked) {
        // A held card that is re-attempted stays HELD on any refusal (the decision was already made;
        // a ship deploying or a transient error does not un-make it). A fresh approval is held only
        // on the ACTIVE-zee guard — that is the quiescence wait the ticket is about.
        return refuseApproval({ id, row, manager, by, detail: result,
          hold: result.reap?.active === true || wasHeld, notify: !wasHeld,
          error: result.reap?.error || 'the queenzee refused to close that xell.' });
      }
    } else {
      // A xell with no task row (a bare dispatch) is reaped directly — the same path the console's
      // "Mark done" takes for one, so a manager's suggestion can never end in a xell nobody can close.
      const { reapXell } = await import('../queenzee/reaper.js');
      result = { reap: await reapXell(target.id, 'done-suggestion', { force }) };
      if (result.reap?.ok === false) {
        return refuseApproval({ id, row, manager, by, detail: result,
          hold: result.reap?.active === true || wasHeld, notify: !wasHeld,
          error: result.reap?.error || 'the queenzee refused to close that xell.' });
      }
    }
  } catch (e) {
    // An operational failure is still "the xell was not closed" — same treatment, or the card
    // disappears on a transient error and nobody ever learns the click did nothing. It is not an
    // ACTIVE-zee guard, so a FRESH approval is never held as a quiescence wait; a HELD one stays
    // held so the reaper can keep retrying it.
    return refuseApproval({ id, row, manager, by, notify: !wasHeld, hold: wasHeld,
      error: `the teardown threw: ${e.message}` });
  }

  const done = await one(`UPDATE done_suggestion SET result=$2::jsonb WHERE id=$1 RETURNING *`,
    [id, JSON.stringify({ ok: true, marked_by: by })]);
  broadcast('done-suggestion', done);
  broadcast('xell', { id: target.id });
  logline('crew', `done suggestion for ${row.target_slug} CONFIRMED by ${by} — task marked done and the xell reaped`);
  if (manager) {
    const confirmedBy = by === 'auto-done@policy' ? 'The auto-done policy (a human turned it on)'
      : `A human (${by || 'human@console'})`;
    await postMessage({ from: null, to: manager, kind: 'report', by,
      body: `${confirmedBy} CONFIRMED your suggestion: ${row.target_slug} is marked done and its cxell is being torn `
        + 'down (its commits were collected first). One fewer worker in your crew.' }).catch(() => {});
  }
  return done;
}

// ── the reaper's half: apply a HELD approval the moment the turn ends ─────────
//
// A human (or the auto-done policy) approved a done suggestion whose target was mid-turn; the reap
// refused, and refuseApproval recorded the decision as 'approved-held' rather than throwing it away.
// This function re-attempts the apply (the SAME path the human's approve click takes), and is what
// the held-done reaper loop calls on every tick:
//
//   • target's turn has ended → the reap succeeds → the suggestion is finalized 'approved' and the
//     manager is told ONCE (the hold message at refuseApproval already told it the decision was held);
//   • target is STILL mid-turn → the reap refuses with active:true → the row stays 'approved-held'
//     and the next tick re-checks. No message — the manager was told once at hold time;
//   • a DIFFERENT refusal (e.g. a ship is deploying) → also stays held so a later tick retries;
//   • target already gone/retired → a reap that succeeded but crashed before finalizing; finalize.
export async function applyHeldDoneSuggestion(id, by = 'reaper@queenzee') {
  const row = await one(
    `SELECT * FROM done_suggestion WHERE id=$1 AND status='approved-held' AND dismissed_at IS NULL`, [id]);
  if (!row) return { ok: false, applied: false, error: 'no held done suggestion (already applied or decided?)' };

  const target = row.target_xell_id ? await one(
    // The gate (xellGate) needs the same read crewFor has: the LIVE zee's entrypoint/status to know
    // whether to ask the cxell, plus the worktree_path/head_commit/main_branch to measure it against.
    `SELECT x.*, p.main_branch,
            (z.entrypoint = 'cxell-cli' AND z.status IN ('spawning','online','working','idle')) AS cxell_live
       FROM xell x
       LEFT JOIN project p ON p.id = x.project_id
       LEFT JOIN LATERAL (
         SELECT * FROM zee zz WHERE zz.xell_id = x.id
          ORDER BY CASE WHEN zz.status IN ('spawning','online','working','idle') THEN 0 ELSE 1 END,
                   zz.created_at DESC LIMIT 1) z ON true
      WHERE x.id = $1`, [row.target_xell_id]) : null;
  const manager = row.manager_xell_id ? await one(`SELECT * FROM xell WHERE id=$1`, [row.manager_xell_id]) : null;

  // Already retired: the reap that retired it IS the apply this hold was waiting for, and the crash
  // between reap and finalize left the row held. Finalize as applied rather than re-reap a gone xell.
  if (!target || target.status === 'retired') {
    const done = await one(
      `UPDATE done_suggestion SET status='approved', result=$2::jsonb WHERE id=$1 AND status='approved-held' RETURNING *`,
      [id, JSON.stringify({ ok: true, applied_by: by, note: 'the xell was already closed' })]);
    if (!done) return { ok: false, applied: false, error: 'no held done suggestion (already applied or decided?)' };
    broadcast('done-suggestion', done);
    if (target) broadcast('xell', { id: target.id });
    logline('crew', `held done suggestion for ${row.target_slug} finalized by ${by} — the xell was already closed`);
    return { ok: true, applied: true, suggestion: done };
  }

  // THE GATE (ticket #75, STRICTER than a fresh approval): a held approval applies only when the
  // turn is over AND the xell is clean — no unlanded commits, no dirty files. The turn boundary was
  // already checked (we got here only because reapXell/markTaskDone refused while ACTIVE); this adds
  // the two checks the fresh path never made. The thing being protected is unlanded work: a zee with
  // nothing uncommitted and nothing unlanded loses nothing by being reaped; a zee holding a diff can
  // lose everything. Unclean OR unmeasurable → stay held, next tick re-checks.
  const gate = await xellGate(target, target.main_branch || 'main');
  if (!gate.clean) {
    // The reason is written to the ROW (not just returned) so a human, a manager, or the console
    // can read why the approval is still held — "it waits for" must name the actual blocker.
    const refused = await one(
      `UPDATE done_suggestion SET result=$2::jsonb WHERE id=$1 AND status='approved-held' RETURNING *`,
      [id, JSON.stringify({ refused: true, held: true, error: gate.reason, gate,
                            by: row.decided_by || by, at: new Date().toISOString() })]);
    broadcast('done-suggestion', refused);
    logline('crew', `held done suggestion for ${row.target_slug} still held — ${gate.reason}`);
    return { ok: false, applied: false, held: true, still_active: false, gate, error: gate.reason };
  }

  const { markTaskDone } = await import('../queenzee/tasks.js');
  const task = await one(
    `SELECT id FROM task WHERE xell_id=$1 ORDER BY created_at DESC LIMIT 1`, [target.id]);
  let result;
  try {
    if (task) {
      result = await markTaskDone(task.id, by, { force: false });
    } else {
      const { reapXell } = await import('../queenzee/reaper.js');
      result = { reap: await reapXell(target.id, 'done-suggestion-held', { force: false }) };
    }
  } catch (e) {
    // An operational failure is transient — stay held, the next tick retries. The manager was told
    // once at hold time; a retry must not spam.
    logline('crew', `held done suggestion ${String(id).slice(0, 8)} apply threw: ${e.message}`);
    return { ok: false, applied: false, held: true, error: `the teardown threw: ${e.message}` };
  }

  const refused = result?.blocked === true || result?.reap?.ok === false;
  if (!refused) {
    // Applied — the reap retired the xell (and markTaskDone marked the task done). Finalize.
    const done = await one(
      `UPDATE done_suggestion SET status='approved', result=$2::jsonb WHERE id=$1 AND status='approved-held' RETURNING *`,
      [id, JSON.stringify({ ok: true, applied_by: by })]);
    if (!done) return { ok: false, applied: false, error: 'no held done suggestion (already applied or decided?)' };
    broadcast('done-suggestion', done);
    broadcast('xell', { id: target.id });
    logline('crew', `held done suggestion for ${row.target_slug} APPLIED by ${by} — the turn had ended and the xell is reaped`);
    if (manager) {
      await postMessage({ from: null, to: manager, kind: 'report', by,
        body: `The done suggestion you made for ${row.target_slug} was approved while the xell was mid-turn; `
          + `the turn has now ended and the xell has been closed automatically. Nothing more for you to do.` })
        .catch(() => {});
    }
    return { ok: true, applied: true, suggestion: done };
  }

  // Refused. A still-mid-turn refusal is the normal "keep holding" case (the next tick re-checks).
  // A different refusal (a ship deploying, a transient error) is also left held so a later tick
  // retries — the manager was told once at hold time and must not be spammed per tick.
  const active = result?.reap?.active === true || result?.active === true;
  logline('crew', `held done suggestion for ${row.target_slug} still not applied (${result?.reap?.error || 'refused'}) — `
    + (active ? 'the turn is still in flight; will re-check next tick' : 'will retry next tick'));
  return { ok: false, applied: false, held: true, still_active: active,
           error: result?.reap?.error || 'the queenzee refused to close that xell.' };
}

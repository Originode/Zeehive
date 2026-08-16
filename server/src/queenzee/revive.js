// THE REVIVER — a zee whose turn the PROVIDER killed gets it back; one whose CREDENTIAL is dead
// gets a human. Nothing in between, and no human in the loop for either decision.
//
// WHAT WAS MEASURED (the live meta-DB, 2026-08-04). Across 279 zees, ~43 ended their LAST turn on a
// provider or infrastructure error rather than on a decision of their own: 429 x20, 529 x9,
// connection-closed x4, 401 x6, org/model x4, and 7 that said only 'error'. The rate-limit/overload
// cohort died at $0.06–$0.43 — on the FIRST turn, after the xell, its containers and its database
// had been provisioned and paid for in full, with a task nobody ever did. Six of the 401 zees never
// landed anything, ever, and nobody was ever told which account was dead. Until now nothing here
// retried, classified or reported any of it: intake.js wrote status='errored' and stopped.
//
// The split, and why it is the whole design (lib/turn-death.js holds the table):
//
//   • TRANSIENT — 429, 529, a connection closed mid-response, another 5xx, a timeout. The session,
//     the cage, the branch and the database are all intact; the API said no for a while. Resume the
//     SAME session on a 5/15/45-minute ladder, three attempts, then stop and raise a human. The
//     resume is the same one a landing approval comes through (nudge.js) — the one door whose turn
//     the queenzee starts, records and watches end.
//   • TERMINAL — 401, an invalid key, a disabled org, an unknown model, exhausted credit. Never
//     revived, at any interval: no number of retries mends a credential, and every retry buries the
//     one line a human needs. setTend, naming the provider and the account, quoting the error.
//
// THE RULES IT MUST NOT BREAK, all of them for the same reason (a revive STARTS A TURN):
//   – never under a fleet, project or xell PAUSE (lib/fleet-pause.js xellPaused — all three levels);
//   – never a DECOMMISSIONED zee, and never one in a retired or tearing-down xell;
//   – never two revives in flight for one zee — the schedule is CLAIMED with a conditional UPDATE,
//     so a second tick (or a second reader) finds nothing to take;
//   – never in a nested queenzee: PROVISION_MODE decides, exactly as it does for every other nudge.
//
// AND EVERY ATTEMPT IS RECORDED, twice on purpose: the zee row carries the scheduler's state
// (revive_class/signal/attempts/next_at/revived_at — migration 125), and each event rides the
// append-only session_event log ('turn-death', 'zee-revive'), so "how often does the fleet die on
// the provider, and how often does reviving it work?" is a GROUP BY afterwards rather than a
// forensic read of the queenzee's ring buffer.
import { q, one } from '../db/pool.js';
import { logline } from '../lib/logbus.js';
import { broadcast } from '../lib/events.js';
import { recordEvent, setTend } from '../lib/status.js';
import { xellPaused } from '../lib/fleet-pause.js';
import { classifyTurnDeath, decideRevive, MAX_REVIVE_ATTEMPTS, REVIVE_BACKOFF_MIN,
         HOST_RESTART_DEATH } from '../lib/turn-death.js';
import { providerForRuntimeKey } from '../lib/cxell-runtimes.js';
import { raiseAuthDeathRequest, injectedRevivePrompt, scrubSecrets } from '../lib/credential-inject.js';
import { nudgeXellForTurnDeath } from './nudge.js';

// Same switch every other real-side-effect module reads. A revive resumes an agent's session in a
// cage named off a fleet row — and in a NESTED queenzee (a zee running this server inside its own
// xell, against a CLONE of the meta-DB) that row is another zee's live cage. See startRevive().
const PROVISION_MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

// How often the due set is swept. A minute is far finer than the ladder it serves (5/15/45), so the
// wait a zee actually experiences is the backoff, not this.
const TICK_MS = Number(process.env.REVIVE_TICK_MS) || 60000;

// FILE A DEAD TURN. Called from intake.js wherever a cxell turn is filed as 'errored', and from
// nudge.js when a RESUMED turn dies the same way. It classifies, records, and then either schedules
// a revive or raises a human — it never resumes anything itself, because every transient revive is
// deliberately in the future (the whole point of the backoff).
//
// `resumable: false` says this death happened before there was a session to resume (the cage was
// never built, or the spawn failure removed it) — a transient one is then simply logged, while a
// terminal one still gets its human, which is exactly the 401-at-spawn case.
//
// Best-effort and NEVER throws: it hangs off a completion handler, and a zee's turn ending must not
// depend on this bookkeeping succeeding.
//
// `death` OVERRIDES the classifier for a caller that already KNOWS how the turn died, and there is
// exactly one class of those: a death the queenzee OBSERVED rather than read (the host restarted and
// took every cage with it — lib/turn-death.js HOST_RESTART_DEATH). Such a turn left NO message
// behind, so classifyTurnDeath would call it UNKNOWN and do nothing, and the zee would sit in a
// restarted cage forever. Everything downstream is unchanged: the same decideRevive policy, the same
// ladder, the same human at the end of it.
export async function noteTurnDeath({ zeeId, xellId, slug = null, reason = '', resumable = true,
                                      source = 'turn', death: deathOverride = null } = {}) {
  try {
    if (!zeeId) return { classified: false };
    const zee = await one(
      `SELECT z.id, z.xell_id, z.revive_attempts, z.decommissioned_at, z.claude_session_id,
              z.entrypoint, x.slug, x.status AS xell_status, x.project_id, rt.key AS runtime_key
         FROM zee z JOIN xell x ON x.id = z.xell_id
         LEFT JOIN agent_runtime rt ON rt.id = z.runtime_id
        WHERE z.id = $1`, [zeeId]);
    if (!zee) return { classified: false };
    const name = slug || zee.slug || String(zee.xell_id).slice(0, 8);

    const death = deathOverride
      ? { kind: deathOverride.kind, signal: deathOverride.signal, message: String(reason || '') }
      : classifyTurnDeath(reason);
    const verdict = decideRevive({
      kind: death.kind,
      attempts: zee.revive_attempts || 0,
      decommissioned: !!zee.decommissioned_at,
      xellStatus: zee.xell_status,
      // A resume needs a session id as much as it needs a cage (claude/codex resume BY id), so a
      // turn that died before init is not resumable however alive the container is.
      resumable: resumable && !!zee.claude_session_id,
    });

    // The classification lands on the row whatever the verdict — a zee that died on something
    // unrecognised is still worth being able to count later.
    // A new death RE-DECIDES the schedule outright, including clearing it: a zee that dies on a 401
    // while a transient revive is still pending must not be revived by that leftover schedule.
    await q(`UPDATE zee SET revive_class = $2, revive_signal = $3,
                            revive_next_at = CASE WHEN $4::int IS NULL THEN NULL
                                                  ELSE now() + ($4::int || ' minutes')::interval END
               WHERE id = $1`,
            [zee.id, death.kind, death.signal, verdict.action === 'revive' ? verdict.delayMinutes : null]);
    // A vendor error can ECHO THE KEY back ("your api key: sk-ant-… is invalid") — scrub token-
    // shaped substrings before the reason lands in the event log or the tend (finding [10]).
    const scrubbedReason = scrubSecrets(String(reason || ''));
    await recordEvent({ source: 'queenzee', hook_event_name: 'turn-death', zee_id: zee.id,
                        xell_id: zee.xell_id, stop_reason: death.kind,
                        raw: { kind: death.kind, signal: death.signal, action: verdict.action,
                               attempts: zee.revive_attempts || 0, delay_minutes: verdict.delayMinutes,
                               source, message: scrubbedReason.slice(0, 1000) } });

    if (verdict.action === 'revive') {
      logline('revive', `${name}: turn died on ${death.signal} (TRANSIENT) — ${verdict.reason}`);
      broadcast('zee', await one(`SELECT * FROM zee WHERE id=$1`, [zee.id]));
      return { classified: true, kind: death.kind, signal: death.signal, scheduled: true,
               in_minutes: verdict.delayMinutes };
    }

    if (verdict.action === 'tend') {
      const account = await accountFor(zee.project_id, zee.runtime_key);
      const why = death.kind === 'terminal'
        ? `This zee's turn died on a ${death.signal.toUpperCase()} error from ${account} and it will NOT be `
          + `revived — retrying cannot mend a credential. The provider said, verbatim: "`
          + `${scrubbedReason.replace(/\s+/g, ' ').slice(0, 600)}". Fix or re-connect the account in `
          + 'Project setup (or re-dispatch this work on another account); the zee is idle in its cage until then.'
        : `This zee's turn has now died on the provider ${(zee.revive_attempts || 0) + 1} time(s) `
          + `(last: ${death.signal}) and the queenzee has spent all ${MAX_REVIVE_ATTEMPTS} automatic revives. `
          + `It said, verbatim: "${scrubbedReason.replace(/\s+/g, ' ').slice(0, 400)}". Nothing is wrong `
          + 'with its work — its commits are on its branch — but it needs a human to decide whether to send it '
          + 'again (📨 a message resumes it) or mark it done.';
      await setTend(zee.xell_id, true, { reason: why, zeeId: zee.id, source: 'queenzee' });
      logline('revive', `${name}: turn died on ${death.signal} (${death.kind.toUpperCase()}) — raised a tend for a human`);
      broadcast('zee', await one(`SELECT * FROM zee WHERE id=$1`, [zee.id]));
      // A TERMINAL AUTH death is the one a NEW KEY fixes: raise a credential-inject request scoped to
      // this xell so a human can approve injecting the current key into the live cage. 'credit',
      // 'account' and 'model' are NOT triggers — a new key does not fix an empty balance, a disabled
      // org or a model the vendor never had.
      if (death.kind === 'terminal' && death.signal === 'auth') {
        await raiseAuthDeathRequest({
          xellId: zee.xell_id, projectId: zee.project_id,
          provider: providerForRuntimeKey(zee.runtime_key) || 'claude',
          reason, errorQuote: reason,
        });
      }
      return { classified: true, kind: death.kind, signal: death.signal, tended: true };
    }

    // 'none' — unknown, or nothing left to resume. Logged, never silent: a death this loop chose not
    // to act on must still be findable when someone asks why a xell went quiet.
    logline('revive', `${name}: turn ended — ${verdict.reason}`
      + (death.signal ? ` (${death.signal})` : ''));
    return { classified: true, kind: death.kind, signal: death.signal, scheduled: false };
  } catch (e) {
    logline('revive', `could not classify the death of zee ${String(zeeId).slice(0, 8)} (${String(e.message).slice(0, 140)})`);
    return { classified: false, error: e.message };
  }
}

// Name the account a human has to go and fix. The zee row does not store which provider_token the
// dispatch used, so this is the account the project WOULD dispatch this provider on — read-only (no
// last_used_at write, unlike tokenForSpawn) and best-effort: a tend that says "the claude account"
// is still infinitely better than one that says "the provider".
async function accountFor(projectId, runtimeKey) {
  const provider = String(runtimeKey || '').includes('codex') ? 'openai'
    : String(runtimeKey || '').includes('kimi') ? 'kimi'
    : String(runtimeKey || '').includes('deepseek') ? 'deepseek' : 'claude';
  try {
    const row = await one(
      `SELECT label FROM provider_token WHERE project_id = $1 AND provider = $2
        ORDER BY paused_at NULLS FIRST, created_at DESC LIMIT 1`, [projectId, provider]);
    return row?.label ? `the ${provider} account "${row.label}"` : `this project's ${provider} account`;
  } catch { return `this project's ${provider} account`; }
}

// THE PROMPT A HOST RESTART DESERVES — and why the standard one would be a lie.
//
// REVIVE_PROMPT (nudge.js) opens "your last turn was CUT SHORT BY A PROVIDER ERROR" and quotes what
// the provider said. After a machine restart NO provider said anything: the zeehive host (or its
// docker daemon) went down, every cage stopped where it stood, and the queenzee started this one
// again on the way back up. Telling an agent the API refused it sends it hunting for a rate limit
// that never happened — the exact failure mode the revive prompt exists to prevent, one layer up.
//
// The two facts it must carry that no other revive does: the cage was OFF for a while (so anything
// it left running in the background — a `--wait` build poll, a dev server, a background job — is
// gone, not merely quiet), and its FILES survived (a restart is not a rebuild: the worktree, the
// commits and the container's disk are exactly as they were). Exported for the test.
export function hostRestartRevivePrompt({ minutes = null, attempt = 1, max = MAX_REVIVE_ATTEMPTS } = {}) {
  return [
    'RESUMED — your last turn did NOT end, and it was NOT rejected: THE ZEEHIVE MACHINE RESTARTED'
      + (minutes != null ? ` about ${minutes} minute(s) ago` : '') + ' and took your container down with it.',
    'The queenzee started your cage again, re-opened its ssh door, re-applied its firewall and resumed',
    `this session (attempt ${attempt} of ${max}, no human involved). Nothing of yours failed: no gate moved,`,
    'no build broke, nothing was reverted or rejected — your transcript stops mid-thought because the',
    'host went down, not because anybody said no to you.',
    '',
    'YOUR FILES SURVIVED. A restart is not a rebuild: your worktree, your commits and everything else on',
    'your container\'s disk are exactly where you left them.',
    'YOUR PROCESSES DID NOT. Anything you had running in the background is gone — a `zee build --wait`',
    'that was polling, a dev server, a long job. If you were waiting on one, it did not finish while you',
    'were down; check its state and start it again rather than waiting for an answer that cannot arrive.',
    '',
    'Re-orient BEFORE you act — time has passed and you must not trust your memory of the fleet\'s state:',
    '  1. `zee status` — where you stand: your task, and whether a landing, a ship or a done proposal of',
    '     yours is pending a human. A decision may have arrived while you were down.',
    '  2. `zee work` if you are on a work item — re-read it rather than recalling it.',
    '  3. `git log --oneline -5` and `git status` in your worktree — what you had actually committed',
    '     before the machine went down, which is usually more (or less) than you remember.',
    '',
    'Then CONTINUE the job from there. Do not redo work that is already committed, do not re-raise a',
    'request `zee status` shows is already open, and do not `zee tend` about the restart — it is handled,',
    'and the machine coming back is why you are running again.',
  ].join('\n');
}

// Zees that have been "held, paused" already reported — so a fleet paused for an hour does not write
// sixty identical lines for the same zee. Per-process, like landgate's reportedDryLandings.
const reportedPaused = new Set();

// ONE SWEEP of the due set. Exported for the test and for anything that wants to force a pass.
export async function reviveTick() {
  const due = await q(
    `SELECT z.id, z.xell_id, z.revive_attempts, z.revive_signal, z.last_stop_reason, z.revive_next_at,
            x.slug, x.status AS xell_status, x.project_id
       FROM zee z JOIN xell x ON x.id = z.xell_id
      WHERE z.revive_next_at IS NOT NULL AND z.revive_next_at <= now()
        AND z.decommissioned_at IS NULL
        AND z.entrypoint = 'cxell-cli'
        AND x.status NOT IN ('retired', 'tearing-down')
      ORDER BY z.revive_next_at
      LIMIT 10`);
  let revived = 0;
  for (const row of due) {
    // A REVIVE IS A TURN, so every level of the pause switch refuses it — and it is HELD rather than
    // dropped: the schedule stays on the row and the zee is revived when a human presses play.
    if (await xellPaused({ id: row.xell_id, project_id: row.project_id })) {
      if (!reportedPaused.has(row.id)) {
        reportedPaused.add(row.id);
        logline('revive', `${row.slug}: revive is DUE but the fleet/project/xell is PAUSED — held, not dropped `
          + '(it is resumed when a human presses play)');
      }
      continue;
    }
    reportedPaused.delete(row.id);

    // CLAIM IT. The conditional UPDATE is what makes "never two revives in flight for one zee" a
    // fact rather than an intention: whoever moves revive_next_at to NULL first owns this attempt,
    // and a second reader gets no row back and moves on.
    const claimed = await one(
      `UPDATE zee SET revive_attempts = revive_attempts + 1, revived_at = now(), revive_next_at = NULL
        WHERE id = $1 AND revive_next_at IS NOT NULL AND revive_next_at <= now()
        RETURNING revive_attempts`, [row.id]);
    if (!claimed) continue;

    const attempt = claimed.revive_attempts;
    // How long ago the turn actually died, for the prompt: the backoff this attempt was scheduled
    // with, plus however long the tick (or a pause) made it wait beyond that.
    const overdue = Math.round((Date.now() - new Date(row.revive_next_at).getTime()) / 60000);
    const minutes = Math.max(1, (REVIVE_BACKOFF_MIN[row.revive_attempts] || 0) + Math.max(0, overdue));
    await recordEvent({ source: 'queenzee', hook_event_name: 'zee-revive', zee_id: row.id,
                        xell_id: row.xell_id, raw: { attempt, max: MAX_REVIVE_ATTEMPTS, signal: row.revive_signal } });
    const injected = row.revive_signal === 'credential-injected';
    // A HOST RESTART is not a provider error, so it does not get the provider error's story: the
    // standard prompt would quote an API refusal that never happened (hostRestartRevivePrompt).
    const hostRestart = row.revive_signal === HOST_RESTART_DEATH.signal;
    logline('revive', `${row.slug}: REVIVING — attempt ${attempt} of ${injected ? 1 : MAX_REVIVE_ATTEMPTS} after a `
      + `${row.revive_signal || 'provider'} death`);

    const r = await nudgeXellForTurnDeath(row.xell_id, {
      signal: injected ? 'credential-injected' : row.revive_signal,
      message: injected ? 'a human approved the injection of a fresh provider key into this cage' : (row.last_stop_reason || ''),
      attempt: injected ? 1 : attempt, max: injected ? 1 : MAX_REVIVE_ATTEMPTS,
      minutes, mode: PROVISION_MODE,
      prompt: injected ? injectedRevivePrompt()
            : hostRestart ? hostRestartRevivePrompt({ minutes, attempt, max: MAX_REVIVE_ATTEMPTS })
            : null,
      why: hostRestart ? 'the zeehive machine restarted under this turn' : undefined });

    if (r?.nudged) { revived++; continue; }
    // A revive that could not even START is not an attempt the zee had: give the schedule back so
    // the next tick tries again, and do not spend one of its three on a cage that was busy being
    // unreachable. (A paused fleet lands here too — nudgeCxell refuses it — and is held the same way.)
    await q(`UPDATE zee SET revive_attempts = GREATEST(revive_attempts - 1, 0),
                            revive_next_at = now() + interval '5 minutes' WHERE id = $1`, [row.id]);
    logline('revive', `${row.slug}: revive attempt ${attempt} could not be delivered `
      + `(${r?.reason || r?.error || 'unknown'}) — retrying in 5 minutes`);
  }
  return { due: due.length, revived };
}

// The loop. Started from index.js with the other queenzee loops.
export function startRevive() {
  if (process.env.REVIVE_ENABLED === 'false') {
    console.log('[queenzee] reviver DISABLED (REVIVE_ENABLED=false)');
    return null;
  }
  // A NESTED QUEENZEE MUST NOT REVIVE A REAL ZEE. Its meta-DB is a CLONE of the fleet's, so every
  // errored zee in it is somebody else's — and unlike a landing there is no human gate in front of
  // this one to catch the mistake. nudgeCxell would refuse the exec anyway (its own PROVISION_MODE
  // guard); refusing to start the loop at all means it also never spends another xell's attempts.
  if (PROVISION_MODE !== 'real') {
    console.log('[queenzee] reviver DISABLED — PROVISION_MODE=simulate (this queenzee models the fleet)');
    return null;
  }
  setInterval(() => reviveTick().catch((e) => console.error('[revive] tick:', e.message)), TICK_MS);
  console.log(`[queenzee] reviver started (${TICK_MS}ms) — resumes zees whose turn a provider error cut`);
  return true;
}

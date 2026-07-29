// WHEN THE NEXT PROD BACKUP IS DUE, AND WHEN A HUMAN GETS TOLD — ticket #26.
//
// THE BUG THIS EXISTS TO FIX. backupDue() asked one question: "is the newest attempt older than the
// policy interval?" — newest attempt of ANY status, deliberately, so a just-started or just-failed row
// could not trigger a storm. The cost of that simplicity was invisible and expensive: a FAILED attempt
// SATISFIED its window. One failure pushed the next good dump out by a full interval; two in a row cost
// a day with no new restore point, silently. Measured on the fleet 2026-07-29: omnibiz backs up every
// 12h, its last good dump was 2026-07-28 18:30, the 19:32 attempt failed ("interrupted by server
// restart"), and the live restore point was ~27 HOURS old under a 12-hour policy.
//
// So a failure must SHORTEN the next window instead of consuming it — while a retry storm stays
// impossible, because a backup takes the prod window and moves gigabytes.
//
// Everything here is PURE, and that is the point: the whole change is about TIMING, and timing you can
// only reason about is timing you get wrong. A test drives these with explicit clocks (see
// test/backup-retry-alert.test.mjs) instead of asserting that the code looks right.

// ── the retry interval ────────────────────────────────────────────────────────────────────────────
// 10 minutes, doubling per CONSECUTIVE failure, capped at the policy interval.
//
// WHY 10 MINUTES: it is the slowest existing loop in this repo (proddiff's default tick) and this
// repo's established unit for "not urgent, but not hours either". A prod context that is unreachable
// now will still be unreachable in ten seconds, so anything tick-sized would be a hammer; ten minutes
// is a real retry that still recovers a transient restart or a NAS blip inside the same window.
//
// WHY DOUBLING: 10 → 20 → 40 → 80 … converges on the policy interval, so a long outage costs a handful
// of extra attempts rather than one every ten minutes forever.
//
// WHY CAPPED AT THE POLICY INTERVAL: it makes this change strictly "sooner, never later". A retry can
// never be scheduled further out than today's behaviour would have put it, so no configuration can
// turn this fix into a regression of the thing it fixes.
export const RETRY_BASE_SEC = 600;

export function retryDelaySec(consecutiveFailures, intervalSec) {
  const n = Math.max(1, Number(consecutiveFailures) || 1);
  const policy = Math.max(1, Number(intervalSec) || 0);
  // 2^(n-1), bounded before it can overflow into Infinity on an absurd failure count.
  const backoff = RETRY_BASE_SEC * Math.pow(2, Math.min(n - 1, 20));
  return Math.min(backoff, policy);
}

// Is a backup due, and WHY — the whole decision, from facts a caller can read in two queries.
//
//   lastAttempt      the newest db_snapshot row for this project (any status) or null
//   lastGood         the newest FINISHED one, or null
//   failStreak       consecutive FAILED attempts since the last success (0 when the newest is good)
//   intervalSec      the configured policy interval
//   now              ms
//
// Returns { due, kind, dueAt, waitSec, reason }. `kind` is what a log line should say:
//   'first'   — nothing has ever been attempted
//   'policy'  — the normal schedule elapsed
//   'retry'   — the last attempt FAILED and the (shorter) retry interval has elapsed
//   'running' — an attempt is in flight; NEVER due, at any age
export function backupDecision({ lastAttempt, lastGood, failStreak = 0, intervalSec, now }) {
  const policy = Math.max(1, Number(intervalSec) || 0);
  const t = Number(now);

  // A RUNNING backup is never due, however old the row is. This is the first of three independent
  // reasons a retry cannot interrupt a live dump (the other two: backupProd refuses when a row is
  // 'running', and the prod window guard defers). An age-based rule alone would eventually call a
  // long-running dump "overdue" and try to start a second one on top of it.
  if (lastAttempt?.status === 'running') {
    return { due: false, kind: 'running', dueAt: null, waitSec: null,
             reason: 'a backup is already running — never interrupted, whatever its age' };
  }
  if (!lastAttempt) {
    return { due: true, kind: 'first', dueAt: t, waitSec: 0, reason: 'no backup has ever been taken for this project' };
  }

  const failed = lastAttempt.status === 'failed';
  const waitFor = failed ? retryDelaySec(failStreak || 1, policy) : policy;
  const since = new Date(lastAttempt.taken_at).getTime();
  const dueAt = since + waitFor * 1000;
  const due = t >= dueAt;
  const waitSec = Math.max(0, Math.ceil((dueAt - t) / 1000));
  const goodAgeSec = lastGood ? Math.floor((t - new Date(lastGood.taken_at).getTime()) / 1000) : null;

  return {
    due, kind: failed ? 'retry' : 'policy', dueAt, waitSec,
    reason: failed
      ? `the last attempt FAILED ${Math.floor((t - since) / 60000)} min ago; retry interval is `
        + `${Math.round(waitFor / 60)} min (attempt ${failStreak || 1} since the last success`
        + `${goodAgeSec != null ? `, whose dump is ${Math.round(goodAgeSec / 3600)}h old` : ''})`
      : `the policy interval is ${Math.round(policy / 60)} min`,
  };
}

// ── telling a human ───────────────────────────────────────────────────────────────────────────────
// THE THRESHOLD, and why it is this one. What harms the operator is the AGE OF THE RESTORE POINT, not
// the number of failed attempts: a failure that a retry fixes ten minutes later cost nothing, and
// pinging on it is how an alert earns a mute. So the alarm is "the newest GOOD dump is older than TWO
// policy intervals" — a whole window has been missed AND the retries inside it did not save it.
//
// On the numbers that produced this ticket: omnibiz's 27h under a 12h policy fires (27 > 24); the
// single failure at 07-27 18:29, followed by a good dump at 07-28 06:29, never would have.
export const STALE_ALERT_INTERVALS = 2;

// Re-alerting is bounded to once per policy interval, so a three-day outage is three pings on a
// 24h policy — not one every maintenance tick. That bound is the difference between an alert a human
// reads and an alert a human filters.
export function staleAlertDecision({ lastGood, intervalSec, alertedAt = null, alertOpen = false, now }) {
  const policy = Math.max(1, Number(intervalSec) || 0);
  const t = Number(now);
  const ageSec = lastGood ? Math.floor((t - new Date(lastGood.taken_at).getTime()) / 1000) : null;
  const thresholdSec = policy * STALE_ALERT_INTERVALS;

  // NEVER alert about a project that has no backups at all. It is either brand new or not configured
  // for backups, and neither is an incident — waking someone for it is exactly the noise that gets a
  // channel muted before the real event arrives.
  if (!lastGood) {
    return { fire: false, clear: false, stale: false, ageSec: null, thresholdSec,
             reason: 'no successful backup on record — not an incident, and not this alarm\'s business' };
  }

  const stale = ageSec > thresholdSec;

  // RECOVERED: a good dump landed after we woke somebody. Exactly one ping, and only to someone who
  // was already told — so it can never become chatter on its own.
  if (!stale) {
    return { fire: false, clear: alertOpen, stale: false, ageSec, thresholdSec,
             reason: alertOpen
               ? `a good backup landed ${Math.round(ageSec / 60)} min ago — the stale-restore-point alert clears`
               : `the newest good backup is ${Math.round(ageSec / 3600)}h old, inside the ${Math.round(thresholdSec / 3600)}h threshold` };
  }

  const sinceAlert = alertedAt ? (t - new Date(alertedAt).getTime()) / 1000 : null;
  const repeatOk = sinceAlert == null || sinceAlert >= policy;
  return {
    fire: repeatOk, clear: false, stale: true, ageSec, thresholdSec,
    reason: repeatOk
      ? `the newest good backup is ${Math.round(ageSec / 3600)}h old — past the `
        + `${Math.round(thresholdSec / 3600)}h threshold (${STALE_ALERT_INTERVALS}x the policy interval)`
      : `already alerted ${Math.round(sinceAlert / 60)} min ago; the next reminder is one policy `
        + `interval (${Math.round(policy / 3600)}h) apart, so a long outage does not become chatter`,
  };
}

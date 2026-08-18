// WHY DID THIS TURN DIE — and does the zee deserve to be revived, or a human?
//
// A dependency-free leaf, the same shape as lib/zee-turn.js: two questions decided in a table so
// they can be table-tested, and so the queenzee loop that acts on them holds no policy of its own.
//
// WHAT WAS MEASURED (the live meta-DB, 2026-08-04). Of 279 zees, ~43 ended their LAST turn on a
// PROVIDER or infrastructure error rather than on a decision of their own: 429 x20, 529 x9,
// connection-closed x4, 401 x6, org/model x4, and 7 that said only 'error'. The 429/529 cohort died
// at $0.06–$0.43 — i.e. on the FIRST turn, after the xell, its containers and its database had been
// paid for in full. Nothing retried, classified or reported any of it: intake.js wrote
// status='errored' and stopped. Six of the 401 zees never landed anything, ever.
//
// The two cohorts want opposite things, and that is the whole of this file:
//
//   • TRANSIENT (429 / 529 / a closed connection / another 5xx / a timeout) — the provider was busy
//     or the pipe broke. The session is intact, the cage is intact, the work is intact. Resuming it
//     a few minutes later is very likely to just work, and it costs nobody anything.
//   • TERMINAL (401 / an invalid key / a disabled org / an unknown model / exhausted credit) — the
//     credential or the dispatch is wrong. No number of retries fixes it, and every retry burns a
//     turn and buries the one line a human needs. Raise a human, name the account, quote the error.
//
// ORDER MATTERS, and it is why terminal is asked FIRST. Providers reuse status codes across the two
// meanings: OpenAI answers an EXHAUSTED BALANCE with HTTP 429 + "exceeded your current quota", which
// is a rate limit by code and a dead account by fact. A classifier that matched 429 first would put
// that zee on a 5/15/45-minute retry ladder that can only ever fail, and never raise the human who
// could top the account up.
//
// Anything that matches neither is UNKNOWN, and unknown is deliberately inert: the 7 zees whose
// whole message was 'error' are exactly the population where a guess in either direction is worse
// than doing nothing (a wrong revive costs a turn; a wrong tend teaches humans to skim their cards).

// The transient ladder: how long to wait before revive attempt 1, 2 and 3. Minutes, growing, so a
// provider-wide incident is not hammered by the whole fleet at once — and so the third attempt is
// far enough out (~65 min total) to outlive the median rate-limit window without pinning a xell for
// a day. Its LENGTH is the attempt cap: three tries, then a human.
export const REVIVE_BACKOFF_MIN = [5, 15, 45];
export const MAX_REVIVE_ATTEMPTS = REVIVE_BACKOFF_MIN.length;

// Each rule is { kind, signal, test } and the FIRST match wins. `signal` is the word that goes in
// the log line, in the zee row and in the tend — so "how often does the fleet die on a 429?" is one
// GROUP BY afterwards rather than a regex over prose.
const RULES = [
  // ── TERMINAL: a credential/dispatch fact. Asked first (see the note above). ──────────────────
  { kind: 'terminal', signal: 'credit',
    test: /credit balance|insufficient (credit|funds|quota|balance)|exceeded your current quota|quota_exceeded|insufficient_quota|billing (hard )?limit|payment required|\b402\b/i },
  { kind: 'terminal', signal: 'auth',
    // "incorrect api key provided" is xAI's wording for a bad key — and it arrives as HTTP 400, not
    // 401 (measured against api.x.ai, 2026-08-04), so nothing else in this rule would catch it and a
    // dead grok credential classified as UNKNOWN raises nobody at all. OpenAI uses the same sentence.
    test: /\b401\b|unauthorized|unauthorised|authentication_error|invalid[_ ]api[_ ]key|incorrect api key|invalid bearer|missing bearer|invalid x-api-key|not logged in|oauth token (has )?expired|permission[_ ]error|\b403\b|forbidden/i },
  { kind: 'terminal', signal: 'account',
    test: /organization (has been )?(disabled|deactivated|suspended)|account (has been )?(disabled|deactivated|suspended)|org(anization)?[_ ]disabled|access terminated/i },
  { kind: 'terminal', signal: 'model',
    test: /unknown model|model[_ ]not[_ ]found|invalid model|model .{0,40}(does not exist|is not available|not found)|no access to model/i },

  // ── TRANSIENT: the provider or the pipe, not the account. ────────────────────────────────────
  { kind: 'transient', signal: '429',   test: /\b429\b|rate[_ ]?limit|too many requests|slow down/i },
  { kind: 'transient', signal: '529',   test: /\b529\b|overloaded/i },
  { kind: 'transient', signal: 'closed',
    test: /connection (closed|reset|error|aborted)|socket hang ?up|premature close|stream (was )?closed|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|network error|fetch failed/i },
  { kind: 'transient', signal: 'timeout', test: /timed out|timeout|ETIMEDOUT|deadline exceeded|\b504\b|gateway time-?out/i },
  { kind: 'transient', signal: '5xx',
    test: /\b5(00|02|03|20|21|22|24|25|30)\b|internal server error|bad gateway|service unavailable|server error|upstream/i },
];

// A death nobody has to READ, because the queenzee WATCHED it happen: the machine (or its docker
// daemon) went down under a live turn and every cxell came back EXITED. There is no provider
// sentence to classify — the turn left no message at all, and an empty message is UNKNOWN, which is
// deliberately inert (see the note at the top), so a host restart classified the normal way would
// resume nobody. The caller that KNOWS what happened (queenzee/cxell-recover.js, which just
// restarted the cage itself) passes this classification in instead of a string to guess from.
//
// TRANSIENT is the honest kind: the session, the cage's filesystem, the branch and the database all
// survived the reboot — only the process did — which is the same "resume it in a few minutes" shape
// a 529 has, on the same three-attempt ladder with the same human at the end of it.
export const HOST_RESTART_DEATH = Object.freeze({ kind: 'transient', signal: 'host-restart' });

// The same death, caused ON PURPOSE by a human: the console's "restart cage" button (the route
// behind it is queenzee/cxell-recover.js restartXellCxell). A wedged cage — sshd gone, the runtime
// hung, a turn that has stopped speaking without dying — is the case the automatic sweep cannot see,
// because from docker's side the container is RUNNING and nothing is wrong with it. So a human
// stops it, the queenzee brings it back through the same start → door → seal order, and the turn
// that was live inside it died exactly the way a reboot kills one.
//
// It is a SEPARATE signal from host-restart for one reason: everything downstream SAYS what happened
// — the revive prompt the zee reads, the tend a spent ladder raises, the `revive_signal` column
// somebody groups by later. "The zeehive machine restarted" is a lie when what happened is "a human
// pressed restart on your cage", and it sends both the agent and the operator to the wrong logs.
// The POLICY is deliberately identical (transient, same 5/15/45 ladder, same human at the end).
export const CAGE_RESTART_DEATH = Object.freeze({ kind: 'transient', signal: 'cage-restart' });

// What to CALL a transient death in the one sentence a human reads. Provider errors are the default
// because they are almost all of them; the two the queenzee causes itself name themselves.
const TRANSIENT_CAUSE = {
  [HOST_RESTART_DEATH.signal]: 'the zeehive machine restarted under this turn',
  [CAGE_RESTART_DEATH.signal]: 'a human restarted this zee\'s cxell under this turn',
};

// Classify the sentence a dead turn left behind (zee.last_stop_reason, a CLI's final result text, a
// docker exec's stderr). Never throws; an empty message is UNKNOWN, not an error.
// → { kind: 'transient' | 'terminal' | 'unknown', signal, message }
export function classifyTurnDeath(text) {
  const message = String(text ?? '').trim();
  if (!message) return { kind: 'unknown', signal: null, message: '' };
  for (const r of RULES) if (r.test.test(message)) return { kind: r.kind, signal: r.signal, message };
  return { kind: 'unknown', signal: null, message };
}

// WHAT TO DO ABOUT IT — the whole revival policy, in one pure function, decided in this order:
//
//   1. NOTHING TO REVIVE. A zee the reaper stopped (decommissioned_at), or one whose xell is retired
//      or tearing down, has no cage to resume into. Asked FIRST, exactly as decideMessageDelivery
//      does, because viewer_kind is not cleared with either of them.
//   2. NO SESSION TO RESUME. A turn that died before the cage was built, or before an init event
//      captured a session id, cannot be resumed by anyone — the queenzee removed the container on
//      that path. It can still be TERMINAL, and a terminal one still deserves its human.
//   3. TERMINAL → a human, always, and never a revive.
//   4. UNKNOWN → nothing. (See the note at the top: a guess here is worse than silence.)
//   5. TRANSIENT, attempts left → revive, after REVIVE_BACKOFF_MIN[attempts] minutes.
//   6. TRANSIENT, attempts spent → a human. Three provider deaths in ~65 minutes is not a busy
//      provider any more, and the fourth retry is the one that would hide it.
//
// `attempts` is how many revives this zee has ALREADY been given (zee.revive_attempts).
// `signal` is only used to SAY THE RIGHT THING: every transient death used to be a provider error,
// and since HOST_RESTART_DEATH and CAGE_RESTART_DEATH ride the same ladder
// (queenzee/cxell-recover.js) that sentence would be a lie in the one place a human reads to find
// out what happened. The POLICY does not branch on it — a rebooted machine, a cage a human bounced
// and a 529 are all "wait and resume", which is why they share a ladder — only the wording does.
// → { action: 'revive' | 'tend' | 'none', delayMinutes, reason }
export function decideRevive({ kind = 'unknown', attempts = 0, decommissioned = false,
                              xellStatus = null, resumable = true, signal = null } = {}) {
  const cause = TRANSIENT_CAUSE[signal] || 'a transient provider error';
  if (decommissioned) return { action: 'none', delayMinutes: null, reason: 'the zee has been decommissioned — there is no session to revive' };
  if (xellStatus === 'retired' || xellStatus === 'tearing-down') {
    return { action: 'none', delayMinutes: null, reason: `the xell is ${xellStatus} — its cxell is gone` };
  }
  if (kind === 'terminal') {
    return { action: 'tend', delayMinutes: null,
             reason: 'the turn died on a credential/dispatch error — retrying cannot fix it, so a human is raised instead' };
  }
  if (kind === 'unknown') {
    return { action: 'none', delayMinutes: null,
             reason: 'the turn did not die on a recognised provider error — left alone rather than guessed at' };
  }
  if (!resumable) {
    return { action: 'none', delayMinutes: null,
             reason: `${cause}, but this turn died before it had a session to resume (the cage was never built or was removed)` };
  }
  if (attempts >= MAX_REVIVE_ATTEMPTS) {
    return { action: 'tend', delayMinutes: null,
             reason: `the queenzee has already revived this zee ${attempts} time(s) and the turn keeps dying — a human is raised instead of a fourth retry` };
  }
  return { action: 'revive', delayMinutes: REVIVE_BACKOFF_MIN[attempts],
           reason: `${cause} — revive attempt ${attempts + 1} of ${MAX_REVIVE_ATTEMPTS}, in ${REVIVE_BACKOFF_MIN[attempts]} minute(s)` };
}

// DID THIS RESUMED TURN DIE THE SAME WAY A SPAWNED ONE DOES?
//
// A revive is only honest if a revived turn's OWN death is seen: the ladder is "three attempts, then
// a human", and an attempt whose death nobody notices makes the cap — and the human at the end of it
// — unreachable. The resume path (lib/cxell.js nudgeCxellZee) does not attach a stream parser, so
// what comes back is the raw `{ code, out, err }` of the docker exec, whose final `result` event
// carries the same is_error/result pair intake.js reads off a spawned turn.
//
// THAT EVENT IS NOW PARSED IN ONE PLACE — lib/cxell-runtimes.js resultFrom, by the adapter that
// produced the output — and handed to this function as `result`. It used to scan `out` here for
// claude-shaped JSON, beside a second, adapter-aware reader written for the burn ledger one day
// later: two parsers over one stream, one of which read a codex or kimi turn wrongly (neither prints
// claude's result event; their adapters SYNTHESIZE it on close). This function is the POLICY half
// only — is that result a death — and knows no vendor's line format.
//
// Falls back to the streams for a run that died before printing anything to parse. Pure, never
// throws, and returns null when the turn ended normally.
// → { message } | null
export function resumeTurnDeath({ result = null, code = 0, out = '', err = '' } = {}) {
  if (result?.is_error) return { message: String(result.result || 'error') };
  if (result) return null;                                   // it spoke, and it did not die
  if (code && code !== 0) {
    const tail = String(err || '').trim() || String(out || '').trim();
    return tail ? { message: tail.slice(-600) } : null;      // an exit code alone says nothing to classify
  }
  return null;
}

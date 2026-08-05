-- REVIVE A ZEE WHOSE TURN DIED ON THE PROVIDER — the scheduler state, on the zee row.
--
-- MEASURED (the live meta-DB, 2026-08-04): of 279 zees, ~43 ended their LAST turn on a provider or
-- infrastructure error rather than on a decision of their own — 429 x20, 529 x9, connection-closed
-- x4, 401 x6, org/model x4, and 7 that said only 'error'. The 429/529 cohort died at $0.06–$0.43,
-- i.e. on the first turn, after the xell, its containers and its database had been paid for in full.
-- Nothing in the queenzee retried, classified or reported any of it: intake.js wrote
-- status='errored' and stopped. Six of the 401 zees never landed anything, ever.
--
-- So a TRANSIENT death (429/529/a closed connection/another 5xx/a timeout) is now resumed
-- automatically on a 5/15/45-minute ladder (queenzee/revive.js), and a TERMINAL one (401, invalid
-- key, disabled org, unknown model, exhausted credit) is never resumed and raises a tend naming the
-- account. These four columns are the SCHEDULER's state — what the loop reads to decide whether a
-- zee is due, and what a human (or a `GROUP BY revive_class`) reads afterwards to answer "how often
-- does the fleet die on the provider, and how often does reviving it work?".
--
-- Why columns on `zee` rather than a table: the state is one-per-zee and is only ever read with the
-- zee row (the loop's scan joins xell for the pause/retirement guards). The per-attempt HISTORY —
-- which is what the revival RATE is computed from — rides the append-only session_event log
-- ('turn-death' / 'zee-revive'), exactly as tend, the hints and a held nudge do; the dev schema is
-- frozen and this is the same shape.
--
-- Additive + idempotent (IF NOT EXISTS), and every column is nullable-or-defaulted, so an existing
-- fleet reads as "no death classified, never revived, nothing due" — which is true of every zee that
-- died before this shipped, and is what keeps the loop from waking a backlog of dead xells on boot.
ALTER TABLE zee ADD COLUMN IF NOT EXISTS revive_class    text;         -- 'transient' | 'terminal' | 'unknown'
ALTER TABLE zee ADD COLUMN IF NOT EXISTS revive_signal   text;         -- '429' | '529' | 'closed' | 'auth' | 'credit' | …
ALTER TABLE zee ADD COLUMN IF NOT EXISTS revive_attempts int NOT NULL DEFAULT 0;
ALTER TABLE zee ADD COLUMN IF NOT EXISTS revive_next_at  timestamptz;  -- when the loop should resume it (NULL = nothing due)
ALTER TABLE zee ADD COLUMN IF NOT EXISTS revived_at      timestamptz;  -- when the last revive was started

-- The loop's only scan. Partial, because the due set is a handful of rows in a table of hundreds and
-- the overwhelming majority of zees never carry a schedule at all.
CREATE INDEX IF NOT EXISTS zee_revive_due_idx ON zee (revive_next_at) WHERE revive_next_at IS NOT NULL;

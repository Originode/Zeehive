# Implementation Plan: Per-Xell Observability UI

**Date:** 2026-08-07
**Author:** Architect (implement-observability-ui-similar-to-how-re-43ca00)
**Status:** Implemented and verified in this xell

## Goal

A human right-clicks a xell in the honeycomb and gets a **play-by-play, per-turn** view of
what the zee did: token usage per turn, cost per turn, model, duration, end state, a summary
of what it said, and the expandable event log (assistant text, tool calls, results).

## Design Summary (see docs/observability-decision-record.md for the full record)

- **Boundary:** one unit = one TURN. A turn is a queenzee-started session invocation
  (spawn/resume) or an interactive turn (a human typing into the pane). The zee row stays the
  LIFETIME burn; `zee_turn` is the per-turn grain.
- **Data shape:** `zee_turn` (one row per turn with its own cost/tokens/session/model/
  timing/summary/status) + `session_event.turn_id` (play-by-play attribution). The turn's own
  burn mirrors the zee row's migration-030 columns so `usageFrom()` feeds both.
- **Migration:** additive + idempotent. New table; nullable FK. No existing reader changes.
  The server boots and applies `db/migrations/*.sql` automatically (`runMigrations`).
- **Writer contract:** every turn boundary the queenzee already observes now writes the
  ledger — spawn (intake), resume (nudge), interactive (self), pause/error closes. Best-effort
  (never throws), because observability must never sink a zee's completion.
- **Reader contract:** `GET /xells/:id/observability` lists turns newest-first;
  `GET /turns/:id/events` fetches one turn's play-by-play. Both 503-not-throw.

## Build Steps (all done)

### 1. Migration — `db/migrations/153_xell_observability_ledger.sql`
- `CREATE TABLE zee_turn` — id, zee_id (FK CASCADE), xell_id, project_id (denormalised),
  kind (`spawn|resume|interactive`), status (`started|ended|errored|paused`), session_id,
  model, started_at/ended_at, cost_usd, input/output/cache_read/cache_write_tokens, metered,
  stop_reason, summary, meta.
- `ALTER TABLE session_event ADD COLUMN turn_id uuid REFERENCES zee_turn ON DELETE SET NULL`
  + index.
- Verified: applies cleanly on a fresh postgres (`zee db-sandbox --migrate` → 153 in ledger;
  `\d zee_turn` shows the full shape).

### 2. Server ledger — `server/src/lib/turn-ledger.js`
- `startTurn({ zee, xell, kind, sessionId, model, startedAt, meta })` → turn row.
- `endTurn(turnId, { status, burn, stopReason, summary, endedAt, meta })` → updated row.
- `turnsForXell(xellId, { zeeId, limit })` → newest-first turn rows.
- `eventsForTurn(turnId)` → session_event rows for the turn.
- `lastAssistantText(msg)` → the last assistant text a turn produced.
- All best-effort, never throw.

### 3. Writers
- **intake.js SDK spawn:** `startTurn` after zee insert; `endTurn` on result (with burn +
  summary), on no-result (`metered:false`), and on error. Feed events persist with `turn_id`
  (source `cxell-feed`, hook_event_name = event type, raw = the event).
- **intake.js cxell spawn:** same shape; `endTurn` on result, on fleet-pause (`paused`), on
  error. Feed events persist with `turn_id`.
- **nudge.js resume:** `startTurn(kind='resume')` after `claimZeeTurn`; `endTurn` on result,
  on death, on exec-failure.
- **self.js interactive:** `startTurn(kind='interactive')` on `zee turn --start`;
  `endTurn` on `--end`.

### 4. Reader routes — `server/src/api/routes.js`
- `GET /xells/:id/observability` → `{ ok, xell_id, turns }`.
- `GET /turns/:id/events` → `{ ok, turn_id, events }`.

### 5. Web
- `web/src/api.js`: `getXellObservability`, `getTurnEvents`.
- `web/src/XellObservability.jsx`: the panel. Turn rows (kind/status/model/tokens/cost/
  duration/time) + expandable event log.
- `web/src/hive/HiveCanvas.jsx`: `observability` verb (◉) on the MACHINE petal, tooltip,
  `VERB_MENU_LABEL` ("◉ Observability").
- `web/src/App.jsx`: handleFlowerAction (`setObsXell`) + modal render.
- `web/src/styles.css`: `.xob-*` / `.ob-*`.

## Verification (done in this xell)

| Check | Evidence |
|---|---|
| Migration applies | `zee db-sandbox --migrate` → `153_xell_observability_ledger.sql` in ledger; `\d zee_turn` + `\d session_event` show the shape |
| Ledger writes + reads | `/tmp/verify-turn-ledger.cjs` against sandbox: `started turn → ended turn cost=0.0123 tokens=100 → turnsForXell=1 → eventsForTurn=1 → lastAssistantText` |
| Routes live | `zee build server --wait` → UP serving HEAD; `curl /api/xells/:id/observability` → `{ok, turns}` |
| Web compiles | esbuild transform of `App.jsx`, `HiveCanvas.jsx`, `XellObservability.jsx`, `api.js` all pass |
| Web test suite | `xell-context-menu`, `manager-hexagon`, `show-harness-toggle`, `queenzee-node`, `hive-identity-colors`, `app-dialog-jsx` all pass |
| Migration lint | `migration-numbers.test.mjs` all pass (153 not colliding) |
| No test data | `SELECT count(*) FROM zee_turn` → 0 after cleanup |

## Follow-ups (deliberately out of scope)

- **Retention** — the feed-event `INSERT` is unbounded. A future retention sweep or a capped
  `turn_event` table would bound it. See the decision record's "What Would Change Our Mind".
- **Richer summaries** — the current `summary` is the last assistant text. A structured
  narrative (commit, landing, result) is a separate summariser.
- **Live streaming into the panel** — the panel fetches on open + manual refresh. A live
  SSE/WS subscription (like the terminal) is a natural next step but not required for the
  initial read-only surface.
- **Per-turn transcript link** — when a human wants the full transcript for one turn, link
  `xell_conversation` to `turn_id` rather than storing per-turn archives.

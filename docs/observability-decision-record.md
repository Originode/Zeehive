# Decision Record: Per-Xell Observability UI (turn ledger + play-by-play)

**Date:** 2026-08-07
**Author:** Architect (implement-observability-ui-similar-to-how-re-43ca00)
**Status:** Implemented (migration 153 + server turn-ledger + web panel)

## Decision

The console gains a per-xell **observability** surface, reached from the xell's right-click
context menu (and the flower's MACHINE petal). It shows **one row per TURN** — the unit a
human replays — with that turn's cost, token burn, model, timing, end state, a summary of
what the zee said, and an expandable **play-by-play event log** (the same stream-json feed
intake.js already broadcasts, now persisted per turn).

The storage shape is **two additions, both on established precedent**:

1. A **`zee_turn`** table — one row per turn (`spawn` | `resume` | `interactive`), each
   carrying the turn's OWN burn columns (mirroring the zee row's migration-030 columns) plus
   `session_id`, `model`, `started_at`/`ended_at`, `stop_reason`, `summary`, and `status`.
2. A nullable **`session_event.turn_id`** FK — so the play-by-play events (assistant text,
   tool_use, tool_result, result) attribute to the turn they belong to. `session_event` is
   the existing append-only event log (tend/hints/refusals already ride it); the new column
   is backward compatible (every existing INSERT uses an explicit column list).

The ledger is written at every turn boundary the queenzee already observes:
- **spawn** (intake.js, both SDK and cxell paths) — a turn row starts; feed events persist
  with `turn_id`; the row closes with the turn's own `usageFrom()` burn + a summary of the
  last assistant text.
- **resume** (nudge.js) — a `kind='resume'` row starts; closes on the resumed turn's result.
- **interactive turn** (self.js `zee turn --start|--end`) — a `kind='interactive'` row
  starts/ends (cost stays measured-zero: this door has no meter, and a silent zero is the
  honest reading).
- **fleet-pause / error** — the turn row is closed `paused` / `errored`, never left dangling
  in `started`.

The web surface is a **read-only panel** (`web/src/XellObservability.jsx`), opened by a new
`observability` verb (◉) on the MACHINE petal + right-click context menu.

## Context

The task: "implement observability ui similar to how RelayPlane vs LiteLLM vs Helicone vs
Bifrost implements theirs. i want everything that ang agent does, logged and observed so that
when i right click a xell i can view play by play logs, token usage per turn, cost, etc."

The fleet already had the *ingredients* but not the *grain*:

- The **zee row** carries LIFETIME burn (`cost_usd` + token counters, migration 030) — the
  right number for a fleet burn, the wrong grain for "what did THIS turn do and cost?". A
  xell that hosted three zees (a swap, a resume) or one zee that ran three turns cannot say
  which turn spent what.
- **Langfuse** (migration 114) is the system-wide LLM observability stack — it records traces
  per finished turn and the console has a "View Langfuse" verb that opens the session. But it
  is a **separate self-hosted instance** (its own UI, its own login), and it only works when
  the plugin is provisioned + enabled. The ask is a **native console surface**, available
  without any external stack.
- **session_event** is the append-only log of hook/fleet events — but it is sparse: tend
  pings, hints, refusals. The rich play-by-play feed (assistant blocks, tool calls, results)
  that intake.js's `feed()` receives is broadcast on the SSE bus as `'zee-output'` and then
  **discarded** — nothing persists it.
- **`xell_conversation`** (migration 112) archives the *whole transcript* on demand, but it is
  opt-in (the `zee upload-conversation` verb or a harness checkbox), heavyweight (the raw
  JSONL), and not per-turn.

So the design decision is: **introduce the missing per-turn grain natively** (`zee_turn`),
**persist the existing feed events against it** (`session_event.turn_id`), and **render both
in the console** — without requiring Langfuse or an upload.

## Options Considered

### Option A: Read everything from Langfuse's public API (native console = Langfuse UI)
- **For:** No new schema; Langfuse already records traces with tokens + cost per turn.
- **Rejected because:** Langfuse is a separate self-hosted stack (opt-in, provisioned by a
  human; disabled by default). The ask is a native surface that works without it. The console
  would depend on an external instance being up, and the "play-by-play" in Langfuse is the
  *session* view, not per-turn attribution in the ZEEHIVE honeycomb's own words. Langfuse
  stays as the deep-dive companion (the existing "View Langfuse" verb), not the primary.

### Option B: Store the whole transcript per turn (a `xell_conversation` per turn)
- **For:** Complete fidelity; the transcript IS the play-by-play.
- **Rejected because:** Heavyweight and redundant with `xell_conversation`. The play-by-play a
  human wants in the console is the *event feed* (assistant text, tool calls, results), not
  the raw JSONL. Storing one archive per turn multiplies storage for little gain. The existing
  `xell_conversation` already covers "read the whole transcript" when needed.

### Option C: Reuse the zee row only (add per-turn columns to zee)
- **For:** No new table; the zee row is already the fleet's burn record.
- **Rejected because:** The zee row is LIFETIME by design (migration 030's additive UPDATE
  makes it cumulative). Adding per-turn columns would fight that invariant and still not
  capture multiple turns per zee (a resumed zee runs several turns over its life). A separate
  table is the honest home.

### Option D: Reuse `session_event` for everything (no zee_turn table)
- **For:** One append-only log; no new table.
- **Rejected because:** session_event has no per-turn aggregation columns (cost, tokens,
  model, session, summary). Deriving "one row per turn" from it would mean GROUP BY over a
  log whose boundaries are not marked. The turn IS a first-class unit (it has a cost, a
  duration, a session) — it deserves a row.

## Why the Rejected Ones Were Rejected

| Option | Specific cost |
|---|---|
| A (Langfuse-only) | Adds a hard dependency on a separately-provisioned stack; the native surface would be empty when Langfuse is off. The play-by-play lives in a foreign UI. |
| B (transcript per turn) | Storage × turns; redundant with `xell_conversation`; the raw JSONL is not what the console renders. |
| C (per-turn columns on zee) | Fights the zee row's cumulative invariant; cannot model multiple turns per zee. |
| D (session_event only) | No per-turn aggregates; turn boundaries are not marked in the log; a derived read would be fragile. |

## Consequences

### What this makes easy
- **Per-turn cost/token answers** — "which turn spent what?" is one row read.
- **Play-by-play replay in the console** — the feed events a human sees on the SSE bus are
  persisted against the turn that produced them.
- **No external dependency** — the observability panel works with or without Langfuse.
- **Backward compatible** — `zee_turn` is a new table; `session_event.turn_id` is nullable
  and every existing INSERT leaves it null. No existing reader changes.
- **Survives a xell's zee churn** — `zee_turn` rides `ON DELETE CASCADE` with the zee, but
  `xell_id`/`project_id` are denormalised (like `xell_conversation`, 112) so the turn history
  stays findable after a zee is decommissioned.

### What this makes hard
- **The feed persistence is best-effort** — it is an un-awaited `INSERT ... catch(() => {})`
  in the hot feed path. A pg blip silently drops events (the turn row itself still lands, so
  the cost/token numbers survive). This is the deliberate contract: observability must never
  slow or fail a zee's live feed.
- **Interactive turns have no meter** — `zee turn --start/--end` reports a boundary, not a
  cost (the cage's hook cannot see what the vendor charged). The turn row is started and ended
  with measured-zero burn. This is the same honesty rule TKT-99-1390 established for unmetered
  headless turns.
- **The summary is the LAST assistant text**, not a structured "what happened". A richer
  narrative (commit message, landing, task result) would need a separate summariser; out of
  scope.

### What this makes impossible
- Nothing. Every previous behaviour is preserved.

## Reversibility

| Step | Reversible? | How |
|------|-------------|-----|
| `zee_turn` table | Yes | Stop writing it; the table is inert. `DROP TABLE` if truly unwanted (safe: nothing depends on it except `session_event.turn_id`). |
| `session_event.turn_id` FK | Yes | Nullable; remove the column or ignore it. Existing INSERTs are unaffected. |
| Feed-event persistence in intake.js | Yes | Remove the `INSERT` block; `broadcast('zee-output')` stays. |
| Web panel + verb | Yes | Remove the `observability` verb from `petalVerbs`/`VERB_LABEL`/`VERB_MENU_LABEL` and the modal render. |

**One-way doors:** none. Every piece is additive and removable.

## What Would Change Our Mind

- If the feed-event persistence proves too noisy (the console replays megabytes per turn),
  the `session_event` INSERT should be trimmed (store only `assistant`/`tool_use`/`result`,
  drop `system`) or moved to a dedicated `turn_event` table with a bounded row cap.
- If per-turn aggregation across many xells becomes a query bottleneck (the console's
  observability endpoint filters by `xell_id` + `started_at DESC`), a per-project summary
  table or a retention window would be justified.
- If a human wants per-turn *transcripts* (not just the event feed), the existing
  `xell_conversation` archive should be linked to the turn (`turn_id` on `xell_conversation`)
  rather than duplicating storage.

## Files Changed

```
A  db/migrations/153_xell_observability_ledger.sql   (NEW — zee_turn + session_event.turn_id)
A  server/src/lib/turn-ledger.js                     (NEW — startTurn/endTurn/turnsForXell/eventsForTurn/lastAssistantText)
M  server/src/queenzee/intake.js                     (spawn turns, feed-event persistence, pause/error closes)
M  server/src/queenzee/nudge.js                      (resume turns)
M  server/src/queenzee/self.js                       (interactive turns)
M  server/src/api/routes.js                          (+ /xells/:id/observability, + /turns/:id/events)
A  web/src/XellObservability.jsx                     (NEW — the panel)
M  web/src/api.js                                    (+ getXellObservability, + getTurnEvents)
M  web/src/hive/HiveCanvas.jsx                       (+ 'observability' verb, label, tooltip, menu label)
M  web/src/App.jsx                                   (handleFlowerAction + modal render)
M  web/src/styles.css                                (.xob-* / .ob-* styles)
```

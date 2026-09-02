# Stage 4 — the medic leaves the xell: meta-plane driver, GRANT-scoped writes, the Medic Bay

**Implements:** [docs/medic-meta-plane-plan.md](../medic-meta-plane-plan.md) (DR-7/DR-8 in the
[decision record](../provision-proof-decision-record.md)). **Prerequisite:** stage 3 is on main
(the handlers this stage re-hosts, the capability column, migration 242).
**Supersedes stage 3's PLACEMENT:** the medic is NOT a manager zee in a xell — do not call
`createManagerZee` on the dispatch seam when this stage is done. Read the plan first; it decides
everything structural here. The directive, verbatim: *"a medic is not to be deployed in a xell.
a medic sees and updates meta-db, and deploy zees if needed. make a separate ui for medic
hexagons."*

## Build (in this order — each step lands runnable)

1. **Schema** (`zee migration-number` first; `--again` per extra file):
   - `medic` + `medic_action` tables exactly as plan §3.1 (status values in a CHECK; comments
     on every column per house style);
   - relax `zee.xell_id` to nullable, add `zee.medic_id uuid REFERENCES medic ON DELETE
     CASCADE`, add the exactly-one-of CHECK; same trio on `zee_conversation`. Audit
     `one_active_zee_per_xell` (001) — it must not fire on NULL xell_id;
   - widen the gateway/self-token resolution: `medic.token_hash` with a `mintMedicToken`
     mirroring `lib/xell-token.js`, and the gateway's token→caller lookup answering (xell |
     medic). The self-verb routes stay xell-only — a medic has no `zee` CLI.
2. **The role** (`lib/medic-role.js`): mint `zeehive_medic` idempotently at boot with the exact
   GRANT surface of plan §3.3 / DR-8 — audit the table list against the LIVE schema, never a
   hardcoded copy (the `*_hint` sibling rule). `MEDICRW_MODE=simulate` mints nothing and
   returns a DSN that cannot authenticate. A dedicated small pool connects as the role.
3. **The tool registry** (`lib/medic-tools.js`) — a SEPARATE module from `langchain-tools.js`,
   never merged (a zee loop must not be able to name a medic tool). The plan §4 table is the
   spec: `meta_select` (READ ONLY txn, row cap, timeout), `meta_write` (single statement on the
   role pool; the `medic_action` audit row is written FIRST on the OWNER pool), the three
   `source_*` tools (path-guarded to the xource root — resolve symlinks before the guard; no
   write/exec sibling), the stage-3 handlers in-process (`readiness`/`proof`/`bootstrap_plan`/
   `settings`/`manifest_refresh`), `bootstrap_perform` (files the HUMAN-GATED `infra_request`
   card — performs nothing), `condition_add`/`condition_remove`, `dispatch_worker` (REFUSES any
   project that is not the orchestrator's own — reuse `selfProjectId()`), `report`/`need_human`.
   Every refusal is a `{ ok:false, refused:true, reason }` tool RESULT, never a throw.
4. **The driver** (`queenzee/medic-spawn.js`): mirror `queenzee/langchain-spawn.js` — medic row
   → zee row (`medic_id`, no xell) → `startTurn` → `runLangchainAgentTurn` with the MEDIC
   registry → persist conversation keyed by medic → `endTurn`. Same SSE/feed event contract so
   the Bay replays the loop. System prompt = the `infra-medic` harness bundle (a migration
   re-points its runbook to the meta-plane manual via `harness_memory_put` — house rule 9; the
   harness row stays the authoring surface even though nothing wears it in a cage).
5. **Cutover + UI, one landing:** `POST /project-conditions/:condId/dispatch-medic` reads the
   project knob `medic_plane` (`'meta'` default | `'manager-zee'` — a migration adds it): meta →
   medic row + first turn; manager-zee → the old `createManagerZee` path, kept callable.
   `web/src/MedicBay.jsx` per plan §5: own pane, hexagons from `medic` rows (reuse `hive/hex.js`
   geometry, own palette), transcript + `medic_action` ledger + pending cards + worker links +
   Retire; `awaiting-human` joins the needs-you bar. The honeycomb is NOT touched — it renders
   xell rows and never sees a medic.

Out of scope (the follow-up landing, NOT yours): removing the meta-RO dispatch bind (241) and
the `/api/xell/self/infra/*` medic consumer. They stay landed and harmless.

## Refusals to preserve (they are the design)

- No bash / file-write / docker / git tool exists in the medic registry — absence is the wall.
- The medic role holds NO grant on `xell`, `zee`, `medic`, `harness`, gate tables or ledgers;
  `medic_action` is written on the owner pool only.
- `bootstrap --perform` performs NOTHING until a human approves the card (unchanged).
- `dispatch_worker` targets the orchestrator's own project only; the worker's landings cross
  the normal gates.
- Project creation stays a human console act (DR-6).

## Verify

Standalone `test/*.test.mjs`, each watched failing first:
- the exactly-one-of CHECKs (zee, zee_conversation) and `one_active_zee_per_xell` under NULLs;
- the role's GRANT surface asserted against the live sandbox schema (SELECT-all-minus-
  provider_token; write list exact; `UPDATE xell` and `DELETE FROM container` REFUSED by
  postgres in the test, not by tool code);
- `meta_write` audits before it commits, and a role-refused write still leaves an audit row;
- `source_*` path guard (a `../` and a symlink escape both refused as tool results);
- `dispatch_worker` refuses a non-orchestrator project;
- the dispatch seam under both knob values; `MEDICRW_MODE=simulate` mints nothing;
- registries disjoint: no medic tool name resolves in `LANGCHAIN_TOOLS` and vice versa.

DDL on `zee db-sandbox --migrate` only (the assigned db is the SHARED dev db). Exercise the
driver end-to-end in-cage against the sandbox with a stub model if the live gateway cannot be
reached; report exactly what was and was not exercised live.

## Land

Commit as you go; land when green. The landing message names the migration numbers, states that
the dispatch seam is knob-guarded (`medic_plane`), and that no capability or grant was widened
for any existing harness or role.

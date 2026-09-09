# The medic lives in the META PLANE — design and migration plan

**Date:** 2026-09-02
**Author:** Architect (xell `wise-delta-84e470`)
**Status:** Decided — design only; implementation is the kit brief
[provision-proof-kit/stage-4-medic-meta-plane.md](provision-proof-kit/stage-4-medic-meta-plane.md).
**Supersedes:** the PLACEMENT and WRITE-MODEL halves of DR-5 (2026-09-02 correction) in
[provision-proof-decision-record.md](provision-proof-decision-record.md) — restated there as
DR-7/DR-8. **Keeps:** DR-6 (project creation stays human), the scope wall (the medic never
touches another project's code), the capability column, the host-mutation gate.
**Directive (verbatim):** *"medic lives in meta plane. it should be like a manager where it can
only see zeehive source code, but not touch it. it can fully access meta-db to fix configs so
xells can actually access dbs, or build, etc. they deploy a zee only if zeehive code needs
changes. … a medic is not to be deployed in a xell. a medic sees and updates meta-db, and deploy
zees if needed. make a separate ui for medic hexagons."*

---

## 1. What was wrong with the last correction

The 2026-09-02 rework (migration 242, DR-5 as corrected) re-typed the medic worker → MANAGER on
the Zeehive project. That fixed the *scope* (whole-meta-DB read, config-not-code) but kept the
*placement*: `createManagerZee` → `dispatchXell` → a **real xell** — a claimed pool slot, a
worktree, a branch, a caged CLI, containers to build, a hexagon in the honeycomb, and a land
gate it will never legitimately use. Live dispatches showed the consequence: a medic sent to fix
"this project cannot provision xells" was itself provisioned as a xell, subject to the very
faults it was sent to fix (the dead shared-dev db, the exhausted docker pools, the SCRAM
refusals). An organ that repairs the fleet's provisioning cannot depend on the fleet's
provisioning. And its human-gated `propose` cards made every one-line config fix (a wrong
`conn_pw`, a stale manifest cache) a two-actor round-trip when the whole point of the medic is
that the human stops being the bottleneck.

The corrected model, in one sentence: **the medic is a meta-plane resident — an agent loop the
queenzee runs in its own process, with full (role-scoped) meta-DB access, a read-only view of
the Zeehive source, the power to dispatch a Zeehive worker when code must change, and its own
UI surface (the Medic Bay) instead of a honeycomb hexagon.**

## 2. Boundaries — what is one thing, what is two

- **The medic is an AGENT, not an ENVIRONMENT.** A xell is an isolated environment; a zee is an
  agent. The medic is a zee **with no environment**: no worktree, no branch, no containers, no
  cage. Its "workspace" is the meta-DB itself plus a read-only window onto the xource.
- **The medic plane is the queenzee's plane.** The loop runs in the queenzee process, on the
  precedent already landed for langchain zees (`lib/langchain-zee.js` /
  `queenzee/langchain-spawn.js`): the queenzee invokes the loop, owns the turn ledger, and the
  gateway records every model call. No new scheduler, no framework loop.
- **Confinement moves from the cage to three walls.** A cxell's wall is the container. The
  medic's walls are: (1) the TOOL REGISTRY — a fixed allowlist, no bash/file-write/docker/git
  tool exists; (2) the POSTGRES ROLE — its SQL tools run on a dedicated `zeehive_medic` role
  whose GRANTs are the config surface and nothing else (postgres refuses, not a prompt); (3)
  the HUMAN GATES that remain on host mutations (bootstrap `--perform`) and on everything a
  dispatched worker does downstream (land/ship).
- **Code changes are two things, never one.** Meta-DB config faults: the medic fixes them
  itself, directly. ZEEHIVE code faults: the medic dispatches an ordinary Zeehive WORKER (a real
  xell, normal gates) with a brief. Another project's code faults: reported, never fixed —
  the scope wall survives unchanged.

## 3. Data shape

Data outlives code; this is the part to get right.

### 3.1 A `medic` table, and `zee` decoupled from `xell`

```sql
CREATE TABLE medic (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_project_id  uuid NOT NULL REFERENCES project,
  condition_id       uuid REFERENCES project_condition ON DELETE SET NULL,
  brief              text NOT NULL,             -- the condition/card verbatim + the dispatch preamble
  status             text NOT NULL DEFAULT 'diagnosing',
    -- 'diagnosing' | 'acting' | 'awaiting-human' | 'worker-dispatched' | 'converged' | 'retired' | 'errored'
  needs_human_reason text,                      -- the medic's one-line ask when status='awaiting-human'
  token_hash         text,                      -- gateway identity (same discipline as xell.self_token_hash)
  created_at         timestamptz NOT NULL DEFAULT now(),
  retired_at         timestamptz
);

CREATE TABLE medic_action (                     -- the audit ledger: every write the medic performs
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  medic_id    uuid NOT NULL REFERENCES medic ON DELETE CASCADE,
  tool        text NOT NULL,                    -- which registry tool ran
  statement   text NOT NULL,                    -- the exact SQL / verb args, verbatim
  tables      text[] NOT NULL DEFAULT '{}',
  rows_affected int,
  result      jsonb,                            -- receipt (dispatch slug, refresh outcome, …)
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE zee ALTER COLUMN xell_id DROP NOT NULL;
ALTER TABLE zee ADD COLUMN medic_id uuid REFERENCES medic ON DELETE CASCADE;
ALTER TABLE zee ADD CONSTRAINT zee_exactly_one_plane
  CHECK ((xell_id IS NOT NULL)::int + (medic_id IS NOT NULL)::int = 1);
```

Why relax `zee.xell_id` instead of minting a "virtual xell": a fake xell row would ride into
every consumer of xell rows — the pool sweeps, the reaper, the provisioning reconcile, the
preflight, the proof ladder, and the honeycomb (the exact surface the directive says the medic
must LEAVE). The zee row is the agent identity the observability spine already hangs off
(`zee_turn.zee_id`, feed events, burn columns), and `zee_turn.xell_id` / `session_event.xell_id`
are already nullable — the spine tolerates a xell-less zee today. Every existing query that
JOINs zee→xell keeps working and simply never sees a medic, which is the separation we want,
for free.

`zee_conversation` (the durable turnover store, keyed by xell_id as "the durable work unit")
gains the same shape: `xell_id` relaxed, `medic_id` added, same exactly-one CHECK. For a medic
the durable unit IS the medic row — a resumed medic starts warm on its own history.

### 3.2 What is authoritative

- The **medic row** is authoritative for placement and status; the zee row under it is
  authoritative for the running turn (burn, stop reason) — same split as xell/zee today.
- The **`medic_action` ledger** is authoritative for "what did the medic change": the mutable
  config rows it edits carry no history, so the ledger is the only receipt. Append-only,
  broadcast on write, rendered in the Medic Bay.
- **Gateway attribution:** `mintMedicToken(medicId)` mirrors `lib/xell-token.js` (hash stored on
  `medic.token_hash`); the gateway's token resolution widens to (xell | medic). Every medic
  model call lands in `llm_gateway_request` like any other.

### 3.3 The postgres role — the write wall, in GRANTs

One long-lived role, minted idempotently at boot (`MEDICRW_MODE=simulate` mints nothing, same
contract as `PRODRO_MODE`):

- `GRANT SELECT` on all tables **except** `provider_token` (`token` stays revoked — a broken
  provider auth is a human re-auth, per the standing conditions; nothing the medic fixes needs
  to read a vendor key). This is the "fully access meta-db" READ: the whole estate, including
  `container.conn_pw` and `environment_var.value`, because a credential-shaped config fault
  (TKT-181) is exactly the patient.
- `GRANT INSERT, UPDATE` (and `DELETE` only where a row is legitimately removable) on the
  CONFIG surface: `machine`, `machine_pool`, `pool_config`, `container` (no DELETE — deleting a
  container row is the reaper's act), `environment`, `environment_var`, `deploy_site`,
  `project_condition` (full — deleting a stale condition is the medic's job),
  `build_readiness_record`, and column-scoped `UPDATE` on `project` (the manifest-cache and
  pool/readiness knob columns only).
- **No grant, ever:** `xell`, `zee`, `medic`, `harness` (no self-grant), `provider_token`, the
  gate tables (`landing_request`/ship/seed/`infra_request`), the ledgers (`zee_turn`,
  `llm_gateway_request`, `medic_action` — the driver writes the audit on the OWNER pool, so the
  medic role cannot forge or trim its own receipts).

This answers `docs/self-project-prod-data.md`'s incident directly: the rejected role was one
that "can UPDATE xell / DELETE container" — a nested reaper. This role can do neither, by GRANT.

## 4. Interfaces — the medic tool registry

A second registry beside `LANGCHAIN_TOOLS` (`lib/medic-tools.js` — never merged into the zee
registry; a zee loop must not be able to name a medic tool). The identity comes from the turn:
the driver passes the `medic` row, the model supplies only args.

| tool | writes | notes |
|---|---|---|
| `meta_select` | nothing | arbitrary SELECT, run on the medic role's pool in a `READ ONLY` transaction; row cap + timeout |
| `meta_write` | config rows | single INSERT/UPDATE/DELETE statement, medic-role pool (GRANTs enforce the surface), audited to `medic_action` before commit |
| `source_read` / `source_search` / `source_history` | nothing | file read / grep / `git log -p` against the XOURCE checkout, path-guarded to the repo root; **no write/exec sibling exists** — "sees the source, cannot touch it" is structural |
| `readiness` / `proof` / `bootstrap_plan` / `settings` / `manifest_refresh` | throwaway containers at most | the same handlers stage 3 landed, called in-process with an explicit target project |
| `bootstrap_perform` | an `infra_request` card | **still HUMAN-GATED** — it mutates real docker on real hosts, which the directive's "fully access meta-db" does not cover |
| `condition_add` / `condition_remove` | `project_condition` | the manager-verb equivalent — a fixed fault DELETES its condition line |
| `dispatch_worker` | a real Zeehive worker xell | pool claim + brief; **Zeehive project only** (the scope wall); the worker's output still crosses the normal land/ship gates |
| `report` / `need_human` | `medic.status/needs_human_reason` | the tend-equivalent: lights the Medic Bay, blocks nothing |

Error contract: every tool returns `{ ok, … } | { ok:false, refused:true, reason }` — a refusal
(GRANT denied, path outside the xource, non-Zeehive dispatch target) is a normal tool result the
model reads, never a thrown turn.

Why direct writes are safe HERE when `langchain-tools.js` refuses workspace tools in-process:
that ruling confines **zees** — per-project, untrusted, whose wall must be the container. The
medic is a fleet organ on the queenzee's own plane, like the pool maintainer or the reaper; its
wall is the registry + the role + the gates that remain. The three tool classes that actually
collapse the process boundary (bash, file write, docker) are still absent.

## 5. The Medic Bay — the separate UI

Medics get their own surface, NOT cells in the project honeycomb (they have no xell, so the
honeycomb — which renders xell rows — excludes them with zero code):

- **A `⛑ Medic Bay` strip/pane in the console** (its own component, `web/src/MedicBay.jsx`),
  rendered from `medic` rows fleet-wide: one hexagon per live medic — reusing `hive/hex.js`
  geometry so the visual language is the fleet's, but in its own canvas with its own palette
  (status → diagnosing / acting / awaiting-human / worker-dispatched / converged). The bay is
  hidden when no medic rows exist.
- **Click → the medic panel:** the target condition verbatim, the live transcript (the same
  SSE feed contract `spawnLangchainZee` emits — assistant text, tool_use blocks, result), the
  `medic_action` ledger (every write, verbatim SQL, rows affected), pending `infra_request`
  cards, dispatched workers (each linking to its REAL hexagon in the honeycomb), and a
  **Retire** button (`status='retired'`, the row kept — the ledger must outlive the medic).
- **`awaiting-human` renders on the needs-you bar** like a tend does today, with the one-line
  reason — a medic must never be stuck invisibly.
- **The dispatch seams do not move:** the ⛑ buttons (needs-you bar, ProjectSetup conditions,
  PROVISION-INFRA cards) keep their exact placement and POST; the handler changes underneath
  (§6). The toast copy changes from "spawning a manager zee" to "medic attending in the bay".
- **The EMERGENCY GATE (refined 2026-09-02, follow-up directive — "do not fill the panel with
  tickets... the point of medic is emergency response. a dispatch button should only show when a
  zee is being blocked").** The ⛑ dispatch affordance renders ONLY while `fleet.medic_emergency`
  is non-empty: live zees whose xell shows infra evidence — a failing db preflight (#53), a
  failing provision proof (236), or an INFRA-classed build failure (233). Computed once,
  server-side (lib/fleet.js), read by both surfaces — one eligibility rule, like the CODE-fact
  exclusion. A condition LINE is information (the editor keeps its list, with a note saying why
  the button is absent); a BLOCKED ZEE is the emergency, and the opened panel leads with who is
  blocked and why. `test/medic-bar-wiring.test.mjs` holds the gate on both surfaces.

## 6. Migration — a running fleet, no flag day

Each step is additive and safe to stop at:

1. **Schema** (numbers via `zee migration-number`): `medic` + `medic_action`, the `zee` /
   `zee_conversation` relaxation + CHECK, the gateway token widening. Nothing reads them yet;
   the old dispatch path is untouched.
2. **Driver + registry + role:** `lib/medic-tools.js`, `queenzee/medic-spawn.js` (mirrors
   `langchain-spawn.js`: medic row → zee row → turn → loop → conversation persist), the
   `zeehive_medic` role mint (idempotent, simulated under `MEDICRW_MODE=simulate`). Runbook:
   migration re-points the `infra-medic` harness bundle to the meta-plane manual — the harness
   row stays the PROMPT SOURCE (persona/memory authoring surface), even though nothing "wears"
   it in a cage any more.
3. **Cutover + UI, one landing:** `POST /project-conditions/:id/dispatch-medic` creates a medic
   row and starts turn 1 (no xell claim, no cage); `MedicBay.jsx` lands in the same change so
   the console can see what the button now creates. A project knob `medic_plane`
   (`'meta'` default | `'manager-zee'`) keeps the old path one flip away.
4. **Decommission (follow-up, after the meta medic has run green):** drop the dispatch-time
   meta-RO bind (`ZEEHIVE_META_RO_DSN`, migration 241 surface) and the `/api/xell/self/infra/*`
   family's medic consumer. The routes themselves may stay (capability-gated, harmless) until
   nothing carries the capability; removing them is its own small landing.

**Live medics at cutover** need no migration: an existing manager-medic is an ordinary manager
xell — it finishes or is retired normally. **The way back:** flip `medic_plane` to
`'manager-zee'`; steps 1–3 are additive (the tables sit idle). The one-way door is step 4 —
that is why it waits.

## 7. What would change our mind

- If the medic role's GRANT surface proves chronically too narrow (fixes keep needing tables
  off the list), widen it **by named table, by migration, one at a time** — never by handing
  the loop the owner pool.
- If in-process medic turns measurably degrade the queenzee (event-loop stalls during long
  loops), move the DRIVER to a sidecar process holding the same role DSN — the registry and
  role are unchanged; only the process boundary moves.
- If a medic's direct writes cause a config incident a human would have caught, demote
  `meta_write` to a gated card for the specific table that burned — per table, recorded as a
  superseding DR, not a blanket retreat to DR-5.

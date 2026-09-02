# Stage 3 — the infra-medic harness: capability, verbs, meta-RO bind

**Implements:** phase 4 of [docs/provision-proof-plan.md](../provision-proof-plan.md) (landed
`302df5b5`). **Prerequisite:** stage 2 is on main (the records and routing its verbs read).
Read plan §7 and DR-5/DR-6 first — they decide everything structural here.

**The 2026-09-02 correction (the medic-rework card).** This stage was first built as a WORKER
harness (migrations 237–241; the `/infra/*` verbs project-resolved from the calling xell). The
first PROVISION-INFRA dispatches corrected the model: a PROVISION-INFRA card is a machine×project
pair that cannot build because the project's CONFIG is wrong — a meta-DB config fix, not a code
fix — and whoever fixes it must read the WHOLE meta-DB, which no worker of any single project is.
So the medic is re-typed **worker → MANAGER on the orchestrator's own project** (migration 242)
and every verb takes an explicit `--project <name|id>` target. The brief below describes that
corrected end state; a builder reading it implements the manager model, not the superseded worker
one.

## Build

1. **Migrations** (`zee migration-number` first; one number per migration, `--again` for the
   second):
   - `harness.capabilities jsonb NOT NULL DEFAULT '[]'`, allowlist-validated by trigger — ONE
     legal value today: `'infra-troubleshoot'`. Capabilities are a COLUMN, never a bundle
     field: the bundle authoring surface (personality/skills/memory) is structurally unable to
     express a grant, and must stay so (237).
   - Create the harness `infra-medic` and its `infra_request` card table via `createHarness` +
     `harness_memory_put` ONLY (house rule 9 — never hand-roll `jsonb_set` on bundles;
     `test/harness-memory-migrations.test.mjs` fails anything newer that tries; 238–239). Its
     memory is the runbook: the readiness ladder, how to read a proof verdict, the bootstrap
     contract, the onboarding definition of done (plan §5: manifest parses / a machine records
     `ok` / first pooled xell proof green), and the standing refusals — never ask for a write
     DSN, never route around a gate, report unfixed faults with the named check (241 adds the
     `xell_meta_ro_dsn` surface).
   - **Migration 242 — re-type the medic to the meta-plane model.** `infra-medic` is re-typed
     worker → manager (column AND the bundle mirror, a scalar `jsonb_set` on `{zee_type}` that
     preserves every sibling key — never a memory rebuild), parented to the `manager` law
     harness, its capability grant (`infra-troubleshoot`) kept on that row and that row only,
     and its runbook REPLACED (model change — the old manual instructs the removed behaviour).
     The replacement runbook teaches: the medic lives on Zeehive (whose production database IS
     the meta-DB), its scope wall is meta-DB config rows only (never another project's code —
     structural, its cage holds only the Zeehive repo), and a ZEEHIVE code fault is a
     `zee dispatch` of a Zeehive worker. The `zee-base` manual's `zee infra` section is patched
     (a single anchored phrase, idempotent, through `harness_memory_put`) to say the family reads
     a TARGET project — your own by default, or the one `--project` names.

2. **Routes** `/api/xell/self/infra/*` in `api/routes.js` — token-scoped, capability-gated
   through the EFFECTIVE harness chain (a harness inheriting the medic counts; a disabled
   ancestor grants nothing), and each verb takes an explicit TARGET project (`project` query/body
   param — name or id; the caller's own project is the default). Reads are open across projects;
   the two mutations file HUMAN-GATED cards on the target:
   - `readiness` (read — run/read machine×project readiness for the target);
   - `proof` (ungated act — burn-in a pooled xell of the target project; throwaway containers,
     same class as `zee build`);
   - `bootstrap-plan` (read — `performBuildBootstrap` dryRun verbatim);
   - `bootstrap` (HUMAN-GATED card → the queenzee performs; identical contract and guards as
     the console 🔧: creates only manifest-declared DEV infra, never invents, never removes,
     `guardDevOnly` intact, every action recorded in `build_bootstrap_action`);
   - `settings` (read — non-secret projection of the target's manifest cache, pool_config,
     machines + machine_pool, container rows, deploy_site);
   - `propose` (HUMAN-GATED settings card → the queenzee applies on approval; who asked, what
     changed, recorded).

3. **Dispatch seam — the ⛑ medic is a MANAGER zee on Zeehive.** `POST /project-conditions/:condId/dispatch-medic`
   (`requireQueenzeeLoops`, refuses WORKER tokens
   403 — MANAGER-only), resolves the condition's TARGET project (the pair that is actually
   broken) and calls `createManagerZee({ project: selfProject, task:
   buildMedicDispatchBrief(cond), harness: 'infra-medic', title: 'infra medic' })` — the medic is
   created on the ORCHESTRATOR'S OWN project, where manager prod-read sees the whole fleet. The
   console surfaces the button wherever a blocker first shows: on PROVISION-INFRA card rows, on
   every hand-written current-condition line, and on the needs-you bar's project chip (#15/#18).

4. **`zee infra` CLI family** in `scripts/zee` mirroring the routes, each verb taking
   `--project <name|id>`. The manual, the briefing and the CLI move TOGETHER
   (`test/cxell-cli-drift.test.mjs` fails the build if they drift) — so the manual text
   documenting the verb family is part of THIS change, landed by migration through
   `harness_memory_put` against `zee-base`'s manual and the medic's own memory.

5. **Meta-RO bind at dispatch** when the worn effective harness carries the capability: reuse
   `lib/prod-readonly.js` machinery pointed at the orchestrator's own meta-DB — per-xell
   `zee_ro_<slug>` role, LOGIN+CONNECT+SELECT, `default_transaction_read_only=on`, SECRET
   COLUMNS REVOKED (provider_token.token, environment_var.value, xell.prod_ro_dsn — and audit
   the list against the live schema, per the `*_hint` sibling rule), injected as
   `ZEEHIVE_META_RO_DSN`, firewall-opened at seal time, dropped by the reaper with the xell.
   Mirror `bindManagerToProdReadonly`'s lifecycle exactly. `PRODRO_MODE=simulate` mints
   nothing real and a DSN that cannot authenticate.

## Refusals to preserve (they are the design)

- No write DSN to the meta-DB exists on any path — postgres refuses, not a prompt
  (docs/self-project-prod-data.md; DR-5).
- `bootstrap` and `propose` PERFORM NOTHING until a human approves the card.
- A harness edit cannot self-grant a capability (the column is outside the bundle, set only by
  migration/console).
- The medic never edits another project's code — meta-DB config rows are the whole surface; a
  ZEEHIVE code fault is a `zee dispatch` of a Zeehive worker, not a medic land.
- Project creation stays a human console act (DR-6) — the medic drives convergence after it.

## Verify

Standalone tests, watched failing first:
- the capability trigger allowlist (unknown value refused; empty default fine);
- route refusal without the capability, acceptance with it (through the effective CHAIN — a
  harness inheriting the medic counts);
- migration 242 idempotence and shape: infra-medic is MANAGER-type after the migration, its
  parent is the manager law harness, its runbook is the meta-plane manual, and every sibling
  memory file survives (no memory rebuild);
- the dispatch seam: a WORKER token is refused 403, a MANAGER create lands on the orchestrator's
  own project with the card's TARGET project in the brief, and the condition surfaces on the
  needs-you bar / conditions editor with the ⛑ button;
- gated verbs create pending cards and perform nothing pre-approval; approval performs and
  records;
- the settings projection leaks no secret column (assert against the live sandbox schema, not
  a hardcoded list);
- `PRODRO_MODE=simulate` mints nothing;
- `test/cxell-cli-drift.test.mjs` and `test/harness-memory-migrations.test.mjs` green.

Build your own server (`zee build server --wait`, in the background) and exercise the routes
end-to-end against your OWN build with a token-scoped call. Report what needed the real fleet
(the meta-RO role mint, the firewall re-seal, a live manager spawn) and could not be exercised
in-cage.

## Land

Commit as you go; land when green. The landing message names the migration numbers (237–242),
the verb family, the manager re-type, and states that no capability was granted to any existing
harness other than `infra-medic` itself.

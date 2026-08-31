# Stage 3 — the infra-medic harness: capability, verbs, meta-RO bind

**Implements:** phase 4 of [docs/provision-proof-plan.md](../provision-proof-plan.md) (landed
`302df5b5`). **Prerequisite:** stage 2 is on main (the records and routing its verbs read).
Read plan §7 and DR-5/DR-6 first — they decide everything structural here.

## Build

1. **Migrations** (`zee migration-number` first; one number per migration, `--again` for the
   second):
   - `harness.capabilities jsonb NOT NULL DEFAULT '[]'`, allowlist-validated by trigger — ONE
     legal value today: `'infra-troubleshoot'`. Capabilities are a COLUMN, never a bundle
     field: the bundle authoring surface (personality/skills/memory) is structurally unable to
     express a grant, and must stay so.
   - Create the system-wide worker harness `infra-medic` via `createHarness` +
     `harness_memory_put` ONLY (house rule 9 — never hand-roll `jsonb_set` on bundles;
     `test/harness-memory-migrations.test.mjs` fails anything newer that tries). Its memory is
     the runbook: the readiness ladder, how to read a proof verdict, the bootstrap contract,
     the onboarding definition of done (plan §5: manifest parses / a machine records `ok` /
     first pooled xell proof green), and the standing refusals — never ask for a write DSN,
     never route around a gate, report unfixed faults with the named check.

2. **Routes** `/api/xell/self/infra/*` in `api/routes.js` — token-scoped, project-resolved
   from the calling xell (the `zee item` wall: its own project, nothing beside it), enabled
   only when the EFFECTIVE harness chain carries `'infra-troubleshoot'`:
   - `readiness` (read — run/read machine×project readiness for its project);
   - `proof` (ungated act — burn-in a pooled xell of its project; throwaway containers, same
     class as `zee build`);
   - `bootstrap-plan` (read — `performBuildBootstrap` dryRun verbatim);
   - `bootstrap` (HUMAN-GATED card → the queenzee performs; identical contract and guards as
     the console 🔧: creates only manifest-declared DEV infra, never invents, never removes,
     `guardDevOnly` intact, every action recorded in `build_bootstrap_action`);
   - `settings` (read — non-secret projection of the project's manifest cache, pool_config,
     machines + machine_pool, container rows, deploy_site);
   - `propose` (HUMAN-GATED settings card → the queenzee applies on approval; who asked, what
     changed, recorded).

3. **`zee infra` CLI family** in `scripts/zee` mirroring the routes. The manual, the briefing
   and the CLI move TOGETHER (`test/cxell-cli-drift.test.mjs` fails the build if they drift) —
   so the manual text documenting the verb family is part of THIS change, landed by migration
   through `harness_memory_put` against `zee-base`'s manual and the medic's own memory.

4. **Meta-RO bind at dispatch** when the worn effective harness carries the capability: reuse
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
- Project creation stays a human console act (DR-6) — the medic drives convergence after it.

## Verify

Standalone tests, watched failing first:
- the capability trigger allowlist (unknown value refused; empty default fine);
- route refusal without the capability, acceptance with it (through the effective CHAIN — a
  harness inheriting the medic counts);
- gated verbs create pending cards and perform nothing pre-approval; approval performs and
  records;
- the settings projection leaks no secret column (assert against the live sandbox schema, not
  a hardcoded list);
- `PRODRO_MODE=simulate` mints nothing;
- `test/cxell-cli-drift.test.mjs` and `test/harness-memory-migrations.test.mjs` green.

Build your own server (`zee build server --wait`, in the background) and exercise the routes
end-to-end against your OWN build with a token-scoped call. Report what needed the real fleet
(the meta-RO role mint, the firewall re-seal) and could not be exercised in-cage.

## Land

Commit as you go; land when green. The landing message names the migration numbers, the verb
family, and states that no capability was granted to any existing harness other than
`infra-medic` itself.

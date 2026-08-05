# Harness model policy vs. the fleet's three active providers

**Date:** 2026-08-05 · **Encoded by:** `db/migrations/147_provider_priority_scheme_in_harness_model_policies.sql`
(the models) and `db/migrations/148_harness_provider_allowances_the_operator_scheme.sql` (the
providers) · **Routing request:** "evaluate every harness's model/provider policy against the fleet's
CURRENT reality — 3 active providers (claude, deepseek, grok) — and ENCODE the operator's priority
scheme in the harness rows, so dispatch defaults follow it without anyone remembering prose."

This is the evaluation the migrations are the answer to. It is a snapshot with a date on it: the rows
it describes are DATA (house rule 7), so re-read them before you trust a number here.

---

## 1. The operator's scheme, normalized

| tier | provider | the work |
|---|---|---|
| default | **deepseek** | task deployments — builders, fixers, testers, scribes, scouts, shipwrights |
| top | **claude** | managerial work — planning, routing, architecture, the estate |
| middle | **grok** | in-between / medium-difficulty — well-scoped features, reviews |

And the operator's ruling on how it binds — the answer to F6, which 147 had to leave open:

> "yes my intention is that a harness row can forbid a provider from wearing it.
> the weights are only for those allowed providers."

So the persona IS the refusal. `allow_providers` per lane (148) decides *whether* a wearer may run on
a provider at all; the router's `provider_weights` (147) only spread a choice **among what the chosen
harness already allows**; and `priorities` (147) decide *which model* inside a lane, per provider.
Three knobs, one order of precedence — and the first of them is enforced at spawn, not remembered.

## 2. The estate, and what the scheme implies for each row

Two chains, two roots. `core` is the law layer and is deliberately **never consulted** for policy
(`lib/model-policy.js`: "a harness policy is a config layer, not law").

| harness | type | chain (root → leaf) | may wear (148) | model inside the lane (147) |
|---|---|---|---|---|
| `core` | any | (law) | — | untouched — the law layer carries no policy |
| `zee-base` | worker | `zee-base` | claude · deepseek · grok | the WORKER LANE: `deepseek-chat` / `grok-4.5` / `opus` |
| `dev-base` | worker | `zee-base → dev-base` | inherits the three | inherits |
| `dev-builder` · `dev-fixer` · `dev-tester` · `dev-scribe` · `dev-scout` · `dev-shipwright` | worker | `zee-base → dev-base → …` | **deepseek only** | `deepseek-chat` (`deepseek-reasoner` for hard work) |
| `dev-reviewer` | worker | `zee-base → dev-base → dev-reviewer` | **grok only** | `grok-4.5` |
| `dev-architect` | worker | `zee-base → dev-base → dev-architect` | **claude only** | `opus` |
| `trainer` · `teacher` | worker | `zee-base → trainer(→ teacher)` | the three (deliberately unnarrowed — §6) | the worker lane |
| `zeetest` | worker | `zee-base → zeetest` | inherits the three | inherits |
| `hermes` | worker | `hermes` (**no parent**) | **anything** — inherits nothing (F7) | none |
| `manager` | manager | `manager` | **claude only** — *but see §7c: the LIVE row carries `claude, deepseek`, a human's own edit that 148 respects* | `opus` (live: `opus` on claude, `deepseek-reasoner` on deepseek) |
| `dev-lead` · `master` · `queenzee-minister` | manager | `manager → …` | inherits the `manager` row, whatever it says | inherits |
| `router` | manager | `manager → router` | inherits the `manager` row | inherits; `router_policy` carries the shares it hands out |

The lists INTERSECT down the chain, which is why the worker ROOT must allow all three: a child can
only narrow. That is also the safety property — no leaf can widen its way back to a provider its
ancestor forbids.

Per-project harnesses: **none exist today** (`SELECT count(*) FROM harness WHERE project_id IS NOT
NULL` = 0). Every UPDATE in 147 and 148 is guarded with `project_id IS NULL` anyway, so a project
persona minted later is never edited by them — per the constraint that project personas belong to
their projects.

## 3. Effective policy BEFORE 147 (measured, not assumed)

On a **fresh** database (which is every cxell's, and the shape a new prod cut inherits) every single
harness carries `model_policy = {}` except `router` (`{"limit":1}`). The consequence, measured by
resolving a bare dispatch through `resolveDispatchModel` for all 20 rows × 5 providers:

> **Every zee in the fleet, worker or manager, on every provider, resolves to `opus`.**

Not because anyone chose it — because no policy expresses a preference, so `intake.js` hands over
its code fallback `DEFAULT_ZEE_MODEL = 'opus'`. On claude that runs Opus. On deepseek and grok the
adapter DROPS the claude alias (`vendorModel()` in `lib/cxell-runtimes.js`) and the vendor's own
default runs — while the zee row, the console and the cost-per-model telemetry all say `opus`. The
scheme is not merely unencoded; the record of what ran is wrong for two of the three active
providers.

On the **live** database the operator's console edit adds one more mismatch: `zee-base.allow_models
= [deepseek-chat, deepseek-reasoner, fable, opus]` — **no grok model at all**. Because allow-lists
INTERSECT down the chain, that is the whole worker estate. Concretely:

- an **explicit** `--model grok-4.5` on any worker harness is **REFUSED**: *"harness "zee-base" does
  not allow model "grok-4.5"…"*. Grok is unusable by name for every worker;
- a **bare** grok dispatch is not refused — it falls through to `opus`, the alias is dropped, and
  `grok-4.5` runs recorded as `opus`. So the fleet's grok work is invisible in every model-keyed
  report.
- `fable` is allowed and its own spec says *"unproven on unattended zee work"* — it never wins a
  bare dispatch (opus is claude's `is_default`), and 147 keeps it allowed and unpromoted.

## 4. Two hazards that decide the SHAPE of the encoding

**(A) `default_model` is provider-blind, and writing the scheme into it would break the fleet.**
The routing request proposed "worker-harness default → deepseek-chat". `default_model` has no
provider dimension and wins over everything, so `zee-base.default_model = 'deepseek-chat'` resolves
to that string on *every* provider:

- **claude**: `claude --bare … --model deepseek-chat` (the claude adapter passes `--model` verbatim)
  → a dead turn on a model the vendor does not have;
- **grok**: `grok -p … -m deepseek-chat` → the grok CLI validates ids CLIENT-side and ends the turn
  with *"unknown model id"* (measured on 0.2.118, migration 141) → a dead dispatch;
- **deepseek**: correct — one provider in three.

Only claude ALIASES are dropped by the other adapters; a foreign *vendor* id is passed straight
through. So 147 encodes the scheme in **`priorities`**, which IS provider-aware
(`allowedModelsForProvider` filters by the provider's own spec rows): each provider's lane names its
own model, and what is recorded is what runs.

**(B) Any `priorities` at all switch every provider off its vendor default.** In
`resolveDispatchModel`, the existence of priorities is a "model preference", and a NAMED model always
beats the `''` (vendor-default) spec row. So once the scheme exists, kimi and openai — the two
providers the operator has retired — also stop resolving to `''`, and the pick would fall to an
alphabetical accident (`kimi-for-coding` and `gpt-5.4-mini`, by label sort). 147 therefore names one
deliberate model for those two as well (`k3`, `gpt-5.6-terra`) rather than letting the sort decide.
That is a wart of the resolver, not of the scheme — see the follow-up in §6.

*(148 then makes those two entries unreachable rather than merely unlikely: once a row forbids kimi
and openai outright, a priority for their models can never be read, so 148 drops exactly the entries
its own `allow_providers` proves dead — and only those. A priority whose model has no spec at all is
left alone: unknown is not dead.)*

## 5. Findings

- **F1 — the scheme was nowhere in the data.** Every effective policy resolved to `opus` (§3).
  *Fixed by 147.*
- **F2 — grok is refused by name for the whole worker estate** on the live db (§3). *Fixed by 147*
  (additive union into the two ROOT allow-lists; no allowance removed).
- **F3 — deepseek/grok zees are recorded as `opus`.** Same root cause as F1; the per-provider
  priorities make the recorded model the one that ran. *Fixed by 147 for bare dispatches.*
- **F4 — `default_model` cannot express a per-provider scheme** (§4A). *Encoded via priorities
  instead; 147 also drops a legacy `default_model = 'opus'` on the two lane roots, anchored on that
  exact value, because the lane priorities now say the same thing per provider and say it truthfully.*
- **F5 — the manual still tells a caged zee its CLI is "claude, codex or kimi".** Drift of exactly
  the class migration 115 fixed: deepseek and grok zees read that they are something else. *Fixed by
  147, anchored, through `harness_memory_put` (house rule 9).*
- **F6 — the harness layer can FORBID a provider but not PREFER one — RESOLVED BY THE OPERATOR.**
  147 could not encode "deepseek is the default for task deployments": that is a statement about
  *provider* selection, and `decideDispatchProvider` (`lib/provider-tokens.js`) picks **claude
  whenever a claude account is connected**, consulting only `allow_providers` — a restriction. 147
  therefore reported it rather than inventing a refusal. The operator ruled that the refusal IS the
  intent ("a harness row can forbid a provider from wearing it. the weights are only for those
  allowed providers"), so **148 encodes it as `allow_providers` per lane** (§1, §2) and the follow-up
  that would have added a soft `prefer_providers` knob is withdrawn — a preference where a refusal
  was wanted is a second way to say one thing, and the whole point of this evaluation is that there
  should be one. Measured after 148: with claude, deepseek and grok all connected, a bare dispatch of
  `dev-builder` goes to **deepseek**, `dev-reviewer` to **grok**, `dev-architect` and every manager to
  **claude** — and a dispatch that names a forbidden provider is refused at spawn with a sentence
  naming the persona.
- **F7 — `hermes` is a root worker harness with no parent**: it inherits no manual, no law and no
  policy, so neither this scheme nor any future one reaches it without duplicating the policy into
  it (copy rot). The fix is structural — re-parent it to `zee-base` — and it changes what a hermes
  wearer is briefed with, so it is not smuggled into a policy migration.
- **F8 — TKT-97 stays green.** `fable`/`opus` in an allow-list are claude-only names, and an
  explicit `fable` on deepseek is still refused loudly by the spec check — that refusal is the
  feature. 147 adds exactly one model name (`grok-4.5`), which has a spec on grok (migration 141),
  so no allow-list gains a name that no provider carries.

## 6. Follow-ups (not done here, in priority order)

1. ~~**`prefer_providers` on `model_policy`**~~ — **withdrawn.** The operator ruled that a harness
   row forbidding a provider IS the intent, so the refusal (148) is the encoding and a parallel soft
   preference would be a second way to say one thing.
2. **The resolver should keep a provider's `''` default when the policy expresses no preference FOR
   THAT PROVIDER** (§4B) — today one priority anywhere moves every provider off its vendor default.
3. **Re-parent `hermes`** (F7), with its own evidence check on what its wearers do. 148 makes this
   sharper, not softer: `hermes` is now the only fleet persona that may still be worn on a retired
   provider, because it inherits nothing to forbid it.
4. **Decide the lane for `trainer`/`teacher`** — the estate class. Their work is judgement over text
   (this evaluation was written by one), which reads like the claude tier, but the scheme names
   "task deployments", "managerial work" and "the middle tier" and these are none of the three. 147
   and 148 leave them on the root's three-provider allowance rather than inventing a refusal nobody
   can defend; one line from the operator settles it, and it is one console edit either way.
5. **The router's shares are a guess with a number in front of it** — 147 seeds
   `provider_weights {deepseek: 6, grok: 3, claude: 1}` as the scheme's shape (default / middle /
   managerial). It is the first honest encoding, not a measurement; retune it from what the router
   actually dispatches.

## 7. What 147 changes, in one table

| row | field | before | after |
|---|---|---|---|
| `zee-base` | `priorities` | — | `deepseek-chat 5 > deepseek-reasoner 3` · `grok-4.5 5` · `opus 5` · `k3 5` · `gpt-5.6-terra 5` |
| `zee-base` | `allow_models` | (live) no grok | `+ grok-4.5` — only when a non-empty list already exists |
| `manager` | `priorities` | — | `opus 9` · `deepseek-reasoner 9 > deepseek-chat 3` · `grok-4.5 9` · `k3 9` · `gpt-5.6-sol 9` |
| `manager` | `allow_models` | (live) no grok | `+ grok-4.5`, same guard |
| `dev-architect` | `priorities` | — | flagship per provider: `opus 9`, `deepseek-reasoner 9 > deepseek-chat 1`, `grok-4.5 9` |
| `dev-reviewer` | `priorities` | — | middle tier: `grok-4.5 9`, `sonnet 9 > opus 3`, `deepseek-chat 9 > deepseek-reasoner 3` |
| `zee-base`, `manager` | `default_model` | `'opus'` if a console edit set it | removed (anchored on that exact value) — the lane priorities say it per provider |
| `router` | `router_policy` | rewrite/mode/chars | `+ provider_weights`, `+ fallback_provider: deepseek` (missing keys only) |
| `zee-base` | memory `cxell-zee-manual.md` | "claude, codex or kimi" | the five CLIs a cage actually resolves to |

Nothing 147 does is forbidden that was allowed before: every change is a priority, an addition to an
allow-list, or the removal of a `default_model` whose per-provider meaning the priorities now carry.

## 7b. What 148 changes, in one table

148 is the operator's ruling, so unlike 147 it DOES add refusals — that is its whole content.

| row | field | before | after |
|---|---|---|---|
| `zee-base` | `allow_providers` | (none — everything) | `claude, deepseek, grok` — the retired vendors leave the worker estate |
| `manager` | `allow_providers` | (none) | `claude` — inherited by `dev-lead`, `master`, `queenzee-minister`, `router` |
| `dev-builder` · `dev-fixer` · `dev-tester` · `dev-scribe` · `dev-scout` · `dev-shipwright` | `allow_providers` | (none) | `deepseek` |
| `dev-reviewer` | `allow_providers` | (none) | `grok` |
| `dev-architect` | `allow_providers` | (none) | `claude` |
| the rows above | `priorities` | 147's per-provider picks | entries no allowed provider can reach are dropped (dead text) |
| `router` | `bundle.personality` | "provider — follow `provider_weights` …" | "the HARNESS decides first … then spread AMONG WHAT IT ALLOWS" |

Effective dispatch after 147 + 148, measured by `test/harness-provider-priority.test.mjs` against a
real database — the allowance first, then the model inside it:

| harness | may wear | bare dispatch runs | anything else |
|---|---|---|---|
| `zee-base` · `dev-base` · `trainer` · `teacher` · `zeetest` | claude · deepseek · grok | `opus` · `deepseek-chat` · `grok-4.5` | openai/kimi refused by name |
| `dev-builder` · `dev-fixer` · `dev-tester` · `dev-scribe` · `dev-scout` · `dev-shipwright` | **deepseek** | `deepseek-chat` | refused by name |
| `dev-reviewer` | **grok** | `grok-4.5` | refused by name |
| `dev-architect` | **claude** | `opus` | refused by name |
| `manager` · `dev-lead` · `master` · `queenzee-minister` · `router` | **claude** | `opus` | refused by name |

The refusal is a sentence, not a silence: *"harness "dev-builder" allows only deepseek — a zee cannot
run on provider "claude". Pick an allowed provider (or change the harness policy."* The console's
dispatch composer greys the provider out with the same reason, so the picker can never offer what
the spawn would refuse. An **explicit** `--provider` is still an instruction that reaches the spawn —
and is then refused there by name, rather than being silently rerouted.

It binds at **dispatch/assign time only**: a zee already running is untouched, no gate semantics move,
and every list is one console edit away from being widened again.

## 7c. What the LIVE database actually carries — and the mistake that makes this section exist

The table above is what 148 writes on a row that carries **no allowance of its own**. §1 fills only
where empty, so **a console edit outranks the file** — and on the fleet's own meta-DB one row did:

| row | live after 148 | why |
|---|---|---|
| `manager` (and therefore `dev-lead`, `master`, `queenzee-minister`, `router`) | **`claude, deepseek`** | a human had set it before 148 ran; 148 skipped it with `NOTICE: manager already carries its own allow_providers (["claude","deepseek"]) — left to the operator` |
| `zee-base` | `claude, deepseek, grok` | as written |
| `dev-builder` · `dev-fixer` · … | `deepseek` | as written |
| `dev-reviewer` | `grok` | as written |

Verified read-only on production by the router manager at 19:07:07Z (148 in `schema_migrations`,
rows read back). Inside that live manager lane the models resolve `opus` on claude and
**`deepseek-reasoner`** on deepseek — which is the improvement 147 was for: the same dispatch used
to resolve `opus`, record `opus`, and actually run `deepseek-chat`.

**The mistake:** the reflection filed straight after the ship said "manager is claude-only" as a
statement about production. It was a measurement of a FRESH database — every cxell's, and the only
kind a caged zee can read — reported as fleet fact. The guard did its job; the report did not. Two
things follow, and both are now in the code:

- **A caged zee cannot see production**, so anything it says about the live estate must be attributed
  ("on a fresh database …") or verified by someone who can (`zee harness`, a manager holding prod
  read-only). This document says which of its numbers are which.
- **The test must not treat the scheme as universal.** `test/harness-provider-priority.test.mjs`
  originally asserted `manager → claude only` outright, which would have turned a RESPECTED operator
  edit into a red build the first time it ran against the live shape. It now holds a lane to the
  scheme only where the scheme still stands, reports an override where a human has set their own,
  and in both cases holds the invariants that must be true either way: every allowed provider
  resolves to a model that provider actually offers, and everything outside the allowance is refused
  by name.

Whether `manager` should be forced to claude-only is **the operator's call, not a migration's** —
one console edit, or one word and an anchored follow-up migration.

**What a wearer pays for it:** almost nothing in persona or skills — the scheme is columns, not text.
The two text changes are the manual's CLI list (+110 characters on a 46,700-character file, 0.2%,
spent to delete a sentence that was false for two of the three active providers) and the router's
provider bullet (+~380 characters, and only the router pays it), which had to move because a router
obeying the old wording would hand a persona a provider its row now refuses.

## 8. No new harness

The mint question was asked and answered NO. This evaluation covered the whole estate looking for a
recurring kind of work with no persona behind it, and found none: the gaps it did find are a policy
lever the operator has since ruled on (F6), a structural parent (F7) and a resolver wart (§6.2) —
none of them is a personality. A "model policy" or "fleet economics" persona would be its parent plus a task
description, which is the test a mint must pass and this one fails. The recurring part of this work
— evaluate the estate, land a guarded migration — is exactly what `trainer` already is.

# Decision Record: the bootstrap button's contract — a shown button always acts

**Date:** 2026-08-19
**Author:** Architect (the-bootstrap-button-is-useless-just-shows-t-bb6244)
**Status:** Decided — implementation to be cut as follow-up tasks (this record is the plan).
**Supersedes, in part:**
[`build-readiness-compose-env-decision-record.md`](build-readiness-compose-env-decision-record.md)
— its "Follow-up seam (recommended, separate task)" section is now DECIDED, not deferred, and
widened. The probe-env fix in that record is unchanged and remains phase 1; nothing lands from
this record before it.

## Decision

The bootstrap button's promise becomes: **if the button renders, clicking it creates
something; what it cannot create is shown as the named human step where the knob for that step
already lives — never as a dead-end alert after a click.**

Concretely:

1. `BootstrapButton` renders **only when the probe says something performable is missing** —
   a derived `bootstrappable` boolean on the readiness payload, computed server-side by ONE
   shared function that the planner also uses. The "Nothing to perform" alert path becomes
   unreachable and is removed.
2. `requires-present` attaches **structured data** to its check row —
   `missing: { networks: [], volumes: [], aliases: [] }` — and the planner reads that
   structure. The `/missing required alias/` regex on free-text detail
   (build-bootstrap.js:128) is deleted.
3. The performable set **widens by exactly one category**: a declared external volume the
   manifest explicitly marks safe to create empty
   (`tiers.spinoff.requires.volumes: [{ name: x, create: empty }]`) becomes a planned
   `docker volume create` step. The plain-string form keeps today's meaning: data, never
   auto-created.
4. The never-performable cases stop being button clicks and become **guided facts at the
   existing knobs**: a failing `registry-for-handoff` check names the two real fixes and the
   console links them — the `can_build` checkbox already in the same matrix row
   (Machines.jsx:248–252) and the "Build registry" field in ProjectSetup
   (ProjectSetup.jsx:774–775). No new surface is invented.

## Context

The operator's requirement, verbatim: *"i need a button that works. thats the whole point of
bootstrapping."* After the phase-1 probe fix, the reported false dead-end vanishes — but the
button can still render for a pair whose only missing prerequisites are never-performable
(volume, registry, a real compose defect), and the click still ends in "Nothing to perform".
A button that can render without being able to act breaks the operator's contract, however
truthful the alert. The fix is to move the render condition onto performability and to give
every non-performable fact an actionable home.

## What "works" means, category by category

| missing prerequisite | after this record | why |
|---|---|---|
| external network (declared) | ✅ button creates it | already performable today |
| shared dev db | ✅ button provisions it | already performable today |
| external volume, `create: empty` opt-in | ✅ button creates it empty | the manifest — the project's own authority — says empty is a valid start |
| external volume, plain string | ✋ named human step | data; an auto-created empty volume converts a loud "missing data" into a silent runtime malfunction |
| registry / no build machine | ✋ guided: link to `can_build` knob + registry field | a registry is a service plus credentials reachable from two daemons; `can_build` is a capacity judgment about someone's hardware — both human decisions with existing one-click knobs |
| lost network alias on a running container | ✋ named human step (recreate via compose) | recreating the shared dev db interrupts every live dev xell on that machine — a human-timed maintenance action, and the bootstrap's "never touches a running container" line holds |
| compose does not resolve (post phase 1) | ✋ named repo defect | no machine button can fix a repo; the check's detail names the file and error |
| unreachable daemon / docker absent | 🚫 refused whole action | physically nothing to act on; a bootstrap must never run half-blind |
| dev/prod name overlap (`guardDevOnly`) | 🚫 refused | deliberately never clickable |

So: **for any project and any machine, the button either acts or does not appear** — and when
it does not appear with ✗ build still showing, the badge/tooltip names the one human step,
with the knob for it a click away. That is the strongest "works" a machine-scoped button can
honestly offer; the last two rows are one-way doors we keep shut on purpose.

## Interfaces and data shape

1. **Check row (additive):** `requires-present` gains
   `missing: { networks: [names], volumes: [{ name, create }], aliases: [{ network, aliases }] }`.
   The check must no longer return early on the first miss — it collects all misses so the
   plan is complete in one probe (today a missing network hides a missing volume behind it,
   build-readiness.js:174–192).
2. **Probe result (additive):** top-level `bootstrappable: boolean` on the per-machine
   readiness object, derived by an exported `bootstrappableFrom(checks)` in
   build-readiness.js: any failing `shared-dev-db`, OR `requires-present` with
   `missing.networks.length > 0` or an opted-in missing volume. build-bootstrap.js imports
   the same function's underlying classification — one authority, two consumers.
3. **Manifest (additive, backward-compatible):** `requires.volumes` entries may be
   `string | { name, create?: 'empty' }`. Every existing reader normalizes exactly the way
   `requires.networks` already normalizes string-vs-object (build-readiness.js:167–169,
   build-bootstrap.js:125–126) — the same shape used twice already, no new convention.
4. **Planner:** reads `missing` structure; drops the detail regex; volume steps with
   `create: 'empty'` become `{ kind: 'volume', action: 'docker volume create <name>' }` with
   an idempotent performer mirroring the network performer (inspect → create → "already
   exists" race tolerated).
5. **Console:** `BootstrapButton` condition changes from `readiness.status === 'missing'` to
   `readiness.bootstrappable`; the ✗ badge tooltip is unchanged (it already lists every
   failing check); the `registry-for-handoff` failing row renders its two links.

## Options considered

**A. Chosen: performability decides rendering; manifest opt-in widens volumes; knobs absorb
the rest.** For: every render acts; no new invented infrastructure; the authority for "is an
empty volume safe" sits with the project that declared the volume.

**B. Make the bootstrap create everything, including plain volumes and a local registry
container.** For: the button "always works". Rejected: an empty volume where data was expected
fails silently at runtime, hours later, off this screen — strictly worse than a named refusal;
a queenzee-invented registry is an unauthenticated service on someone's LAN plus a daemon
config change on every machine that must pull from it — infrastructure with credentials and
blast radius, precisely what the bootstrap's contract excludes.

**C. Keep rendering on `status === 'missing'`, soften the alert into guidance.** For: tiny
diff. Rejected: the operator's requirement is the contract itself — a button that renders and
then explains why it cannot act is the reported defect with better prose.

**D. Client-side performability inference (parse check names/details in Machines.jsx).** For:
no payload change. Rejected: duplicates the planner's classification in a second language on
free text; the two drift, and the drift is invisible until a button lies again.

**E. Bootstrap recreates the alias-less dev db container via compose.** For: fixes the known
"fleet crash-loop" state with one click. Rejected: interrupts every live dev xell on the
machine at a moment the queenzee — not a human — chose; and "never touches a running
container" is the line that makes the button safe to hand out at all. The step stays named,
human-timed.

## Consequences

- The button disappears entirely for pairs whose misses are all human-only — ✗ build plus a
  tooltip naming the step replaces it. An operator who wants "one click regardless" does not
  get it; they get the honest version.
- `readiness` payload grows two additive fields; no existing consumer breaks (the web reads
  `status` and `checks[].detail` today).
- A manifest author gains a small new power (`create: empty`) and the responsibility that
  comes with it; the default stays safe.
- The `requires-present` check gets slightly slower (no early return — it inspects every
  declared item). Bounded: item count is manifest-declared and small; calls stay async.

## Reversibility

All additive: payload fields, manifest option, one render condition, one new step kind.
Revert restores today's behaviour; no data written beyond what a human clicked to create
(volumes created empty are removable while unused). The one-way doors (B's registry, E's
recreate) were not opened — that is the point.

## What would change our mind

- An operator repeatedly needing the alias-recreate at scale (E) — that would earn a separate,
  explicitly-confirmed maintenance action with its own disclosure, not a widening of this
  button.
- A second manifest needing `create: seed-from-X` — then the volume option grows a source
  field and its own record; `create: empty` was deliberately the smallest grant.
- The `bootstrappable` derivation disagreeing with an actual plan (button renders, plan comes
  back empty): that means the shared classification forked — fix by re-unifying the authority
  function, never by re-widening the render condition.

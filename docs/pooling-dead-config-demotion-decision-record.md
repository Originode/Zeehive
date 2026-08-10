# Decision Record: Dead per-machine pooling config is shown at the knobs, not as an alert

**Date:** 2026-08-10
**Author:** Architect (machine-aware-pooling-is-disabled-local-mard-eccb04)
**Status:** Implemented (Machines.jsx knob dimming; pool.js logline demoted;
`machine-pooling-warning.test.mjs` + `pool-machine-guard-silence.test.mjs` rewritten).
**Supersedes, in part:** the LOUD-guard aspect of
[`process-machine-pooling-decision-record.md`](process-machine-pooling-decision-record.md)
and the original loud-guard work it built on. The GUARD itself (remote rows cannot govern a
`runner:process` project) is unchanged and stays.

## Decision

For a `runner: process` project, a remote machine's prio/pool knobs render DIMMED in the
container matrix (`.mx-knob.dead`, `data-pooling-dead`), with the reason in the knob's own
tooltip, still editable. The full-width red banner and its clear button are REMOVED. The
pool's per-tick line is demoted from a `!!!` console.error alert to a ring-only informational
line, still rate-limited to once per state change.

## Context

Third operator report on the same surface, this time a wordless screenshot of the banner
filling the matrix. The escalation history matters: the banner was born when dead config was a
TRAP — the pool silently took a different target than the one the operator had configured, and
the 167-xell runaway was live memory. Both hazards are gone: since the default-pooling ship
the queenzee-host row (or the implicit default) GOVERNS a process project, the runaway is
structurally impossible (project-wide count), and the config on remote rows is simply inert.
An alert that fires forever over harmless config trains the operator to ignore red — and this
operator explicitly asked for peace, twice.

## Options considered

**A. Keep the banner, add a "don't show again" dismissal.** For: no information lost.
Rejected: dismissal state is one more per-(project,human) fact to store, and a dismissed
banner is exactly as invisible as no banner — with more machinery.

**B. Keep the banner only when a remote knob is >0** (the state before this record). For:
already built. Rejected by the operator's screenshot: their machines legitimately carry
numbers (other projects use them; the same knobs are one matrix), so for them "only when
configured" means "always".

**C. Chosen: the fact lives where the operator looks when it matters — on the knob.** A
dimmed knob with the reason in its tooltip is visible at the exact moment someone tries to
use it, invisible the rest of the time, and needs no state.

## Consequences

- The ops digest (`ops-review` `ALERT_RE`) no longer sees this condition at all. That is
  deliberate: it is not an incident. The once-per-change ring line remains for forensics.
- A person who sets a remote pool number for a process project and never hovers the dimmed
  knob gets no push notification that it is inert. Accepted: the pool line records it, the
  knob is visibly dimmed, and nothing breaks — inert is the worst case.

## Reversibility

Pure presentation + log level; revert restores the banner. What would change our mind: dead
config regaining the power to change behaviour (e.g. if remote rows ever influenced anything
for process projects again), which would make it a trap again and re-earn the alert.

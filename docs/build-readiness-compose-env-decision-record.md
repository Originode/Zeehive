# Decision Record: the compose-resolves probe interpolates with the harness env contract

**Date:** 2026-08-18
**Author:** Architect (the-bootstrap-button-is-useless-just-shows-t-bb6244)
**Status:** Decided — implementation cut as a follow-up task (this record is the plan).
**Builds on:** the build-readiness probe and one-click bootstrap (ticket #173 + follow-on;
`8c14293`, `177c578`, `ea5da28`).

## The reported symptom

Clicking 🔧 bootstrap on machine `local` shows only:

> Nothing to perform on local — what the probe found missing is not something a bootstrap can
> create: • cannot spinoff compose — spinoff compose 'docker-compose.spinoff.yml' does not
> resolve on 'default': error while interpolating services.server.environment.[]: required
> variable SPINOFF_WEB_PORT is missing a value: set SPINOFF_WEB_PORT · … SPINOFF_SLUG … ·
> … SPINOFF_SERVER_PORT …

The button is the symptom. The defect is upstream: **the probe's verdict is false**, and every
consumer of that verdict (the ✗ build badge, the bootstrap button's render condition, the plan)
faithfully repeats it.

## Decision

`checkComposeResolves` (server/src/lib/build-readiness.js) runs `docker compose … config -q`
**the way the harness actually invokes compose**, not bare:

1. with the **harness env contract stubbed** — inert placeholder values for the variables every
   real invocation is guaranteed to carry:
   `SPINOFF_SLUG`, `SPINOFF_SERVER_PORT`, `SPINOFF_WEB_PORT`, `SPINOFF_DB_PORT`,
   `GIT_COMMIT_HASH`;
2. with `--env-file <repo_root>/<manifest env.file, default '.env'>` **when that file exists**
   (when it does not exist, the check keeps failing on a required var from it — correctly, see
   Consequences).

A compose file that still fails `config -q` under that contract is then a REAL defect of the
repo/manifest, and the probe's `missing` verdict (and the planner's `cannot` step) is true.

## Context — why the current check is wrong

- The SPINOFF_* variables are **per-xell inputs, not machine prerequisites**. No machine can
  "have" them; they do not exist until a xell does. Every real compose invocation supplies them:
  - `scripts/build-container.sh` exports `SPINOFF_SLUG`, `SPINOFF_SERVER_PORT`,
    `SPINOFF_WEB_PORT`, `GIT_COMMIT_HASH` (lines 53–60) and passes
    `--env-file "$ENV_FILE"` on every `dc()`/`dcb()` call (lines 79–80);
  - `server/src/lib/build.js` hands it `SPINOFF_SLUG/SERVER_PORT/WEB_PORT/DB_PORT` from the
    meta-DB's recorded facts (lines 156–162).
- The probe is the ONLY invoker that runs compose with none of that:
  `checkComposeResolves` calls `docker(ctx, ['compose','-f',path,'config','-q'])`
  (build-readiness.js:125) and `dockerAdapter` spawns docker with the queenzee's own inherited
  process env — no `env` option, no `--env-file` (build-readiness.js:62–90).
- A project-owned spinoff compose that marks the contract **required**
  (`${SPINOFF_WEB_PORT:?set SPINOFF_WEB_PORT}`) is *legitimate — arguably good — authorship*:
  it fails fast when run outside the harness instead of publishing a default port that collides
  with a sibling stack. ZEEHIVE's own generated compose happens to use `:-` defaults
  (compose-gen.js:39,69) so ZEEHIVE never trips this; any project that authors its own compose
  with `:?` trips it on every machine, forever.
- Downstream of the false verdict, everything behaves as designed and is therefore useless:
  readiness → `missing` → badge ✗ build → `BootstrapButton` renders (Machines.jsx: rendered
  whenever `readiness.status === 'missing'`) → planner maps a failing `compose-resolves` to a
  `cannot` step (build-bootstrap.js:180–183) → "Nothing to perform" alert. Fixing the probe
  removes the button for this pair entirely (or reveals the next REAL missing prerequisite).

## The interface changes (the contract, before the code)

**1. `dockerAdapter(ctx, args, { timeout, bin, env })`** — additive `env` option, default
`undefined`. When present, spawn with `{ env: { ...process.env, ...env } }`. Existing callers
and every injected test stub keep their `(ctx, args)` shape untouched — the option is invisible
unless passed.

**2. `checkComposeResolves(machine, project, docker)`** builds:

```js
const PROBE_COMPOSE_ENV = {           // inert: `config` renders, it never runs anything
  SPINOFF_SLUG: 'readiness-probe',    // interpolates into names only
  SPINOFF_SERVER_PORT: '1',           // distinct valid port numbers so
  SPINOFF_WEB_PORT: '2',              //   `ports: "${X}:4700"` renders
  SPINOFF_DB_PORT: '3',
  GIT_COMMIT_HASH: 'probe',
};
const envFile = resolve(repoRoot, project.manifest?.env?.file || '.env');
const args = ['compose', ...(existsSync(envFile) ? ['--env-file', envFile] : []),
              '-f', path, 'config', '-q'];
return docker(machine.docker_ctx, args, { env: PROBE_COMPOSE_ENV });
```

Failure/pass/unknown texts keep their exact current shape — only the invocation changes.

**3. Nothing else moves.** No schema change, no API change, no readiness-payload change, no
console change. The bootstrap planner keeps treating a failing `compose-resolves` as `cannot`
— under the new invocation that is finally the truth.

## Options considered

**A. Chosen: probe supplies the contract it knows every real invocation supplies.** For: fixes
the verdict at its source; one function changes; mirrors `build-container.sh`, which is the
single authority on how spinoff compose is really invoked.

**B. Console-side: hide the button / soften the alert when the plan is all-`cannot`.** For:
smallest visible diff for the reporter. Rejected: the badge still reads ✗ build on a machine
that can build, the pool operator is still misinformed, and the false `missing` still masks any
probe consumer added later. It treats the symptom and leaves the lie in the data.

**C. Fix the project's compose authorship (`:?` → `:-` defaults).** For: no ZEEHIVE code
change. Rejected: the probe cannot demand an authorship style of every project repo it will ever
probe; `:?` is fail-fast authorship the real harness satisfies; and a `:-` default on a
published port is strictly worse — outside the harness it silently binds a port that collides
with the next stack. Fixing one repo leaves the probe wrong for the next.

**D. Downgrade an interpolation failure to `unknown` (or skip the check).** For: no false
`missing`. Rejected: throws away a real answer we can cheaply get. A genuinely broken compose
(bad YAML, dangling dockerfile ref) is exactly what this check exists to catch, and `unknown`
never turns the badge green — it would park every custom-compose project at △ forever.

**E. Interpolate with REAL per-xell values.** Rejected: the probe is (machine × project); no
xell exists at probe time, so there are no real values — that is not an implementation gap, it
is the semantics. Placeholders are correct because `config -q` renders and validates but never
creates anything.

**F. Put stub SPINOFF_* into the queenzee's own process env at boot.** For: no adapter change.
Rejected: leaks probe fixtures into every other docker invocation the queenzee ever spawns
(including real builds, where an accidental inherit could mask a missing recorded fact). Env is
per-call context; it belongs on the call.

## Consequences

- The reported pair flips to ✓ build (or to the next TRUE missing prerequisite), and the
  bootstrap button disappears where there is nothing to bootstrap — the button's existing
  render condition needs no change.
- A repo with **no `.env` yet** keeps failing the check when its compose requires a var from
  that file. Correct: `build-container.sh` hard-errors on a missing env file (line 75), so a
  build genuinely cannot work there; the check's detail names the variable, which is the fix.
- The probe now names `config`-level defects only. Anything supplied per-xell can no longer
  produce a false ✗ — and anything the contract does NOT supply still fails loudly, which is
  what we want from `:?` authorship.
- One knock-on worth keeping visible: the plan's `cannot` wording for compose
  ("a repo/manifest defect", build-bootstrap.js:87) becomes accurate instead of accusatory.

## Test plan (watch it fail first)

Extend `test/build-readiness.test.mjs`'s `makeDocker` stub with a `composeNeedsContract` mode:
the `compose` branch returns the exact docker error text ("required variable SPINOFF_WEB_PORT
is missing a value…") **unless** the call carried `opts.env` with all five contract vars.
- Before the fix: the new case reproduces this ticket — `compose-resolves` fails, verdict
  `missing`. After: passes, verdict clean.
- Second case: stub asserts `--env-file` is present in args iff the fixture repo has `.env`.
- Existing cases run untouched (the stub's old two-arg calls still work — additive option).
- `test/build-bootstrap.test.mjs` unchanged: a compose failure under the new invocation is
  still a `cannot` step, which its fixtures already assert.

## Follow-up seam (recommended, separate task — not required by this ticket)

The planner still distinguishes performable from `cannot` by **regexing check detail**
(`/missing required alias/`, build-bootstrap.js:128) and the console can still show a
bootstrap button when the only failures are never-performable (missing volume, registry).
The seam: `requires-present` attaches structured
`missing: { networks: [], volumes: [], aliases: [] }` to its check row; the probe result gains
a derived `bootstrappable` boolean; `BootstrapButton` renders only when true; the planner drops
the regex. Deliberately NOT built here — it changes the readiness payload shape, and this
ticket's dead-end vanishes without it.

## Reversibility

Fully reversible: one function's invocation plus an additive adapter option; revert restores
today's behaviour. No data written, no schema, no payload change.

## What would change our mind

- A real incident where a machine passed `compose-resolves` under the stubbed contract but the
  real build failed on interpolation — that would mean the contract set drifted from
  `build-container.sh`/`build.js`; the fix would be deriving the stub set from one shared
  constant those three import, not abandoning the approach.
- The env contract becoming per-project (manifest-declared port env names used inside spinoff
  compose files): then the stub set must be computed from `tiers.spinoff.ports.*.env` union the
  fixed contract, and this record should be superseded.

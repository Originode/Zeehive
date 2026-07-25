# Proposal: Harnesses — shared, cross-project config layers for xells

Status: **PROPOSAL — awaiting review.** Nothing here is built yet.

## 1. What you asked for (restated)

- A **harness** is a shared thing you can *add* (example: **`hermes`**).
- When a harness exists, its **harness xell becomes visible to all projects** — it is global,
  not owned by one project.
- In the git-graph topology, the **trace goes to the harness first**, and **from the harness a
  trace fans out to every xell using it** — so the harness sits *between* the git graph and the
  xells that consume it.
- A xell attached to a harness inherits whatever the harness configures: **shared skills,
  personalities, or whatever else** is on the harness.
- The **cxell-zee manual is always present on a harness**, and it is **LAW** for anything that
  touches how a zee interacts with zeehive/queenzee — a harness may add, never override that.

## 2. Where this lands in the existing architecture

Everything below reuses machinery that already exists; nothing here is a new orchestration model.

- **A xell already gets its entire "who am I / what may I do" from one assembly point** —
  `bindingFor()` → `briefing()` in `server/src/queenzee/intake.js`. That function builds the
  binding JSON + the `rules[]` list, and `spawnCxell()` appends the manual reference and the
  "you have no skills" line. **This is the single seam a harness injects through.** (Lines
  ~311–516 build the binding/rules; ~944–983 build the cxell addendum.)
- **The git graph already renders non-code nodes anchored to a commit.** `getTimeline()`
  (`lib/timeline.js`) emits `xells[]` each with a `base_commit`; `production` is itself a xell
  anchored to the *shipped* commit, gold-coloured, and `Connectors.jsx` draws a wire from its
  commit dot to its hexagon. **A harness is one more anchored node of the same shape.**
- **The tree abstraction for "one xell is the source of another" already exists** — `xource.xell_id`
  (migration 012) with `xource_guard()`/`xell_guard()` enforcing ref-matches-branch, no-cycles,
  immutability. A harness is a *sibling* concept: where a xource carries **code that work lands UP
  into**, a harness carries **config that flows DOWN into consumers** and nothing lands back
  through it. We keep them separate on purpose (see §7).
- **Config-as-data-stamped-with-a-hash is the house pattern.** `project.manifest` (016) caches
  the repo's `zeehive.yml`, validated at onboard, drift surfaced not silent. A harness bundle is
  the same shape: a parsed, hashed projection of a versioned source of truth.
- **cxells run `claude --bare`** (`lib/cxell-runtimes.js`), which deliberately excludes host-side
  skills/plugins/hooks — which is *why* today's cxell briefing says "no skills". A harness is the
  sanctioned way to put a curated skill/personality set back in, per-xell, without reopening the
  host to the cxell.

## 3. The model

### 3.1 A harness is a first-class, GLOBAL entity backed by a git ref

```
harness
  id            uuid pk
  key           text UNIQUE         -- 'hermes', 'core', ...
  label         text                -- 'Hermes'
  ref           text                -- the git ref that carries this harness's files (see §3.3)
  head_commit   text                -- the commit the graph anchors the harness node to
  bundle        jsonb               -- parsed/validated config (skills[], personality, memory, tools…)
  bundle_hash   text                -- projection stamp; drift vs the ref is surfaced, not silent
  is_law_core   boolean             -- the built-in manual harness (see §4); exactly one, undeletable
  enabled       boolean
  created_at    timestamptz
```

Unlike `xource`/`xell`/`container`, a harness has **no `project_id`** — that is what "visible to
all projects" means at the schema level. A project *opts in* by assignment (§3.2), and the
console lists every enabled harness in every project's picker.

### 3.2 A xell is ASSIGNED a harness (config-uses, not code-tracks)

```
ALTER TABLE xell ADD COLUMN harness_id uuid REFERENCES harness;   -- NULL = core only
```

- Single primary harness per xell in v1 (matches "a personality"). Stacking (multiple harnesses,
  ordered) is a clean future extension via a `xell_uses_harness(xell_id, harness_id, ord)` join;
  I recommend shipping single-assignment first and noting the join as the growth path.
- **Assignment is mutable** (unlike `xource_id`, which is immutable because it decides where work
  lands). A harness decides *config*, touches no landing target, and swapping it just re-briefs the
  next turn — so there is no impossibility to guard here, only a re-brief.
- **Defaults, exactly like runtime/db-coupling defaults:**
  - `pool_config.default_harness_id` — per project, what a bare dispatch attaches.
  - `--harness hermes` at dispatch and a picker in the "+" composer — per-dispatch override.
  - `task.req_harness_id` — carried through intake the same way `req_runtime_id` /
    `req_db_coupling` already are.

### 3.3 What "the harness's files" are, and where they live

The harness's skills/personality/memory are **real files on a git ref**, so they are versioned,
diffable, and land through the same gates as everything else. Two viable homes — a **review
decision** (§9, Q1):

- **(A) A dedicated harness repo/xource per harness** — e.g. a `harnesses` project (or the
  Zeehive self-project) with a branch `harness/hermes` holding `skills/`, `PERSONALITY.md`,
  `memory/`. The harness node in the graph then literally *is* a ref in that repo, and the
  "trace to the git graph" is a real anchor. Cleanest fit with the existing graph/xource code.
- **(B) A conventional folder inside each project** — `.zeehive/harnesses/hermes/…`. Simpler to
  start, but "shared across all projects" then means copying, which fights the single-source rule.

**Recommendation: (A).** It makes the harness genuinely one shared, versioned artifact and lets
the graph anchor be truthful. `bundle`/`bundle_hash` on the `harness` row is the parsed projection
of that ref, refreshed on pull just like `project.manifest`.

## 4. The manual is LAW (non-negotiable core harness)

Model the manual as a **built-in harness** `core` (`is_law_core = true`), that **every xell always
gets**, whether or not it also gets `hermes`. Precedence in the assembled briefing is fixed and
one-directional:

```
LAW LAYER  (always, first, non-overridable)
  1. cxell-zee-manual.md  — how a zee talks to zeehive/queenzee (land/ship/prod/done, the gates)
  2. the binding rules[]  — db safety, "verify in your xell", "origin off-limits", land-is-a-request
        ↑ these two are the `core` harness; a project/hermes harness may ADD below, never edit above
HARNESS LAYER  (the assigned harness, if any)
  3. personality / voice
  4. skills (materialized + described)
  5. extra memory / house guidance
TASK LAYER
  6. the actual job
```

Enforcement is **structural, not just prompt-order**: the harness `bundle` schema simply has **no
field that can express** a land/ship/prod/done rule or a queenzee-interaction override. The
validator (at onboard/refresh, mirroring the manifest validator) **rejects** a harness bundle that
tries to redefine a reserved key. So "the manual is law" is true because the data model gives a
harness nowhere to contradict it — the same way the schema, not a rule, is what stops a xell
tracking its own xource today.

## 5. The trace (git graph → harness → xells)

Concretely, in `getTimeline()` and the two SVG layers:

- **`getTimeline()`** additionally emits an `harnesses[]` array. Each harness in play (any harness
  assigned to ≥1 live xell in this project, plus `core`) becomes a node with:
  - `base_commit` = the harness's `head_commit` (its ref tip) → its anchor into the trunk, exactly
    like prod anchors to the shipped commit.
  - `color` — a distinct harness palette (prod already reserves gold).
- **Each consuming xell** carries `harness_id`, and `Connectors.jsx` draws, in addition to (or
  instead of — Q2) its code-anchor wire, a **config edge from the harness node to the xell
  hexagon**, visually distinct (dashed / thinner) so a shared-config grouping reads at a glance.
  The maze router (`hive/maze.js`) already threads hex-edge corridors; a harness node is just
  another routing endpoint.
- **Reading of the picture:** the git graph feeds the harness (harness anchored to its ref tip),
  and the harness fans out to its xells — precisely "trace goes to the harness first, then from the
  harness to the xells." The harness renders as its own hexagon in the honeycomb, like production.

`GraphPane.jsx`/`HiveCanvas.jsx` need a node kind for "harness" (shape/badge), and the scroll-anchor
logic that today keeps prod's dot across from its hex can stay prod-only — harness wires route
through the maze like ordinary xells, so they need no special perpendicular tracking.

## 6. How a xell actually inherits the config (injection mechanics)

At `spawnCxell()` / `briefing()` time:

1. **Resolve the harness chain**: `core` (always) + the xell's `harness_id` (if any).
2. **Prompt layer** — fold the harness `personality` + skill *descriptions* + memory into the
   briefing string, in the §4 order, under the law layer. This alone gives voice + "you have these
   skills and here's when to use them."
3. **Skill files** — `spawnCxell()` already `cloneIntoCxell()`s the branch; add a step that
   materializes the harness's `skills/` into a location the in-cxell CLI will load. Because the
   cxell runs `claude --bare` (skills excluded by design), this needs one of:
   - drop the harness skills into `/work/repo/.claude/skills/` and pass the CLI the flag that
     re-enables project skills for *that curated set only* (the host is still never exposed), or
   - keep v1 purely prompt-injected (skill instructions as text, no SKILL.md loading) and add
     file-loading in a follow-up.
   **Recommendation:** ship prompt-injection first (works today, zero CLI-flag risk), then wire
   real SKILL.md loading once the curated-skills flag is validated on the pinned CLI.
4. **Personality / system voice** — via the SDK `appendSystemPrompt` for host-spawned zees
   (`spawnHeadless` already sets `systemPrompt: {preset:'claude_code'}` + `settingSources`), and
   via the prompt text for `--bare` cxells.
5. **Tool defaults** — a harness `bundle.allowed_tools` can *narrow* (never widen past the mode's
   ladder) the tools, folded in where `m.tools` is applied.

The line the cxell briefing prints today — *"You are walled in: no docker, no host fs, no skills"* —
becomes *"…your skills are the ones your harness gives you"* when a harness is attached.

## 7. Why a harness is NOT just a xource (the load-bearing distinction)

They look similar (both a ref a xell relates to) but they are opposites in flow, and conflating
them would break the tree invariants the codebase is careful about:

| | xource (code) | harness (config) |
|---|---|---|
| direction | work flows **UP** into it (land/PR) | config flows **DOWN** into consumers |
| scope | per-project (`UNIQUE(project_id, ref)`) | **global** (no project_id) |
| binding | **immutable** per xell (decides land target) | **re-assignable** (decides briefing) |
| cardinality | exactly one per xell | zero-or-one now, stackable later |
| gates | land gate / PR gate guard it | none — it grants nothing irreversible |

Keeping them separate means a harness assignment can never accidentally re-point where a zee's work
lands (the thing `xell_guard` exists to make impossible), and a global harness never has to satisfy
the per-project `xource` uniqueness/cycle rules.

## 8. Phased plan (each phase independently landable)

1. **Schema + core harness.** `harness` table, `xell.harness_id`, `pool_config.default_harness_id`,
   seed the undeletable `core` harness = today's manual + binding rules. Validator that rejects a
   bundle touching reserved (law) keys. *No behaviour change yet — core reproduces current briefing.*
2. **Injection.** `briefing()`/`spawnCxell()` resolve `core` + assigned harness and layer them in
   (prompt-injection path). Dispatch `--harness`, composer picker, `req_harness_id` through intake.
   *Verifiable in a cxell: dispatch with/without `hermes`, read the assembled prompt & behaviour.*
3. **Trace + honeycomb.** `getTimeline().harnesses[]`, harness node kind, the config edge in
   `Connectors.jsx`. *Verifiable in the dashboard: harness hexagon with wires to its xells.*
4. **Real skill-file loading** (curated `.claude/skills` + CLI flag) and **harness authoring UI**
   (create/edit a harness, see its ref, its consumers). Optional **stacking** join table.

## 9. Open questions for your review

1. **Harness file home** — dedicated harness repo/xource (A, recommended) vs per-project folder (B)?
2. **Trace shape** — does a harnessed xell keep its own code-anchor wire *and* gain a harness edge,
   or does its wire route *through* the harness node (harness strictly in series)? Your wording
   ("git graph → harness → xells") reads as series; I lean toward showing both (code anchor +
   dashed config edge) so you don't lose "where in history this xell forked."
3. **Single vs stacked** harness per xell for v1 (I recommend single now, join-table later).
4. **Skill delivery in v1** — prompt-injected descriptions only, or real SKILL.md loading from the
   first cut (needs the curated-skills CLI flag validated on the pinned `claude --bare`)?
5. **Who may edit a harness** — since it is global, an edit hits every project. Should harness edits
   land through the same human gate (they're files on a ref, so they naturally would)?

---
*Prepared in xell `keen-summit-9ce124`. Standing by for review before any implementation.*

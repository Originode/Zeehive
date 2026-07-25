# Proposal: Harnesses — shared, system-wide config layers for xells

Status: **PROPOSAL — awaiting review.** Nothing here is built yet. Revision 2 folds in the review
decisions (see §9).

## 1. What you asked for (restated)

- A **harness** is a shared thing you can *add* (example: **`hermes`**).
- When a harness exists, it is **visible to all projects** — it is system-wide, not owned by one
  project.
- In the git-graph topology, the harness sits **in series**: the trace goes to the harness first,
  and the consuming xells' wires **route through** the harness. (Orchestrators, later, will be the
  *parallel* counterpart — a grouping — see §8.)
- A xell attached to a harness inherits whatever it configures: **shared skills, personalities, or
  whatever else**.
- The **cxell-zee manual is always present on a harness** and is **LAW** for anything that touches
  how a zee interacts with zeehive/queenzee — a harness may add, never override that.
- A harness is presented as an **avatar badge**, not a hex cell.
- A harness **never ships or lands** — it is only a guide; the *zee* ships/lands.

## 2. Where this lands in the existing architecture

Everything below reuses machinery that already exists.

- **One injection seam.** A xell's whole "who am I / what may I do" is assembled in
  `bindingFor()` → `briefing()` (`server/src/queenzee/intake.js`): the binding JSON + `rules[]`, then
  `spawnCxell()` appends the manual reference and the "you have no skills" line. **This is the single
  seam a harness injects through.**
- **The graph already anchors non-code nodes to a commit.** `getTimeline()` (`lib/timeline.js`)
  emits nodes with a `base_commit`; `Connectors.jsx` draws a wire from the commit dot to the node.
  `production` is itself such a node, anchored to the shipped commit.
- **Config-as-data-stamped-with-a-hash is the house pattern.** `project.manifest` (016) caches the
  repo's `zeehive.yml`, validated at onboard, drift surfaced not silent. A harness bundle is the same
  shape: a parsed, hashed projection of versioned files.
- **The runtime/viewer indirection already exists.** `agent_runtime` carries `vendor`/`driver`/
  `viewer_url_template`/`viewer_kind`, and `runtimes.js:viewerUrlFor()` stamps a zee's `viewer_url`
  from a template + session id. This is exactly the hook the Hermes web-UI bridge reuses (§7).
- **cxells run `claude --bare`** (`lib/cxell-runtimes.js`) — host-side skills/plugins/hooks excluded
  by design (that's *why* the cxell briefing says "no skills"). A harness is the sanctioned way to
  put a *curated* skill/personality set back in, per-xell, without reopening the host.

## 3. The model

### 3.1 A harness is a first-class, SYSTEM-WIDE entity, with files in the Zeehive project

```
harness
  id            uuid pk
  key           text UNIQUE         -- 'hermes', 'core', ...
  label         text                -- 'Hermes'
  dir           text                -- 'harnesses/hermes' (relative to the Zeehive repo root)
  head_commit   text                -- commit the graph anchors the harness node to (the dir's last touch)
  bundle        jsonb               -- parsed/validated config (skills[], personality, memory, tools, avatar, bridge…)
  bundle_hash   text                -- projection stamp; drift vs the files is surfaced, not silent
  avatar_path   text                -- 'harnesses/hermes/avatar.svg' (the badge art)
  is_law_core   boolean             -- the built-in manual harness (§4); exactly one, undeletable
  enabled       boolean
  created_at    timestamptz
```

**Files live in the Zeehive project** under `harnesses/<key>/` — because a harness is system-wide
and **Zeehive is the system**. So harnesses are versioned, diffable, and travel with the orchestrator
itself, not with any tenant project. A harness row has **no `project_id`** — that is what "visible to
all projects" means at the schema level; every enabled harness shows in every project's picker.

```
harnesses/
  core/                 # the manual harness (§4) — the law layer, undeletable
    MANUAL.md           # docs/cxell-zee-manual.md is sourced/linked here
  hermes/
    HARNESS.yml         # bundle manifest: personality, skills list, tools, avatar, bridge config
    PERSONALITY.md
    avatar.svg          # the Hermes badge art (see §6)
    skills/
      <skill>/SKILL.md
    memory/*.md
```

`bundle`/`bundle_hash` on the row is the parsed, validated projection of `HARNESS.yml` + that folder,
refreshed on pull exactly like `project.manifest`.

### 3.2 A xell is ASSIGNED one harness; a human may switch it

```
ALTER TABLE xell ADD COLUMN harness_id uuid REFERENCES harness;   -- NULL = core only
```

- **Exactly one harness per xell** (plus `core`, always). No stacking.
- **Assignment is mutable, but only a human switches it** — a zee cannot re-harness itself. Swapping
  is a console action on the xell card; it re-briefs the next turn (a harness touches only *config*,
  never a landing target, so there is no impossibility to guard — just a re-brief).
- **Defaults, like the runtime/db-coupling defaults already threaded through intake:**
  - `pool_config.default_harness_id` — per project, what a bare dispatch attaches.
  - `--harness hermes` at dispatch + a picker in the "+" composer.
  - `task.req_harness_id` — carried through intake the same way `req_runtime_id` already is.

## 4. The manual is LAW (non-negotiable `core` harness)

The manual + binding rules are a built-in, undeletable **`core` harness** (`is_law_core = true`) that
**every xell always gets**, layered *above* any assigned harness. Precedence is fixed and
one-directional:

```
LAW LAYER  (always, first, non-overridable — this IS the `core` harness)
  1. cxell-zee-manual.md  — how a zee talks to zeehive/queenzee (land/ship/prod/done, the gates)
  2. the binding rules[]  — db safety, "verify in your xell", "origin off-limits", land-is-a-request
HARNESS LAYER  (the assigned harness, e.g. hermes)
  3. personality / voice
  4. skills (delivered per provider — §6.2)
  5. extra memory / house guidance
TASK LAYER
  6. the actual job
```

Enforcement is **structural, not prompt-order politeness**: the harness `bundle` schema has **no
field** that can express a land/ship/prod/queenzee-interaction rule, and the validator (at
onboard/refresh, mirroring the manifest validator) **rejects** a bundle that tries to redefine a
reserved key. "The manual is law" holds because the data model gives a harness nowhere to contradict
it — the same way the schema, not a rule, is what stops a xell tracking its own xource today.

## 5. The trace — harness in SERIES, rendered as an avatar badge

- **`getTimeline()`** additionally emits `harnesses[]`. Each harness in play (assigned to ≥1 live
  xell in this project) becomes a node anchored to its `head_commit` (the last commit that touched
  its folder) — its anchor into the trunk, exactly like prod anchors to the shipped commit.
- **In series.** Today `Connectors.jsx` routes one wire per xell: commit-dot → xell hexagon. For a
  harnessed xell the wire routes **through the harness node**: commit-dot → **harness** → xell
  hexagon. One shared inbound segment from the graph reaches the harness; from the harness the wire
  fans out to each consuming xell. The maze router (`hive/maze.js`) already threads corridors between
  hexes — the harness is just an intermediate routing waypoint on the path.
- **Rendered as ONE AVATAR BADGE at the junction, not a hex cell.** Where prod and xells are
  hexagons, a harness is a single circular **avatar** (its `avatar.svg`) placed at the **junction
  where the graph feeds it and its consumer wires fan out** — one badge upstream of the fan-out, not
  one per wire (the xell hexagons are already crowded). A small count badge ("×N") shows how many
  xells it harnesses. Hovering it highlights exactly its consumers' wires (the hover plumbing in
  `Connectors.jsx`/`GraphPane.jsx` already supports per-id highlight).
- **No ship/land affordance.** A harness node carries none of the land?/ship? buttons a xell/prod
  hexagon does — it is a guide, not a work-cell (§7 of the manual: only the zee lands/ships).

`getTimeline()` + `Connectors.jsx` + `HiveCanvas.jsx` are the three files that change; the anchor,
wire-routing and hover machinery all already exist.

## 6. Injecting the config + delivering skills per provider

### 6.1 Injection point
At `spawnCxell()`/`briefing()`: resolve `core` (always) + the xell's `harness_id`, then layer them in
per §4 — personality/memory/skill-guidance folded into the briefing string under the law layer. The
cxell line *"you have no skills"* becomes *"your skills are the ones your harness gives you."*

### 6.2 Skill delivery is PER PROVIDER (both mechanisms, whichever fits the AI)
Claude is not the only integrated runtime (`agent_runtime` already spans Claude/OpenAI-Codex/Kimi via
`lib/cxell-runtimes.js`), so a harness delivers its skills through whatever each provider does best:

- **Claude** — materialize the harness's `skills/` as real `SKILL.md` files into the cxell's curated
  skill dir and let the CLI load them (the curated set only; the host is still never exposed). Native
  skill semantics, progressive disclosure.
- **OpenAI-compatible / others** — where a provider has no SKILL.md loader, deliver the same skills as
  **prompt-injected instructions** (name + when-to-use + body), and/or the provider's native tool/
  function surface.

The `harness.bundle` stores each skill once (provider-neutral); the per-provider adapter in
`cxell-runtimes.js` decides the delivery. `bundle.allowed_tools` may *narrow* (never widen past the
dispatch mode's ladder) the tools.

## 7. Connecting zee conversations into a harness's own web UI (Hermes)

Yes — and Hermes is a good first proof because it exposes exactly the surface needed. Hermes Agent
(Nous Research) runs an **OpenAI-compatible HTTP API** (`/v1/chat/completions`, `/v1/responses`,
`/v1/runs`), a **discovery endpoint** that advertises whether the running instance supports
runs/streaming/cancellation/session-continuity, **spec-native streaming** of `function_call` /
`function_call_output` items, and a **Web UI** (browser Chat + logs). Crucially it separates two
session ids: `X-Hermes-Session-Id` (transcript-scoped, rotates on `/new`) and **`X-Hermes-Session-Key`
— a *stable* per-channel identifier** for long-term memory. That stable key is our anchor.

**Chosen: (B) — mirror the transcript, keep the zee in its cxell.** The deciding factor is *file
access*. A zee has the project files only because it **runs inside its cxell** — `/work/repo` (a
private clone of its branch), its own db/app containers, the firewall, its identity token. Its file
I/O is done by its own tools *in that cage*.

- **Why NOT (A) — Hermes as the runtime backend.** Hermes is itself an agent (its own tools, memory,
  data in `~/.hermes/`). Pointing the cxell at Hermes as a backend means *Hermes* runs the agentic
  turn — and **Hermes has no access to the xell's `/work/repo`**. That either strands the agent from
  the project files or nests two agent loops. So (A) breaks the very thing the cxell exists to give
  the zee. Rejected.
- **(B) keeps the execution boundary fixed.** The zee still runs on Claude/Codex/etc. **inside its
  cxell** with full, unchanged file access. The bridge is **one-way, outbound, transcript-only**:
  Zeehive already normalizes every provider's stream to one shape on the SSE `zee-output` bus
  (`logbus`/`events`); the harness bridge relays those events into a Hermes thread keyed by
  `X-Hermes-Session-Key = <xell.slug>` (stable for the xell's life). It stamps the harness's
  `viewer_url_template` → the Hermes Web UI thread onto `zee.viewer_url` (via `viewerUrlFor()`), so the
  console viewer opens the conversation in Hermes. **Hermes receives a display copy — never the files,
  never write-back into the cxell.**

Integration caveats for (B), recorded honestly:
- Hermes's API is *execution*-oriented, so the mirror must **append to a thread for DISPLAY without
  triggering Hermes to generate its own turn.** At attach the bridge **calls Hermes's discovery
  endpoint first** to learn which append/display path the running instance supports (matching
  Zeehive's "surface drift, never guess" ethos); if none exists, Hermes is self-hosted (`~/.hermes/`)
  so the session store can be written directly. Bridge config (base url, auth, append mode) lives in
  `harnesses/hermes/HARNESS.yml`, versioned with the harness.
- **Two-way is out of scope for (B).** "Chat with the zee *from* Hermes's web UI" would open an
  *inbound* control path into the cxell (a Hermes user-message posted as a prompt into the zee's
  session). That is a new, gated surface — a later, opt-in bridge mode, never a side effect of the
  display mirror.

> Domain note: the badge asset link points at `hermes-agent.org`; the authoritative docs/API live at
> `hermes-agent.nousresearch.com` (repo `NousResearch/hermes-agent`), with a mirror at
> `hermesagent.org.cn`. Worth pinning the exact instance URL in `HARNESS.yml` at wiring time.

## 8. Note on orchestrators (the parallel counterpart — provisions, not this feature)

You framed it as *harness in series, orchestrator in parallel (a group)*. This proposal is
harness-only, but it deliberately leaves room:

- An **orchestrator** is a *grouping* over several xells that coordinate on one larger piece — drawn
  as a **parallel bracket/lane** around their hexagons, not a series waypoint on the wire.
- Its *coordination* substrate already exists: the **xource tree** (`xource.xell_id`, migration 012)
  already lets one xell be the source others land into — the real "children land into the
  orchestrating xell, it lands into main" mechanism, guards and all. The missing last mile is
  *provisioning* a xell that tracks another (HANDOFF §0 roadmap).
- The two compose cleanly: a harness says *what persona/skills* each zee wears (series); an
  orchestrator says *which xells form one squad* and where their work converges (parallel). A xell can
  have both — one harness, membership in one orchestrated group.

If you want, the next proposal can spec the orchestrator against that xource-tree foundation.

## 9. Decisions locked in this revision (from your review)

1. **Harness files** → dedicated folders in the **Zeehive project** (`harnesses/<key>/`), because the
   harness is system-wide and Zeehive is the system. ✔
2. **Trace** → **in series**; wires route *through* the harness. (Orchestrator = parallel group,
   separate feature.) ✔
3. **One harness per xell**; **a human may switch it** (a zee cannot re-harness itself). ✔
4. **Skill delivery** → **both** mechanisms, chosen **per AI provider** for efficiency (Claude:
   SKILL.md files; OpenAI-compatible/others: prompt-injection / native tools). ✔
5. **A harness never ships/lands** — guide only; the **zee** ships/lands. **Rendered as an avatar
   badge**, not a hex. Hermes avatar sourced from the provided SVG, vendored to
   `harnesses/hermes/avatar.svg`. **Zee↔Hermes web-UI conversations** → feasible via §7. ✔
6. **Hermes bridge → (B), mirror the transcript** (§7). Rejected (A) because it would run the agentic
   turn *on Hermes*, which has no access to the xell's `/work/repo` — file access requires the zee to
   stay in its cxell. B is a one-way, outbound, display-only mirror; the zee never leaves its cage. ✔
7. **Avatar placement → one badge at the junction** (upstream of the fan-out), because the xell
   hexagons are already crowded. ✔

### Everything above is decided; no open questions remain. Implementation gated on your go-ahead.

### Phased plan (each phase independently landable)
1. **Schema + `core`.** `harness` table, `xell.harness_id`, `pool_config.default_harness_id`, seed the
   undeletable `core` = today's manual + binding rules; validator rejecting law-key overrides. *No
   behaviour change — core reproduces the current briefing.*
2. **Injection + assignment.** `briefing()`/`spawnCxell()` layer `core` + assigned harness; `--harness`
   dispatch, composer picker, `req_harness_id`, console switch-harness on the xell card.
3. **Trace + avatar badge.** `getTimeline().harnesses[]`, series routing through the node, avatar-badge
   rendering with the consumer-count + hover-highlight.
4. **Hermes.** Seed the `hermes` harness folder (personality, skills, `avatar.svg`, bridge config) and
   wire the chosen bridge mode (§7); the `hermes` `agent_runtime` if (A).

---
*Prepared in xell `keen-summit-9ce124`. Standing by for review before any implementation.*

Sources for the Hermes API/Web-UI facts in §7:
[Integrations](https://hermes-agent.nousresearch.com/docs/integrations/) ·
[API Server](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/api-server.md) ·
[Open WebUI](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/open-webui)

# Operation priorities in project settings

*Design · 2026-08-05 · Architect (xell `design-split-api-gateway-from-queenzee-confi-73130e`)*

**Status: DESIGN. Nothing here is built.** The architecture this sits on is
[queenzee-gateway-split.md](queenzee-gateway-split.md); the rejected alternatives are in
[queenzee-gateway-split-decision-record.md](queenzee-gateway-split-decision-record.md).

The ask, in the operator's own words: *"mark-done / xell reaping should be top priority, to free
compute."*

---

## 1. What an operator is actually choosing

**Not** "how important is this feature". An operator is choosing, for each kind of heavy job the
queenzee does, **which of three queues it joins** — and nothing else. Three lanes, one number:

| lane | what it means, mechanically |
|---|---|
| **top** | dequeued before anything else; has a **reserved** concurrency slot of its own; while one is pending or running, `background` loop ticks **skip** |
| **normal** | FIFO, inside the shared concurrency budget |
| **background** | runs only when nothing is on `top` and a shared slot is free; its own loop ticks skip while a `top` op is in flight; **promoted to `normal` after 15 minutes of waiting** so it cannot starve |

plus **`max_concurrent_ops`** (default **2**) — how many heavy jobs the queenzee runs at once. That
is the actual "free compute" lever; the lanes decide who gets those slots first.

> **⚠ The `2` is a JUDGEMENT DEFAULT, not a measurement.** Nobody has timed how many concurrent
> provisions or builds this fleet's hosts absorb before they thrash; 2 is the smallest number that is
> obviously more than serial, chosen so the first fleet-day is safe rather than fast. It is a
> settings field precisely so it can be raised on evidence — and the operations rail (queue depth vs
> running count) is where that evidence will show up first. The **lane assignments** in §3 are a
> policy choice and are argued on their merits; this one number is a guess and is labelled as one.

Three lanes and not a 0–100 priority on purpose: a number invites an argument about 47 versus 52 that
no scheduler can honour, and it cannot be read off a screen. A lane is a sentence: *"reaping goes
first, disk hygiene goes last."*

---

## 2. Where it is stored

`pool_config.op_priority jsonb` — the project settings table (`pool_config` is per project and is
already what Project setup → Pool edits). This follows `pool_config.spawn_prep` (migration 121)
exactly, because that pattern is settled here and has a normalizer, an editor and a doc already:

```sql
-- db/migrations/NNN_op_priority.sql   (ask `zee migration-number` for NNN)
ALTER TABLE pool_config ADD COLUMN IF NOT EXISTS op_priority jsonb;
COMMENT ON COLUMN pool_config.op_priority IS
  'Operation priorities: {lanes:{<kind>:top|normal|background}, max_concurrent_ops:int}. '
  'NULL = the built-in defaults (server/src/lib/op-priority.js DEFAULT_LANES). Never read raw — '
  'the normalizer serves it EFFECTIVE. Edited in Project setup → Pool → Operation priorities.';
```

```jsonc
// the shape, in full
{ "lanes": { "reap": "top", "build": "normal", "image-janitor": "background" },
  "max_concurrent_ops": 2 }
```

**NULL means the built-in defaults**, and a partial `lanes` map means "these kinds, defaults for the
rest" — so a project that never opens the editor, and a kind added by a future migration, both behave
predictably without anybody backfilling anything. Unknown kinds in a stored map are **dropped by the
normalizer, not thrown** (a kind removed from the code must not brick a project's settings page).

`getPoolConfig` serves it effective, exactly as it serves `spawn_prep`:

```jsonc
{ "op_priority": { "lanes": {…all kinds, resolved…}, "max_concurrent_ops": 2 },
  "op_priority_custom": false,          // has a human edited it?
  "op_priority_defaults": {…},          // what "Reset to defaults" restores
  "op_priority_kinds": [ { "key": "reap", "label": "Reap a xell (teardown)",
                           "hint": "runs when a human marks a xell done — frees its containers, db clone and images",
                           "default": "top" }, … ] }
```

The **kind list is server-defined**, so adding an operation kind means shipping the server, not the
server *and* the console — the same rule `spawn_prep_presets` follows.

---

## 3. The vocabulary, and the defaults

Every kind is a real code path today (§5.2 of the split doc names the module and function for each).

| kind | what it is | default lane | why |
|---|---|---|---|
| `reap` | tear a xell down (mark-done, human cleanup, pool trim) | **top** | the operator's stated policy. It is also the **measured** worst offender: 1.2s of frozen API in the cheapest possible case, up to a 120s despawn script on a real host. And it is the one job whose *completion returns compute* — containers, a db clone, images, a cage |
| `dispatch` | create the cage and start a zee's turn | normal | a human waits on it too, but it competes with `reap` for the same slot; see §8 |
| `land` | execute an APPROVED landing (collect + push) | normal | a human is watching, but it is seconds |
| `build` | build a xell's own app tier | normal | zees wait on it via `zee build --wait`, which already polls |
| `ship` / `seed` | deploy to prod / run a seed | normal | holds the prod lock; a lane must not be what decides prod ordering (§6.5) |
| `provision` | cut a fresh pooled xell | normal | it is how the pool refills; a human dispatching soon depends on it |
| `backup` / `restore` | prod dump / restore | normal | scheduled, but a human clicks restore |
| `db-clone` / `schema-catchup` | give a xell its own db / roll it to prod's schema | normal | a zee is blocked on it |
| `pool-reconcile` | catch a pooled xell up to source, or decommission it | **background** | nobody waits; it runs every 15s forever and it is git-heavy |
| `prod-diff` | read-only schema diff against production | **background** | a 10-minute loop; nobody waits on a tick |
| `image-janitor` | reclaim built images | **background** | pure disk hygiene |
| `env-reconcile` | rewrite stale `.zeehive.env` projections | **background** | a boot-time sweep; nobody waits |
| `worktree-diff` | the monitor's stale-claim diffs | **background** | a throttled sweep; it is exactly the loop `lib/git.js:19` already blames for a 30–90s API |

**These defaults are a change, and that is deliberate.** There is no existing priority behaviour to
preserve byte-for-byte: today everything interleaves on one event loop in arrival order. The default
map encodes the policy that was actually asked for (reaping first) and moves only four kinds down —
each one a loop that no human and no zee is waiting on. Every other kind stays `normal`, so nothing
that anyone waits on changes its relative position.

*(Contrast `spawn_prep`'s defaults, which were required to be byte-identical to prior behaviour
because that column replaced a hard-coded path every project already ran. This column has no prior.)*

---

## 4. How the loops honour it

One module, four functions, no scheduling logic anywhere else:

```js
// server/src/lib/op-priority.js
export const LANES = ['top', 'normal', 'background'];
export const OP_KIND_META = { reap: { label: '…', hint: '…', default: 'top' }, … };  // §3's table
export const DEFAULT_LANES = { reap: 'top', /* …everything else… */ };
export const DEFAULT_MAX_CONCURRENT = 2;
export const AGING_MS = 15 * 60 * 1000;

export function normalizeOpPriority(raw)           // NULL/partial/unknown-kind → the effective map
export async function laneFor(projectId, kind)     // cached 1s; FAILS OPEN to DEFAULT_LANES
export async function opBudget(projectId)          // { max_concurrent, top_reserved: 1 }
export async function mayTick(projectId, loopName) // false while a `top` op is pending/running
                                                   // AND this loop's kind is `background`
```

`laneFor` and `mayTick` are read on hot paths (every enqueue, every loop tick) against a meta-DB that
is over the network, so they copy `lib/fleet-pause.js` **precisely**: a 1-second cache, invalidated by
the writer (`updatePoolConfig`), and **failing open** — a read that throws returns the last known
value, and the boot value is the built-in defaults. A NAS blip must never silently stall the fleet by
making everything look `background`. That module says why at length; do not re-derive it.

Three touchpoints, and there are only three:

**1 · At enqueue** (`ops.js`) — resolve and **store** the lane:
```js
const lane = await laneFor(project_id, kind);
// stored on the row: an op runs at the priority it was ACCEPTED at. Changing a setting must not
// reorder a queue underneath a human watching it, and the row is the receipt for why it ran when.
```

**2 · At dequeue** (`scheduler.js`) — lane, then FIFO, with a reserved `top` slot:
```sql
ORDER BY CASE lane WHEN 'top' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, enqueued_at
```
```js
const { max_concurrent, top_reserved } = await opBudget(projectId);
// a `top` op may claim even when running >= max_concurrent, up to top_reserved extra slots;
// a `background` op is only claimed when nothing is pending/running on `top`.
```
Aging, in the same query's `WHERE`: `background` ops older than `AGING_MS` are treated as `normal`.
One expression, and it removes the classic starvation failure before anybody meets it.

**3 · At the top of a background loop's tick** (`lib/loops.js`, the registry from Phase 0):
```js
register({ name: 'pool', kind: 'pool-reconcile', interval_ms: 15000, tick });
// the registry wraps every tick:
if (!(await mayTick(projectId, name))) { skipped++; return; }   // reported on /internal/health
```

A skipped tick is **counted and reported**, never silent: `/internal/health` carries
`loops:[{name, last_tick_at, skipped}]`, and the console's operations rail shows *"pool: yielding to a
top-priority reap"*. A loop that quietly stops is how an operator loses trust in a scheduler.

---

## 5. The console surface

**Project setup → Pool → Operation priorities** (the Pool tab already owns "how this project's xells
are made and maintained"; `web/src/ProjectSetup.jsx`, `SpawnSection`).

```
Operation priorities                                    [ Reset to defaults ]
Run at most  [ 2 ]  heavy operations at once.

  Reap a xell (teardown)          ( ) background   ( ) normal   (•) top
  Start a zee (dispatch)          ( ) background   (•) normal   ( ) top
  Land approved work              ( ) background   (•) normal   ( ) top
  …
  Reclaim built images            (•) background   ( ) normal   ( ) top

  ⓘ Top-priority operations go first and get a reserved slot. Background ones wait, and pause
    their own loops while a top-priority job is running. Applies to newly queued operations.
```

Two pieces of honesty in that panel:

- **"Applies to newly queued operations"** — because the lane is stored on the op row (§4, touchpoint 1).
- A warning line when more than three kinds are `top`: *"everything is top-priority, so nothing is."*
  A **warning**, not a refusal: an operator who means it may be right about their fleet, and a
  scheduler that argues with its operator gets switched off.

---

## 6. What a lane is NOT

**6.1 It is not a permission.** A lane changes when work runs, never whether it is allowed. Every gate
(landing, ship, prod, done, seed) keeps its human, its refusal wording and its answer — see §4 of the
split doc.

**6.2 It is not a per-xell knob.** It is per project, in project settings, as asked. A one-off urgent
job is a human clicking the thing, which enqueues an op that is already in front of the loops.

**6.3 It does not change a loop's interval.** A `background` loop still ticks on its own clock; it
only yields while a `top` op is in flight. Intervals stay env-configured, where they are today.

**6.4 It does not preempt.** A running op is never killed to make room. `top` means "next", not "now".
A 40-minute backup that is already running keeps running; the reap goes to the front of the queue and
takes the reserved slot.

**6.5 It does not jump a lock, and it does not reorder the landing pad.** The prod deploy lock
(`deploy_lock`), the landing runway (one per ref) and the landing pad
(`queenzee/landingpad.js` — one chronological runway, strictly one item at a time, across landings
*and* ships) are **correctness** mechanisms; lanes are a **scheduling** mechanism. A `top` op that
needs a held lock waits, exactly as it does today, and the ops rail shows it waiting with the holder
named. A `land`/`ship` op takes its turn on the pad in arrival order however its lane is set — the pad
already says it *"only decides the ORDER and the ONE-AT-A-TIME in which the queenzee acts on the
things a human already approved"*, and a lane must not become a way to overtake a human's queue.
Lanes order everything **around** those mechanisms, never through them. Making a settings screen able
to jump a lock would turn it into a way to break the fleet's serialization guarantees.

---

## 7. Migration and compatibility

- **The column is additive and NULL on every existing row**, so every project keeps behaving as it did
  the moment the migration lands. Nothing reads it until Phase 2's code ships, and nothing needs
  backfilling — ever.
- **Priorities do not require the process split.** They work on today's single process the moment the
  op queue exists (Phase 1). That sequencing is deliberate: it is the half of this work with a visible
  operator payoff and the smaller blast radius.
- **Rollback is a click**: "Reset to defaults" writes NULL. `OP_PRIORITY_ENABLED=false` forces every
  lane to `normal`, which is a plain FIFO queue — i.e. the behaviour of Phase 1 alone.
- **Half-deployed fleet:** an old worker that does not know about `lane` orders by `enqueued_at` and
  is merely un-prioritized; a new worker reading rows enqueued by an old one sees `lane` NOT NULL
  because the column has a default. Neither errors.
- **Forward compat:** a kind added later is absent from a stored `lanes` map and resolves to its
  built-in default. A kind removed later is dropped by the normalizer. Neither needs a data migration.

---

## 8. What would change our mind

- **If measurement after Phase 3 shows loop ticks are noise** (all real cost being in op-runners),
  delete `mayTick` and keep lanes as pure queue ordering. Simpler, and I would take it.
- **If a human is seen waiting on `dispatch` behind a queue of reaps**, flip `dispatch` to `top` — in
  settings first, and only in `DEFAULT_LANES` if it happens on more than one fleet.
- **If a second busy project appears** and its `normal` work starves behind another project's `top`
  lane, lanes need a per-project concurrency reservation. `queenzee_op.project_id` is already there
  for it; do not build it before the starvation is observed.
- **If operators start asking for a fourth lane**, that is the signal the three-lane model is wrong —
  but the answer is more likely `max_concurrent_ops` per lane than a fourth queue.

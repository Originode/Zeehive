# The ROUTER zee — the project's front door (migration 139)

## What it is

A **router** is ONE zee per project whose whole job is intake: it accepts a human's **raw prompt**,
recomposes it into a brief a zee can actually execute, and decides the dispatch — **provider, model,
autonomy mode, harness** — under an operator-tunable **router policy**. The console's composer
routes every worker prompt THROUGH it: with no live router, the **Dispatch button is disabled** and
the one honest button is **"Deploy router"**.

## The shape, and why it is a manager

The router is a **manager-type xell wearing the `router` harness** (parent `manager`). That choice
is the entire safety story, because every wall a router needs already exists for managers as
**refusals in code, not prose**:

| requirement (the task's words) | how the manager type already provides it |
|---|---|
| "readonly prod xell" | the manager dispatch path mints a SELECT-only postgres role and binds it (fails closed) |
| "no ability to land" | the landgate declines a manager push without raising a request (052); `zee land` → `refuseForManager` |
| "no ability to ship" | **added in 139**: `selfShip` refuses a router by name (`isRouterXell`) — a plain manager may still ask, a router may not |
| "can sync its worktree to the xource" | `zee sync` has no manager refusal — the queenzee delivers current main into its cage |
| decides + performs dispatches | the manager crew verbs (`zee dispatch`, now with `--provider`, plus `zee zees` / `zee say`) |

A new `zee_type` was rejected for 120's reason verbatim: **types exist for refusals**, and the
router needs no refusal the manager type does not already have — except the ship ask, which is one
predicate (`isRouterXell`) rather than a type.

## Singularity: the `limit` policy knob

`harness.model_policy` gains **`limit`** — the max number of LIVE xells that may wear a harness
**per project**. Absent = unlimited; merged **min-wins** down the parent chain (a child cannot
widen a cap, same reasoning as 110's allow-list intersection); enforced in **`assignHarness`**,
which every persona-granting path (dispatch, swap, the console chip) funnels through, excluding the
target xell itself so a swap/redeploy is never refused by its own presence. The router ships with
`{"limit": 1}` — "the router" is singular by policy, and an operator can deliberately raise it.

## The router policy (`harness.router_policy`)

Routing knobs, edited in the harness manager, **attached as a snapshot to every routing request**
(so turning a knob changes the router's next decision without a re-brief or redeploy):

- `provider_weights` — `{provider: n≥0}`: relative share of dispatches (0 = never, unless fallback)
- `provider_schedule` — `{provider: {days:[0-6], hours:[start,end]}}` (UTC; windows may wrap midnight)
- `max_concurrent` — hold routing requests when this many routed workers are active
- `default_mode` — the autonomy (1–5) a routed dispatch gets unless the prompt demands eyes on it
- `rewrite` — `concise` | `structured` | `verbatim`
- `max_task_chars` — target ceiling for the recomposed brief
- `fallback_provider` — where a request lands when weights/schedule exclude everything else

Normalized defensively in `lib/router-policy.js` (wrong shapes degrade to "not set"), merged
leaf-wins (per-key for the maps) — these are **preferences**, not restrictions; the router's walls
are structural (above), never in this file.

## The flow

1. **No router live** → composer: Dispatch disabled (with the reason), **Deploy router** shown.
   Deploying takes **no prompt text** — a router's brief is fixed (`DEFAULT_ROUTER_BRIEF`); a human
   picks only the **provider and model** it thinks with (`POST /api/router/deploy`).
2. **Router live** → the composer's submit becomes **Route via router**: the raw prompt (+ pasted
   images) goes to the router as a `🧭 ROUTING REQUEST` (`POST /api/router/route`) — stored in
   `zee_message` (kind `directive`) and delivered into its live session. The message carries the
   raw prompt **verbatim**, the effective policy snapshot, the providers currently outside their
   schedule window, and the persona button the human pressed (marked *hint, not decision*).
3. The router recomposes, decides, dispatches (`zee dispatch --provider … --model … --mode …
   --harness …`) and **reports what it routed and why**.
4. **Redeploy / "swap it with a better model"** — the composer's router chip (`⇄ redeploy / swap
   model`) reuses the human swap path: same xell row, same branch, same read-only prod bind, a NEW
   zee on the provider/model picked (`POST /api/router/redeploy`; falls back to a fresh deploy when
   none is live).

The gate applies **only where the feature exists**: on a fleet whose meta-DB has no `router`
harness yet (or where `/api/router/status` fails), the composer dispatches directly exactly as
before — a gate that bricked every project the day it shipped would be worse than no gate.

## Files

- `db/migrations/139_router_harness_and_policies.sql` — `router_policy` column, `limit` knob
  documented, the `router` harness (guarded + idempotent, 120/138 pattern)
- `server/src/lib/router-policy.js` — normalize / merge / schedule-window predicate
- `server/src/lib/router.js` — `routerStatus`, `deployRouter`, `redeployRouter`, `routeRawPrompt`,
  `isRouterXell`
- `server/src/lib/model-policy.js` — the `limit` knob (min-wins)
- `server/src/lib/harness.js` — `assertHarnessLimit` in `assignHarness`; `router_policy` in
  save/read models
- `server/src/api/routes.js` — `/api/router/{status,deploy,redeploy,route}`
- `server/src/queenzee/self.js` — `zee dispatch --provider`; the router ship refusal
- `web/src/Dispatch.jsx` (the gate + deploy sub-mode) · `web/src/App.jsx` (toasts) ·
  `web/src/HarnessManager.jsx` (limit field + `RouterPolicyEditor`) · `web/src/api.js`
- `test/router-zee.test.mjs` — the whole contract, against a real database

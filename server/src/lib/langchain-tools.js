// THE LANGCHAIN ZEE TOOL REGISTRY — the allowlist that IS the confinement.
//
// "Model → tool request → queenzee-owned verb → tool result → model, looping, with every gate still
// in front of everything irreversible." This module is the queenzee-owned VERB half of that loop,
// for the WAVE-1 slice the manager authorised: the tool LOOP itself runs in the queenzee process
// (docs/langchain-stateful-zees.md §8.3.1), and the tool LIST is the confinement — only the verbs in
// this registry are bindable, and only read/report verbs are here.
//
// EACH TOOL CALLS THE SAME HANDLER /api/xell/self/* CALLS. `status` → selfStatus, `work` → selfWork,
// `working` → selfWorking, `item` → selfWorkItem — the exact functions the routes import
// (server/src/api/routes.js:1574+). There is NO second copy of a verb's logic on the tool path; the
// tool adds only the langchain-shaped wrapper: a JSON schema the model sees, and a call that maps
// the model's args onto the handler's options object.
//
// THE IDENTITY COMES FROM THE TURN, NEVER FROM THE MODEL. The `xell` object passed to each tool's
// run() is resolved by the queenzee (the caller of the loop), not supplied by the model — the model
// only provides the args for the verb. This is what keeps an in-process tool scoped to the xell it
// belongs to: the handlers act on the xell the turn is for, never a name the model invents.
//
// WHAT IS NOT HERE (the never-bindable list, accepted in full by the manager, enforced structurally
// by absence):
//   • workspace-action tools — run_bash / code execution / file write / direct SQL / docker / git
//     commit. In the queenzee process those are host access and the confinement story collapses.
//   • build, sync, db-catchup — build boots a server that applies migrations at boot; sync triggers
//     a build (the 2026-08-11 hole). A langchain zee can never reconcile git/db state through a tool.
//   • manager verbs (swap, dispatch, say, suggest-done, zees) — a worker's reach is its own xell.
//   • done, device, db-sandbox, prod — out of the loop by design; infra/human-only.
//   • land, ship, seed — NOT BINDABLE, and never will be by a test. The wave-2 premise ("they
//     terminate on a human") is FALSE on this fleet: project.auto_approve_land/ship/seed are TRUE
//     for Zeehive and omnibiz, and the gates land/ship/seed with decided_by='auto-approve@policy'
//     and no human in the path (landgate.js:188→250, shipgate.js:223, seedgate.js:199; measured:
//     593 auto-approved lands, 287 auto-approved ships, 10 auto-approved seeds). A bound `land`
//     puts a model-chosen commit on main, `ship` deploys production, `seed` writes prod rows. The
//     confinement is the ALLOWLIST, not the gate — these are absent from it. Do NOT flip
//     auto_approve_* to make a hold appear: that is fleet-wide policy, and this stays absent.
import { selfStatus, selfWorking, selfWork, selfWorkItem, selfTend, selfHint } from '../queenzee/self.js';

// The bound verbs. Keyed BY NAME so the loop and runTool can look a request up in one step and so
// the never-bindable check is a single property test: `LANGCHAIN_TOOLS[name]` is undefined for
// anything that is not bindable. Each entry: { name, description, schema (JSON schema), run(xell,
// args) -> anything }. `xell` is the turn's xell (resolved by the queenzee), args are the model's.
// Each description states what the verb WRITES (or that it is a pure select), because that is the
// sentence the model reasons from.
//
// hint-land / hint-ship are BOUND (manager authorisation 2026-08-11): each writes exactly one
// session_event row (hook_event_name '<kind>hint-request'/'<kind>hint-clear') with the optional
// reason, plus the xell's hint state (which lights the land?/ship? button) and an xell broadcast.
// They open NO gate, push nothing, and there is no auto_approve path for a hint (landgate/shipgate
// are not reached) — lib/status.js setHint (219-232).
export const LANGCHAIN_TOOLS = {
  status: {
    name: 'status',
    description: 'Reads THIS xell\'s status: the task, whether a landing/ship/done is pending a human, '
      + 'the xell\'s containers and db binding. PURE SELECT — it writes nothing.',
    schema: { type: 'object', properties: {}, required: [] },
    run: (xell) => selfStatus(xell),
  },
  work: {
    name: 'work',
    description: 'Reads the work item THIS zee is executing — its plan, ticket and history. PURE '
      + 'SELECT — it writes nothing (use `item` to report progress).',
    schema: { type: 'object', properties: {}, required: [] },
    run: (xell) => selfWork(xell),
  },
  working: {
    name: 'working',
    description: 'Writes a "working" ping for THIS xell (a session_event + a zee status update) that '
      + 'tells the fleet this zee is actively working. It opens no gate. NOTE: like the shared `zee '
      + 'working` verb, it AUTO-CLEARS an open tend (a question posted to a human) — the same shared '
      + 'semantics as every cxell zee; it is not langchain-specific. Use it only when you are '
      + 'genuinely working, never as conversational filler.',
    schema: { type: 'object', properties: { note: { type: 'string' } }, required: [] },
    // PLAIN SHARED HANDLER — no wrapper, no branch, no langchain-only behaviour. The tool IS the
    // door to selfWorking, exactly as `zee working` is for a cxell zee. What must be shared is the
    // VERB'S EFFECT; the loop decides whether the TURN continues, which is harness policy.
    run: (xell, args) => selfWorking(xell, { note: args?.note || null }),
  },
  item: {
    name: 'item',
    description: 'WRITES this xell\'s OWN work-item card: status, progress (0-100) and an optional '
      + 'note, plus an event row. Scoped by the server to THIS xell\'s card — it cannot write another '
      + 'item. It opens no gate and does not clear a tend.',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'the work item status, e.g. working / done' },
        progress: { type: 'number', description: '0-100' },
        note: { type: 'string' },
      },
      required: [],
    },
    run: (xell, args) => selfWorkItem(xell, {
      status: args?.status || null, progress: args?.progress ?? null, note: args?.note || null,
    }),
  },
  tend: {
    name: 'tend',
    description: 'Writes "I need a human in the console" for THIS xell with a brief reason — a signal '
      + 'shown beside this xell\'s hexagon. It EXECUTES nothing and opens no gate: it is a request '
      + 'for attention, not an action. To RAISE you must give a reason (a bare tend is refused); pass '
      + 'clear:true to lower it. It also auto-clears when you report working.',
    schema: { type: 'object', properties: { reason: { type: 'string' }, clear: { type: 'boolean' } }, required: [] },
    run: (xell, args) => selfTend(xell, { reason: args?.reason || null, clear: !!args?.clear }),
  },
  'hint-land': {
    name: 'hint-land',
    description: 'WRITES one thing: a hint-request event (with the optional reason) that lights the '
      + 'land? button on THIS xell\'s hexagon for a human to decide. Opens NO gate, pushes NOTHING, '
      + 'and cannot land anything (there is no auto_approve path for a hint). Use when the work looks '
      + 'land-ready but you are not certain; pass clear:true to lower it.',
    schema: { type: 'object', properties: { reason: { type: 'string' }, clear: { type: 'boolean' } }, required: [] },
    run: (xell, args) => selfHint(xell, 'land', { reason: args?.reason || null, clear: !!args?.clear }),
  },
  'hint-ship': {
    name: 'hint-ship',
    description: 'WRITES one thing: a hint-request event (with the optional reason) that lights the '
      + 'ship? button on THIS xell\'s hexagon for a human to decide. Opens NO gate, pushes NOTHING, '
      + 'and cannot ship anything (there is no auto_approve path for a hint). Use when the work looks '
      + 'ship-ready but you are not certain; pass clear:true to lower it.',
    schema: { type: 'object', properties: { reason: { type: 'string' }, clear: { type: 'boolean' } }, required: [] },
    run: (xell, args) => selfHint(xell, 'ship', { reason: args?.reason || null, clear: !!args?.clear }),
  },
};

// The bindable tool list — what the loop binds. Only what is in this registry, nothing else.
export function toolList() {
  return Object.values(LANGCHAIN_TOOLS);
}

// Run ONE tool by name — THE single dispatch path. The loop calls THIS (never a second lookup), and
// it is the allowlist refusal. Resolves against the GLOBAL LANGCHAIN_TOOLS (the allowlist) — never a
// caller-supplied list, so an over-wide caller array cannot leak a verb in. Returns the tool output
// as a string (the shape a ToolMessage carries). A name not in the registry is REFUSED with a
// visible message the model can react to, never a silent no-op and never a free run.
export async function runTool(xell, { name = null, args = {} } = {}) {
  const desc = LANGCHAIN_TOOLS[name];
  if (!desc) {
    return JSON.stringify({ ok: false, error: `"${name}" is not a bindable tool for this zee — the `
      + 'allowlist is the confinement and that verb is not on it.' });
  }
  try {
    const out = await desc.run(xell, args || {});
    return typeof out === 'string' ? out : JSON.stringify(out);
  } catch (e) {
    return JSON.stringify({ ok: false, error: `tool "${name}" error: ${String(e.message).slice(0, 300)}` });
  }
}

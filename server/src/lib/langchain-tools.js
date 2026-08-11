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
//   • done, device, db-sandbox, prod, seed, land, ship — done out of the loop by design; the rest
//     are infra/prod asks that must stay human-only. WAVE 2 (tend, hint-land, hint-ship, land, ship,
//     seed) is approved IN PRINCIPLE but added ONLY after wave 1 is green AND a test shows a bound
//     `land` producing a HELD request, not a landing.
import { selfStatus, selfWorking, selfWork, selfWorkItem } from '../queenzee/self.js';

// The four WAVE-1 verbs. Each: { name, description, schema (JSON schema for the model), run(xell,
// args) -> anything }. `xell` is the turn's xell (resolved by the queenzee), args are the model's.
export const LANGCHAIN_TOOLS = [
  {
    name: 'status',
    description: 'Read THIS xell\'s status: the task, whether a landing/ship/done is pending a human, '
      + 'the xell\'s containers and db binding. Read-only orientation.',
    schema: { type: 'object', properties: {}, required: [] },
    run: (xell) => selfStatus(xell),
  },
  {
    name: 'work',
    description: 'Read the work item THIS zee is executing — its plan, ticket and history (use `item` '
      + 'to report progress on it). Read-only.',
    schema: { type: 'object', properties: {}, required: [] },
    run: (xell) => selfWork(xell),
  },
  {
    name: 'working',
    description: 'Ping "I am actively working" with an optional note. Reports a change of state, '
      + 'never a gate.',
    schema: { type: 'object', properties: { note: { type: 'string' } }, required: [] },
    run: (xell, args) => selfWorking(xell, { note: args?.note || null }),
  },
  {
    name: 'item',
    description: 'Report where THIS xell\'s work item has got to: status, progress (0-100), and an '
      + 'optional note. A report of fact, never a gate.',
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
];

// The bindable tool list — what the loop binds. Only what is in this registry, nothing else.
export function toolList() {
  return LANGCHAIN_TOOLS;
}

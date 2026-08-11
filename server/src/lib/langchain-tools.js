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

// The four WAVE-1 verbs. Keyed BY NAME so the loop and runTool can look a request up in one step and
// so the never-bindable check is a single property test: `LANGCHAIN_TOOLS[name]` is undefined for
// anything that is not bindable. Each entry: { name, description, schema (JSON schema), run(xell,
// args) -> anything }. `xell` is the turn's xell (resolved by the queenzee), args are the model's.
export const LANGCHAIN_TOOLS = {
  status: {
    name: 'status',
    description: 'Read THIS xell\'s status: the task, whether a landing/ship/done is pending a human, '
      + 'the xell\'s containers and db binding. Read-only orientation.',
    schema: { type: 'object', properties: {}, required: [] },
    run: (xell) => selfStatus(xell),
  },
  work: {
    name: 'work',
    description: 'Read the work item THIS zee is executing — its plan, ticket and history (use `item` '
      + 'to report progress on it). Read-only.',
    schema: { type: 'object', properties: {}, required: [] },
    run: (xell) => selfWork(xell),
  },
  working: {
    name: 'working',
    description: 'Ping "I am actively working" with an optional note. WARNING: this also auto-clears '
      + 'this xell\'s open tend (a question that was posted to a human) if one is open — it does not '
      + 'RAISE a gate, but it can CLOSE one. Use it only when you are genuinely working, not as '
      + 'conversational filler.',
    schema: { type: 'object', properties: { note: { type: 'string' } }, required: [] },
    run: (xell, args) => selfWorking(xell, { note: args?.note || null }),
  },
  item: {
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
};

// The bindable tool list — what the loop binds. Only what is in this registry, nothing else.
export function toolList() {
  return Object.values(LANGCHAIN_TOOLS);
}

// Run ONE tool by name — THE single dispatch path. The loop calls THIS (never a second lookup), and
// it is the allowlist refusal. Returns the tool output as a string (the shape a ToolMessage carries).
// A name not in the registry is REFUSED with a visible message the model can react to, never a
// silent no-op and never a free run. `tools` is the registry to resolve against (the loop passes its
// own list so an injected test list stays authoritative); it defaults to the global LANGCHAIN_TOOLS
// and accepts either the keyed object or an array of descriptors.
export async function runTool(xell, { name = null, args = {} } = {}, tools = LANGCHAIN_TOOLS) {
  const list = Array.isArray(tools) ? tools : Object.values(tools);
  const desc = list.find((d) => d.name === name);
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

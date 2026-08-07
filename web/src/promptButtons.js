// THE SINGLE "+ prompt" BUTTON — whether it can be pressed, and if not, why.
//
// It is a pure function, kept out of the JSX so it can be tested in plain node (the same reason
// harnessHealth.js and hive/crew.js are pure), and so the decision has ONE place: the toolbar, and
// anything else that ever offers "start a zee", must agree about what is dispatchable.
//
// History: the console used to render one button per PERSONA (and before that, one per AI ACCOUNT).
// The router layer (Dispatch.jsx → routerGate / POST /api/router/route) now recomposes the prompt
// and decides provider/model/mode/harness itself; a persona pinned by a toolbar button was only a
// hint. So the toolbar shows ONE "+ prompt" button that opens the composer with no pinned harness.
// On a fleet with no router feature the human picks the persona inside the composer; on a
// router-gated fleet the router picks it (optionally overridden in Custom deployment).
//
// What remains of the pure decision is honesty about whether anything can be dispatched at all:
//   • no dispatchable account → the caller shows "add provider" instead (hasAnyAccount)
//   • every account paused → this button stays, DISABLED, carrying the reason
// Persona-level policy blocks live inside the composer, not on the toolbar — a disabled control
// with no reason is the bug this file exists to avoid, and hiding it instead would read as
// "dispatch disappeared".
//
//   providers — GET /api/projects/:id/tokens (the masked account read model)
//
// Returns { blocked, runsOn } where `blocked` is a SENTENCE (never a boolean alone) when the
// button cannot be pressed, else null.
export function promptButton(providers = []) {
  const ai = (providers || []).filter((p) => p.provider !== 'github' && p.dispatch);
  const live = ai.filter((p) => (p.accounts || []).some((a) => !a.paused));
  if (live.length) return { blocked: null, runsOn: live };
  // A PAUSE is not an absence, and saying "nothing is connected" when an account is merely paused
  // sends a human to Project setup to add a token they already have. The pause is reversible and
  // deliberate (104), and the spawn refuses a paused account anyway (spawnCreds → tokenForSpawn) —
  // so name it as the pause it is.
  const pausedOnly = ai.length > 0
    && ai.every((p) => (p.accounts || []).length && p.accounts.every((a) => a.paused));
  return {
    runsOn: [],
    blocked: pausedOnly
      ? 'every AI provider account on this project is PAUSED — resume one in Project setup'
      : 'no AI provider account is connected to this project',
  };
}

// Is there anything to dispatch ON at all? When not, the one honest button is "add provider" —
// visibility IS the token store.
export const hasAnyAccount = (providers = []) =>
  (providers || []).some((p) => p.provider !== 'github' && p.dispatch && (p.accounts || []).length);

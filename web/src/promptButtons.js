// WHICH "＋ prompt" BUTTONS THE CONSOLE SHOWS — one per PERSONA, and whether each can be pressed.
//
// It is a pure function, kept out of the JSX so it can be tested in plain node (the same reason
// harnessHealth.js and hive/crew.js are pure), and so the decision has ONE place: the toolbar, and
// anything else that ever offers "start a zee", must agree about what is dispatchable.
//
// The rule it encodes, and why the buttons are personas at all: the console used to render one
// button per connected AI ACCOUNT, with the harness as the last segmented control inside the
// composer. That puts the credential first and the manual last, and the two could contradict each
// other — a Claude account button plus a persona whose model policy allows only deepseek dispatched
// a refusal (resolveDispatchModel) after the whole prompt had been written. The harness carries the
// manual, the skills and the model policy, so the harness is the button, and everything under it
// (providers, accounts, models, autonomy) is derived from it by GET /api/dispatch/options.
//
//   harnesses — GET /api/harnesses?zee_type=worker&project=… (core excluded by the caller)
//   providers — GET /api/projects/:id/tokens (the masked account read model)
//   defaultHarnessId — pool_config.default_harness_id (fleet.pool): the persona a BARE dispatch
//                      attaches, so it leads the row and says so
//
// Returns [{ key, label, glyph, scope, title, isDefault, blocked, runsOn }] in render order, where
// `key` is the three-state harness value the dispatch payload carries: '' = core only, else the
// harness key. `blocked` is a SENTENCE (never a boolean alone) — a disabled control with no reason
// is the bug this file exists to avoid, and hiding it instead would read as "my persona disappeared".
export function promptButtons(harnesses = [], providers = [],
                              { emptyWarning = () => null, defaultHarnessId = null } = {}) {
  const ai = (providers || []).filter((p) => p.provider !== 'github' && p.dispatch);
  const live = ai.filter((p) => (p.accounts || []).some((a) => !a.paused));
  // The persona's EFFECTIVE policy (the whole parent chain merged — a child that inherits
  // "claude only" declares nothing of its own), intersected with what this project can actually
  // dispatch on. An empty allow-list is no restriction, not "nothing allowed".
  const runnable = (allow) => (!allow?.length ? live : live.filter((p) => allow.includes(p.provider)));
  const personas = (harnesses || []).map((h) => ({
    key: h.key, label: h.label, glyph: h.glyph || null, scope: h.scope,
    warn: emptyWarning(h), allow: h.effective_model_policy?.allow_providers || [],
    title: h.summary || h.label,
    // The project's DEFAULT persona (pool_config) leads, because it is what a bare dispatch — and
    // therefore every other surface — already attaches. Marked, not just first: "why is this one at
    // the front" is a question a human should not have to answer by experiment.
    isDefault: !!defaultHarnessId && h.id === defaultHarnessId,
  }));
  const rows = [
    ...personas.filter((p) => p.isDefault),
    ...personas.filter((p) => !p.isDefault),
    // CORE ONLY last: a dispatch with no persona at all was reachable from the old composer and
    // must not become impossible now that the persona is the button — but it is the rare case, so
    // it does not lead.
    { key: '', label: 'core only', glyph: '○', scope: 'global', warn: null, isDefault: false,
      allow: [], title: 'Core only — the manual + binding rules, no persona/skills layer' },
  ];
  return rows.map((b) => {
    const runsOn = runnable(b.allow);
    // A PAUSE is not an absence, and saying "nothing is connected" when an account is merely paused
    // sends a human to Project setup to add a token they already have. The pause is reversible and
    // deliberate (104), and the spawn refuses a paused account anyway (spawnCreds → tokenForSpawn) —
    // so name it as the pause it is. Same for a policy-restricted persona: say which provider.
    const named = (allow) => (allow?.length ? ai.filter((p) => allow.includes(p.provider)) : ai);
    const pausedOnly = named(b.allow).length > 0
      && named(b.allow).every((p) => (p.accounts || []).length && p.accounts.every((a) => a.paused));
    return {
      ...b,
      runsOn,
      blocked: runsOn.length ? null
        : pausedOnly
          ? `every ${b.allow.length ? b.allow.join(' / ') : 'AI provider'} account on this project is PAUSED — resume one in Project setup`
        : b.allow.length
          ? `no connected account for the provider(s) this persona allows (${b.allow.join(', ')})`
          : 'no AI provider account is connected to this project',
    };
  });
}

// Is there anything to dispatch ON at all? When not, the one honest button is "add provider" —
// visibility IS the token store, exactly as before the buttons became personas.
export const hasAnyAccount = (providers = []) =>
  (providers || []).some((p) => p.provider !== 'github' && p.dispatch && (p.accounts || []).length);

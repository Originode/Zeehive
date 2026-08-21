// Per-project AI-provider ACCOUNTS (spec: cxell zees) — the meta-DB is the credential store.
// Since 036 a project can hold SEVERAL accounts of one provider type (two Claude subscriptions,
// say): each is its own row with its own label and its own prompt button in the console. The
// full token leaves this module through ONE door: tokenForSpawn(), used when the queenzee
// injects it into a zee-agent container's environment. Everything the console sees is masked.
import { q, one } from '../db/pool.js';
import { logline } from './logbus.js';
// runtimeKeyForProvider/adapterFor map a provider onto its CXELL runtime's adapter — the ONE place
// that knows each vendor CLI's env dialect. providerRunEnv below builds the RUNNABLE env for a
// vendor through this door, so the mapping is never copied into the zee CLI (the exact drift class
// test/cxell-cli-drift.test.mjs exists to catch). One direction only: cxell-runtimes.js imports
// nothing from here, so there is no cycle.
import { runtimeKeyForProvider, adapterFor, grokSessionCredential } from './cxell-runtimes.js';

// provider TYPE registry — how to obtain a token of each type and what a valid one looks like.
// UI copy lives here too so the console renders new provider types without a client change.
export const PROVIDERS = {
  claude: {
    key: 'claude',
    label: 'Claude',
    dispatch: true,   // a zee can run on this provider today
    command: 'claude setup-token',
    placeholder: 'sk-ant-oat01-…',
    steps: 'Run the command in any terminal. Your browser opens — authorize, and the CLI prints a long-lived token (sk-ant-oat01-…). Paste it below; it is stored only in the meta-DB.',
    // sk-ant-oat01-<base64ish>; stay loose on the tail so a format tweak upstream doesn't lock us out
    valid: (t) => /^sk-ant-[a-z0-9]+-[A-Za-z0-9_-]{20,}$/.test(t),
    // SIGNATURE: a prefix Anthropic and nobody else issues, so a token carrying it can be ATTRIBUTED
    // to claude (credentialVendorMismatch) even though the loose shapes below overlap each other.
    // This is the one that had to exist: an sk-ant-… key sent to api.deepseek.com is what killed ten
    // DeepSeek zees on 2026-08-01→03, with the vendor's 401 blaming a healthy account.
    signature: /^sk-ant-/,
  },
  // The GPT runtime is the literal ChatGPT Codex CLI (`codex exec` inside the cxell,
  // OPENAI_API_KEY auth — runtime 'codex-cxell'). sk-ant-… is explicitly rejected so a Claude
  // token pasted in the wrong slot fails loudly instead of sitting dormant.
  openai: {
    key: 'openai',
    label: 'ChatGPT Codex',
    dispatch: true,   // codex-cxell runtime (lib/cxell-runtimes.js)
    command: 'https://platform.openai.com/api-keys',
    placeholder: 'sk-proj-… / sk-…',
    steps: 'Create an API key on the OpenAI platform (sk-… or sk-proj-…) and paste it below; it is stored only in the meta-DB. Dispatched zees run the Codex CLI inside their cxell.',
    valid: (t) => /^sk-[A-Za-z0-9_-]{20,}$/.test(t) && !/^sk-ant-/.test(t),
  },
  // Mark's ruling (2026-07-20): NOT Kimi-via-claude-CLI shims — the Kimi runtime is the literal
  // Kimi Code CLI (`kimi --print` inside the cxell — runtime 'kimi-code-cxell'), whose dedicated
  // CODING key comes from kimi.com/code/console (a different credential than a Moonshot Open
  // Platform key).
  kimi: {
    key: 'kimi',
    label: 'Kimi Code',
    dispatch: true,   // kimi-code-cxell runtime (lib/cxell-runtimes.js)
    command: 'https://kimi.com/code/console',
    placeholder: 'the coding key from the Kimi Code console',
    steps: 'Create a dedicated CODING key in the Kimi Code console (not a Moonshot platform key) and paste it below; it is stored only in the meta-DB. Dispatched zees run the Kimi Code CLI inside their cxell.',
    valid: (t) => /^[A-Za-z0-9_-]{20,}$/.test(t) && !/^sk-ant-/.test(t),
  },
  // DeepSeek ships no coding-agent CLI of its own — a DeepSeek zee runs the claude CLI against
  // DeepSeek's OWN Anthropic-compatible endpoint (runtime 'deepseek-cxell'): the sanctioned
  // exception to the vendor-native ruling, decided 2026-07-22 (see lib/cxell-runtimes.js).
  deepseek: {
    key: 'deepseek',
    label: 'DeepSeek',
    dispatch: true,   // deepseek-cxell runtime (lib/cxell-runtimes.js)
    command: 'https://platform.deepseek.com/api_keys',
    placeholder: 'sk-…',
    steps: 'Create an API key on the DeepSeek platform (sk-…) and paste it below; it is stored only in the meta-DB. Dispatched zees run the claude CLI against DeepSeek’s Anthropic-compatible endpoint.',
    // sk-<alnum tail>; sk-ant-… is explicitly rejected so a Claude token in the wrong slot fails loudly
    valid: (t) => /^sk-[A-Za-z0-9]{20,}$/.test(t) && !/^sk-ant-/.test(t),
  },
  // xAI ships its own coding-agent CLI, so the vendor-native ruling applies with no exception: a
  // Grok zee runs the literal Grok Build CLI (`grok -p` inside the cxell — runtime 'grok-cxell').
  //
  // TWO CREDENTIALS ARE ACCEPTED, because xAI sells two things. An `xai-…` API key spends PREPAID
  // API credits; a SuperGrok / Business SEAT is a signed-in SESSION and spends the subscription's
  // weekly pool instead. The seat's headless door is `grok login --device-auth` (a device code, no
  // browser on the box), and what it produces is the FILE ~/.grok/auth.json — so that file's
  // contents are what a human pastes here, and the cage installs it (lib/cxell-runtimes.js
  // authSetupCmd). Pasting BOTH is not a thing: an account row is one credential, and a cage given a
  // session deliberately carries no XAI_API_KEY, since the key wins over the seat.
  grok: {
    key: 'grok',
    label: 'Grok Build',
    dispatch: true,   // grok-cxell runtime (lib/cxell-runtimes.js)
    command: 'grok login --device-auth && cat ~/.grok/auth.json',
    placeholder: '{"https://accounts.x.ai/sign-in":{…}}  — or xai-… for an API key',
    steps: 'For a SuperGrok / Business seat (no prepaid API credits): run the command on any machine that has the grok CLI — it prints a URL and a code to enter in any browser — then paste the ~/.grok/auth.json it prints below. For pay-as-you-go instead, create an API key at https://console.x.ai (xai-…) and paste that. Either way it is stored only in the meta-DB, and dispatched zees run the Grok Build CLI inside their cxell.',
    // an xai-… API key, OR a device-auth session (the auth.json object — shape measured in
    // lib/cxell-runtimes.js, which owns the predicate because the adapter branches on it too)
    valid: (t) => /^xai-[A-Za-z0-9_-]{20,}$/.test(t) || !!grokSessionCredential(t),
    // Stored CANONICALLY: a session pasted from a pretty-printed file becomes one compact line, so
    // it can never split a KEY=value in the cage's /etc/environment (scrubEnvValue's concern) and
    // two pastes of the same session are the same string.
    normalize: (t) => (grokSessionCredential(t) ? JSON.stringify(grokSessionCredential(t)) : t),
    // A session's first 13 characters are `{"https://acc` for every account alike, so the generic
    // head…tail hint would name nothing. Say what it IS instead — the scope's auth_mode and the
    // last 4 of the session key, which is what an xAI-side error message can be matched against.
    hint: (t) => {
      const s = grokSessionCredential(t);
      if (!s) return null;                       // an API key: the generic hint is right for it
      const e = Object.values(s)[0] || {};
      return `grok ${String(e.auth_mode || 'session')} session …${String(e.key || '').slice(-4)}`;
    },
    // SIGNATURE (see claude): `xai-` is xAI's own prefix, and it has to be declared here because the
    // loose shapes above swallow it — kimi's "20+ chars that are not sk-ant-" accepts an xAI key, so
    // without this an xAI token pasted into the wrong slot would be unattributable. A SESSION needs
    // no signature arm: it is a JSON object, every other vendor's `valid` is an anchored one-line
    // charset that rejects `{`, so the SHAPE arm of attributeTokenVendor already names it grok and
    // nothing else — and keeping the signature a bare prefix keeps scrubSecrets' registry-built
    // regex a set of prefixes. (What that costs: a session key echoed back in a vendor error is not
    // masked by scrubSecrets — it carries no prefix to match. Nothing in the fleet prints it.)
    signature: /^xai-/,
  },
  // GitHub is INBOUND BY DEFAULT (migration 032): this token drives clone/pull fetches in
  // lib/remote-git.js. A Contents:Read-only PAT is the safe default and keeps Zeehive fetch-only.
  // If the PAT instead carries Contents: WRITE (and, for PRs, Pull requests: write), the console's
  // Project setup ADDITIONALLY offers a human-confirmed Push / open-PR (lib/remote-git.js
  // remoteAccess/pushRemote/openPullRequest) — still never a zee's to trigger.
  github: {
    key: 'github',
    label: 'GitHub',
    command: 'GitHub → Settings → Developer settings → Fine-grained tokens',
    placeholder: 'github_pat_… / ghp_…',
    steps: 'Create a fine-grained personal access token scoped to this repo. Contents: READ-ONLY keeps Zeehive fetch-only (the safe default). Grant Contents: WRITE (plus Pull requests: write for PRs) and Project setup gains a human-confirmed Push / open-PR button. Paste it below; it is stored only in the meta-DB.',
    // classic ghp_…, fine-grained github_pat_…, or an OAuth/device token gho_/ghu_/ghs_ (what
    // `gh auth token` and git-credential-manager hold — a proven-working fallback when an org's
    // fine-grained-PAT policy fights the human); loose tails for the same reason as above
    valid: (t) => /^(gh[opus]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})$/.test(t),
    // SIGNATURE (see claude): GitHub's prefixes are its own. This credential must never reach a
    // vendor CLI — it is infra, and `dispatch:false` already keeps it off the dispatch path — but
    // attributing it means a mis-wired env is one named sentence instead of an auth error at a
    // model API that has no idea what it was given.
    signature: /^(gh[opus]_|github_pat_)/,
  },
};

// The masked read model of a credential: head…tail is right for every key-shaped token, and a
// provider may override it for a credential that is NOT key-shaped (grok's device-auth session is a
// JSON object whose first 13 characters are identical for every account). Never the token itself.
const hint = (t, provider = null) => PROVIDERS[provider]?.hint?.(t)
  || `${t.slice(0, 13)}…${t.slice(-4)}`;

// ── THE LAST GATE BEFORE A CREDENTIAL LEAVES FOR A VENDOR'S API ──────────────────────────────────
//
// decideRuntimePairing (lib/cxell-runtimes.js) settles provider/runtime/credential at the moment a
// dispatch is DECIDED. This is the other half, and it is deliberately not the same check: it looks
// at the credential STRING about to be handed to a vendor CLI and asks whether it is, plainly,
// some OTHER vendor's key. One is a decision, the other is a fact, and only the fact holds on
// every path — spawn, resume, a re-crewed cage, and whatever adapter is added next.
//
// It exists because the decision alone did not hold. Ten DeepSeek zees in this fleet died on
// "Failed to authenticate. API Error: 401 Authentication Fails, Your api key: ****CAAA is invalid"
// (2026-08-01 → 2026-08-03) — DeepSeek's wording, and ****CAAA the last four of the CLAUDE OAuth
// token (sk-ant-oat01-…CAAA). $0 spent, no code, a xell burned each time, and the vendor's sentence
// names the CREDENTIAL, so the human's next move is to rotate or pause a perfectly healthy account.
// The pairing fix closed the dispatch path; the RESUME path still reads its fallback token out of
// the cage's /etc/environment by `adapter.tokenEnvKey` — which is ANTHROPIC_AUTH_TOKEN for the
// claude AND the deepseek adapter alike, so a token read back from a cage cannot be attributed to a
// vendor at all. This can.
//
// IDENTIFICATION MUST BE UNAMBIGUOUS, or it says nothing — and MEASURED against the registry above
// rather than assumed. Running every `valid()` over one real token of each type (2026-08-04):
//   sk-ant-oat01-…            → [claude]
//   a DeepSeek platform key   → [openai, kimi, deepseek]
//   an OpenAI sk-proj-… key   → [openai, kimi]
//   a Kimi coding key         → [kimi]
//   github_pat_… / ghp_…      → [kimi, github]
// The paste-box predicates are deliberately LOOSE at the tail (a format tweak upstream must not
// lock a human out), and kimi's — "20+ chars of [A-Za-z0-9_-] that is not sk-ant-" — is a superset
// of nearly every other shape. So "exactly one shape accepts it" alone attributes only two of the
// five, which is why a vendor may ALSO declare a `signature`: a prefix that this vendor and no
// other issues. That is an explicit human-auditable claim, not an inference from regex overlap.
//
//   attribution = the single vendor whose SIGNATURE matches, else the single vendor whose SHAPE
//                 matches, else NOTHING — and nothing means the credential is allowed through.
//
// So the guard can only ever fire on a token it can NAME: a DeepSeek/OpenAI key is unattributable
// by construction and is never refused, and a vendor changing its key format costs a missed catch,
// never a refused dispatch. Refusing on "does not match the TARGET's shape" is the tempting
// spelling and is the one that takes the fleet down the day DeepSeek adds a prefix — kimi's shape
// would claim the new key and "some other vendor wants it" would look like proof.
export function identifyTokenVendors(token) {
  const t = String(token || '').trim();
  if (!t) return [];
  return Object.values(PROVIDERS).filter((p) => {
    try { return p.valid(t); } catch { return false; }
  }).map((p) => p.key);
}

// WHO ISSUED THIS TOKEN — a vendor key, or null when nothing can be said. See above for why the
// signature layer exists and why "null" is the safe answer rather than a guess.
export function attributeTokenVendor(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  const signed = Object.values(PROVIDERS).filter((p) => {
    try { return p.signature ? p.signature.test(t) : false; } catch { return false; }
  });
  if (signed.length) return signed.length === 1 ? signed[0].key : null;
  const shaped = identifyTokenVendors(t);
  return shaped.length === 1 ? shaped[0] : null;
}

// PURE. Returns null when the credential may be sent, or { from, to, hint, sentence } when it is
// unmistakably another vendor's. The sentence is what a human reads instead of the vendor's 401,
// and it carries the MASKED token only (`sk-ant-oat01-…CAAA`) — the same hint the console shows,
// which is also exactly what makes the vendor's own message matchable to an account.
export function credentialVendorMismatch({ provider, token } = {}) {
  const t = String(token || '').trim();
  if (!t || !provider) return null;
  const from = attributeTokenVendor(t);
  if (!from || from === provider) return null;    // unattributable, or the right vendor — allowed
  const label = (k) => PROVIDERS[k]?.label || k;
  const masked = t.length > 20 ? hint(t, from) : '…';
  return { from, to: provider, hint: masked, sentence:
    `that credential is a ${label(from)} token (${masked}) and this cage runs on ${label(provider)} — `
    + `a ${label(provider)} endpoint will answer "your api key is invalid" and blame the ${label(from)} `
    + `account, which is healthy. Dispatch on ${label(from)}, or connect a ${label(provider)} account `
    + 'in Project setup.' };
}

// masked read model: every provider TYPE, each with its list of connected ACCOUNTS — never the
// token itself. The legacy per-type fields (connected/token_hint/…) mirror the FIRST account so
// older consumers keep working; new consumers read `accounts`. Each account carries its pause
// state (paused/paused_at/paused_by/reason — migration 104): a paused account is still connected
// but no dispatch may start a zee on it.
export async function listProviderTokens(projectId) {
  // usage_limit / usage_limit_at (migration 203) — how much of THIS account's provider quota is
  // still available. Written by the LLM gateway from upstream rate-limit headers. SELECT * of the
  // known columns so a pre-203 database still answers (missing columns → query fails → we retry
  // without them, so the Providers panel never goes blank over a missing migration).
  let rows;
  try {
    rows = await q(
      `SELECT id, provider, label, token_hint, created_at, last_used_at,
              paused_at, paused_by, reason, usage_limit, usage_limit_at
         FROM provider_token WHERE project_id = $1 ORDER BY created_at`, [projectId]);
  } catch {
    rows = await q(
      `SELECT id, provider, label, token_hint, created_at, last_used_at,
              paused_at, paused_by, reason
         FROM provider_token WHERE project_id = $1 ORDER BY created_at`, [projectId]);
  }
  // Per-provider spend-alert thresholds (migration 206): { claude: 50 } = "flag a xell whose
  // gateway-ledger spend on claude exceeds $50". Read beside the accounts so the Providers panel
  // can offer the alert input on the same row it shows the % free.
  const alertAmounts = await getProviderAlertAmounts(projectId);
  return Object.values(PROVIDERS).map((p) => {
    const accounts = rows.filter((r) => r.provider === p.key)
      .map(({ id, label, token_hint, created_at, last_used_at, paused_at, paused_by, reason,
              usage_limit, usage_limit_at }) => ({
        id, label, token_hint, created_at, last_used_at,
        paused: !!paused_at, paused_at, paused_by, reason,
        // USAGE LIMIT available for THIS account — not fleet spend, not per-xell. Null until the
        // gateway has seen one call authenticated with this account's key.
        usage_limit: usage_limit || null,
        usage_limit_at: usage_limit_at || null,
        available_pct: usage_limit?.available_pct ?? null,
      }));
    const pausedCount = accounts.filter((a) => a.paused).length;
    // The provider-level available_pct is the WORST (lowest remaining) of its active accounts —
    // "claude is at 12%" means at least one connected seat is that tight.
    const activeAvails = accounts
      .filter((a) => !a.paused && a.available_pct != null)
      .map((a) => a.available_pct);
    return {
      provider: p.key, label: p.label, command: p.command, steps: p.steps,
      placeholder: p.placeholder || null,   // the SHAPE to paste — console copy, so it stays here
      dispatch: !!p.dispatch,   // can a zee run on it? (github: no — infra credential)
      connected: accounts.length > 0,
      accounts,
      // spend-alert threshold (USD) for ONE xell on THIS provider — migration 206, set in the
      // Providers panel. Null when no alert configured.
      alert_amount: alertAmounts[p.key] ?? null,
      // every account of this type is paused → the provider as a whole is disabled
      all_paused: accounts.length > 0 && pausedCount === accounts.length,
      token_hint: accounts[0]?.token_hint || null,
      created_at: accounts[0]?.created_at || null,
      last_used_at: accounts[0]?.last_used_at || null,
      available_pct: activeAvails.length ? Math.min(...activeAvails) : null,
    };
  });
}

// PROJECT-LEVEL PROVIDER SPEND-ALERT THRESHOLDS (migration 206) — { provider: USD }. A human
// sets these in Project setup → Agent providers; the fleet read model compares each xell's
// gateway-ledger spend on a provider against the threshold and flags the hexagon when it is
// exceeded. Absent key = no alert. Read as a plain object (never undefined).
export async function getProviderAlertAmounts(projectId) {
  const row = await one(
    `SELECT provider_alert_amounts FROM project WHERE id = $1`, [projectId]).catch(() => null);
  const map = row?.provider_alert_amounts;
  if (map && typeof map === 'object' && !Array.isArray(map)) return map;
  return {};
}

// Set (or clear) ONE provider's spend-alert threshold. `amount` is a USD number; null/0/''/NaN
// clears the alert. Unknown provider keys are refused (the catalogue lives in PROVIDERS above, so
// a typo becomes a 400 instead of a silently-ignored threshold).
export async function setProviderAlertAmount(projectId, provider, amount) {
  if (!PROVIDERS[provider]) throw new Error(`unknown provider "${provider}"`);
  const next = await getProviderAlertAmounts(projectId);
  const v = amount === '' || amount == null ? null : Number(amount);
  if (v != null && (!Number.isFinite(v) || v < 0)) {
    throw new Error('alert amount must be a non-negative USD number (or empty to clear)');
  }
  if (v == null || v <= 0) delete next[provider];
  else next[provider] = Math.round(v * 100) / 100;   // cents precision — it is money
  await q(`UPDATE project SET provider_alert_amounts = $2 WHERE id = $1`,
    [projectId, JSON.stringify(next)]);
  return { ok: true, provider, alert_amount: next[provider] ?? null };
}

// PROJECT-LEVEL PROVIDER LIMITS — how much of each connected provider account's quota is still
// available. Read-only, account-grained (never per-xell). Used by the statusline chip and any
// surface that asks "can I still dispatch on claude?" without opening Project setup.
export async function providerLimits(projectId) {
  const tokens = await listProviderTokens(projectId);
  return tokens
    .filter((p) => p.dispatch && p.connected)
    .map((p) => ({
      provider: p.provider,
      label: p.label,
      available_pct: p.available_pct,
      accounts: p.accounts.map((a) => ({
        id: a.id,
        label: a.label,
        token_hint: a.token_hint,
        paused: a.paused,
        available_pct: a.available_pct,
        usage_limit: a.usage_limit,
        usage_limit_at: a.usage_limit_at,
      })),
    }));
}

function validate(provider, token) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider "${provider}"`);
  const t = String(token || '').trim();
  if (!t) throw new Error('token is empty');
  if (!p.valid(t)) throw new Error(`that does not look like a ${p.label} token — see the steps for what to paste`);
  // CANONICALIZE before it is stored, where the provider says how (grok compacts a pasted
  // auth.json). Every write path goes through here, so a stored credential is never the paste's
  // incidental whitespace.
  return { p, t: p.normalize ? String(p.normalize(t)) : t };
}

// ADD an account of this type (multiple per type allowed — that is the point since 036).
export async function addProviderToken(projectId, provider, token, label = null) {
  const { t } = validate(provider, token);
  const row = await one(
    `INSERT INTO provider_token (project_id, provider, token, token_hint, label)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [projectId, provider, t, hint(t, provider), String(label || '').trim() || null]);
  return (await listProviderTokens(projectId)).find((r) => r.provider === provider)
    ?? { id: row.id };
}

// Legacy PUT semantics, kept for scripts and the github panel: no account of this type → create;
// exactly one → replace it in place; several → refuse rather than guess which to clobber.
export async function setProviderToken(projectId, provider, token) {
  const { t } = validate(provider, token);
  const rows = await q(`SELECT id FROM provider_token WHERE project_id=$1 AND provider=$2`, [projectId, provider]);
  if (rows.length > 1) throw new Error(`several ${provider} accounts are connected — add/remove specific accounts instead`);
  if (rows.length === 1) {
    await q(`UPDATE provider_token SET token=$2, token_hint=$3, created_at=now(), last_used_at=NULL WHERE id=$1`,
      [rows[0].id, t, hint(t, provider)]);
  } else {
    await q(`INSERT INTO provider_token (project_id, provider, token, token_hint) VALUES ($1,$2,$3,$4)`,
      [projectId, provider, t, hint(t, provider)]);
  }
  return (await listProviderTokens(projectId)).find((r) => r.provider === provider);
}

// disconnect ONE account by id (scoped to the project so a stray id can't cross projects)
export async function deleteProviderAccount(projectId, accountId) {
  await q('DELETE FROM provider_token WHERE project_id = $1 AND id = $2', [projectId, accountId]);
  return { ok: true };
}

// disconnect ALL accounts of a type (legacy route; the console now removes per account)
export async function deleteProviderToken(projectId, provider) {
  await q('DELETE FROM provider_token WHERE project_id = $1 AND provider = $2', [projectId, provider]);
  return { ok: true };
}

// PAUSE / RESUME one account (migration 104). Pausing disables the account for every dispatch
// surface without disconnecting it — the token stays in the meta-DB, the row stays connected,
// and only the spawn gate refuses it. `by` and `reason` ride along for the audit trail, exactly
// like the fleet/project/xell pause tables. A paused account can always be resumed (or deleted).
export async function setProviderAccountPaused(projectId, accountId, paused, { by = 'human@console', reason = null } = {}) {
  const row = await one(
    `UPDATE provider_token SET
        paused_at  = CASE WHEN $3 THEN COALESCE(paused_at, now()) ELSE NULL END,
        paused_by  = CASE WHEN $3 THEN $4::text ELSE NULL END,
        reason     = CASE WHEN $3 THEN $5::text ELSE NULL END,
        resumed_at = CASE WHEN $3 THEN NULL ELSE now() END,
        resumed_by = CASE WHEN $3 THEN NULL ELSE $4::text END
      WHERE project_id = $1 AND id = $2 RETURNING id, provider, paused_at, paused_by, reason, resumed_at`,
    [projectId, accountId, !!paused, by, reason]);
  if (!row) throw new Error('provider account not found');
  return { id: row.id, provider: row.provider, paused: !!row.paused_at,
           paused_at: row.paused_at, paused_by: row.paused_by, reason: row.reason, resumed_at: row.resumed_at };
}

// The pre-flight gate every dispatch path calls before it routes to a runtime. The cxell spawn
// re-checks the exact account in tokenForSpawn (that is the authoritative full-token read); this
// is the broader "is this provider usable at all" check that also catches runtimes which never
// read a meta-DB token (claude-code-remote, the host SDK) — pausing every Claude account must
// stop a Claude-remote spawn too, not just the cxell one. A provider with NO accounts is left to
// the spawn path: claude remote/local need no meta-DB token, and the cxell path already answers
// "no token connected" with the exact fix.
export async function assertProviderDispatchable(projectId, provider, { tokenId = null } = {}) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider "${provider}"`);
  if (!p.dispatch) return; // infra credential (github) — nothing dispatches a zee on it anyway
  if (tokenId) {
    const row = await one(
      `SELECT paused_at FROM provider_token WHERE project_id = $1 AND id = $2 AND provider = $3`,
      [projectId, tokenId, provider]);
    if (row?.paused_at) throw new Error(
      `that ${p.label} account is PAUSED — resume it in Project setup, or pick another account`);
    return;
  }
  const [total, active] = await Promise.all([
    one(`SELECT count(*)::int AS n FROM provider_token WHERE project_id = $1 AND provider = $2`, [projectId, provider]),
    one(`SELECT count(*)::int AS n FROM provider_token WHERE project_id = $1 AND provider = $2 AND paused_at IS NULL`, [projectId, provider]),
  ]);
  if ((total?.n || 0) > 0 && (active?.n || 0) === 0) {
    throw new Error(`every ${p.label} account is PAUSED — resume one in Project setup to dispatch ${p.label} zees`);
  }
}

// ── WHICH PROVIDER A DISPATCH THAT NAMED NONE RUNS ON ────────────────────────────────────────────
//
// Every dispatch entry point used to DEFAULT to claude — `provider = 'claude'` in the signature —
// which is not the same statement as "the caller asked for claude". On a project whose only
// connected account is a Codex or a Kimi one, a bare dispatch (a queued task, an MCP call, a
// manager's `zee dispatch`, a re-crewing swap that carried no provider) therefore died on
// "project has no claude token — connect one in Project setup", naming a vendor the human had
// deliberately not connected. A cage that carries every vendor's CLI should not have a favourite.
//
// PURE DECISION, exported so the whole rule is table-testable without a database (the same shape as
// lib/prod-readonly.js decideReaderAddress). Order matters and every step is a claim:
//
//   1. THE CALLER WINS. An explicit provider is an instruction, never a hint — including 'claude'.
//   2. A HOST-AUTH RUNTIME STAYS CLAUDE. `claude-code-remote` and the local SDK authenticate from
//      the HOST's own claude session and read no meta-DB token at all, so "no claude account" is
//      not a reason to move them to another vendor's CLI — that would silently change the runtime.
//   3. A HARNESS THAT RESTRICTS PROVIDERS decides among what it allows (migration 110's
//      allow_providers). Dispatching a persona onto a provider it forbids is the same class of bug
//      as briefing it with the wrong manual, and resolveDispatchModel would refuse it one step later
//      anyway — better to pick something allowed than to fail.
//   4. AN ACTIVE CLAUDE ACCOUNT KEEPS TODAY'S BEHAVIOUR, byte for byte. This is the common case and
//      it must not move.
//   5. OTHERWISE THE FRESHEST ACTIVE ACCOUNT'S PROVIDER — `accounts` arrives ordered the way
//      tokenForSpawn picks within a type (freshest first), so the two agree by construction.
//   6. NOTHING CONNECTED → claude, so the error a human reads is the familiar "connect one in
//      Project setup" rather than a new sentence about a provider they never mentioned.
//
// Returns { provider, reason } — the reason is logged at dispatch, because a provider nobody named
// must never be a silent choice.
export function decideDispatchProvider({ requested = null, claudeNeedsNoToken = false,
                                         allowProviders = [], accounts = [] } = {}) {
  const asked = String(requested || '').trim();
  if (asked) return { provider: asked, reason: 'requested' };
  if (claudeNeedsNoToken) return { provider: 'claude', reason: 'host-auth-runtime' };
  const allowed = (p) => !allowProviders.length || allowProviders.includes(p);
  const active = accounts.filter((a) => !a.paused && PROVIDERS[a.provider]?.dispatch && allowed(a.provider));
  if (allowed('claude') && active.some((a) => a.provider === 'claude')) {
    return { provider: 'claude', reason: 'claude-account' };
  }
  if (active.length) {
    const only = new Set(active.map((a) => a.provider));
    return { provider: active[0].provider,
             reason: only.size === 1 ? 'only-connected-provider' : 'freshest-connected-account' };
  }
  // no usable account: a restricted harness still names its own vendor, so the refusal that follows
  // is about the provider the PERSONA requires rather than about claude
  const restricted = allowProviders.find((p) => PROVIDERS[p]?.dispatch);
  return restricted ? { provider: restricted, reason: 'harness-policy' }
                    : { provider: 'claude', reason: 'fallback' };
}

// The I/O half of the decision above: read this project's dispatchable accounts (freshest first,
// paused flag included) and apply the rule. Never throws — a project with nothing connected returns
// the fallback, and the spawn path's own error says what to connect.
export async function dispatchProviderFor(projectId, { requested = null, tokenId = null,
                                                       claudeNeedsNoToken = false,
                                                       allowProviders = [] } = {}) {
  const asked = String(requested || '').trim();
  if (asked) return { provider: asked, reason: 'requested' };
  // An ACCOUNT id with no provider beside it still names a provider — the account's own. A surface
  // that sends provider_token_id alone (the console's per-account buttons carry both, but a script
  // need not) is asking for THAT account, and resolving anything else would ignore what it said.
  if (tokenId) {
    const acct = await one(`SELECT provider FROM provider_token WHERE project_id=$1 AND id=$2`,
                           [projectId, tokenId]).catch(() => null);
    if (acct?.provider) return { provider: acct.provider, reason: 'named-account' };
  }
  let accounts = [];
  try {
    accounts = await q(
      `SELECT provider, paused_at FROM provider_token WHERE project_id = $1 ORDER BY created_at DESC`,
      [projectId]);
  } catch { /* unreadable = nothing connected as far as this decision goes */ }
  return decideDispatchProvider({
    claudeNeedsNoToken, allowProviders,
    accounts: accounts.map((r) => ({ provider: r.provider, paused: !!r.paused_at })),
  });
}

// What a cxell spawn needs for a given AI provider ACCOUNT: the token plus (for a provider
// whose CLI takes an alternate endpoint) the base URL. `tokenId` pins the exact account the
// human's button carries; without one (CLI dispatches), the freshest account of the type is
// used. Refuses non-dispatchable types up front — a GitHub PAT is an infra credential, not
// something a zee can run on.
export async function spawnCreds(projectId, provider = 'claude', { tokenId = null } = {}) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider "${provider}"`);
  if (!p.dispatch) throw new Error(`no zee runtime for ${p.label} — dispatch on Claude, Codex, or Kimi`);
  const acct = await tokenForSpawn(projectId, provider, { tokenId });
  return { provider, token: acct.token, baseUrl: p.anthropicBaseUrl || null,
           tokenId: acct.id, accountLabel: acct.label };
}

// the one full-token read — the spawn path injecting into a cxell zee's environment
export async function tokenForSpawn(projectId, provider = 'claude', { tokenId = null } = {}) {
  const p = PROVIDERS[provider];
  const row = tokenId
    ? await one(
        // the id is authoritative but must MATCH the claimed type — a button can't smuggle a
        // github PAT into a zee spawn by pairing its id with provider=claude. A PAUSED account
        // is refused here even when its id is named, so no surface can route around the pause.
        `UPDATE provider_token SET last_used_at = now()
          WHERE project_id = $1 AND id = $2 AND provider = $3 AND paused_at IS NULL
          RETURNING id, label, token`,
        [projectId, tokenId, provider])
    : await one(
        // generic pick: the freshest ACTIVE account of the type — a paused account never shadows
        // an active sibling, and a type whose every account is paused refuses below
        `UPDATE provider_token SET last_used_at = now()
          WHERE id = (SELECT id FROM provider_token WHERE project_id = $1 AND provider = $2
                       AND paused_at IS NULL ORDER BY created_at DESC LIMIT 1)
          RETURNING id, label, token`,
        [projectId, provider]);
  if (!row) {
    if (tokenId) {
      // Distinguish PAUSED from gone so the caller is told which — a paused account is connected
      // and resumable; a missing one must be re-added.
      const existing = await one(
        `SELECT paused_at FROM provider_token WHERE project_id = $1 AND id = $2 AND provider = $3`,
        [projectId, tokenId, provider]);
      throw new Error(existing?.paused_at
        ? `that ${p?.label || provider} account is PAUSED — resume it in Project setup, or pick another account`
        : `that ${provider} account is no longer connected — it may have been removed; reopen the composer`);
    }
    const any = await one(
      `SELECT count(*)::int AS n FROM provider_token WHERE project_id = $1 AND provider = $2`,
      [projectId, provider]);
    throw new Error((any?.n || 0) > 0
      ? `every ${p?.label || provider} account is PAUSED — resume one in Project setup to dispatch ${p?.label || provider} zees`
      : `project has no ${provider} token — connect one in Project setup`);
  }
  return row;
}

// ── THE EVERY-PROVIDER ENV: what a cage carries BESIDE the dispatched provider's ──────────────
//
// spawnCxell injects the ACTIVE runtime's credential as `adapter.env()` — ANTHROPIC_AUTH_TOKEN
// for the claude AND the deepseek adapter alike. A zee whose task needs a DIFFERENT vendor's CLI
// (a manager swapping a worker onto Codex, a DeepSeek cage asked to compare against a Claude
// answer) had no way to get that vendor's key: the cage only carried the one it was born with.
// So the cage is now given EVERY dispatchable provider's freshest ACTIVE account, each under its
// own NON-COLLIDING namespaced env var, plus a manifest it can read to discover what it holds.
//
// ENV CONTRACT (a zee reads these with `zee creds` — see docs/cxell-provider-env.md):
//   ZEE_PROVIDERS             = comma-separated provider keys present, in PROVIDERS order
//   ZEE_PROVIDER_<KEY>_TOKEN  = the full token (KEY = the provider key, UPPERCASE)
//   ZEE_PROVIDER_<KEY>_LABEL  = the account label (or the provider label)
//   ZEE_PROVIDER_<KEY>_HINT   = the masked hint — what the console shows, matchable to an account
//
// PURE — the same table-testable shape as decideDispatchProvider (test/cxell-provider-env.test.mjs
// covers the collisions it must never reintroduce). It picks, per provider, the FIRST non-paused
// account in the input order (the caller hands freshest-first, exactly as tokenForSpawn picks
// within a type). Returns { env, skipped }:
//   env          — the namespaced vars to inject (empty when nothing is connected);
//   skipped      — { provider, reason } per account the guard REFUSED. A token unmistakably another
//                  vendor's is never injected under this provider's name — the SAME
//                  credentialVendorMismatch the active vendor's env goes through, and a cage carrying
//                  every key makes it MORE load-bearing, not less. One bad account is skipped (and
//                  logged by the caller) rather than poisoning the whole cage.
//   accounts_used — { provider, account_id, account_created_at } for each account actually picked —
//                  what the SPAWN should record in xell_provider_grant so the runnable-env door can
//                  later answer from the record instead of a challenge value.
export function everyProviderEnv(accounts = []) {
  const env = {};
  const skipped = [];
  const keys = [];
  const accountsUsed = [];
  for (const p of Object.values(PROVIDERS)) {
    if (!p.dispatch) continue;                       // github is INFRA — never in the set
    const acct = (accounts || []).find((a) => a.provider === p.key && !a.paused);
    if (!acct) continue;                             // no connected ACTIVE account of this type
    const token = String(acct.token || '').trim();
    if (!token) continue;
    const bad = credentialVendorMismatch({ provider: p.key, token });
    if (bad) {
      skipped.push({ provider: p.key, reason: `credentialVendorMismatch (${bad.from})` });
      continue;
    }
    const K = p.key.toUpperCase();
    env[`ZEE_PROVIDER_${K}_TOKEN`] = token;
    env[`ZEE_PROVIDER_${K}_LABEL`] = acct.label || p.label;
    env[`ZEE_PROVIDER_${K}_HINT`] = acct.token_hint || hint(token, p.key);
    keys.push(p.key);
    accountsUsed.push({ provider: p.key, account_id: acct.id, account_created_at: acct.created_at || null });
  }
  if (keys.length) env.ZEE_PROVIDERS = keys.join(',');
  return { env, skipped, accountsUsed };
}

// The I/O half of everyProviderEnv: read every connected account of a project, tokens included,
// freshest first — the exact shape everyProviderEnv picks from. Only the SPAWN path calls this
// (it is a full-token read; the ONE full-token door for a single account remains tokenForSpawn).
// It never refuses a paused or mis-attributed row — the pure function decides that, so the whole
// rule stays in ONE place, table-testable.
export async function allProviderTokenRows(projectId) {
  const rows = await q(
    `SELECT id, provider, token, label, token_hint, created_at, paused_at
       FROM provider_token WHERE project_id = $1 ORDER BY created_at DESC`, [projectId]);
  return rows.map((r) => ({ ...r, paused: !!r.paused_at }));
}

// ── THE RUNNABLE PROVIDER ENV — what `zee creds --provider <key> --export` prints ────────────────
//
// The cage holds every provider's raw token under ZEE_PROVIDER_<KEY>_TOKEN, but a zee cannot RUN a
// vendor CLI from that: the vendor wants its OWN env (KIMI_MODEL_API_KEY/NAME/BASE_URL,
// OPENAI_API_KEY, ANTHROPIC_AUTH_TOKEN+BASE_URL+MODEL) and, for codex, an in-cage `codex login
// --with-api-key` install. That mapping is the runtime adapters' (lib/cxell-runtimes.js) and is
// SERVER-COMPUTED here so the CLI never carries a second copy — the exact drift class
// test/cxell-cli-drift.test.mjs exists to catch. The CLI prints; it decides nothing.
//
// PURE — the table-testable heart (same shape as everyProviderEnv / decideDispatchProvider). Given
// ONE provider account's token, return the vendor env the CXELL adapter would set for that dispatch,
// plus any in-cage auth install the vendor needs. The token goes through the SAME guarded door the
// active env uses (credentialVendorMismatch) — a mis-attributed token is refused with the existing
// named sentence. The runtime is the provider's own CXELL adapter (claude falls back to
// claude-code-cxell, exactly as the spawn path resolves it).
export function providerRunEnvFromAccount({ provider, token, label = null, hint = null, model = null } = {}) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider "${provider}" — known: ${Object.values(PROVIDERS).filter((x) => x.dispatch).map((x) => x.key).join(', ')}`);
  if (!p.dispatch) throw new Error(`no zee runtime for ${p.label} — dispatch on Claude, Codex, or Kimi`);
  const t = String(token || '').trim();
  if (!t) throw new Error(`project has no ${provider} token — connect one in Project setup`);
  const bad = credentialVendorMismatch({ provider, token: t });
  if (bad) throw new Error(bad.sentence);
  const runtimeKey = runtimeKeyForProvider(provider) || 'claude-code-cxell';
  const adapter = adapterFor(runtimeKey);
  if (!adapter?.env) throw new Error(`no adapter env for ${p.label}`);
  return {
    provider,
    label: p.label,
    account: label || p.label,
    hint: hint || null,
    bin: adapter.bin || null,
    env: adapter.env({ token: t, baseUrl: p.anthropicBaseUrl || null, model }),
    // The account's token is passed so an adapter that installs only SOME credential shapes can
    // say "nothing to install" for the others (grok: an API key is env-only, a seat session is a
    // file). The spawn path calls it with no token and gets the command that handles both.
    // `file` is the vendor's own proof that the install happened (relative to $HOME) — declared by
    // the adapter, so the CLI can refuse to exit 0 on an un-installed cage without knowing a single
    // vendor path itself.
    auth_setup: (() => {
      const cmd = adapter.authSetupCmd?.({ token: t });
      return cmd ? { required: true, command: cmd, file: adapter.authFile || null } : null;
    })(),
  };
}

// SCRUB an env VALUE so it can never inject a line into /etc/environment (finding [9]): a newline
// (or lone CR) in a label or token would split one KEY=value into several lines, letting a pasted
// label re-write the cage's env. Both the spawn door (openCxellSsh) and the injection rewrite call
// this — strip, never emit.
export function scrubEnvValue(value) {
  return String(value ?? '').replace(/[\r\n]+/g, '');
}

// ── SCRUB SECRETS OUT OF FREE TEXT ──────────────────────────────────────────────────────────────
// A vendor error can ECHO THE KEY back ("your api key: sk-ant-oat01-… is invalid"), and that text
// lands in zee.last_stop_reason (broadcast to the console), a session_event, a credential-inject
// card and a tend. This masks every token shape the PROVIDERS registry can NAME before the text is
// first stored — the same intent as the codex authSetupCmd's `sed -E "s/sk-[A-Za-z0-9_-]{6,}/sk-…/g"`,
// generalised to the registry so a new vendor's key format is covered when it is added here.
// Registry-driven: every provider's declared `signature` prefix is included verbatim, plus the
// non-signed but dispatchable shapes (claude sk-ant-…, openai/deepseek sk-…, kimi kc-…). Masks with
// a single `sk-…`/`kc-…`/`gh…` token so nothing secret survives.
export function scrubSecrets(text) {
  // Every provider's declared `signature` prefix (with its ^ anchor dropped so it matches
  // mid-text, where a vendor error actually echoes the key), plus the non-signed dispatchable
  // shapes: openai/deepseek sk-… and kimi kc-…. The trailing [A-Za-z0-9_-]* consumes the whole
  // key tail, so no token-shaped substring survives.
  const signatures = Object.values(PROVIDERS)
    .filter((p) => p.signature)
    .map((p) => p.signature.source.replace(/^\^/, ''));
  const re = new RegExp(`(?:${[...signatures, 'sk-[A-Za-z0-9_-]{6,}', 'kc-[A-Za-z0-9_-]{6,}'].join('|')})[A-Za-z0-9_-]*`, 'g');
  return String(text ?? '').replace(re, (m) => {
    if (m.startsWith('github_pat_')) return 'github_pat_…';
    if (m.startsWith('gh')) return 'gh…';                 // gho_/ghp_/ghu_/ghs_
    if (m.startsWith('kc-')) return 'kc-…';               // kimi CODING key
    return 'sk-…';
  });
}

// ── THE GRANT LEDGER: WHICH ACCOUNT A CAGE WAS GIVEN (finding [1], second attempt) ─────────────
// The runnable-provider-env door is gated on a cage being able to prove it ALREADY HOLDS a key. A
// masked hint cannot prove that — it is public in the read model — so the proof is a SERVER-SIDE
// LEDGER: xell_provider_grant records WHICH provider_token account each xell was granted, per
// provider, written at BOTH doors that put a key in a cage (spawn + injection). providerRunEnv
// answers FROM THAT RECORD and FAILS CLOSED: the recorded account still connected and active →
// return ITS env (the cage already holds that key, nothing new is disclosed); rotated away / deleted
// / paused / its key replaced in place → REFUSE naming the credential-inject card; NO record → REFUSE,
// same sentence. What the door guarantees, in one sentence: a cage may only ever obtain the runnable
// env for the exact account it was granted — never the project's current key after a rotation.
export async function recordXellProviderGrant({ xellId, provider, providerTokenId, accountCreatedAt = null, grantedBy = 'spawn' } = {}) {
  if (!xellId || !provider || !providerTokenId) return;
  try {
    await q(
      `INSERT INTO xell_provider_grant (xell_id, provider, provider_token_id, account_created_at, granted_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (xell_id, provider) DO UPDATE
         SET provider_token_id = EXCLUDED.provider_token_id,
             account_created_at = EXCLUDED.account_created_at,
             granted_at = now(),
             granted_by = EXCLUDED.granted_by`,
      [xellId, provider, providerTokenId,
       accountCreatedAt || (await one(`SELECT created_at FROM provider_token WHERE id=$1`, [providerTokenId]).catch(() => null))?.created_at || new Date(),
       grantedBy]);
  } catch (e) {
    logline('credential', `could not record the ${provider} grant for xell ${String(xellId).slice(0, 8)} (${String(e.message).slice(0, 120)})`);
  }
}

// THE DOOR — compute the runnable env for a provider THIS CAGE WAS GRANTED. Fails closed (a refusal
// is `{ ok:false, status:'refused', error }`, never a throw): no record, a deleted/paused account,
// or an account whose key was replaced in place all refuse with the injection sentence. `xellId` is
// required — without the caller's identity there is nothing to answer from.
export async function providerRunEnv(projectId, provider, { model = null, xellId = null } = {}) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider "${provider}" — known: ${Object.values(PROVIDERS).filter((x) => x.dispatch).map((x) => x.key).join(', ')}`);
  if (!xellId) {
    return { ok: false, status: 'refused', error: 'this request does not identify a cage — the runnable env is granted per xell, and a cage with no grant record cannot pull it' };
  }
  const grant = await one(
    `SELECT * FROM xell_provider_grant WHERE xell_id=$1 AND provider=$2`, [xellId, provider]);
  const refuse = (detail) => ({ ok: false, status: 'refused', error:
    `this cage cannot pull the ${provider} runnable env — ${detail} a human must approve a credential injection (the console's credential-inject card) before this cage can run that provider's CLI` });
  if (!grant) {
    return refuse('it has no record of being granted a ' + provider + ' account (every cage spawned before this feature landed reads this way).');
  }
  const acct = await one(
    `SELECT id, label, token, token_hint, paused_at, created_at FROM provider_token
      WHERE id=$1 AND project_id=$2`, [grant.provider_token_id, projectId]);
  if (!acct || acct.paused_at) {
    return refuse(`the ${provider} account it was granted has been rotated away, deleted or paused.`);
  }
  // setProviderToken bumps created_at on an in-place replace — a grant whose stored created_at
  // differs means the key was replaced UNDER this cage: it holds the OLD key, and the door must not
  // hand out the new one.
  if (new Date(acct.created_at).getTime() !== new Date(grant.account_created_at).getTime()) {
    return refuse(`the ${provider} account it was granted has had its key replaced in place.`);
  }
  return { ok: true, ...providerRunEnvFromAccount({
    provider, token: acct.token, label: acct.label, hint: acct.token_hint, model,
  }) };
}

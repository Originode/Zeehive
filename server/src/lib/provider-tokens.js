// Per-project AI-provider ACCOUNTS (spec: cxell zees) — the meta-DB is the credential store.
// Since 036 a project can hold SEVERAL accounts of one provider type (two Claude subscriptions,
// say): each is its own row with its own label and its own prompt button in the console. The
// full token leaves this module through ONE door: tokenForSpawn(), used when the queenzee
// injects it into a zee-agent container's environment. Everything the console sees is masked.
import { q, one } from '../db/pool.js';

// provider TYPE registry — how to obtain a token of each type and what a valid one looks like.
// UI copy lives here too so the console renders new provider types without a client change.
export const PROVIDERS = {
  claude: {
    key: 'claude',
    label: 'Claude',
    dispatch: true,   // a zee can run on this provider today
    command: 'claude setup-token',
    steps: 'Run the command in any terminal. Your browser opens — authorize, and the CLI prints a long-lived token (sk-ant-oat01-…). Paste it below; it is stored only in the meta-DB.',
    // sk-ant-oat01-<base64ish>; stay loose on the tail so a format tweak upstream doesn't lock us out
    valid: (t) => /^sk-ant-[a-z0-9]+-[A-Za-z0-9_-]{20,}$/.test(t),
  },
  // The GPT runtime is the literal ChatGPT Codex CLI (`codex exec` inside the cxell,
  // OPENAI_API_KEY auth — runtime 'codex-cxell'). sk-ant-… is explicitly rejected so a Claude
  // token pasted in the wrong slot fails loudly instead of sitting dormant.
  openai: {
    key: 'openai',
    label: 'ChatGPT Codex',
    dispatch: true,   // codex-cxell runtime (lib/cxell-runtimes.js)
    command: 'https://platform.openai.com/api-keys',
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
    steps: 'Create an API key on the DeepSeek platform (sk-…) and paste it below; it is stored only in the meta-DB. Dispatched zees run the claude CLI against DeepSeek’s Anthropic-compatible endpoint.',
    // sk-<alnum tail>; sk-ant-… is explicitly rejected so a Claude token in the wrong slot fails loudly
    valid: (t) => /^sk-[A-Za-z0-9]{20,}$/.test(t) && !/^sk-ant-/.test(t),
  },
  // GitHub is INBOUND-ONLY (migration 032): this token is used exclusively by clone/pull fetches
  // in lib/remote-git.js — nothing in Zeehive can push, so a Contents:Read-only PAT is all it
  // should ever be granted.
  github: {
    key: 'github',
    label: 'GitHub (pulls only)',
    command: 'GitHub → Settings → Developer settings → Fine-grained tokens',
    steps: 'Create a fine-grained personal access token scoped to this repo with Contents: READ-ONLY. Zeehive only ever fetches — it cannot and will not push. Paste it below; it is stored only in the meta-DB.',
    // classic ghp_…, fine-grained github_pat_…, or an OAuth/device token gho_/ghu_/ghs_ (what
    // `gh auth token` and git-credential-manager hold — a proven-working fallback when an org's
    // fine-grained-PAT policy fights the human); loose tails for the same reason as above
    valid: (t) => /^(gh[opus]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})$/.test(t),
  },
};

const hint = (t) => `${t.slice(0, 13)}…${t.slice(-4)}`;

// masked read model: every provider TYPE, each with its list of connected ACCOUNTS — never the
// token itself. The legacy per-type fields (connected/token_hint/…) mirror the FIRST account so
// older consumers keep working; new consumers read `accounts`.
export async function listProviderTokens(projectId) {
  const rows = await q(
    `SELECT id, provider, label, token_hint, created_at, last_used_at
       FROM provider_token WHERE project_id = $1 ORDER BY created_at`, [projectId]);
  return Object.values(PROVIDERS).map((p) => {
    const accounts = rows.filter((r) => r.provider === p.key)
      .map(({ id, label, token_hint, created_at, last_used_at }) => ({ id, label, token_hint, created_at, last_used_at }));
    return {
      provider: p.key, label: p.label, command: p.command, steps: p.steps,
      dispatch: !!p.dispatch,   // can a zee run on it? (github: no — infra credential)
      connected: accounts.length > 0,
      accounts,
      token_hint: accounts[0]?.token_hint || null,
      created_at: accounts[0]?.created_at || null,
      last_used_at: accounts[0]?.last_used_at || null,
    };
  });
}

function validate(provider, token) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider "${provider}"`);
  const t = String(token || '').trim();
  if (!t) throw new Error('token is empty');
  if (!p.valid(t)) throw new Error(`that does not look like a ${p.label} token — see the steps for what to paste`);
  return { p, t };
}

// ADD an account of this type (multiple per type allowed — that is the point since 036).
export async function addProviderToken(projectId, provider, token, label = null) {
  const { t } = validate(provider, token);
  const row = await one(
    `INSERT INTO provider_token (project_id, provider, token, token_hint, label)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [projectId, provider, t, hint(t), String(label || '').trim() || null]);
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
      [rows[0].id, t, hint(t)]);
  } else {
    await q(`INSERT INTO provider_token (project_id, provider, token, token_hint) VALUES ($1,$2,$3,$4)`,
      [projectId, provider, t, hint(t)]);
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
  const row = tokenId
    ? await one(
        // the id is authoritative but must MATCH the claimed type — a button can't smuggle a
        // github PAT into a zee spawn by pairing its id with provider=claude
        `UPDATE provider_token SET last_used_at = now()
          WHERE project_id = $1 AND id = $2 AND provider = $3 RETURNING id, label, token`,
        [projectId, tokenId, provider])
    : await one(
        `UPDATE provider_token SET last_used_at = now()
          WHERE id = (SELECT id FROM provider_token WHERE project_id = $1 AND provider = $2
                       ORDER BY created_at DESC LIMIT 1) RETURNING id, label, token`,
        [projectId, provider]);
  if (!row) {
    throw new Error(tokenId
      ? `that ${provider} account is no longer connected — it may have been removed; reopen the composer`
      : `project has no ${provider} token — connect one in Project setup`);
  }
  return row;
}

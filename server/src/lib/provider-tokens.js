// Per-project AI-provider tokens (spec: cxell zees) — the meta-DB is the credential store.
// The full token leaves this module through ONE door: tokenForSpawn(), used when the queenzee
// injects it into a zee-agent container's environment. Everything the console sees is masked.
import { q, one } from '../db/pool.js';

// provider registry — how to obtain a token and what a valid one looks like. UI copy lives
// here too so the console renders new providers without a client change.
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
  // The GPT runtime will be the literal ChatGPT Codex CLI (OPENAI_API_KEY auth) — this slot
  // holds its key, inert until that runtime lands. sk-ant-… is explicitly rejected so a Claude
  // token pasted in the wrong slot fails loudly instead of sitting dormant.
  openai: {
    key: 'openai',
    label: 'ChatGPT Codex',
    command: 'https://platform.openai.com/api-keys',
    steps: 'Create an API key on the OpenAI platform (sk-… or sk-proj-…) and paste it below; it is stored only in the meta-DB. Dispatch activates when the Codex CLI runtime lands.',
    valid: (t) => /^sk-[A-Za-z0-9_-]{20,}$/.test(t) && !/^sk-ant-/.test(t),
  },
  // Mark's ruling (2026-07-20): NOT Kimi-via-claude-CLI shims — the Kimi runtime will be the
  // literal Kimi Code CLI, whose dedicated CODING key comes from kimi.com/code/console (a
  // different credential than a Moonshot Open Platform key). Inert until that runtime lands.
  kimi: {
    key: 'kimi',
    label: 'Kimi Code',
    command: 'https://kimi.com/code/console',
    steps: 'Create a dedicated CODING key in the Kimi Code console (not a Moonshot platform key) and paste it below; it is stored only in the meta-DB. Dispatch activates when the Kimi Code CLI runtime lands.',
    valid: (t) => /^[A-Za-z0-9_-]{20,}$/.test(t) && !/^sk-ant-/.test(t),
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

// masked read model: which providers exist, which are connected — never the token itself
export async function listProviderTokens(projectId) {
  const rows = await q(
    `SELECT provider, token_hint, created_at, last_used_at
       FROM provider_token WHERE project_id = $1`, [projectId]);
  const byProvider = Object.fromEntries(rows.map((r) => [r.provider, r]));
  return Object.values(PROVIDERS).map((p) => ({
    provider: p.key, label: p.label, command: p.command, steps: p.steps,
    dispatch: !!p.dispatch,   // can a zee run on it? (github: no — infra credential)
    connected: !!byProvider[p.key],
    token_hint: byProvider[p.key]?.token_hint || null,
    created_at: byProvider[p.key]?.created_at || null,
    last_used_at: byProvider[p.key]?.last_used_at || null,
  }));
}

export async function setProviderToken(projectId, provider, token) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider "${provider}"`);
  const t = String(token || '').trim();
  if (!t) throw new Error('token is empty');
  if (!p.valid(t)) throw new Error(`that does not look like a ${p.label} token (expected sk-ant-…)`);
  await q(
    `INSERT INTO provider_token (project_id, provider, token, token_hint)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, provider)
     DO UPDATE SET token = $3, token_hint = $4, created_at = now(), last_used_at = NULL`,
    [projectId, provider, t, hint(t)]);
  return (await listProviderTokens(projectId)).find((r) => r.provider === provider);
}

export async function deleteProviderToken(projectId, provider) {
  await q('DELETE FROM provider_token WHERE project_id = $1 AND provider = $2', [projectId, provider]);
  return { ok: true };
}

// What a cxell spawn needs for a given AI provider: the token plus (for anthropic-compatible
// vendors like Kimi) the base URL the claude CLI should aim at. Refuses non-dispatchable
// providers up front — an OpenAI key has no runtime yet and must fail the dispatch cleanly.
export async function spawnCreds(projectId, provider = 'claude') {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider "${provider}"`);
  if (!p.dispatch) throw new Error(`no zee runtime for ${p.label} yet — dispatch on Claude or Kimi`);
  return { provider, token: await tokenForSpawn(projectId, provider), baseUrl: p.anthropicBaseUrl || null };
}

// the one full-token read — the spawn path injecting into a cxell zee's environment
export async function tokenForSpawn(projectId, provider = 'claude') {
  const row = await one(
    `UPDATE provider_token SET last_used_at = now()
      WHERE project_id = $1 AND provider = $2 RETURNING token`, [projectId, provider]);
  if (!row) throw new Error(`project has no ${provider} token — connect one in Project setup`);
  return row.token;
}

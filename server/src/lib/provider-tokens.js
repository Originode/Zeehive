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
    command: 'claude setup-token',
    steps: 'Run the command in any terminal. Your browser opens — authorize, and the CLI prints a long-lived token (sk-ant-oat01-…). Paste it below; it is stored only in the meta-DB.',
    // sk-ant-oat01-<base64ish>; stay loose on the tail so a format tweak upstream doesn't lock us out
    valid: (t) => /^sk-ant-[a-z0-9]+-[A-Za-z0-9_-]{20,}$/.test(t),
  },
  // Stored for the coming multi-provider dispatch — no zee runtime consumes it yet, so
  // connecting it is inert until an OpenAI-backed runtime lands. sk-ant-… is explicitly
  // rejected so a Claude token pasted in the wrong slot fails loudly instead of sitting dormant.
  openai: {
    key: 'openai',
    label: 'OpenAI (ChatGPT)',
    command: 'https://platform.openai.com/api-keys',
    steps: 'Create an API key on the OpenAI platform (sk-… or sk-proj-…) and paste it below; it is stored only in the meta-DB. No zee runtime uses it yet — this slot is for the coming multi-provider dispatch.',
    valid: (t) => /^sk-[A-Za-z0-9_-]{20,}$/.test(t) && !/^sk-ant-/.test(t),
  },
  // Same story as openai: stored for the coming multi-provider dispatch, inert until a
  // Kimi-backed runtime lands. Moonshot keys are OpenAI-shaped (sk-…), so only the sk-ant-
  // mispaste is detectable — the slots themselves keep the keys apart.
  kimi: {
    key: 'kimi',
    label: 'Kimi (Moonshot)',
    command: 'https://platform.moonshot.ai/console/api-keys',
    steps: 'Create an API key on the Moonshot platform (sk-…) and paste it below; it is stored only in the meta-DB. No zee runtime uses it yet — this slot is for the coming multi-provider dispatch.',
    valid: (t) => /^sk-[A-Za-z0-9_-]{20,}$/.test(t) && !/^sk-ant-/.test(t),
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

// the one full-token read — the spawn path injecting into a cxell zee's environment
export async function tokenForSpawn(projectId, provider = 'claude') {
  const row = await one(
    `UPDATE provider_token SET last_used_at = now()
      WHERE project_id = $1 AND provider = $2 RETURNING token`, [projectId, provider]);
  if (!row) throw new Error(`project has no ${provider} token — connect one in Project setup`);
  return row.token;
}

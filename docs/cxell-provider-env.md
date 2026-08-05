# What a cxell carries: every connected provider's credential, and how a zee reads it

A caged zee's workspace carries more than the one credential its dispatch was born with. When the
queenzee spawns a cxell on ANY provider, it injects:

1. **the active runtime's vendor env, byte-identical to before** — `adapter.env({token})` for the
   provider actually dispatched (e.g. `ANTHROPIC_AUTH_TOKEN` for a claude or deepseek cage). This is
   what authenticates the CLI, and it is unchanged.
2. **every connected DISPATCHABLE provider's freshest ACTIVE account**, each under its own
   non-colliding namespaced env var — so a zee whose task needs a different vendor's CLI can reach it
   without asking a human to re-dispatch or copy a key by hand.

## The namespaced env contract

For each dispatchable provider with a connected, non-paused account, the cage gets:

```
ZEE_PROVIDERS                  = claude,deepseek        # which providers are present (registry order)
ZEE_PROVIDER_CLAUDE_TOKEN      = sk-ant-…               # the full token
ZEE_PROVIDER_CLAUDE_LABEL      = "my work account"      # the account label (or the provider label)
ZEE_PROVIDER_CLAUDE_HINT       = sk-ant-oat01-…CAAA     # the masked hint, as the console shows it
```

`KEY` is the provider key uppercased (`claude` → `CLAUDE`, `openai` → `OPENAI`, `kimi` → `KIMI`,
`deepseek` → `DEEPSEEK`).

## Why namespaced, not a merge of `adapter.env()`

The naive spelling — merge every adapter's env into one object — is exactly the mix-up that killed ten
zees. The claude and deepseek adapters BOTH set `ANTHROPIC_AUTH_TOKEN`, and a DeepSeek cage whose
`ANTHROPIC_AUTH_TOKEN` is really a claude OAuth token dies on `"your api key: ****CAAA is invalid"`
with the vendor blaming a healthy claude account. So each provider's key lives under its OWN name, and
the only place a token is ever injected under a provider's name is the one it was connected as.

## What is never in the set

- **paused accounts** — only the freshest ACTIVE (non-paused) account per provider;
- **github** — `dispatch:false`: the GitHub PAT is an infra credential that drives clone/pull, and it
  must never reach a vendor CLI;
- **a mis-attributed token** — one that `credentialVendorMismatch` can NAME as another vendor's is
  skipped (and logged by the spawn), never injected under the wrong provider's name. The guard is the
  same one the active vendor's env goes through — a cage carrying every key makes it MORE
  load-bearing, not less.

## Reading the set

`zee creds` prints what the cage holds (provider, account label, masked hint). `zee creds --provider
claude` prints the namespaced env for one provider, source-able (`ZEE_PROVIDER_CLAUDE_TOKEN=…`).
`zee creds --json` prints the list as JSON. The vars land in BOTH `/etc/environment` (an attending
human's SSH login) and the headless exec env, so a zee finds them either way.

## How to actually RUN another vendor's CLI

The namespaced token is what a cage HOLDS; it is not what a vendor CLI READS. To switch to a provider
your cage holds a key for and run its CLI, use `--export` — the runnable vendor env is SERVER-computed
through the same runtime adapter the spawn uses, so the mapping is never duplicated in the CLI:

```
eval "$(zee creds --provider kimi --export)"    # KIMI_MODEL_API_KEY/_NAME/_PROVIDER_TYPE/_BASE_URL
kimi                                             # …now runs against the kimi coding endpoint

eval "$(zee creds --provider deepseek --export)" # ANTHROPIC_AUTH_TOKEN/_BASE_URL/_MODEL
claude -p "…"                                    # the claude CLI aimed at DeepSeek's Anthropic-compatible endpoint

eval "$(zee creds --provider claude --export)"   # ANTHROPIC_AUTH_TOKEN (+ CLAUDE_CODE_OAUTH_TOKEN)
claude -p "…"

eval "$(zee creds --provider grok --export)"     # XAI_API_KEY
grok -p "…"                                      # xAI's own CLI (Grok Build)
```

`--export` prints source-able `KEY=value` lines and NOTHING else on stdout (so `eval` is safe) —
every value is shell-quoted, so source-ability is structural rather than luck; human-readable notes —
including any in-cage install the vendor needs — go to stderr. It is a read-only, token-scoped API
call (`GET /api/xell/self/provider-env?provider=<key>`), authorized by the xell's own identity token.

**It is GATED on a SERVER-SIDE GRANT LEDGER, not on anything the cage says.** The
`xell_provider_grant` table records WHICH provider_token account each xell was granted, per provider,
written at BOTH doors that put a key in a cage — the spawn (`spawnCxell`) and the credential-injection
performer. The endpoint answers **only for the exact account this cage was granted**:
the recorded account still connected and active → return ITS env (the cage already holds that key,
nothing new is disclosed); rotated away / deleted / paused / its key replaced in place → a REFUSED
answer (`ok:false, status:'refused'`) naming the credential-inject card; NO record at all (every cage
spawned before this landed) → REFUSE, fail-closed. What the door guarantees, in one sentence: a cage
may only ever obtain the runnable env for the exact account it was granted — never the project's
current key after a rotation.

**codex is the one exception — its env alone sends no Authorization header.** The export prints
`OPENAI_API_KEY`, and the note names the exact one-liner to run ONCE in the cage (idempotent, prints
`AUTH_OK`):

```
eval "$(zee creds --provider openai --export)"
printenv OPENAI_API_KEY | codex login --with-api-key    # writes ~/.codex/auth.json — then `codex exec` sends the key
```

An unknown/absent provider fails with a sentence naming what the cage does hold (read `ZEE_PROVIDERS`),
and a token that is unmistakably another vendor's is refused with the same named sentence the spawn
guard uses — the CLI never decides either.

## Where it is injected

`server/src/lib/provider-tokens.js` `everyProviderEnv` (the pure builder) + `allProviderTokenRows`
(the read), wired into `server/src/queenzee/intake.js` `spawnCxell` — both `openCxellSsh`
(/etc/environment) and `runZee` (exec env). The nudge path (`nudgeCxellZee`) reads its resume token
by provider from `ZEE_PROVIDER_<KEY>_TOKEN` first, so a resumed cage's token is attributable — the
old fallback `adapter.tokenEnvKey` is what claude and deepseek SHARE, and a token read back under it
cannot be named.

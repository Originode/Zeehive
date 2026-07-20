// Runtime ADAPTERS for the cxell driver — the one place that knows each vendor CLI's dialect.
// Everything else (cxell.js, intake.js, nudge.js) speaks one contract: an adapter says how to
// RUN the vendor's own coding agent headless inside the zee-agent container, which env carries
// its credential, and how to translate its output stream into the claude-shaped events the SSE
// feed already understands. Mark's ruling (2026-07-20): vendor-NATIVE CLIs only — the OpenAI
// runtime is the literal `codex` CLI and the Kimi runtime the literal Kimi Code CLI, never the
// claude CLI re-aimed at a compat base URL, never a hand-rolled loop on a raw API.
//
// The event contract (what intake's feed() consumes — the claude stream-json shape):
//   { type:'system', subtype:'init', session_id }        — once, when the agent is up
//   { type:'assistant', message:{ content:[ {type:'text',text} | {type:'tool_use',name,input} ] } }
//   { type:'result', is_error, result, total_cost_usd?, usage? }  — once, at end of turn
// A vendor adapter maps what it can and degrades gracefully: unrecognized output becomes text
// events, and a run that dies before its own final event gets a SYNTHESIZED error result on
// close — so a bad API key surfaces on the zee feed as a readable error, never a hang.
//
// Adapter surface:
//   execCmd({model, resumeSid})  → the in-cxell shell command (runs under `cd /work/repo && …`)
//   env({token, baseUrl, model}) → credential env the CLI needs (docker-exec -e AND /etc/environment)
//   tokenEnvKey                  → which of those vars the nudge path reads back as "the token"
//   stdinPayload(prompt)         → what to write on stdin (default: the prompt verbatim)
//   makeParser(emit)             → { line(l), close(code, errTail) } translating output → events
//   resumable / needsSid         → can a finished session be re-invoked, and does that need an id

// The dispatch model picker offers claude aliases; they mean nothing to other vendors' CLIs,
// so non-claude adapters drop them and run the vendor's own default model.
const CLAUDE_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku']);
const vendorModel = (model) => (model && !CLAUDE_MODEL_ALIASES.has(model) ? model : null);

// sanitize anything interpolated into the in-cxell bash command line
const safeSid = (sid) => String(sid || '').replace(/[^0-9a-zA-Z_-]/g, '');
const safeModel = (m) => String(m || '').replace(/[^0-9a-zA-Z_./:-]/g, '');

const text = (t) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const toolUse = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input: input || {} }] } });
const initEv = (sid) => ({ type: 'system', subtype: 'init', session_id: sid || null });

const ADAPTERS = {
  // ── Claude Code — the reference dialect; its stream IS the normalized shape ─────────────
  'claude-code-cxell': {
    key: 'claude-code-cxell',
    provider: 'claude',
    bin: 'claude',
    // --bare: nothing host-side (plugins/MCP/hooks/skills) leaks into the cxell, and auth comes
    // from the injected token alone. --dangerously-skip-permissions is safe HERE and only here —
    // the cxell is the permission system, and the CLI requires non-root, which the image guarantees.
    execCmd: ({ model, resumeSid } = {}) =>
      'claude --bare -p --output-format stream-json --verbose --dangerously-skip-permissions'
      + (safeSid(resumeSid) ? ` --resume ${safeSid(resumeSid)}` : '')
      + (safeModel(model) ? ` --model ${safeModel(model)}` : ''),
    // BOTH names, measured on claude 2.1.214 (2026-07-19): --bare skips the OAuth credential chain
    // (CLAUDE_CODE_OAUTH_TOKEN alone yields "Not logged in") but honors ANTHROPIC_AUTH_TOKEN (the
    // raw bearer header, which an sk-ant-oat01 token is). Keep the OAuth var for future CLIs.
    env: ({ token, baseUrl } = {}) => ({
      CLAUDE_CODE_OAUTH_TOKEN: token,
      ANTHROPIC_AUTH_TOKEN: token,
      ...(baseUrl ? { ANTHROPIC_BASE_URL: baseUrl } : {}),
    }),
    tokenEnvKey: 'ANTHROPIC_AUTH_TOKEN',
    // stream-json is already the contract — parse and pass through
    makeParser: (emit) => ({
      line(l) {
        let ev;
        try { ev = JSON.parse(l); } catch { return; } // non-JSON noise (e.g. a bash warning)
        emit(ev);
      },
      close() {}, // claude prints its own result event; a run without one stays an error (as today)
    }),
    resumable: true,
    needsSid: true, // claude --resume <sid>
  },

  // ── ChatGPT Codex — the literal `codex` CLI (@openai/codex), `codex exec --json` ────────
  // Flags per the 0.14x CLI: --json is the JSONL event stream; --dangerously-bypass-approvals-
  // and-sandbox is the documented mode for an externally-hardened environment (the cxell IS
  // that — and codex's own Landlock sandbox cannot initialize in an unprivileged container
  // anyway); --skip-git-repo-check because /work/repo is a bundle clone codex didn't make.
  // The prompt rides on stdin (the literal `-` arg), so no model text is shell-interpolated.
  'codex-cxell': {
    key: 'codex-cxell',
    provider: 'openai',
    bin: 'codex',
    execCmd: ({ model, resumeSid } = {}) =>
      `codex exec${safeSid(resumeSid) ? ` resume ${safeSid(resumeSid)}` : ''}`
      + ' --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check'
      + (safeModel(vendorModel(model)) ? ` --model ${safeModel(vendorModel(model))}` : '')
      + ' -',
    env: ({ token } = {}) => ({ OPENAI_API_KEY: token }),
    tokenEnvKey: 'OPENAI_API_KEY',
    // codex exec --json events → normalized. thread.started carries the resumable session id;
    // the final answer is the agent_message item; turn.completed carries usage. No text deltas
    // in --json mode — items arrive whole, which is fine for the feed's narration.
    makeParser: (emit) => {
      let lastText = '', errNote = '', done = false;
      return {
        line(l) {
          let ev;
          try { ev = JSON.parse(l); } catch { return; }
          if (ev.type === 'thread.started') emit(initEv(ev.thread_id));
          else if (ev.type === 'item.started' && ev.item?.type === 'command_execution') {
            emit(toolUse('shell', { command: ev.item.command }));
          } else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) {
            lastText = ev.item.text;
            emit(text(ev.item.text));
          } else if (ev.type === 'turn.completed') {
            done = true;
            const u = ev.usage || {};
            emit({ type: 'result', is_error: false, result: lastText,
                   usage: { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0,
                            cache_read_input_tokens: u.cached_input_tokens || 0 } });
          } else if (ev.type === 'turn.failed' || ev.type === 'error') {
            errNote = ev.error?.message || ev.message || JSON.stringify(ev).slice(0, 300);
            if (ev.type === 'turn.failed') { done = true; emit({ type: 'result', is_error: true, result: errNote }); }
          }
        },
        // a run that died before its own turn event (bad key → 401 on stderr, non-zero exit)
        // still ends in a readable result on the feed
        close(code, errTail) {
          if (done) return;
          emit({ type: 'result', is_error: true,
                 result: errNote || errTail || lastText || `codex exited ${code} with no output` });
        },
      };
    },
    resumable: true,
    needsSid: true, // codex exec resume <thread_id>
  },

  // ── Kimi Code — the literal `kimi` CLI (@moonshot-ai/kimi-code), prompt mode ────────────
  // Headless (measured on 0.28.1, the pinned version): `-p <prompt> --output-format stream-json`.
  // -p takes the prompt as an ARGUMENT, so the prompt rides in on stdin and `"$(cat)"` splices
  // it in-container — model text still never touches the queenzee-side command line. Prompt mode
  // runs tool calls under the auto policy (no approval prompts by design; -p is documented as
  // mutually exclusive with --yolo/--auto). Output lines are OpenAI-chat-shaped messages with no
  // final "result" event, so the parser synthesizes one from the exit code + last assistant text
  // (measured: a bad key prints `error: failed to run prompt: provider.auth_error: 401 …` on
  // stderr and exits 1 — that line becomes the synthesized error result).
  // Credentials: the CLI reads NO plain shell vars — the KIMI_MODEL_* family is the documented
  // env-only way to define a provider without a config.toml. The coding-subscription key from
  // kimi.com/code/console pairs with the managed coding endpoint, type 'kimi'.
  'kimi-code-cxell': {
    key: 'kimi-code-cxell',
    provider: 'kimi',
    bin: 'kimi',
    execCmd: ({ resumeSid } = {}) =>
      // resume = -c/--continue: kimi resumes the most recent session for this workdir
      // (/work/repo); its session ids never reach us headless, and one cxell only ever holds
      // one zee, so "most recent here" IS the session.
      `kimi${resumeSid !== undefined && resumeSid !== null ? ' -c' : ''}`
      + ' -p "$(cat)" --output-format stream-json',
    env: ({ token, model } = {}) => ({
      KIMI_MODEL_API_KEY: token,
      KIMI_MODEL_NAME: safeModel(vendorModel(model)) || process.env.KIMI_DEFAULT_MODEL || 'k3',
      KIMI_MODEL_PROVIDER_TYPE: 'kimi',
      KIMI_MODEL_BASE_URL: process.env.KIMI_CODE_BASE_URL || 'https://api.kimi.com/coding/v1',
      KIMI_DISABLE_TELEMETRY: '1',
    }),
    tokenEnvKey: 'KIMI_MODEL_API_KEY',
    makeParser: (emit) => {
      let sawAny = false, lastText = '';
      return {
        line(l) {
          if (!sawAny) { sawAny = true; emit(initEv(null)); } // first output = the agent is alive
          let msg;
          try { msg = JSON.parse(l); } catch { emit(text(l)); return; } // degrade: raw line as text
          if (msg?.role !== 'assistant') return; // tool-result echoes aren't narrated (claude parity)
          const blocks = [];
          if (typeof msg.content === 'string' && msg.content.trim()) {
            lastText = msg.content;
            blocks.push({ type: 'text', text: msg.content });
          }
          for (const tc of msg.tool_calls || []) {
            let input;
            try { input = JSON.parse(tc?.function?.arguments || '{}'); } catch { input = { raw: tc?.function?.arguments }; }
            blocks.push({ type: 'tool_use', name: tc?.function?.name || 'tool', input });
          }
          if (blocks.length) emit({ type: 'assistant', message: { content: blocks } });
        },
        close(code, errTail) {
          emit(code === 0
            ? { type: 'result', is_error: false, result: lastText || 'done' }
            : { type: 'result', is_error: true,
                result: errTail || lastText || `kimi exited ${code} with no output` });
        },
      };
    },
    resumable: true,
    needsSid: false, // --continue keys off the workdir, not an id
  },
};

export function adapterFor(runtimeKey) {
  const a = ADAPTERS[runtimeKey || 'claude-code-cxell'];
  if (!a) throw new Error(`no cxell runtime adapter for "${runtimeKey}" — known: ${Object.keys(ADAPTERS).join(', ')}`);
  return a;
}
export const CLAUDE_ADAPTER = ADAPTERS['claude-code-cxell'];

// Which cxell runtime a dispatch provider runs on. Claude resolves through the pool default /
// runtime toggle as before; the other vendors have exactly one runtime — their own CLI.
const PROVIDER_RUNTIME = { openai: 'codex-cxell', kimi: 'kimi-code-cxell' };
export const runtimeKeyForProvider = (provider) => PROVIDER_RUNTIME[provider] || null;

// The "+" composer's model picker, per vendor (claude's aliases stay in intake.js — they also
// serve the non-cxell SDK runtimes). key '' = "send no model": the dispatch omits it, vendorModel()
// drops the claude-alias default, and the vendor CLI runs ITS own default — the one entry that can
// never 400 on a stale id. Named entries are real vendor ids a human can pin.
const VENDOR_MODELS = {
  // ids per the models doc (2026-07): the gpt-5.6 tier (sol/terra/luna) is current; the dedicated
  // -codex line ended at 5.3. Default stays '' — the CLI's routing picks its recommended model,
  // which tracks upstream changes and can't 400 on an account without 5.6 access.
  openai: [
    { key: '', label: 'Codex default', note: "the codex CLI's own recommended model", default: true },
    { key: 'gpt-5.6-sol',   label: 'GPT-5.6 Sol',   note: 'flagship — complex, long-horizon work' },
    { key: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', note: 'balanced everyday workhorse' },
    { key: 'gpt-5.6-luna',  label: 'GPT-5.6 Luna',  note: 'fast and affordable' },
    { key: 'gpt-5.4-mini',  label: 'GPT-5.4 mini',  note: 'cheapest — light edits and quick tasks' },
  ],
  // the coding endpoint takes EXACTLY these ids (docs warn "Kimi K3"-style names fail);
  // '' resolves to KIMI_DEFAULT_MODEL || k3 in the adapter env
  kimi: [
    { key: '', label: 'Kimi default', note: `runs ${process.env.KIMI_DEFAULT_MODEL || 'k3'} (override: KIMI_DEFAULT_MODEL)`, default: true },
    { key: 'k3',                        label: 'K3',              note: 'flagship' },
    { key: 'kimi-for-coding',           label: 'K2.7 Code',       note: 'standard coding model' },
    { key: 'kimi-for-coding-highspeed', label: 'K2.7 high-speed', note: 'same model, faster serving' },
  ],
};
export const providerModels = (provider) => VENDOR_MODELS[provider] || null;

// pgrep -f pattern for "is ANY known agent CLI alive in this cxell" — headless run or a human's
// interactive session over SSH alike (see cxellZeeActive). Word-ish boundaries keep it from
// matching substrings of unrelated cmdlines.
export const AGENT_PROC_PATTERN = `(^|/| )(${[...new Set(Object.values(ADAPTERS).map((a) => a.bin))].join('|')})( |$)`;

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
//   authSetupCmd()               → OPTIONAL. An in-cxell command that INSTALLS the credential for a
//                                  CLI that does not read it from the environment (see below); null
//                                  / absent means env() alone authenticates the CLI.
//   stdinPayload(prompt)         → what to write on stdin (default: the prompt verbatim)
//   makeParser(emit)             → { line(l), close(code, errTail) } translating output → events
//   resumable / needsSid         → can a finished session be re-invoked, and does that need an id
//
// ── WHY authSetupCmd EXISTS: "the environment is enough" is a per-vendor FACT, not a rule ─────────
// Every credential here rides in as env (docker exec -e for the headless run, /etc/environment for
// an attending human's shell) because that is how a cxell is kept provider-agnostic: nothing about
// a vendor is baked into the image or into the xell, and whichever provider a dispatch picks is the
// one whose credential the cage gets. For claude, kimi and deepseek that env IS the login —
// measured in the cxell image (2026-08-03): a bad key produces a clean vendor auth error, so the key
// was sent.
//
// `codex` is the exception, and it failed SILENTLY as an auth error. Measured on codex-cli 0.145.0
// in the same image: with OPENAI_API_KEY set and nothing else, `codex exec` sends NO Authorization
// header at all — every turn dies with `401 Unauthorized: Missing bearer or basic authentication in
// header`, which reads exactly like "the human pasted a bad key" no matter how good the key is.
// Its documented door is `codex login --with-api-key`, which reads the key from STDIN and writes
// ~/.codex/auth.json ({auth_mode:"apikey", OPENAI_API_KEY}); with that in place the SAME key is sent
// (a deliberately bogus one then returns the honest `invalid_api_key`). So the queenzee installs the
// credential into the cage before the agent starts (lib/cxell.js prepareCxellAuth).
//
// `grok` is the SECOND exception, and it is not a bug in the CLI — it is a second CREDENTIAL SHAPE.
// An `xai-…` API key is env-only exactly as before, but a SuperGrok / Business SEAT is a signed-in
// session, and the vendor's headless door for it (`grok login --device-auth`) writes a FILE:
// ~/.grok/auth.json. Its env var GROK_AUTH does not accept that file's shape (measured 2026-08-13),
// so the queenzee installs the file the same way it installs codex's, from the same env.
//
// Rules for one of these commands: it reads the key from the ENV the exec already carries (never
// interpolate a token into a command line — it would land in `ps`, in the docker argv and in logs),
// it is idempotent (it runs at every spawn and before every resume), and it prints AUTH_OK /
// AUTH_FAILED (AUTH_MARKERS) so the caller reads the container's own verdict rather than an exit
// code. Anything it echoes on failure is scrubbed of `sk-…` before it can reach a log.
export const AUTH_MARKERS = ['AUTH_OK', 'AUTH_FAILED'];

// ── …AND THE SAME FOR FIRST-RUN PROMPTS: firstRunSeedCmd ─────────────────────────────────────────
// A cxell's first-run answers used to be CLAUDE'S ONLY — cxell-claude-seed.mjs, baked into the image
// and re-run by cxell-sshd.sh — so the cage was pre-answered for one vendor and left every other one
// to meet its own gauntlet. That is invisible on the headless path (all three CLIs run
// non-interactively) and lands squarely on the HUMAN who attends a cage: zee-attach.sh hands the
// pane to `codex resume` / `kimi --continue`, and an unanswered first-run prompt is what they get
// instead of the session.
//
// MEASURED in the zee-agent image (2026-08-03), rather than assumed:
//   • codex 0.145.0 — the binary carries "Do you trust the contents of this directory? Working with
//     untrusted cont…" and a `[projects."<path>"] trust_level = "trusted"` table in
//     ~/.codex/config.toml. Written for /work/repo, `codex doctor` reports `config.toml parse ok`
//     and `codex exec` runs unchanged. That is the one gate; auth is already handled above.
//   • kimi 0.28.1 — its config lives at ~/.kimi-code/config.toml (+ tui.toml for theme), its
//     credentials come from the KIMI_MODEL_* env, and its only "onboarding" text is the /login path
//     for a CLI with NO provider configured — which the env configures. Nothing to pre-answer, so
//     it declares nothing rather than being handed a speculative config file.
//   • deepseek — the claude CLI, so it inherits claude's seed with the adapter it spreads.
//
// Same contract as authSetupCmd: idempotent (it runs at every spawn), it must never write over what
// the vendor has already recorded, and it prints SEED_OK / SEED_FAILED. It is NOT fatal: a cage
// whose seed failed still works headless, and the cost is a prompt in front of an attending human.
export const SEED_MARKERS = ['SEED_OK', 'SEED_FAILED'];

// ── …AND THE SAME FOR TURN BOUNDARIES: turnHookCmd ───────────────────────────────────────────────
//
// The third per-vendor install, and the same rule as the two above: MEASURED, never assumed, and a
// vendor with nothing measured declares nothing rather than being handed a speculative config.
//
// WHAT IT IS FOR. Three kinds of turn run in a cage. The queenzee STARTS two of them (a spawn —
// queenzee/intake.js; a resume — queenzee/nudge.js) and records both. The third is a turn a human or
// a manager starts by TYPING into the live session in the pane, and nothing in the fleet can see it:
// no hook is installed in a cage, the passive poller skips entrypoint='cxell-cli', and the monitor's
// pgrep cannot tell a generating TUI from one at its prompt (queenzee/reaper.js has carried that as a
// KNOWN GAP in those words). So such a zee reads 'idle' for the whole turn — the reading that cost a
// manager a duplicate xell.
//
// MEASURED in this image, claude 2.1.220 (2026-08-04), both halves:
//   • an interactive/`-p` run FIRES `UserPromptSubmit` and `Stop` hooks from the cage's own
//     ~/.claude/settings.json — that is the door, and zee-attach.sh's pane session is exactly such a
//     run;
//   • `claude --bare` — what EVERY queenzee-started turn runs (intake's runZee and nudgeCxellZee) —
//     fires neither. So the hook covers precisely the turns the queenzee cannot see, and cannot
//     double-report the ones it can.
// codex and kimi: not measured, so they declare nothing and their cages are unchanged.
//
// The command's rules are authSetupCmd's: it is idempotent (it replaces its own hook group and keeps
// every other hook and setting the file holds), it interpolates no secret, and it prints
// TURNHOOK_OK / TURNHOOK_FAILED so the caller reads the cage's own verdict rather than an exit code.
// The hook itself is `|| true` and silent: a hook that fails must never break the zee's session, and
// a UserPromptSubmit hook's STDOUT is injected into the prompt — so it writes none.
export const TURN_HOOK_MARKERS = ['TURNHOOK_OK', 'TURNHOOK_FAILED'];

// The dispatch model picker offers claude aliases; they mean nothing to other vendors' CLIs,
// so non-claude adapters drop them and run the vendor's own default model. EVERY alias the
// picker can offer must be listed here — vendorModel() treats anything NOT in this set as a
// vendor-specific model id, so a missing alias is not a claude bug: it silently launches a
// Codex/Kimi dispatch with `--model <claude alias>`.
const CLAUDE_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable']);
const vendorModel = (model) => (model && !CLAUDE_MODEL_ALIASES.has(model) ? model : null);

// WHAT THE CAGE WILL ACTUALLY RUN, when the adapter can say. A claude alias is dropped by every
// non-claude adapter above, so a DeepSeek dispatch that resolved to "opus" (the manager harness's
// default_model, migration 110) runs deepseek-chat — while the zee ROW said `opus`. That is not
// cosmetic: production carries deepseek-cxell zees recorded as opus/fable, the console shows a
// model that never ran, the delivery telemetry's cost-per-model table sums DeepSeek spend under
// claude's name, and the resume path feeds that same string back to the CLI.
//
// Only the vendors whose default is KNOWABLE answer: deepseek and kimi set it themselves in env()
// (the same expression, so the two cannot drift), while codex deliberately sends NO --model and
// lets its own CLI route — a default this queenzee does not know and must not invent. null means
// "no better answer than what was asked", and the caller keeps the requested model.
export const effectiveModelFor = (adapter, model) => (adapter?.effectiveModel?.(model) ?? null);

// sanitize anything interpolated into the in-cxell bash command line
const safeSid = (sid) => String(sid || '').replace(/[^0-9a-zA-Z_-]/g, '');
const safeModel = (m) => String(m || '').replace(/[^0-9a-zA-Z_./:-]/g, '');

// The two vendors whose default model IS knowable to the queenzee — each written ONCE and read
// both by the adapter's env() (what is sent) and by effectiveModel (what is recorded).
const kimiModel = (model) => safeModel(vendorModel(model)) || process.env.KIMI_DEFAULT_MODEL || 'k3';
const deepseekModel = (model) => safeModel(vendorModel(model)) || process.env.DEEPSEEK_DEFAULT_MODEL || 'deepseek-chat';
// grok's default is knowable the same way: `grok models` names grok-4.5 as the CLI's own default
// (measured on 0.2.118), and the CLI REJECTS an id it does not know — so this is sent explicitly
// rather than omitted, and GROK_DEFAULT_MODEL is the knob for the day that id moves upstream.
const grokModel = (model) => safeModel(vendorModel(model)) || process.env.GROK_DEFAULT_MODEL || 'grok-4.5';

// ── A GROK CREDENTIAL IS ONE OF TWO THINGS, AND THEY ARE NOT INTERCHANGEABLE ─────────────────────
// An `xai-…` API key spends PREPAID xAI API credits. A SuperGrok / Business seat is not an API key
// at all — it is a signed-in SESSION, and the vendor's own door for a headless box (no browser) is
// `grok login --device-auth`, which writes that session to ~/.grok/auth.json. Same CLI, different
// pool, and the CLI's own instruction when it has neither is that exact command.
//
// The two must never be mixed: xAI's guidance is to UNSET XAI_API_KEY when using the seat, because
// the key takes precedence and the seat is then silently not used — a cage that quietly bills a
// prepaid balance while a human believes it is on their subscription. So the adapter branches on
// the SHAPE of the credential (below), and a session cage gets no XAI_API_KEY at all.
//
// MEASURED on grok 0.2.118 in this cage (2026-08-13), by feeding the CLI candidate files and
// reading its own parse errors back off `--debug-file`:
//   • ~/.grok/auth.json is a JSON OBJECT keyed by auth SCOPE (a device/browser login writes
//     "https://accounts.x.ai/sign-in"; an API key lands under "xai::api_key"), each entry an object
//     whose REQUIRED fields are `key`, `auth_mode` (one of grok | web_login | oidc | external |
//     api_key — the CLI names the whole enum when it rejects one), `create_time` (RFC 3339) and
//     `user_id`. Extra fields (refresh_token, expires_at, email, …) are accepted and preserved.
//   • the env var `GROK_AUTH` is NOT that door: it parses as a different (undocumented) struct and
//     every auth.json shape fed to it logs "GROK_AUTH set but failed to parse as JSON, falling back
//     to file". So the FILE is the vendor's documented and working transport, and the queenzee
//     installs it into the cage the way it installs codex's — authSetupCmd, credential from the env.
// The predicate is deliberately LOOSE at the tail (the repo's rule for credential shapes): a shape
// tweak upstream must cost a missed catch, never a locked-out human.
export function grokSessionCredential(token) {
  const t = String(token || '').trim();
  if (!t.startsWith('{')) return null;                    // an xai-… API key, or nothing
  let o;
  try { o = JSON.parse(t); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const entries = Object.values(o);
  const usable = entries.length > 0 && entries.every(
    (e) => e && typeof e === 'object' && typeof e.key === 'string' && e.key.trim()
           && typeof e.auth_mode === 'string' && e.auth_mode.trim());
  return usable ? o : null;
}

// The reader for a CLI whose output IS the normalized contract already: one JSON event per line,
// parsed and passed through, and no synthesized result on close (a run that printed none stays an
// error, as it always has). Named once because more than one vendor speaks it.
const passThroughJsonParser = (emit) => ({
  line(l) {
    let ev;
    try { ev = JSON.parse(l); } catch { return; } // non-JSON noise (e.g. a bash warning)
    emit(ev);
  },
  close() {},
});

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
    // Claude's first-run gauntlet (onboarding, theme, folder trust, the bypass acknowledgement) is
    // pre-answered by the script the image bakes. Declared HERE, not only in the image, so the
    // answer to "what does this vendor need before a human can attend it?" has one place per
    // vendor — and so a cage from an older image is seeded by the queenzee that spawned it, the
    // same defence installZeeCliIntoCxell applies to the CLI. The script is idempotent by design
    // (it merges keys and preserves what Claude has written), so running it twice is a no-op.
    firstRunSeedCmd: () =>
      'if node /usr/local/bin/cxell-claude-seed.mjs "$HOME/.claude.json" >/dev/null 2>&1; '
      + 'then echo SEED_OK; else echo "cxell-claude-seed.mjs failed"; echo SEED_FAILED; fi',
    // The turn-boundary hooks (see TURN_HOOK_MARKERS above). MERGES into ~/.claude/settings.json:
    // it drops any previous `zee turn` group and re-adds exactly one, keeping every other hook and
    // every other setting the file holds — so it is safe at every spawn and safe over whatever a
    // human has put there. Written for `node -e` in single quotes, so the script itself contains no
    // single quote and the hook command contains no quote at all.
    turnHookCmd: () =>
      'if node -e '
      + '\'const fs=require("fs"),path=require("path"),p=process.env.HOME+"/.claude/settings.json";'
      + 'let c={};try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){}'
      + 'const mk=(s)=>({hooks:[{type:"command",command:"zee turn --"+s+" >/dev/null 2>&1 || true",timeout:15}]});'
      + 'c.hooks=c.hooks||{};'
      + 'for(const kv of [["UserPromptSubmit","start"],["Stop","end"]]){'
      + 'const keep=(c.hooks[kv[0]]||[]).filter(g=>JSON.stringify(g).indexOf("zee turn --")<0);'
      + 'c.hooks[kv[0]]=keep.concat([mk(kv[1])]);}'
      + 'fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(c,null,2));\' '
      + '>/dev/null 2>&1; then echo TURNHOOK_OK; else echo "could not merge the turn hooks into ~/.claude/settings.json"; echo TURNHOOK_FAILED; fi',
    // stream-json is already the contract — parse and pass through
    makeParser: passThroughJsonParser,
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
    // `codex exec` does NOT authenticate from OPENAI_API_KEY — see the authSetupCmd note at the top
    // of this file. This is the vendor's own door: the key is piped in from the env the exec already
    // carries (never on the command line), and codex writes ~/.codex/auth.json. Idempotent — it just
    // rewrites that file, which is what makes a rotated key take effect on the next resume.
    // The file that PROVES the install happened, relative to $HOME — declared here so nothing
    // outside the adapters has to know a vendor's path (`zee creds --export` fails non-zero until
    // it exists, rather than letting a zee eval the env and walk into a silent 401).
    authFile: '.codex/auth.json',
    authSetupCmd: () =>
      'if out=$(printenv OPENAI_API_KEY | codex login --with-api-key 2>&1); then echo AUTH_OK; '
      // never let a key reach a log, even on the vendor's own error path
      + 'else printf %s "$out" | sed -E "s/sk-[A-Za-z0-9_-]{6,}/sk-…/g" | tail -c 300; '
      + 'echo; echo AUTH_FAILED; fi',
    // The one first-run gate codex has once it is authenticated: "Do you trust the contents of this
    // directory?" for the cwd an attending human resumes in. Its answer is a `[projects."<path>"]
    // trust_level = "trusted"` table in ~/.codex/config.toml (both the prompt and the table are in
    // the 0.145.0 binary; written for /work/repo, `codex doctor` reports `config.toml parse ok` and
    // `codex exec` runs unchanged). APPEND-IF-ABSENT, never a rewrite: codex owns that file (MCP
    // servers, model prefs, whatever a human set through it), so the seed adds its own block and
    // touches nothing else — and running it twice leaves one block.
    firstRunSeedCmd: () => [
      'mkdir -p "$HOME/.codex" && touch "$HOME/.codex/config.toml"',
      `&& { grep -qF '[projects."/work/repo"]' "$HOME/.codex/config.toml"`,
      `|| printf '\\n[projects."/work/repo"]\\ntrust_level = "trusted"\\n' >> "$HOME/.codex/config.toml"; }`,
      '&& echo SEED_OK || { echo "could not write ~/.codex/config.toml"; echo SEED_FAILED; }',
    ].join(' '),
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
    // ONE expression for "which model this cage runs", used by env() below and reported to the
    // queenzee (effectiveModelFor) — so what is recorded cannot drift from what is sent.
    effectiveModel: (model) => kimiModel(model),
    execCmd: ({ resumeSid } = {}) =>
      // resume = -c/--continue: kimi resumes the most recent session for this workdir
      // (/work/repo); its session ids never reach us headless, and one cxell only ever holds
      // one zee, so "most recent here" IS the session.
      `kimi${resumeSid !== undefined && resumeSid !== null ? ' -c' : ''}`
      + ' -p "$(cat)" --output-format stream-json',
    env: ({ token, model } = {}) => ({
      KIMI_MODEL_API_KEY: token,
      KIMI_MODEL_NAME: kimiModel(model),
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

  // ── Grok Build — the literal `grok` CLI (@xai-official/grok), headless single-prompt ─────
  // xAI ships its own coding-agent CLI, so the vendor-native ruling applies straight: this is
  // Grok Build, not the claude CLI re-aimed at api.x.ai (which does answer the Anthropic wire
  // format, and is exactly the shim that ruling forbids).
  //
  // MEASURED on grok 0.2.118 in this cage (2026-08-04), not read off the docs:
  //   • `--output-format streaming-messages-json` IS the normalized contract, line for line —
  //     `{"type":"system","subtype":"init","session_id":…}` first, and a final
  //     `{"type":"result","is_error":…,"total_cost_usd":…,"usage":{input_tokens,output_tokens,
  //     cache_read_input_tokens,cache_creation_input_tokens}}` (the vendor calls it "NDJSON in
  //     the Anthropic Messages API wire format"). So it reads with claude's parser and
  //     usageFrom() counts its turn with no translation. NB the OTHER NDJSON format,
  //     `streaming-json`, is native ACP session updates and is NOT this shape.
  //   • XAI_API_KEY alone authenticates an API-KEY account (the init event reports apiKeySource
  //     "user"), and a bad key ends the turn with its own error result ("API error … Incorrect API
  //     key provided"), never a hang. A SEAT (SuperGrok / Business) is the other credential and it
  //     is a FILE, not an env var — see grokSessionCredential above and authSetupCmd below.
  //   • with NEITHER, a turn ends with the CLI's own instruction rather than a hang: "Not signed
  //     in. To authenticate without a browser, run: grok login --device-code …" (measured today).
  //   • no first-run gauntlet: a run in a fresh HOME writes ~/.grok and proceeds, so like kimi it
  //     declares no firstRunSeedCmd rather than being handed a speculative config.
  //   • the model is validated CLIENT-side — an id the CLI does not know ends the turn before the
  //     API is called ("unknown model id. Run 'grok models'"), which is why the picker below
  //     offers only what `grok models` lists.
  // -p takes the prompt as an ARGUMENT (kimi's situation), so it rides in on stdin and `"$(cat)"`
  // splices it in-container — model text never touches the queenzee-side command line.
  'grok-cxell': {
    key: 'grok-cxell',
    provider: 'grok',
    bin: 'grok',
    // ONE expression for "which model this cage runs" — sent on the command line below and
    // reported to the queenzee (effectiveModelFor), so what is recorded cannot drift from what ran.
    effectiveModel: (model) => grokModel(model),
    execCmd: ({ model, resumeSid } = {}) =>
      `grok${safeSid(resumeSid) ? ` -r ${safeSid(resumeSid)}` : ''}`
      // --always-approve: the cxell is the permission system (the init event then reports
      // permissionMode bypassPermissions), same stance as every other runtime here
      + ` -p "$(cat)" -m ${safeModel(grokModel(model))}`
      + ' --output-format streaming-messages-json --always-approve',
    // TWO credential shapes, one adapter (grokSessionCredential above says which): an `xai-…` API
    // key rides in as XAI_API_KEY exactly as before, while a device-auth SESSION rides in as
    // GROK_AUTH_JSON — a carrier var the CLI does not read, installed into ~/.grok/auth.json by
    // authSetupCmd below. A session cage deliberately gets NO XAI_API_KEY: the key wins over the
    // seat, so setting both would spend prepaid credits while a human believes the subscription
    // is being used.
    env: ({ token } = {}) => ({
      ...(grokSessionCredential(token) ? { GROK_AUTH_JSON: token } : { XAI_API_KEY: token }),
      // documented container knob: no background update check inside a throwaway cage
      GROK_DISABLE_AUTOUPDATER: '1',
    }),
    // The nudge path's LEGACY fallback only (it reads ZEE_PROVIDER_GROK_TOKEN first, which carries
    // either shape) — so it stays the API-key var: a session is not a token to hand a CLI.
    tokenEnvKey: 'XAI_API_KEY',
    // INSTALL A SEAT SESSION — the codex situation, for the opposite reason. codex needs a file
    // because its env is not read; grok needs one because the vendor's device-code login IS a file
    // (~/.grok/auth.json) and its env door, GROK_AUTH, does not accept that file's shape (measured).
    // Called with the account's token where it is known (the runnable-env export) so an API-key
    // account is told there is nothing to install; called with NOTHING on the spawn/resume path, so
    // the command it returns then must handle both shapes from the cage's own environment.
    //
    // NEVER CLOBBER A FRESHER SESSION. The CLI refreshes that file in place (the session expires in
    // ~7 days and carries a refresh_token), so a resume that blindly rewrote it would put a stale
    // copy — possibly with an already-spent refresh token — over the live one. The rule is
    // create_time: install only when the credential the queenzee holds is NEWER than what the cage
    // already has, which installs a human's re-login and leaves the CLI's own refresh alone.
    authFile: '.grok/auth.json',   // what a device-auth login writes (GROK_HOME moves it)
    authSetupCmd: ({ token } = {}) => {
      if (token && !grokSessionCredential(token)) return null;   // an API key: the env IS the login
      return 'if [ -n "${GROK_AUTH_JSON:-}" ]; then '
        // node's own stderr can quote the offending input, so it is dropped and we say our own line
        + 'if said=$(printenv GROK_AUTH_JSON | node -e '
        + '"const fs=require(\'fs\'),os=require(\'os\'),path=require(\'path\');'
        + 'let s=\'\';process.stdin.on(\'data\',(d)=>{s+=d;}).on(\'end\',()=>{'
        + 'const inc=JSON.parse(s);'
        + 'const dir=process.env.GROK_HOME||path.join(os.homedir(),\'.grok\');'
        + 'const p=path.join(dir,\'auth.json\');'
        + 'const born=(o)=>Math.max(0,...Object.values(o||{}).map((e)=>Date.parse(e&&e.create_time)||0));'
        + 'let cur=null;try{cur=JSON.parse(fs.readFileSync(p,\'utf8\'));}catch{}'
        + 'if(cur&&born(cur)>=born(inc)){process.stdout.write(\'kept the cage session\');return;}'
        + 'fs.mkdirSync(dir,{recursive:true});'
        + 'fs.writeFileSync(p+\'.zeehive\',JSON.stringify(inc),{mode:0o600});'
        + 'fs.renameSync(p+\'.zeehive\',p);fs.chmodSync(p,0o600);'
        + 'process.stdout.write(\'installed the seat session\');});" 2>/dev/null); then '
        + 'echo "$said"; echo AUTH_OK; '
        + 'else echo "could not install the Grok session into ~/.grok/auth.json — is it the JSON that '
        + 'grok login --device-auth wrote?"; echo AUTH_FAILED; fi; '
        + 'elif [ -n "${XAI_API_KEY:-}" ]; then echo "XAI_API_KEY is the login"; echo AUTH_OK; '
        + 'else echo "the cage has neither GROK_AUTH_JSON nor XAI_API_KEY"; echo AUTH_FAILED; fi';
    },
    // The ONE dialect difference measured in that stream: a FAILED turn carries its message in
    // `errors[]`, where claude carries it in `result` — and `result` is what every consumer reads
    // (the zee's last_stop_reason, the revive classifier that decides transient vs terminal, the
    // tend a human is left with). Unfixed, every grok failure reads as the bare word "error". So it
    // is normalized here, in the adapter, where a vendor's dialect belongs.
    makeParser: (emit) => passThroughJsonParser((ev) => {
      if (ev?.type === 'result' && !ev.result && Array.isArray(ev.errors) && ev.errors.length) {
        emit({ ...ev, result: ev.errors.join('; ') });
      } else emit(ev);
    }),
    resumable: true,
    needsSid: true, // grok -r <session-id>, resumed out of ~/.grok/sessions
  },
};

// ── DeepSeek — the claude CLI aimed at DeepSeek's OWN Anthropic-compatible endpoint ──────────
// The sanctioned exception to the vendor-native ruling above (Mark, 2026-07-22): DeepSeek ships
// NO coding-agent CLI of its own; what it ships is an Anthropic-compatible API surface
// (api.deepseek.com/anthropic) built precisely so Claude-Code-style tooling can drive DeepSeek
// models. That makes this the vendor's documented door, not a shim around the vendor. Everything
// is the claude adapter (same stream-json contract, same resume mechanics); what differs is the
// credential (a DeepSeek key on the same bearer header), the base URL, and the model — pinned
// via ANTHROPIC_MODEL because claude aliases mean nothing here (bare dispatch runs deepseek-chat).
ADAPTERS['deepseek-cxell'] = {
  ...ADAPTERS['claude-code-cxell'],
  key: 'deepseek-cxell',
  provider: 'deepseek',
  // no --model flag: the model rides ANTHROPIC_MODEL below (claude aliases are dropped)
  execCmd: ({ resumeSid } = {}) =>
    'claude --bare -p --output-format stream-json --verbose --dangerously-skip-permissions'
    + (safeSid(resumeSid) ? ` --resume ${safeSid(resumeSid)}` : ''),
  // what this cage runs when the dispatch asked for a claude alias (which means nothing here) —
  // ONE expression, read by env() below and by the queenzee that records the zee's model
  effectiveModel: (model) => deepseekModel(model),
  env: ({ token, model } = {}) => ({
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_BASE_URL: process.env.DEEPSEEK_ANTHROPIC_BASE_URL || 'https://api.deepseek.com/anthropic',
    ANTHROPIC_MODEL: deepseekModel(model),
    // the CLI's background/fast lane must not silently ask for a claude model id either
    ANTHROPIC_SMALL_FAST_MODEL: process.env.DEEPSEEK_DEFAULT_MODEL || 'deepseek-chat',
  }),
};

// ── WHAT ONE TURN BURNED, off that final `result` event ──────────────────────────────────────────
// The fleet burn tracker's reader (migration 030): the event carries total_cost_usd plus a `usage`
// object, and ALL of it is captured (was: cost_usd only) so the dashboard can show tokens too. NB:
// these are the FLEET's own consumption — NOT the account-wide %/limits that only Anthropic's
// /usage exposes. Tolerant of shape drift: usage may sit on the result or (SDK) alongside
// total_cost_usd, and any field may be absent → 0. Never throws.
//
// It lives HERE, beside the event contract it reads and the adapters that produce it, because two
// paths now end a turn and both must count it the same way: a SPAWNED turn (queenzee/intake.js) and
// a RESUMED one (queenzee/nudge.js — a landing approval, a message, a clearance, a reflection). It
// was private to intake.js while only intake ended a turn, and the resumed half of the fleet's burn
// was simply never read.
export function usageFrom(result) {
  const u = result?.usage || {};
  // METERED = the provider's result carried a usage signal at all: a cost figure (total_cost_usd)
  // or a usage object with at least one recognised token key. A result with NEITHER is not "free" —
  // the turn ran and the fleet cannot know what it cost, and booking a silent zero would read as
  // "measured zero" everywhere this row is summed (TKT-99-1390). The callers turn `metered:false`
  // into an explicit marker (last_stop_reason 'end_turn (usage unreported)') instead.
  const hasCost = result?.total_cost_usd != null || u?.total_cost_usd != null;
  const hasTokens = !!(u && (u.input_tokens != null || u.output_tokens != null
                             || u.cache_read_input_tokens != null || u.cache_creation_input_tokens != null));
  return {
    cost: Number(result?.total_cost_usd ?? u.total_cost_usd ?? 0) || 0,
    input: Number(u.input_tokens || 0) || 0,
    output: Number(u.output_tokens || 0) || 0,
    cacheRead: Number(u.cache_read_input_tokens || 0) || 0,
    cacheWrite: Number(u.cache_creation_input_tokens || 0) || 0,
    metered: hasCost || hasTokens,
  };
}

// ── THE FINAL `result` EVENT OF A RUN THAT IS ALREADY OVER ───────────────────────────────────────
//
// runZee (lib/cxell.js) streams a SPAWNED turn through the adapter's parser line by line. A RESUMED
// turn has no stream: nudgeCxellZee gets the whole `docker exec` back at once as { code, out, err },
// and two callers then need the same thing out of it — what the turn cost (usageFrom, above) and
// whether it DIED (lib/turn-death.js resumeTurnDeath). Those two grew their own readers within a day
// of each other, one adapter-aware and one scanning stdout for claude-shaped JSON, which is a third
// one waiting to happen and a codex/kimi turn read wrongly by one of them.
//
// So the parse happens ONCE, here, where the dialects are: the adapter that produced the output is
// the adapter that reads it, `close()` still synthesizes the result a codex or kimi run never prints,
// and the LAST result event wins (a resumed session can emit more than one). Both callers then work
// on the same object, and neither knows a vendor's line format.
//
// Pure and best-effort — a line the parser chokes on is skipped exactly as its own JSON.parse does,
// and a run with nothing to read returns null rather than a shape nobody can trust.
export function resultFrom(adapter, { code = 0, out = '', err = '' } = {}) {
  if (!adapter?.makeParser) return null;
  let result = null;
  const parser = adapter.makeParser((ev) => { if (ev?.type === 'result') result = ev; });
  for (const line of String(out || '').split('\n')) {
    if (!line.trim()) continue;
    try { parser.line(line); } catch { /* one unreadable line is not the turn */ }
  }
  try { parser.close(code, String(err || '').trim().split('\n').slice(-3).join(' ').slice(0, 400)); }
  catch { /* an adapter's close is best-effort too */ }
  return result;
}

export function adapterFor(runtimeKey) {
  const a = ADAPTERS[runtimeKey || 'claude-code-cxell'];
  if (!a) throw new Error(`no cxell runtime adapter for "${runtimeKey}" — known: ${Object.keys(ADAPTERS).join(', ')}`);
  return a;
}
export const CLAUDE_ADAPTER = ADAPTERS['claude-code-cxell'];

// Which cxell runtime a dispatch provider runs on. Claude resolves through the pool default /
// runtime toggle as before; the other vendors have exactly one runtime — their own CLI.
const PROVIDER_RUNTIME = { openai: 'codex-cxell', kimi: 'kimi-code-cxell', deepseek: 'deepseek-cxell',
                           grok: 'grok-cxell' };
export const runtimeKeyForProvider = (provider) => PROVIDER_RUNTIME[provider] || null;

// Which vendor a runtime key actually RUNS — the adapter's own claim, and therefore whose
// credential its env() sets. null = no adapter (a host-auth claude runtime, or an unknown key).
export const providerForRuntimeKey = (key) => ADAPTERS[key]?.provider || null;

// ── PROVIDER, RUNTIME AND CREDENTIAL MUST NAME THE SAME VENDOR ───────────────────────────────────
//
// A dispatch decides those three separately — the provider from the connected accounts
// (provider-tokens.js decideDispatchProvider), the runtime from the caller or
// pool_config.default_runtime_id, the credential from spawnCreds(pid, provider) — and until this
// existed nothing compared them. Only the NON-claude providers had an opinion: runtimeKeyForProvider
// pulls a Codex/Kimi/DeepSeek dispatch onto its own CLI. Claude has no entry (it has three runtimes:
// cxell, remote, local), so a project whose pool default was another vendor's cxell runtime kept
// that runtime and was handed a CLAUDE token for it — the DeepSeek adapter set an sk-ant-… key as
// ANTHROPIC_AUTH_TOKEN against api.deepseek.com, and the vendor's answer ("your api key … is
// invalid") blamed the account. Four zees died that way on 2026-08-03 before anyone read the pairing.
//
// PURE DECISION, exported so the whole rule is table-testable without a database (same shape as
// decideDispatchProvider): the project state that breaks — a non-claude pool default beside a claude
// account — is one this repo's own meta-DB does not have.
//
//   1. A PROVIDER WITH ITS OWN RUNTIME still picks it (unchanged). An OpenAI key runs the Codex CLI.
//   2. AGREEMENT PASSES THROUGH. The common case (claude account, claude pool default) does not move,
//      and neither does a host-auth runtime — claude-code-remote and the local SDK authenticate from
//      the HOST's claude session, read no meta-DB token, and so have nothing to disagree about.
//   3. AN EXPLICIT PROVIDER BEATS A CONFIGURED RUNTIME. A caller that named claude (the console's
//      per-account button, an MCP call) gets claude's own cxell runtime — the pool default is a
//      claude-world knob and must not aim that credential at another vendor's CLI.
//   4. A CONFIGURED RUNTIME BEATS AN INFERRED PROVIDER, and its OWN credential is used. Nobody asked
//      for claude here: it was inferred from "an account happens to be connected", while the runtime
//      is a human's configuration. Inference must not overrule configuration — and the resume path
//      already reads the token for adapter.provider (queenzee/nudge.js), so this is the only
//      spelling under which a spawn and its own resume use the same account.
//   5. TWO EXPLICIT INSTRUCTIONS THAT DISAGREE ARE REFUSED, with a sentence naming what disagreed and
//      what to change. There is nothing to defer to, and a mismatch is never started silently.
//   6. A HARNESS THAT FORBIDS THE RUNTIME'S VENDOR REFUSES TOO (migration 110's allow_providers):
//      repairing the credential must not walk a persona onto a provider its policy excludes.
//
// Returns { ok:true, provider, runtimeKey, reason } — provider/runtimeKey are what the spawn must
// use — or { ok:false, refuse:<sentence>, reason }.
export function decideRuntimePairing({ provider, providerNamed = false, runtimeKey = null,
                                       runtimeNamed = false, runtimeIsCaged = true,
                                       allowProviders = [] } = {}) {
  const own = runtimeKeyForProvider(provider);
  if (own) return { ok: true, provider, runtimeKey: own, reason: 'provider-runtime' };
  // Only a CAGED runtime is handed a meta-DB credential; a host-auth one carries no claim at all.
  const runtimeProvider = runtimeIsCaged ? providerForRuntimeKey(runtimeKey) : provider;
  if (!runtimeProvider) return { ok: true, provider, runtimeKey, reason: 'unknown-runtime' };
  if (runtimeProvider === provider) return { ok: true, provider, runtimeKey, reason: 'agree' };
  if (providerNamed && runtimeNamed) {
    return { ok: false, reason: 'contradiction', refuse:
      `this dispatch names provider "${provider}" and runtime "${runtimeKey}", which runs ${runtimeProvider} — `
      + `a ${runtimeProvider} CLI cannot authenticate with a ${provider} credential. `
      + `Dispatch on ${runtimeProvider}, or name a ${provider} runtime (${runtimeKeyForProvider(provider) || 'claude-code-cxell'}).` };
  }
  if (providerNamed) {
    return { ok: true, provider, runtimeKey: runtimeKeyForProvider(provider) || 'claude-code-cxell',
             reason: 'named-provider' };
  }
  if (allowProviders.length && !allowProviders.includes(runtimeProvider)) {
    return { ok: false, reason: 'harness-policy', refuse:
      `runtime "${runtimeKey}" runs ${runtimeProvider}, but this harness's model policy allows only `
      + `${allowProviders.join(', ')} — dispatch on a provider the harness allows, or change the runtime `
      + `this project defaults to.` };
  }
  return { ok: true, provider: runtimeProvider, runtimeKey, reason: 'runtime-provider' };
}

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
  // DeepSeek's two stable serving names — they track generations upstream, so they can't go stale:
  // deepseek-chat is the current V-series (non-thinking), deepseek-reasoner the thinking R-series.
  deepseek: [
    { key: '', label: 'DeepSeek default', note: `runs ${process.env.DEEPSEEK_DEFAULT_MODEL || 'deepseek-chat'} (override: DEEPSEEK_DEFAULT_MODEL)`, default: true },
    { key: 'deepseek-chat',     label: 'DeepSeek Chat',     note: 'the current V-series — fast, everyday coding' },
    { key: 'deepseek-reasoner', label: 'DeepSeek Reasoner', note: 'the thinking R-series — hard, long-horizon work' },
  ],
  // EXACTLY what `grok models` lists (measured on the CLI, 0.2.118): the CLI validates the id
  // itself and fails the turn on one it does not know, so an aspirational entry here is a dead
  // dispatch, not a fallback. '' resolves to GROK_DEFAULT_MODEL || grok-4.5 on the command line.
  grok: [
    { key: '', label: 'Grok default', note: `runs ${process.env.GROK_DEFAULT_MODEL || 'grok-4.5'} (override: GROK_DEFAULT_MODEL)`, default: true },
    { key: 'grok-4.5', label: 'Grok 4.5', note: 'the flagship coding model — configurable reasoning' },
  ],
};
export const providerModels = (provider) => VENDOR_MODELS[provider] || null;

// pgrep -f pattern for "is ANY known agent CLI alive in this cxell" — headless run or a human's
// interactive session over SSH alike (see cxellZeeActive). Word-ish boundaries keep it from
// matching substrings of unrelated cmdlines.
export const AGENT_PROC_PATTERN = `(^|/| )(${[...new Set(Object.values(ADAPTERS).map((a) => a.bin))].join('|')})( |$)`;

// pgrep -f pattern for the NARROWER question: "is the queenzee's HEADLESS turn in flight right
// now?" — as opposed to AGENT_PROC_PATTERN, which also matches the interactive session a human
// drives in the pane. The difference decides who owns the cxell's terminal, and therefore whether
// a message can be TYPED into it at all (see cxellTalkCommand): during a headless turn the pane is
// zee-attach.sh's read-only feed, and keystrokes sent there are swallowed.
//
// ⚠ MUST stay in lockstep with `live_run()` in docker/zeehive/zee-attach.sh — that script decides
// the same thing from inside the cage, and the two disagreeing is a message delivered into a void.
//
// The BRACKETS are load-bearing, and were put here by a live misfire rather than by theory: this
// pattern is interpolated into the shell command the queenzee execs over SSH, so `pgrep -f` reads
// its own wrapper's cmdline — which contains the pattern — and matched IT. Every message would then
// look mid-turn and queue, in a cage with no turn running at all. `[-]p` matches "-p" while the
// literal text "[-]p" does not, so the probe cannot see itself. (Same trick, same reason, as
// `zee-live[.]mjs` in terminal-bridge.js.)
// grok spells its alternative out (`grok( -r <sid>)? -p`) rather than as `grok [-]p`, because a
// RESUMED grok turn puts the session id FIRST (`grok -r <sid> -p …`) and the headless flag is what
// identifies the turn. A plain `grok .*[-]p` would have done it and must not be used: the `.*` hops
// straight over the brackets to a `-p` further along the wrapper's own command line, which is the
// self-match this whole comment is about.
export const HEADLESS_PROC_PATTERN = 'claude --bare [-]p|codex [e]xec|kimi [-]p|grok( -r [^ ]*)? [-]p';

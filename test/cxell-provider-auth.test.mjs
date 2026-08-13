// THE CAGE IS PROVIDER-AGNOSTIC — AND "the environment is enough" IS A PER-VENDOR FACT.
//
// A cxell carries every vendor CLI and nothing about a provider is baked into it: whichever AI
// provider a dispatch picks, that provider's credential is what the cage gets, as the runtime
// adapter's env (docker exec -e for the headless run, /etc/environment for an attending human).
// For claude, kimi and deepseek that environment IS the login — measured in the zee-agent image
// (2026-08-03): a deliberately bad key comes back as the vendor's own auth error, so the key was
// sent.
//
// `codex` is the exception, and it failed as an AUTH ERROR, which is why this file exists. Measured
// on codex-cli 0.145.0 in the same image: with OPENAI_API_KEY set and nothing else, `codex exec`
// sends NO Authorization header — every turn dies with `401 Unauthorized: Missing bearer or basic
// authentication in header`. That is indistinguishable, to the human reading the feed, from "the key
// you pasted is invalid", and it happens with a PERFECT key. After `codex login --with-api-key`
// (stdin → ~/.codex/auth.json) the same key IS sent and a bogus one returns the honest
// `invalid_api_key`. So the queenzee installs the credential into the cage before the agent starts.
//
// `grok` is the SECOND exception, and for the opposite reason: not a CLI that ignores its env, but a
// vendor with TWO credential shapes. An `xai-…` API key is read straight from XAI_API_KEY (nothing to
// install); a SuperGrok / Business SEAT is obtained by `grok login --device-auth`, which writes a
// session into ~/.grok/auth.json — a file, not a key, and the CLI's env door for it (GROK_AUTH) does
// not accept that file's shape (measured on grok 0.2.118). So the seat session rides in as the
// carrier var GROK_AUTH_JSON and the adapter writes the file. A seat cage gets NO XAI_API_KEY at all:
// the key OVERRIDES the seat, so setting both would quietly spend prepaid credits while a human
// believes the weekly subscription pool is being used.
//
// What this pins (lib/cxell-runtimes.js authSetupCmd + lib/cxell.js prepareCxellAuth):
//   1. THE ADAPTER CONTRACT — only a CLI that needs it declares a setup command, and that command
//      reads the key from the ENV the exec carries. A token interpolated into a command line would
//      land in `ps`, in the docker argv and in every log; that must stay impossible by construction.
//   2. THE VERDICT IS THE CONTAINER'S — AUTH_OK / AUTH_FAILED via dkVerdict, never the exit code,
//      and NO verdict is a FAILURE here (guessing would restore the silence this fixes).
//   3. A NO-OP IS FREE — an adapter with no setup runs NO exec at all, and the adapter is asked with
//      the TOKEN, so a shape that needs no install (a grok API key) costs nothing either. Provider-
//      agnostic means the claude/kimi/deepseek path is not paying for codex's quirk.
//   4. THE CREDENTIAL IS THE DISPATCHED ONE — the exec carries the token that was passed in, so a
//      re-crewed cage or a rotated account key installs the CURRENT key, not the one it was born
//      with.
//   5. THE SPAWN REFUSES rather than starting a zee that cannot authenticate, and the RESUME path
//      re-installs best-effort (a cage older than this fix must not resume into a 401).
//
// The seam is `docker` itself: the fake shim in test/_bin records argv + stdin and states the
// verdict the container would have printed (DOCKER_FAKE_CXELL_VERDICT). No database is needed —
// this is the cxell driver, not the fleet.
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeTokens } from './_bin/tokens.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'cxauth-'));
const DOCKER_LOG = join(tmp, 'docker.log');
process.env.DOCKER_LOG = DOCKER_LOG;
process.env.PATH = `${join(REPO_ROOT, 'test', '_bin')}:${process.env.PATH}`;

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const section = (t) => console.log(`\n── ${t} ──`);
const readLog = () => (existsSync(DOCKER_LOG) ? readFileSync(DOCKER_LOG, 'utf8') : '');
const clearLog = () => { rmSync(DOCKER_LOG, { force: true }); };

const TOKEN = 'sk-proj-testtoken0123456789abcdef';
const SESSION = fakeTokens.grokSession();          // what `grok login --device-auth` leaves behind

try {
  const RT = await import('../server/src/lib/cxell-runtimes.js');
  const { prepareCxellAuth } = await import('../server/src/lib/cxell.js');

  // ── 1. the adapter contract ─────────────────────────────────────────────────────────────────
  section('adapter contract — who needs a setup, and what it may not contain');
  const codex = RT.adapterFor('codex-cxell');
  const cmd = codex.authSetupCmd();
  ok(typeof cmd === 'string' && cmd.length > 0, 'the codex adapter declares an auth setup command');
  ok(/codex login --with-api-key/.test(cmd), "it is the vendor's own door: `codex login --with-api-key`");
  ok(/printenv OPENAI_API_KEY/.test(cmd),
     'the key is read from the ENV the exec carries (printenv), so it is never on a command line');
  ok(cmd.includes('AUTH_OK') && cmd.includes('AUTH_FAILED'),
     'it prints both declared verdicts, so dkVerdict can read the container’s own answer');
  ok(RT.AUTH_MARKERS.every((m) => cmd.includes(m)),
     'every marker it prints is declared in AUTH_MARKERS (dkVerdict refuses an undeclared one)');
  ok(/sk-\[A-Za-z0-9_-\]/.test(cmd) || /sed/.test(cmd),
     'the failure path scrubs sk-… before anything it echoes can reach a log');

  for (const key of ['claude-code-cxell', 'kimi-code-cxell', 'deepseek-cxell']) {
    const a = RT.adapterFor(key);
    ok(!a.authSetupCmd, `${key}: no setup command — its environment IS the login (measured)`);
  }

  // grok: one adapter, two shapes — the KEY needs nothing, the SEAT SESSION is a file to install
  const grok = RT.adapterFor('grok-cxell');
  ok(grok.authSetupCmd({ token: fakeTokens.grok() }) === null,
     'grok + an xai-… API key: no setup command — XAI_API_KEY IS the login');
  const gcmd = grok.authSetupCmd({ token: SESSION });
  ok(typeof gcmd === 'string' && gcmd.length > 0,
     'grok + a device-auth SEAT session: a setup command, because the session is a FILE');
  ok(/printenv GROK_AUTH_JSON/.test(gcmd) && !gcmd.includes(SESSION),
     'the session is read from the ENV the exec carries — never interpolated into the command');
  ok(/auth\.json/.test(gcmd) && /GROK_HOME/.test(gcmd),
     "it writes the vendor's own file (~/.grok/auth.json, GROK_HOME honored)");
  ok(/create_time/.test(gcmd) && /born\(cur\)>=born\(inc\)/.test(gcmd),
     'it NEVER clobbers a fresher session: the CLI refreshes that file in place, so newer wins');
  ok(/mode:0o600/.test(gcmd) && /chmodSync\(p,0o600\)/.test(gcmd),
     '…and the credential file is 0600, whatever umask the cage was built with');
  ok(/renameSync/.test(gcmd),
     '…written to a temp name and renamed, so a killed exec cannot leave half a session behind');
  ok(RT.AUTH_MARKERS.every((m) => gcmd.includes(m)),
     'it prints both declared verdicts, so dkVerdict reads the cage’s own answer');
  ok(!/`/.test(gcmd),
     'no backtick survives in it — a message quoting the login command would EXECUTE it in the cage');
  ok(/elif \[ -n "\$\{XAI_API_KEY:-\}" \]/.test(gcmd),
     'called with NO token (the spawn path) it still handles both shapes from the cage’s own env');

  // ── 2. the exec that installs it ────────────────────────────────────────────────────────────
  section('prepareCxellAuth — the container states the outcome');
  clearLog();
  process.env.DOCKER_FAKE_CXELL_VERDICT = 'AUTH_OK';
  let r = await prepareCxellAuth({ ctx: 'default', name: 'cxell_test', adapter: codex, token: TOKEN });
  ok(r.required && r.ok && r.verdict === 'AUTH_OK', 'AUTH_OK from the cage → the credential is installed');
  let log = readLog();
  ok(/-e OPENAI_API_KEY=/.test(log), 'the exec carries the credential env the adapter declares');
  ok(log.includes(TOKEN), 'the DISPATCHED token is what was handed to the cage');
  const cmdLine = (log.match(/=== docker (.*) ===/) || [])[1] || '';
  const afterEnv = cmdLine.replace(/-e OPENAI_API_KEY=\S+/g, '');
  ok(!afterEnv.includes(TOKEN),
     'the token appears ONLY as the -e env value — never interpolated into the command itself');
  ok(/bash -lc/.test(cmdLine) && /codex login --with-api-key/.test(cmdLine),
     'the setup command is what runs inside the cage');
  ok(!/ -u 0 /.test(cmdLine),
     'it runs as the cage user (`zee`), so the credential lands in the zee’s own home, not root’s');

  clearLog();
  process.env.DOCKER_FAKE_CXELL_VERDICT = 'AUTH_FAILED';
  r = await prepareCxellAuth({ ctx: 'default', name: 'cxell_test', adapter: codex, token: TOKEN });
  ok(r.required && !r.ok && r.verdict === 'AUTH_FAILED', 'AUTH_FAILED → not ok, and the verdict is reported');
  ok(typeof r.said === 'string' && r.said.length > 0, 'the failure carries what the cage said');

  clearLog();
  process.env.DOCKER_FAKE_CXELL_VERDICT = 'NONE';   // the shim prints nothing at all
  r = await prepareCxellAuth({ ctx: 'default', name: 'cxell_test', adapter: codex, token: TOKEN });
  ok(r.required && !r.ok && !r.verdict,
     'NO verdict is a FAILURE, not a shrug — a zee must not start on "we could not tell"');

  // no token to install: refused without touching docker at all
  clearLog();
  r = await prepareCxellAuth({ ctx: 'default', name: 'cxell_test', adapter: codex, token: null });
  ok(r.required && !r.ok, 'no token → refused');
  ok(readLog() === '', '…and nothing was exec’d in the cage to find that out');

  // ── 3. the providers that need nothing pay nothing ──────────────────────────────────────────
  section('an adapter with no setup runs no exec');
  for (const key of ['claude-code-cxell', 'kimi-code-cxell', 'deepseek-cxell']) {
    clearLog();
    const res = await prepareCxellAuth({ ctx: 'default', name: 'cxell_test',
                                         adapter: RT.adapterFor(key), token: TOKEN });
    ok(res.required === false && res.ok === true, `${key}: required:false, ok:true`);
    ok(readLog() === '', `${key}: no docker exec was attempted`);
  }

  // ── 3a. grok — the SHAPE decides, per dispatch ──────────────────────────────────────────────
  section('grok: an API key installs nothing; a seat session is written into the cage');
  clearLog();
  let g = await prepareCxellAuth({ ctx: 'default', name: 'cxell_test', adapter: grok,
                                   token: fakeTokens.grok() });
  ok(g.required === false && g.ok === true, 'an xai-… key: required:false, ok:true');
  ok(readLog() === '', '…and no docker exec was attempted to find that out');

  clearLog();
  process.env.DOCKER_FAKE_CXELL_VERDICT = 'AUTH_OK';
  g = await prepareCxellAuth({ ctx: 'default', name: 'cxell_test', adapter: grok, token: SESSION });
  ok(g.required && g.ok && g.verdict === 'AUTH_OK', 'a seat session: installed, on the cage’s own verdict');
  log = readLog();
  ok(log.includes(`-e GROK_AUTH_JSON=${SESSION}`), 'the session rides in as the carrier env GROK_AUTH_JSON');
  ok(!/-e XAI_API_KEY=/.test(log),
     'a SEAT cage gets NO XAI_API_KEY — the key overrides the seat, and would spend prepaid credits');
  const gLine = (log.match(/=== docker (.*) ===/) || [])[1] || '';
  ok(!gLine.replace(/-e GROK_AUTH_JSON=\S+/g, '').includes(SESSION.slice(0, 40)),
     'the session appears ONLY as the -e env value, never in the command line');
  ok(!/ -u 0 /.test(gLine), 'installed as the cage user, so it lands in the zee’s own ~/.grok');

  clearLog();
  process.env.DOCKER_FAKE_CXELL_VERDICT = 'AUTH_FAILED';
  g = await prepareCxellAuth({ ctx: 'default', name: 'cxell_test', adapter: grok, token: SESSION });
  ok(g.required && !g.ok && g.verdict === 'AUTH_FAILED',
     'a session the cage refuses is a FAILURE — better than a zee that runs unauthenticated');

  // ── 3b. the FIRST-RUN prompts, per vendor ───────────────────────────────────────────────────
  // The cage used to be pre-answered for claude alone (cxell-claude-seed.mjs, baked into the
  // image), which made it a claude cage wearing another vendor's CLI. Invisible headless; it lands
  // on the human who attends, because zee-attach.sh hands the pane to the vendor's resume verb.
  section('first-run seeds — declared per vendor, from what each one actually asks');
  const { seedCxellFirstRun } = await import('../server/src/lib/cxell.js');
  const codexSeed = codex.firstRunSeedCmd();
  ok(/\[projects\."\/work\/repo"\]/.test(codexSeed) && /trust_level = "trusted"/.test(codexSeed),
     'codex: the trust answer for /work/repo (the prompt and the table are both in the 0.145.0 binary)');
  const CFG = '"\\$HOME/\\.codex/config\\.toml"';
  ok(/grep -qF/.test(codexSeed)                                   // only when the block is absent…
     && new RegExp(`>> ${CFG}`).test(codexSeed)                   // …and then APPENDED…
     && !new RegExp(`[^>]> ${CFG}`).test(codexSeed),              // …never truncated over
     '…APPENDED if absent, never a rewrite — codex owns that file (MCP servers, model prefs)');
  const claudeSeed = RT.adapterFor('claude-code-cxell').firstRunSeedCmd();
  ok(/cxell-claude-seed\.mjs/.test(claudeSeed),
     'claude: the same idempotent script the image bakes — declared here so every vendor has ONE place');
  ok(RT.adapterFor('deepseek-cxell').firstRunSeedCmd() === claudeSeed,
     'deepseek: it IS the claude CLI, so it inherits claude’s seed rather than repeating it');
  ok(!RT.adapterFor('kimi-code-cxell').firstRunSeedCmd,
     'kimi: nothing measured to pre-answer (env-configured provider, no folder-trust gate) — so it '
     + 'declares nothing rather than being handed a speculative config file');
  ok(!RT.adapterFor('grok-cxell').firstRunSeedCmd,
     'grok: same — a headless run in a fresh HOME writes ~/.grok and proceeds (measured on 0.2.118), '
     + 'so it declares nothing either');
  for (const cmd of [codexSeed, claudeSeed]) {
    ok(RT.SEED_MARKERS.every((m) => cmd.includes(m)), `each seed prints both declared verdicts [${cmd.slice(0, 28)}…]`);
  }

  clearLog();
  process.env.DOCKER_FAKE_CXELL_VERDICT = 'SEED_OK';
  let s = await seedCxellFirstRun({ ctx: 'default', name: 'cxell_test', adapter: codex });
  ok(s.required && s.ok, 'SEED_OK from the cage → seeded');
  ok(/bash -lc/.test(readLog()) && !/ -u 0 /.test(readLog()),
     'seeded as the cage user, so the answers land in the home the agent actually reads');
  clearLog();
  process.env.DOCKER_FAKE_CXELL_VERDICT = 'NONE';
  s = await seedCxellFirstRun({ ctx: 'default', name: 'cxell_test', adapter: codex });
  ok(s.required && !s.ok, 'no verdict → reported as not seeded (never assumed)');
  clearLog();
  s = await seedCxellFirstRun({ ctx: 'default', name: 'cxell_test', adapter: RT.adapterFor('kimi-code-cxell') });
  ok(s.required === false && s.ok === true && readLog() === '',
     'a vendor with nothing to seed runs no exec at all');

  // ── 4. the wiring — spawn refuses, resume repairs ───────────────────────────────────────────
  section('wiring: the spawn refuses a cage that cannot authenticate; the resume re-installs');
  const intake = readFileSync(join(REPO_ROOT, 'server', 'src', 'queenzee', 'intake.js'), 'utf8');
  ok(/prepareCxellAuth\(/.test(intake), 'spawnCxell calls prepareCxellAuth');
  ok(/auth\.required && !auth\.ok[\s\S]{0,200}throw new Error/.test(intake),
     'a failed install THROWS out of the cage build (removeCxell + releaseXell + an honest error)');
  const cxellSrc = readFileSync(join(REPO_ROOT, 'server', 'src', 'lib', 'cxell.js'), 'utf8');
  const nudge = cxellSrc.slice(cxellSrc.indexOf('export async function nudgeCxellZee'));
  ok(/prepareCxellAuth\(/.test(nudge.slice(0, 2500)),
     'nudgeCxellZee re-installs before resuming (a cage older than this fix, or a rotated key)');
  ok(/logline\(/.test(nudge.slice(0, 2500)),
     '…and a failure there is LOGGED, not fatal — the continuation still runs');
  ok(/seedCxellFirstRun\(\{ ctx, name, adapter \}\)/.test(intake),
     'spawnCxell seeds the DISPATCHED runtime’s first-run answers (not claude’s, whoever is in the cage)');
  ok(/seed\.required && !seed\.ok[\s\S]{0,300}logline\(/.test(intake)
     && !/seed\.required && !seed\.ok[\s\S]{0,300}throw/.test(intake),
     '…and a failed seed is logged, NOT thrown — it costs a human a keypress, never a dispatch');
} finally {
  delete process.env.DOCKER_FAKE_CXELL_VERDICT;
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);

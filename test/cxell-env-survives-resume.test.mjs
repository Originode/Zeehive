// A CXELL'S ENVIRONMENT MUST SURVIVE A RESUMED TURN — the mechanism, named in code before it changed.
//
// MEASURED IN PRODUCTION (queenzee fleet): a zee's turn died on a deepseek 402 on 09-09 and was
// resumed on 09-12, ~64h later. Inside the resumed cxell a plain Bash sub-shell showed
// ZEEHIVE_XELL_TOKEN ABSENT and every `zee` verb REFUSED ("this shell is not an authenticated
// cxell") — so the zee could not land, ship, tend or report, and could not even call for help.
//
// THE MECHANISM, IN CODE. A cage's env enters by TWO doors (server/src/lib/cxell.js):
//   door 1 — /etc/environment, written ONCE at spawn by openCxellSsh → cxell-sshd.sh (root, 0600).
//            The durable copy: identity token, API address, the every-provider set, the git author.
//   door 2 — the `docker exec -e` env of the TURN: built by runZee at spawn, and REBUILT FROM
//            SCRATCH by nudgeCxellZee on every resume.
// Door 2 is what the turn's Bash sub-shells inherit, and on the resume it re-applied only a SUBSET
// of door 1 — the vendor credential, the gateway base URLs and ZEEHIVE_XELL_TOKEN — reading the
// token back out of door 1 inside a `catch {}` that carried on silently when the read failed. So a
// resumed turn lost ZEEHIVE_API, ZEEHIVE_API_FALLBACK, ZEE_PROVIDER_*/ZEE_PROVIDERS and
// GIT_AUTHOR_NAME/EMAIL, and a resume that could not read the token back ran with NO identity.
// THIS IS RESUME-SPECIFIC: a freshly spawned cage inherits door 2 intact (nothing in /etc/profile,
// /etc/bash.bashrc or /etc/profile.d resets env), and the /etc/environment read-back that was
// supposed to cover non-login shells reads a 0600 ROOT-OWNED file as uid zee — proven in a live cage
// with `test -r` (NOT READABLE) and a node readFileSync (EACCES). That residual is REPORTED, not
// fixed here: the ticket forbids widening any token's reach, and the fix belongs where a resumed
// turn REBUILDS ITS ENVIRONMENT.
//
// THE FIX: one builder, `queenzeeTurnEnv`, fed by both callers from the cage's own door-1 record, so
// the doors cannot drift. Precedence is the pair order — docker keeps the LAST `-e` for a duplicate
// key — so the value the queenzee knows NOW (the API address, the dispatched credential, the current
// identity) beats the spawn-time copy, while what only the cage still holds (the every-provider set,
// the git author, the identity token) survives the resume. The credential keys are DELIBERATELY not
// forwarded from the file: the file's ANTHROPIC_AUTH_TOKEN is the cage's OLD credential and is
// exactly what the vendor guard exists to refuse.
//
// The seam is `docker` itself (test/_bin, DOCKER_FAKE_CAGE_ENV_FILE / _EXIT): no database, no cage.
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'cxenv-'));
const DOCKER_LOG = join(tmp, 'docker.log');
process.env.DOCKER_LOG = DOCKER_LOG;
process.env.PATH = `${join(REPO_ROOT, 'test', '_bin')}:${process.env.PATH}`;

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const section = (t) => console.log(`\n── ${t} ──`);
const readLog = () => (existsSync(DOCKER_LOG) ? readFileSync(DOCKER_LOG, 'utf8') : '');
const clearLog = () => { rmSync(DOCKER_LOG, { force: true }); };
// The resume's exec line, as the shim records it (argv space-joined).
const resumeLine = () => (readLog().split('\n').find((l) => l.includes('--resume')) || '');
const flag = (k) => {                       // the LAST -e <k>=… on the resume line (docker's winner)
  const hits = [...resumeLine().matchAll(new RegExp(`-e ${k}=([^\\s]*)`, 'g'))];
  return hits.length ? hits[hits.length - 1][1] : null;
};

// A FULL cage: everything openCxellSsh writes at spawn, plus two lines the queenzee did NOT write
// (PATH, HOME, and a vendor base URL) that must NOT be forwarded.
const FULL_CAGE = join(tmp, 'environment.full');
writeFileSync(FULL_CAGE, [
  'ANTHROPIC_AUTH_TOKEN=sk-ant-fake-tok',          // the cage's OLD credential — never forwarded
  'ZEEHIVE_XELL_TOKEN=cage-ident-tok',             // the identity that must survive the resume
  'ZEEHIVE_API=http://stale-address.invalid:4700', // wrong NOW — the queenzee knows better
  'ZEEHIVE_API_FALLBACK=http://stale-address.invalid:4700',
  'ZEE_PROVIDER_DEEPSEEK_TOKEN=sk-deepseek-cage-tok',
  'ZEE_PROVIDER_DEEPSEEK_LABEL=DeepSeek',
  'ZEE_PROVIDER_DEEPSEEK_HINT=sk-…',
  'ZEE_PROVIDERS=deepseek,claude',
  'GIT_AUTHOR_NAME=quiet-ember-569521',
  'GIT_AUTHOR_EMAIL=quiet-ember-569521@zeehive.local',
  'PATH=/usr/local/bin:/usr/bin:/bin',             // not ours
  'HOME=/home/zee',                                // not ours
  'ANTHROPIC_BASE_URL=https://file-sentinel.invalid/anthropic', // not ours
].join('\n') + '\n');
// A cage with NO identity line — the resume must SAY so, not run mute.
const TOKENLESS_CAGE = join(tmp, 'environment.tokenless');
writeFileSync(TOKENLESS_CAGE, 'ANTHROPIC_AUTH_TOKEN=sk-ant-fake-tok\nZEE_PROVIDER_CLAUDE_TOKEN=sk-ant-fake-tok\n');

try {
  const { parseCageEnvText, cageEnvForTurn, queenzeeTurnEnv, nudgeCxellZee, CAGE_ENV_PREFIXES } =
    await import('../server/src/lib/cxell.js');
  const RT = await import('../server/src/lib/cxell-runtimes.js');
  const claude = RT.adapterFor('claude-code-cxell');

  // ── 1. the pure parts: parse, allowlist, precedence ─────────────────────────────────────────
  section('parseCageEnvText — a cage file is not a shell, and not every line is ours');
  const parsed = parseCageEnvText('A=1\n# comment\nB=two=3\n\nBAD LINE\nC=\nA=late\n');
  ok(parsed.A === '1', 'a duplicate key keeps the FIRST line (what the old per-key regex match read)');
  ok(parsed.B === 'two=3', 'only the first "=" splits, so a value may contain one');
  ok(parsed.C === '' && !('#' in parsed) && !('BAD LINE' in parsed),
     'a blank value parses as empty; a comment and a line with no "=" are skipped');
  ok(Object.keys(parseCageEnvText('1BAD=x\nOK=y')).join() === 'OK',
     'a key that is not an identifier is refused (nothing un-injectable gets an -e)');
  ok(parseCageEnvText('X=v\r\n').X === 'v', 'a CRLF file trims the CR');

  section('cageEnvForTurn — only the namespaces the queenzee itself wrote');
  const fromFull = cageEnvForTurn(parseCageEnvText(readFileSync(FULL_CAGE, 'utf8')));
  ok(fromFull.ZEEHIVE_XELL_TOKEN === 'cage-ident-tok' && fromFull.ZEE_PROVIDERS === 'deepseek,claude'
     && fromFull.GIT_AUTHOR_NAME === 'quiet-ember-569521',
     'the identity, the every-provider set and the git author ARE forwarded');
  ok(!('PATH' in fromFull) && !('HOME' in fromFull),
     'PATH and HOME are NOT — the cage file is not a source of paths for our turns');
  ok(!('ANTHROPIC_AUTH_TOKEN' in fromFull) && !('ANTHROPIC_BASE_URL' in fromFull),
     'nor any vendor credential or base URL: the file holds the OLD one, and the guard exists '
     + 'precisely to stop a read-back like that reaching the wrong API');
  ok(CAGE_ENV_PREFIXES.every((p) => ['ZEEHIVE_', 'ZEE_', 'GIT_AUTHOR_'].includes(p)),
     'the allowlist is exactly the three prefixes the queenzee writes');

  section('queenzeeTurnEnv — the CURRENT value wins, and no key is ever duplicated');
  const pairs = queenzeeTurnEnv({
    extraEnv: { ZEEHIVE_EXTRA: 'x' },
    cageEnv: parseCageEnvText(readFileSync(FULL_CAGE, 'utf8')),
    credentialEnv: [['ANTHROPIC_AUTH_TOKEN', 'sk-ant-current']],
    gatewayEnvVars: { ANTHROPIC_BASE_URL: 'https://gateway.invalid/x/tok/claude' },
    xellToken: 'current-ident',
    apiBase: 'http://now.invalid:4700',
    apiFallback: 'http://now.invalid:4700',
  });
  const map = new Map(pairs);
  ok(pairs.length === new Set(pairs.map(([k]) => k)).size, 'every key appears ONCE (docker keeps the last)');
  ok(map.get('ANTHROPIC_AUTH_TOKEN') === 'sk-ant-current',
     'the dispatched credential beats the cage file’s stale one');
  ok(map.get('ANTHROPIC_BASE_URL') === 'https://gateway.invalid/x/tok/claude',
     'the gateway base URL is last, so it overrides the adapter’s own');
  ok(map.get('ZEEHIVE_XELL_TOKEN') === 'current-ident',
     'a current identity beats the spawn-time copy in the file');
  ok(map.get('ZEEHIVE_API') === 'http://now.invalid:4700' && map.get('ZEEHIVE_API_FALLBACK') === 'http://now.invalid:4700',
     'the API address the queenzee knows NOW beats the one the cage was born with');
  ok(map.get('ZEE_PROVIDER_DEEPSEEK_TOKEN') === 'sk-deepseek-cage-tok' && map.get('GIT_AUTHOR_EMAIL') === 'quiet-ember-569521@zeehive.local',
     'what only the cage still holds survives — that is the whole point');
  ok(!pairs.some(([, v]) => v === '' || v === null || v === undefined),
     'an empty value is DROPPED, never sent as -e K= (an empty identity is not an identity)');

  // ── 2. the door: the resume, driven through the real fake-docker seam ───────────────────────
  section('nudgeCxellZee — the resumed turn carries the cage’s whole environment');
  process.env.DOCKER_FAKE_CAGE_ENV_FILE = FULL_CAGE;
  clearLog();
  const resumed = await nudgeCxellZee({ ctx: 'default', name: 'cxell_test', sessionId: '1234abcd',
                                        prompt: 'carry on', model: 'opus', adapter: claude }).catch((e) => ({ err: e }));
  ok(!resumed.err, `the resume runs (${resumed.err?.message || 'no throw'})`);
  ok(resumed.identity === 'present', 'the result STATES the identity it ran with');
  ok(flag('ZEEHIVE_XELL_TOKEN') === 'cage-ident-tok',
     'THE SYMPTOM: the resumed turn’s exec carries the cage’s identity token, so its Bash '
     + 'sub-shells can authenticate and `zee status` stops refusing');
  ok(flag('ZEE_PROVIDER_DEEPSEEK_TOKEN') === 'sk-deepseek-cage-tok' && flag('ZEE_PROVIDERS') === 'deepseek,claude',
     'the every-provider set rides along, so `zee creds` inside the resumed turn is not blank');
  ok(flag('GIT_AUTHOR_NAME') === 'quiet-ember-569521',
     'the git author survives, so a commit made after the resume is still attributed to this zee');
  ok(flag('ZEEHIVE_API') && flag('ZEEHIVE_API') !== 'http://stale-address.invalid:4700',
     `the CURRENT api address is applied, not the file's stale copy (got ${flag('ZEEHIVE_API')})`);
  ok(flag('ANTHROPIC_AUTH_TOKEN') === claude.env({ token: 'sk-ant-fake-tok', model: 'opus' }).ANTHROPIC_AUTH_TOKEN,
     'the credential the resume sends is the one the ADAPTER builds from the token it recovered — it '
     + 'went through credentialEnvFor (the vendor guard), not straight out of the file');
  ok(!resumeLine().includes('file-sentinel.invalid'),
     'nor is the file’s vendor base URL forwarded — only the credential door may set one');
  ok(!/-e PATH=/.test(resumeLine()) && !/-e HOME=/.test(resumeLine()),
     'nothing outside the three prefixes leaks in (no PATH, no HOME)');
  delete process.env.DOCKER_FAKE_CAGE_ENV_FILE;

  // ── 3. the failure that used to be SILENT ───────────────────────────────────────────────────
  section('a resume that cannot find an identity says so — it does not run mute');
  process.env.DOCKER_FAKE_CAGE_ENV_FILE = TOKENLESS_CAGE;
  clearLog();
  const noIdent = await nudgeCxellZee({ ctx: 'default', name: 'cxell_test', sessionId: '1234abcd',
                                        prompt: 'carry on', model: 'opus', adapter: claude, token: 'sk-ant-oat01-fake' })
    .catch((e) => ({ err: e }));
  ok(!noIdent.err, 'a tokenless cage still resumes (failing the turn helps nobody)');
  ok(noIdent.identity === 'missing', '…but the result says the identity was MISSING');
  ok(flag('ZEEHIVE_XELL_TOKEN') === null, '…and no identity token is invented for it');
  delete process.env.DOCKER_FAKE_CAGE_ENV_FILE;

  process.env.DOCKER_FAKE_CAGE_ENV_EXIT = '1';
  clearLog();
  const unreadable = await nudgeCxellZee({ ctx: 'default', name: 'cxell_test', sessionId: '1234abcd',
                                           prompt: 'carry on', model: 'opus', adapter: claude, token: 'sk-ant-oat01-fake' })
    .catch((e) => ({ err: e }));
  delete process.env.DOCKER_FAKE_CAGE_ENV_EXIT;
  ok(!unreadable.err && unreadable.identity === 'missing',
     'an UNREADABLE cage env is reported the same way — the old `catch {}` swallowed it whole');

  // ── 4. wiring: one builder, two callers ─────────────────────────────────────────────────────
  section('wiring — the spawn and the resume build door 2 from the SAME function');
  const src = readFileSync(join(REPO_ROOT, 'server', 'src', 'lib', 'cxell.js'), 'utf8');
  ok((src.match(/= queenzeeTurnEnv\(\{/g) || []).length === 2,
     'exactly two callers: runZee (spawn) and nudgeCxellZee (resume)');
  const nudge = src.slice(src.indexOf('export async function nudgeCxellZee'));
  ok(/cageEnv/.test(nudge.slice(0, 3000)) && /parseCageEnvText/.test(nudge.slice(0, 3000)),
     'the resume parses the cage’s own /etc/environment (door 1) rather than an ad-hoc regex');
  ok(!/catch \{ \/\* fall through with whatever the caller gave us \*\/ \}/.test(nudge.slice(0, 3000)),
     '…and the read failure is no longer swallowed by a bare catch that carried on');
  ok(/identity: identTok \? 'present' : 'missing'/.test(nudge),
     'the identity it actually ran with is stated on the result');
} finally {
  delete process.env.DOCKER_FAKE_CAGE_ENV_FILE;
  delete process.env.DOCKER_FAKE_CAGE_ENV_EXIT;
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);

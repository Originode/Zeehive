// THE SPAWN TEMPLATE'S PREP STEPS — what gets INSTALLED into a xell before the zee starts, as data
// a human edits per project, plus the CACHE knobs that decide how fast that is.
//
// Before this module the answer was hard-coded in exactly one place (cxell.js: warmInstallScript):
// `npm ci`, then a web build, for every project of every fleet, and nothing else — ever. Two costs
// came out of that:
//   1. A project that needs anything ELSE (psql to talk to its own db, build-essential for a native
//      module, a python) had every zee discover the gap mid-turn and either work around it or burn
//      the turn installing. `postgresql-client` is the standing example: the binding hands a zee a
//      `psql "postgresql://…"` command and the cage has no psql in it.
//   2. Nothing about HOW the install is done was tunable, so the one lever that makes a spawn fast
//      (a warm shared cache + `--prefer-offline`) could only be turned fleet-wide by an env var.
//
// So: `pool_config.spawn_prep` (migration 121) holds `{ steps, cache }` for the project's spawn
// template. NULL means "the built-in default", which is byte-for-byte today's behaviour — a fleet
// that never opens the editor sees no change at all.
//
// THREE RULES THIS MODULE EXISTS TO KEEP (the first two are inherited from npm-cache.js, and they
// are not style — each one is a fleet-wide outage if it is broken):
//  1. **Best-effort, always.** A prep step that fails may never fail a dispatch or a provision. A
//     zee that has to install something itself is slow; a dispatch that dies because a mirror was
//     down is broken. Every step reports its own outcome and the warm carries on.
//  2. **`npm ci`, NEVER `npm install`, on a tree that HAS a lockfile.** install rewrites
//     package-lock.json, the pool reads that as a dirty worktree and reaps the xell (the live
//     provision→build→reap loop of 2026-07-20), and on the cxell side it hands the zee a dirty tree
//     it did not dirty. The generated script keeps the marker contract (WARM_OK / WARM_CI_FAILED /
//     WARM_INSTALL_FAILED / WARM_LOCK_DIRTY) that lets the queenzee tell lock drift from a network
//     failure — see cxell.js warmCxell.
//  3. **Root and non-root are DIFFERENT scripts.** apt needs uid 0; npm must run as `zee` or every
//     file it writes into /work/repo is root-owned and the zee cannot commit. So an `apt` step is
//     never spliced into the user script — it goes into the root script, which runs first, in its
//     own `docker exec -u 0`.
import { createHash } from 'node:crypto';
import { one } from '../db/pool.js';

// ── the vocabulary ──────────────────────────────────────────────────────────────────────────────
// `kind` is the whole contract between the editor and the script generator. Adding a kind means
// adding it in BOTH halves; there is deliberately no "run this arbitrary thing" escape that is not
// visible as such (kind 'shell', which says root/allow_failure on its face).
export const STEP_KINDS = ['npm', 'npm-run', 'apt', 'shell'];

// What a project gets when it has never been edited: exactly what warmInstallScript did before this
// module existed. Do not "improve" this list — a default is every project's behaviour.
export const DEFAULT_STEPS = [
  { key: 'npm-deps', kind: 'npm', enabled: true, label: 'Node dependencies (npm ci)' },
  { key: 'web-build', kind: 'npm-run', enabled: true, script: 'build --workspace web',
    allow_failure: true, label: 'Prebuild the web bundle' },
];

// The cache knobs. `npm: shared` is the fleet-wide docker volume from npm-cache.js (ticket #7);
// `container` restores a per-container ~/.npm (the escape hatch when a shared cache misbehaves).
//
// prefer_offline defaults OFF, and that is a MEASUREMENT, not caution. It was written ON here, with
// the confident comment that it "is what turns a warm cache into a fast spawn" — then measured in a
// cxell against this repo's own lockfile: cold cache 32s, warm cache 11s, warm cache
// --prefer-offline 16s. The win is the SHARED CACHE (3×); prefer-offline showed nothing above noise,
// because `npm ci` already resolves from the lockfile's pinned URLs and integrity hashes and does
// not revalidate what the cache already holds. It stays as a knob (a partially-warm cache on a slow
// registry is the case it is for), but a DEFAULT is every project's dispatch path and it does not
// get to be there on a plausible story. Off also keeps the promise the migration makes: a NULL
// template is byte-for-byte the behaviour every project already had.
export const DEFAULT_CACHE = { npm: 'shared', npm_prefer_offline: false, npm_omit_dev: false, apt: 'shared' };

// WHEN the prep runs — the difference between "the zee installs it" and "provisioning installed it".
//
//   'dispatch'   the prep runs inside the cage at dispatch, moments before the zee's turn. This is
//                where it has always run, and it is on the CRITICAL PATH: a human waiting for a zee
//                waits for apt and npm too.
//   'image'      the pool BAKES the apt half into a per-project cxell image (base + the template's
//                packages) on its own clock and dispatch just runs that image, so apt costs zero at
//                spawn. The npm half still runs at dispatch — it depends on the branch's lockfile,
//                which the image cannot know.
//   'provision'  'image', PLUS the cage itself is created and fully prepped (npm ci + the prebuild)
//                when the xell is PROVISIONED — hours before anyone claims it. Dispatch then reuses
//                that cage, refreshes the clone in place, finds the marker still valid and installs
//                NOTHING. The cost is real: every pooled xell holds a live container.
//
// Default 'dispatch' — today's behaviour, unchanged, for every project that does not choose.
export const PREP_WHEN = ['dispatch', 'image', 'provision'];
export const DEFAULT_WHEN = 'dispatch';
export const NPM_CACHE_MODES = ['shared', 'container'];
export const APT_CACHE_MODES = ['shared', 'off'];

// Ready-made steps the console offers in its "add" menu. Presets are just steps — nothing here is
// privileged, and a human can equally type an apt package list or a shell line by hand.
export const STEP_PRESETS = [
  { key: 'psql', kind: 'apt', packages: ['postgresql-client'], label: 'psql (postgresql-client)',
    hint: 'a zee is handed a psql DSN in its binding; without this the cage has no psql' },
  { key: 'mysql', kind: 'apt', packages: ['default-mysql-client'], label: 'mysql client' },
  { key: 'redis', kind: 'apt', packages: ['redis-tools'], label: 'redis-cli' },
  { key: 'build-essential', kind: 'apt', packages: ['build-essential', 'python3'], label: 'native build tools (node-gyp)',
    hint: 'for a dependency that compiles at install time' },
  { key: 'jq', kind: 'apt', packages: ['jq'], label: 'jq' },
  // `zee db-sandbox` (ticket #62) starts a REAL postgres inside a cage so a zee can verify database
  // work when its assigned db is unusable — and its first start pays for downloading the postgres
  // binaries. Warming them here turns that into seconds. NOT a default: it is ~60MB per xell, and a
  // project whose zees never touch a database should not pay for it. The package spec and the
  // install prefix are the ones scripts/zee resolves (test/db-sandbox.test.mjs asserts they match) —
  // the prefix is a directory of its OWN, deliberately: an install into /work/repo would rewrite the
  // project's package.json and hand the zee a dirty tree (rule 2, one layer out).
  { key: 'db-sandbox', kind: 'shell', allow_failure: true,
    run: 'npm install --prefix "$HOME/.zeehive/db-sandbox/deps" --no-audit --no-fund embedded-postgres@17.10.0-beta.17',
    label: 'warm `zee db-sandbox` (embedded postgres)',
    hint: 'a real throwaway postgres inside the cage — without this its first start downloads ~60MB' },
  { key: 'npm-deps', kind: 'npm', label: 'Node dependencies (npm ci)' },
  { key: 'web-build', kind: 'npm-run', script: 'build --workspace web', allow_failure: true, label: 'Prebuild the web bundle' },
  { key: 'custom', kind: 'shell', run: 'echo hello', label: 'custom shell', allow_failure: true },
];

const bool = (v, dflt) => (v === undefined || v === null ? dflt : !!v);
const str = (v) => String(v ?? '').trim();
// A step key is an identifier, not a shell fragment: it is echoed into the PREP_STEP markers the
// queenzee parses, so it may not carry whitespace or quoting of its own.
const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/i;
// An apt package name, per Debian policy (plus the `=version` pin apt accepts). Anything else would
// be a shell injection into a ROOT exec — this is the one place where that matters most.
const PKG_RE = /^[a-z0-9][a-z0-9+._-]*(=[a-zA-Z0-9+.:~-]+)?$/;

// ── normalization: the ONE door everything else reads through ────────────────────────────────────
// Throws on anything it cannot make sense of (the API turns that into a 400), so a broken template
// is refused at the edit instead of at 3am in a dispatch. NULL/absent → the built-in default.
export function normalizeSpawnPrep(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : (Array.isArray(raw) ? { steps: raw } : {});
  const steps = [];
  const seen = new Set();
  const list = src.steps === undefined || src.steps === null ? DEFAULT_STEPS : src.steps;
  if (!Array.isArray(list)) throw new Error('spawn_prep.steps must be an array of steps');
  for (const s of list) {
    if (!s || typeof s !== 'object') throw new Error('each spawn_prep step must be an object');
    const kind = str(s.kind);
    if (!STEP_KINDS.includes(kind)) throw new Error(`step kind must be one of: ${STEP_KINDS.join(', ')} (got "${kind}")`);
    const key = str(s.key) || kind;
    if (!KEY_RE.test(key)) throw new Error(`step key "${key}" must be a short identifier (letters, digits, . _ -)`);
    if (seen.has(key)) throw new Error(`duplicate step key "${key}" — each step needs its own`);
    seen.add(key);
    const step = { key, kind, enabled: bool(s.enabled, true), label: str(s.label) || key };
    if (kind === 'apt') {
      const packages = (Array.isArray(s.packages) ? s.packages : str(s.packages).split(/[\s,]+/))
        .map(str).filter(Boolean);
      if (!packages.length) throw new Error(`step "${key}": an apt step needs at least one package`);
      for (const p of packages) {
        if (!PKG_RE.test(p)) throw new Error(`step "${key}": "${p}" is not a valid apt package name`);
      }
      step.packages = packages;
      // apt is uid 0 by definition, and the root script is where it runs. Not a knob.
      step.root = true;
    } else if (kind === 'npm-run') {
      step.script = str(s.script);
      if (!step.script) throw new Error(`step "${key}": an npm-run step needs a script (e.g. "build --workspace web")`);
      if (/[\n\r]/.test(step.script)) throw new Error(`step "${key}": the npm script must be one line`);
      step.allow_failure = bool(s.allow_failure, true);
    } else if (kind === 'shell') {
      step.run = str(s.run);
      if (!step.run) throw new Error(`step "${key}": a shell step needs a command to run`);
      step.root = bool(s.root, false);
      step.allow_failure = bool(s.allow_failure, true);
    } else if (kind === 'npm') {
      // The install of the repo's own dependencies. Rule 2 lives in the generator, not here.
      step.allow_failure = false;
    }
    steps.push(step);
  }
  const c = src.cache && typeof src.cache === 'object' ? src.cache : {};
  const npm = str(c.npm) || DEFAULT_CACHE.npm;
  if (!NPM_CACHE_MODES.includes(npm)) throw new Error(`cache.npm must be one of: ${NPM_CACHE_MODES.join(', ')}`);
  const apt = str(c.apt) || DEFAULT_CACHE.apt;
  if (!APT_CACHE_MODES.includes(apt)) throw new Error(`cache.apt must be one of: ${APT_CACHE_MODES.join(', ')}`);
  const cache = {
    npm,
    npm_prefer_offline: bool(c.npm_prefer_offline, DEFAULT_CACHE.npm_prefer_offline),
    npm_omit_dev: bool(c.npm_omit_dev, DEFAULT_CACHE.npm_omit_dev),
    apt,
  };
  const when = str(src.when) || DEFAULT_WHEN;
  if (!PREP_WHEN.includes(when)) throw new Error(`when must be one of: ${PREP_WHEN.join(', ')}`);
  return { steps, cache, when };
}

// The project's template, already normalized. Any failure (no row, a project id that is not one)
// degrades to the DEFAULT rather than throwing: this sits on the dispatch path, and a spawn must
// never die because a config read did.
export async function spawnPrepFor(projectId) {
  if (!projectId) return normalizeSpawnPrep(null);
  try {
    const row = await one(`SELECT spawn_prep FROM pool_config WHERE project_id=$1`, [projectId]);
    return normalizeSpawnPrep(row?.spawn_prep ?? null);
  } catch {
    return normalizeSpawnPrep(null);
  }
}

export const enabledSteps = (prep) => (prep?.steps || []).filter((s) => s.enabled);
export const hasAptStep = (prep) => enabledSteps(prep).some((s) => s.kind === 'apt');
export const prepWhen = (prep) => (PREP_WHEN.includes(prep?.when) ? prep.when : DEFAULT_WHEN);
// 'image' and 'provision' both want the apt half BAKED; only 'provision' also wants the cage itself
// created and installed ahead of time. Asked as questions so no caller re-derives the ladder.
export const bakesImage = (prep) => prepWhen(prep) !== 'dispatch';
export const prewarmsCage = (prep) => prepWhen(prep) === 'provision';

// Every package the template installs, deduped and SORTED — sorted because this list is hashed into
// an image tag, and {a,b} and {b,a} must not be two images.
export function aptPackages(prep) {
  const pkgs = new Set(enabledSteps(prep).filter((s) => s.kind === 'apt').flatMap((s) => s.packages || []));
  return [...pkgs].sort();
}

// The template's IDENTITY, as far as an install is concerned: which steps run, in what order, with
// which npm flags. It is what the prepped image is tagged with and what the in-cage marker records,
// so "is this cage still prepped for this template?" is a string comparison and not a judgement.
// Deliberately NOT the whole object — a relabelled step, or a cache knob that changes no argv,
// must not throw away an image or a warmed cage.
export function templateHash(prep) {
  const p = prep && prep.steps ? prep : normalizeSpawnPrep(null);
  const material = JSON.stringify({
    steps: enabledSteps(p).map((s) => [s.key, s.kind, s.packages || null, s.script || null, s.run || null, !!s.root]),
    flags: npmInstallFlags(p.cache),
  });
  return createHash('sha1').update(material).digest('hex').slice(0, 12);
}

// ── the npm flags the cache knobs buy ────────────────────────────────────────────────────────────
// Returned as an ARRAY so the host-side warm (which spawns npm directly) and the in-cage script
// (which pastes them into a shell line) cannot drift apart.
export function npmInstallFlags(cache = DEFAULT_CACHE) {
  const c = { ...DEFAULT_CACHE, ...(cache || {}) };
  const flags = ['--no-audit', '--no-fund'];
  if (c.npm_prefer_offline) flags.push('--prefer-offline');
  if (c.npm_omit_dev) flags.push('--omit=dev');
  return flags;
}

// ── the scripts ─────────────────────────────────────────────────────────────────────────────────
// Pure functions: what runs in a cage is assertable without a docker daemon (the same stance
// warmInstallScript took, and the reason ticket #14 was provable at all).

// Timing, per step, as a marker the queenzee parses: `PREP_STEP <key> <status> <secs>`. This is the
// "what should we optimize?" evidence — without it a slow spawn is one number with no breakdown,
// and the honest answer to "which step costs the minute" was a guess.
const timed = (key, body, { allowFailure = false } = {}) =>
  `__t0=$(date +%s); if ${body}; then echo "PREP_STEP ${key} ok $(( $(date +%s) - __t0 ))"; `
  + `else echo "PREP_STEP ${key} failed $(( $(date +%s) - __t0 ))"; ${allowFailure ? 'true' : 'false'}; fi`;

// THE ROOT HALF: apt (and any step a human marked root). Runs in its own `docker exec -u 0` BEFORE
// the user half, with egress still open (the firewall is sealed after the warm). Returns null when
// the template asks for nothing root — then no root exec happens at all, which is the state every
// fleet is in today.
// `aptBaked` says the prepped image already carries the packages (when: image/provision), so the
// apt steps are DROPPED here rather than reinstalled — that is the whole point of baking them. Any
// non-apt root step still runs: an image cannot bake a shell line that touches this xell's tree.
export function prepRootScript(prep, { aptCache = true, aptBaked = false } = {}) {
  const steps = enabledSteps(prep).filter((s) => s.root).filter((s) => !(aptBaked && s.kind === 'apt'));
  if (!steps.length) return null;
  const apt = steps.filter((s) => s.kind === 'apt');
  const lines = ['set +e'];
  if (apt.length) {
    // A mounted cache volume comes up EMPTY, and apt refuses to run without its `partial` dir. And
    // Debian's images ship /etc/apt/apt.conf.d/docker-clean, which deletes every .deb the moment it
    // is installed — which would make the cache mount pointless rather than broken, i.e. invisible.
    if (aptCache) {
      lines.push('mkdir -p /var/cache/apt/archives/partial');
      lines.push('printf \'Binary::apt::APT::Keep-Downloaded-Packages "true";\\n\' > /etc/apt/apt.conf.d/99zeehive-keep-cache');
    }
    lines.push('export DEBIAN_FRONTEND=noninteractive');
    lines.push(timed('apt-update', 'apt-get update -qq', { allowFailure: true }));
  }
  for (const s of steps) {
    const body = s.kind === 'apt'
      ? `apt-get install -y --no-install-recommends ${s.packages.join(' ')}`
      // A SUBSHELL, never a brace group: `exit 1` inside a brace group exits the whole script —
      // so one custom step that ends in `exit` would silently swallow every step after it (found by
      // test/spawn-prep.test.mjs running the generated script, which asserting the string could not).
      : `( ${s.run} )`;
    // Every root step is allow-failure at the SCRIPT level: rule 1. The marker says which one died,
    // and the queenzee logs it — a missing package is a slower zee, never a failed dispatch.
    lines.push(timed(s.key, body, { allowFailure: true }));
  }
  lines.push('echo PREP_ROOT_DONE');
  return lines.join('\n');
}

// WHERE A PREPPED CAGE RECORDS WHAT IT IS PREPPED FOR. Outside the repo on purpose: anything
// written INSIDE /work/repo shows up in the zee's `git status` as untracked junk it did not create
// (golden rule 7 — keep scratch out of the repo), and a marker that makes the tree look dirty would
// be worse than the install it saves.
export const PREP_MARKER = '/work/.zeehive-prep.json';

// "Is this cage already prepped for THIS branch state and THIS template?" — as one shell condition,
// because the answer has to be decided inside the cage where the files are. Three things must all
// hold: the marker exists and names this template hash, the lockfile is byte-identical to the one
// that was installed, and node_modules is actually still there. Any doubt → reinstall; a wasted
// `npm ci` costs a minute, a WRONGLY skipped one hands the zee a tree that cannot build.
const prepFreshCondition = (hash) =>
  '[ -f ' + PREP_MARKER + ' ] && [ -d node_modules ] '
  + `&& grep -q '"template":"${hash}"' ${PREP_MARKER} `
  + `&& grep -q "\\"lock\\":\\"$(sha1sum package-lock.json 2>/dev/null | cut -c1-40)\\"" ${PREP_MARKER}`;

// …and how it is written after a successful prep. sha1 of the lockfile, the template hash, a
// timestamp for a human reading it over ssh.
const writeMarkerCmd = (hash) =>
  `printf '{"template":"${hash}","lock":"%s","at":"%s"}\\n' `
  + '"$(sha1sum package-lock.json 2>/dev/null | cut -c1-40)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
  + `> ${PREP_MARKER} 2>/dev/null || true`;

// THE USER HALF: everything that must run as `zee` in /work/repo. This is warmInstallScript's body,
// generated from the template instead of hard-coded — and with the DEFAULT template it produces the
// same script, marker for marker, as the version that was hard-coded here.
//
// OPTIONS (all off by default, so the no-argument call is byte-for-byte the old hard-coded script):
//   hash    the template hash to write into / check against the marker (spawn-prep: templateHash)
//   reuse   SKIP the install when the marker says this cage is already prepped for this lockfile
//           and template — the dispatch half of `when: 'provision'`, and the only reason a
//           pre-warmed cage is worth anything
//   mark    WRITE the marker after a successful run — the provision half
export function prepUserScript(prep, repoDir = '/work/repo', { hash = null, reuse = false, mark = false } = {}) {
  const p = prep && prep.steps ? prep : normalizeSpawnPrep(null);
  const steps = enabledSteps(p).filter((s) => !s.root);
  const flags = npmInstallFlags(p.cache).join(' ');
  const parts = [`cd ${repoDir} && echo "npm cache: $(npm config get cache)" && `];
  // ONE definition of "is the lockfile still as we found it?", hoisted to the head of the script and
  // called on every way out of the locked branch — the successful one, the failed one, and (with
  // `reuse`) the branch that skipped the install altogether. It used to be defined INSIDE the npm
  // branch, which was fine until that branch became skippable: the tail then called a function that
  // did not exist, the && chain died, and a perfectly good prepped cage reported a failed warm.
  if (steps.some((x) => x.kind === 'npm')) {
    parts.push('lockstate() { if [ -n "$(git status --porcelain package-lock.json 2>/dev/null)" ]; then echo WARM_LOCK_DIRTY; fi; }; ');
  }
  // The reuse check runs ONCE, before any step, and only decides the npm/npm-run steps below.
  if (reuse && hash) parts.push(`if ${prepFreshCondition(hash)}; then PREPPED=1; fi; `);
  for (const s of steps) {
    if (s.kind === 'npm') {
      // A prepped cage says so and moves on. `npm ci` DELETES node_modules before it installs, so
      // "run it anyway, it will be quick" is not a thing that exists — reuse or reinstall.
      if (reuse && hash) {
        parts.push(`if [ -n "$PREPPED" ]; then echo "PREP_STEP ${s.key} reused 0"; LOCKED=1; else `);
      }
      parts.push(
        // The guarantee is "the warm never dirties the lockfile", so the check that proves it must
        // not be reachable only when the install succeeded: a `ci` that died having already touched
        // the lock is exactly the case nobody could see. LOCKED is only set where a lockfile exists —
        // where there was none, `npm install` legitimately CREATES one and `git status` would call
        // that a change.
        'if [ -f package-lock.json ]; then LOCKED=1; '
        // no `|| npm install` — rule 2. The marker lets the caller tell lock drift from a network
        // failure without parsing npm's prose twice.
        + `__t0=$(date +%s); npm ci ${flags} || { echo "WARM_CI_FAILED"; lockstate; exit 1; }; `
        + `echo "PREP_STEP ${s.key} ok $(( $(date +%s) - __t0 ))"; `
        + 'else echo "no package-lock.json — npm install (nothing to rewrite)"; '
        + `npm install ${flags} || { echo "WARM_INSTALL_FAILED"; exit 1; }; fi${reuse && hash ? '; fi' : ''} && `);
    } else if (s.kind === 'npm-run') {
      // The prebuild is skipped on a prepped cage too — it produced its artefact when the cage was
      // prepped, and re-running it is the second-largest cost in a spawn after the install.
      const run = timed(s.key, `npm run ${s.script} >/dev/null 2>&1`, { allowFailure: s.allow_failure !== false });
      parts.push(reuse && hash
        ? `{ if [ -n "$PREPPED" ]; then echo "PREP_STEP ${s.key} reused 0"; else ${run}; fi; } && `
        : `${run} && `);
    } else if (s.kind === 'shell') {
      // Subshell, not a brace group — see prepRootScript: a step ending in `exit` must end THAT
      // step, not the warm, or the steps after it vanish without a marker.
      parts.push(`${timed(s.key, `( ${s.run} )`, { allowFailure: s.allow_failure !== false })} && `);
    }
  }
  // Prove the tree is as clean as we found it. Nothing above should touch the lockfile; if that ever
  // changes, this is what says so instead of a zee discovering it in `git status`.
  parts.push('if [ -n "$LOCKED" ]; then lockstate; fi && ');
  // Record what this cage now holds, so a later dispatch can skip the whole thing. Best-effort by
  // construction (`|| true`): a marker that could not be written means the next dispatch reinstalls,
  // which is exactly today's behaviour and never wrong — only slower.
  if (mark && hash) parts.push(`${writeMarkerCmd(hash)} && `);
  parts.push('echo WARM_OK');
  return parts.join('');
}

// The PREP_STEP markers, parsed back into rows. Exported because the same shape is what the console
// and the queenzee log show: key, whether it worked, and how many seconds it cost.
export function parsePrepSteps(out) {
  const rows = [];
  for (const line of String(out || '').split('\n')) {
    // 'reused' is a third outcome, not a flavour of ok: it is the whole evidence that `when:
    // 'provision'` did its job, and a report that folded it into 'ok' could not tell a spawn that
    // installed nothing from one that installed everything in the same number of seconds.
    const m = /^\s*PREP_STEP\s+(\S+)\s+(ok|failed|reused)\s+(\d+)\s*$/.exec(line);
    if (m) rows.push({ key: m[1], status: m[2], ok: m[2] !== 'failed', seconds: Number(m[3]) });
  }
  return rows;
}

// A one-line summary for the dispatch log: which steps ran, how long each took, which failed. This
// is the answer to "the spawn took four minutes — where did it go?".
//
// A step the TEMPLATE marked allow-failure (the web prebuild is one, by default) is reported as
// `optional` rather than FAILED. That is not softening: the word FAILED in a spawn log means "go
// look", and a best-effort prebuild that did not run is the normal, expected outcome on a project
// that has no web workspace. Everything else — an apt install, a step a human said must succeed —
// keeps FAILED, and the root half logs its own loud line besides.
export function summarizePrepSteps(rows, prep = null) {
  if (!rows?.length) return '';
  const byKey = new Map((prep?.steps || []).map((s) => [s.key, s]));
  const total = rows.reduce((n, r) => n + (Number(r.seconds) || 0), 0);
  const mark = (r) => {
    if (r.status === 'reused') return ' (reused — prepped at provision)';
    if (r.ok) return '';
    const s = byKey.get(r.key);
    return s && s.kind !== 'apt' && s.allow_failure === true ? ' (optional, skipped)' : ' FAILED';
  };
  return `${rows.map((r) => `${r.key} ${r.seconds}s${mark(r)}`).join(', ')} (${total}s total)`;
}

// ── the PREPPED IMAGE: the apt half, baked once instead of installed per spawn ───────────────────
//
// `when: 'image'` (and 'provision') moves the apt work off the dispatch path entirely: the pool
// builds base + packages ONCE, tags it by what went into it, and every cage of that project starts
// from an image that already has psql in it. The two pure halves live here so a test can assert the
// tag and the Dockerfile without a docker daemon; ensurePreppedImage (cxell.js) does the build.
//
// The TAG carries the hash of (base image + package list), so:
//   * two projects wanting the same packages share one image — the pool builds it once for both;
//   * changing the template makes a NEW tag, and the old cages keep working off the old one until
//     they are reaped. Nothing is mutated in place, so there is no window where a cage's image and
//     its template disagree about what is installed.
export function preppedImageTag(baseImage, prep) {
  const pkgs = aptPackages(prep);
  if (!pkgs.length) return null;          // nothing to bake → the base image IS the prepped image
  const base = String(baseImage || '').trim() || 'zeehive/zee-agent';
  const hash = createHash('sha1').update(`${base}\n${pkgs.join(' ')}`).digest('hex').slice(0, 10);
  return `zeehive/zee-agent-prep:${hash}`;
}

// ONE RUN layer, packages sorted (so the tag and the build agree), lists cleaned up after — this is
// an image a fleet keeps, not a cache. `--no-install-recommends` and DEBIAN_FRONTEND for the same
// reasons the in-cage script uses them.
export function preppedDockerfile(baseImage, prep) {
  const pkgs = aptPackages(prep);
  if (!pkgs.length) return null;
  return [
    `FROM ${String(baseImage || '').trim() || 'zeehive/zee-agent'}`,
    '# GENERATED by ZEEHIVE from a project spawn template (pool_config.spawn_prep, migration 121).',
    '# Do not edit: it is rebuilt whenever the template\'s package list changes, under a new tag.',
    'USER root',
    'ENV DEBIAN_FRONTEND=noninteractive',
    `RUN apt-get update && apt-get install -y --no-install-recommends ${pkgs.join(' ')} \\`,
    ' && rm -rf /var/lib/apt/lists/*',
    // Back to the non-root user the cage runs as. The base image sets it; being explicit here means
    // a base that ever stops doing so cannot silently hand a zee a root cage.
    'USER zee',
  ].join('\n') + '\n';
}

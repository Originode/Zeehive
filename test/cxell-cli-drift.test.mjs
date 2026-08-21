// CXELL-CLI-DRIFT test — the class of bug that stranded a manager zee in its cage, and the class
// that then hid the fix from production for a whole ship.
//
// Act one: `zee dispatch` answered "unknown command: dispatch" in EVERY cxell, because the CLI
// baked into zeehive/zee-agent was a hand-synced DUPLICATE (docker/zeehive/zee) that had never seen
// the commit adding the crew verbs to the authoritative scripts/zee. The server side was fine; the
// code simply never reached the cage. A Dockerfile comment ("Update both if you change it") was the
// only thing holding it together, and it failed on the first change that mattered.
//
// Act two: the fix shipped and STILL did not reach the cage. The host self-ship rebuilt the image
// from the working tree, which the landing gate leaves at PRE-LANDING code (it moves the ref with
// update-ref), so every layer hit cache and the "rebuild" produced a byte-identical image — while
// the ship card said success. Two zees found it by comparing baked-file mtimes across two cages.
//
// So this test asserts the MECHANISM at every hop the code takes to reach a running zee:
//   a) there is exactly ONE copy of the CLI, and Dockerfile.zee-agent COPYs the authoritative one
//      (re-introducing a duplicate anywhere under docker/ fails here);
//   b) the two build paths can each actually satisfy every COPY — the SHIP path (a `git archive`
//      of the ship ref piped into `docker build -`, implemented once and shared) and the CI/manual
//      path (a repo-root directory context, where .dockerignore applies and must not exclude a
//      COPY source);
//  b2) a failed cxell-image rebuild FAILS THE SHIP rather than being whispered into a log;
//   c) usage-vs-implementation inside scripts/zee: every advertised verb has a `case`, and every
//      case is advertised — the same drift one level in;
//   d) the spawn path installs the queenzee's own CLI into each cxell, and SAYS SO when the image
//      it booted from is stale (the check that would have caught act two);
//   e) usage-vs-MANUAL: every verb the CLI advertises is documented in the manual of the zee type
//      that has it — the hop this test was missing. `zee harness` (084) reached the CLI and the API
//      with every manual silent, so the fleet's managers had a verb they could not know they had and
//      nothing went red. House rule 8 is "what a zee is told is versioned like code"; (c) only ever
//      compared the CLI against itself, which is one document short of that.
//
// Static + unit assertions plus one real `git archive`, and — for (e) — the meta-DB, because since
// 080 a manual is a harness memory entry rather than a file. No docker, no network.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// Section (e) lints the MANUALS, and a manual is a row in the meta-DB (080) — there is no file to
// read. Exit 2 ("could not run") rather than skipping: a lint that quietly checks nothing is how the
// drift in act three got in.
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL required — the manuals this file lints live in the meta-DB (see §e)');
  process.exit(2);
}

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const DOCKERFILE = 'docker/zeehive/Dockerfile.zee-agent';
const CLI = 'scripts/zee';
const IMAGE_LIB = 'scripts/lib/cxell-image.sh';
const SHIP_SCRIPTS = ['scripts/self-ship.sh', 'scripts/self-ship-container.sh'];
const dockerfile = read(DOCKERFILE);
const cli = read(CLI);

// ── (a) ONE copy of the CLI, and it PARSES ────────────────────────────────────────────────────
console.log('\n── one source of truth for the cxell CLI ──');
ok(existsSync(join(ROOT, CLI)), `the authoritative CLI lives at ${CLI}`);

// It must at least be valid JavaScript. This file is not imported by anything the test suite ran,
// so a syntax error in it passed every check and LANDED: an unescaped backtick inside usage()'s
// template literal ("… then `zee sync`") closed the string, and `zee` became a SyntaxError. The
// queenzee installs this exact file into every cxell it spawns, so that one character takes every
// verb away from every new zee — status, land, ship, tend — with no way to ask for help but the
// one command that no longer runs. One `node --check` is the whole guard.
{
  const r = spawnSync(process.execPath, ['--check', join(ROOT, CLI)], { encoding: 'utf8' });
  ok(r.status === 0, `${CLI} is syntactically valid JS — every cxell's only door out runs it`
    + (r.status === 0 ? '' : `\n      ${String(r.stderr).split('\n').slice(0, 3).join('\n      ')}`));
}

// Walk docker/ for any file that looks like the CLI (a node script wrapping /api/xell/self/*).
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && statSync(p).size < 1 << 20) out.push(p);
  }
  return out;
}
const cliLike = walk(join(ROOT, 'docker')).filter((p) => {
  const t = readFileSync(p, 'utf8');
  return t.includes('/api/xell/self/') && t.includes('#!/usr/bin/env node');
});
ok(cliLike.length === 0,
   `no second copy of the CLI under docker/ (found: ${cliLike.map((p) => p.slice(ROOT.length + 1)).join(', ') || 'none'})`);
ok(!existsSync(join(ROOT, 'docker/zeehive/zee')),
   'the old hand-synced docker/zeehive/zee duplicate is gone (and must not come back)');

// The image must bake the AUTHORITATIVE file, not some other path.
const copies = [...dockerfile.matchAll(/^COPY\s+(?:--\S+\s+)*(\S+)\s+(\S+)\s*$/gm)]
  .map(([, src, dest]) => ({ src, dest }));
ok(copies.length > 0, `${DOCKERFILE} has COPY instructions to check (${copies.length})`);
const zeeCopy = copies.find((c) => c.dest === '/usr/local/bin/zee');
ok(!!zeeCopy, 'the image COPYs something to /usr/local/bin/zee');
ok(zeeCopy?.src === CLI, `and its source is the authoritative ${CLI} (got: ${zeeCopy?.src})`);
ok(/eol=lf/.test(read('.gitattributes').split('\n').find((l) => l.startsWith(`${CLI} `)) || ''),
   `.gitattributes pins ${CLI} to LF (the CRLF shebang protection follows the real file)`);
const gaPins = read('.gitattributes').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
ok(!gaPins.some((l) => l.startsWith('docker/zeehive/zee')),
   '.gitattributes no longer PINS the deleted duplicate (a comment about it is fine)');

// ── (b) the two build paths, and what each one actually feeds docker ──────────────────────────
//
// Two shapes, deliberately:
//   * the SHIP path (scripts/lib/cxell-image.sh, sourced by both self-ship variants) pipes a
//     `git archive <ship-sha>` tar into `docker build -`. It CANNOT read the working tree — which
//     on a host ship is still pre-landing code, the defect that made a "successful" rebuild rebuild
//     nothing. .dockerignore does not apply to a stdin context and does not need to: a git archive
//     carries exactly the tracked files.
//   * the CI/manual path (publish-images.yml, the android variant's documented commands) passes the
//     repo ROOT as a directory context, where .dockerignore very much does apply.
console.log('\n── the ship path: one shared implementation, context = the SHIP REF ──');
const imageLib = read(IMAGE_LIB);

// No second copy of the rebuild logic: exactly ONE file may run a docker build of the cxell image.
// (a `docker compose build server` in the container variant builds the QUEENZEE image, not the
// cxell image — the marker for this one is the zee-agent Dockerfile or the CXELL_IMAGE tag.)
const builders = [...SHIP_SCRIPTS, IMAGE_LIB].filter((rel) => read(rel).split('\n').some((l) =>
  !l.trim().startsWith('#') && !/^\s*echo/.test(l.trim())
  && /\bdocker\b[^\n]*\bbuild\b/.test(l) && /Dockerfile\.zee-agent|CXELL_IMAGE/.test(l)));
ok(builders.length === 1 && builders[0] === IMAGE_LIB,
   `exactly one file implements the cxell-image build — ${IMAGE_LIB} (found: ${builders.join(', ') || 'none'})`);
for (const rel of SHIP_SCRIPTS) {
  ok(/^\s*(?:\.|source)\s+"[^\n]*lib\/cxell-image\.sh"/m.test(read(rel)),
     `${rel} SOURCES the shared implementation instead of carrying its own copy`);
  ok(read(rel).includes('rebuild_cxell_image'), `${rel} calls rebuild_cxell_image`);
}
// The context must come from the ship ref, never from the working tree.
ok(/git -C "\$SRC" archive/.test(imageLib), 'the context is materialized with `git archive` from the ship ref');
ok(/docker[^\n]*build[^\n]*-f "\$CXELL_IMAGE_DOCKERFILE"[^\n]*-t "\$CXELL_IMAGE" -/.test(imageLib),
   'and fed to `docker build -` (a stdin tar), so it cannot pick up the working tree');
ok(!/^[^#\n]*docker[^\n]*build[^\n]*"\$SRC"/m.test(imageLib),
   'the working tree ($SRC) is never passed as a build context any more');
ok(/rev-parse --verify "\$\{REF\}\^\{commit\}"/.test(imageLib),
   'the ship ref is resolved to a sha up front (never a moving ref)');
ok(/cat-file -e "\$\{sha\}:\$\{CXELL_IMAGE_DOCKERFILE\}"/.test(imageLib),
   'and the Dockerfile is checked AT THAT SHA, not on disk (the disk is the wrong tree here)');

// THE REAL CHECK, executed: does a git archive of HEAD actually carry everything the Dockerfile
// COPYs? That archive IS the ship context, byte for byte — so this assertion is the mechanism.
const tarList = execFileSync('sh', ['-c', 'git archive --format=tar HEAD | tar -t'],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n').filter(Boolean);
const tarSet = new Set(tarList.map((l) => l.replace(/\/$/, '')));
ok(tarSet.has(DOCKERFILE), `the ship context contains ${DOCKERFILE} itself (-f resolves inside a stdin context)`);
const notInArchive = copies.filter((c) => !tarSet.has(c.src));
ok(notInArchive.length === 0,
   `the ship context contains every COPY source (${notInArchive.map((c) => c.src).join(', ') || `all ${copies.length} present`})`);
ok(!tarList.some((l) => l.startsWith('node_modules/') || l.startsWith('.git/')),
   'and none of the junk .dockerignore used to exclude (untracked → never in a git archive)');

console.log('\n── the CI/manual path: a directory context, where .dockerignore applies ──');
// A .dockerignore matcher with docker's semantics: a leading ! is an exception, LAST match wins,
// ** spans directories, * does not. Unit-tested below against synthetic patterns first, so the real
// assertion means something instead of silently matching nothing.
const DSTAR = '';
function ignoreRegex(pattern) {
  let s = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  s = s.replace(/\*\*/g, DSTAR).replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  s = s.split(`${DSTAR}/`).join('(?:.*/)?').split(DSTAR).join('.*');
  return new RegExp(`^${s}(?:/.*)?$`);
}
function dockerignoreExcludes(path, lines) {
  let excluded = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const neg = line.startsWith('!');
    const pat = (neg ? line.slice(1) : line).replace(/^\.\//, '').replace(/\/$/, '');
    if (ignoreRegex(pat).test(path)) excluded = !neg;    // last match wins
  }
  return excluded;
}
ok(dockerignoreExcludes('node_modules/x/y.js', ['node_modules']), 'matcher: a bare dir pattern excludes its contents');
ok(dockerignoreExcludes('web/a/node_modules/x', ['**/node_modules']), 'matcher: **/ spans directories');
ok(dockerignoreExcludes('build.log', ['*.log']) && !dockerignoreExcludes('build.txt', ['*.log']),
   'matcher: * globs within a segment');
ok(!dockerignoreExcludes('scripts/zee', ['scripts/*.sh']), 'matcher: * does not cross a segment boundary');
ok(dockerignoreExcludes('scripts/zee', ['scripts']),
   'matcher: the regression case — ignoring scripts/ would silently hide the CLI from the image');
ok(!dockerignoreExcludes('scripts/zee', ['scripts', '!scripts/zee']), 'matcher: a later ! exception wins');
// the real assertion: nothing the Dockerfile COPYs may be excluded from a root-context build
const ignoreLines = existsSync(join(ROOT, '.dockerignore')) ? read('.dockerignore').split('\n') : [];
ok(ignoreLines.length > 0, '.dockerignore exists (a root context without it uploads the world)');
const ignored = copies.filter((c) => dockerignoreExcludes(c.src, ignoreLines));
ok(ignored.length === 0,
   `.dockerignore excludes NONE of the COPY sources (${ignored.map((c) => c.src).join(', ') || `all ${copies.length} survive`})`);
ok(!dockerignoreExcludes(DOCKERFILE, ignoreLines), 'and it does not exclude the Dockerfile itself');

// the publish-images workflow's matrix entry for the zee-agent image
const wf = read('.github/workflows/publish-images.yml');
const entry = wf.split(/- image:/).find((b) => b.includes('Dockerfile.zee-agent') && !b.includes('zee-agent-android'));
ok(!!entry, 'publish-images.yml has a zee-agent matrix entry');
const wfCtx = entry?.match(/context:\s*(\S+)/)?.[1];
ok(wfCtx === '.', `the workflow builds it from the repo root (context: ${wfCtx})`);
const missingOnDisk = copies.filter((c) => !existsSync(resolve(ROOT, wfCtx || '.', c.src)));
ok(missingOnDisk.length === 0,
   `every COPY source resolves under the workflow's context (${missingOnDisk.map((m) => m.src).join(', ') || 'all present'})`);
// And the android variant, which FROMs the base, must document the SAME context.
const android = read('docker/zeehive/Dockerfile.zee-agent-android');
const androidCmds = [...android.matchAll(/docker build -f (\S+)\s+-t\s+(\S+)\s+(\S+)/g)];
ok(androidCmds.length === 2, 'the android variant documents both build commands');
ok(androidCmds.every((m) => m[3] === '.'),
   'and both are documented with the repo-root context (they would not build otherwise)');

// ── (b2) a failed rebuild must FAIL THE SHIP, not be whispered into a log ─────────────────────
console.log('\n── a failed cxell-image rebuild fails the ship (escape hatch: CXELL_IMAGE_REQUIRED=0) ──');
ok(/cxell_image_required\(\)\s*{\s*\[\s*"\$\{CXELL_IMAGE_REQUIRED:-1\}"\s*!=\s*"0"\s*\]/.test(imageLib),
   'fatal is the DEFAULT (CXELL_IMAGE_REQUIRED unset → the rebuild is required)');
for (const rel of SHIP_SCRIPTS) {
  const text = read(rel);
  ok(/if\s*!\s*rebuild_cxell_image;\s*then/.test(text), `${rel} branches on the rebuild's exit status`);
  ok(/cxell_image_required/.test(text), `${rel} consults the escape hatch before deciding`);
  ok(/emit false[^\n]*cxell-image-failed/.test(text), `${rel} emits ok:false with method=cxell-image-failed`);
}
// shipgate turns that JSON into a FAILED ship — assert the contract the scripts rely on.
const shipgate = read('server/src/queenzee/shipgate.js');
ok(/json\.ok\s*!==\s*false/.test(shipgate),
   'shipgate marks a build failed when the script emits ok:false (the contract the scripts rely on)');
ok(/ok \? 'shipped' : 'failed'/.test(shipgate), 'and writes that verdict onto the ship_request row a human reads');
// the host variant must decide BEFORE scheduling the restart — otherwise "fatal" still half-ships
const hostShip = read('scripts/self-ship.sh');
ok(hostShip.indexOf('if ! rebuild_cxell_image') < hostShip.indexOf('powershell.exe'),
   'the host variant decides the image BEFORE it schedules the detached restart (nothing half-applied)');
ok(/CXELL_IMAGE_REQUIRED/.test(read('docs/deploy-topology-spec.md')),
   'and the escape hatch is documented in the deploy spec, not just in the script');

// ── (c) usage text vs implemented cases, inside scripts/zee ───────────────────────────────────
console.log('\n── scripts/zee: every advertised verb is implemented, and vice versa ──');
const usageBlock = cli.slice(cli.indexOf('function usage()'), cli.indexOf('switch (cmd)'));
const advertised = new Set([...usageBlock.matchAll(/^\s{2,}zee ([a-z][a-z0-9-]*)/gm)].map((m) => m[1]));
const implemented = new Set([...cli.matchAll(/^\s*(?:case '[a-z0-9-]+':\s*)*case '([a-z0-9-]+)':/gm)].map((m) => m[1]));
for (const m of cli.matchAll(/case '([a-z0-9-]+)':/g)) implemented.add(m[1]);
implemented.delete('help');   // documented in the usage BODY, not as a verb line
ok(advertised.size >= 15, `usage advertises the full verb set (${advertised.size} verbs)`);
const unimplemented = [...advertised].filter((v) => !implemented.has(v));
ok(unimplemented.length === 0, `every advertised verb has a case (missing: ${unimplemented.join(', ') || 'none'})`);
const undocumented = [...implemented].filter((v) => !advertised.has(v));
ok(undocumented.length === 0, `every implemented verb is advertised (undocumented: ${undocumented.join(', ') || 'none'})`);
// The verbs whose absence WAS the bug — named explicitly so a regression is unmistakable.
for (const v of ['zees', 'dispatch', 'say', 'report', 'inbox', 'suggest-done']) {
  ok(advertised.has(v) && implemented.has(v), `crew verb "${v}" is both advertised and implemented`);
}

// ── (d) the spawn path installs the queenzee's own CLI into the cxell ─────────────────────────
console.log('\n── spawn installs the queenzee\'s own CLI over the image\'s baked copy ──');
const { zeeCliSourcePath, zeeCliInstallCommands, ZEE_CLI_DEST, installZeeCliIntoCxell } =
  await import('../server/src/lib/cxell.js');
ok(typeof installZeeCliIntoCxell === 'function', 'cxell.js exports installZeeCliIntoCxell');
ok(zeeCliSourcePath() === join(ROOT, 'scripts', 'zee').replace(/\\/g, '/')
   || resolve(zeeCliSourcePath()) === resolve(ROOT, 'scripts', 'zee'),
   `it installs FROM the authoritative CLI, resolved from the repo root (${zeeCliSourcePath()})`);
ok(!/['"][A-Za-z]:[\\/]|\/repos\//.test(read('server/src/lib/cxell.js').match(/zeeCliSourcePath = [^\n]*/)?.[0] || ''),
   'the source path is resolved (config.repoRoot), never hardcoded');
ok(ZEE_CLI_DEST === '/usr/local/bin/zee', 'and it lands on the CLI the cxell zee actually runs');
const cmds = zeeCliInstallCommands({ name: 'cxell_test-slug' });
ok(cmds[0][0] === 'cp' && cmds[0][2] === 'cxell_test-slug:/tmp/zee.cli',
   'step 1 is a `docker cp` of the CLI into the container');
ok(cmds[0][1] === zeeCliSourcePath(), 'copying the queenzee\'s own scripts/zee');
const shell = cmds[1].join(' ');
ok(cmds[1].slice(0, 3).join(' ') === 'exec -u 0', 'step 2 execs as ROOT (the zee cannot rewrite its own CLI)');
ok(/sed -i 's\/\\r\$\/\/'/.test(shell), 'it strips a trailing CR (a Windows checkout would kill the shebang)');
ok(/-o root -g root/.test(shell) && /0755/.test(shell), 'installs it root-owned and executable');
ok(shell.includes(ZEE_CLI_DEST), `over ${ZEE_CLI_DEST}`);

// the spawn path calls it, and does not let a failure sink the cage
const intake = read('server/src/queenzee/intake.js');
ok(/import\s*{[^}]*installZeeCliIntoCxell[^}]*}\s*from\s*'\.\.\/lib\/cxell\.js'/s.test(intake),
   'intake.js (spawnCxell) imports installZeeCliIntoCxell');
ok(intake.includes('await installZeeCliIntoCxell('), 'and calls it on the spawn path');
const around = intake.slice(intake.indexOf('await cloneIntoCxell('), intake.indexOf('await warmCxell('));
ok(around.includes('await installZeeCliIntoCxell('), 'right after the repo is cloned in, before the zee runs');
ok(/logline\('cxell',[\s\S]{0,300}?zee CLI/.test(intake), 'and logs the outcome to the queenzee log (loud, not silent)');
const cxellLib = read('server/src/lib/cxell.js');
const fn = cxellLib.slice(cxellLib.indexOf('export async function installZeeCliIntoCxell'));
ok(/try\s*{/.test(fn.slice(0, 1800)) && /catch/.test(fn.slice(0, 2400)),
   'the install is best-effort (a failed refresh must not sink a cxell spawn)');
ok(/logline\('cxell'[^]*?!!!/.test(fn.slice(0, 2400)), 'but a failure is logged LOUDLY (!!!), like the self-ship cxell-image rebuild');

// ── (d2) …and it NOTICES when the image it booted from is stale ──────────────────────────────
// The check that act two needed and did not have. It must read the baked CLI BEFORE the install
// overwrites it — otherwise it is comparing the file against itself and can never report staleness.
console.log('\n── spawn detects a STALE zee-agent image (the act-two check) ──');
ok(/sha256sum/.test(cxellLib) && /createHash\('sha256'\)/.test(cxellLib),
   'it compares the baked CLI to the queenzee\'s own scripts/zee by sha256');
const preamble = fn.slice(0, fn.indexOf('for (const args of zeeCliInstallCommands'));
ok(/bakedZeeCliSha\(/.test(preamble),
   'the baked sha is read BEFORE the install overwrites it (afterwards the evidence is gone)');
ok(/staleImage/.test(preamble) && /!!! STALE CXELL IMAGE/.test(preamble),
   'a mismatch is logged loudly as a STALE CXELL IMAGE');
ok(/CLI ONLY|CLI only/.test(preamble),
   'and says plainly that the refresh repairs the CLI ONLY — the other baked files stay stale');
ok(/cli\.staleImage/.test(intake), 'intake surfaces the verdict on the spawn line too');
ok(/catch\s*{\s*return null;?\s*}/.test(cxellLib.slice(cxellLib.indexOf('async function bakedZeeCliSha'))),
   'an unreadable baked copy is "unknown", never an error (the check can never sink a spawn)');

// ── (e) usage vs the MANUAL: a verb a zee has must be a verb its manual mentions ──────────────
//
// (c) holds the CLI to itself. This holds the CLI to the text the zee is actually briefed with, which
// is the hop `zee harness` fell through: it was advertised, implemented, routed and tested, and no
// manual said it existed. An agent cannot use a door nobody told it about.
//
// The verb lists are DERIVED FROM THE USAGE TEXT'S OWN SECTIONS — the ` MANAGER-only …:` heading is
// what says which surface a verb belongs to — so a verb added under either heading is checked the day
// it lands. A hardcoded list here would be one more thing to remember to edit, which is the failure
// mode this whole file exists to remove.
//
// The manuals are DERIVED TOO: the worker manual is whichever system-wide harness carries a
// `cxell-zee-manual` memory entry, and the manager manuals are the system-wide manager-type harnesses
// — checked on their EFFECTIVE (merged) text, so a manager harness that INHERITS the manual (dev-lead)
// passes on the inherited copy and one that has lost its parent fails.
console.log('\n── every advertised verb is in the manual of the zee type that has it ──');
const { effectiveHarness, harnessLayerText } = await import('../server/src/lib/harness.js');
const { q, pool } = await import('../server/src/db/pool.js');
try {
  // usage() is written in SECTIONS: a heading has ONE leading space, a verb line has two or more.
  const sections = [{ heading: '(the verbs before any heading — every zee)', verbs: [] }];
  for (const line of usageBlock.split('\n')) {
    if (/^ \S/.test(line)) sections.push({ heading: line.trim(), verbs: [] });
    const verb = line.match(/^\s{2,}zee ([a-z][a-z-]*)/)?.[1];
    if (verb) sections[sections.length - 1].verbs.push(verb);
  }
  const managerOnly = [...new Set(sections.filter((s) => /MANAGER-only/i.test(s.heading)).flatMap((s) => s.verbs))];
  const anyZee = [...new Set(sections.filter((s) => !/MANAGER-only/i.test(s.heading)).flatMap((s) => s.verbs))];
  ok(managerOnly.length >= 5, `usage marks a MANAGER-only section (${managerOnly.length} verbs: ${managerOnly.join(', ')})`);
  ok(anyZee.length >= 10, `and the rest is every zee's surface (${anyZee.length} verbs)`);
  ok(!managerOnly.some((v) => anyZee.includes(v)), 'no verb is in both surfaces (the split is what picks the manual)');

  const rows = await q(
    `SELECT h.*, (SELECT count(*) FROM jsonb_array_elements(COALESCE(h.bundle->'memory','[]'::jsonb)) e
                   WHERE e->>'path' LIKE '%cxell-zee-manual%') AS carries_worker_manual
       FROM harness h WHERE h.enabled AND h.project_id IS NULL`);
  const briefing = async (row) => harnessLayerText(await effectiveHarness(row));
  const missing = (text, verbs) => verbs.filter((v) => !text.includes(`zee ${v}`));

  const workerManual = rows.filter((r) => Number(r.carries_worker_manual) > 0);
  ok(workerManual.length === 1,
     `exactly one system-wide harness carries the cxell manual (${workerManual.map((r) => r.key).join(', ') || 'NONE — run db:migrate'})`);
  for (const row of workerManual) {
    const gaps = missing(await briefing(row), anyZee);
    ok(!gaps.length, `${row.key}'s manual names every verb a worker has — a verb no manual mentions is a `
      + `verb no zee knows it has; document it there (missing: ${gaps.join(', ') || 'none'})`);
  }

  const managers = rows.filter((r) => r.zee_type === 'manager');
  ok(managers.length >= 1, `there are system-wide manager harnesses to check (${managers.map((r) => r.key).join(', ') || 'NONE'})`);
  for (const row of managers) {
    const text = await briefing(row);
    const gaps = missing(text, managerOnly);
    ok(!gaps.length, `${row.key} is briefed with every MANAGER-only verb — add it to the manager manual `
      + `(a migration, house rule 9), or to this harness's own memory (missing: ${gaps.join(', ') || 'none'})`);
    // …and the manager manual must not name a verb the CLI no longer has: the other direction of the
    // same drift, and the one that sends a manager to run something that answers "unknown command".
    // Backticked mentions, plus the verb lines inside a fenced block — NOT bare "zee …" in prose,
    // which wraps into sentences like "zee is executing" and would invent a verb to complain about.
    const fenced = [...text.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]).join('\n');
    const named = [...new Set([...text.matchAll(/`zee ([a-z][a-z0-9-]*)/g), ...fenced.matchAll(/^zee ([a-z][a-z0-9-]*)/gm)]
      .map((m) => m[1]))];
    const ghosts = named.filter((v) => !implemented.has(v));
    ok(!ghosts.length, `and names no verb the CLI does not implement (${ghosts.join(', ') || 'none'})`);
  }
} finally {
  await pool.end().catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

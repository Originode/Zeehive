// CXELL-CLI-DRIFT test — the class of bug that stranded a manager zee in its cage:
// `zee dispatch` answered "unknown command: dispatch" in EVERY cxell, because the CLI baked into
// zeehive/zee-agent was a hand-synced DUPLICATE (docker/zeehive/zee) that had never seen the commit
// which added the crew verbs to the authoritative scripts/zee. The server side was fine; the code
// simply never reached the cage. A comment in the Dockerfile ("Update both if you change it") was
// the only thing holding it together, and it failed on the first change that mattered.
//
// So this test asserts the MECHANISM, not the fix:
//   a) there is exactly ONE copy of the CLI, and Dockerfile.zee-agent COPYs the authoritative one
//      (re-introducing a duplicate anywhere under docker/ fails here);
//   b) every COPY source in that Dockerfile resolves on disk relative to the context the build
//      paths ACTUALLY pass (parsed out of scripts/self-ship.sh, scripts/self-ship-container.sh and
//      the publish-images workflow) — so changing the context in one place and not the other, or
//      forgetting a path prefix, is caught before the image stops building;
//   c) usage-vs-implementation inside scripts/zee: every advertised verb has a `case`, and every
//      case is advertised — the same drift one level in;
//   d) the spawn path installs the queenzee's own CLI into each cxell (the belt to the Dockerfile's
//      braces), with the right source, destination, root ownership and CR strip.
//
// Pure static/unit assertions: no DB, no docker, no network.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const DOCKERFILE = 'docker/zeehive/Dockerfile.zee-agent';
const CLI = 'scripts/zee';
const dockerfile = read(DOCKERFILE);
const cli = read(CLI);

// ── (a) ONE copy of the CLI ───────────────────────────────────────────────────────────────────
console.log('\n── one source of truth for the cxell CLI ──');
ok(existsSync(join(ROOT, CLI)), `the authoritative CLI lives at ${CLI}`);

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

// ── (b) every COPY source resolves under the context the build paths actually pass ────────────
console.log('\n── the Dockerfile and every build path agree on the context ──');
// self-ship.sh / self-ship-container.sh: take every non-comment line that runs (or echoes) a
// `docker build -f …Dockerfile.zee-agent`, join one level of line continuation, unescape the shell
// quoting (simulate mode spells the command out with \" escapes) and read docker's LAST positional
// token — which is the build CONTEXT.
function contextsFrom(rel) {
  const text = read(rel).replace(/\\\n\s*/g, ' ');
  const out = [];
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('#')) continue;                       // prose, not a build
    if (!/build .*-f [^\n]*Dockerfile\.zee-agent/.test(line)) continue;
    let l = line.trim();
    if (l.startsWith('echo "') && l.endsWith('"')) l = l.slice(6, -1);  // unwrap the simulate echo
    l = l.replace(/\\"/g, '"').replace(/>&2.*$/, '');                     // unescape, drop redirection
    const toks = [...l.matchAll(/"([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
    if (toks.length) out.push(toks[toks.length - 1]);
  }
  return out;
}
const shipPaths = ['scripts/self-ship.sh', 'scripts/self-ship-container.sh'];
const contexts = [];
for (const rel of shipPaths) {
  const found = contextsFrom(rel);
  ok(found.length > 0, `${rel} spells out a build context for the cxell image (${found.length} site(s))`);
  for (const c of found) {
    // Both scripts express the context relative to $SRC (the repo root of the checkout being shipped).
    ok(c === '$SRC', `${rel}: context is the repo ROOT ("$SRC"), not a subdirectory (got "${c}")`);
    contexts.push({ where: rel, dir: '.' });
  }
}
// the publish-images workflow's matrix entry for the zee-agent image
const wf = read('.github/workflows/publish-images.yml');
const entry = wf.split(/- image:/).find((b) => b.includes('Dockerfile.zee-agent') && !b.includes('zee-agent-android'));
ok(!!entry, 'publish-images.yml has a zee-agent matrix entry');
const wfCtx = entry?.match(/context:\s*(\S+)/)?.[1];
ok(wfCtx === '.', `the workflow builds it from the repo root (context: ${wfCtx})`);
contexts.push({ where: '.github/workflows/publish-images.yml', dir: wfCtx || '.' });

// The heart of it: every COPY source must exist relative to EVERY context a build path passes.
for (const { where, dir } of contexts) {
  const base = resolve(ROOT, dir);
  const missing = copies.filter((c) => !existsSync(resolve(base, c.src)));
  ok(missing.length === 0,
     `${where}: every COPY source in ${DOCKERFILE} resolves under its context (${missing.map((m) => m.src).join(', ') || 'all present'})`);
}
// And the android variant, which FROMs the base, must document the SAME context.
const android = read('docker/zeehive/Dockerfile.zee-agent-android');
const androidCmds = [...android.matchAll(/docker build -f (\S+)\s+-t\s+(\S+)\s+(\S+)/g)];
ok(androidCmds.length === 2, 'the android variant documents both build commands');
ok(androidCmds.every((m) => m[3] === '.'),
   'and both are documented with the repo-root context (they would not build otherwise)');

// ── (c) usage text vs implemented cases, inside scripts/zee ───────────────────────────────────
console.log('\n── scripts/zee: every advertised verb is implemented, and vice versa ──');
const usageBlock = cli.slice(cli.indexOf('function usage()'), cli.indexOf('switch (cmd)'));
const advertised = new Set([...usageBlock.matchAll(/^\s{2,}zee ([a-z][a-z-]*)/gm)].map((m) => m[1]));
const implemented = new Set([...cli.matchAll(/^\s*(?:case '[a-z-]+':\s*)*case '([a-z-]+)':/gm)].map((m) => m[1]));
for (const m of cli.matchAll(/case '([a-z-]+)':/g)) implemented.add(m[1]);
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
const lib = read('server/src/lib/cxell.js');
const fn = lib.slice(lib.indexOf('export async function installZeeCliIntoCxell'));
ok(/try\s*{/.test(fn.slice(0, 900)) && /catch/.test(fn.slice(0, 1400)),
   'the install is best-effort (a failed refresh must not sink a cxell spawn)');
ok(/logline\('cxell'[^]*?!!!/.test(fn.slice(0, 1600)), 'but a failure is logged LOUDLY (!!!), like the self-ship cxell-image rebuild');

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

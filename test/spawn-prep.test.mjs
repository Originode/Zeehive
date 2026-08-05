// THE SPAWN TEMPLATE'S PREP STEPS + CACHE KNOBS — migration 121, server/src/lib/spawn-prep.js.
//
// What this covers, and why each one is here rather than "obviously fine":
//
//  1. **The DEFAULT template is today's behaviour, exactly.** The whole safety argument for this
//     feature is "a fleet that never opens the editor sees no change", and that argument is only
//     true if the generated script still carries every marker and every rule warmInstallScript
//     carried when it was hard-coded: `npm ci` (never `npm install`) where a lockfile exists, the
//     lockstate proof on BOTH ways out of the locked branch, WARM_OK last.
//  2. **Root and non-root never mix.** apt needs uid 0; npm must NOT have it, or every file it
//     writes into /work/repo is root-owned and the zee cannot commit its own work. So an apt step
//     may never appear in the user script, and the user script may never be run as root.
//  3. **Validation refuses at the EDIT.** A template that cannot be turned into a script must fail
//     in front of the human who wrote it, not at 3am inside a cage nobody is watching — and an apt
//     package name is a string that ends up in a ROOT shell, so it is validated as an identifier
//     rather than pasted.
//  4. **The cache knobs actually reach the argv** — the docker mount, the npm flags, and the host
//     twin, which is the half that silently drifts (two spawns of "the same" install, one of them
//     with different flags, is exactly the bug this module was extracted to prevent).
//  5. **The timing markers parse**, because they are the evidence a human tunes the template from.
//
// It runs the generated scripts for real under bash where that is cheap (no npm, no docker): a
// script that is asserted only as a STRING is asserted against the thing that was written, not the
// thing that runs.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const throws = (fn, re, msg) => {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  ok(!!err && re.test(err.message), `${msg}${err ? ` (${err.message.slice(0, 80)})` : ' — it did NOT throw'}`);
};

const P = await import('../server/src/lib/spawn-prep.js');
const N = await import('../server/src/lib/npm-cache.js');
const { cxellRunArgs } = await import('../server/src/lib/cxell.js');
const tmp = mkdtempSync(join(tmpdir(), 'spawnprep-'));

try {
  console.log('\n── 1. the DEFAULT template is what every project already had ──');
  const def = P.normalizeSpawnPrep(null);
  ok(def.steps.length === 2 && def.steps[0].kind === 'npm' && def.steps[1].kind === 'npm-run',
     'null → npm deps + the web prebuild, in that order');
  ok(def.steps.every((s) => s.enabled), 'both enabled');
  const script = P.prepUserScript(def, '/work/repo');
  ok(/npm ci --no-audit --no-fund \|\|/.test(script) && !/npm install/.test(script.split('else')[0]),
     'the LOCKED branch runs `npm ci` and contains no `npm install` at all (the reap-loop rule)');
  ok(/WARM_CI_FAILED/.test(script) && /WARM_INSTALL_FAILED/.test(script) && /WARM_LOCK_DIRTY/.test(script)
     && /WARM_OK/.test(script), 'every marker warmCxell reads is still emitted');
  ok((script.match(/lockstate/g) || []).length >= 3,
     'lockstate is defined once and called on BOTH ways out of the locked branch');
  ok(/WARM_CI_FAILED"; lockstate;/.test(script),
     'including the FAILING way — a `ci` that died having touched the lock is the case nobody could see');
  ok(script.trim().endsWith('echo WARM_OK'), 'and WARM_OK is last, so a half-run warm is never reported as done');
  ok(/npm run build --workspace web/.test(script), 'the web prebuild still runs');
  ok(P.prepRootScript(def) === null,
     'the default asks for NOTHING as root — so no root exec happens at all on the default path');

  console.log('\n── 2. dependencies a project adds: apt (root) is a SEPARATE script ──');
  const withPsql = P.normalizeSpawnPrep({
    steps: [...P.DEFAULT_STEPS, { key: 'psql', kind: 'apt', packages: ['postgresql-client'] }],
  });
  const user = P.prepUserScript(withPsql, '/work/repo');
  const root = P.prepRootScript(withPsql);
  ok(!/apt-get/.test(user), 'the USER script never runs apt (it runs as `zee`, which is not uid 0)');
  ok(/apt-get install -y --no-install-recommends postgresql-client/.test(root),
     'the ROOT script installs the packages');
  ok(/apt-get update/.test(root), 'after an update, or the package lists in a slim image are empty');
  ok(/PREP_ROOT_DONE/.test(root), 'and ends with the marker the queenzee reads as "the root half ran"');
  ok(/mkdir -p \/var\/cache\/apt\/archives\/partial/.test(root),
     'a MOUNTED apt cache comes up empty, and apt refuses to run without its partial dir');
  ok(/Keep-Downloaded-Packages/.test(root),
     "…and Debian's docker-clean deletes every .deb on install, which would make the cache silently pointless");
  ok(!/npm ci|npm run/.test(root), 'no npm in the root script — root-owned node_modules is a tree the zee cannot commit');

  console.log('\n── 3. disabling a step removes it; nothing enabled means no script at all ──');
  const noWeb = P.normalizeSpawnPrep({ steps: [P.DEFAULT_STEPS[0], { ...P.DEFAULT_STEPS[1], enabled: false }] });
  ok(!/npm run build/.test(P.prepUserScript(noWeb)), 'a disabled step is absent from the script, not commented out');
  ok(/npm ci /.test(P.prepUserScript(noWeb)), 'and its neighbours are untouched');
  const none = P.normalizeSpawnPrep({ steps: [] });
  const empty = P.prepUserScript(none);
  ok(!/npm/.test(empty.replace(/npm cache: .*?\)"/, '')) && /WARM_OK/.test(empty),
     'an empty template still reports WARM_OK (a spawn with no prep is a choice, not a failure)');
  ok(P.prepRootScript(none) === null, 'and no root script');

  console.log('\n── 4. the generated scripts RUN (bash -n is not enough; these are executed) ──');
  const shellTpl = P.normalizeSpawnPrep({
    steps: [{ key: 'hello', kind: 'shell', run: 'echo hi > out.txt' },
            { key: 'flaky', kind: 'shell', run: 'exit 3', allow_failure: true }],
    cache: { npm: 'container' },
  });
  const out = execFileSync('bash', ['-lc', P.prepUserScript(shellTpl, tmp)], { encoding: 'utf8', cwd: tmp });
  ok(/WARM_OK/.test(out), 'a template of shell steps runs end to end');
  ok(/PREP_STEP hello ok \d+/.test(out), 'each step reports its own timing marker');
  ok(/PREP_STEP flaky failed \d+/.test(out), 'a failing allow-failure step is REPORTED as failed…');
  ok(/WARM_OK/.test(out), '…and does not sink the warm (best-effort, rule 1)');
  const strict = P.normalizeSpawnPrep({ steps: [{ key: 'boom', kind: 'shell', run: 'exit 4', allow_failure: false }] });
  const hard = (() => {
    try { return execFileSync('bash', ['-lc', P.prepUserScript(strict, tmp)], { encoding: 'utf8', cwd: tmp }); }
    catch (e) { return `${e.stdout || ''}EXIT`; }
  })();
  ok(/PREP_STEP boom failed/.test(hard) && !/WARM_OK/.test(hard),
     'while a step that says it must not fail stops the script before WARM_OK');

  console.log('\n── 5. the parsed timings are the evidence a human tunes from ──');
  const rows = P.parsePrepSteps(out);
  ok(rows.length === 2 && rows[0].key === 'hello' && rows[0].ok === true, 'markers parse back into rows');
  ok(rows[1].ok === false, 'including which one failed');
  ok(/hello \d+s/.test(P.summarizePrepSteps(rows)) && /FAILED/.test(P.summarizePrepSteps(rows)),
     `and summarize into one log line (${P.summarizePrepSteps(rows)})`);
  // …with the TEMPLATE in hand, a step that was declared best-effort reads as optional rather than
  // FAILED. The word FAILED in a spawn log means "go look", and a prebuild that legitimately has
  // nothing to build is not that — it is the normal outcome on a project with no web workspace.
  ok(/optional, skipped/.test(P.summarizePrepSteps(rows, shellTpl)) && !/FAILED/.test(P.summarizePrepSteps(rows, shellTpl)),
     `an allow-failure step is reported as optional, not as a failure (${P.summarizePrepSteps(rows, shellTpl)})`);
  ok(/FAILED/.test(P.summarizePrepSteps([{ key: 'psql', ok: false, seconds: 2 }], withPsql)),
     'while an apt install that did not happen keeps FAILED — the zee is missing a tool it was promised');

  console.log('\n── 6. validation refuses at the EDIT, not at 3am in a cage ──');
  throws(() => P.normalizeSpawnPrep({ steps: [{ kind: 'wat' }] }), /kind must be one of/, 'an unknown kind is refused');
  throws(() => P.normalizeSpawnPrep({ steps: [{ kind: 'apt', packages: [] }] }), /at least one package/,
         'an apt step with no packages is refused');
  throws(() => P.normalizeSpawnPrep({ steps: [{ kind: 'apt', packages: ['x; rm -rf /'] }] }),
         /not a valid apt package name/,
         'a package name carrying shell metacharacters is REFUSED — it would land in a ROOT exec');
  throws(() => P.normalizeSpawnPrep({ steps: [{ kind: 'npm-run' }] }), /needs a script/, 'an npm-run step needs a script');
  throws(() => P.normalizeSpawnPrep({ steps: [{ kind: 'shell' }] }), /needs a command/, 'a shell step needs a command');
  throws(() => P.normalizeSpawnPrep({ steps: [{ key: 'a', kind: 'shell', run: 'x' }, { key: 'a', kind: 'shell', run: 'y' }] }),
         /duplicate step key/, 'two steps may not share a key — the timing report is keyed by it');
  throws(() => P.normalizeSpawnPrep({ cache: { npm: 'magic' } }), /cache.npm must be one of/, 'a bad cache mode is refused');
  ok(P.normalizeSpawnPrep({ steps: [{ kind: 'apt', packages: 'postgresql-client, jq' }] }).steps[0].packages.length === 2,
     'a typed-in package list is split on commas/space, so the console can hand over a plain string');
  ok(P.normalizeSpawnPrep({ steps: [{ kind: 'apt', packages: ['jq'] }] }).steps[0].root === true,
     'an apt step is root by construction — not a knob a human can get wrong');

  console.log('\n── 7. the cache knobs reach the argv (docker AND npm, both halves) ──');
  delete process.env.CXELL_NPM_CACHE_VOLUME;
  const runDefault = cxellRunArgs({ name: 'c', net: 'n', port: 22, img: 'i', xellId: 'x' });
  ok(runDefault.join(' ').includes(`zeehive_npm_cache:${N.CXELL_NPM_CACHE_DIR}`),
     'with no template the cage is created exactly as before — the shared npm cache mount');
  ok(!runDefault.join(' ').includes('apt'), 'and NO apt mount, because nothing installs packages');
  const runApt = cxellRunArgs({ name: 'c', net: 'n', port: 22, img: 'i', xellId: 'x', prep: withPsql });
  ok(runApt.join(' ').includes(`zeehive_apt_cache:${N.CXELL_APT_CACHE_DIR}`),
     'a template that installs packages ALSO gets the shared apt archive volume (the second cxell does not re-download)');
  const runCold = cxellRunArgs({ name: 'c', net: 'n', port: 22, img: 'i', xellId: 'x',
                                prep: P.normalizeSpawnPrep({ cache: { npm: 'container' } }) });
  ok(!runCold.join(' ').includes('zeehive_npm_cache'),
     'cache.npm=container opts one project out of the shared cache without touching the fleet');
  ok(N.cxellCacheFixupCommand('c', { npm: 'container' }) === null,
     'and then there is no volume to chown either');
  ok(P.npmInstallFlags({ npm_prefer_offline: true }).includes('--prefer-offline'),
     'prefer-offline is a flag on npm, which is what turns a warm cache into a fast spawn');
  ok(!P.npmInstallFlags({ npm_prefer_offline: false }).includes('--prefer-offline'), 'and it can be turned off');
  ok(P.npmInstallFlags({ npm_omit_dev: true }).includes('--omit=dev'), 'omit-dev is a flag too');
  ok(P.npmInstallFlags().includes('--no-audit') && P.npmInstallFlags().includes('--no-fund'),
     'the flags that were always there are still there');
  ok(P.prepUserScript(P.normalizeSpawnPrep({ cache: { npm_omit_dev: true, npm_prefer_offline: true } })).includes('npm ci --no-audit --no-fund --prefer-offline --omit=dev'),
     'and the SAME flags are what the in-cage script uses (one source, so the two halves cannot drift)');
  ok(N.warmArgsFor().join(' ') === 'ci --no-audit --no-fund',
     'the HOST warm reads the same function — a pooled worktree and a cage install the same way');
  // The DEFAULT is a measurement, not a preference: cold cache 32s / warm 11s / warm+prefer-offline
  // 16s, measured in a cxell against this repo's lockfile. The shared cache is the 3× win;
  // prefer-offline showed nothing above noise, so it is a knob and not a default.
  ok(!P.npmInstallFlags().includes('--prefer-offline'),
     'prefer-offline is OFF by default — a NULL template stays byte-for-byte what every project already ran');
  ok(N.warmArgsFor()[0] === 'ci', 'and it is still `ci`, never `install` (rule 2, on the pool-watched tree)');

  console.log('\n── 8. presets are server-defined, so the console gains a step by shipping the server ──');
  ok(P.STEP_PRESETS.some((x) => x.key === 'psql' && x.packages?.includes('postgresql-client')),
     'psql is offered — a zee is handed a psql DSN in its own binding and the cage had no psql');
  ok(P.STEP_PRESETS.every((x) => P.STEP_KINDS.includes(x.kind)), 'every preset is a legal step kind');
  for (const preset of P.STEP_PRESETS) {
    let bad = null;
    try { P.normalizeSpawnPrep({ steps: [preset] }); } catch (e) { bad = `${preset.key}: ${e.message}`; }
    if (bad) { ok(false, `preset ${bad}`); }
  }
  ok(true, 'and every preset normalizes — the "add" menu cannot offer a step the server would refuse');
  console.log('\n── 9. WHEN the prep runs: provisioning, not the zee ──');
  // The point of `when` is WHO PAYS. 'dispatch' is the old behaviour (a human waits for apt and
  // npm); 'image' moves the apt half to an image the pool bakes; 'provision' moves the whole thing
  // to the pool, and dispatch reuses what it did. Assert the ladder, then assert the two mechanisms
  // that make 'provision' safe: the marker, and every way it can be WRONG.
  ok(P.normalizeSpawnPrep(null).when === 'dispatch', 'default is dispatch — today\'s behaviour for anyone who does not choose');
  throws(() => P.normalizeSpawnPrep({ when: 'someday' }), /when must be one of/, 'an unknown when is refused');
  const atImage = P.normalizeSpawnPrep({ steps: [...P.DEFAULT_STEPS, { key: 'psql', kind: 'apt', packages: ['postgresql-client'] }], when: 'image' });
  const atProvision = P.normalizeSpawnPrep({ ...atImage, when: 'provision' });
  ok(!P.bakesImage(P.normalizeSpawnPrep(null)) && P.bakesImage(atImage) && P.bakesImage(atProvision),
     'image AND provision both bake the packages; dispatch does not');
  ok(!P.prewarmsCage(atImage) && P.prewarmsCage(atProvision),
     'only provision pre-warms the cage — the setting that costs a live container per pooled xell');

  console.log('\n── 10. the baked image: tagged by what went into it ──');
  const tag = P.preppedImageTag('zeehive/zee-agent', atImage);
  ok(/^zeehive\/zee-agent-prep:[0-9a-f]{10}$/.test(tag), `the tag names the recipe, not the project (${tag})`);
  ok(P.preppedImageTag('zeehive/zee-agent', P.normalizeSpawnPrep(null)) === null,
     'a template with no packages has NO prepped image — the base image already is one');
  const reordered = P.normalizeSpawnPrep({ steps: [{ key: 'b', kind: 'apt', packages: ['jq'] }, { key: 'a', kind: 'apt', packages: ['curl'] }] });
  const sameSet = P.normalizeSpawnPrep({ steps: [{ key: 'a', kind: 'apt', packages: ['curl'] }, { key: 'b', kind: 'apt', packages: ['jq'] }] });
  ok(P.preppedImageTag('base', reordered) === P.preppedImageTag('base', sameSet),
     'the same packages in a different order are ONE image, not two (the list is sorted before hashing)');
  ok(P.preppedImageTag('other-base', atImage) !== tag, 'and a different base image is a different tag');
  const df = P.preppedDockerfile('zeehive/zee-agent', atImage);
  ok(/^FROM zeehive\/zee-agent/m.test(df) && /apt-get install -y --no-install-recommends postgresql-client/.test(df),
     'the Dockerfile is FROM the base plus one install layer');
  ok(/USER zee\s*$/.test(df.trim()), 'and it ends back on the non-root user — a cage must never come up as root');
  ok(/rm -rf \/var\/lib\/apt\/lists/.test(df), 'lists cleaned up: this is an image a fleet keeps, not a cache');

  console.log('\n── 11. a baked image means the cage does NOT reinstall those packages ──');
  ok(/apt-get install/.test(P.prepRootScript(atImage) || ''), 'without the image, the root script installs them');
  ok(P.prepRootScript(atImage, { aptBaked: true }) === null,
     'with the image, there is NO root script at all — nothing to run, so no root exec happens');
  const mixed = P.normalizeSpawnPrep({ steps: [{ key: 'psql', kind: 'apt', packages: ['postgresql-client'] },
                                                { key: 'fix', kind: 'shell', root: true, run: 'chmod 777 /tmp/x' }] });
  const baked = P.prepRootScript(mixed, { aptBaked: true });
  ok(baked && !/apt-get/.test(baked) && /chmod 777/.test(baked),
     'a NON-apt root step still runs — an image cannot bake a line that touches this xell\'s tree');

  console.log('\n── 12. the marker: what makes a pre-warmed cage worth anything ──');
  const hash = P.templateHash(atProvision);
  const plain = P.prepUserScript(atProvision, '/work/repo');
  const marked = P.prepUserScript(atProvision, '/work/repo', { hash, mark: true });
  const reusing = P.prepUserScript(atProvision, '/work/repo', { hash, reuse: true, mark: true });
  ok(!/zeehive-prep/.test(plain), 'no options → not one byte about markers (the default script is untouched)');
  ok(new RegExp(P.PREP_MARKER).test(marked) && /"template":"/.test(marked), 'mark → the script writes what it installed for');
  ok(/\/work\/\.zeehive-prep\.json/.test(P.PREP_MARKER + marked) && !/\/work\/repo\/\.zeehive-prep/.test(marked),
     'and the marker lives OUTSIDE the repo — inside it, it would show up in the zee\'s git status as junk it did not write');
  ok(/PREPPED=1/.test(reusing) && /reused 0/.test(reusing), 'reuse → the script can skip the install and SAY it skipped');
  ok(/\[ -d node_modules \]/.test(reusing), 'the reuse check requires node_modules to actually still be there');
  ok(new RegExp(`"template":"${hash}"`).test(reusing), '…and the marker to name THIS template');
  ok(/sha1sum package-lock\.json/.test(reusing), '…and the lockfile to be the one that was installed');
  ok(P.templateHash(atProvision) === P.templateHash(P.normalizeSpawnPrep({ ...atProvision, when: 'image' })),
     'the hash covers the STEPS, not when they run — moving the work does not throw away a warm cage');
  ok(P.templateHash(atProvision) !== P.templateHash(P.normalizeSpawnPrep({ ...atProvision, cache: { npm_omit_dev: true } })),
     'but a flag that changes the argv DOES — those node_modules are not the ones this template asks for');
  // lockstate is defined at the head, not inside the npm branch: with reuse that branch is skipped,
  // and the tail still calls it. This is the bug that made a good prepped cage report a failed warm.
  ok(reusing.indexOf('lockstate()') < reusing.indexOf('PREPPED=1'),
     'lockstate is defined BEFORE the reuse check — the tail calls it on the path that skipped the install');

  console.log('\n── 13. …and the reuse decision RUNS, against a real tree ──');
  const repo = join(tmp, 'prepped');
  const marker = join(tmp, 'prep-marker.json');
  execFileSync('bash', ['-lc', 'mkdir -p ' + repo], { encoding: 'utf8' });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', private: true }));
  writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ name: 'p', lockfileVersion: 3, packages: {} }));
  execFileSync('bash', ['-lc', 'mkdir -p node_modules'], { cwd: repo, encoding: 'utf8' });
  // Only the npm-run + shell kinds here: this asserts the DECISION, not npm itself (which the
  // integration-flavoured tests above already run).
  const tpl = P.normalizeSpawnPrep({ steps: [{ key: 'build', kind: 'npm-run', script: 'nope', allow_failure: true }], when: 'provision' });
  const h = P.templateHash(tpl);
  const run = (script) => {
    try { return execFileSync('bash', ['-lc', script.replaceAll(P.PREP_MARKER, marker)], { cwd: repo, encoding: 'utf8' }); }
    catch (e) { return `${e.stdout || ''} EXIT${e.status}`; }
  };
  const first = run(P.prepUserScript(tpl, '.', { hash: h, reuse: true, mark: true }));
  ok(/PREP_STEP build (ok|failed)/.test(first) && !/reused/.test(first),
     'the FIRST run has no marker to trust, so it does the work');
  ok(existsSync(marker), 'and writes the marker');
  const second = run(P.prepUserScript(tpl, '.', { hash: h, reuse: true, mark: true }));
  ok(/PREP_STEP build reused 0/.test(second), 'the SECOND run reuses it — this is a dispatch that installs nothing');
  execFileSync('bash', ['-lc', 'rm -rf node_modules'], { cwd: repo, encoding: 'utf8' });
  ok(!/reused/.test(run(P.prepUserScript(tpl, '.', { hash: h, reuse: true, mark: true }))),
     'node_modules deleted → it does the work again (the marker alone is never enough)');
  execFileSync('bash', ['-lc', 'mkdir -p node_modules'], { cwd: repo, encoding: 'utf8' });
  ok(!/reused/.test(run(P.prepUserScript(tpl, '.', { hash: 'ffffffffffff', reuse: true, mark: true }))),
     'a DIFFERENT template → it does the work again');
  writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ name: 'p', lockfileVersion: 3, packages: { x: 1 } }));
  ok(!/reused/.test(run(P.prepUserScript(tpl, '.', { hash: h, reuse: true, mark: true }))),
     'a MOVED lockfile → it does the work again. Every doubt reinstalls: a wasted npm ci costs a minute, a wrongly skipped one hands the zee a tree that cannot build');

  console.log('\n── 14. the timing report tells a reused spawn from a working one ──');
  const rows2 = P.parsePrepSteps('PREP_STEP npm-deps reused 0\nPREP_STEP psql ok 6');
  ok(rows2[0].status === 'reused' && rows2[0].ok === true, 'reused is its own status, and is not a failure');
  ok(/reused — prepped at provision/.test(P.summarizePrepSteps(rows2)),
     `and the log says so (${P.summarizePrepSteps(rows2)}) — otherwise a spawn that installed nothing reads identically to one that installed everything`);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

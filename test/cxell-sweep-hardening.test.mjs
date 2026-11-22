// CXELL TOOLING SWEEP — HARDENING test: bounded, litter-free, and honest about the files it does
// NOT repair.
//
// Three follow-ups from the reflection on a9c768fa, none of them a defect in what shipped:
//
//   1. BOUND. The sweep was a serial `for … await` with no aggregate limit, and every docker op
//      carried dk's 120s default — so ONE wedged cage stalled every cage behind it for minutes, on
//      every boot. Proven here with a fake docker that hangs: the sweep must return promptly, and a
//      healthy cage swept alongside the hang must still be reached (small parallelism), and past its
//      budget the sweep must START nothing and say which cages it did not reach.
//   2. LITTER. A failed install used to leave a root-owned `zee.new.<pid>` in /usr/local/bin forever.
//      The real install shell is EXECUTED here twice — once as the old command (which leaves the
//      litter) and once as shipped (which does not). No docker needed: the shell is the unit.
//   3. DRIFT. The stale-image detector compared ONLY the baked `zee` — the one file the sweep then
//      REPAIRS, so after a boot it compares clean while a stale image goes unreported. It now judges
//      the files the sweep does NOT refresh (cxell-sshd.sh, cxell-firewall.sh, cxell-claude-seed.mjs)
//      too. Proven with a fake docker whose CLEAN CLI is paired with a drifted cxell-sshd.sh: a line
//      must fire and name that file.
//
// WHAT THIS CANNOT PROVE, plainly: the `docker cp`/`docker exec` into a REAL live cage. There is no
// daemon in a cxell and no route to the fleet's cages from one. Everything below is the sweep's own
// logic against a fake docker that records argv — the real install into a live container is not
// exercised here and is not claimed.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tag = randomUUID().slice(0, 8);
const tmp = mkdtempSync(join(tmpdir(), 'sweephard-'));
const bin = join(tmp, 'bin');
const DOCKER_LOG = join(tmp, 'docker.log');
mkdirSync(bin, { recursive: true });
const DRIFT_SHA = 'ab'.repeat(32);   // a valid 64-hex that is not any repo file's digest

// The fake docker answers the ONE read the probe makes (sha256sum over the judged baked files) by
// hashing the matching repo file — so by default every cage looks freshly built from this code. A
// cage named `…-drift` reports a DIFFERENT sha for cxell-sshd.sh only: the clean-CLI, drifted-image
// case item 3 exists for. A cage named `…-hang` never answers at all, which is the wedge.
writeFileSync(join(bin, 'docker'), `#!/bin/sh
sha_for() {
  n="$1"; p="$2"
  if [ "$n" = "cxell_${tag}-drift" ] && [ "$p" = "/usr/local/bin/cxell-sshd.sh" ]; then printf '%s' "${DRIFT_SHA}"; return; fi
  case "$p" in
    /usr/local/bin/zee) s="${ROOT}/scripts/zee" ;;
    /usr/local/bin/zee-live.mjs) s="${ROOT}/docker/zeehive/zee-live.mjs" ;;
    /usr/local/bin/zee-attach.sh) s="${ROOT}/docker/zeehive/zee-attach.sh" ;;
    /usr/local/bin/cxell-sshd.sh) s="${ROOT}/docker/zeehive/cxell-sshd.sh" ;;
    /usr/local/bin/cxell-firewall.sh) s="${ROOT}/docker/zeehive/cxell-firewall.sh" ;;
    /usr/local/bin/cxell-claude-seed.mjs) s="${ROOT}/docker/zeehive/cxell-claude-seed.mjs" ;;
    *) printf '%s' "${DRIFT_SHA}"; return ;;
  esac
  sha256sum "$s" | awk '{print $1}'
}
printf '%s\\n' "$*" >> ${DOCKER_LOG}
name=""
[ "$1" = "exec" ] && name="$4"
case "$*" in
  *cxell_${tag}-hang*) exec sleep 60 ;;
esac
case "$*" in
  *sha256sum*)
    script="$7"
    paths="\${script#for f in }"
    paths="\${paths%%; do*}"
    for p in $paths; do printf '%s  %s\\n' "$(sha_for "$name" "$p")" "$p"; done
    ;;
esac
exit 0
`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
const dockerCalls = () => (existsSync(DOCKER_LOG) ? readFileSync(DOCKER_LOG, 'utf8').split('\n').filter(Boolean) : []);
const resetDocker = () => { try { rmSync(DOCKER_LOG); } catch { /* not written yet */ } };

const { refreshZeeToolingInLiveCxells, cxellFileInstallCommands, BAKED_CXELL_FILES,
        ZEE_CLI_DEST, zeeCliSourcePath } = await import('../server/src/lib/cxell.js');
const { recentLogs } = await import('../server/src/lib/logbus.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const since = () => recentLogs(1000).length;
const logsSince = (n) => recentLogs(1000).slice(n).map((l) => l.msg);

try {
  // ── 1. THE BOUND — one wedged cage must not stall the sweep, nor the cage beside it ───────────
  console.log('\n── a wedged cage cannot stall the sweep (per-op timeout + small parallelism) ──');
  resetDocker();
  const hang = `cxell_${tag}-hang`;
  const healthy = `cxell_${tag}-fresh`;
  const t0 = Date.now();
  const wedged = await refreshZeeToolingInLiveCxells(async () => ([{ name: hang }, { name: healthy }]),
    { mode: 'real', perOpTimeoutMs: 250, budgetMs: 60000, concurrency: 2 });
  const elapsed = Date.now() - t0;
  ok(elapsed < 6000, `the sweep returned in ${elapsed}ms with a cage that never answers (dk's 120s `
    + 'default would have held it for minutes)');
  ok(wedged.failed.includes(hang), 'the wedged cage is COUNTED as failed, never thrown');
  ok(wedged.ok === 1 && !wedged.failed.includes(healthy),
     'and the healthy cage beside it was still swept — the wedge did not queue behind it');
  ok(!wedged.bounded, 'nothing was bounded in this run — the per-op timeout, not the budget, did the work');

  // …and past its budget the sweep starts NOTHING and names the cages it did not reach.
  console.log('\n── past its budget the sweep starts nothing, and says which cages it skipped ──');
  resetDocker();
  const n = since();
  const skipped = await refreshZeeToolingInLiveCxells(async () => ([
    { name: `cxell_${tag}-a` }, { name: `cxell_${tag}-b` }, { name: `cxell_${tag}-c` },
  ]), { mode: 'real', budgetMs: 0 });
  ok(skipped.swept === 3 && skipped.bounded === 3 && skipped.ok === 0 && skipped.failed.length === 0,
     'a spent budget reports every cage as bounded — not swept, not failed, not silently dropped');
  ok(dockerCalls().length === 0, 'and no docker op was started at all');
  const skipLine = logsSince(n).find((m) => /stopped at its 0ms bound/.test(m));
  ok(!!skipLine && skipLine.includes(`cxell_${tag}-a`) && skipLine.includes(`cxell_${tag}-c`),
     'the skip is logged with the cage names — "budget spent" must not look like "nothing to do"');

  // ── 2. THE LITTER — the real install shell, run twice: old command leaves it, new one does not ──
  console.log('\n── a failed install leaves nothing behind in the destination directory ──');
  const scratch = join(tmp, 'litter');
  const binDir = join(scratch, 'bin');
  mkdirSync(binDir, { recursive: true });
  const srcFile = join(scratch, 'source-zee');
  const tmpFile = join(scratch, 'zee.cli');
  const destFile = join(binDir, 'zee');
  writeFileSync(srcFile, '#!/usr/bin/env node\n');
  const cmds = cxellFileInstallCommands({ name: 'cxell_litter', src: srcFile, dest: destFile, tmp: tmpFile });
  const shell = cmds[1][cmds[1].length - 1];
  const staged = `${destFile}.new.$$`;
  ok(/^trap 'rm -f .*' EXIT HUP INT TERM; /.test(shell),
     'the shipped sequence runs under an EXIT (+HUP/INT/TERM) trap that removes the staged file');
  ok(shell.includes(`install -o root -g root -m 0755 ${tmpFile} ${staged}`)
     && shell.includes(`mv -f ${staged} ${destFile}`),
     'and the atomic same-directory rename is UNCHANGED — the trap cleans the staging area, it does '
     + 'not replace rename(2) with an install(1) onto the live path');

  const litter = () => readdirSync(binDir).filter((name) => name.startsWith('zee.new.'));
  // `&& false` stands in for the exec dying after the staged install and before the mv: the two
  // variants below are identical except for the trap, so anything left behind is the trap's doing.
  // NB: a FUNCTION replacement — in a string replacement `$$` means a literal `$`, which would
  // silently turn the staged path into `zee.new.$` and make the trap miss it.
  const armed = shell.replace(` ${tmpFile} ${staged} && mv -f `,
    () => ` ${tmpFile} ${staged} && false && mv -f `);
  const legacy = armed.replace(/^trap '[^']*' EXIT HUP INT TERM; /, '');
  ok(legacy !== armed && !/trap /.test(legacy),
     'the "before" variant is the same command with the trap stripped');

  writeFileSync(tmpFile, '#!/usr/bin/env node\n');
  const legacyRun = spawnSync('bash', ['-c', legacy], { encoding: 'utf8' });
  ok(legacyRun.status !== 0, 'the old command dies between the staged install and the mv');
  ok(litter().length === 1, `and leaves the litter the reflection reported (${litter().join(', ')})`);
  for (const l of litter()) rmSync(join(binDir, l), { force: true });

  writeFileSync(tmpFile, '#!/usr/bin/env node\n');
  const newRun = spawnSync('bash', ['-c', armed], { encoding: 'utf8' });
  ok(newRun.status !== 0, 'the shipped command dies at the same point');
  ok(litter().length === 0 && !existsSync(destFile),
     'and leaves NOTHING — no zee.new.<pid>, and no half-installed dest (the mv never ran)');

  // …and on the happy path the trap must not clobber the file the mv just placed.
  writeFileSync(tmpFile, '#!/usr/bin/env node\n');
  const happy = armed.replace(' && false && mv -f ', ' && mv -f ').replace('-o root -g root ', '');
  const happyRun = spawnSync('bash', ['-c', happy], { encoding: 'utf8' });
  ok(happyRun.status === 0 && existsSync(destFile) && !existsSync(tmpFile) && litter().length === 0,
     'a successful install still lands dest, removes the temp copy, and trips no trap cleanup');

  // ── 3. THE DRIFT — a clean CLI must not acquit a stale image ──────────────────────────────────
  console.log('\n── drift in a baked file the sweep does NOT repair fires the verdict ──');
  const unrefreshed = BAKED_CXELL_FILES.filter((f) => !f.refreshed).map((f) => f.dest);
  ok(unrefreshed.includes('/usr/local/bin/cxell-sshd.sh')
     && unrefreshed.includes('/usr/local/bin/cxell-firewall.sh')
     && unrefreshed.includes('/usr/local/bin/cxell-claude-seed.mjs'),
     'the judged set includes the files the sweep does not repair (sshd, firewall, claude seed)');
  ok(BAKED_CXELL_FILES.filter((f) => f.refreshed).map((f) => f.dest).includes(ZEE_CLI_DEST),
     'and still includes the CLI it does repair (a fresh cage still reports CLI drift)');

  resetDocker();
  const driftCage = `cxell_${tag}-drift`;
  const freshCage = `cxell_${tag}-freshtwo`;
  const nDrift = since();
  const drifted = await refreshZeeToolingInLiveCxells(async () => ([{ name: driftCage }, { name: freshCage }]),
    { mode: 'real' });
  ok(dockerCalls().some((c) => c.includes('sha256sum') && c.includes('/usr/local/bin/cxell-sshd.sh')),
     'the ONE probe exec asks for cxell-sshd.sh — the comparison is real, not a default that hides it');
  ok(drifted.stale_image === 1, `only the drifted cage is counted (stale_image=${drifted.stale_image})`);
  const staleLines = logsSince(nDrift).filter((m) => /!!! STALE CXELL IMAGE/.test(m));
  ok(staleLines.length === 1, `the verdict is still ONE line for the sweep, not one per cage (${staleLines.length})`);
  ok(staleLines[0].includes('/usr/local/bin/cxell-sshd.sh'),
     'and it NAMES the drifted file — a clean CLI no longer implies a fresh image');
  ok(/CLI ONLY/.test(staleLines[0]) && /Rebuild the image/.test(staleLines[0]),
     'while keeping the plain warning that a repaired CLI is not a repaired image');

  // The control: with every judged file matching, no verdict at all — the detector must not fire on
  // a fresh image just because it looked.
  resetDocker();
  const nFresh = since();
  const clean = await refreshZeeToolingInLiveCxells(async () => ([{ name: freshCage }]), { mode: 'real' });
  ok(clean.stale_image === 0 && !logsSince(nFresh).some((m) => /!!! STALE CXELL IMAGE/.test(m)),
     'an image whose judged files all match produces no stale line (the control)');

  // ── 4. simulate still installs nothing, verdicts and all ──────────────────────────────────────
  console.log('\n── PROVISION_MODE=simulate still touches nothing ──');
  resetDocker();
  const dry = await refreshZeeToolingInLiveCxells(async () => ([{ name: driftCage }]), { mode: 'simulate' });
  ok(dry.dry_run === true && dry.swept === 1 && dockerCalls().length === 0,
     'simulate reports what it would do and runs no docker op — not even the sha probe');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures ? 1 : 0);

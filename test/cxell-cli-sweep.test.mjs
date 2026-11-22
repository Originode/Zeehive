// CXELL CLI SWEEP test — a zee ALIVE ACROSS A SHIP gets the verb that ship added.
//
// THE GAP. The manual a zee is briefed with is served LIVE from the meta-DB, but the `zee` binary
// is baked into the zee-agent image and cxell.js installed the queenzee's copy only AT SPAWN. So a
// cage already running when the medic verb shipped kept the old binary and answered a bare
// "unknown command: medic" for a verb its own manual documents — the ship delivered the VISIBILITY
// and not one running zee could reach the verb. That is the operator's "i dont see any asks being
// made", and this sweep (lib/cxell.js refreshZeeToolingInLiveCxells, run at boot, which is also the
// moment after a ship) is the fix: the CLI rides the fleet-wide sweep the attend path already had.
//
// PROVEN WITH A FAKE `docker` ON PATH that records every argv it is handed and answers the reads
// the sweep makes. This cage has no docker at all, so "the docker call failed" would prove nothing
// about whether the sweep TRIED; the fake makes "did it try?" a recorded fact.
//
// WHAT THIS CANNOT PROVE, plainly: the `docker cp` into a REAL live cage. There is no daemon in a
// cxell and no route to the fleet's cages from one. What is proven here is the sweep's own logic —
// the right copies into the right path, in order; the stale-image verdict ONCE per sweep and not
// once per cage (the detector still runs per cage); a failing cage counted, never thrown; and
// simulate installing nothing. The pure install sequence is asserted in cxell-cli-drift.test.mjs.
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tag = randomUUID().slice(0, 8);
const tmp = mkdtempSync(join(tmpdir(), 'clisweep-'));
const bin = join(tmp, 'bin');
const DOCKER_LOG = join(tmp, 'docker.log');
mkdirSync(bin, { recursive: true });
// The sha the fake reports as the BAKED CLI: a valid 64-hex that is not scripts/zee's digest, i.e.
// a cage that booted from a stale zee-agent image. Every cage gets it, which is the point — the
// verdict is the same fleet-wide and must be said once.
const BAKED = 'ab'.repeat(32);
writeFileSync(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> ${DOCKER_LOG}
case "$*" in
  *sha256sum*) echo '${BAKED}  /usr/local/bin/zee' ;;
  *cxell_${tag}-dead*) exit 1 ;;
esac
exit 0
`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
const dockerCalls = () => (existsSync(DOCKER_LOG) ? readFileSync(DOCKER_LOG, 'utf8').split('\n').filter(Boolean) : []);
const resetDocker = () => { try { rmSync(DOCKER_LOG); } catch { /* not written yet */ } };

const { refreshZeeToolingInLiveCxells, zeeCliSourcePath, ZEE_CLI_DEST } =
  await import('../server/src/lib/cxell.js');
const { recentLogs } = await import('../server/src/lib/logbus.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const since = () => recentLogs(1000).length;
const logsSince = (n) => recentLogs(1000).slice(n).map((l) => l.msg);

const source = zeeCliSourcePath();
const alive = [
  { ctx: 'default', name: `cxell_${tag}-one` },
  { ctx: 'default', name: `cxell_${tag}-two` },
  { ctx: 'default', name: `cxell_${tag}-three` },
];

try {
  ok(dockerCalls().length === 0 && readFileSync(join(bin, 'docker'), 'utf8').includes(DOCKER_LOG),
     'the fake docker is first on PATH — so "did it try?" is a recorded fact, not an inference');

  // ── 1. every live cage gets the CLI, and the two attend-path files with it ───────────────────
  console.log('\n── real mode reaches EVERY live cage with the queenzee\'s CLI ──');
  resetDocker();
  let n = since();
  const r = await refreshZeeToolingInLiveCxells(async () => alive, { mode: 'real' });
  ok(r.swept === 3 && r.ok === 3 && r.failed.length === 0, 'all three cages refreshed');
  for (const { name } of alive) {
    ok(dockerCalls().includes(`cp ${source} ${name}:/tmp/zee.cli`),
       `copies the queenzee's own scripts/zee to ${name}:/tmp/zee.cli`);
    ok(dockerCalls().some((c) => c.startsWith(`exec -u 0 ${name} `) && c.includes(ZEE_CLI_DEST)),
       `and installs it over ${ZEE_CLI_DEST} in ${name}`);
    ok(dockerCalls().some((c) => c.startsWith('cp ') && c.endsWith(`${name}:/tmp/zee-live.mjs`)),
       `and the live-feed renderer still rides along (${name})`);
  }
  const cliShell = dockerCalls().find((c) => c.includes('/tmp/zee.cli') && c.includes('mv -f'));
  ok(!!cliShell && cliShell.includes(`/usr/local/bin/zee.new.$$`)
     && cliShell.includes('mv -f /usr/local/bin/zee.new.$$ /usr/local/bin/zee'),
     'the CLI is placed by an ATOMIC RENAME — the sweep now writes into cages that may be MID-TURN, '
     + 'and install(1) alone leaves the path absent for the unlink/create window');

  // ── 2. the stale-image detector: per cage, but ONE log line for the sweep ────────────────────
  console.log('\n── a stale image is detected per cage, reported once per sweep ──');
  const shaChecks = dockerCalls().filter((c) => /sha256sum/.test(c) && c.startsWith('exec -u 0'));
  ok(shaChecks.length === 3,
     'the sha256 detector still runs for every cage — it is the only thing that tells a repaired CLI '
     + 'from a repaired IMAGE, and it is not deleted');
  const staleLines = logsSince(n).filter((m) => /!!! STALE CXELL IMAGE/.test(m));
  ok(staleLines.length === 1, `the verdict is logged ONCE for the whole sweep, not once per cage (${staleLines.length})`);
  ok(/3\/3/.test(staleLines[0]), 'naming how many of the swept cages booted from a stale image');
  ok(/CLI ONLY/.test(staleLines[0]) && /cxell-sshd\.sh/.test(staleLines[0]) && /Rebuild the image/.test(staleLines[0]),
     'and saying plainly that the CLI refresh is NOT an image rebuild (other baked files stay stale)');
  ok(r.stale_image === 3, 'the count rides on the result as stale_image');

  // ── 3. one unreachable cage is counted, never thrown — the sweep goes on ─────────────────────
  console.log('\n── a failing cage does not stop the sweep ──');
  resetDocker();
  const mixed = await refreshZeeToolingInLiveCxells(async () => ([
    { name: `cxell_${tag}-live` }, { name: `cxell_${tag}-dead` }, { name: `cxell_${tag}-after` },
  ]), { mode: 'real' });
  ok(mixed.swept === 3 && mixed.ok === 2 && mixed.failed.length === 1 && mixed.failed[0] === `cxell_${tag}-dead`,
     'the dead cage is COUNTED as failed and the other two still refresh');
  ok(dockerCalls().includes(`cp ${source} cxell_${tag}-after:/tmp/zee.cli`),
     'the cage AFTER the failure still got its CLI — the sweep does not bail');

  // ── 4. simulate reports what it WOULD do and touches nothing ─────────────────────────────────
  console.log('\n── simulate installs nothing and says so (PROVISION_MODE) ──');
  resetDocker();
  n = since();
  const dry = await refreshZeeToolingInLiveCxells(async () => alive, { mode: 'simulate' });
  ok(dry.dry_run === true && dry.swept === 3 && dry.ok === 0 && dockerCalls().length === 0,
     'no docker cp, no docker exec, not even the sha check');
  const dryLogs = logsSince(n);
  ok(dryLogs.some((m) => /zee tooling/.test(m) && /PROVISION_MODE=simulate/.test(m) && m.includes(alive[0].name)),
     'and the log names the cages it would have refreshed — "not allowed" must not look like "nothing to do"');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures ? 1 : 0);

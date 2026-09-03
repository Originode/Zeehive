// A SHIP MUST NEVER ROLL PRODUCTION BACKWARDS — the 2026-08-23 incident, replayed.
//
// WHAT HAPPENED. A ship requested at 16:26 for eed2ffb8 was not executed until 17:15. In those 49
// minutes two NEWER ships completed (e708af96 at 16:42, fd5a3855 at 17:08). A ship's target is
// resolved ONCE, at REQUEST time; nothing re-checked it at EXECUTION time, so the old request reset
// the checkout to its 16:26-era sha and rebuilt — production went back to code older than it was
// already running, reverting the compose gateway port publish and the landed probe/fallback code.
// Nothing in the system noticed; a human said "it broke again".
//
// WHAT THIS PINS:
//   1. the DECISION as a pure function (server/src/lib/ship-direction.js) — table-tested, no git,
//      no database, no fleet: behind → REFUSE, forward → proceed, same sha → "already live",
//      and every unknowable case → proceed (a refusal must be DEFINITE, never a guess);
//   2. the RESOLVER (shipgate.resolveShipDirection) against a REAL throwaway git repo shaped like
//      the incident, with the ledger lookup injected — so the ancestry and the "how far behind"
//      count are measured by real git, not asserted about;
//   3. that the refusal is a NAMED, RENDERABLE failure — classifyShipFailure maps its words to the
//      'ship-behind-live' cause the console shows on a failed card (not a silent skip);
//   4. that the guard is asked BEFORE anything is deployed (before the migration apply and the
//      container builds in runShipBody) — the placement is the fix, not the check;
//   5. the belt-and-braces refusal in scripts/self-ship-sync.sh, by RUNNING it: a backwards target
//      must leave the checkout untouched, a forward one must still sync;
//  5b. and what that shell guard is allowed to call "backwards" (the FALSE REFUSAL of 2026-09-03).
//      It compared the target against `git rev-parse HEAD`. In this self-hosting checkout HEAD is
//      the last LAND, not the last DEPLOY — the landing gate moves master with update-ref and never
//      touches the tree — so a ship approved after any landing was bounced as "BACKWARDS ... would
//      revert everything shipped since" when it was strictly FORWARD of the running code. b5a7bde1
//      died that way; the server-side ledger guard had allowed it one layer up. The reference is now
//      the sha the script last SYNCED THE TREE TO (ledger file → the log's last OK line → HEAD, but
//      only while the tree still matches it → otherwise proceed, saying the check did not run). This
//      section builds the exact shape with update-ref and asserts BOTH directions: the forward ship
//      syncs, the genuinely-backwards one is still refused;
//   6. END TO END through runShipBody against a throwaway postgres (`zee db-sandbox --migrate`) and
//      the same real repo: the backwards ship lands 'failed' with the named cause, its build script
//      is NEVER executed, and the site's lock gets its release countdown — while the forward control
//      ships and DOES execute the build. Skipped loudly (never silently) without DATABASE_URL.
import { execFileSync, spawnSync } from 'node:child_process';
import pg from 'pg';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { shipDirectionVerdict, SHIP_DIRECTIONS, SHIP_BEHIND_LIVE_CAUSE } =
  await import('../server/src/lib/ship-direction.js');
const { classifyShipFailure } = await import('../server/src/lib/ship-failure.js');
const { resolveShipDirection } = await import('../server/src/queenzee/shipgate.js');

// ── 1. the pure decision, as a table ────────────────────────────────────────────
console.log('── shipDirectionVerdict (pure) ──');
const EED = 'eed2ffb8aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';   // the stale target
const FD  = 'fd3855aabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';   // what production was already running
const table = [
  { name: 'THE INCIDENT: target is an ancestor of live → REFUSE',
    in: { target: EED, deployed: FD, isAncestor: true, behind: 2 },
    allowed: false, direction: 'behind-live' },
  { name: 'a normal forward ship → proceed',
    in: { target: FD, deployed: EED, isAncestor: false, behind: null },
    allowed: true, direction: 'forward' },
  { name: 'target === live → "already live", NOT a failure',
    in: { target: FD, deployed: FD, isAncestor: true, behind: 0 },
    allowed: true, direction: 'already-live' },
  { name: 'nothing has ever shipped → unknown, proceed',
    in: { target: FD, deployed: null, isAncestor: null, behind: null },
    allowed: true, direction: 'unknown' },
  { name: 'ancestry UNREADABLE → unknown, proceed (a refusal must be definite)',
    in: { target: EED, deployed: FD, isAncestor: null, behind: null },
    allowed: true, direction: 'unknown' },
  { name: 'no commit on the request → unknown, proceed',
    in: { target: null, deployed: FD, isAncestor: null, behind: null },
    allowed: true, direction: 'unknown' },
];
for (const row of table) {
  const v = shipDirectionVerdict(row.in);
  ok(v.allowed === row.allowed && v.direction === row.direction,
     `${row.name} → allowed=${v.allowed} direction=${v.direction}`);
  ok(typeof v.reason === 'string' && v.reason.length > 20, '   …and it says WHY, in a sentence');
  ok(SHIP_DIRECTIONS.includes(v.direction), '   …with a direction from the fixed vocabulary');
}
{
  const v = shipDirectionVerdict({ target: EED, deployed: FD, isAncestor: true, behind: 2 });
  ok(/BACKWARDS/.test(v.reason), 'the refusal names the actual danger: rolling production BACKWARDS');
  ok(v.reason.includes('eed2ffb8') && v.reason.includes('fd3855aa'),
     'the refusal names BOTH shas — which was requested, and which is live');
  ok(/2 commits behind/.test(v.reason), 'the refusal says HOW FAR behind');
  ok(/re-request/i.test(v.reason) && /human/.test(v.reason),
     'the refusal says what to do: re-request at main\'s tip, approved by a human');
  ok(/never advanced automatically/.test(v.reason),
     'the refusal states it will NOT silently retarget (that would deploy unapproved code)');
  ok(shipDirectionVerdict({}).allowed === true && shipDirectionVerdict().allowed === true,
     'a degenerate call never throws and never refuses');
}

// ── 2. the resolver, against a REAL git repo shaped like the incident ───────────
console.log('\n── resolveShipDirection (real git, injected ledger) ──');
const parent = mkdtempSync(join(tmpdir(), 'zeehive-shipdir-'));
const repo = join(parent, 'repo');
mkdirSync(repo);
const g = (...args) => String(execFileSync('git', ['-C', repo, ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
let A, B, C, SIDE;
try {
  g('init', '-q', '-b', 'master');
  g('config', 'user.email', 'test@zeehive'); g('config', 'user.name', 'zeehive test');
  writeFileSync(join(repo, 'compose.yml'), 'ports: []\n');
  g('add', '-A'); g('commit', '-qm', 'A — the 16:26-era commit (no 4701 publish)');
  A = g('rev-parse', 'HEAD');
  g('branch', 'side');
  writeFileSync(join(repo, 'compose.yml'), 'ports: ["4701:4701"]\n');
  g('add', '-A'); g('commit', '-qm', 'B — publish the gateway port (shipped 16:42)');
  B = g('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'probe.js'), 'export const probeGatewayBase = () => {};\n');
  g('add', '-A'); g('commit', '-qm', 'C — the gateway probe/fallback (shipped 17:08, LIVE)');
  C = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'side');
  writeFileSync(join(repo, 'other.txt'), 'unrelated work\n');
  g('add', '-A'); g('commit', '-qm', 'a commit on a side branch — neither ancestor nor descendant of C');
  SIDE = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'master');

  const project = { id: 'proj-1', repo_root: repo };
  const ledger = (commit) => async () => (commit ? { id: 'ship-live', commit } : null);
  const dir = (target, live, opts = {}) => resolveShipDirection(project,
    { id: 'ship-under-test', commit: target, site_id: null }, null,
    { deployedLookup: opts.lookup || ledger(live) });

  const incident = await dir(A, C);
  ok(incident.allowed === false && incident.direction === 'behind-live',
     'THE INCIDENT: target A with C live → REFUSED (behind-live)');
  ok(incident.behind === 2, `real git counted the distance: ${incident.behind} commits behind`);
  ok(incident.reason.includes(A.slice(0, 8)) && incident.reason.includes(C.slice(0, 8)),
     'the refusal names the requested and the live sha');

  const forward = await dir(C, A);
  ok(forward.allowed === true && forward.direction === 'forward',
     'a normal forward ship (C with A live) is unaffected');

  const same = await dir(C, C);
  ok(same.allowed === true && same.direction === 'already-live',
     're-shipping the live sha is "already live", not a failure');

  const oneStep = await dir(B, C);
  ok(oneStep.allowed === false && oneStep.behind === 1, 'one commit behind is still backwards → REFUSED');

  const diverged = await dir(SIDE, C);
  ok(diverged.allowed === true && diverged.direction === 'forward',
     'a DIVERGED sha (not an ancestor of live) is not refused — the guard only ever refuses on ancestry');

  const firstShip = await dir(C, null);
  ok(firstShip.allowed === true && firstShip.direction === 'unknown',
     'nothing shipped yet → unknown, and the ship proceeds');

  const missing = await dir('0'.repeat(40), C);
  ok(missing.allowed === true && missing.direction === 'unknown',
     'a target sha that does not resolve → unknown, and the ship proceeds (never a guessed refusal)');

  const broken = await dir(A, C, { lookup: async () => { throw new Error('db is down'); } });
  ok(broken.allowed === true && broken.direction === 'unknown',
     'an UNREADABLE ledger → unknown, and the ship proceeds — it must never be a new way to block prod');
  ok(/could not read the ship ledger/.test(broken.reason) && /db is down/.test(broken.reason),
     '   …and it says the ledger could not be read, naming the error (never "nothing is live")');

  // ── 3. the refusal is a NAMED failure the console renders ─────────────────────
  console.log('\n── the refusal is a named, visible ship failure ──');
  const classified = classifyShipFailure({ error: incident.reason });
  ok(classified.cause === SHIP_BEHIND_LIVE_CAUSE,
     `the refusal text classifies as '${classified.cause}' (the cause stored on the failed ship_request)`);
  ok(classified.line.length > 20, 'and carries an identifying line for the card');
  const fromShell = classifyShipFailure({ containers: [{ ok: false, role: 'server', log:
    '[2026-08-23T17:15:06Z] self-ship-sync: REFUSED: BACKWARDS ship refused — the target eed2ffb8 is an '
    + 'ancestor of what this checkout already has (fd3855aa), 2 commit(s) behind.' }] });
  ok(fromShell.cause === SHIP_BEHIND_LIVE_CAUSE,
     'the SHELL guard\'s refusal, arriving as a build log, classifies the same way');
  // Both wordings, because both reach the console: a queenzee still running an older image emits the
  // 2026-08-23 sentence, the current script emits the 2026-09-03 one. The classifier keys on
  // "BACKWARDS ship refused", which is why that phrase is not free to change.
  const fromShellNow = classifyShipFailure({ containers: [{ ok: false, role: 'server', log:
    '[2026-09-03T03:05:58Z] self-ship-sync: REFUSED: BACKWARDS ship refused — the target eed2ffb8 is an '
    + 'ancestor of what is DEPLOYED (fd3855aa, per the last sync this script recorded), 2 commit(s) behind.' }] });
  ok(fromShellNow.cause === SHIP_BEHIND_LIVE_CAUSE,
     'and so does the current wording — the phrase the classifier keys on survived the fix');

  // ── 4. the guard is asked BEFORE anything is deployed ─────────────────────────
  console.log('\n── placement: the guard runs before the deploy touches anything ──');
  const src = readFileSync(join(ROOT, 'server/src/queenzee/shipgate.js'), 'utf8');
  const iGuard = src.indexOf('resolveShipDirection(project, shipping');
  const iMigrate = src.indexOf('await applyMigrations(');
  const iBuild = src.indexOf('await runScript(c,');
  ok(iGuard > 0, 'runShipBody asks the direction guard');
  ok(iGuard < iMigrate, 'it is asked BEFORE the migrations are applied');
  ok(iGuard < iBuild, 'it is asked BEFORE any container is built');
  ok(/failShipUpfront\(/.test(src), 'a refusal goes through the terminal-failure path (row + lock countdown)');
  ok(/SHIP_BEHIND_LIVE_CAUSE/.test(src), 'the failed row carries the named cause');
  ok(!/commit\s*=\s*headCommit\([^)]*\)[^;]*;\s*\/\/ retarget/.test(src),
     'nothing retargets a refused ship to the tip');

  // ── 5. the shell belt-and-braces, RUN for real ────────────────────────────────
  console.log('\n── scripts/self-ship-sync.sh (executed) ──');
  // spawnSync, not execFileSync: the script says what it decided on STDERR whether it refuses or
  // proceeds, and the "why" of a PERMITTED sync is exactly what 5b has to read.
  const sync = (ref) => {
    const r = spawnSync('bash', [join(ROOT, 'scripts/self-ship-sync.sh'), repo, ref],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: r.status ?? -1, err: String(r.stderr || '') };
  };
  // the checkout is at C (live); a ship targeting A would reset it BACKWARDS
  ok(g('rev-parse', 'HEAD') === C, 'the checkout starts at C');
  const back = sync(A);
  ok(back.code !== 0, `a backwards target exits non-zero (${back.code}) — the caller aborts the ship`);
  ok(/BACKWARDS ship refused/.test(back.err), 'it says WHY, in the words the classifier knows');
  ok(g('rev-parse', 'HEAD') === C, 'and the checkout is UNTOUCHED — production keeps the newer code');

  // a legitimate forward sync still works: from A up to C
  g('reset', '--hard', A);
  const fwd = sync(C);
  ok(fwd.code === 0, 'a forward sync still succeeds (exit 0)');
  ok(g('rev-parse', 'HEAD') === C, 'and the tree is moved to the ship sha');

  // the same-sha case is a no-op sync, never a refusal
  const noop = sync(C);
  ok(noop.code === 0 && g('rev-parse', 'HEAD') === C, 're-syncing to the sha already checked out is fine');
  g('checkout', '-q', 'master');

  // ── 5b. THE FALSE REFUSAL of 2026-09-03: HEAD is the last LAND, not the last DEPLOY ──────────
  // The landing gate advances master with `update-ref` and never touches the tree (the reason this
  // script exists at all). So between two ships HEAD runs ahead of the deployed files, and the guard
  // used to read that gap as "production has newer code". Ship b5a7bde1 was strictly FORWARD of what
  // was running and was refused with "would revert everything shipped since" — nothing had shipped.
  const ledgerFile = join(parent, `zeehive-self-ship-deployed-${basename(repo)}.sha`);
  const deploy = (sha) => { g('reset', '--hard', sha); writeFileSync(ledgerFile, `${sha}\n`); };
  const land = (sha) => execFileSync('git', ['-C', repo, 'update-ref', 'refs/heads/master', sha],
    { stdio: ['ignore', 'pipe', 'pipe'] });   // the gate's move: the ref only, tree untouched
  {
    deploy(A);                       // production is running A…
    land(C);                         // …and two landings have moved master to C since
    ok(g('rev-parse', 'HEAD') === C && g('status', '--porcelain') !== '',
       'the shape: HEAD is the LANDED tip while the tree still holds the DEPLOYED commit');
    const fwd2 = sync(B);            // B: behind HEAD, but a commit ahead of what is deployed
    ok(fwd2.code === 0,
       `a target BEHIND HEAD but AHEAD of the deployed sha is NOT refused (exit ${fwd2.code}) — `
       + 'this is the ship the old check bounced');
    ok(/direction OK/.test(fwd2.err) && /last LAND, not the last deploy/.test(fwd2.err),
       'and it says which reference it used, so the next reader is not misled by HEAD');
    ok(g('rev-parse', 'HEAD') === B, 'the tree really moved to the ship sha');
  }
  {
    deploy(C);                       // now C IS deployed…
    land(C);
    const back2 = sync(A);           // …so A is genuinely backwards, ledger or no ledger
    ok(back2.code !== 0 && /BACKWARDS ship refused/.test(back2.err),
       'a REAL backwards ship is still refused — the fix narrows the reference, not the guard');
    ok(/is an ancestor of what is DEPLOYED/.test(back2.err) && /2 commit\(s\) behind/.test(back2.err),
       'and the refusal now names what it measured against, and how far');
    ok(g('rev-parse', 'HEAD') === C, 'the checkout is untouched');
  }
  {
    // The incident's own shape, with a landing on top: deployed C, master landed past it. Without a
    // ledger this is unknowable from HEAD alone — and the old fallback would have got it WRONG.
    rmSync(ledgerFile, { force: true });
    const logFile = join(parent, 'zeehive-self-ship-sync.log');
    const savedLog = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    rmSync(logFile, { force: true });
    g('reset', '--hard', A); land(C);
    const blind = sync(B);
    ok(blind.code === 0 && /direction UNCHECKED here/.test(blind.err),
       'with NOTHING local to compare against, it proceeds and says the check did not run — '
       + 'the authoritative guard is server-side, and a refusal must be definite');
    // …and the log alone is enough to make the NEXT one definite again (an older queenzee wrote no
    // ledger; this is what makes the first ship after this change correct, not the second).
    rmSync(ledgerFile, { force: true });
    g('reset', '--hard', C); land(C);
    writeFileSync(logFile, `[t] self-ship-sync: OK working tree now at ${C.slice(0, 12)} (HEAD x → y)\n`);
    const fromLog = sync(A);
    ok(fromLog.code !== 0 && /per the last successful sync in zeehive-self-ship-sync\.log/.test(fromLog.err),
       'a prior sync recorded only in the LOG still refuses a backwards ship, and names that source');
    writeFileSync(logFile, savedLog);
  }
  g('checkout', '-q', 'master');
  g('reset', '--hard', C);

  // ── 6. END TO END: runShipBody against a real database ────────────────────────
  // The sections above prove the DECISION and the placement; this one proves the WIRING — that the
  // refusal's own SQL runs, that the failed row carries the cause the console renders, that the
  // build script is never executed, and that the site's lock is released on a countdown (a guard
  // that wedged the prod lock would be worse than the bug it fixes).
  if (!process.env.DATABASE_URL) {
    console.log('\n── 6. end-to-end through runShipBody (SKIPPED — no DATABASE_URL; use `zee db-sandbox --migrate`) ──');
  } else {
    console.log('\n── 6. end-to-end through runShipBody (real db, real repo) ──');
    const PID = '00000000-0000-4000-8000-0000000ba110';
    const XOURCE = '00000000-0000-4000-8000-0000000ba220';
    const XELL = '00000000-0000-4000-8000-0000000ba330';
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query('DELETE FROM project WHERE id=$1', [PID]).catch(() => {});
      const { runShipBody } = await import('../server/src/queenzee/shipgate.js');

      // A build script that leaves a MARKER when it runs. Its absence is the evidence that the
      // refusal happened BEFORE anything was deployed — not merely that the row says 'failed'.
      const marker = join(parent, 'built.log');
      const script = join(parent, 'fake-build.sh');
      writeFileSync(script, '#!/usr/bin/env bash\n'
        + `echo "built ref=\$6 mode=\$4" >> "${marker}"\n`
        + 'printf \'{"ok":true,"head":"unknown","method":"test-build"}\\n\'\n');

      await client.query(
        `INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'ship-backwards-test',$2,'master')`,
        [PID, repo]);
      await client.query('INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,$3)', [XOURCE, PID, 'master']);
      await client.query(
        `INSERT INTO xell (id, project_id, xource_id, slug, branch, worktree_path, status)
           VALUES ($1,$2,$3,'ship-backwards-cove','spinoff/ship-backwards',$4,'working')`,
        [XELL, PID, XOURCE, repo]);
      await client.query(
        `INSERT INTO container (project_id, role, tier, isolation, name, build_script, docker_ctx, site_id)
           VALUES ($1,'server','prod','shared','prod_server_test',$2,'default',NULL)`, [PID, script]);
      const xellRow = (await client.query('SELECT * FROM xell WHERE id=$1', [XELL])).rows[0];
      const projRow = (await client.query('SELECT * FROM project WHERE id=$1', [PID])).rows[0];

      // the ledger: production was last given C (the 17:08 ship)
      await client.query(
        `INSERT INTO ship_request (project_id, xell_id, commit, status, targets, finished_at, decided_at, decided_by)
           VALUES ($1,$2,$3,'shipped',ARRAY['server','webapp'], now(), now(),'human@console')`, [PID, XELL, C]);
      // …and the stale request, approved 49 minutes after it was raised, still aimed at A
      const stale = (await client.query(
        `INSERT INTO ship_request (project_id, xell_id, commit, status, targets, reason, decided_at, decided_by)
           VALUES ($1,$2,$3,'approved',ARRAY['server'],'the 16:26 request, approved at 17:15', now(),'human@console')
         RETURNING *`, [PID, XELL, A])).rows[0];
      await client.query(
        `INSERT INTO deploy_lock (project_id, container, xell_id, phase, ship_id) VALUES ($1,'prod',$2,'shipping',$3)`,
        [PID, XELL, stale.id]);

      await runShipBody(stale, xellRow, projRow, null, 'prod', 'simulate');

      const after = (await client.query('SELECT * FROM ship_request WHERE id=$1', [stale.id])).rows[0];
      ok(after.status === 'failed', `the backwards ship ends 'failed' (${after.status}) — a visible failure, not a silent skip`);
      ok(after.failure_cause === SHIP_BEHIND_LIVE_CAUSE, `failure_cause = ${after.failure_cause}`);
      ok(/BACKWARDS/.test(after.error || ''), 'the error a human reads says it would have rolled production backwards');
      ok((after.error || '').includes(A.slice(0, 8)) && (after.error || '').includes(C.slice(0, 8)),
         'and names the requested sha and the live one');
      ok(Array.isArray(after.containers) && after.containers[0]?.role === 'direction-guard',
         'the step that refused is recorded on the row');
      ok(!existsSync(marker), 'THE BUILD NEVER RAN — production was not touched');
      const lock = (await client.query('SELECT * FROM deploy_lock WHERE ship_id=$1', [stale.id])).rows[0];
      ok(lock?.phase === 'failed' && !!lock?.auto_release_at,
         'the site lock is on its release countdown — a refusal must never wedge production');

      // the FORWARD control, same machinery: production last got A, this ship carries C
      await client.query(`UPDATE ship_request SET commit=$2 WHERE project_id=$1 AND status='shipped'`, [PID, A]);
      const fwdShip = (await client.query(
        `INSERT INTO ship_request (project_id, xell_id, commit, status, targets, reason, decided_at, decided_by)
           VALUES ($1,$2,$3,'approved',ARRAY['server'],'a normal forward ship', now(),'human@console')
         RETURNING *`, [PID, XELL, C])).rows[0];
      await client.query('DELETE FROM deploy_lock WHERE project_id=$1', [PID]);
      await client.query(
        `INSERT INTO deploy_lock (project_id, container, xell_id, phase, ship_id) VALUES ($1,'prod',$2,'shipping',$3)`,
        [PID, XELL, fwdShip.id]);

      await runShipBody(fwdShip, xellRow, projRow, null, 'prod', 'simulate');
      const fwdAfter = (await client.query('SELECT * FROM ship_request WHERE id=$1', [fwdShip.id])).rows[0];
      ok(fwdAfter.status === 'shipped', `the forward ship still SHIPS (${fwdAfter.status}) — the guard is not in its way`);
      ok(existsSync(marker), 'and its build script DID run (the guard only ever stops a backwards move)');
    } finally {
      await client.query('DELETE FROM project WHERE id=$1', [PID]).catch(() => {});
      await client.end().catch(() => {});
    }
  }
} finally {
  rmSync(parent, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? 'ALL PASSED ✓' : `${fail} FAILURE(S) ✗`}`);
process.exit(fail === 0 ? 0 : 1);

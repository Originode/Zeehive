// GRADE A RESTORE WHEN IT FINISHES, AND READ pg_restore's TALLY — ticket #30.
//
// Two gaps, and they are complementary — neither substitutes for the other:
//   the TALLY says "this restore had trouble, and here is the cause" (a missing type, a failed COPY);
//   the GRADE says "and here is what is missing" (rows that did not arrive).
// A restore can ignore 400 errors while every table it loaded still passes its counts — indexes,
// constraints and triggers are not rows. And a table can come back empty with no error at all.
//
// THE FIXTURE IS REAL. Everything asserted about pg_restore's output was produced by running a real
    const sh = (cmd) => q(`COPY (SELECT 1) TO PROGRAM $prog$${cmd}$prog$`);
// throwaway database) and reading its stderr back verbatim. That is how the tally's exact wording was
// settled — and how a second, unknown bug surfaced:
//
//   pg_restore EXITS 1 WHEN IT MERELY IGNORED ERRORS. Both restore paths treated any non-zero exit as
//   a throw, so a restore that COMPLETED — data on disk — was logged "restore FAILED", never recorded
//   as having happened, and never graded. The omnibiz dev db missing core.location (a table its dump
//   certainly contained) is exactly that shape.
//
// So the decision cannot be made from the exit code. It is made from pg_restore's own tally, and the
// live section at the end re-runs the real thing to prove the fixture is not a story about the past.
process.env.MAINTENANCE_MODE = 'simulate';
process.env.MAINTENANCE_ENABLED = 'false';
process.env.PRODDIFF_ENABLED = 'false';
process.env.TKB_NOTIFY = '0';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const RE = await import('../server/src/lib/restore-errors.js');
const { q, one, pool } = await import('../server/src/db/pool.js');

// ── VERBATIM stderr from a real `pg_restore` (postgres 17, this xell's own container) ─────────────
// Produced by restoring a real -Fc dump over objects that still existed: CREATE fails, COPY fails on
// the primary key, pg_restore continues past all of it and reports its own count. Kept exactly as it
// came out, including the blank lines and the "Command was:" blocks, because the parser's whole job is
// to survive this shape.
const REAL_STDERR = `pg_restore: error: could not execute query: ERROR:  schema "zt30" already exists
Command was: CREATE SCHEMA zt30;


pg_restore: error: could not execute query: ERROR:  relation "t" already exists
Command was: CREATE TABLE zt30.t (
    id integer NOT NULL,
    note text
);


pg_restore: error: COPY failed for table "t": ERROR:  duplicate key value violates unique constraint "t_pkey"
DETAIL:  Key (id)=(1) already exists.
CONTEXT:  COPY t, line 1
pg_restore: error: could not execute query: ERROR:  multiple primary keys for table "t" are not allowed
Command was: ALTER TABLE ONLY zt30.t
    ADD CONSTRAINT t_pkey PRIMARY KEY (id);


pg_restore: warning: errors ignored on restore: 7
`;

let projId;
try {
  // ── 1. the tally, read out of real output ─────────────────────────────────────────────────────
  console.log('\n── pg_restore\'s own tally, parsed from output it really produced ──');
  const p = RE.parseRestoreErrors(REAL_STDERR);
  ok(p.completed === true, 'the tally line means pg_restore RAN TO THE END of the archive');
  ok(p.ignored === 7, 'and the number it reported is taken verbatim (7), never re-counted from lines');
  ok(p.errors.length === 4 && p.errors[0].includes('schema "zt30" already exists'),
     'the distinct error causes are kept, first line each — that is the part that names WHY');
  ok(!p.errors.some((e) => /^Command was:|^DETAIL:|^CONTEXT:/.test(e)),
     'and the Command was: / DETAIL: / CONTEXT: blocks are context, not separate errors');
  ok(!p.errors.some((e) => /errors ignored on restore/.test(e)), 'the tally is not counted as one of the errors');
  // Forty rows of the same missing type is ONE fact.
  const dup = RE.parseRestoreErrors(
    Array(40).fill('pg_restore: error: could not execute query: ERROR:  type "geometry" does not exist').join('\n')
    + '\npg_restore: warning: errors ignored on restore: 40\n');
  ok(dup.ignored === 40 && dup.errors.length === 1,
     'duplicates collapse: 40 identical errors are one cause and the tally still says 40');

  // ── 2. THE BUG: exit 1 does not mean "did not happen" ─────────────────────────────────────────
  console.log('\n── a restore that completed WITH HOLES is not a failed restore ──');
  const withErrors = RE.restoreOutcome({ status: 1, stderr: REAL_STDERR });
  ok(withErrors.ok === true, 'exit 1 + a tally → the restore HAPPENED (this is the bug: it was thrown away)');
  ok(withErrors.completed_with_errors === true && withErrors.ignored === 7, 'and it is flagged as completed-with-errors');
  const clean = RE.restoreOutcome({ status: 0, stderr: 'pg_restore: warning: errors ignored on restore: 0\n' });
  ok(clean.ok === true && clean.completed_with_errors === false && clean.ignored === 0, 'a clean restore is clean');
  const quiet = RE.restoreOutcome({ status: 0, stderr: '' });
  ok(quiet.ok === true && quiet.ignored === null,
     'exit 0 with no tally at all → clean, and it says it saw no tally rather than inventing a zero');
  const dead = RE.restoreOutcome({ status: 1, stderr: 'pg_restore: error: connection to server failed\n' });
  ok(dead.ok === false && /genuine failure/.test(dead.reason),
     'non-zero AND no tally → a GENUINE failure, still thrown (bad archive, refused connection, killed)');
  ok(dead.errors[0].includes('connection to server failed'),
     'and even a genuine failure keeps its cause for the log line');

  console.log('\n── a clean restore does not shout ──');
  ok(RE.restoreErrorLine(clean) === null && RE.restoreErrorLine(quiet) === null,
     'a clean restore produces NO extra line — a pool refresh restores databases all day, and a green '
     + 'announcement on every one of them is how the line that matters becomes invisible');
  ok(/7 error\(s\) IGNORED/.test(RE.restoreErrorLine(withErrors) || ''), 'a troubled one says so, loudly');
  ok(/e\.g\./.test(RE.restoreErrorLine(withErrors) || ''), 'and names the first cause, so the log is actionable');

  // ── 3. THE WIRING: both restore paths, and the duplicate path ─────────────────────────────────
  console.log('\n── every path that runs pg_restore reads the tally instead of the exit code ──');
  const m = read('server/src/queenzee/maintenance.js');
  const outcomes = (m.match(/restoreOutcome\(\{ status:/g) || []).length;
  ok(outcomes === 3, `all three pg_restore call sites are covered (${outcomes}/3: streamed, docker-cp, duplicate-prod)`);
  ok(!/if \(piped\.srcStatus !== 0 \|\| piped\.dstStatus !== 0\) \{\s*\n\s*throw new Error\(`streamed restore/.test(m),
     'the streamed path no longer throws on the DESTINATION exit code alone');
  ok(/if \(piped\.srcStatus !== 0\) \{/.test(m),
     'but a failed READER is still unconditional — no archive reached pg_restore at all');
  ok(/restore_report=\$4::jsonb/.test(m), 'the report is persisted on the container');
  ok(/gradeRestore\(c, tables\)\s*\n\s*\.catch/.test(m),
     'and the grade is fire-and-forget: a restore is never awaited on its own grading');

  // ── 3.5 PROD ROLES ARE NEVER REPLAYED ON A DEV COPY ───────────────────────────────────────────
  // A prod dump carries GRANT/ACL statements naming prod-only roles (read-only managers' `zee_ro_*`,
  // etc.). pg_restore replays those by default, so restoring into a dev server that lacks the roles
  // makes it exit 1 with "role does not exist" and the restore reports itself "completed with holes"
  // for ACL objects that have no meaning on the copy. Every DEV restore path must pass --no-privileges
  // so the data loads cleanly and the restore's tally means what a human reads it to mean — while a
  // restore OVER PROD (gated) must KEEP replaying ACLs, because prod's roles exist there and the
  // restore must not strip their grants.
  console.log('\n── prod roles are never replayed on a dev copy (--no-privileges) ──');
  ok(/const aclArg = c\.tier === 'prod' \? \[\] : \['--no-privileges'\]/.test(m),
     'runRestoreJob picks the ACL flag by TARGET tier: skip on dev, keep on prod');
  const devRestores = [...m.matchAll(/'pg_restore',[^\]]*?\]/g)].map((mm) => mm[0])
    .filter((s) => s.includes('--clean') && s.includes('...aclArg'));   // the two runRestoreJob paths
  ok(devRestores.length === 2, `both runRestoreJob paths thread aclArg (${devRestores.length})`);
  ok(devRestores.every((s) => s.includes('--no-owner') && s.includes('...aclArg')),
     'and both use the tier-dependent aclArg (skip on dev, keep on prod)');
  ok(/--no-owner', '--no-privileges', '-d', dbName\]/.test(m),
     'the duplicate-prod path carries --no-privileges (it always targets a dev db)');
  const sh = read('scripts/provision-xell-db.sh');
  ok(/pg_restore -U "\$DBUSER" --clean --if-exists --no-owner --no-privileges/.test(sh),
     'and the isolated-db provision script carries it too');

  console.log('\n── neither may fail a restore ──');
  const job = m.slice(m.indexOf('async function runRestoreJob'), m.indexOf('// ── DUPLICATE PROD'));
  ok(/restored = true;/.test(job) && job.indexOf('gradeRestore') > job.indexOf('clearBusy'),
     'the grade runs AFTER busy is cleared — a count taken mid-restore is half a database');
  ok(/gradeRestore\(c, tables\)[\s\S]{0,120}catch\(/.test(m.replace(/\s+/g, ' ').replace(/ /g, ' ')) || /gradeRestore\(c, tables\)\s*\n\s*\.catch\(\(e\)/.test(m),
     'every failure of the grade is caught and logged, never propagated');
  ok(/pool refreshes databases all day/.test(m),
     'and the reason a clean grade stays quiet is written down where the decision is');

  // ── 4. A SCOPED restore is graded only over what it loaded ────────────────────────────────────
  console.log('\n── a table-scoped restore is not graded against the whole database ──');
  const dd = read('server/src/queenzee/datadiff.js');
  ok(/only = null/.test(dd) && /scope\.has\(t\)/.test(dd),
     'checkContainerData takes the scope actually loaded');
  ok(/every untouched table as missing/.test(dd),
     'and says why: grading the whole db after a 3-table restore is a false alarm on a correct operation');
  ok(/gradeRestore\(c, tables\)/.test(m), 'the restore passes its table selection through');

  // ── 5. THE CONSOLE: three questions on one chip, each saying which it is ──────────────────────
  console.log('\n── the chip carries the tally and the grade, separately ──');
  const { dataText } = await import('../web/src/drift.js');
  const troubled = dataText({
    restore_report: { ok: true, ignored: 7, errors: ['could not execute query: ERROR:  type "geometry" does not exist'], error_count: 4 },
    restored_at: '2026-07-29T23:00:00Z',
    data_check: { ok: true, verdict: 'incomplete', ok_count: 30, checked: 35,
                  empty: [{ table: 'core.location', ref: 120345, got: 0 }], short: [] },
    data_check_at: '2026-07-29T23:01:00Z' });
  ok(/IGNORED 7 error\(s\)/.test(troubled), 'the tally is on the chip');
  ok(/type "geometry" does not exist/.test(troubled), 'with the cause a human can act on');
  ok(/ROWS MISSING vs the backup this db was restored from/.test(troubled), 'and the row grade beside it');
  ok(/core\.location — backup ~120,345, here 0/.test(troubled), 'naming the table that came back empty');
  ok(/Rows are a separate question/.test(troubled) && /Row COUNTS only/.test(troubled),
     'each reading says which question it answers — the whole point of TKT-22-4F0E, now with three of them');
  const quietChip = dataText({ restore_report: { ok: true, ignored: 0 }, restored_at: '2026-07-29T23:00:00Z',
    data_check: { ok: true, verdict: 'complete', ok_count: 35, checked: 35 }, data_check_at: '2026-07-29T23:01:00Z' });
  ok(/✓ last restore clean/.test(quietChip) && /✓ rows match/.test(quietChip),
     'a clean restore records both readings quietly — recorded is not the same as announced');
  ok(dataText({}) === '', 'and a container with neither reading adds nothing at all');

  // ── 6. THE GRADE, RUN FOR REAL off a real (simulated-mode) restore ────────────────────────────
  // MAINTENANCE_MODE=simulate skips only the docker work; every decision after it — the report, the
  // recorded source, the grade — runs exactly as in production. This is the DONE WHEN: a finished
  // restore is graded without anyone asking.
  console.log('\n── a finished restore grades itself, with nobody asking ──');
  const maint = await import('../server/src/queenzee/maintenance.js');
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,$2,'main','zt','zt') RETURNING id`, [`zt-r30-${Date.now()}`, '/tmp/zt-r30'])).id;
  await q(`INSERT INTO pool_config (project_id) VALUES ($1)`, [projId]);
  const dbC = (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name)
       VALUES ($1,'db','dev','shared',$2) RETURNING id`, [projId, `zt_r30_db_${Date.now()}`])).id;
  const snapId = (await one(
    `INSERT INTO db_snapshot (project_id, source, dump_path, status, mode, taken_at, size_bytes, row_counts, row_total)
       VALUES ($1,'prod','/tmp/zt-r30.dump','finished','real', now(), 99999, $2::jsonb, 1500) RETURNING id`,
    [projId, JSON.stringify({ 'public.a': 1000, 'public.b': 500 })])).id;

  const started = await maint.restoreBackup({ snapshot: snapId, container: dbC });
  ok(started.ok === true, 'the restore starts');
  // The job is async; wait for busy to clear, which is what the real code waits on too.
  for (let i = 0; i < 60; i++) {
    const row = await one(`SELECT busy_since, restored_from FROM container WHERE id=$1`, [dbC]);
    if (!row.busy_since && row.restored_from) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const after = await one(`SELECT restored_from, restored_at, data_check, data_check_at FROM container WHERE id=$1`, [dbC]);
  ok(after.restored_from === snapId, 'and it records WHICH snapshot it loaded');
  ok(after.restored_at != null, 'with when');
  // DID IT ACTUALLY GRADE? With no docker daemon the count probe cannot reach a container, so nothing
  // is persisted — which would leave the most important claim in this ticket unproven. The grade's own
  // log line is the evidence, and it is evidence nothing else could have written: the phrase only exists
  // in gradeRestore, and gradeRestore is only ever called off a finished restore.
  const { recentLogs } = await import('../server/src/lib/logbus.js');
  let graded = null;
  for (let i = 0; i < 40; i++) {
    graded = recentLogs(400).find((l) => l.scope === 'datadiff' && l.msg.includes('after the restore'));
    if (graded) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  ok(!!graded, 'THE GRADE RAN BY ITSELF off the finished restore — nobody asked for it');
  ok(/rows not graded after the restore/.test(graded?.msg || ''),
     `and with no daemon it says so honestly rather than inventing a verdict: "${(graded?.msg || '').slice(0, 90)}…"`);
  const restoreLine = recentLogs(400).find((l) => l.scope === 'maint' && /restore finished/.test(l.msg));
  ok(!!restoreLine && !/BUT/.test(restoreLine.msg),
     'and a simulated restore (no pg_restore, so no tally) logs the plain line — it does not invent trouble');
  const dc = await import('../server/src/queenzee/datadiff.js');
  const direct = await dc.checkContainerData(dbC);
  ok(direct.ok === false, 'and with no docker daemon it degrades honestly rather than inventing a verdict');
  ok(!/production/.test(direct.error || ''), 'a dev db is never refused as a prod subject');

  // Production stays refused as a subject, exactly as in P2 — asserted here too because #30 made the
  // check automatic, and an automatic check pointed at prod would be a new way to hurt production.
  const prodC = (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name)
       VALUES ($1,'db','prod','shared',$2) RETURNING id`, [projId, `zt_r30_prod_${Date.now()}`])).id;
  const onProd = await dc.checkContainerData(prodC);
  ok(onProd.ok === false && /never row-counted on demand/.test(onProd.error),
     'production is STILL refused as a subject, now that the check runs by itself');
  // ── 7. RE-RUN THE REAL THING, so the fixture is not a story about the past ────────────────────
  // The REAL_STDERR above is verbatim, but a fixture rots: a future pg_restore could reword its tally
  // and every assertion here would keep passing while the parser silently stopped matching. So when the
  // connection can do it, produce the output AGAIN, live, and parse THAT. Needs superuser (COPY … TO
  // PROGRAM) and pg_dump inside the db container; skipped LOUDLY rather than silently when it cannot.
  console.log('\n── the same parser against a pg_restore run right now ──');
  const su = await one(`SELECT usesuper FROM pg_user WHERE usename = current_user`);
  if (!su?.usesuper) {
    console.log('  … SKIPPED: this connection is not superuser, so it cannot run pg_restore in-container.');
    console.log('    The fixture above is verbatim output from a real run; the parse is still asserted.');
  } else {
    const sh = (cmd) => q(`COPY (SELECT 1) TO PROGRAM $prog$${cmd}$prog$`);
    const SCHEMA = `zt30_live_${Date.now()}`;
    const dump = `/tmp/${SCHEMA}.dump`, errf = `/tmp/${SCHEMA}.err`;
    try {
      const db = await one(`SELECT current_database() AS d, current_user AS u`);
      await q(`CREATE SCHEMA "${SCHEMA}"`);
      await q(`CREATE TABLE "${SCHEMA}".t (id int primary key, note text)`);
      await q(`INSERT INTO "${SCHEMA}".t SELECT g, 'row '||g FROM generate_series(1,5) g`);
      await sh(`pg_dump -U ${db.u} -d ${db.d} -Fc -n ${SCHEMA} -f ${dump}`);
      // Restore over the objects that still exist: CREATE fails, COPY fails on the key, pg_restore
      // continues past both and reports its own tally — the exact shape a missing type produces.
      await sh(`pg_restore -U ${db.u} -d ${db.d} ${dump} 2>${errf}; echo "EXIT=$?" >> ${errf}`);
      const live = (await one(`SELECT pg_read_file($1) AS t`, [errf]))?.t || '';
      const lp = RE.parseRestoreErrors(live);
      ok(/EXIT=1/.test(live),
         'CONFIRMED LIVE: pg_restore exits 1 for a restore it merely ignored errors on — which is why the '
         + 'exit code cannot be the signal, and why this ticket found a restore misclassified as failed');
      ok(lp.completed === true && lp.ignored > 0,
         `the parser reads today's pg_restore too: tally = ${lp.ignored} ignored error(s)`);
      ok(lp.errors.length > 0 && lp.errors.every((e) => !/^Command was:/.test(e)),
         'and picks the causes out of live output, not the Command was: blocks');
      ok(RE.restoreOutcome({ status: 1, stderr: live }).ok === true,
         'so the decision on a REAL exit-1-with-tally is: the restore happened');
    } finally {
      await q(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {});
      await sh(`rm -f ${dump} ${errf}`).catch(() => {});
    }
  }
} finally {
  if (projId) {
    await q(`UPDATE container SET restored_from=NULL WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM db_snapshot WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM container WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM pool_config WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  }
  await pool.end().catch(() => {});
}
console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);

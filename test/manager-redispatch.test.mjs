// RE-DISPATCHING INTO AN EXISTING MANAGER XELL — the input bug in dispatchXell.
//
// The console's ordinary dispatch route never sends `zee_type` (grep routes.js: the only zee_type it
// carries is the harness-list query). Only POST /api/managers does, via createManagerZee. So every
// ordinary dispatch used to arrive with dispatchXell's DEFAULT parameter — `zee_type = 'worker'` —
// and dispatchXell then decided EVERYTHING downstream from that parameter instead of from the TARGET
// XELL's actual type:
//
//   • the harness branch assigned the project's default WORKER harness, and 054's pairing correctly
//     refused it — "harness … is for worker zees, but this xell is a manager zee". The refusal was
//     right; the input was wrong. This is what an operator hit in the console.
//   • the prod read-only bind (`if (zee_type === 'manager')`) was SKIPPED, so a bare re-dispatch
//     would have silently STRIPPED a manager off production, and
//   • the else-branch would have attachXellDb()'d a non-prod database onto a manager.
//
// This test stands up a throwaway project with a REAL manager xell in the real meta DB and proves
// all three, plus the refusal that must NOT be silently allowed: an explicit worker downgrade.
//
// Docker is faked on PATH (the prod db row's identity check runs `docker ps`/`inspect`), PRODRO_MODE
// is simulate, so nothing anywhere near a real cluster is touched.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.PRODRO_MODE = 'simulate';   // never mint a role on a real database
process.env.SHIP_MODE = 'simulate';
process.env.PROVISION_MODE = 'simulate';
process.env.TKB_NOTIFY = '0';

// ── fake docker on PATH (same shim shape as db-resolver-integration.test.mjs) ────────────────────
const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const bin = mkdtempSync(join(tmpdir(), `mgrrd-bin-${tag}-`));
const stateFile = join(bin, 'state.json');
const setState = (s) => writeFileSync(stateFile, JSON.stringify(s));
const shim = join(bin, 'fake-docker.mjs');
writeFileSync(shim, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const a = process.argv.slice(2);
const st = JSON.parse(readFileSync(process.env.FAKE_DOCKER_STATE, 'utf8'));
if (a.includes('ps')) { process.stdout.write((st.ps||[]).map(c=>c.name+'\\t'+(c.ports||'')).join('\\n')+'\\n'); process.exit(0); }
if (a.includes('inspect')) { const n=a[a.length-1]; const p=(st.inspect||{})[n];
  if (p===undefined){process.stderr.write('No such object: '+n+'\\n');process.exit(1);} process.stdout.write(JSON.stringify(p)+'\\n'); process.exit(0); }
process.exit(0);
`);
writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash\nexec node "${shim}" "$@"\n`);
chmodSync(join(bin, 'docker'), 0o755);
process.env.FAKE_DOCKER_STATE = stateFile;
process.env.PATH = `${bin}:${process.env.PATH}`;

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

const client = new pg.Client({ connectionString: url });
const tmp = mkdtempSync(join(tmpdir(), 'mgrrd-'));
const PID = '00000000-0000-4000-8000-0000000e1111';
const XOURCE = '00000000-0000-4000-8000-0000000e2222';
const PRODC = `mgrrd${tag}_db_prod`;

async function cleanup({ files = false } = {}) {
  try { await client.query(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* */ }
  if (files) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
               try { rmSync(bin, { recursive: true, force: true }); } catch { /* */ } }
}

try {
  await client.connect();
  await cleanup();

  // ── a real repo + a worktree for the manager xell ─────────────────────────
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# redispatch test\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');

  // Two manager xells: one that has never worn a harness (the operator's case — the default-harness
  // branch fires), one already wearing the manager harness (the prod-bind branch is what breaks).
  const mkWt = (name, branch) => {
    const wt = join(tmp, name);
    git(repo, 'worktree', 'add', '-q', '-b', branch, wt, 'master');
    return wt;
  };
  const wtA = mkWt('retask-me-aa11bb', 'spinoff/retask-me-aa11bb');
  const wtB = mkWt('retask-two-bb22cc', 'spinoff/retask-two-bb22cc');
  const wtW = mkWt('plain-worker-cc33dd', 'spinoff/plain-worker-cc33dd');

  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,'mgr-redispatch-test',$2,'master','mgrrd','postgres')`, [PID, repo]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [XOURCE, PID]);

  // A PRODUCTION db row that publishes a host:port — the ordinary, already-supported shape. The
  // manager's read-only bind must actually happen on a bare re-dispatch.
  await client.query(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, host, host_port, internal_port)
       VALUES ($1,'db','prod','shared',$2,'default','10.9.9.9',5432,5432)`, [PID, PRODC]);
  setState({ ps: [{ name: PRODC, ports: '0.0.0.0:5432->5432/tcp' }],
             inspect: { [PRODC]: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '5432' }] } } });

  // The project default harness is a WORKER one — exactly the fleet's shape (`zeehive-dev` there,
  // `zee-base` here). This is the harness a bare dispatch used to force onto a manager.
  const workerH = (await client.query(`SELECT id, key FROM harness WHERE zee_type='worker' AND enabled ORDER BY key LIMIT 1`)).rows[0];
  const mgrH = (await client.query(`SELECT id, key FROM harness WHERE key='manager'`)).rows[0];
  ok(!!workerH && !!mgrH, `fixtures: a worker harness (${workerH?.key}) and the manager harness exist`);
  await client.query(`INSERT INTO pool_config (project_id, default_harness_id) VALUES ($1,$2)
                        ON CONFLICT (project_id) DO UPDATE SET default_harness_id=EXCLUDED.default_harness_id`,
                     [PID, workerH.id]);

  const mkXell = async (slug, wt, type, harnessId) => (await client.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, zee_type, harness_id)
       VALUES ($1,$2,$3,$4,$5,'ready',false,$6,$7) RETURNING *`,
    [PID, XOURCE, slug, `spinoff/${slug}`, wt, type, harnessId])).rows[0];

  const mgrA = await mkXell('retask-me-aa11bb', wtA, 'manager', null);
  const mgrB = await mkXell('retask-two-bb22cc', wtB, 'manager', mgrH.id);
  const wrk  = await mkXell('plain-worker-cc33dd', wtW, 'worker', null);

  const { dispatchXell } = await import('../server/src/queenzee/intake.js');

  // dispatchXell does all of its TYPE work (crew stamp → db bind → harness) BEFORE it spawns
  // anything. The spawn itself must fail in this test project (no provider token is connected), so
  // that failure is the marker for "everything before the spawn succeeded".
  const SPAWN_STAGE = /has no claude token|no ready xell|failed to launch|runtime .* is not in agent_runtime/i;
  const dispatch = async (body) => {
    try { const out = await dispatchXell(body); return { threw: false, out }; }
    catch (e) { return { threw: true, error: e.message }; }
  };
  // The prod read-only BIND happens mid-dispatch, and every dispatch in this throwaway project
  // fails at the spawn (no provider account) — which now correctly triggers the compensating UNBIND,
  // so the xell row afterwards cannot tell "bound then undone" from "never bound". Read the queenzee
  // log instead: it is the same ring the console renders, and it records both halves in order.
  const { recentLogs } = await import('../server/src/lib/logbus.js');
  let logMark = recentLogs(2000).length;
  const sinceDispatch = () => recentLogs(2000).slice(logMark).map((l) => l.msg);
  const markLogs = () => { logMark = recentLogs(2000).length; };
  const boundThenUndone = (slug) => {
    const lines = sinceDispatch();
    return {
      bound: lines.some((m) => m.startsWith(slug + ' bound to PRODUCTION READ-ONLY')),
      undone: lines.some((m) => m.startsWith(slug + ': UNBOUND from production read-only')),
    };
  };
  const readXell = async (id) => (await client.query(
    `SELECT x.*, h.key AS harness_key FROM xell x LEFT JOIN harness h ON h.id=x.harness_id WHERE x.id=$1`,
    [id])).rows[0];

  // ── 1. a BARE re-dispatch into a manager xell (no zee_type — what the console sends) ─────
  console.log('bare re-dispatch into a manager xell (the console\'s payload)');
  markLogs();
  const r1 = await dispatch({ xell_id: mgrA.id, project: PID, task: 'retask me', title: 'retask me' });
  ok(!(r1.threw && /is for worker zees/.test(r1.error)),
     `NOT refused by the harness pairing [${r1.threw ? r1.error.slice(0, 110) : 'no throw'}]`);
  ok(!r1.threw || SPAWN_STAGE.test(r1.error),
     'the only thing that fails is the spawn itself (no provider token in a throwaway project)');
  const a1 = await readXell(mgrA.id);
  ok(a1.zee_type === 'manager', `it is STILL a manager (zee_type=${a1.zee_type})`);
  ok(a1.harness_key === 'manager', `it wears the MANAGER harness, not the project's worker default (${a1.harness_key})`);
  const t1 = boundThenUndone('retask-me-aa11bb');
  ok(t1.bound, 'it IS bound to production READ-ONLY (its own zee_ro_ role) — the branch a bare re-dispatch used to skip');
  ok(t1.undone && a1.db_coupling !== 'db-prod-readonly',
     `…and because THIS dispatch then failed at the spawn, the bind is compensated rather than left on production (${a1.db_coupling})`);

  // ── 2. a manager that ALREADY wears the manager harness ─────────────────────
  // Here the old code never tripped the harness refusal (a xell with a harness keeps it), so the bug
  // was silent: the prod read-only bind was skipped and the manager came back off production.
  console.log('bare re-dispatch into a manager that already wears its harness');
  markLogs();
  const r2 = await dispatch({ xell_id: mgrB.id, project: PID, task: 'retask two', title: 'retask two' });
  ok(!r2.threw || SPAWN_STAGE.test(r2.error), `no refusal before the spawn [${r2.threw ? r2.error.slice(0, 110) : 'no throw'}]`);
  const b1 = await readXell(mgrB.id);
  ok(b1.zee_type === 'manager' && b1.harness_key === 'manager', 'type and harness are untouched');
  const t2 = boundThenUndone('retask-two-bb22cc');
  ok(t2.bound, 'production read-only is (re-)bound, not silently stripped — the SILENT half of this bug');
  ok(t2.undone, 'and undone again when the spawn fails, so nothing is left on the cluster');

  // ── 3. an EXPLICIT worker downgrade is REFUSED, and says what does change a type ──────────
  console.log('explicit zee_type=worker on a manager xell');
  markLogs();
  const r3 = await dispatch({ xell_id: mgrB.id, project: PID, task: 'downgrade me', title: 'retask two',
                              zee_type: 'worker' });
  ok(r3.threw, 'refused');
  ok(/manager/i.test(r3.error || '') && /\/api\/managers/.test(r3.error || ''),
     `the refusal names the real verb that changes a type [${(r3.error || '').slice(0, 160)}]`);
  const b2 = await readXell(mgrB.id);
  ok(b2.zee_type === 'manager' && b2.harness_key === 'manager',
     'and NOTHING was half-converted — it is still a manager wearing the manager manual');
  ok(!sinceDispatch().some((m) => /retask-two-bb22cc.*(bound to PRODUCTION|UNBOUND)/.test(m)),
     'a refused dispatch touches production not at all — no bind, and nothing to compensate');

  // ── 4. a plain worker dispatch is completely unchanged ───────────────────────
  console.log('an ordinary worker dispatch still behaves exactly as before');
  const r4 = await dispatch({ xell_id: wrk.id, project: PID, task: 'do work', title: 'plain worker' });
  ok(!r4.threw || SPAWN_STAGE.test(r4.error), `no refusal before the spawn [${r4.threw ? r4.error.slice(0, 110) : 'no throw'}]`);
  const w1 = await readXell(wrk.id);
  ok(w1.zee_type === 'worker', 'still a worker');
  ok(w1.harness_key === workerH.key, `and it inherits the project's default WORKER harness (${w1.harness_key})`);
  ok(w1.db_coupling !== 'db-prod-readonly' && !w1.prod_ro_dsn,
     'a worker is never bound to production read-only by a bare dispatch');

  // ── 5. explicitly promoting is still possible (createManagerZee's own payload) ───────────
  console.log('an explicit zee_type=manager still promotes (POST /api/managers\'s own payload)');
  markLogs();
  const r5 = await dispatch({ xell_id: wrk.id, project: PID, task: 'be a manager', title: 'plain worker',
                              zee_type: 'manager', harness: 'manager' });
  ok(!r5.threw || SPAWN_STAGE.test(r5.error), `no refusal before the spawn [${r5.threw ? r5.error.slice(0, 110) : 'no throw'}]`);
  const w2 = await readXell(wrk.id);
  ok(w2.zee_type === 'manager' && w2.harness_key === 'manager',
     'the worker xell became a manager, wearing the manager harness');
  ok(boundThenUndone('plain-worker-cc33dd').bound, 'and was put on production read-only');

  // ── 6. an UNNAMED worker dispatch is never handed a ready MANAGER xell ────────────────────
  // The console composer sends no xell_id: it takes "the freshest ready xell". A manager whose zee
  // died or whose work landed goes back to 'ready' WITH its prod binding and manager harness, so
  // that pick used to land on it — which is how the operator's refusal happened without anyone
  // naming a manager. Excluding it is the only answer that is neither a downgrade nor a dead end.
  console.log('an unnamed WORKER dispatch skips a ready manager xell');
  await client.query(`UPDATE xell SET status='ready', ready_at=now() WHERE id IN ($1,$2)`, [mgrA.id, mgrB.id]);
  // wrk is now a manager (case 5 promoted it); park it so the ONLY non-manager ready xell is new.
  await client.query(`UPDATE xell SET status='working' WHERE id=$1`, [wrk.id]);
  const wt2 = mkWt('spare-worker-dd44ee', 'spinoff/spare-worker-dd44ee');
  const spare = await mkXell('spare-worker-dd44ee', wt2, 'worker', null);
  await client.query(`UPDATE xell SET ready_at = now() - interval '1 hour' WHERE id=$1`, [spare.id]);

  // "Untouched" is now a COMPARISON, not an absolute: sections 1-2 legitimately unbound these two
  // (their dispatches failed at the spawn and the bind was compensated). What must hold here is that
  // an unnamed WORKER dispatch changes nothing about them at all.
  const beforeA = (await readXell(mgrA.id)).db_coupling;
  const beforeB = (await readXell(mgrB.id)).db_coupling;
  markLogs();
  const r6 = await dispatch({ project: PID, task: 'plain worker work', title: 'spare worker' });
  ok(!r6.threw || SPAWN_STAGE.test(r6.error), `no refusal before the spawn [${r6.threw ? r6.error.slice(0, 110) : 'no throw'}]`);
  const picked = await readXell(spare.id);
  ok(picked.harness_key === workerH.key,
     'it took the OLDER plain worker xell, not either of the two fresher ready MANAGER xells');
  const untouchedA = await readXell(mgrA.id);
  const untouchedB = await readXell(mgrB.id);
  ok(untouchedA.status === 'ready' && untouchedB.status === 'ready',
     'and both manager xells were left alone (still ready, not claimed by a worker dispatch)');
  ok(untouchedA.db_coupling === beforeA && untouchedB.db_coupling === beforeB,
     `their db binding is exactly as it was — nothing was downgraded to take a spare xell (${beforeA}/${beforeB})`);
  ok(!sinceDispatch().some((m) => /retask-(me|two)-\w+.*(bound to PRODUCTION|UNBOUND)/.test(m)),
     'and production was not touched on their behalf at all');

  // ── 7. with ONLY manager xells ready, the pool is dry for a worker — it does not "make do" ──
  console.log('only manager xells ready → a worker dispatch reports an EMPTY pool, it does not take one');
  await client.query(`UPDATE xell SET status='working' WHERE id=$1`, [spare.id]);
  await client.query(`UPDATE xell SET status='ready' WHERE id IN ($1,$2)`, [mgrA.id, mgrB.id]);
  const beforeA7 = (await readXell(mgrA.id)).db_coupling;
  markLogs();
  const r7 = await dispatch({ project: PID, task: 'nowhere to go' });
  ok(r7.threw && /no ready xell available/i.test(r7.error),
     `the pool reads as DRY, so the reconciler provisions a real one [${(r7.error || '').slice(0, 90)}]`);
  const a7 = await readXell(mgrA.id);
  ok(a7.zee_type === 'manager' && a7.status === 'ready' && a7.db_coupling === beforeA7,
     'and the ready manager is untouched rather than conscripted');

  // ── 8. …but an explicit MANAGER dispatch still draws from every ready xell ───
  console.log('an explicit MANAGER dispatch may still take a ready manager xell');
  const r8 = await dispatch({ project: PID, task: 'add a manager', zee_type: 'manager', harness: 'manager' });
  ok(r8.threw && SPAWN_STAGE.test(r8.error) && !/no ready xell available/i.test(r8.error),
     `it FOUND a target (only the spawn failed) [${(r8.error || '').slice(0, 90)}]`);

  // ── 9. A FAILED DISPATCH LEAVES NOTHING ON PRODUCTION ────────────────────────────────────────
  // bindManagerToProdReadonly mints a real `zee_ro_<slug>` role on a real cluster and re-points the
  // xell at prod — and the spawn after it can still fail (in this throwaway project it always does:
  // no provider account is connected, so spawnCreds throws before the cage-build try/catch is even
  // reached). Nothing used to undo that: a READY, zee-less xell was left pointing at production
  // holding a live credential, waiting on a teardown that only comes when the xell is reaped.
  console.log('a dispatch that fails after the prod bind UNBINDS it again');
  // A BYSTANDER: a manager bound to prod read-only directly (not through a dispatch), so nothing in
  // this section is dispatching into it. The compensation must be scoped to the failing dispatch's
  // OWN target — a manager minding its own business must not lose production because another
  // dispatch failed.
  const { bindManagerToProdReadonly } = await import('../server/src/lib/manager-spawn.js');
  const bystander = await mkXell('bystander-aa99zz', mkWt('bystander-aa99zz', 'spinoff/bystander-aa99zz'),
                                 'manager', mgrH.id);
  await bindManagerToProdReadonly(bystander.id);
  const bBefore = await readXell(bystander.id);
  ok(bBefore.db_coupling === 'db-prod-readonly' && !!bBefore.prod_ro_dsn, 'fixture: the bystander holds prod read-only');

  const victimWt = mkWt('victim-dd44ee', 'spinoff/victim-dd44ee');
  const victim = await mkXell('victim-dd44ee', victimWt, 'worker', null);
  const r9 = await dispatch({ xell_id: victim.id, project: PID, task: 'be a manager', title: 'victim',
                              zee_type: 'manager', harness: 'manager' });
  ok(r9.threw && SPAWN_STAGE.test(r9.error), `the spawn failed, as it must here [${(r9.error || '').slice(0, 80)}]`);
  const v9 = await readXell(victim.id);
  ok(v9.db_coupling !== 'db-prod-readonly',
     `the xell is NOT left pointing at production (${v9.db_coupling})`);
  ok(!v9.prod_ro_dsn, 'and holds no production DSN — the reader was dropped, not left for the reaper');
  ok(v9.zee_type === 'manager' && v9.harness_key === 'manager',
     'what it IS (a manager, wearing the manager manual) is untouched — only the prod credential is undone');

  // The compensation must be surgical: it undoes THIS dispatch's bind, and nothing else's.
  const b9 = await readXell(bystander.id);
  ok(b9.db_coupling === 'db-prod-readonly' && !!b9.prod_ro_dsn,
     "a DIFFERENT manager's binding is untouched by the failure");

  // ── 10. the universal spawn path is FREE for every xell this does not concern ────────────────
  // connectCxellToProdNetwork() runs on every cxell dispatch in the fleet. When the caller already
  // knows the coupling it must decide on a string comparison — no query, no docker, nothing that can
  // throw — or an unrelated dispatch can be sunk by manager code.
  console.log('connectCxellToProdNetwork short-circuits before any query for a non-manager xell');
  const { connectCxellToProdNetwork } = await import('../server/src/lib/prod-readonly.js');
  // POISONED id: `SELECT … WHERE id='not-a-uuid'` raises `invalid input syntax for type uuid`. So a
  // clean answer here PROVES no query was made — it is not an assertion about the answer, it is an
  // assertion about the path. Every non-manager dispatch in the fleet rides this.
  const call = async (args) => {
    try { return { out: await connectCxellToProdNetwork(args) }; }
    catch (e) { return { threw: true, error: e.message }; }
  };
  const cheap = await call({ xellId: 'not-a-uuid', dbCoupling: 'db-shared-dev', cxellName: 'cxell_x' });
  ok(!cheap.threw && cheap.out?.required === false && !cheap.out?.error,
     `a known non-prod-readonly coupling answers WITHOUT reading the xell row [${cheap.error || 'no query'}]`);
  const cheap2 = await call({ xellId: 'not-a-uuid', dbCoupling: 'db-clone', cxellName: 'cxell_x' });
  ok(!cheap2.threw && cheap2.out?.required === false, 'same for db-clone — the guard is the coupling, not the row');
  const cheap3 = await call({ xellId: 'not-a-uuid', dbCoupling: 'db-isolated', cxellName: 'cxell_x' });
  ok(!cheap3.threw && cheap3.out?.required === false, 'same for db-isolated (this xell\'s own coupling)');
  // With NO hint it must still never throw THROUGH a cage build — it fails closed as a returned
  // refusal, because a xell it cannot rule out may genuinely be a manager.
  const blind = await call({ xellId: 'not-a-uuid', cxellName: 'cxell_x' });
  ok(!blind.threw, 'with no coupling hint an unexpected failure is RETURNED, never thrown mid-cage-build');
  ok(blind.out?.required === true && !!blind.out?.error,
     `and it fails CLOSED, since a xell it could not read might be a manager [${(blind.out?.error || '').slice(0, 70)}]`);
  // A prod-read-only xell with the hint still does the real work (it is not short-circuited away).
  const real = await call({ xellId: bystander.id, dbCoupling: 'db-prod-readonly', cxellName: 'cxell_x' });
  ok(!real.threw && real.out?.required === false && /publishes 10\.9\.9\.9:5432/.test(real.out?.reason || ''),
     `a real manager IS resolved — this project's prod db publishes a port, so no join is needed [${real.out?.reason || real.out?.error}]`);

  // ── 11. a RETYPE writes type and harness together (no window wearing nothing) ────────────────
  // 054's trigger compares NEW.harness_id with NEW.zee_type in the same row version, so the two can
  // and must move in one statement. Clearing first and assigning after left a xell wearing NO manual
  // at all if anything in between threw — and the prod bind is in between.
  console.log('a retype never leaves the xell wearing nothing');
  const swapWt = mkWt('swap-ee55ff', 'spinoff/swap-ee55ff');
  const swap = await mkXell('swap-ee55ff', swapWt, 'worker', workerH.id);
  const r11 = await dispatch({ xell_id: swap.id, project: PID, task: 'promote', title: 'swap',
                               zee_type: 'manager', harness: 'manager' });
  ok(r11.threw && SPAWN_STAGE.test(r11.error), 'the dispatch got past the retype and died at the spawn');
  const s11 = await readXell(swap.id);
  ok(s11.zee_type === 'manager' && s11.harness_key === 'manager',
     `it wears the MANAGER manual, never nothing (${s11.harness_key})`);
  // The failure mode this replaces: the old code cleared harness_id, then the prod bind ran, then
  // assignHarness. Assert the invariant directly — a manager xell always wears a manager harness.
  for (const x of [await readXell(mgrA.id), await readXell(mgrB.id), s11, v9]) {
    ok(x.zee_type !== 'manager' || x.harness_key === 'manager',
       `invariant: manager xell ${x.slug} wears a manager harness (${x.harness_key})`);
  }
  // An explicit MISMATCHED harness on a retype is refused with the sentence, not a raw trigger error.
  const swap2 = await mkXell('swap2-ff66aa', mkWt('swap2-ff66aa', 'spinoff/swap2-ff66aa'), 'worker', null);
  const r11b = await dispatch({ xell_id: swap2.id, project: PID, task: 'promote badly', title: 'swap2',
                                zee_type: 'manager', harness: workerH.key });
  ok(r11b.threw && /is for worker zees/.test(r11b.error || '') && !/RAISE|plpgsql|syntax/i.test(r11b.error || ''),
     `refused with the explanation, not a postgres exception [${(r11b.error || '').slice(0, 90)}]`);
  const s11b = await readXell(swap2.id);
  ok(s11b.zee_type === 'worker' && !s11b.harness_key,
     'and the xell is not half-converted — it is still exactly what it was');

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  await cleanup({ files: true });
  await client.end().catch(() => {});
}
process.exit(fail ? 1 : 0);

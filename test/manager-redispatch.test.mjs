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
  const readXell = async (id) => (await client.query(
    `SELECT x.*, h.key AS harness_key FROM xell x LEFT JOIN harness h ON h.id=x.harness_id WHERE x.id=$1`,
    [id])).rows[0];

  // ── 1. a BARE re-dispatch into a manager xell (no zee_type — what the console sends) ─────
  console.log('bare re-dispatch into a manager xell (the console\'s payload)');
  const r1 = await dispatch({ xell_id: mgrA.id, project: PID, task: 'retask me', title: 'retask me' });
  ok(!(r1.threw && /is for worker zees/.test(r1.error)),
     `NOT refused by the harness pairing [${r1.threw ? r1.error.slice(0, 110) : 'no throw'}]`);
  ok(!r1.threw || SPAWN_STAGE.test(r1.error),
     'the only thing that fails is the spawn itself (no provider token in a throwaway project)');
  const a1 = await readXell(mgrA.id);
  ok(a1.zee_type === 'manager', `it is STILL a manager (zee_type=${a1.zee_type})`);
  ok(a1.harness_key === 'manager', `it wears the MANAGER harness, not the project's worker default (${a1.harness_key})`);
  ok(a1.db_coupling === 'db-prod-readonly', `it is still bound to production READ-ONLY (${a1.db_coupling})`);
  ok(typeof a1.prod_ro_dsn === 'string' && a1.prod_ro_dsn.startsWith('postgresql://zee_ro_'),
     'and it holds a read-only DSN minted for its own role');

  // ── 2. a manager that ALREADY wears the manager harness ─────────────────────
  // Here the old code never tripped the harness refusal (a xell with a harness keeps it), so the bug
  // was silent: the prod read-only bind was skipped and the manager came back off production.
  console.log('bare re-dispatch into a manager that already wears its harness');
  const r2 = await dispatch({ xell_id: mgrB.id, project: PID, task: 'retask two', title: 'retask two' });
  ok(!r2.threw || SPAWN_STAGE.test(r2.error), `no refusal before the spawn [${r2.threw ? r2.error.slice(0, 110) : 'no throw'}]`);
  const b1 = await readXell(mgrB.id);
  ok(b1.zee_type === 'manager' && b1.harness_key === 'manager', 'type and harness are untouched');
  ok(b1.db_coupling === 'db-prod-readonly' && !!b1.prod_ro_dsn,
     `production read-only is (re-)bound, not silently stripped (${b1.db_coupling})`);

  // ── 3. an EXPLICIT worker downgrade is REFUSED, and says what does change a type ──────────
  console.log('explicit zee_type=worker on a manager xell');
  const r3 = await dispatch({ xell_id: mgrB.id, project: PID, task: 'downgrade me', title: 'retask two',
                              zee_type: 'worker' });
  ok(r3.threw, 'refused');
  ok(/manager/i.test(r3.error || '') && /\/api\/managers/.test(r3.error || ''),
     `the refusal names the real verb that changes a type [${(r3.error || '').slice(0, 160)}]`);
  const b2 = await readXell(mgrB.id);
  ok(b2.zee_type === 'manager' && b2.harness_key === 'manager' && b2.db_coupling === 'db-prod-readonly',
     'and NOTHING was half-converted (type, harness and db binding all intact)');

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
  const r5 = await dispatch({ xell_id: wrk.id, project: PID, task: 'be a manager', title: 'plain worker',
                              zee_type: 'manager', harness: 'manager' });
  ok(!r5.threw || SPAWN_STAGE.test(r5.error), `no refusal before the spawn [${r5.threw ? r5.error.slice(0, 110) : 'no throw'}]`);
  const w2 = await readXell(wrk.id);
  ok(w2.zee_type === 'manager' && w2.harness_key === 'manager' && w2.db_coupling === 'db-prod-readonly',
     'the worker xell became a manager, wearing the manager harness, on production read-only');

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  await cleanup({ files: true });
  await client.end().catch(() => {});
}
process.exit(fail ? 1 : 0);

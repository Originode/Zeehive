// POST /api/xells/:id/swap — a HUMAN in the console replaces the zee working a xell, keeping the xell.
//
// The console half of `zee swap` (covered by its sibling manager-swap.test.mjs). It exists so a human
// can do from the honeycomb what a manager can do from a CLI: hand ONE piece of work — same branch,
// same commits, same containers, same database, same work-item card — to a different persona, instead
// of throwing the xell away and briefing somebody to find the work again.
//
// WHAT THIS FILE IS REALLY GUARDING: that there is only ONE swap.
//   dispatchXell → spawnCxell → ensureCxell runs `docker rm -f <cage>`, and cloneIntoCxell re-clones
//   /work/repo from the HOST WORKTREE. A caged zee's commits live INSIDE its container until
//   something collects them (only land/build/sync do), so a zee that committed and never landed has
//   work that exists in exactly one place — and the recreate destroys it. Nothing on the dispatch
//   path collects. The manager verb therefore COLLECTS FIRST and refuses the whole swap when the
//   collect fails on a running cage; a human route that reimplemented the swap would be a second path
//   to `docker rm -f` with no collect in front of it. So both callers run the same function
//   (self.js swapZeeInXell), and the assertions below are written against the HUMAN entry point:
//
//   1. the ORDERING, read from a real docker call log — the cage's commits land on the host worktree
//      BEFORE anything removes a cage, and the commit that existed only inside the cage survives;
//   2. a collect that FAILS on a running cage refuses the human swap too, and recreates nothing;
//   3. the refusals MATCH the manager verb's — an open human gate (land/ship/done), a persona of the
//      wrong zee_type, another project's persona, an unknown harness, no harness, a RETIRED xell, and
//      a MANAGER xell (re-dispatching one re-mints its production read-only role);
//   4. the ONE way it is deliberately WIDER: a xell with NO manager, which `zee swap` can never
//      reach, is swappable by a human — a human already dispatches into any xell in the project;
//   5. what SURVIVES: branch, slug, worktree, db coupling, manager_xell_id, zee_type, the work-item
//      card, and the outgoing zee row retired honestly rather than deleted;
//   6. the HANDOVER says a HUMAN swapped it in (not "your manager"), and still carries the manager
//      block when the xell reports to one;
//   7. the manager of a swapped worker is TOLD (lib/managers.js notifyManagerOfSwap), so it never
//      finds a persona it did not ask for. Asserted on the message ROW and its text;
//   8. THE HALF-SWAPPED STATE — the dispatch fails AFTER the outgoing zee is retired (the spawn is
//      the flakiest step there is). The manager is told in swap-specific wording, the xell stops
//      reading as a working crew member in `zee zees` and on the honeycomb, it is forced back OUT of
//      the pool (spawnCxell's own failure path releases it INTO the pool, where the next dispatch
//      could clone a stranger onto this branch), and the human's answer is unchanged;
//   9. ONE FULL SWAP, END TO END, with a STUBBED RUNTIME — the new zee actually comes up, the
//      work-item re-link happens and the manager notification fires. Everything after the spawn had
//      never been observed running: every other assertion in this suite reads the ordering out of a
//      docker call log and stops at the spawn, because a cxell has no docker.
//
// Docker is faked on PATH (the collect is `docker exec`/`docker cp`) and every invocation is
// RECORDED, and PROVISION_MODE/PRODRO_MODE are simulate. For §1–§8 the throwaway project has no
// provider account — so every dispatch dies AT THE SPAWN, which is the marker this suite's siblings
// use for "everything before the spawn succeeded". §9 then connects a stub account and teaches the
// SAME fake docker to answer the agent exec with the claude stream-json events intake.js waits for
// (`system/init` then `result`), which is what makes a whole swap completable in a cage. Nothing
// here goes near a real cage, cluster or fleet row.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.PRODRO_MODE = 'simulate';
process.env.SHIP_MODE = 'simulate';
process.env.PROVISION_MODE = 'simulate';
process.env.TKB_NOTIFY = '0';

// ── fake docker on PATH, which also RECORDS every call (the ordering evidence) ───────────────────
const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const bin = mkdtempSync(join(tmpdir(), `humswap-bin-${tag}-`));
const stateFile = join(bin, 'state.json');
const callLog = join(bin, 'calls.log');
const setState = (s) => writeFileSync(stateFile, JSON.stringify(s));
const calls = () => (existsSync(callLog) ? readFileSync(callLog, 'utf8').split('\n').filter(Boolean) : []);
const shim = join(bin, 'fake-docker.mjs');
writeFileSync(shim, `#!/usr/bin/env node
import { readFileSync, appendFileSync, copyFileSync } from 'node:fs';
const a = process.argv.slice(2);
appendFileSync(process.env.FAKE_DOCKER_LOG, a.join(' ') + '\\n');
const st = JSON.parse(readFileSync(process.env.FAKE_DOCKER_STATE, 'utf8'));
const i = a.indexOf('inspect');
if (i >= 0) {                                   // cxellRunning(): is the cage up?
  const n = a[a.length - 1];
  if (!(n in (st.running || {}))) { process.stderr.write('No such object: ' + n + '\\n'); process.exit(1); }
  process.stdout.write((st.running[n] ? 'true' : 'false') + '\\n'); process.exit(0);
}
if (a[0] === 'exec') {                          // exportCxellDiff(): probe + bundle create
  const script = a[a.length - 1];
  // THE STUBBED RUNTIME (§9). This is the vendor CLI being run inside the cage (lib/cxell.js
  // runZee → adapterFor('claude-code-cxell').execCmd), and it is the ONE docker call whose OUTPUT
  // decides whether a spawn succeeds: intake.js awaits a system/init event before it will claim a
  // zee started, and takes the result event as end-of-turn. Answer both and the whole
  // post-dispatch third of a swap becomes observable in a cxell that has no docker at all.
  if (/--output-format stream-json/.test(script)) {
    if (st.spawnFail) { process.stderr.write('stub runtime: ' + st.spawnFail + '\\n'); process.exit(1); }
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: st.session || 'stub-session' }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'stub zee: inherited the xell',
      total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
    process.exit(0);
  }
  if (st.execFail) { process.stderr.write('Error: No such container: ' + a[1] + '\\n'); process.exit(1); }
  if (/rev-list/.test(script)) { process.stdout.write(String(st.commits ?? 1) + '\\n'); process.exit(0); }
  process.exit(0);
}
if (a[0] === 'cp') {                            // exportCxellDiff(): pull the bundle out of the cage
  if (String(a[1]).endsWith(':/tmp/out.bundle')) { copyFileSync(st.bundle, a[2]); process.exit(0); }
  process.exit(0);
}
process.exit(0);
`);
writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash\nexec node "${shim}" "$@"\n`);
chmodSync(join(bin, 'docker'), 0o755);
process.env.FAKE_DOCKER_STATE = stateFile;
process.env.FAKE_DOCKER_LOG = callLog;
process.env.PATH = `${bin}:${process.env.PATH}`;
// The cage build authorizes the fleet SSH key inside the container, minting the keypair on first
// use. Point it at this run's throwaway dir so the suite neither reads nor writes the real one.
process.env.ZEEHIVE_SSH_DIR = join(bin, 'ssh');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

const client = new pg.Client({ connectionString: url });
const tmp = mkdtempSync(join(tmpdir(), 'humswap-'));
const PID = '00000000-0000-4000-8000-0000000e4411';
const PID2 = '00000000-0000-4000-8000-0000000e4412';
const XOURCE = '00000000-0000-4000-8000-0000000e4422';

async function cleanup({ files = false } = {}) {
  for (const p of [PID, PID2]) {
    try { await client.query(`DELETE FROM project WHERE id=$1`, [p]); } catch { /* */ }
  }
  if (files) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
               try { rmSync(bin, { recursive: true, force: true }); } catch { /* */ } }
}

try {
  await client.connect();
  await cleanup();

  // ── a real repo, real worktrees, and a real "cage bundle" ─────────────────
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# human swap test\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');

  const mkWt = (name) => {
    const wt = join(tmp, name);
    git(repo, 'worktree', 'add', '-q', '-b', `spinoff/${name}`, wt, 'master');
    return wt;
  };
  const wtA = mkWt('crew-work-aa11bb');    // a MANAGED worker — the manager must be told
  const wtB = mkWt('solo-work-bb22cc');    // NOBODY's crew — `zee swap` can never reach this one
  const wtM = mkWt('lead-one-cc33dd');     // a manager xell (a swap must refuse it)
  const wtR = mkWt('gone-work-dd44ee');    // a retired xell

  // THE COMMITS THAT ONLY EXIST INSIDE THE CAGE. A second clone stands in for the cxell's
  // /work/repo: it commits, and `git bundle create … --not --remotes` is exactly what
  // exportCxellDiff pulls out of a real cage. The host worktree has never seen this commit.
  const cage = join(tmp, 'cage');
  execFileSync('git', ['clone', '-q', repo, cage]);
  git(cage, 'config', 'user.email', 'z@z'); git(cage, 'config', 'user.name', 'zee');
  git(cage, 'checkout', '-q', 'spinoff/crew-work-aa11bb');
  writeFileSync(join(cage, 'BUILDER-NOTES.md'), '# what the builder wrote\n');
  git(cage, 'add', '-A'); git(cage, 'commit', '-qm', 'builder: the commit a human swap must not destroy');
  const cageHead = git(cage, 'rev-parse', 'HEAD');
  const bundle = join(tmp, 'cage.bundle');
  git(cage, 'bundle', 'create', bundle, 'spinoff/crew-work-aa11bb', '--not', '--remotes');
  setState({ running: { 'cxell_crew-work-aa11bb': true }, bundle, commits: 1 });

  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,'human-swap-test',$2,'master','humswap','postgres')`, [PID, repo]);
  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,'human-swap-other',$2,'master','humswap2','postgres')`, [PID2, repo]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [XOURCE, PID]);

  const H = Object.fromEntries((await client.query(
    `SELECT key, id FROM harness WHERE key = ANY($1::text[])`,
    [['dev-scout', 'dev-builder', 'dev-reviewer', 'manager']])).rows.map((r) => [r.key, r.id]));
  ok(!!H['dev-scout'] && !!H['dev-builder'] && !!H.manager,
     'fixtures: the dev crew personas and the manager harness exist (run db:migrate if not)');
  const foreign = (await client.query(
    `INSERT INTO harness (key, label, zee_type, project_id, enabled, bundle)
       VALUES ($1,'Other Project Builder','worker',$2,true,'{}'::jsonb) RETURNING *`,
    [`humswap-foreign-${tag}`, PID2])).rows[0];

  const mkXell = async (slug, wt, { type = 'worker', harness = null, manager = null,
                                    status = 'working' } = {}) =>
    (await client.query(
      `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                         zee_type, harness_id, manager_xell_id, db_coupling)
         VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8,$9,'db-isolated') RETURNING *`,
      [PID, XOURCE, slug, `spinoff/${slug}`, wt, status, type, harness, manager])).rows[0];

  const manager = await mkXell('lead-one-cc33dd', wtM, { type: 'manager', harness: H.manager });
  const worker = await mkXell('crew-work-aa11bb', wtA, { harness: H['dev-scout'], manager: manager.id });
  const solo = await mkXell('solo-work-bb22cc', wtB, { harness: H['dev-scout'] });
  const retired = await mkXell('gone-work-dd44ee', wtR, { harness: H['dev-scout'], status: 'retired' });

  // the zee currently in the managed xell, its task, its last report, and its card
  const outgoing = (await client.query(
    `INSERT INTO zee (xell_id, attach_mode, viewer_kind, status, kind, entrypoint, cwd, title, model)
       VALUES ($1,'headless-spawn','none','working','headless','cxell-cli','/work/repo','xell : the auth bug','sonnet')
     RETURNING *`, [worker.id])).rows[0];
  await client.query(
    `INSERT INTO task (project_id, prompt_text, source, status, xell_id, zee_id, assigned_at)
       VALUES ($1,'SCOUT the auth bug: find where the session cookie is dropped. Do not fix it.','dispatch','assigned',$2,$3,now())`,
    [PID, worker.id, outgoing.id]);
  await client.query(
    `INSERT INTO zee_message (project_id, from_xell_id, from_slug, to_xell_id, to_slug, kind, body)
       VALUES ($1,$2,'crew-work-aa11bb',$3,'lead-one-cc33dd','report','The cookie is dropped in refreshSession()')`,
    [PID, worker.id, manager.id]);
  const item = (await client.query(
    `INSERT INTO work_item (project_id, kind, title, status, xell_id) VALUES ($1,'task','Fix the auth bug','working',$2) RETURNING *`,
    [PID, worker.id])).rows[0];

  const { swapXellZeeAsHuman, swapZeeInXell, swapBrief } = await import('../server/src/queenzee/self.js');
  const readXell = async (id) => (await client.query(
    `SELECT x.*, h.key AS harness_key FROM xell x LEFT JOIN harness h ON h.id=x.harness_id WHERE x.id=$1`, [id])).rows[0];
  const readZee = async (id) => (await client.query(`SELECT * FROM zee WHERE id=$1`, [id])).rows[0];
  // Every dispatch in this throwaway project must die at the SPAWN (no provider account is
  // connected) — that failure is the marker for "everything before the spawn succeeded".
  const SPAWN_STAGE = /has no claude token|no ready xell|failed to launch|runtime .* is not in agent_runtime|could not start the new zee/i;

  // ── 1. REFUSALS — the human route says NO to everything the manager verb says no to ───────
  console.log('\nrefusals (each one a sentence, and none of them touches anything)');
  const before = await readXell(worker.id);

  const noXell = await swapXellZeeAsHuman({ xellId: '00000000-0000-4000-8000-00000000dead', harness: 'dev-builder' });
  ok(noXell.ok === false && noXell.status === 'not_found', 'an unknown xell id is not_found (a 404, not a swap)');
  const noHarness = await swapXellZeeAsHuman({ xellId: worker.id });
  ok(noHarness.ok === false && /harness/i.test(noHarness.error),
     'a swap with no harness is refused — the persona IS the swap');
  const unknown = await swapXellZeeAsHuman({ xellId: worker.id, harness: `no-such-harness-${tag}` });
  ok(unknown.ok === false && unknown.status === 'refused' && /no harness/i.test(unknown.error),
     'an unknown harness is refused by name');
  const otherProject = await swapXellZeeAsHuman({ xellId: worker.id, harness: foreign.key });
  ok(otherProject.ok === false && otherProject.status === 'refused' && /belongs to project/i.test(otherProject.error),
     "another project's persona is refused, naming the project that owns it");
  const wrongType = await swapXellZeeAsHuman({ xellId: worker.id, harness: 'manager' });
  ok(wrongType.ok === false && wrongType.status === 'refused'
     && /MANAGER harness/.test(wrongType.error) && /WORKER xell/.test(wrongType.error),
     `a MANAGER persona on a WORKER xell is refused by TYPE [${(wrongType.error || '').slice(0, 90)}]`);
  const aManagerXell = await swapXellZeeAsHuman({ xellId: manager.id, harness: 'manager' });
  ok(aManagerXell.ok === false && aManagerXell.status === 'refused' && /MANAGER xell/.test(aManagerXell.error),
     'a MANAGER xell is refused — a swap does not re-crew one');
  ok(/read-only|CREATE\/ALTER ROLE/i.test(aManagerXell.error || ''),
     'and it says WHY: re-dispatching a manager re-mints its production read-only role');
  const isRetired = await swapXellZeeAsHuman({ xellId: retired.id, harness: 'dev-builder' });
  ok(isRetired.ok === false && isRetired.status === 'refused' && /RETIRED/.test(isRetired.error),
     'a RETIRED xell is refused — there is no zee to replace and nothing to inherit');

  ok(calls().length === 0, 'and NOT ONE docker call was made by any refusal above — nothing was touched');
  ok((await readXell(worker.id)).harness_key === 'dev-scout'
     && (await readZee(outgoing.id)).status === 'working',
     'the xell still wears its old persona and its zee is still working');

  // ── 2. an open HUMAN GATE refuses it, exactly as it refuses the manager verb ───────────────
  console.log('\nan open human gate on that xell refuses the human swap too');
  const lr = (await client.query(
    `INSERT INTO land_request (project_id, xell_id, ref, new_sha, status) VALUES ($1,$2,'master','deadbeef01','pending') RETURNING *`,
    [PID, worker.id])).rows[0];
  const gated = await swapXellZeeAsHuman({ xellId: worker.id, harness: 'dev-builder' });
  ok(gated.ok === false && gated.status === 'refused' && /landing is open/i.test(gated.error),
     `a pending landing refuses it, and says which gate [${(gated.error || '').slice(0, 80)}]`);
  ok(calls().length === 0, 'still no docker call — the gate check runs BEFORE the collect');
  await client.query(`UPDATE land_request SET dismissed_at=now() WHERE id=$1`, [lr.id]);
  const sr = (await client.query(
    `INSERT INTO ship_request (project_id, xell_id, status) VALUES ($1,$2,'pending') RETURNING *`, [PID, worker.id])).rows[0];
  ok((await swapXellZeeAsHuman({ xellId: worker.id, harness: 'dev-builder' })).error?.match(/ship is open/i) !== null,
     'a pending ship refuses it');
  await client.query(`UPDATE ship_request SET dismissed_at=now() WHERE id=$1`, [sr.id]);
  const ds = (await client.query(
    `INSERT INTO done_suggestion (project_id, manager_xell_id, manager_slug, target_xell_id, target_slug, reason)
       VALUES ($1,$2,'lead-one-cc33dd',$3,'crew-work-aa11bb','looks finished') RETURNING *`,
    [PID, manager.id, worker.id])).rows[0];
  ok(/done/i.test((await swapXellZeeAsHuman({ xellId: worker.id, harness: 'dev-builder' })).error || ''),
     'an open done suggestion refuses it');
  await client.query(`UPDATE done_suggestion SET dismissed_at=now() WHERE id=$1`, [ds.id]);

  // ── 3. THE COLLECT FAILS ON A RUNNING CAGE → the human swap is refused OUTRIGHT ────────────
  // The property that makes the shared core worth sharing: a route with its own copy of the swap
  // would be a second path to `docker rm -f` with no collect in front of it.
  console.log('\na collect that FAILS on a running cage refuses the human swap and recreates nothing');
  setState({ running: { 'cxell_crew-work-aa11bb': true }, bundle, commits: 1, execFail: true });
  const broke = await swapXellZeeAsHuman({ xellId: worker.id, harness: 'dev-builder' });
  ok(broke.ok === false && broke.status === 'refused' && broke.stage === 'collect',
     `refused at the COLLECT stage [${(broke.error || '').slice(0, 100)}]`);
  ok(!calls().some((c) => /^rm -f/.test(c)),
     'NO `docker rm -f` was issued — the cage, and the commits inside it, are untouched');
  ok((await readXell(worker.id)).harness_key === 'dev-scout', 'the harness was NOT re-assigned');
  ok((await readZee(outgoing.id)).status === 'working', 'and the outgoing zee was NOT retired');
  ok(git(wtA, 'log', '--oneline').split('\n').length === 1, 'the host worktree is exactly where it was');

  // ── 4. THE SWAP ITSELF — collect first, then re-dispatch into the SAME xell ────────────────
  console.log('\nthe human swap: the cage\'s commits are collected BEFORE anything re-dispatches');
  setState({ running: { 'cxell_crew-work-aa11bb': true }, bundle, commits: 1 });
  writeFileSync(callLog, '');
  const swap = await swapXellZeeAsHuman({ xellId: worker.id, harness: 'dev-builder',
                                          task: 'BUILD the fix the scout scoped.', by: 'mark@console' });
  ok(swap.ok === false && SPAWN_STAGE.test(swap.error || ''),
     `only the spawn itself failed (no provider token in a throwaway project) [${(swap.error || '').slice(0, 110)}]`);
  ok(swap.stage === 'dispatch' && swap.collected?.collected === true,
     'and the answer says the COLLECT succeeded before the dispatch was attempted');

  // THE COMMITS SURVIVED — the assertion the whole feature exists for.
  ok(git(wtA, 'rev-parse', 'HEAD') === cageHead,
     'the host worktree is now AT the cage\'s HEAD — the commit that existed only inside the cage is safe');
  ok(git(wtA, 'log', '--oneline').includes('builder: the commit a human swap must not destroy'),
     'and the outgoing zee\'s commit is on the branch by name');

  // THE ORDERING, read from the actual docker call log rather than from a comment.
  const log = calls();
  const cpAt = log.findIndex((c) => /^cp cxell_crew-work-aa11bb:\/tmp\/out\.bundle/.test(c));
  const rmAt = log.findIndex((c) => /^rm -f/.test(c));
  ok(cpAt >= 0, 'the collect really ran (docker cp of the cage bundle is in the call log)');
  ok(rmAt === -1 || rmAt > cpAt,
     `no cage was removed before the collect (cp@${cpAt}, rm@${rmAt === -1 ? 'never' : rmAt})`);
  ok(log.slice(0, cpAt).every((c) => /^(inspect|exec)/.test(c)),
     'and everything the swap did before that collect was read-only (inspect/exec only)');

  // ── 4b. THE HALF-SWAPPED STATE — that dispatch failed AFTER the outgoing zee was retired ───
  // The swap above is not just "a swap that did not happen": it got past the retire. The previous
  // zee is stopped, the xell already wears the incoming persona, and nothing is running in it. Every
  // assertion here is about a xell in exactly that state, because it is the state a transient spawn
  // failure actually leaves behind — and until this existed, the only person who knew was whoever
  // clicked. (Nothing is re-run: these read the xell the swap above left.)
  console.log('\nthe dispatch failed after the retire — and the half-swapped xell says so');
  const { tendState } = await import('../server/src/lib/status.js');
  const { crewFor } = await import('../server/src/lib/managers.js');

  ok((await readZee(outgoing.id)).status === 'stopped',
     'the outgoing zee is already retired — this really is the half-swapped state, not a refusal');
  const halfXell = await readXell(worker.id);
  ok(halfXell.harness_key === 'dev-builder' && halfXell.status === 'idle',
     `the xell wears the new persona with NO zee in it, and reads 'idle' rather than 'working' [${halfXell.status}]`);
  ok(halfXell.is_pooled === false,
     'and it is OUT of the pool — spawnCxell\'s own failure path releases a xell back INTO it, which '
     + 'would offer this branch, its commits and its card to the next dispatch that asked for a xell');

  const tend = await tendState(worker.id);
  ok(tend.open === true, 'a TEND is open on it — the existing, honest way this system says "a human is needed"');
  ok(/SWAP HALF-DONE/.test(tend.reason || '') && /NO zee in this xell/.test(tend.full || tend.reason || ''),
     `whose reason leads with what happened [${(tend.reason || '').slice(0, 80)}]`);
  ok(/dev-builder/.test(tend.full || tend.reason || '') && /spinoff\/crew-work-aa11bb/.test(tend.full || tend.reason || ''),
     'and names the persona it was left wearing and the branch the commits are on');
  ok(swap.half_swapped?.ok === true && swap.half_swapped.tend_raised === true
     && swap.half_swapped.xell_status === 'idle' && swap.half_swapped.is_pooled === false,
     'the answer carries what was done about it (half_swapped), so the route and the console need not guess');

  // …and that it READS honestly through the two surfaces that matter: `zee zees` (a manager has no
  // console) and the honeycomb. Both project hiveStatus(), which without a signal reads a 'working'
  // row as `working` — a busy-looking hexagon over an empty cage.
  const crewNow = (await crewFor(manager.id)).find((c) => c.slug === 'crew-work-aa11bb');
  ok(crewNow?.hive_status === 'occ-tendRequest' && crewNow.hive_status_label === 'tend?',
     `\`zee zees\` shows it as tend?, not working [${crewNow?.hive_status}]`);
  ok(crewNow?.working === false, 'and not as a working crew member — there is no zee to be working');
  ok((crewNow?.waiting_on_human || []).some((w) => /TEND/.test(w) && /SWAP HALF-DONE/.test(w)),
     'its waiting-on-human line says a human is needed, and what for');
  const { hiveStatus } = await import('../server/src/lib/hive-status.js');
  ok(hiveStatus({ ...halfXell, is_production: false }, { tendPending: true }) === 'occ-tendRequest',
     'the honeycomb derives the same key from the same row (one status vocabulary, two surfaces)');

  // THE MANAGER IS TOLD — on the path where it matters most. It is not the clicking human; all it
  // would otherwise see is one of its crew going permanently quiet.
  ok(swap.manager_notified?.ok === true, 'the manager of the half-swapped worker was notified');
  const told = (await client.query(
    `SELECT body FROM zee_message WHERE to_xell_id=$1 ORDER BY created_at DESC LIMIT 1`, [manager.id])).rows[0];
  ok(/tried to swap the zee in your worker crew-work-aa11bb and THE NEW ZEE DID NOT START/.test(told?.body || ''),
     'in wording written for a swap that HALF-happened — not the success sentence');
  ok(/NO zee in that xell now/.test(told.body) && /do not wait for it to report/.test(told.body),
     'it says plainly what state the xell is in: nobody is in it, and nothing will report from it');
  ok(/commits were collected onto the host worktree first \(HEAD [0-9a-f]{8}\)/.test(told.body),
     'and what happened to the COMMITS — the one fact a manager cannot see for itself');
  ok(/`tend\?`/.test(told.body) && /zee swap --to crew-work-aa11bb --harness dev-builder/.test(told.body),
     'plus who has been asked to look, and the exact retry');

  // THE HUMAN'S ANSWER IS UNCHANGED — the notification and the state repair ride alongside it.
  ok(/^the swap could not start the new zee in crew-work-aa11bb:/.test(swap.error || ''),
     'the clicking human still gets the same sentence they always did');
  ok(/Fix the reason and swap again\.$/.test(swap.error || ''), 'ending in what to do about it');

  // ── 5. WHAT SURVIVES: the xell is the same xell, and it is still that manager's ────────────
  console.log('\nthe xell is the SAME xell — only the zee changed');
  const now = await readXell(worker.id);
  ok(now.harness_key === 'dev-builder', `it wears the INCOMING persona (${now.harness_key})`);
  ok(now.slug === worker.slug && now.branch === worker.branch && now.worktree_path === worker.worktree_path,
     'same slug, same branch, same worktree — a swap never renames (dispatchXell rename:false)');
  ok(now.db_coupling === before.db_coupling, `db coupling survives (${now.db_coupling})`);
  ok(now.manager_xell_id === manager.id,
     'it STILL reports to the same manager — a human swap does not adopt the xell');
  ok(now.zee_type === 'worker', 'and it is still a worker xell (a swap never changes the type)');
  ok((await client.query(`SELECT * FROM work_item WHERE id=$1`, [item.id])).rows[0].xell_id === worker.id,
     'the work-item card is still on this xell — the board did not lose it');
  const gone = await readZee(outgoing.id);
  ok(!!gone && gone.status === 'stopped',
     'the outgoing zee ROW still exists and is stopped (it is the record of what that agent did)');
  ok(/swapped out by/.test(gone.last_stop_reason || '') && /mark@console/.test(gone.last_stop_reason || '')
     && /dev-builder/.test(gone.last_stop_reason || ''),
     `with a stop reason naming the HUMAN who did it and the incoming persona [${gone.last_stop_reason}]`);

  // ── 6. A xell with NO MANAGER — the one way the human route is deliberately WIDER ──────────
  console.log('\nnobody\'s crew: a xell `zee swap` can never reach is swappable by a human');
  setState({ running: {}, bundle, commits: 1 });      // its cage is not running: nothing to collect
  const soloSwap = await swapXellZeeAsHuman({ xellId: solo.id, harness: 'dev-builder' });
  ok(soloSwap.ok === false && SPAWN_STAGE.test(soloSwap.error || '') && soloSwap.stage === 'dispatch',
     'it is NOT refused for having no manager — it reaches the dispatch like any other');
  ok(soloSwap.collected?.collected === false && /not running/i.test(soloSwap.collected?.reason || ''),
     'and it says plainly that nothing was collected (the cage was not running) rather than implying a rescue');
  ok((await readXell(solo.id)).harness_key === 'dev-builder', 'the persona was re-assigned on it');
  ok((await readXell(solo.id)).manager_xell_id === null, 'and it still has no manager');

  // ── 7. THE HANDOVER — it says a HUMAN swapped you in, and still names the manager ──────────
  console.log('\nthe handover brief is honest about WHO swapped the zee in');
  const human = await swapBrief({ manager: null, target: await readXell(worker.id),
                                  harness: { key: 'dev-reviewer', label: 'Reviewer' },
                                  task: 'REVIEW what the builder wrote.', by: 'mark@console' });
  ok(human.brief.startsWith('REVIEW what the builder wrote.'), "the human's own task text leads the brief");
  ok(/YOU ARE INHERITING THIS XELL/.test(human.brief), 'it says, in the heading, that the xell is INHERITED');
  ok(/A HUMAN in the ZEEHIVE console swapped the previous zee out/.test(human.brief),
     'and that a HUMAN put it there — not "your manager", which nobody said');
  ok(human.brief.includes('SCOUT the auth bug'), 'it carries what the PREVIOUS zee was asked to do');
  ok(human.brief.includes('builder: the commit a human swap must not destroy'),
     'and a git summary of what is actually ON the branch (the collected commit, by subject)');
  ok(human.brief.includes('lead-one-cc33dd') && /`zee report --message/.test(human.brief),
     'the manager block still rides along — the xell HAS a manager, and the incoming zee must know');
  ok(/a HUMAN \(mark@console\) swapped you into it, not your manager/.test(human.brief),
     'stating exactly that relationship: it is watching you, but it did not ask for you');
  ok(human.manager?.id === manager.id, 'and the brief builder resolved that manager from the xell itself');

  const soloBrief = await swapBrief({ manager: null, target: await readXell(solo.id),
                                      harness: { key: 'dev-builder', label: 'Builder' } });
  ok(!/## Your manager/.test(soloBrief.brief) && soloBrief.manager === null,
     'a xell with no manager gets NO manager block — there is nobody to report to');
  ok(/Continue the work on `solo-work-bb22cc`/.test(soloBrief.brief),
     'and with no task text it is told to continue this xell\'s work in its harness\'s role');

  // ── 8. THE MANAGER IS TOLD ────────────────────────────────────────────────────────────────
  // A manager plans around who is in each xell. A human re-crewing one of its workers must not be
  // invisible to it, or it briefs a persona that left. (Asserted on the notification itself: the
  // swap's own call to it sits after the dispatch, which cannot complete in a project with no
  // provider account — so the message is proven here, and the CALL is proven structurally below.)
  console.log('\nthe manager of a swapped worker is told, in its own inbox');
  const { notifyManagerOfSwap, inboxFor } = await import('../server/src/lib/managers.js');
  const note = await notifyManagerOfSwap({
    manager, target: await readXell(worker.id), harness: { key: 'dev-reviewer', label: 'Reviewer' },
    previous: { harness_key: 'dev-builder' }, by: 'mark@console' });
  ok(note.ok === true && note.message?.to_xell_id === manager.id && note.message.kind === 'report',
     'it lands as a REPORT addressed to the manager (durable row, delivered live when it has a session)');
  const body = note.message.body;
  ok(/A HUMAN swapped the zee in your worker crew-work-aa11bb/.test(body),
     'the text says a HUMAN did it, and names the worker');
  ok(/dev-reviewer/.test(body) && /replacing dev-builder/.test(body),
     'naming the incoming persona and the one it replaced');
  ok(/same branch \(spinoff\/crew-work-aa11bb\)/.test(body) && /still reports to you/.test(body),
     'and that nothing else about the xell changed, including who it reports to');
  ok(/zee say --to crew-work-aa11bb/.test(body), 'and how to re-brief it if the plan has changed');
  const inbox = await inboxFor(manager.id);
  ok(inbox.some((m) => /A HUMAN swapped the zee/.test(m.body)),
     'and `zee inbox` on the manager returns it');

  // ── 9. ONE SWAP, TWO CALLERS — read from the SOURCE, not from this run ─────────────────────
  // The safety contract is an ORDERING, and an ordering can only be forked by a second copy of the
  // code. So: the core exists, both entry points call it, and neither of them collects or dispatches
  // on its own.
  console.log('\nboth callers run ONE swap (structural — a second copy is the bug this prevents)');
  const src = readFileSync(new URL('../server/src/queenzee/self.js', import.meta.url), 'utf8');
  const fnBody = (name) => {
    const start = src.indexOf(`export async function ${name}(`);
    if (start < 0) throw new Error(`${name} not found`);
    let i = src.indexOf('{', src.indexOf(')', start));
    for (let depth = 0; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`could not bracket-match ${name}`);
  };
  const core = fnBody('swapZeeInXell');
  const mgrVerb = fnBody('selfSwap');
  const humanVerb = fnBody('swapXellZeeAsHuman');
  ok(core.indexOf('collectCxellDiffToWorktree(') < core.indexOf('dispatchXell('),
     'in the CORE, the collect is written BEFORE the dispatch — the ordering is structural, not incidental');
  ok(/rename: false/.test(core), 'and it dispatches with rename:false so the branch cannot move');
  ok(/swapZeeInXell\(/.test(mgrVerb) && !/collectCxellDiffToWorktree\(|dispatchXell\(/.test(mgrVerb),
     '`zee swap` delegates to the core and neither collects nor dispatches itself');
  ok(/swapZeeInXell\(/.test(humanVerb) && !/collectCxellDiffToWorktree\(|dispatchXell\(/.test(humanVerb),
     'the HUMAN route delegates to the same core and neither collects nor dispatches itself');
  ok(/openHumanGatesOn\(/.test(core) && !/openHumanGatesOn\(/.test(mgrVerb) && !/openHumanGatesOn\(/.test(humanVerb),
     'and the open-gate refusal lives in the core too — one copy, so it cannot drift between callers');
  // The notification's CALL SITE. The message itself is asserted above (§8); this is the part a
  // project with no provider account cannot reach at runtime, because the dispatch dies first — so it
  // is read from the source instead of left unclaimed: only a HUMAN swap notifies, it is the shared
  // helper rather than a second wording, and it is best-effort (a notification row must never turn a
  // completed swap into a reported failure).
  ok(/notifyManagerOfSwap\(/.test(core), 'the core notifies through lib/managers.js, not its own wording');
  ok(/if \(!manager && watcher\)/.test(core),
     'and only when a HUMAN asked and the xell HAS a manager — a manager is not told about its own swap');
  ok(/notifyManagerOfSwap\([\s\S]{0,220}\.catch\(/.test(core),
     'best-effort: a swap that WORKED is not reported as failed because a message row could not be written');
  ok(core.indexOf('notifyManagerOfSwap(') > core.indexOf('dispatchXell('),
     'and it is told AFTER the new zee is in — never about a swap that did not happen');

  const routes = readFileSync(new URL('../server/src/api/routes.js', import.meta.url), 'utf8');
  ok(/router\.post\('\/xells\/:id\/swap'/.test(routes),
     'the console route POST /api/xells/:id/swap exists');
  const route = routes.slice(routes.indexOf("router.post('/xells/:id/swap'"), routes.indexOf("router.post('/xells/:id/suggest-done'"));
  ok(/swapXellZeeAsHuman\(/.test(route) && !/collectCxellDiffToWorktree|dispatchXell|docker/.test(route),
     'and the ROUTE only calls it — no second copy of the collect/recreate ordering in an express handler');
  ok(/409/.test(route) && /404/.test(route) && /502/.test(route),
     "a refusal answers 409, an unknown xell 404, and a swap the queenzee could not finish 502 — each "
     + "carrying the server's own sentence");

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  await cleanup({ files: true });
  await client.end().catch(() => {});
}
process.exit(fail ? 1 : 0);

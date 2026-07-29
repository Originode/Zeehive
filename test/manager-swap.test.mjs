// `zee swap` — a MANAGER replaces the zee working one of ITS OWN crew xells, keeping the xell.
//
// The verb exists so one piece of work can be played by a Scout, then a Builder, then a Reviewer:
// same branch, same commits, same containers, same database, same work-item card. `zee dispatch` can
// only ever open a NEW xell, so before this the only way to change the persona on a job was to throw
// the job away.
//
// THE HAZARD IT IS BUILT AROUND, and what this file is really guarding:
//   dispatchXell → spawnCxell → ensureCxell runs `docker rm -f <cage>`, and cloneIntoCxell re-clones
//   /work/repo from the HOST WORKTREE. A caged zee's commits live INSIDE its container until something
//   collects them (only the land/build/sync paths do) — so a zee that committed and never landed has
//   work that exists in exactly one place, and the recreate destroys it. Nothing on the dispatch path
//   collects. selfSwap therefore COLLECTS FIRST and REFUSES THE WHOLE SWAP when the collect fails on a
//   running cage: losing a worker's commits is the one outcome nobody can undo.
//
// What is covered here:
//   1. the COLLECT-BEFORE-RECREATE ordering — a real bundle of "commits made inside the cage" is
//      collected onto the host worktree, and it happens before anything on the dispatch path runs
//      (docker is faked on PATH and every invocation is RECORDED, so the order is read from the
//      actual call log, not from a comment);
//   2. a collect that FAILS on a running cage refuses the whole swap and changes NOTHING — no zee is
//      retired, no harness is re-assigned, and no `docker rm -f` is ever issued;
//   3. refusal while a human gate is open on that xell (a pending land_request);
//   4. refusal of a MANAGER harness, and of a harness belonging to another project;
//   5. refusal of a xell that is not this manager's crew (including another manager's worker, and a
//      manager xell — which is scoped out by the same rule);
//   6. what must SURVIVE a swap: db coupling, work-item link, branch, slug, worktree path and
//      manager_xell_id — plus the outgoing zee row retired honestly (status + last_stop_reason)
//      rather than deleted;
//   7. the incoming zee is briefed as an INHERITOR (the handover text is asserted on the task brief
//      selfSwap hands dispatchXell).
//
// Docker is faked on PATH (the collect is `docker exec`/`docker cp`), PROVISION_MODE/PRODRO_MODE are
// simulate, and the throwaway project has no provider account — so every dispatch dies AT THE SPAWN,
// which is exactly the marker the sibling manager-redispatch.test.mjs uses for "everything before the
// spawn succeeded". Nothing here goes near a real cluster, a real cage or a real fleet row.
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
const bin = mkdtempSync(join(tmpdir(), `mgrswap-bin-${tag}-`));
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
  if (st.execFail) { process.stderr.write('Error: No such container: ' + a[1] + '\\n'); process.exit(1); }
  const script = a[a.length - 1];
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

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

const client = new pg.Client({ connectionString: url });
const tmp = mkdtempSync(join(tmpdir(), 'mgrswap-'));
const PID = '00000000-0000-4000-8000-0000000e3311';
const PID2 = '00000000-0000-4000-8000-0000000e3312';
const XOURCE = '00000000-0000-4000-8000-0000000e3322';

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
  writeFileSync(join(repo, 'README.md'), '# swap test\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');

  const mkWt = (name) => {
    const wt = join(tmp, name);
    git(repo, 'worktree', 'add', '-q', '-b', `spinoff/${name}`, wt, 'master');
    return wt;
  };
  const wtA = mkWt('scout-work-aa11bb');     // the xell that gets swapped
  const wtB = mkWt('other-crew-bb22cc');     // another manager's worker
  const wtM = mkWt('lead-one-cc33dd');       // the manager doing the swapping
  const wtM2 = mkWt('lead-two-dd44ee');      // a second manager (its crew is not ours)

  // THE COMMITS THAT ONLY EXIST INSIDE THE CAGE. A second clone stands in for the cxell's
  // /work/repo: it commits, and `git bundle create … --not --remotes` produces exactly what
  // exportCxellDiff pulls out of a real cage. The host worktree has never seen this commit.
  const cage = join(tmp, 'cage');
  execFileSync('git', ['clone', '-q', repo, cage]);
  git(cage, 'config', 'user.email', 'z@z'); git(cage, 'config', 'user.name', 'zee');
  git(cage, 'checkout', '-q', 'spinoff/scout-work-aa11bb');
  writeFileSync(join(cage, 'SCOUT-NOTES.md'), '# what the scout found\n');
  git(cage, 'add', '-A'); git(cage, 'commit', '-qm', 'scout: the findings that must survive a swap');
  const cageHead = git(cage, 'rev-parse', 'HEAD');
  const bundle = join(tmp, 'cage.bundle');
  git(cage, 'bundle', 'create', bundle, 'spinoff/scout-work-aa11bb', '--not', '--remotes');
  setState({ running: { 'cxell_scout-work-aa11bb': true }, bundle, commits: 1 });

  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,'mgr-swap-test',$2,'master','mgrswap','postgres')`, [PID, repo]);
  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,'mgr-swap-other',$2,'master','mgrswap2','postgres')`, [PID2, repo]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [XOURCE, PID]);

  const H = Object.fromEntries((await client.query(
    `SELECT key, id FROM harness WHERE key = ANY($1::text[])`,
    [['dev-scout', 'dev-builder', 'manager', 'zee-base']])).rows.map((r) => [r.key, r.id]));
  ok(!!H['dev-scout'] && !!H['dev-builder'] && !!H.manager,
     'fixtures: the dev crew personas and the manager harness exist (run db:migrate if not)');
  // A persona scoped to the OTHER project — a manager may not hand out somebody else's.
  const foreign = (await client.query(
    `INSERT INTO harness (key, label, zee_type, project_id, enabled, bundle)
       VALUES ($1,'Other Project Builder','worker',$2,true,'{}'::jsonb) RETURNING *`,
    [`mgrswap-foreign-${tag}`, PID2])).rows[0];

  const mkXell = async (slug, wt, { type = 'worker', harness = null, manager = null, project = PID } = {}) =>
    (await client.query(
      `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                         zee_type, harness_id, manager_xell_id, db_coupling)
         VALUES ($1,$2,$3,$4,$5,'working',false,$6,$7,$8,'db-isolated') RETURNING *`,
      [project, XOURCE, slug, `spinoff/${slug}`, wt, type, harness, manager])).rows[0];

  const manager = await mkXell('lead-one-cc33dd', wtM, { type: 'manager', harness: H.manager });
  const manager2 = await mkXell('lead-two-dd44ee', wtM2, { type: 'manager', harness: H.manager });
  const worker = await mkXell('scout-work-aa11bb', wtA, { harness: H['dev-scout'], manager: manager.id });
  const stranger = await mkXell('other-crew-bb22cc', wtB, { harness: H['dev-scout'], manager: manager2.id });

  // the zee that is currently in the crew xell, and its task — both must be handled honestly
  const outgoing = (await client.query(
    `INSERT INTO zee (xell_id, attach_mode, viewer_kind, status, kind, entrypoint, cwd, title, model)
       VALUES ($1,'headless-spawn','none','working','headless','cxell-cli','/work/repo','xell : scout the auth bug','sonnet')
     RETURNING *`, [worker.id])).rows[0];
  await client.query(
    `INSERT INTO task (project_id, prompt_text, source, status, xell_id, zee_id, assigned_at)
       VALUES ($1,'SCOUT the auth bug: find where the session cookie is dropped. Do not fix it.','dispatch','assigned',$2,$3,now())`,
    [PID, worker.id, outgoing.id]);
  await client.query(
    `INSERT INTO zee_message (project_id, from_xell_id, from_slug, to_xell_id, to_slug, kind, body)
       VALUES ($1,$2,'scout-work-aa11bb',$3,'lead-one-cc33dd','report','The cookie is dropped in refreshSession() — see SCOUT-NOTES.md')`,
    [PID, worker.id, manager.id]);
  // the work-item CARD this xell is on — it must still be on it afterwards
  const item = (await client.query(
    `INSERT INTO work_item (project_id, kind, title, status, xell_id) VALUES ($1,'task','Fix the auth bug','working',$2) RETURNING *`,
    [PID, worker.id])).rows[0];

  const { selfSwap } = await import('../server/src/queenzee/self.js');
  const readXell = async (id) => (await client.query(
    `SELECT x.*, h.key AS harness_key FROM xell x LEFT JOIN harness h ON h.id=x.harness_id WHERE x.id=$1`, [id])).rows[0];
  const readZee = async (id) => (await client.query(`SELECT * FROM zee WHERE id=$1`, [id])).rows[0];
  // Every dispatch in this throwaway project must die at the SPAWN (no provider account is
  // connected) — that failure is the marker for "everything before the spawn succeeded".
  const SPAWN_STAGE = /has no claude token|no ready xell|failed to launch|runtime .* is not in agent_runtime|could not start the new zee/i;

  // ── 1. REFUSALS FIRST, while the xell is still pristine ───────────────────
  console.log('\nrefusals (each one a sentence, and none of them touches anything)');
  const before = await readXell(worker.id);

  const notMine = await selfSwap(manager, { to: stranger.slug, harness: 'dev-builder' });
  ok(notMine.ok === false && notMine.status === 'refused' && /not in your crew|no worker/i.test(notMine.error),
     `another manager's worker is refused [${(notMine.error || '').slice(0, 80)}]`);
  const aManager = await selfSwap(manager, { to: manager2.slug, harness: 'dev-builder' });
  ok(aManager.ok === false && aManager.status === 'refused',
     'a MANAGER xell is refused (it is nobody\'s crew — the DB itself forbids a managed manager)');
  const asWorker = await selfSwap(worker, { to: worker.slug, harness: 'dev-builder' });
  ok(asWorker.ok === false && /MANAGER verb/i.test(asWorker.error || ''),
     'a WORKER calling swap is refused — it is a manager verb');
  const noHarness = await selfSwap(manager, { to: worker.slug });
  ok(noHarness.ok === false && /--harness/.test(noHarness.error || ''),
     'swap without --harness is refused (the persona IS the swap)');
  const unknown = await selfSwap(manager, { to: worker.slug, harness: `no-such-harness-${tag}` });
  ok(unknown.ok === false && unknown.status === 'refused' && /no harness/i.test(unknown.error),
     'an unknown harness is refused by name');
  const mgrHarness = await selfSwap(manager, { to: worker.slug, harness: 'manager' });
  ok(mgrHarness.ok === false && mgrHarness.status === 'refused' && /MANAGER harness/.test(mgrHarness.error),
     'a MANAGER harness is refused — a manager may not swap another manager into its own crew');
  const otherProject = await selfSwap(manager, { to: worker.slug, harness: foreign.key });
  ok(otherProject.ok === false && otherProject.status === 'refused' && /another project|belongs to project/i.test(otherProject.error),
     "another project's persona is refused, naming the project that owns it");

  ok(calls().length === 0, 'and NOT ONE docker call was made by any refusal above — nothing was touched');
  const after = await readXell(worker.id);
  ok(after.harness_key === 'dev-scout' && (await readZee(outgoing.id)).status === 'working',
     'the xell still wears its old persona and its zee is still working');

  // ── 2. an open HUMAN GATE refuses the swap ────────────────────────────────
  console.log('\nan open human gate on that xell refuses the swap');
  const lr = (await client.query(
    `INSERT INTO land_request (project_id, xell_id, ref, new_sha, status) VALUES ($1,$2,'master','deadbeef01','pending') RETURNING *`,
    [PID, worker.id])).rows[0];
  const gated = await selfSwap(manager, { to: worker.slug, harness: 'dev-builder' });
  ok(gated.ok === false && gated.status === 'refused' && /landing is open/i.test(gated.error),
     `a pending land_request refuses it, and says which gate [${(gated.error || '').slice(0, 90)}]`);
  ok(calls().length === 0, 'still no docker call — the gate check runs BEFORE the collect');
  // holding is the same answer: a queued landing is still a landing on that ref
  await client.query(`UPDATE land_request SET status='holding', holding_since=now() WHERE id=$1`, [lr.id]);
  const held = await selfSwap(manager, { to: worker.slug, harness: 'dev-builder' });
  ok(held.ok === false && /landing is open/i.test(held.error || ''), 'a HOLDING landing refuses it too');
  await client.query(`UPDATE land_request SET cleared_at=now(), cleared_by='test' WHERE id=$1`, [lr.id]);
  // …and a ship, and a done suggestion
  const sr = (await client.query(
    `INSERT INTO ship_request (project_id, xell_id, status) VALUES ($1,$2,'pending') RETURNING *`, [PID, worker.id])).rows[0];
  const shipGated = await selfSwap(manager, { to: worker.slug, harness: 'dev-builder' });
  ok(shipGated.ok === false && /ship is open/i.test(shipGated.error || ''), 'a pending ship refuses it');
  await client.query(`UPDATE ship_request SET dismissed_at=now() WHERE id=$1`, [sr.id]);
  const ds = (await client.query(
    `INSERT INTO done_suggestion (project_id, manager_xell_id, manager_slug, target_xell_id, target_slug, reason)
       VALUES ($1,$2,'lead-one-cc33dd',$3,'scout-work-aa11bb','looks finished') RETURNING *`,
    [PID, manager.id, worker.id])).rows[0];
  const doneGated = await selfSwap(manager, { to: worker.slug, harness: 'dev-builder' });
  ok(doneGated.ok === false && /done/i.test(doneGated.error || ''), 'an open done suggestion refuses it');
  await client.query(`UPDATE done_suggestion SET dismissed_at=now() WHERE id=$1`, [ds.id]);

  // ── 3. THE COLLECT FAILS ON A RUNNING CAGE → the swap is refused OUTRIGHT ──
  // The whole reason this verb lives in the server. If the outgoing zee's commits cannot be pulled
  // out of its cage, nothing may recreate that cage: `docker rm -f` would destroy work that exists
  // in exactly one place.
  console.log('\na collect that FAILS on a running cage refuses the swap and recreates nothing');
  setState({ running: { 'cxell_scout-work-aa11bb': true }, bundle, commits: 1, execFail: true });
  const broke = await selfSwap(manager, { to: worker.slug, harness: 'dev-builder' });
  ok(broke.ok === false && broke.status === 'refused' && broke.stage === 'collect',
     `refused at the COLLECT stage [${(broke.error || '').slice(0, 100)}]`);
  ok(/zee land|zee build/.test(broke.error || ''),
     'and it says how to make the swap possible (have the worker land or build — both collect)');
  ok(!calls().some((c) => /^rm -f/.test(c)),
     'NO `docker rm -f` was issued — the cage, and the commits inside it, are untouched');
  const stillScout = await readXell(worker.id);
  ok(stillScout.harness_key === 'dev-scout', 'the harness was NOT re-assigned (dispatch was never entered)');
  ok((await readZee(outgoing.id)).status === 'working', 'and the outgoing zee was NOT retired');
  ok(git(wtA, 'log', '--oneline').split('\n').length === 1, 'the host worktree is exactly where it was');

  // ── 4. THE SWAP ITSELF — collect first, then re-dispatch into the SAME xell ─
  console.log('\nthe swap: the cage\'s commits are collected BEFORE anything re-dispatches');
  setState({ running: { 'cxell_scout-work-aa11bb': true }, bundle, commits: 1 });
  writeFileSync(callLog, '');
  const swap = await selfSwap(manager, { to: worker.slug, harness: 'dev-builder',
                                         task: 'BUILD the fix the scout scoped.' });
  // The dispatch dies at the spawn in a project with no provider account — everything BEFORE it ran.
  ok(swap.ok === false && SPAWN_STAGE.test(swap.error || ''),
     `only the spawn itself failed (no provider token in a throwaway project) [${(swap.error || '').slice(0, 110)}]`);
  ok(swap.stage === 'dispatch' && swap.collected?.collected === true,
     'and the answer says the COLLECT succeeded before the dispatch was attempted');

  // THE COMMITS SURVIVED — the assertion this whole verb exists for.
  ok(git(wtA, 'rev-parse', 'HEAD') === cageHead,
     'the host worktree is now AT the cage\'s HEAD — the commit that existed only inside the cage is safe');
  ok(git(wtA, 'log', '--oneline').includes('scout: the findings that must survive a swap'),
     'and the outgoing zee\'s commit is on the branch by name');

  // THE ORDERING, read from the actual docker call log rather than from a comment.
  const log = calls();
  const cpAt = log.findIndex((c) => /^cp cxell_scout-work-aa11bb:\/tmp\/out\.bundle/.test(c));
  const rmAt = log.findIndex((c) => /^rm -f/.test(c));
  ok(cpAt >= 0, 'the collect really ran (docker cp of the cage bundle is in the call log)');
  ok(rmAt === -1 || rmAt > cpAt,
     `no cage was removed before the collect (cp@${cpAt}, rm@${rmAt === -1 ? 'never' : rmAt})`);
  ok(log.slice(0, cpAt).every((c) => /^(inspect|exec)/.test(c)),
     'and everything the swap did before that collect was read-only (inspect/exec only)');

  // ── 5. WHAT SURVIVES: the xell is the same xell ───────────────────────────
  console.log('\nthe xell is the SAME xell — only the zee changed');
  const now = await readXell(worker.id);
  ok(now.harness_key === 'dev-builder', `it wears the INCOMING persona (${now.harness_key})`);
  ok(now.slug === worker.slug && now.branch === worker.branch && now.worktree_path === worker.worktree_path,
     'same slug, same branch, same worktree — a swap never renames (dispatchXell rename:false)');
  ok(now.db_coupling === before.db_coupling, `db coupling survives (${now.db_coupling})`);
  ok(now.manager_xell_id === manager.id, 'it still reports to the same manager');
  ok(now.zee_type === 'worker', 'and it is still a worker xell');
  const card = (await client.query(`SELECT * FROM work_item WHERE id=$1`, [item.id])).rows[0];
  ok(card.xell_id === worker.id, 'the work-item card is still on this xell — the board did not lose it');

  // ── 6. THE OUTGOING ZEE IS RETIRED HONESTLY ───────────────────────────────
  const gone = await readZee(outgoing.id);
  ok(!!gone, 'the outgoing zee ROW still exists (it is the record of what that agent did — never deleted)');
  ok(gone.status === 'stopped', `and it is stopped (${gone.status})`);
  ok(/swapped out by lead-one-cc33dd/.test(gone.last_stop_reason || '') && /dev-builder/.test(gone.last_stop_reason || ''),
     `with a stop reason naming the manager and the incoming persona [${gone.last_stop_reason}]`);

  // ── 7. THE HANDOVER — the incoming zee is told it INHERITED this xell ─────
  // This is the brief selfSwap hands dispatchXell, built by the same exported function from the same
  // rows — asserted on its TEXT, because a swap whose brief does not say "you are inheriting" just
  // buys a fresh zee that re-reads the repo and re-does the previous phase.
  console.log('\nthe handover brief tells the incoming zee it is inheriting, not starting');
  const { swapBrief } = await import('../server/src/queenzee/self.js');
  const built = await swapBrief({
    manager, target: await readXell(worker.id),
    harness: { key: 'dev-builder', label: 'Builder' },
    task: 'BUILD the fix the scout scoped.',
  });
  const brief = built.brief;
  ok(brief.startsWith('BUILD the fix the scout scoped.'), 'the manager\'s own --task text leads the brief');
  ok(/YOU ARE INHERITING THIS XELL/.test(brief), 'it says, in the heading, that the xell is INHERITED');
  ok(brief.includes('SCOUT the auth bug'), 'it carries what the PREVIOUS zee was asked to do');
  ok(brief.includes('The cookie is dropped in refreshSession()'), 'and the last thing that zee reported');
  ok(brief.includes('scout: the findings that must survive a swap'),
     'and a git summary of what is actually ON the branch (the collected commit, by subject)');
  ok(brief.includes('spinoff/scout-work-aa11bb'), 'naming the branch it inherited');
  ok(/1 commit\(s\) ahead of master/.test(brief), 'with how far ahead of the source that branch is');
  ok(brief.includes('Fix the auth bug'), 'it names the work-item card the xell is on');
  ok(/`zee report --message/.test(brief) && brief.includes('lead-one-cc33dd'),
     'and the standard manager block — who is watching, and how to talk back');
  ok(/REFUSE and raise it/.test(brief),
     'including the refusal rule (a manager may not send a worker beyond its own xell)');
  ok(built.item?.id === item.id && built.prevZee?.id === outgoing.id,
     'the brief builder resolved the same card and the same outgoing zee the swap did');

  // …and the ORDER is structural in the source too, not just incidental to this run.
  const src = readFileSync(new URL('../server/src/queenzee/self.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export async function selfSwap'), src.indexOf('// POST /api/xell/self/say'));
  ok(body.indexOf('collectCxellDiffToWorktree(') < body.indexOf('dispatchXell('),
     'in the source, the collect is written BEFORE the dispatch — the ordering is structural, not incidental');
  ok(/rename: false/.test(body), 'and it dispatches with rename:false so the branch cannot move');

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  await cleanup({ files: true });
  await client.end().catch(() => {});
}
process.exit(fail ? 1 : 0);

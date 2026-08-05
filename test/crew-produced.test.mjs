// WHAT HAS THIS WORKER PRODUCED? — the crew read model, end to end.
//
// A manager's ONE instrument is `zee zees` (lib/managers.js crewFor → GET /api/xell/self/zees, and
// GET /api/xells/:id/crew for the console). Every field it carried came from the `zee` row, which is
// written at TURN BOUNDARIES: a worker mid-turn reads as the status — and the cost — its LAST turn
// ended in. A manager read `idle` on a reviewer that had restarted and landed a commit eight minutes
// earlier, concluded it was inert, and spent a whole redundant xell redoing landed work. The manual
// meanwhile promised a diff ("ahead/dirty") that crewFor never computed, and told the manager to
// check unlanded work before suggesting done — against a field that did not exist.
//
// So the row now also carries the two things that are MEASURED at read time:
//   landings — {count, last_sha, landed_at} from the landing ledger (status='landed' only);
//   diff     — {ahead, dirty, files, insertions, deletions, head, source}, read from the worker's
//              cxell when one is live, else its host worktree, and NULL — never 0 — when neither can
//              be read.
//
// Exercised against a REAL postgres (DATABASE_URL), REAL git worktrees, and the REAL express router
// over REAL HTTP with a REAL minted xell token. The CLI is the actual `scripts/zee` process, run
// against that server, and the console body is rendered with react-dom/server and read back.
// Everything it creates is torn down in a finally, whatever happens.
import http from 'node:http';
import express from 'express';
import { transformSync } from 'esbuild';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.PRODRO_MODE = 'simulate';
process.env.TKB_NOTIFY = '0';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

const client = new pg.Client({ connectionString: url });
const tmp = mkdtempSync(join(tmpdir(), 'crewprod-'));
const PID = '00000000-0000-4000-8000-0000000c7e01';
const XOURCE = '00000000-0000-4000-8000-0000000c7e02';
const PORT = 47971;
const API = `http://127.0.0.1:${PORT}`;
let server = null;

async function cleanup({ files = false } = {}) {
  try { await client.query(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* */ }
  if (files) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } }
}

try {
  await client.connect();
  await cleanup();

  // ── a real repo: master, a manager, and three workers in three git states ──
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# crew produced\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');

  const wt = (name, branch) => {
    const p = join(tmp, name);
    git(repo, 'worktree', 'add', '-q', '-b', branch, p, 'master');
    git(p, 'config', 'user.email', 'zee@zeehive.local'); git(p, 'config', 'user.name', 'zee');
    return p;
  };
  const mgrWt = wt('mgr', 'spinoff/mgr');

  // BUSY: two commits ahead of master and one uncommitted file — the worker that is producing.
  const busyWt = wt('busy', 'spinoff/busy');
  writeFileSync(join(busyWt, 'a.txt'), 'one\n');
  git(busyWt, 'add', '-A'); git(busyWt, 'commit', '-qm', 'first');
  writeFileSync(join(busyWt, 'b.txt'), 'two\nlines\n');
  git(busyWt, 'add', '-A'); git(busyWt, 'commit', '-qm', 'second');
  writeFileSync(join(busyWt, 'a.txt'), 'one\nchanged\n');       // dirty, uncommitted
  const busyHead = git(busyWt, 'rev-parse', 'HEAD');

  // LANDED: its commit is already on master, so its diff is clean and the ledger has a row.
  const landedWt = wt('landed', 'spinoff/landed');
  writeFileSync(join(landedWt, 'c.txt'), 'landed work\n');
  git(landedWt, 'add', '-A'); git(landedWt, 'commit', '-qm', 'the landed commit');
  const landedSha = git(landedWt, 'rev-parse', 'HEAD');
  git(repo, 'merge', '-q', '--ff-only', 'spinoff/landed');       // it reached main

  // GONE: a worktree path that is not on disk — the diff must be null, never 0.
  const goneWt = join(tmp, 'not-on-disk');

  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,'crew-produced-test',$2,'master','crewprod','postgres')`, [PID, repo]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [XOURCE, PID]);

  const mkXell = async (slug, branch, path, extra = {}) => (await client.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                       zee_type, manager_xell_id, head_commit)
       VALUES ($1,$2,$3,$4,$5,'working',false,$6,$7,$8) RETURNING *`,
    [PID, XOURCE, slug, branch, path, extra.zee_type || 'worker', extra.manager || null,
     extra.head || null])).rows[0];

  const mgr = await mkXell('cp-mgr', 'spinoff/mgr', mgrWt, { zee_type: 'manager' });
  const busy = await mkXell('cp-busy', 'spinoff/busy', busyWt, { manager: mgr.id, head: busyHead });
  const landed = await mkXell('cp-landed', 'spinoff/landed', landedWt, { manager: mgr.id });
  const gone = await mkXell('cp-gone', 'spinoff/gone', goneWt, { manager: mgr.id });

  // The BUSY worker is mid-turn in a live cxell — the case the whole defect is about. Its zee row
  // says 'working' (and would say 'idle' a moment later); its work is measured from git either way.
  // No docker in a test runner, so cxellDiff fails and the row falls back to the host worktree —
  // which is exactly the fallback the read model promises, exercised for real.
  const rt = (await client.query(
    `SELECT id FROM agent_runtime WHERE driver='cxell-cli' ORDER BY sort_order LIMIT 1`)).rows[0];
  await client.query(
    `INSERT INTO zee (xell_id, attach_mode, runtime_id, viewer_kind, status, kind, entrypoint, model, cwd)
       VALUES ($1,'headless-spawn',$2,'none','working','headless','cxell-cli','sonnet','/work/repo')`,
    [busy.id, rt?.id || null]);
  // the LANDED worker's turn ENDED — the zee row a manager would misread as "it did nothing"
  await client.query(
    `INSERT INTO zee (xell_id, attach_mode, runtime_id, viewer_kind, status, kind, entrypoint, model, cwd)
       VALUES ($1,'headless-spawn',$2,'none','stopped','headless','cxell-cli','sonnet','/work/repo')`,
    [landed.id, rt?.id || null]);

  // the LEDGER: one landed request for cp-landed, plus asks that are NOT landings (a pending one
  // for cp-busy and a withdrawn one) — an ask must never be counted as a landing.
  await client.query(
    `INSERT INTO land_request (project_id, xell_id, ref, old_sha, new_sha, status, decided_at, decided_by, landed_at)
       VALUES ($1,$2,'refs/heads/master',$3,$4,'landed', now() - interval '10 minutes', 'human@console',
               now() - interval '8 minutes')`,
    [PID, landed.id, null, landedSha]);
  await client.query(
    `INSERT INTO land_request (project_id, xell_id, ref, old_sha, new_sha, status)
       VALUES ($1,$2,'refs/heads/master',null,$3,'pending')`, [PID, busy.id, busyHead]);

  const managers = await import('../server/src/lib/managers.js');

  // ── 1. the read model itself ──────────────────────────────────────────────
  console.log('\n── the crew read model: what each worker has produced ──');
  const crew = await managers.crewFor(mgr.id);
  const by = Object.fromEntries(crew.map((c) => [c.slug, c]));
  ok(crew.length === 3, `the manager's three workers are listed (${crew.length})`);

  ok(by['cp-busy'].diff?.ahead === 2,
     `a worker with two unlanded commits reports ahead=2 (${by['cp-busy'].diff?.ahead})`);
  ok(by['cp-busy'].diff?.dirty === 1,
     `and its ONE uncommitted file as dirty=1 (${by['cp-busy'].diff?.dirty})`);
  ok(by['cp-busy'].diff?.insertions > 0 && by['cp-busy'].diff?.files > 0,
     `and the shortstat of what it would land (+${by['cp-busy'].diff?.insertions}/−${by['cp-busy'].diff?.deletions}`
     + ` in ${by['cp-busy'].diff?.files} file(s))`);
  ok(by['cp-busy'].diff?.head === busyHead,
     'and the LIVE head it is sitting on, not the commit it was provisioned at');
  ok(by['cp-busy'].diff?.source === 'worktree',
     `and SAYS where the number came from (${by['cp-busy'].diff?.source}) — the cxell read failed, so it fell back`);
  ok(by['cp-busy'].zee_status === 'working' && by['cp-busy'].landings?.count === 0,
     'a busy worker has landed nothing yet — a pending land request is an ASK, not a landing');

  ok(by['cp-landed'].landings?.count === 1,
     `the worker that landed shows one landing (${by['cp-landed'].landings?.count})`);
  ok(by['cp-landed'].landings?.last_sha === landedSha,
     'with the exact sha that reached main');
  ok(by['cp-landed'].landings?.landed_at instanceof Date,
     `and WHEN it landed (${by['cp-landed'].landings?.landed_at?.toISOString?.()})`);
  ok(by['cp-landed'].zee_status === 'stopped' && by['cp-landed'].diff?.ahead === 0,
     'its own zee row says stopped and its diff is clean — the landing is the only evidence it worked');

  ok(by['cp-gone'].diff === null,
     `a worker with no worktree on disk reports diff=null, NOT zeroes (${JSON.stringify(by['cp-gone'].diff)})`);
  ok(by['cp-gone'].landings?.count === 0 && by['cp-gone'].landings?.last_sha === null,
     'and a landings row that is honestly empty rather than absent');

  // the THROTTLE — this is polled, so the answer is cached per xell (15s). A third commit made
  // right after a read is deliberately NOT visible yet.
  writeFileSync(join(busyWt, 'd.txt'), 'third\n');
  git(busyWt, 'add', '-A'); git(busyWt, 'commit', '-qm', 'third');
  const again = (await managers.crewFor(mgr.id)).find((c) => c.slug === 'cp-busy');
  ok(again.diff?.ahead === 2,
     `the diff is CACHED between polls (still ahead=2 a commit later — ${again.diff?.ahead}); a git call per worker per poll is not free`);

  // ── 2. over real HTTP, as the manager's own token ─────────────────────────
  console.log('\n── over real HTTP: the two endpoints that serve it ──');
  const { router } = await import('../server/src/api/routes.js');
  const { mintXellToken } = await import('../server/src/lib/xell-token.js');
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const token = await mintXellToken(mgr.id);

  const zees = await (await fetch(`${API}/api/xell/self/zees`,
    { headers: { authorization: `Bearer ${token}` } })).json();
  const httpBusy = zees.crew?.find((c) => c.slug === 'cp-busy');
  const httpLanded = zees.crew?.find((c) => c.slug === 'cp-landed');
  ok(zees.ok === true && zees.count === 3, `GET /api/xell/self/zees answers the manager (${zees.count} worker(s))`);
  ok(httpBusy?.diff?.ahead === 2 && httpBusy?.diff?.dirty === 1,
     'the diff survives the JSON round trip (ahead + dirty)');
  ok(httpLanded?.landings?.count === 1 && httpLanded?.landings?.last_sha === landedSha,
     'and so do the landings (count + sha)');
  ok(typeof httpLanded?.landings?.landed_at === 'string',
     'landed_at serialises as a timestamp an agent can read');
  ok(/UNLANDED/.test(zees.message) && /cp-busy/.test(zees.message),
     `the summary names who is holding unlanded commits — the thing never to suggest done over (${zees.message})`);

  const consoleCrew = await (await fetch(`${API}/api/xells/${mgr.id}/crew`)).json();
  ok(Array.isArray(consoleCrew) && consoleCrew.find((c) => c.slug === 'cp-landed')?.landings?.count === 1
     && consoleCrew.find((c) => c.slug === 'cp-busy')?.diff?.ahead === 2,
     'the console endpoint (GET /api/xells/:id/crew) serves the same two facts');

  // ── 3. the CLI a manager actually types ──────────────────────────────────
  console.log('\n── `zee zees`: the ONE authoritative CLI ──');
  // ASYNC spawn, deliberately: the server under test is in THIS process, so a spawnSync would block
  // the event loop that has to answer the CLI's request — the test would deadlock, not fail.
  const cli = await new Promise((done) => {
    const p = spawn(process.execPath, [join(ROOT, 'scripts/zee'), 'zees'], {
      env: { ...process.env, ZEEHIVE_API: API, ZEEHIVE_XELL_TOKEN: token },
    });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => done({ status, stdout, stderr }));
  });
  const out = cli.stdout || '';
  ok(cli.status === 0, `\`zee zees\` exits 0 (${cli.status})${cli.status === 0 ? '' : `\n${cli.stderr}`}`);
  ok(/cp-busy/.test(out) && /branch: spinoff\/busy/.test(out), 'it prints the worker and its branch');
  ok(/git: ↑2 unlanded commit\(s\) · 1 dirty file\(s\)/.test(out),
     `it prints the unlanded/dirty position in one readable line\n      ${out.split('\n').find((l) => l.includes('git: ↑2')) || '(missing)'}`);
  ok(new RegExp(`landed: 1 — last ${landedSha.slice(0, 8)}`).test(out),
     `and what reached main\n      ${out.split('\n').find((l) => l.includes('landed: 1')) || '(missing)'}`);
  ok(/landed: nothing on main yet/.test(out), 'a worker that has landed nothing says so rather than printing a blank');
  ok(/not measurable/.test(out), 'and an unmeasurable diff says so instead of reading as 0');

  // ── 4. the console's crew view ───────────────────────────────────────────
  console.log('\n── the console: the manager panel\'s crew rows ──');
  const built = [];
  let CrewBody, React, renderToStaticMarkup;
  try {
    const outFile = 'web/src/.crew-produced.test-build.mjs';
    writeFileSync(join(ROOT, outFile),
      transformSync(readFileSync(join(ROOT, 'web/src/Directives.jsx'), 'utf8'), { loader: 'jsx', format: 'esm' }).code);
    built.push(outFile);
    ({ CrewBody } = await import('../' + outFile));
    React = require_('react');
    renderToStaticMarkup = require_('react-dom/server').renderToStaticMarkup;
  } finally { for (const f of built) rmSync(join(ROOT, f), { force: true }); }

  const html = renderToStaticMarkup(React.createElement(CrewBody, { crew: consoleCrew }));
  ok(/crew-row/.test(html) && /cp-busy/.test(html) && /cp-landed/.test(html), 'one row per worker');
  ok(new RegExp(`landed 1 × · last ${landedSha.slice(0, 8)}`).test(html),
     'the landing is readable on the row (count + sha)');
  ok(/↑2 unlanded · 1 dirty/.test(html), 'and so is the unlanded position');
  ok(/crew-diff unlanded/.test(html), 'unlanded work is MARKED (it is the one thing that must not be closed out)');
  ok(/crew-diff-unknown/.test(html), 'an unmeasurable diff renders as "not measurable", never as 0/0');
  ok(/nothing landed yet/.test(html), 'and a worker with no landing says so');
  ok(renderToStaticMarkup(React.createElement(CrewBody, { crew: [] })).includes('crew-empty'),
     'an empty crew states that instead of a blank panel');

  const dirSrc = readFileSync(join(ROOT, 'web/src/Directives.jsx'), 'utf8');
  ok(/isManagerXell\(xell\)/.test(dirSrc) && /if \(manager\) fetchCrew/.test(dirSrc),
     'the panel reads the crew ONLY for a manager (a worker has none, and the read costs a git call per worker)');
  ok(/fetchCrew/.test(readFileSync(join(ROOT, 'web/src/api.js'), 'utf8')),
     'through the api.js client for GET /api/xells/:id/crew');

  // ── 5. house rule 8: the manual says what the code does ──────────────────
  console.log('\n── what a manager is TOLD matches what it gets ──');
  const manual = (await client.query(
    `SELECT harness_memory_get('manager','memory/manager-zee-manual.md') AS t`)).rows[0].t;
  ok(!!manual, 'the manager manual is in the meta-DB');
  ok(/WHAT IT HAS PRODUCED/.test(manual) && /`landings`/.test(manual) && /`diff`/.test(manual),
     'and it documents the two fields the crew row now carries');
  ok(/TURN BOUNDARIES/.test(manual),
     'and warns that status/model/cost are as old as the worker\'s last turn boundary');
  ok(/diff\.ahead/.test(manual),
     'and the never-suggest-done-over-unlanded-work rule names the field to check (diff.ahead)');
} catch (e) {
  console.error('\n✗ FAIL (threw):', e?.stack || e?.message || e);
  fail++;
} finally {
  if (server) await new Promise((r) => server.close(r));
  await cleanup({ files: true });
  await client.end().catch(() => {});
  try { const { pool } = await import('../server/src/db/pool.js'); await pool.end(); } catch { /* */ }
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nall good');
process.exit(fail ? 1 : 0);

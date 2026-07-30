// A FAILURE THAT NAMES THE WRONG CAUSE COSTS MORE THAN THE FAILURE — ticket #36, the reaper half.
//
// `reapXell` guarded its despawn with one `&&` chain:
//
//     if (destructive && existsSync(script) && xell.worktree_path && existsSync(xell.worktree_path))
//
// Four different situations dropped out of that into the SAME three words in the log — "despawn
// failed" — and one of them (`scripts/despawn-xell.sh` missing from the queenzee's own tree) is not a
// per-xell problem at all: it means every teardown on that queenzee purges nothing. A human reading
// "despawn failed" goes hunting a docker fault that does not exist. That is the whole ticket: three
// zees lost time today to failures that named the wrong cause.
//
// So each of the four now says which it is, and this test drives the REAL reapXell for each:
//   1. the script is MISSING           → names the path, says it is not a docker fault, and is LOUD
//   2. the script RAN and failed       → names the exit code and the script's own last line
//   3. no worktree_path on the row     → says there was nothing on disk to tear down
//   4. the worktree is already gone    → says so; this one is FINE, not a failure
// plus simulate, which was already named, and the invariant that matters more than any of them:
// A MISSING SCRIPT STILL NEVER BLOCKS A TEARDOWN. The log changes; the behaviour does not.
//
// Everything it creates is torn down in a finally.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PROVISION_MODE = 'simulate';        // the loops must not act while this test runs
const { config } = await import('../server/src/config.js');
const { q, one, pool } = await import('../server/src/db/pool.js');
const { recentLogs } = await import('../server/src/lib/logbus.js');
const { reapXell } = await import('../server/src/queenzee/reaper.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const section = (t) => console.log(`\n── ${t} ──`);
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

const REAL_ROOT = config.repoRoot;
const tag = randomUUID().slice(0, 8);
const tmp = mkdtempSync(join(tmpdir(), 'reapcause-'));
let projId = null;
const madeXells = [];
const since = () => recentLogs(400).length;
const linesSince = (n) => recentLogs(400).slice(n).filter((l) => l.scope === 'reaper').map((l) => l.msg);

// A fake queenzee tree carrying (or not carrying) scripts/despawn-xell.sh — config.repoRoot is where
// the reaper looks for it, so pointing that at a directory we control IS the missing-script case.
const treeWith = (name, script) => {
  const root = join(tmp, name);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  if (script) {
    const p = join(root, 'scripts', 'despawn-xell.sh');
    writeFileSync(p, script);
    chmodSync(p, 0o755);
  }
  return root;
};

try {
  const repo = join(tmp, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README'), 'x\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');

  projId = (await one(`INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'master') RETURNING id`,
    [`zt-reapcause-${tag}`, repo])).id;
  const xource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [projId]);

  // a xell with a REAL worktree on disk (so only the script's presence decides), and one with none
  const mkXell = async (slug, worktree) => {
    const x = await one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled)
         VALUES ($1,$2,$3,$4,$5,'idle',false) RETURNING *`,
      [projId, xource.id, slug, `spinoff/${slug}`, worktree]);
    madeXells.push(x.id);
    return x;
  };
  const worktreeFor = (slug) => {
    const wt = join(tmp, slug);
    git(repo, 'worktree', 'add', '-q', '-b', `spinoff/${slug}`, wt, 'master');
    return wt;
  };

  // ── 1. the script is MISSING from the queenzee's own tree ─────────────────
  section('the despawn script is missing — a deployment fault, not a docker fault');
  const a = await mkXell(`rc-a-${tag}`, worktreeFor(`rc-a-${tag}`));
  config.repoRoot = treeWith('no-script', null);
  let n = since();
  const rA = await reapXell(a.id, 'test', { mode: 'real' });
  let log = linesSince(n).join('\n');
  ok(rA.ok === true, 'the teardown still SUCCEEDS — a missing script must never block a reap');
  ok((await one(`SELECT status FROM xell WHERE id=$1`, [a.id])).status === 'retired',
     'and the xell is retired, exactly as before');
  ok(/despawn script is MISSING/.test(log), 'the log says the SCRIPT is missing');
  ok(log.includes(join(config.repoRoot, 'scripts', 'despawn-xell.sh')),
     'naming the exact path it looked for');
  ok(/nothing here is a docker fault/.test(log),
     'and says out loud that this is not a docker fault — the wrong hunt this ticket is about');
  ok(/every teardown on this queenzee is degraded/.test(log),
     'and that it is fleet-wide, not about this one xell');
  ok(/!!!/.test(log), 'flagged loud, like the other deployment faults');
  ok(!/despawn failed(?![a-z])/.test(log), 'and never the old bare "despawn failed"');

  // ── 2. the script RAN and failed ──────────────────────────────────────────
  section('the script ran and failed — a different fact, and a different response');
  const b = await mkXell(`rc-b-${tag}`, worktreeFor(`rc-b-${tag}`));
  config.repoRoot = treeWith('bad-script',
    '#!/usr/bin/env bash\necho "spin-env purge: no such compose project" >&2\nexit 3\n');
  n = since();
  const rB = await reapXell(b.id, 'test', { mode: 'real' });
  log = linesSince(n).join('\n');
  ok(rB.ok === true, 'the teardown still succeeds (best-effort, unchanged)');
  ok(/RAN and failed \(exit 3\)/.test(log), 'the log says it RAN, and with which exit code');
  ok(/no such compose project/.test(log), "carrying the script's own last line — the part a human acts on");
  ok(!/is MISSING/.test(log), 'and does not confuse this with an absent script');

  // ── 3. the row has no worktree at all ─────────────────────────────────────
  section('no worktree_path on the row');
  const c = await mkXell(`rc-c-${tag}`, null);
  config.repoRoot = treeWith('ok-script', '#!/usr/bin/env bash\necho \'{"ok":true}\'\n');
  n = since();
  await reapXell(c.id, 'test', { mode: 'real' });
  log = linesSince(n).join('\n');
  ok(!/despawn/i.test(log) || /nothing on disk to tear down/.test(log),
     'either it says nothing (there was nothing to report) or it says there was nothing on disk');

  // ── 4. the worktree is already gone — which is FINE ───────────────────────
  section('the worktree is already gone — not a failure at all');
  const dWt = join(tmp, `rc-d-${tag}`);
  const d = await mkXell(`rc-d-${tag}`, dWt);          // path recorded, never created
  n = since();
  await reapXell(d.id, 'test', { mode: 'real' });
  log = linesSince(n).join('\n');
  ok(!/MISSING|RAN and failed/.test(log), 'it is not reported as a script problem');
  ok(!/!!!/.test(log), 'and not flagged loud — nothing went wrong here');

  // ── 5. simulate still says what it always said ────────────────────────────
  section('simulate is unchanged');
  const e = await mkXell(`rc-e-${tag}`, worktreeFor(`rc-e-${tag}`));
  n = since();
  await reapXell(e.id, 'test', { mode: 'simulate' });
  log = linesSince(n).join('\n');
  ok(/PROVISION_MODE=simulate/.test(log), 'the simulate reason is still named');
  ok((await one(`SELECT status FROM xell WHERE id=$1`, [e.id])).status === 'retired',
     'and it still retires the row only');

  // ── 6. the shape of the fix, not just this instance ───────────────────────
  section('the guard cannot silently grow a fifth unnamed reason');
  const src = (await import('node:fs')).readFileSync(join(REAL_ROOT, 'server/src/queenzee/reaper.js'), 'utf8');
  ok(/const skipReason =/.test(src), 'the reason is computed explicitly, not inferred from an && chain');
  ok(/despawn did not run and did not say why — that is a bug in reaper\.js/.test(src),
     'and a branch that forgets to set one says THAT, instead of blaming docker');
} finally {
  config.repoRoot = REAL_ROOT;
  for (const id of madeXells) await q(`DELETE FROM xell WHERE id=$1`, [id]).catch(() => {});
  if (projId) await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  await pool.end().catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

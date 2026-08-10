// PROVENANCE SPINE (TKT-159-3139) — per-actor git identity, door-side write ledger, land_request
// diff provenance.
//
// Proves the three strands against a THROWAWAY postgres + real git repos (the same shape as the
// land-loop suite):
//   (a) a commit authored by the zee slug (GIT_AUTHOR_*) and committed by the DOOR (git config
//       user.name 'xell', <slug>@xell.zeehive.local) reads author=<slug>, committer=xell door.
//   (b) a console-terminal input frame ({t:'i',d}) leaves a row in door_write_event via the
//       terminal-bridge ledger helper — sanitised, attributed, append-only.
//   (c) the land gate's pushedCommits carries per-commit committer + door, and checkPush stores
//       that richer shape in land_request.commits.
//
// Runs the REAL queenzee code (no mocks of the logic under test). The ONLY seam is the throwaway
// postgres this suite points DATABASE_URL at (the assigned shared-dev db is not reachable from a
// cxell; the manual's db-sandbox is the supported row-writing evidence path).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PROVISION_MODE = 'simulate';   // this suite only reads the gate; no refs are moved

const { q, one, pool } = await import('../server/src/db/pool.js');
const { safeTerminalInput, consoleGitIdentityEnv, recordDoorWrite } =
  await import('../server/src/lib/terminal-bridge.js');
const { doorFromEmail } = await import('../server/src/lib/git.js');
const { pushedCommits, checkPush } = await import('../server/src/queenzee/landgate.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tmp = mkdtempSync(join(tmpdir(), 'prov-spine-'));
const src = join(tmp, 'src');
mkdirSync(src);
const git = (cwd, args, env = {}) => spawnSync('git', ['-C', cwd, ...args],
  { encoding: 'utf8', env: { ...process.env, ...env } });
const gok = (cwd, args, env = {}) => { const r = git(cwd, args, env); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };

try {
  // ── (a) per-actor git identity: author = zee slug, committer = door ──────────────
  console.log('\n── (a) per-actor git identity ──');
  gok(src, ['init', '-q', '-b', 'main']);
  // The spawn-time override (cxell.js configureCxellGitIdentity): the DOOR identity in config.
  gok(src, ['config', 'user.name', 'xell']);
  gok(src, ['config', 'user.email', 'provenance-test@xell.zeehive.local']);
  // The headless/console env (intake.js gitAuthorEnv + openCxellSsh): the AUTHOR is the zee slug.
  const SLUG = 'provenance-spine-test';
  const authorEnv = { GIT_AUTHOR_NAME: SLUG, GIT_AUTHOR_EMAIL: `${SLUG}@zeehive.local` };
  writeFileSync(join(src, 'a.txt'), 'A\n');
  gok(src, ['add', '.']);
  gok(src, ['commit', '-qm', 'zee-authored commit'], authorEnv);

  const author = gok(src, ['log', '-1', '--format=%an <%ae>']);
  const committer = gok(src, ['log', '-1', '--format=%cn <%ce>']);
  ok(author === `${SLUG} <${SLUG}@zeehive.local>`, `AUTHOR is the zee slug (got '${author}')`);
  ok(committer === `xell <provenance-test@xell.zeehive.local>`, `COMMITTER is the xell door (got '${committer}')`);

  // The console door's committer env (terminal-bridge consoleGitIdentityEnv) overrides the config.
  const consoleEnv = consoleGitIdentityEnv(SLUG);
  ok(/GIT_COMMITTER_NAME='console'/.test(consoleEnv), 'consoleGitIdentityEnv sets the console door name');
  ok(new RegExp(`GIT_COMMITTER_EMAIL='${SLUG}@console\\.zeehive\\.local'`).test(consoleEnv),
    'consoleGitIdentityEnv sets the console door email with the slug');
  ok(doorFromEmail('provenance-test@xell.zeehive.local') === 'xell', 'doorFromEmail: @xell → xell door');
  ok(doorFromEmail(`${SLUG}@console.zeehive.local`) === 'console', 'doorFromEmail: @console → console door');
  ok(doorFromEmail('queenzee@zeehive.local') === 'queenzee', 'doorFromEmail: queenzee → queenzee door');
  ok(doorFromEmail('random@example.com') === 'unknown', 'doorFromEmail: anything else → unknown');

  // ── (b) door-side write ledger: a console-terminal input leaves a row ────────────
  console.log('\n── (b) door-side write ledger ──');
  const doorTarget = 'prov-test-zee-' + Date.now();
  const rawInput = 'git commit -m "fix" \x1b[D\x07';   // includes ESC + BEL control chars
  recordDoorWrite({ door: 'console-terminal', xellId: null, zeeId: null,
                    target: doorTarget, input: rawInput });
  // recordDoorWrite is fire-and-forget — poll briefly (a pg pool flush is not synchronous).
  let rows = [];
  for (let i = 0; i < 20 && !rows.length; i++) {
    await new Promise((r) => setTimeout(r, 100));
    rows = await q(`SELECT * FROM door_write_event WHERE target='${doorTarget}' ORDER BY id DESC LIMIT 1`);
  }
  ok(rows.length === 1, 'a door_write_event row was recorded for the terminal input');
  if (rows.length) {
    ok(rows[0].door === 'console-terminal', `door is 'console-terminal' (got '${rows[0].door}')`);
    ok(rows[0].input.includes('\\x1b') && rows[0].input.includes('\\x07'),
      'control chars are escaped in the safe input representation');
    ok(rows[0].input.includes('git commit -m'), 'the readable text of the input survives');
  }
  ok(safeTerminalInput('plain text') === 'plain text', 'safeTerminalInput leaves plain text alone');
  ok(safeTerminalInput('a\rb') === 'a\\rb', 'safeTerminalInput escapes CR');

  // ── (c) land_request diff provenance ─────────────────────────────────────────────
  console.log('\n── (c) land_request diff provenance ──');
  // A second commit with the console-door committer, then read the range through pushedCommits.
  gok(src, ['commit', '--allow-empty', '-qm', 'console-typed commit'],
      { ...authorEnv, ...{ GIT_COMMITTER_NAME: 'console', GIT_COMMITTER_EMAIL: `${SLUG}@console.zeehive.local` } });
  const base = gok(src, ['rev-parse', 'HEAD~1']);
  const head = gok(src, ['rev-parse', 'HEAD']);
  const commits = pushedCommits(src, base, head);
  ok(commits.length === 1, `pushedCommits returns the pushed commit (got ${commits.length})`);
  if (commits.length) {
    const c = commits[0];
    ok(c.author === SLUG, `author is the zee slug (got '${c.author}')`);
    ok(c.committer === 'console', `committer is the console door (got '${c.committer}')`);
    ok(c.door === 'console', `door is 'console' (got '${c.door}')`);
    ok(c.committer_email === `${SLUG}@console.zeehive.local`, 'committer_email carries the slug + console door');
  }

  // And through the REAL gate: checkPush stores the richer commits shape on the row.
  await q(`DELETE FROM land_request WHERE ref='refs/heads/main' AND xell_id IS NOT NULL`);
  await q(`DELETE FROM xell WHERE slug='prov-spine-xell'`);
  await q(`DELETE FROM project WHERE name='prov-spine-proj'`);
  const project = await one(
    `INSERT INTO project (name, repo_root, main_branch, auto_approve_land)
     VALUES ('prov-spine-proj', $1, 'main', false) RETURNING *`, [src]);
  const xource = await one(
    `INSERT INTO xource (project_id, ref, xell_id) VALUES ($1, 'main', NULL) RETURNING *`, [project.id]);
  await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, head_commit, status, self_token_hash)
     VALUES ($1,$2,'prov-spine-xell','spinoff/prov-spine',$3,$4,'working','provspinehash') RETURNING *`,
    [project.id, xource.id, src, base]);
  const gate = await checkPush({ projectId: project.id, ref: 'refs/heads/main', oldSha: base, newSha: head });
  ok(gate.allow === false && gate.reason === 'pending', `the push is HELD for review (got '${gate.reason}')`);
  const lr = await one(
    `SELECT commits FROM land_request WHERE project_id=$1 AND new_sha=$2 ORDER BY requested_at DESC LIMIT 1`,
    [project.id, head]);
  ok(lr && Array.isArray(lr.commits) && lr.commits.length === 1, 'land_request.commits is the richer array');
  if (lr && lr.commits?.length) {
    const c = lr.commits[0];
    ok(c.author === SLUG, `land_request.commits[0].author is the slug (got '${c.author}')`);
    ok(c.committer === 'console' && c.door === 'console',
      `land_request.commits[0] carries committer + door (got committer='${c.committer}' door='${c.door}')`);
  }

} finally {
  // door_write_event is append-only by design (the point of the ledger) — the test's rows are
  // left behind, like the land suites' project rows. Only the mutable fixtures are cleaned up.
  await q(`DELETE FROM land_request WHERE ref='refs/heads/main' AND xell_id IS NOT NULL`).catch(() => {});
  await q(`DELETE FROM xell WHERE slug='prov-spine-xell'`).catch(() => {});
  await q(`DELETE FROM project WHERE name='prov-spine-proj'`).catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
  await pool.end().catch(() => {});
}

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures === 0 ? 0 : 1);

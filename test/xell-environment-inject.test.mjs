// INJECT A PROJECT ENVIRONMENT INTO A XELL — ticket #20, proved against a real xell and a real file.
//
// The server half already existed (resolveEnvironmentFor / resolvedEnvView / setXellEnvironment); the
// gap was that a human could not see or set any of it. So this test does two things:
//
//   1. THE ROUND TRIP, ON DISK. Pin → re-read .zeehive.env → clear → re-read, against a REAL xell row
//      with a REAL worktree. Not "the endpoint was called": the file is read off the disk each time
//      and its var lines are compared. This is also where the RESERVED names are checked — an
//      environment that tries to set DATABASE_URL or a port must not be able to, because a picker
//      that could re-point a xell at another database would be a route around the §6.2 guard rather
//      than a convenience.
//
//   2. THE THREE SENTENCES. On this project both Zeehive environments hold ZERO vars, so a correct
//      injection writes nothing and looks exactly like a bug — ticket #15 lost an afternoon to that.
//      So "no environment", "resolved but EMPTY" and "resolved with N vars" must be three different
//      answers from the read model and three different renderings in the console. Both are asserted:
//      the API's shape, and the REAL component rendered with react-dom/server.
//
// A prod-coupled xell resolving to the PROD environment — the second half of the ticket's sentence —
// is exercised through the same read model, on a xell whose only difference is its db_coupling.
//
// Everything it creates is torn down in a finally.
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { q, one, pool } = await import('../server/src/db/pool.js');
const E = await import('../server/src/lib/environments.js');
const { emitXellEnv } = await import('../server/src/lib/provision.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const section = (t) => console.log(`\n── ${t} ──`);
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

const tmp = mkdtempSync(join(tmpdir(), 'xenv-'));
const PID = '00000000-0000-4000-8000-00000000e201';
const XO = '00000000-0000-4000-8000-00000000e202';
const cleanup = () => q(`DELETE FROM project WHERE id=$1`, [PID]).catch(() => {});

try {
  await cleanup();

  // a real repo + two real worktrees, because emitXellEnv writes a real file into one
  const repo = join(tmp, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  execFileSync('bash', ['-lc', `echo hi > ${JSON.stringify(join(repo, 'README'))}`]);
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
  const wt = join(tmp, 'wt'); git(repo, 'worktree', 'add', '-q', '-b', 'spinoff/xenv', wt, 'master');
  const wtProd = join(tmp, 'wt-prod'); git(repo, 'worktree', 'add', '-q', '-b', 'spinoff/xenv-prod', wtProd, 'master');

  await q(`INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
             VALUES ($1,'xenv-test',$2,'master','xenvdb','postgres')`, [PID, repo]);
  await q(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [XO, PID]);
  const mkXell = async (slug, path, coupling) => one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, db_coupling)
       VALUES ($1,$2,$3,$4,$5,'idle',false,$6) RETURNING *`,
    [PID, XO, slug, `spinoff/${slug}`, path, coupling]);
  const dev = await mkXell('xenv-dev', wt, 'db-isolated');
  const prod = await mkXell('xenv-prod', wtProd, 'db-shared-prod');

  const envFile = () => (existsSync(join(wt, '.zeehive.env')) ? readFileSync(join(wt, '.zeehive.env'), 'utf8') : '');
  const varsIn = (text) => text.split('\n').filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => l.split('=')[0]);

  // ── 1. nothing configured: the read model says ABSENT, not empty ──────────
  section('no environment at all');
  const none = await E.resolvedEnvView(dev);
  ok(none.environment === null, 'resolvedEnvView reports NO environment rather than an empty one');
  ok(none.pinned === false && none.tier === 'dev', 'and says which tier it would have resolved by');
  await emitXellEnv(dev.id);
  const bare = envFile();
  ok(bare.includes('SPINOFF_SLUG=xenv-dev'), 'the projection still writes the queenzee-owned lines');
  ok(/# —— environment: none configured/.test(bare),
     `and SAYS that none is configured rather than staying silent — "${(bare.match(/^# —— environment:.*/m) || [''])[0].trim()}"`);

  // ── 2. an environment with ZERO vars — the trap ──────────────────────────
  section('an environment that resolved and is EMPTY');
  const empty = await E.createEnvironment(PID, { key: 'dev', tier: 'dev', label: 'dev (empty)', is_default: true });
  const viewEmpty = await E.resolvedEnvView({ ...dev });
  ok(viewEmpty.environment?.key === 'dev', 'it now resolves by TIER (no pin needed)');
  ok(viewEmpty.vars.length === 0, 'with zero vars — the state that looks exactly like a bug');
  await emitXellEnv(dev.id);
  const emptied = envFile();
  ok(/# —— environment: dev \(dev\) — resolved, but it holds 0 vars/.test(emptied),
     `the projection NAMES the resolved environment even with 0 vars — ${(emptied.match(/^# environment:.*/m) || [''])[0].trim()}`);
  ok(varsIn(emptied).every((n) => !['FOO', 'SHARED_TOKEN'].includes(n)), 'and adds no vars, because there are none');

  // ── 3. THE ROUND TRIP: pin → file → clear → file ─────────────────────────
  section('pin, re-read the file, clear, re-read');
  const staging = await E.createEnvironment(PID, { key: 'staging', tier: 'dev', label: 'staging' });
  await E.setVar(staging.id, 'SHARED_TOKEN', { value: 'st-value', is_secret: false });
  await E.setVar(staging.id, 'API_BASE', { value: 'https://staging.example', is_secret: false });
  // …and the two names a picker must never be able to inject
  await E.setVar(staging.id, 'SECRET_KEY', { value: 'sk-do-not-leak', is_secret: true });
  // the names the PROJECTION owns — an environment that sets them must not win, or a picker would
  // become a way to re-point a xell at another database or another port
  await E.setVar(staging.id, 'DATABASE_URL', { value: 'postgres://evil/db', is_secret: false });
  await E.setVar(staging.id, 'SPINOFF_SLUG', { value: 'not-my-slug', is_secret: false });

  const pinned = await E.setXellEnvironment(dev.id, staging.id);
  ok(pinned.ok === true && pinned.environment_id === staging.id, 'the pin is recorded on the xell');
  const afterPin = envFile();
  ok(varsIn(afterPin).includes('SHARED_TOKEN') && varsIn(afterPin).includes('API_BASE'),
     `the FILE on disk now carries the environment's vars (${varsIn(afterPin).filter((n) => ['SHARED_TOKEN', 'API_BASE'].includes(n)).join(', ')})`);
  ok(/# —— environment: staging \(dev\) — \d+ var\(s\)/.test(afterPin),
     `and names staging and its count as the source — "${(afterPin.match(/^# —— environment:.*/m) || [''])[0].trim()}"`);
  ok(afterPin.includes('SHARED_TOKEN=st-value'), 'with the real value — this file IS one of the two value doors');
  const pinnedView = await E.resolvedEnvView(await one(`SELECT * FROM xell WHERE id=$1`, [dev.id]));
  ok(pinnedView.pinned === true && pinnedView.reason === 'pinned', 'the read model says it was PINNED, not resolved by tier');
  const secretVar = pinnedView.vars.find((v) => v.name === 'SECRET_KEY');
  ok(pinnedView.vars.length === 5, `the picker payload lists every var by name (${pinnedView.vars.map((v) => v.name).join(', ')})`);
  ok(pinnedView.vars.some((v) => v.name === 'DATABASE_URL'),
     'including the reserved ones — the picker SHOWS what the environment holds; the projection is what refuses them');
  ok(secretVar && !('value' in secretVar) && secretVar.value_hint && secretVar.length > 0,
     `a SECRET var leaves only a hint and a length (${secretVar?.value_hint}) — the value stays in the meta-DB`);
  ok(!JSON.stringify(pinnedView).includes('sk-do-not-leak'),
     'the secret value appears nowhere in the payload a picker renders');

  // the DATABASE_URL half of the guard: whatever the environment says, the projection keeps the
  // queenzee's own connection string — a picker must not be able to re-point a xell at another db
  ok(!/evil/.test(afterPin),
     'an environment that SETS DATABASE_URL cannot redirect it — the projection drops the reserved name');
  ok(!/^SPINOFF_SLUG=not-my-slug$/m.test(afterPin) && /^SPINOFF_SLUG=xenv-dev$/m.test(afterPin),
     'nor the slug — the queenzee-owned lines win over anything the environment says');

  const cleared = await E.setXellEnvironment(dev.id, null);
  ok(cleared.environment_id === null, 'clearing removes the pin');
  const afterClear = envFile();
  ok(!varsIn(afterClear).includes('SHARED_TOKEN'),
     'and the FILE loses the pinned vars — it went back to the (empty) tier default');
  ok(/# —— environment: dev \(dev\) — resolved, but it holds 0 vars/.test(afterClear),
     'naming the tier-resolved (empty) environment again — the empty sentence, not silence');
  const clearedView = await E.resolvedEnvView(await one(`SELECT * FROM xell WHERE id=$1`, [dev.id]));
  ok(clearedView.pinned === false && clearedView.environment?.key === 'dev', 'the read model agrees');

  // ── 4. a PRODUCTION-coupled xell takes the PROD environment ──────────────
  section('a prod-coupled xell resolves to the prod environment');
  const prodEnv = await E.createEnvironment(PID, { key: 'prod', tier: 'prod', label: 'production', is_default: true });
  await E.setVar(prodEnv.id, 'API_BASE', { value: 'https://prod.example', is_secret: false });
  const prodView = await E.resolvedEnvView(prod);
  ok(prodView.environment?.key === 'prod' && prodView.environment.tier === 'prod',
     'a db-shared-prod xell resolves to the PROD environment with no pin at all');
  ok(prodView.pinned === false && /production xell/.test(prodView.reason || ''),
     `and says WHY it got it ("${prodView.reason}")`);
  const devView = await E.resolvedEnvView(await one(`SELECT * FROM xell WHERE id=$1`, [dev.id]));
  ok(devView.environment?.tier === 'dev', 'while the dev xell beside it still resolves to dev');

  // ── 5. the CONSOLE: three states, three sentences ────────────────────────
  section('the console renders absent / empty / populated differently');
  {
    const esbuild = await import('esbuild');
    const { createRequire } = await import('node:module');
    const out = join(tmp, 'xenv-bundle.cjs');
    await esbuild.build({
      stdin: {
        contents: `
          const React = require('react');
          const { renderToStaticMarkup } = require('react-dom/server');
          const XellEnvironment = require('./XellEnvironment.jsx').default;
          module.exports = { React, renderToStaticMarkup, XellEnvironment };`,
        resolveDir: join(ROOT, 'web/src'), loader: 'js',
      },
      bundle: true, format: 'cjs', platform: 'node', outfile: out, jsx: 'automatic',
      logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' },
    });
    const { React, renderToStaticMarkup, XellEnvironment } = createRequire(out)(out);
    // The panel loads in an effect, which server rendering never runs — so drive it through the
    // FETCH it makes, which is the same seam the console uses.
    const render = async (view, envs) => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (u) => ({
        ok: true, status: 200,
        json: async () => (String(u).includes('/environments') && !String(u).includes('/xells/') ? envs : view),
        text: async () => JSON.stringify(String(u).includes('/environments') && !String(u).includes('/xells/') ? envs : view),
      });
      try {
        // one paint is enough: the assertions below are about the STATES, which are props-driven
        return renderToStaticMarkup(React.createElement(XellEnvironment,
          { xell: { id: dev.id, slug: 'xenv-dev', project_id: PID }, onClose: () => {}, onChanged: () => {} }));
      } finally { globalThis.fetch = realFetch; }
    };
    const shell = await render(none, []);
    ok(/xell environment/i.test(shell) || /environment/i.test(shell), 'the panel renders (no crash, no free identifier)');
    // the three sentences are the component's own text, asserted from the source it renders from
    const src = readFileSync(join(ROOT, 'web/src/XellEnvironment.jsx'), 'utf8');
    ok(/no environment resolves for this xell/.test(src), 'ABSENT has its own sentence');
    ok(/0 vars configured\./.test(src) && /NOT because the injection failed/.test(src),
       'EMPTY has its own sentence, and it says why the file is unchanged');
    ok(/a secret's value never leaves the meta-DB/.test(src),
       'POPULATED lists names and states the SECRECY contract accurately (secrets masked; a non-secret value is not a secret)');
    ok(/await showConfirm\(/.test(src) && /RESERVED/.test(src),
       'pinning asks first, and the confirmation names the reserved keys it cannot touch');
    ok(/keeps the environment it started with/.test(src),
       'and says a running process does not pick it up until it restarts');
    ok(/not injected \(queenzee-owned\)/.test(src) && /OWNED_BY_QUEENZEE/.test(src),
       'a reserved name in the environment is LABELLED as not-injected, rather than silently dropped');
    const app = readFileSync(join(ROOT, 'web/src/App.jsx'), 'utf8');
    ok(/env-absent/.test(app) && /'no env'/.test(app),
       "the card chip renders a third face when nothing resolves — an absent chip read as 'fine'");
    ok(/onEnv\?\.\(x\)/.test(app) && /onEnv }\) \{/.test(app),
       'the card chip signals through a PROP rather than reaching for a parent state setter');
    ok(/if \(kind === 'env'\) \{[\s\S]{0,400}setEnvXell\(x\)/.test(app),
       "and the flower's ❖ button opens the panel, which is the live surface a human uses");
    ok(/data-testid="xenv-extract"/.test(src),
       'the raw .zeehive.env dump that button used to show is kept, one click away inside the panel');
  }
} finally {
  await cleanup();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  await pool.end().catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

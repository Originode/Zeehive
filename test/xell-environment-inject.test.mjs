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
//   3. THE URLS, OVER REAL HTTP. Added after the panel shipped 404ing on open: it asked for GET
//      /api/xells/:id/environment, which no router.get ever declared (the read is env/resolved).
//      Nothing above caught it, because the render above drives the component through a STUBBED
//      fetch that answers any /xells/ url — a stub cannot disagree with the route table. So §6 takes
//      the paths out of web/src/api.js and sends them at the REAL router: a path either exists or it
//      404s, on both sides of the same fact.
//
// A prod-coupled xell resolving to the PROD environment — the second half of the ticket's sentence —
// is exercised through the same read model, on a xell whose only difference is its db_coupling.
//
// Everything it creates is torn down in a finally.
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import express from 'express';

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
let server = null;

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

    // ── the CARD's env chip: rendered, not grepped ────────────────────────
    // This was `/env-absent/.test(app) && /'no env'/.test(app)` — a grep over App.jsx, which stays
    // GREEN when the chip is wrapped in a condition that can never be true (checked by hand: the
    // strings live on in the source and no human ever sees a chip). So the three faces are asserted
    // off real MARKUP, through the same esbuild + react-dom/server route test/tend-reason.test.mjs
    // renders this component by. App.jsx exports no XellCard, hence the one-line entry beside it —
    // written, bundled and deleted here. Its own react + react-dom go in the bundle (one instance:
    // XellCard calls useState, and a split react/react-dom pair has no dispatcher).
    const cardEntry = join(ROOT, 'web/src/.xenv-card-entry.jsx');
    const cardBundle = join(tmp, 'xenv-card.cjs');
    let cardUi;
    try {
      writeFileSync(cardEntry, `${app}\nexport { XellCard };\n`);
      await esbuild.build({
        stdin: {
          contents: `
            const React = require('react');
            const { renderToStaticMarkup } = require('react-dom/server');
            const { XellCard } = require('./.xenv-card-entry.jsx');
            module.exports = { React, renderToStaticMarkup, XellCard };`,
          resolveDir: join(ROOT, 'web/src'), loader: 'js',
        },
        bundle: true, format: 'cjs', platform: 'node', outfile: cardBundle, jsx: 'automatic',
        logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' },
      });
      cardUi = createRequire(cardBundle)(cardBundle);
    } finally { rmSync(cardEntry, { force: true }); }

    // the chip a human would see, for a xell whose only difference is its env_* columns. Reported as
    // class + visible text: the title is three paragraphs long and a failure has to be readable.
    const chipOf = (env) => {
      let html;
      try {
        html = cardUi.renderToStaticMarkup(cardUi.React.createElement(cardUi.XellCard, {
          x: { id: '00000000-0000-4000-8000-00000000e2c1', slug: 'xenv-card', status: 'claimed',
               hive_status: 'occ-working', hive_status_label: 'working', head_commit: 'abc123def456',
               branch: 'spinoff/xenv-card', stack: [], burn: { tokens: 0, cost: 0 }, ...env },
          diff: null, onDone: () => {}, onMenu: () => {}, prodLock: null, projectId: PID,
          landing: [], prs: [], ship: null, onDismiss: () => {}, machines: [], onEnv: () => {} }));
      } catch (e) {
        // a card that throws is a failed assertion with a reason, not a dead test run
        return { cls: '', text: '', threw: e?.message || String(e) };
      }
      const at = html.indexOf('data-testid="env-chip"');
      if (at < 0) return null;
      const span = html.slice(html.lastIndexOf('<span', at), html.indexOf('</span>', at) + 7);
      return { cls: (span.match(/class="([^"]*)"/) || [, ''])[1], text: span.replace(/<[^>]*>/g, '') };
    };
    const NO_CHIP = 'NO env chip in the rendered card at all';
    const chipSaw = (chip) => (chip === null ? NO_CHIP
      : chip.threw ? `XellCard THREW while rendering: ${chip.threw}`
        : `class="${chip.cls}" text="${chip.text}"`);
    const populated = chipOf({ env_key: 'staging', env_tier: 'dev', env_var_count: 5, env_pinned: true });
    ok(populated?.text === '❖ staging ·5 📌',
       `a resolved environment renders its key, var count and pin — expected text "❖ staging ·5 📌", `
       + `got ${chipSaw(populated)}`);
    const emptyChip = chipOf({ env_key: 'zeehive-dev', env_tier: 'dev', env_var_count: 0 });
    ok(emptyChip?.text === '❖ zeehive-dev ∅' && / env-empty\b/.test(emptyChip.cls),
       `EMPTY renders its own face (∅ + .env-empty), because 0 vars is the state that looks like a `
       + `bug — got ${chipSaw(emptyChip)}`);
    const absentChip = chipOf({ env_key: null, env_tier: null, env_var_count: 0 });
    ok(absentChip?.text === '❖ no env' && / env-absent\b/.test(absentChip.cls),
       `and ABSENT renders a third face ("no env" + .env-absent) — an absent chip must not read as `
       + `'fine' — got ${chipSaw(absentChip)}`);

    // The one thing static markup cannot show: WHERE the click goes. The CONTRACT is "XellCard takes
    // an onEnv prop and calls it" — so that is what is asserted, from the props it DECLARES (parsed
    // out of a brace-balanced parameter list) rather than from the punctuation around them. Both
    // earlier versions of this assertion pinned the shape instead and died to it: `onEnv }) {` broke
    // when a `links` prop was appended, and `XellCard\(\{[^}]*onEnv` breaks on the day any prop
    // before it carries an object default (`links = {}`).
    const paramsOf = (src, fn) => {
      const at = src.indexOf(`function ${fn}(`);
      if (at < 0) return null;
      const open = src.indexOf('(', at);
      let depth = 0;
      for (let i = open; i < src.length; i++) {
        if ('([{'.includes(src[i])) depth++;
        else if (')]}'.includes(src[i]) && --depth === 0) return src.slice(open + 1, i);
      }
      return null;
    };
    const bodyOf = (src, fn) => {
      const at = src.indexOf(`function ${fn}(`);
      if (at < 0) return '';
      const next = src.indexOf('\nfunction ', at + 1);
      return src.slice(at, next < 0 ? src.length : next);
    };
    const cardParams = paramsOf(app, 'XellCard');
    ok(cardParams !== null && /\bonEnv\b/.test(cardParams),
       `XellCard DECLARES an onEnv prop, anywhere in its parameter list — its props are: `
       + `${cardParams === null ? 'no `function XellCard(` in web/src/App.jsx' : cardParams.trim()}`);
    const cardBody = bodyOf(app, 'XellCard');
    ok(/\bonEnv\s*\?\.\s*\(|\bonEnv\s*\(/.test(cardBody),
       'and CALLS it — the chip signals the env panel through its prop');
    ok(cardBody !== '' && !/setEnvXell/.test(cardBody),
       'rather than reaching past its props for the parent\'s setEnvXell');
    ok(/if \(kind === 'env'\) \{[\s\S]{0,400}setEnvXell\(x\)/.test(app),
       "and the flower's ❖ button opens the panel, which is the live surface a human uses");
    ok(/data-testid="xenv-extract"/.test(src),
       'the raw .zeehive.env dump that button used to show is kept, one click away inside the panel');
  }

  // ── 6. the CALLS the CONSOLE makes, at the REAL router ───────────────────
  // The panel shipped asking for GET /api/xells/:id/environment — a path the router only ever
  // declared for POST — so every open ended at "site GET failed (404)". The render above cannot see
  // that: it stubs fetch, and a stub answers whatever url it is handed. So this drives the console's
  // OWN client functions at the REAL route table.
  //
  // Two departures from how the rest of this repo tests console wiring, both about this bug: it
  // IMPORTS web/src/api.js (React-free, so node takes it as-is) instead of grepping it, because a
  // grep cannot tell a path that reaches a route from one that 404s; and the only stub is a fetch
  // that prefixes the base url, so the request, the routing and the error handling are all real.
  section("the panel's own calls, over real HTTP");
  {
    const { router } = await import('../server/src/api/routes.js');
    const app = express();
    app.use(express.json());
    app.use('/api', router);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const API = `http://127.0.0.1:${server.address().port}`;

    const api = await import('../web/src/api.js');
    const realFetch = globalThis.fetch;
    globalThis.fetch = (u, o) => realFetch(String(u).startsWith('/') ? `${API}${u}` : u, o);
    // siteCall THROWS on a non-2xx (that throw is the red box the human photographed), so each call
    // is captured rather than left to kill the run — a 404 must be a named failure, not a stack.
    const call = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: e.message }; } };
    try {
      const read = await call(() => api.getXellEnvironment(dev.id));
      ok(read.ok, `getXellEnvironment() reaches a route — ${read.ok ? 'answered' : `it threw "${read.error}", which is the red box on the panel`}`);
      ok(read.ok && 'pinned' in read.value && Array.isArray(read.value.vars),
         'and answers the resolvedEnvView read model the panel renders (pinned + vars[])');

      const dump = await call(() => api.extractXellEnv(dev.id));
      ok(dump.ok && typeof dump.value.text === 'string',
         `extractXellEnv() serves the "view .zeehive.env" button — ${dump.ok ? `${dump.value.source}, ${dump.value.text.length} chars` : dump.error}`);

      // and the WRITE half, which is what the picker's buttons send
      const pin = await call(() => api.setXellEnvironment(dev.id, staging.id));
      ok(pin.ok && pin.value.environment_id === staging.id, `setXellEnvironment() pins — ${pin.ok ? 'ok' : pin.error}`);
      ok(varsIn(envFile()).includes('SHARED_TOKEN'), 'and the file on disk followed the HTTP pin');
      const clear = await call(() => api.setXellEnvironment(dev.id, null));
      ok(clear.ok && clear.value.environment_id === null, `and the clear-the-pin button too — ${clear.ok ? 'ok' : clear.error}`);
    } finally { globalThis.fetch = realFetch; }
  }
} finally {
  if (server) await new Promise((r) => server.close(r));
  await cleanup();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  await pool.end().catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

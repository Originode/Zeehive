// THE SHIP CARD MUST NAME EVERY MIGRATION THE DEPLOY WILL APPLY — ticket #12.
//
// `ship_request.migrations` only ever held the DEPLOY-TIME set (server/sql/migrations|ops, applied
// by the queenzee before the containers build). Zeehive migrates ITSELF: runMigrations() applies
// db/migrations/*.sql to the live meta-DB as the new server boots. Nothing joined those two facts,
// so every Zeehive ship card said "no migrations" — and one deploy applied five, including the one
// that repaired live data loss and two that rewrote the manual every zee reads.
//
// That is a GATE bug, not a display bug: the ship gate exists so a human decides what reaches
// production, and a card that understates schema change makes the gate less informative than the
// human believes. Same class as the harness that rendered healthy while carrying nothing.
//
// So this proves it against a REAL ship request through the REAL requestShip — not by reading the
// code and asserting it would work:
//   1. a throwaway project whose repo carries BOTH migration sets, and whose prod db row points at
//      THIS xell's own postgres (the self-hosting shape: the prod database IS the meta-DB the
//      queenzee is connected to, which is why the boot ledger can be read over the pool);
//   2. requestShip() → the row records the boot set, with the file that is NOT in schema_migrations
//      and without the ones that are;
//   3. an unreadable ledger becomes ok:false → the card must say UNKNOWN, never "none";
//   4. a project with no boot-applied schema is unaffected (applicable:false, nothing to render);
//   5. the console renders both sets, and says which runs WHEN;
//   6. the confirmations say a ship deploys the current TIP of main, not the requester's work.
// Everything it creates is torn down in a finally.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.env.SHIP_MODE = 'simulate';
process.env.SHIP_REAPER_ENABLED = 'false';
process.env.LANDING_PAD_ENABLED = 'false';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { config } = await import('../server/src/config.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

const tmp = mkdtempSync(join(tmpdir(), 'shipboot-'));
const PID = '00000000-0000-4000-8000-00000000b111';
const IDS = { xource: '00000000-0000-4000-8000-00000000b222', site: '00000000-0000-4000-8000-00000000b333' };
const compiled = [];

async function cleanup() {
  await q(`DELETE FROM project WHERE id=$1`, [PID]).catch(() => {});
}

try {
  await cleanup();

  // ── a repo shaped like a self-migrating project ────────────────────────────────────────────
  // db/migrations: two files that THIS database has already applied (they are real filenames from
  // its own schema_migrations) and one it has not — so "pending" is a fact about the live ledger,
  // not an assumption.
  const appliedNames = (await q(`SELECT filename FROM schema_migrations ORDER BY filename LIMIT 2`)).map((r) => r.filename);
  if (appliedNames.length < 2) throw new Error('this database has no schema_migrations rows — run npm run db:migrate first');
  const futureName = '999_zt_not_yet_applied.sql';

  const repo = join(tmp, 'repo');
  mkdirSync(join(repo, 'db', 'migrations'), { recursive: true });
  mkdirSync(join(repo, 'server', 'sql', 'migrations'), { recursive: true });
  mkdirSync(join(repo, 'server', 'src', 'db'), { recursive: true });
  for (const f of [...appliedNames, futureName]) writeFileSync(join(repo, 'db', 'migrations', f), '-- fixture\n');
  writeFileSync(join(repo, 'server', 'sql', 'migrations', '001_deploy_time.sql'), '-- fixture\n');
  // the boot runner, so the SHAPE detection (not the project's name) recognises a self-migrator
  writeFileSync(join(repo, 'server', 'src', 'db', 'migrate.js'), 'export async function runMigrations() {}\n');
  writeFileSync(join(repo, 'server', 'src', 'index.js'), 'await runMigrations();\n');
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
  const head = git(repo, 'rev-parse', 'HEAD');
  const wt = join(tmp, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'spinoff/shipboot', wt, 'master');

  await q(`INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
             VALUES ($1,'shipboot-test',$2,'master','zeehive','zeehive')`, [PID, repo]);
  await q(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [IDS.xource, PID]);
  await q(`INSERT INTO deploy_site (id, project_id, key, tier, is_default) VALUES ($1,$2,'local','prod',true)`,
    [IDS.site, PID]);
  // The prod DB row points at THIS xell's own database — the self-hosting shape, where the prod
  // database IS the one the queenzee is connected to. That is what makes the ledger readable here.
  const dbc = await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, conn_ref, site_id, health)
       VALUES ($1,'db','prod','shared','shipboot-db','default',$2,$3,'up') RETURNING id`,
    [PID, config.databaseUrl, IDS.site]);
  const xell = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled)
       VALUES ($1,$2,'shipboot-a','spinoff/shipboot',$3,'idle',false) RETURNING *`, [PID, IDS.xource, wt]);

  const M = await import('../server/src/queenzee/shipmigrate.js');
  const { requestShip } = await import('../server/src/queenzee/shipgate.js');

  console.log('\n── the shape, not the name, says this project migrates itself ──');
  ok(M.bootMigrationDir({ repo_root: repo }, head) === 'db/migrations',
     'a repo with db/migrations/*.sql AND a boot runner that calls runMigrations() is self-migrating');
  const plain = join(tmp, 'plain');
  mkdirSync(plain); git(plain, 'init', '-q', '-b', 'master');
  git(plain, 'config', 'user.email', 't@t'); git(plain, 'config', 'user.name', 't');
  writeFileSync(join(plain, 'README'), 'x\n'); git(plain, 'add', '-A'); git(plain, 'commit', '-qm', 'x');
  ok(M.bootMigrationDir({ repo_root: plain }, git(plain, 'rev-parse', 'HEAD')) === null,
     'a normal project has no boot-applied schema at all');
  ok(M.isOwnDatabase(config.databaseUrl) === true, 'the prod db row that names OUR database is recognised');
  ok(M.isOwnDatabase('postgresql://x@somewhere-else:5432/other') === false, 'and a different one is not');

  console.log('\n── a REAL ship request records what the deploy will actually apply ──');
  const r = await requestShip({ xellId: xell.id, reason: 'ticket #12 proof' });
  ok(r.ok === true && r.request, `requestShip raised a real request (${r.request?.id?.slice(0, 8) || r.reason})`);
  const req = r.request;
  const boot = typeof req.boot_migrations === 'string' ? JSON.parse(req.boot_migrations) : req.boot_migrations;
  ok(!!boot && boot.applicable === true, 'the row carries a BOOT migration set');
  ok(boot.ok === true && boot.via === 'own-pool', `read from the live ledger (${boot.via}, ${boot.applied} applied)`);
  ok(boot.pending.length === 1 && boot.pending[0].endsWith(futureName),
     `it names exactly the file the live ledger has NOT applied (${boot.pending.join(', ')})`);
  for (const f of appliedNames) {
    ok(!boot.pending.some((p) => p.endsWith(f)), `and not ${f}, which the ledger says is already applied`);
  }
  const deploy = Array.isArray(req.migrations) ? req.migrations : JSON.parse(req.migrations || '[]');
  ok(deploy.some((f) => f.includes('server/sql/migrations/001_deploy_time.sql')) || deploy.length === 0,
     `the deploy-time set is unchanged in shape (${deploy.length} file(s) — it needs a reachable prod db to resolve)`);
  ok(boot.dir === 'db/migrations', 'and the card can say WHERE the boot set comes from');

  console.log('\n── an unreadable ledger is UNKNOWN, never "none" ──');
  await q(`UPDATE container SET conn_ref=$2 WHERE id=$1`, [dbc.id, 'postgresql://nobody@10.255.255.1:5432/nothing']);
  const bad = await M.pendingBootMigrations({ ...(await one(`SELECT * FROM project WHERE id=$1`, [PID])) }, head,
    await one(`SELECT * FROM deploy_site WHERE id=$1`, [IDS.site]));
  ok(bad.applicable === true && bad.ok === false, 'a ledger it cannot read comes back ok:false, not an empty list');
  ok(!!bad.error, `with the reason on the row: "${String(bad.error).slice(0, 60)}…"`);
  ok(bad.pending.length === 3, 'and every file at the sha is listed as possibly-pending, not zero');
  await q(`UPDATE container SET conn_ref=$2 WHERE id=$1`, [dbc.id, config.databaseUrl]);

  console.log('\n── the console CARD renders both sets, and says which runs when ──');
  // Ship.jsx imports Dialog.jsx and api.js, so it is BUNDLED (like test/work-console.test.mjs)
  // rather than transformed — the point is to render the REAL component, not a copy of it.
  const esbuild = await import('esbuild');
  const out = join(tmp, 'ship-bundle.cjs');
  await esbuild.build({
    stdin: { contents: "module.exports = require('./Ship.jsx');", resolveDir: join(ROOT, 'web/src'), loader: 'js' },
    bundle: true, format: 'cjs', platform: 'node', outfile: out, jsx: 'automatic',
    logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' },
  });
  const { createRequire } = await import('node:module');
  const S = createRequire(out)(out);
  const html = (rq) => renderToStaticMarkup(React.createElement(S.ShipSchema, { req: rq }));
  const both = html({ migrations: ['server/sql/migrations/001_deploy_time.sql'], boot_migrations: boot });
  ok(/at deploy:/.test(both) && /at boot:/.test(both), 'the card shows BOTH sets, separately');
  ok(both.includes(futureName), 'naming the boot file that will actually run');
  ok(/before the containers build/.test(both) && /when it restarts/.test(both),
     'and says WHEN each one runs — the two have different risk, so the card must not merge them');
  const unknown = html({ migrations: [], boot_migrations: { ...boot, ok: false, error: 'connection refused' } });
  ok(/UNKNOWN/.test(unknown) && /could not read the boot ledger/.test(unknown),
     'an unreadable ledger renders as UNKNOWN with the reason, never as "none"');
  ok(!/at boot:<\/span> <span class="ship-schema-none">none/.test(unknown), 'and never silently as none');
  const normal = html({ migrations: [], boot_migrations: { applicable: false, ok: true, pending: [] } });
  ok(/no migrations ride this ship/.test(normal) && !/at boot/.test(normal),
     'a project with no boot schema is unchanged — one honest line, no phantom section');
  const old = html({ migrations: ['server/sql/migrations/001.sql'] });
  ok(/at deploy:/.test(old) && !/at boot/.test(old), 'and a row from BEFORE this existed still renders (boot_migrations null)');

  console.log('\n── the confirmations stop implying a ship carries only the requester\'s work ──');
  ok(/UNKNOWN number at boot/.test(S.schemaConfirmLine({ migrations: [], boot_migrations: { applicable: true, ok: false, dir: 'db/migrations' } })),
     'the approve confirmation carries the same UNKNOWN honesty as the card');
  ok(/1 migration\(s\) at deploy time; 1 at boot/.test(
    S.schemaConfirmLine({ migrations: ['a.sql'], boot_migrations: { applicable: true, ok: true, dir: 'db/migrations', pending: ['b.sql'] } })),
     'and both counts when both are known');
  const shipSrc = readFileSync(join(ROOT, 'web/src/Ship.jsx'), 'utf8');
  ok(/CURRENT TIP of main/.test(shipSrc), 'the approve confirmation says it deploys the current TIP of main');
  ok(/not only \$\{req\.xell_slug\}'s work/.test(shipSrc), 'and names whose work it is NOT limited to');
  const appSrc = readFileSync(join(ROOT, 'web/src/App.jsx'), 'utf8');
  ok(/FLEET-WIDE/.test(appSrc) && /CURRENT TIP of main/.test(appSrc), 'the REQUEST confirmation says the same thing');
  const selfSrc = readFileSync(join(ROOT, 'server/src/queenzee/self.js'), 'utf8');
  ok(/CURRENT TIP of main/.test(selfSrc) && /not only your commits/.test(selfSrc),
     'and so does the answer a zee gets, so it cannot report "my work shipped"');
  ok(/Schema riding with it/.test(selfSrc), 'which also tells the zee what schema rides along');
} finally {
  for (const f of compiled) { try { rmSync(f, { force: true }); } catch { /* */ } }
  await cleanup();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  await pool.end().catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

// `zee db-sandbox` — a REAL throwaway postgres inside the cage (ticket #62).
//
// WHY THE VERB EXISTS. The DATABASE_URL the queenzee writes into a xell's .zeehive.env is refused by
// the shared dev db (ticket #47). On one night three zees INDEPENDENTLY invented the same
// workaround — `npm i embedded-postgres` in /tmp, a real PostgreSQL on 127.0.0.1, `npm run
// db:migrate`, tests pointed at it — and two more never found it, ran three hours and verified
// nothing. `zee db-sandbox` is that workaround as a verb, so nobody has to discover it again.
//
// WHAT THIS FILE ASSERTS, and why each part is here:
//
//  1. **The behaviour, for real.** It starts an actual postgres, connects to it with `pg`, runs the
//     repo's own migrations into it, starts a SECOND time (which must return the SAME DSN rather
//     than a second server), reads --status, and stops — twice, because a cleanup that runs after a
//     failed test stops something that is already stopped. Asserting the printed JSON alone would
//     assert what was written, not what runs.
//  2. **It cannot reach a fleet database.** This is the constraint the whole verb is only safe
//     under: the host is a literal 127.0.0.1, the port is bound on the loopback, and postgres is
//     started with `-h 127.0.0.1`. Checked as text in scripts/zee AND observed on the running
//     server's own `listen_addresses`.
//  3. **It never substitutes for the assigned DATABASE_URL.** The hard rule from the ticket: a
//     broken assigned db must stay VISIBLE (#47's bug, #53's readiness preflight), so the verb may
//     not read DATABASE_URL, may not write .zeehive.env, and may set DATABASE_URL only on the child
//     process `--migrate` explicitly asks for. A silent fallback would delete the only signal
//     anyone has.
//
// No queenzee, no docker, no network beyond the npm install the first start does. It needs no
// DATABASE_URL of its own — the point of the verb is that it brings one.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// §1b probes a port directly: whether a sandbox is alive is a question about the PORT, and the test
// asks it the same way the verb does rather than trusting the verb's own answer.
import net from 'node:net';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'zee');
const cli = readFileSync(CLI, 'utf8');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// The sandbox lives in a temp HOME so this test can never disturb the one the zee running it is
// using — `zee db-sandbox` keeps exactly one per home directory, which is the point of it.
const HOME = mkdtempSync(join(tmpdir(), 'db-sandbox-test-'));
const run = (...args) => {
  const r = spawnSync(process.execPath, [CLI, 'db-sandbox', ...args], {
    encoding: 'utf8', timeout: 10 * 60 * 1000,
    // No ZEEHIVE_XELL_TOKEN: the verb calls no API, so it must work without one.
    env: { ...process.env, ZEE_DB_SANDBOX_HOME: HOME, ZEEHIVE_XELL_TOKEN: '' },
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* the assertion below reports it */ }
  return { ...r, json };
};

try {
  // ── 1. the behaviour ────────────────────────────────────────────────────────────────────────
  console.log('\n── start · migrate · use · start again · status · stop ──');
  const before = run('--status');
  ok(before.status === 0 && before.json?.running === false,
     'before anything: --status says nothing is running, and exits 0 (a question, not an error)');
  ok(before.json?.dsn === null, 'and offers no DSN for a server that does not exist');

  const t0 = Date.now();
  const start = run('--migrate');
  const secs = Math.round((Date.now() - t0) / 1000);
  ok(start.status === 0 && start.json?.ok === true,
     `--migrate starts postgres and applies db/migrations (${secs}s, cold: it installs the binaries)`);
  const dsn = start.json?.dsn || '';
  ok(/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/postgres$/.test(dsn), `and prints a loopback DSN (${dsn})`);
  ok(start.json?.migrated === true, 'the migrations are reported applied');
  ok(start.json?.already === false, 'and it says this was a fresh start, not an existing one');

  // The DSN has to be usable by the thing a zee will actually point at it. A failed connect is
  // reported as a FAILED ASSERTION rather than thrown: the checks after it are the ones that say
  // WHY (a DSN pointing off-box, a server listening somewhere it should not), and a stack trace
  // here would hide every one of them.
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: dsn });
  let connectErr = null;
  try { await client.connect(); } catch (e) { connectErr = e; }
  ok(!connectErr, `the DSN it printed actually connects${connectErr ? ` — ${connectErr.message}` : ''}`);
  if (!connectErr) {
    const applied = (await client.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n;
    ok(applied > 100, `the repo's own migrations really are in there (${applied} rows in schema_migrations)`);
    const listen = (await client.query('SHOW listen_addresses')).rows[0].listen_addresses;
    ok(listen === '127.0.0.1',
       `the RUNNING server listens on the loopback only (listen_addresses=${listen}) — no fleet db is reachable, `
       + 'and neither is this one from outside the container');
    const port = (await client.query('SHOW port')).rows[0].port;
    ok(String(port) === String(start.json?.port), `and on the port the verb reported (${port})`);
    // A sandbox is a database of your OWN: it must not be a copy of anybody's data.
    const xells = (await client.query('SELECT count(*)::int AS n FROM xell')).rows[0].n;
    ok(xells === 0, 'the schema is there and the data is not — an empty database, not a clone of a live one');
  }
  await client.end().catch(() => {});

  const second = run();
  ok(second.status === 0 && second.json?.already === true,
     'a SECOND start is not refused — it returns the sandbox already running');
  ok(second.json?.dsn === dsn, 'and it is the SAME DSN, so nobody ends up with two servers and one state file');

  const status = run('--status');
  ok(status.json?.running === true && status.json?.dsn === dsn, '--status now reports it running, on that DSN');
  ok(status.json?.package === start.json?.package,
     `--status names the pinned postgres package (${status.json?.package})`);

  const stop = run('--stop');
  ok(stop.status === 0 && stop.json?.stopped === true && stop.json?.running === false, '--stop stops it');
  const afterStop = run('--status');
  ok(afterStop.json?.running === false && afterStop.json?.dsn === null,
     'and --status agrees afterwards (the state file is gone, not just the process)');
  const dead = new pg.Client({ connectionString: dsn });
  let refused = null;
  try { await dead.connect(); } catch (e) { refused = e; }
  ok(!!refused, `and the port really is dead (${refused?.code || 'connected — it is NOT stopped'})`);
  await dead.end().catch(() => {});

  const stopAgain = run('--stop');
  ok(stopAgain.status === 0 && stopAgain.json?.ok === true && stopAgain.json?.stopped === false,
     'stopping a stopped sandbox is a no-op that exits 0 — a cleanup runs after a failure too');
  ok(existsSync(join(HOME, 'data', 'PG_VERSION')),
     'the data dir survives a stop, so a later start reuses the schema you already migrated');

  // ── 1b. a sandbox that DIED rather than being stopped ───────────────────────────────────────
  // PID 1 in a cxell is `sleep infinity`, and it reaps nothing: a postgres that crashes leaves a
  // ZOMBIE, `kill(pid, 0)` keeps succeeding on it, and `pg_ctl status` therefore keeps answering
  // "server is running" for the rest of the container's life. Measured in a cage before this was
  // handled: --status reported a healthy sandbox whose port refused every connection, a second start
  // handed that dead DSN straight back, and postgres then refused to start at all ("lock file
  // postmaster.pid already exists") until somebody knew to delete the file. That is the invisible
  // broken database this verb exists to abolish, one layer in — so the PORT is the authority here,
  // never the pid.
  console.log('\n── a sandbox that CRASHED is reported dead, and the next start recovers it ──');
  const revived = run();
  ok(revived.status === 0 && revived.json?.running === true, 'a sandbox is up again to be killed');
  const lockPid = Number(readFileSync(join(HOME, 'data', 'postmaster.pid'), 'utf8').split('\n')[0]);
  ok(Number.isFinite(lockPid) && lockPid > 0, `postgres wrote its lock file (postmaster pid ${lockPid})`);
  process.kill(lockPid, 'SIGKILL');
  // The PRECONDITION of everything below is that the server is really gone, so it is waited for and
  // asserted here rather than assumed: a fixed sleep would make this read as intermittency later.
  const portDead = async (port) => new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.on('connect', () => { s.destroy(); res(false); });
    s.on('error', () => res(true));
    s.setTimeout(1000, () => { s.destroy(); res(false); });
  });
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) {
    gone = await portDead(revived.json.port);
    if (!gone) await new Promise((r) => setTimeout(r, 250));
  }
  ok(gone, 'the killed postmaster stopped accepting on its port (the precondition for the rest)');

  const crashed = run('--status');
  ok(crashed.json?.running === false,
     '--status says it is NOT running — a zombie pid does not count as a database');
  ok(crashed.json?.dsn === null, 'and it offers no DSN for a server that answers nothing');
  const recovered = run();
  ok(recovered.status === 0 && recovered.json?.ok === true,
     'the next start SUCCEEDS — a crashed sandbox is not a cage-long dead end');
  ok(recovered.json?.already === false, 'and it is a real start, not the dead one handed back');
  ok(recovered.json?.dsn && recovered.json.dsn !== revived.json?.dsn,
     `on a port of its own (${revived.json?.dsn} → ${recovered.json?.dsn})`);
  const afterCrash = new pg.Client({ connectionString: recovered.json?.dsn || 'postgresql://127.0.0.1:1/x' });
  let afterCrashErr = null;
  try { await afterCrash.connect(); } catch (e) { afterCrashErr = e; }
  ok(!afterCrashErr, `and it really accepts connections${afterCrashErr ? ` — ${afterCrashErr.message}` : ''}`);
  await afterCrash.end().catch(() => {});
  run('--stop');

  // ── 2 & 3. the constraints, in the source ───────────────────────────────────────────────────
  // These are read off scripts/zee because they are about what the verb CANNOT do, and the honest
  // test for "it never does X" is that the code has no way to.
  console.log('\n── it can only ever be a LOCAL database, and never a replacement for the assigned one ──');
  const verb = cli.slice(cli.indexOf('// ── zee db-sandbox:'), cli.indexOf('function usage()'));
  // The comments are checked as PROSE and the rest as CODE, separately: a comment saying ".zeehive.env
  // is never written" would otherwise satisfy — or fail — a check about whether anything writes it.
  const code = verb.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok(verb.length > 500 && code.length > 500, 'the db-sandbox implementation was located in scripts/zee');
  ok(/const sandboxDsn = \(port\) => `postgresql:\/\/postgres@127\.0\.0\.1:\$\{port\}\/postgres`;/.test(code),
     'the DSN host is the literal 127.0.0.1 — it is not built from a variable anything could set');
  ok(/-h 127\.0\.0\.1/.test(code), 'and postgres is started with `-h 127.0.0.1` (listen_addresses)');
  ok(/listen\(\{ host: '127\.0\.0\.1', port: 0 \}/.test(code), 'the port is bound on the loopback to find a free one');
  const hosts = [...code.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)].map((m) => m[0]);
  ok(hosts.length > 0 && hosts.every((h) => h === '127.0.0.1'),
     `no other IP appears anywhere in the verb's code (${[...new Set(hosts)].join(', ')})`);
  ok(!/process\.env\.DATABASE_URL/.test(code),
     'it never READS DATABASE_URL — it cannot connect to the assigned db, correctly or by accident');
  const writes = [...code.matchAll(/(?:write|append)FileSync\(([^,]+)/g)].map((m) => m[1].trim());
  ok(writes.length > 0 && writes.every((w) => w === 'SANDBOX_DIRS.state'),
     `the only file it writes is its own state file (${writes.join(', ')}) — never .zeehive.env, which is generated`);
  ok(!/zeehive\.env/.test(code), 'and .zeehive.env is not so much as named in the code');
  const dbUrlWrites = [...code.matchAll(/DATABASE_URL:/g)].length;
  ok(dbUrlWrites === 1, `DATABASE_URL is set in exactly ONE place (${dbUrlWrites})`);
  const migrateCall = code.slice(code.indexOf('if (migrate) {'), code.indexOf('console.log(JSON.stringify({ ok: migrated'));
  ok(/DATABASE_URL: dsn/.test(migrateCall) && /spawnSync\('npm', \['run', 'db:migrate'\]/.test(migrateCall),
     'and that place is the env of the `npm run db:migrate` CHILD that --migrate explicitly asks for');
  // The rule the ticket is emphatic about: a broken assigned db must stay VISIBLE.
  ok(/never (a |consulted as a )?fallback/i.test(verb),
     'the source says out loud that it is not a fallback for an unreachable assigned db');
  // ── 4. the spawn-prep preset warms exactly what the verb installs ───────────────────────────
  // A warm that installs a DIFFERENT package, or into a different directory, is worse than no warm:
  // the spawn pays for the download and the first `zee db-sandbox` pays for it again. The two live
  // in different files (a CLI baked into the cage, a preset read by the console), so the only thing
  // keeping them equal is this assertion.
  console.log('\n── the spawn-prep preset warms exactly what the verb installs ──');
  const { STEP_PRESETS, DEFAULT_STEPS, normalizeSpawnPrep, prepUserScript, prepRootScript } =
    await import('../server/src/lib/spawn-prep.js');
  const preset = STEP_PRESETS.find((p) => p.key === 'db-sandbox');
  ok(!!preset, 'the console offers a "warm zee db-sandbox" step');
  const pkg = cli.match(/const SANDBOX_PKG = '([^']+)'/)?.[1];
  ok(!!pkg && preset?.run?.includes(pkg),
     `the preset installs the SAME pinned package the CLI resolves (${pkg})`);
  const depsExpr = cli.match(/deps: join\(SANDBOX_HOME, '([^']+)'\)/)?.[1];
  ok(preset?.run?.includes(`$HOME/.zeehive/db-sandbox/${depsExpr}`),
     `and into the SAME prefix the CLI looks in ($HOME/.zeehive/db-sandbox/${depsExpr})`);
  ok(preset?.kind === 'shell' && preset?.allow_failure === true,
     'it is a best-effort shell step — a mirror being down may never fail a dispatch (spawn-prep rule 1)');
  ok(!DEFAULT_STEPS.some((s) => s.key === 'db-sandbox'),
     'and it is NOT in the default template — a project whose zees never touch a database pays nothing');
  const prep = normalizeSpawnPrep({ steps: [...DEFAULT_STEPS, preset] });
  ok(prep.steps.some((s) => s.key === 'db-sandbox'), 'it normalizes (the "add" menu cannot offer a step the server refuses)');
  ok(prepUserScript(prep).includes(preset.run) && prepRootScript(prep) === null,
     'and it runs in the USER half — npm as `zee`, so nothing it writes is root-owned');

  const help = spawnSync(process.execPath, [CLI, 'help'], { encoding: 'utf8' }).stdout;
  ok(/zee db-sandbox \[--migrate\] \[--status\] \[--stop\]/.test(help), 'the verb is advertised in `zee help`');
  ok(/NEVER replaces your assigned DATABASE_URL/i.test(help),
     'and the usage line says so too — the one line a zee is most likely to read');
} finally {
  // Whatever happened above, do not leave a postgres running.
  run('--stop');
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* the temp dir is throwaway */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

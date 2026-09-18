// `zee prod-logs` — the read-only production log door (server/src/lib/prod-logs.js +
// docker.js containerLogTail).
//
// The thing under test is a WALL as much as a feature, so most of what is asserted here is what
// this door CANNOT do:
//   • it dials a FAKE docker daemon (a node:http server on loopback, reached as the 'default'
//     context via DOCKER_HOST) and asserts every request it ever makes is a GET of an inspect or a
//     log — no /exec, no /attach, no POST, no start/stop, follow=0 always;
//   • against a real (sandbox) meta-DB it asserts the prod `db` container is invisible and
//     unnameable, and that another project's prod containers are invisible to this project's xell;
//   • PRODLOGS_MODE=simulate dials NOTHING (a nested queenzee runs on a CLONE of the real meta-DB,
//     so its container rows are the REAL fleet's);
//   • credential-shaped values are masked before any line leaves the queenzee.
//
//   DATABASE_URL=... node test/prod-logs.test.mjs
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// ── a fake docker daemon, so the docker half is exercised for real without a real daemon ────────
// It records every request it is asked for: the assertion "this never execs" has to be made
// against what went ON THE WIRE, not against a reading of the source.
const seen = [];
let logBody = () => Buffer.alloc(0);
let tty = false;
// The daemon only knows the containers it was told about — asking for one it does not have must
// behave like a real daemon (404), because "could not ask" and "the log is empty" must never look
// the same to a reader.
const known = new Set();
const nameOf = (u) => decodeURIComponent(/^\/containers\/([^/?]+)/.exec(u)?.[1] || '');
const daemon = createServer((req, res) => {
  seen.push(`${req.method} ${req.url}`);
  if (!known.has(nameOf(req.url))) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ message: `No such container: ${nameOf(req.url)}` }));
  }
  if (/^\/containers\/[^/]+\/json$/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ Config: { Tty: tty }, State: { Status: 'running' } }));
  }
  if (/^\/containers\/[^/]+\/logs/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    return res.end(logBody(req.url));
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'no such endpoint on this fake daemon' }));
});
await new Promise((r) => daemon.listen(0, '127.0.0.1', r));
const port = daemon.address().port;
process.env.DOCKER_HOST = `tcp://127.0.0.1:${port}`;
// A CXELL's own .zeehive.env carries SHIP_MODE=simulate (it is a nested, caged queenzee), and
// PRODLOGS_MODE inherits SHIP_MODE — which is the point, and is asserted at the end of this file.
// The real-path sections need the real path, so say so explicitly BEFORE prod-logs.js is imported.
process.env.PRODLOGS_MODE = 'real';

const frame = (stream, text) => {
  const payload = Buffer.from(text, 'utf8');
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, payload]);
};

const { q, one, pool } = await import('../server/src/db/pool.js');
const { containerLogTail } = await import('../server/src/lib/docker.js');
const { demuxDockerStream } = await import('../server/src/lib/container-fs.js');
const prodLogs = await import('../server/src/lib/prod-logs.js');
const { redactLogLine, sinceToUnix, clampTail, formatLogLines, prodLogSources, prodLogTail,
        LOGGABLE_ROLES, MAX_TAIL, DEFAULT_TAIL, MAX_LINE_CHARS } = prodLogs;
const { selfProdLogs } = await import('../server/src/queenzee/self.js');

const tag = randomUUID().slice(0, 8);
const root = mkdtempSync(join(tmpdir(), `prodlogs-${tag}-`));
let pid = null, otherPid = null, xellId = null;

try {
  // ── 1. redaction: a log line is the likeliest place in the fleet to find a printed secret ─────
  console.log('\nredactLogLine');
  const cases = [
    ['DATABASE_URL=postgres://zeehive:hunter2@10.1.0.15:5432/db', 'hunter2'],
    ['authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk', 'eyJhbGci'],
    ['login failed password=s3cr3tpw for user bob', 's3cr3tpw'],
    ['token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', 'ghp_ABCDEFGHIJ'],
    ['calling openai with sk-proj-ABCDEFGHIJKLMNOPQRST', 'sk-proj-ABCDEFGH'],
    ['aws key AKIAIOSFODNN7EXAMPLE in env', 'AKIAIOSFODNN7'],
  ];
  for (const [line, secret] of cases) {
    const r = redactLogLine(line);
    ok(r.redacted && !r.line.includes(secret), `masked: ${line.slice(0, 40)}… → ${r.line.slice(0, 48)}`);
  }
  const keeps = redactLogLine('DATABASE_URL=postgres://zeehive:hunter2@10.1.0.15:5432/db');
  ok(keeps.line.includes('zeehive') && keeps.line.includes('10.1.0.15'),
    'a masked DSN stays readable (user and host survive, only the password goes)');
  const plain = redactLogLine('GET /api/fleet 200 in 31ms');
  ok(!plain.redacted && plain.line === 'GET /api/fleet 200 in 31ms', 'an ordinary line is untouched');

  // ── 2. bounds ─────────────────────────────────────────────────────────────────────────────────
  console.log('\nclampTail / sinceToUnix');
  ok(clampTail(50) === 50, 'clampTail keeps a sane count');
  ok(clampTail(999999) === MAX_TAIL, `clampTail ceils at ${MAX_TAIL} (no unbounded read of prod)`);
  ok(clampTail('nonsense') === DEFAULT_TAIL && clampTail(0) === DEFAULT_TAIL && clampTail(-5) === DEFAULT_TAIL,
    'clampTail defaults for junk/zero/negative');
  const now = 1_700_000_000_000;
  ok(sinceToUnix('30m', now) === 1_700_000_000 - 1800, '"30m" is 30 minutes ago');
  ok(sinceToUnix('2h', now) === 1_700_000_000 - 7200, '"2h" is 2 hours ago');
  ok(sinceToUnix('1d', now) === 1_700_000_000 - 86400, '"1d" is a day ago');
  ok(sinceToUnix('900', now) === 1_700_000_000 - 900, 'a bare number is seconds ago');
  ok(sinceToUnix('2026-01-01T00:00:00Z', now) === 1_767_225_600, 'an ISO timestamp parses');
  ok(sinceToUnix('', now) === null && sinceToUnix('later please', now) === null,
    'an unparseable window is NO window, never a silent epoch');

  // ── 3. formatting: tail slice, plain-substring grep, per-line cap ─────────────────────────────
  console.log('\nformatLogLines');
  const text = ['one', '', 'two TOKEN=abc123xyz', '   ', 'three', 'four'].join('\n');
  const f = formatLogLines(text, { tail: 2 });
  ok(f.scanned === 4, 'blank lines are dropped before counting');
  ok(f.lines.length === 2 && f.lines[1] === 'four', 'tail keeps the LAST n lines');
  const g = formatLogLines(text, { tail: 100, grep: 'THREE' });
  ok(g.matched === 1 && g.lines[0] === 'three', 'grep is a case-insensitive plain substring');
  const gRe = formatLogLines(text, { tail: 100, grep: 'o.e' });
  ok(gRe.matched === 0, 'grep is NOT a regex (`o.e` matches nothing — no ReDoS surface)');
  const red = formatLogLines(text, { tail: 100 });
  ok(red.redactions === 1 && red.lines.some((l) => l.includes('TOKEN=***')),
    'formatLogLines redacts and COUNTS what it redacted');
  const long = formatLogLines('x'.repeat(MAX_LINE_CHARS + 500), { tail: 5 });
  ok(long.lines[0].length < MAX_LINE_CHARS + 60 && long.lines[0].endsWith('[line truncated]'),
    'a monster line is capped and says so');

  // ── 4. containerLogTail against the fake daemon — READ-ONLY on the wire ───────────────────────
  console.log('\ncontainerLogTail (fake daemon)');
  known.add('fake-prod-server'); known.add('fake-prod-webapp');
  tty = false;
  logBody = () => Buffer.concat([
    frame(1, 'stdout line A\n'), frame(2, 'stderr line B\n'), frame(1, 'stdout line C\n')]);
  seen.length = 0;
  const tail = await containerLogTail('default', 'fake-prod-server', { tail: 7, sinceTs: 1700000000 });
  ok(tail.text === 'stdout line A\nstderr line B\nstdout line C\n',
    'non-TTY frames are demuxed and INTERLEAVED in arrival order (stderr is part of the log)');
  ok(tail.state === 'running', 'the container state comes back');
  ok(seen.every((s) => s.startsWith('GET ')), `only GETs went on the wire: ${JSON.stringify(seen)}`);
  ok(!seen.some((s) => /exec|attach|start|stop|restart|kill|archive/.test(s)),
    'no exec / attach / start / stop / archive was ever requested');
  const logReq = seen.find((s) => s.includes('/logs'));
  ok(/follow=0/.test(logReq), 'follow=0 — a zee cannot hold a stream open on a production daemon');
  ok(/tail=7/.test(logReq) && /since=1700000000/.test(logReq), 'tail and since are passed to the daemon');
  ok(/timestamps=1/.test(logReq) && /stdout=1/.test(logReq) && /stderr=1/.test(logReq),
    'timestamps + both streams are asked for');

  tty = true;
  logBody = () => Buffer.from('raw tty line\n', 'utf8');
  const rawTail = await containerLogTail('default', 'fake-prod-webapp', { tail: 3 });
  ok(rawTail.text === 'raw tty line\n', 'a TTY container\'s log is passed through unframed');

  tty = false;
  logBody = () => frame(1, `${'y'.repeat(50_000)}\n`);
  const capped = await containerLogTail('default', 'fake-prod-server', { tail: 5, maxBytes: 4096 });
  ok(capped.truncated === true, 'the byte cap trips truncated:true instead of reading forever');
  ok(capped.text.length <= 4096, 'and no more than the cap is kept');

  let threw = null;
  try { await containerLogTail('default', 'no-such-container', { tail: 5 }); }
  catch (e) { threw = e; }
  ok(threw && /404/.test(threw.message), 'an unreadable container THROWS (never a silent empty log)');

  // the shared frame walker still serves its first consumer
  const dm = demuxDockerStream(Buffer.concat([frame(1, 'out'), frame(2, 'err'), frame(1, '!')]));
  ok(dm.out.toString() === 'out!' && dm.err.toString() === 'err',
    'demuxDockerStream (container-fs re-export) still SEPARATES the streams');

  // ── 5. the DB wall: which prod containers a project's zee can even see ────────────────────────
  console.log('\nprodLogSources / prodLogTail (sandbox meta-DB)');
  pid = (await one(`INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`,
    [`prodlogs-${tag}`, root])).id;
  otherPid = (await one(`INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`,
    [`prodlogs-other-${tag}`, root])).id;
  const xoid = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [pid])).id;
  xellId = (await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                       zee_type, db_coupling)
       VALUES ($1,$2,$3,$4,$5,'working',false,'worker','db-isolated') RETURNING id`,
    [pid, xoid, `prodlogs-${tag}`, `spinoff/prodlogs-${tag}`, root])).id;
  const site = (await one(
    `INSERT INTO deploy_site (project_id, key, tier, docker_ctx, is_default)
       VALUES ($1,'main','prod','default',true) RETURNING id`, [pid])).id;
  const mkC = (project, role, tier, name, ctx = 'default', siteId = null) => {
    known.add(name);                    // the fake daemon HAS the container each row points at
    return one(
      `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, site_id,
                              last_build_commit, health)
         VALUES ($1,$2,$3,'shared',$4,$5,$6,'abcdef1234567890','up') RETURNING id`,
      [project, role, tier, name, ctx, siteId]);
  };
  await mkC(pid, 'server', 'prod', `prodlogs-${tag}-server`, 'default', site);
  await mkC(pid, 'webapp', 'prod', `prodlogs-${tag}-webapp`, 'default', site);
  await mkC(pid, 'db', 'prod', `prodlogs-${tag}-db`, 'default', site);
  await mkC(pid, 'server', 'dev', `prodlogs-${tag}-dev-server`);
  await mkC(otherPid, 'server', 'prod', `prodlogs-other-${tag}-server`);

  const srcs = await prodLogSources(pid);
  ok(srcs.length === 2, `only the prod SHIPPABLE containers are sources (got ${srcs.length})`);
  ok(srcs.every((s) => LOGGABLE_ROLES.includes(s.role)), 'sources are exactly server/webapp');
  ok(!srcs.some((s) => s.role === 'db'), 'the production DATABASE is not a source (its log is row data)');
  ok(!srcs.some((s) => s.name.includes('-dev-')), 'dev containers are not sources (this verb is about PROD)');
  ok(!srcs.some((s) => s.name.includes('other')), "another project's prod container is invisible");

  const list = await prodLogTail(pid, {});
  ok(list.ok === true && list.sources.length === 2, 'no role → the sources list');
  ok(list.sources.every((s) => !('docker_ctx' in s) && !('host' in s) && !('id' in s) && !('image' in s)),
    'a source publishes NO way in: no docker context, host, id or image');
  ok(Object.keys(list.sources[0]).sort().join(',') === 'container,deployed_commit,health,role,site',
    `a source is exactly {role, container, site, health, deployed_commit} (${Object.keys(list.sources[0]).join(',')})`);

  const dbAsk = await prodLogTail(pid, { role: 'db' });
  ok(dbAsk.ok === false && /not a readable role/.test(dbAsk.error), "role=db is refused BY NAME");
  ok(/row data/.test(dbAsk.error) && /zee prod/.test(dbAsk.error),
    'and the refusal says WHY and where that door is (`zee prod` / `zee seed`)');
  const infra = await prodLogTail(pid, { role: 'infra' });
  ok(infra.ok === false, 'role=infra is refused too (not a zee\'s code)');
  const bogus = await prodLogTail(pid, { role: '../../etc/passwd' });
  ok(bogus.ok === false && seen.every((s) => !s.includes('passwd')),
    'a junk role is refused by the allow-list and never reaches the daemon');

  const otherList = await prodLogTail(otherPid, {});
  ok(!otherList.sources.some((s) => s.container.includes(`prodlogs-${tag}-`)),
    "the other project's zee cannot see THIS project's prod containers");

  // ── 6. the happy path, end to end through the fake daemon ────────────────────────────────────
  tty = false;
  logBody = () => Buffer.concat([
    frame(1, '2026-09-18T10:00:00Z GET /api/fleet 200\n'),
    frame(2, '2026-09-18T10:00:01Z ERROR db url=postgres://app:letmein@db:5432/app\n'),
    frame(1, '2026-09-18T10:00:02Z GET /api/health 200\n'),
  ]);
  seen.length = 0;
  const got = await prodLogTail(pid, { role: 'server', tail: 10 });
  ok(got.ok === true && got.lines.length === 3, 'a real read returns the lines');
  ok(got.source.container === `prodlogs-${tag}-server` && got.source.state === 'running',
    'the answer names the container and its state');
  ok(!('docker_ctx' in got.source), 'and still no docker context in the answer');
  ok(got.redacted_lines === 1 && got.lines.join('\n').includes('app:***@'),
    'the printed DSN password is masked on the way out, and counted');
  ok(got.lines.some((l) => l.includes('ERROR')), 'stderr lines are part of what a reader gets');
  ok(got.mode === 'real' && /READ-ONLY/.test(got.note), 'the answer states the mode and the contract');
  ok(seen.every((s) => s.startsWith('GET ')), 'the end-to-end read made GETs only');

  const grepped = await prodLogTail(pid, { role: 'server', tail: 10, grep: 'error' });
  ok(grepped.matched_lines === 1 && grepped.lines.length === 1, 'grep filters the tail');
  ok(grepped.scanned_lines === 3, 'and still reports how much was scanned');

  // a second prod server (two deploy sites) must force an explicit choice, not a guess
  const site2 = (await one(
    `INSERT INTO deploy_site (project_id, key, tier, docker_ctx) VALUES ($1,'alt','prod','default') RETURNING id`,
    [pid])).id;
  await mkC(pid, 'server', 'prod', `prodlogs-${tag}-server-alt`, 'default', site2);
  const ambiguous = await prodLogTail(pid, { role: 'server', tail: 5 });
  ok(ambiguous.ok === false && /--container/.test(ambiguous.error),
    'two prod servers → name one with --container (the queenzee does not guess a site)');
  const chosen = await prodLogTail(pid, { role: 'server', tail: 5, container: `prodlogs-${tag}-server-alt` });
  ok(chosen.ok === true && chosen.source.container === `prodlogs-${tag}-server-alt`,
    '--container picks the named site');
  const foreign = await prodLogTail(pid, {
    role: 'server', tail: 5, container: `prodlogs-other-${tag}-server` });
  ok(foreign.ok === false && /no production server container named/.test(foreign.error),
    "--container cannot reach ANOTHER project's container (the name is filtered, not dialed)");
  await q(`DELETE FROM container WHERE name = $1`, [`prodlogs-${tag}-server-alt`]);
  await q(`DELETE FROM deploy_site WHERE id = $1`, [site2]);

  // ── 7. the queenzee route layer: a xell reads ITS OWN project, never one it names ─────────────
  console.log('\nselfProdLogs (the door the route opens)');
  const xell = await one(`SELECT id, slug, project_id FROM xell WHERE id=$1`, [xellId]);
  const viaSelf = await selfProdLogs(xell, { role: 'server', tail: 5 });
  ok(viaSelf.ok === true && viaSelf.source.container === `prodlogs-${tag}-server`,
    'selfProdLogs reads the CALLING xell\'s project');
  const selfSig = selfProdLogs.toString();
  ok(!/project_id\s*[:=]\s*(opts|args|params)/.test(selfSig) && /xell\.project_id/.test(selfSig),
    'the project comes from the xell row, never from the caller\'s parameters');
  const routes = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../server/src/api/routes.js', import.meta.url), 'utf8'));
  ok(/router\.get\('\/xell\/self\/prod-logs'/.test(routes),
    'the route is registered, and only as a GET');
  ok(!/router\.(post|put|delete|patch)\('\/xell\/self\/prod-logs/.test(routes),
    'there is no write verb on this path');

  // ── 8. simulate mode: a nested queenzee dials NOTHING ─────────────────────────────────────────
  console.log('\nPRODLOGS_MODE=simulate');
  process.env.PRODLOGS_MODE = 'simulate';
  const sim = await import('../server/src/lib/prod-logs.js?sim=1');
  ok(sim.PRODLOGS_MODE === 'simulate', 'the mode is read from the environment');
  // and the mode a CAGE already has — SHIP_MODE=simulate in .zeehive.env — is inherited, so a
  // nested queenzee is contained without anyone remembering to set a second flag.
  delete process.env.PRODLOGS_MODE;
  const shipWas = process.env.SHIP_MODE;
  process.env.SHIP_MODE = 'simulate';
  const inherited = await import('../server/src/lib/prod-logs.js?inherit=1');
  ok(inherited.PRODLOGS_MODE === 'simulate', 'PRODLOGS_MODE inherits SHIP_MODE when unset');
  if (shipWas === undefined) delete process.env.SHIP_MODE; else process.env.SHIP_MODE = shipWas;
  process.env.PRODLOGS_MODE = 'simulate';
  seen.length = 0;
  const simAnswer = await sim.prodLogTail(pid, { role: 'server', tail: 5 });
  ok(simAnswer.ok === false && simAnswer.simulated === true, 'simulate refuses the read');
  ok(seen.length === 0, 'and NOTHING went to a daemon (a nested queenzee\'s rows are the REAL fleet\'s)');
  const simList = await sim.prodLogTail(pid, {});
  ok(simList.ok === true && simList.sources.length === 2, 'the sources list still works in simulate');
  ok(seen.length === 0, 'listing sources is a meta-DB read — still no daemon dialed');
  delete process.env.PRODLOGS_MODE;
} finally {
  try { await q(`DELETE FROM container WHERE project_id = ANY($1)`, [[pid, otherPid].filter(Boolean)]); } catch {}
  try { await q(`DELETE FROM deploy_site WHERE project_id = ANY($1)`, [[pid, otherPid].filter(Boolean)]); } catch {}
  try { if (xellId) await q(`DELETE FROM xell WHERE id = $1`, [xellId]); } catch {}
  try { await q(`DELETE FROM xource WHERE project_id = ANY($1)`, [[pid, otherPid].filter(Boolean)]); } catch {}
  try { await q(`DELETE FROM project WHERE id = ANY($1)`, [[pid, otherPid].filter(Boolean)]); } catch {}
  try { rmSync(root, { recursive: true, force: true }); } catch {}
  await new Promise((r) => daemon.close(r));
  await pool.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);

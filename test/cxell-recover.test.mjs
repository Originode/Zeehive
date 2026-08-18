// ON A FRESHLY RESTARTED ZEEHIVE MACHINE, THE QUEENZEE MUST BE ABLE TO GET ITS ZEES BACK.
//
// WHAT ACTUALLY BREAKS. The app tier comes back with the host (compose restart policies); the CXELLS
// DO NOT — intake.js runs them `docker run -d … sleep infinity` with NO restart policy — so every
// live xell's cage is EXITED and nothing in the fleet revisits it: the reaper skips cages, the
// health monitor watches fleet containers, and the poller has no opinion about a zee that simply
// stopped speaking. The dashboard keeps showing live xells whose terminals will not open.
//
// AND A RESTART POLICY WOULD NOT HAVE FIXED IT, which is why this is a queenzee job: sshd is a
// process the queenzee EXECS at spawn (cxell-sshd.sh) and the egress seal is iptables rules in the
// container's OWN network namespace (cxell-firewall.sh). Both are RUNTIME state. A cage dockerd
// brought back on its own would have no attend door and — the dangerous half — NO FIREWALL: the
// fleet's live production databases reachable from an agent's cage.
//
// AND HALF THE FIX IS NOT THE CAGE AT ALL. A zee whose turn the reboot killed is left at
// status='working' — a turn LOCK with no turn behind it (claimZeeTurn refuses every resume while it
// is set) plus an open zee_turn row nobody will ever close. That zee is unreachable forever: a
// message queues, a landing approval cannot arrive, the reviver cannot revive it. So the phantom
// turn is ended honestly and filed as HOST_RESTART_DEATH, which puts it on the ladder a 529 gets.
//
// WHAT IS FENCED HERE:
//   A. the CLASSIFICATION and the PROMPT (pure): a host restart is transient, and the agent is told
//      the MACHINE went down — the standard revive prompt's "CUT SHORT BY A PROVIDER ERROR" would
//      send it hunting for a rate limit that never happened;
//   B. the ORDER, against the real docker seam: start → ssh door → SEAL → only then a turn;
//   C. the RECONNECT: the turn lock released, the ledger row closed, the revive scheduled, and the
//      resumed session carrying the restart's own prompt;
//   D. the REFUSALS: a missing cage is never rebuilt, an unprobeable one is left alone (UNKNOWN is
//      not 'down'), a paused/running one is untouched, and a nested queenzee restarts nothing;
//   E. the INTERLOCK: a cage that came up but could NOT be sealed is stopped again, tended, and its
//      zee's turn is NOT resumed.
//
// ⚠ EVERY LIVE CALL HERE IS CONFINED TO THIS TEST'S OWN XELLS, on purpose. DATABASE_URL may be a
// SHARED meta-DB (a xell on db-shared-dev has one), and both halves of this feature WRITE to the zee
// rows they visit — a fleet-wide sweep from a test would restart other people's cages and file
// host-restart deaths against zees that are working perfectly well. So the sweep is handed its
// lister (`list`, the same seam refreshZeeLiveInLiveCxells takes) and the resume is driven through
// nudgeXellForTurnDeath for THIS xell, rather than through reviveTick, whose due-set is the whole
// fleet's and whose claim would spend a real zee's revive attempt against this test's fake docker.
// That reviveTick sends a host-restart revive the RESTART's prompt is asserted statically in A2.
//
// Everything it creates is deleted in a finally, whatever happens.
process.env.PROVISION_MODE = 'real';   // read once at import: the real queenzee restarts real cages
process.env.TKB_NOTIFY = '0';

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── A. THE CLASSIFICATION AND THE PROMPT (pure — no database, no daemon) ──────────────────────
console.log('\n── A. a host restart is a TRANSIENT death with its own story ──');
const { HOST_RESTART_DEATH, decideRevive, classifyTurnDeath, REVIVE_BACKOFF_MIN } =
  await import('../server/src/lib/turn-death.js');
const { hostRestartRevivePrompt } = await import('../server/src/queenzee/revive.js');

ok(HOST_RESTART_DEATH.kind === 'transient' && HOST_RESTART_DEATH.signal === 'host-restart',
   'the machine going down is TRANSIENT — the session, the cage disk, the branch and the db all survived it');
ok(classifyTurnDeath('').kind === 'unknown',
   'and it CANNOT be classified from a message, because a turn a power cut killed left none — which is '
   + 'why noteTurnDeath takes an explicit classification instead of guessing');
ok(decideRevive({ ...HOST_RESTART_DEATH, attempts: 0 }).action === 'revive'
   && decideRevive({ ...HOST_RESTART_DEATH, attempts: 0 }).delayMinutes === REVIVE_BACKOFF_MIN[0],
   'so it rides the SAME ladder a 529 does (5/15/45, three attempts, then a human) — no second policy');
// …and the ladder SAYS the right thing about it. The schedule line is what a human reads in the log
// to find out what happened, and "a transient provider error" would send them to the provider's
// status page for a reboot of our own machine. The POLICY must not branch (one ladder), the WORDS
// must (proved by asserting the default is untouched).
ok(/the zeehive machine restarted under this turn/.test(decideRevive({ ...HOST_RESTART_DEATH, attempts: 0 }).reason)
   && !/provider/.test(decideRevive({ ...HOST_RESTART_DEATH, attempts: 0 }).reason),
   'the revive it schedules is explained as the machine restarting — not as a provider error it never was');
ok(/a transient provider error/.test(decideRevive({ kind: 'transient', signal: '529', attempts: 0 }).reason),
   'and every OTHER transient death still reads exactly as it did — the wording branches on the signal, nothing else');

const prompt = hostRestartRevivePrompt({ minutes: 7, attempt: 1, max: 3 });
ok(/THE ZEEHIVE MACHINE RESTARTED/.test(prompt) && !/PROVIDER ERROR/.test(prompt),
   'the prompt says the MACHINE restarted, and never claims a provider refused the zee');
ok(/YOUR FILES SURVIVED/.test(prompt) && /YOUR PROCESSES DID NOT/.test(prompt),
   'it states both halves an agent cannot see for itself: the disk survived, the background processes did not');
ok(/`zee build --wait`/.test(prompt),
   '…naming the poll a zee is most likely to be sitting in, which cannot ever answer now');
ok(/`zee status`/.test(prompt) && /Re-orient BEFORE you act/.test(prompt),
   'and it sends the zee to `zee status` first — decisions may have arrived while it was down');
ok(/attempt 1 of 3/.test(prompt) && /no human involved/.test(prompt),
   'and says which attempt this is, and that no human is behind it');

console.log('\n── A2. wired where a restarted machine actually reaches it ──');
const index = read('server/src/index.js');
ok(/import \{ startCxellRecovery \} from '\.\/queenzee\/cxell-recover\.js'/.test(index)
   && index.includes('startCxellRecovery()'),
   'index.js starts the recovery at boot — the one moment a host restart is guaranteed to run code');
const inproc = index.slice(index.indexOf('if (!config.queenzeeInproc)'));
ok(inproc.indexOf('startCxellRecovery()') > 0 && inproc.indexOf('startCxellRecovery()') > inproc.indexOf('return;'),
   'inside the QUEENZEE_INPROC block only — an API-only process must not drive the fleet');
const recover = read('server/src/queenzee/cxell-recover.js');
ok(/recoverStoppedCxells\(\{ reason: 'boot' \}\)[\s\S]{0,120}\.catch\(/.test(recover),
   'the boot sweep has a .catch — a docker probe that fails must never stop the queenzee coming up');
// The live half below hands the sweep its own lister, so the guards of the REAL one are asserted here.
// (From the shared CXELL_COLS/CXELL_WHERE pair down: the sweep's lister and the console button's
// single-xell lookup are built from ONE where-clause, precisely so these guards cannot drift apart.)
const lister = recover.slice(recover.indexOf('const CXELL_COLS'),
                             recover.indexOf('// END THE TURN THE REBOOT KILLED'));
ok(/viewer_kind = 'ssh-terminal'/.test(lister) && /entrypoint = 'cxell-cli'/.test(lister),
   'the fleet-wide lister visits cxell zees only — the only ones that HAVE a cage to restart');
ok(/decommissioned_at IS NULL/.test(lister) && /NOT IN \('retired', 'tearing-down'\)/.test(lister),
   '…never a decommissioned zee, a retired xell or one being torn down: their cages are meant to be gone');
ok(/DISTINCT ON \(x\.id\)[\s\S]*ORDER BY x\.id, z\.created_at DESC/.test(lister),
   'and one cage per xell (the newest zee), so a xell whose zee was swapped is not restarted twice');
const revive = read('server/src/queenzee/revive.js');
ok(/hostRestart \? hostRestartRevivePrompt/.test(revive),
   'and the reviver hands a host-restart revive its own prompt rather than the provider-error one');
const cxelljs = read('server/src/lib/cxell.js');
const sshdFn = cxelljs.slice(cxelljs.indexOf('export async function restartCxellSshd'),
                             cxelljs.indexOf('export async function restartCxellSshd') + 400);
ok(!/CXELL_ENV/.test(sshdFn),
   're-opening the door passes NO env: cxell-sshd.sh OVERWRITES /etc/environment when CXELL_ENV is '
   + 'set, and a cage restarted with a one-line environment loses its provider and identity tokens');

// ── B. THE DOCKER SEAM (no database — the fake `docker` on PATH records argv) ─────────────────
//
// Everything up to and including the sweep's REFUSALS is asserted here, because none of it touches
// the meta-DB: a cage that is running, paused, gone or unprobeable is decided from the probe alone,
// and a nested queenzee decides from PROVISION_MODE. That matters beyond tidiness — this half runs
// inside a cxell, where there is no DATABASE_URL at all, so the part of this feature that is most
// dangerous to get wrong (which cages get touched) is the part that stays verifiable everywhere.
const DOCKER_LOG = join(process.env.TMPDIR || '/tmp', `cxell-recover-docker-${process.pid}.log`);
process.env.DOCKER_LOG = DOCKER_LOG;
process.env.PATH = `${join(ROOT, 'test', '_bin')}:${process.env.PATH}`;
const dockerLog = () => (existsSync(DOCKER_LOG) ? readFileSync(DOCKER_LOG, 'utf8') : '');
const dropDockerLog = () => { try { if (existsSync(DOCKER_LOG)) unlinkSync(DOCKER_LOG); } catch { /* fine */ } };
dropDockerLog();

const { recentLogs } = await import('../server/src/lib/logbus.js');
const logs = (n = 80) => recentLogs(n).map((l) => `${l.scope}: ${l.msg}`).join('\n');
const { cxellState, startCxell, stopCxell, restartCxellSshd } = await import('../server/src/lib/cxell.js');
const { recoverStoppedCxells } = await import('../server/src/queenzee/cxell-recover.js');

console.log('\n── B. reading a cage\'s state, and the three different things each answer means ──');
process.env.DOCKER_FAKE_CXELL_STATE = 'exited';
ok((await cxellState({ slug: 'probe-me' })).state === 'exited',
   "docker's own word for a cage a reboot stopped is read back as 'exited'");
process.env.DOCKER_FAKE_CXELL_STATE = 'running';
ok((await cxellState({ slug: 'probe-me' })).state === 'running', '…and a live one as running');
process.env.DOCKER_FAKE_CXELL_STATE = 'missing';
const gone = await cxellState({ slug: 'probe-me' });
ok(gone.state === 'missing' && gone.missing === true,
   'a daemon that ANSWERED and has no such container is MISSING — a fact, and a different one from');
process.env.DOCKER_FAKE_CXELL_STATE = 'unreachable';
const unknown = await cxellState({ slug: 'probe-me' });
ok(unknown.state === 'unknown' && unknown.missing === false && !!unknown.error,
   '…a daemon that could not be asked at all, which is UNKNOWN: the containers.js doctrine is that a '
   + 'probe which cannot run must NEVER be read as "down" (a queenzee racing dockerd on the way up '
   + 'would otherwise report the whole fleet\'s cages as gone)');
delete process.env.DOCKER_FAKE_CXELL_STATE;

dropDockerLog();
await startCxell({ slug: 'probe-me' });
await restartCxellSshd({ slug: 'probe-me' });
await stopCxell({ slug: 'probe-me' });
const prim = dockerLog();
ok(/docker start cxell_probe-me/.test(prim),
   'the restart is `docker start` — never `run`, which would create a NEW cage with none of the zee\'s work');
ok(/docker exec -u 0 cxell_probe-me bash \/usr\/local\/bin\/cxell-sshd\.sh/.test(prim),
   'the attend door is re-opened by re-running cxell-sshd.sh as root — sshd is a process, and it died with the container');
ok(!/CXELL_ENV/.test(prim),
   '…with NO env: cxell-sshd.sh OVERWRITES /etc/environment when CXELL_ENV is set, so passing one would '
   + 'replace a live cage\'s provider and identity tokens with a one-line file');
ok(/docker stop cxell_probe-me/.test(prim), 'and there is a stop — the undo for a restart whose seal fails');

console.log('\n── B2. which cages the sweep will not touch ──');
const fake = (slug, over = {}) => ({ xell_id: '00000000-0000-4000-8000-00000000dead', slug,
  project_id: '00000000-0000-4000-8000-00000000beef', db_coupling: 'db-isolated',
  xell_status: 'working', zee_id: '00000000-0000-4000-8000-00000000cafe',
  zee_status: 'idle', claude_session_id: null, ...over });
const sweepOf = (rows, over = {}) => recoverStoppedCxells({ reason: 'tick', mode: 'real', list: async () => rows, ...over });

const empty = await sweepOf([]);
ok(empty.checked === 0 && empty.restarted === 0, 'an empty fleet does nothing at all');
const brokenLister = await recoverStoppedCxells({ list: async () => { throw new Error('db down'); }, mode: 'real' });
ok(brokenLister.error === 'db down' && brokenLister.restarted === 0,
   'a lister that throws is swallowed — this runs at BOOT, and a queenzee that will not come up because '
   + 'a query failed is a worse outage than the one it is recovering from');

for (const [state, key, why] of [
  ['running', 'running', 'a RUNNING cage is left completely alone — its turn may still be going'],
  ['paused', 'held', 'a PAUSED cage is held: pausing is a deliberate human act, and `docker start` does not even undo it'],
  ['restarting', 'held', 'a RESTARTING one is mid-transition — asking again next tick is the only correct move'],
  ['missing', 'missing', 'a cage that is GONE is reported, never rebuilt: a new container wearing the name would have none of the zee\'s work'],
  ['unreachable', 'unknown', 'and an unprobeable one is left ALONE and reported to nobody'],
]) {
  process.env.DOCKER_FAKE_CXELL_STATE = state;
  dropDockerLog();
  const s = await sweepOf([fake(`refuse-${state}`)]);
  ok(s[key] === 1 && s.restarted === 0 && !/docker start/.test(dockerLog()), why);
}
ok(/is GONE/.test(logs()), 'the missing cage is NAMED in the log, so a human can decide about re-dispatching it');

process.env.DOCKER_FAKE_CXELL_STATE = 'exited';
dropDockerLog();
const sim = await sweepOf([fake('refuse-simulate')], { mode: 'simulate' });
ok(sim.would_restart === 1 && !/docker start/.test(dockerLog()),
   'and a NESTED queenzee (PROVISION_MODE=simulate) starts nothing: its meta-DB is a CLONE of the fleet\'s, '
   + 'so every cage named in it is somebody else\'s live container');
ok(/NOT restarted. PROVISION_MODE=simulate/.test(logs()), '…saying what it would have done instead of doing it');
delete process.env.DOCKER_FAKE_CXELL_STATE;

// ── C/D/E. THE RESTART AND THE RECONNECT (throwaway postgres + the same docker seam) ─────────
const url = process.env.DATABASE_URL;
if (!url) {
  // A cxell has no DATABASE_URL (the meta-DB is the queenzee's). Say so LOUDLY rather than passing
  // quietly: the half above is real evidence, the half below is not yet run.
  console.log(`\n${failures === 0 ? 'ALL PASSED ✓ (so far)' : `${failures} FAILURE(S) ✗`}`);
  console.log('SKIPPED: C/D/E need DATABASE_URL (a throwaway meta-DB) — run them where one exists');
  process.exit(failures === 0 ? 0 : 1);
}

const { q, one, pool } = await import('../server/src/db/pool.js');
const { tendState } = await import('../server/src/lib/status.js');
const { startTurn } = await import('../server/src/lib/turn-ledger.js');
const { nudgeXellForTurnDeath } = await import('../server/src/queenzee/nudge.js');

const PID = '00000000-0000-4000-8000-0000000f5c01';
const cleanup = async () => {
  try { await q(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* already gone */ }
  try { if (existsSync(DOCKER_LOG)) unlinkSync(DOCKER_LOG); } catch { /* fine */ }
};

try {
  await cleanup();
  await q(`INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'cxell-recover',$2,'main')`, [PID, ROOT]);
  await q(`INSERT INTO provider_token (project_id, provider, token, token_hint, label) VALUES ($1,'claude','sk-fake','sk-…ake','recover-acct')`, [PID]);
  // A PROD DB IN THE FLEET — so the re-seal has something real to block and the test can prove the
  // restarted cage is sealed with the SAME list a spawn uses (lib/cxell-seal.js, one query, three callers).
  await q(`INSERT INTO container (project_id, role, tier, isolation, name, host, host_port)
           VALUES ($1,'db','prod','shared','recover_db_prod','10.77.0.9',54329)`, [PID]);
  const xource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'main') RETURNING *`, [PID]);
  const rt = await one(`SELECT id FROM agent_runtime WHERE key='claude-code-cxell'`);
  let n = 0;
  const mkXell = async (slug) => one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, self_token_hash)
     VALUES ($1,$2,$3,$4,$5,'working',$6) RETURNING *`,
    [PID, xource.id, slug, `spinoff/${slug}`, `/tmp/recover/${slug}`, `hash-${slug}`]);
  const mkZee = async (xellId, over = {}) => one(
    `INSERT INTO zee (xell_id, attach_mode, entrypoint, kind, runtime_id, viewer_kind, viewer_url,
                      claude_session_id, model, status)
     VALUES ($1,'headless-spawn','cxell-cli','headless',$2,$3,'ssh://zee@127.0.0.1:2222',$4,'opus',$5) RETURNING *`,
    [xellId, rt?.id || null, over.viewerKind ?? 'ssh-terminal',
     over.sid ?? `00000000-0000-4000-8000-00000000000${++n}`, over.status ?? 'working']);
  const zeeRow = (id) => one(`SELECT * FROM zee WHERE id=$1`, [id]);
  // THIS TEST'S OWN FLEET, and nothing else's — the production lister's guards are asserted in A2.
  const mine = async () => q(
    `SELECT DISTINCT ON (x.id)
            x.id AS xell_id, x.slug, x.project_id, x.db_coupling, x.status AS xell_status,
            z.id AS zee_id, z.status AS zee_status, z.claude_session_id
       FROM zee z JOIN xell x ON x.id = z.xell_id
      WHERE x.project_id = $1 AND z.viewer_kind = 'ssh-terminal' AND z.decommissioned_at IS NULL
        AND z.entrypoint = 'cxell-cli' AND x.status NOT IN ('retired', 'tearing-down')
      ORDER BY x.id, z.created_at DESC`, [PID]);
  const sweep = (over = {}) => recoverStoppedCxells({ reason: 'tick', mode: 'real', list: mine, ...over });
  const openTurn = (zeeId) => one(`SELECT * FROM zee_turn WHERE zee_id=$1 ORDER BY started_at DESC LIMIT 1`, [zeeId]);

  // ── B/C. THE MID-TURN CASE: the machine died under a running turn ────────────────────────────
  console.log('\n── B. the cage comes back in the only safe order ──');
  const x1 = await mkXell('recover-midturn');
  const z1 = await mkZee(x1.id);
  const t1 = await startTurn({ zee: z1, xell: x1, kind: 'spawn', sessionId: z1.claude_session_id });
  ok(!!t1 && t1.ended_at === null, 'setup: a zee mid-turn, with an OPEN zee_turn row, exactly as a reboot leaves one');

  process.env.DOCKER_FAKE_CXELL_STATE = 'exited';
  const sweep1 = await sweep({ reason: 'boot' });
  const dl1 = dockerLog();
  ok(sweep1.restarted >= 1, `the boot sweep restarted the stopped cage (${JSON.stringify({ ...sweep1, results: undefined })})`);
  const iStart = dl1.indexOf('docker start cxell_recover-midturn');
  const iSsh = dl1.indexOf('cxell-sshd.sh');
  const iSeal = dl1.indexOf('cxell-firewall.sh');
  ok(iStart >= 0, 'it ran `docker start` on the cage — never a recreate, which would destroy uncollected work');
  ok(iSsh > iStart, 'then re-ran cxell-sshd.sh: sshd is a PROCESS and died with the container, so the attend door is gone');
  ok(iSeal > iSsh, 'and then re-applied the firewall — iptables rules live in the container network namespace and died with it too');
  ok(/CXELL_BLOCK_TCP=[^\n]*10\.77\.0\.9:54329/.test(dl1),
     'sealed with the fleet\'s prod DBs in the block list — the same query the spawn seal uses (lib/cxell-seal.js)');
  ok(dl1.indexOf('zee-live.mjs') > iSeal && /zee-attach\.sh/.test(dl1),
     'and the attend path (feed renderer + attach script) is refreshed into it: index.js\'s boot sweep '
     + 'reaches RUNNING cages only, so a cage that slept through a ship would otherwise keep the old pair');

  console.log('\n── C. and the zee inside it is reconnected ──');
  const r1 = await zeeRow(z1.id);
  ok(r1.status === 'errored',
     "the phantom turn lock is RELEASED (status left 'working' forever blocks claimZeeTurn — no message, "
     + 'no landing approval and no revive could ever reach this zee again)');
  ok(/machine restarted/.test(r1.last_stop_reason || ''),
     `and the row says what happened, in the zee's own stop reason (${String(r1.last_stop_reason).slice(0, 60)}…)`);
  const t1b = await openTurn(z1.id);
  ok(t1b.ended_at !== null && t1b.status === 'errored',
     'the open zee_turn row is closed too — a ledger row nobody closes is a turn that never ends');
  ok(t1b.metered === false,
     '…as UNMETERED zero rather than a measured zero: the turn spent whatever it spent before the power cut, '
     + 'and the provider never reported it');
  ok(r1.revive_class === 'transient' && r1.revive_signal === 'host-restart',
     'the death is filed with its own signal, so "how many zees did the reboot cost us?" is a GROUP BY');
  ok(r1.revive_next_at && new Date(r1.revive_next_at) > new Date(Date.now() + 4 * 60000),
     'and a revive is SCHEDULED (five minutes out — the machine deserves a moment to settle), not fired inside the sweep');
  ok((await tendState(x1.id)).open === false,
     'no human is raised: a machine that came back is the queenzee\'s to fix, not a card on somebody\'s board');
  const ev1 = await one(`SELECT raw FROM session_event WHERE zee_id=$1 AND hook_event_name='cxell-recover'`, [z1.id]);
  ok(ev1?.raw?.sealed === true && ev1?.raw?.state === 'exited',
     'the restart is answerable in SQL afterwards (session_event cxell-recover carries the state and the seal)');

  // THE RESUME ITSELF — the SAME door a landing approval comes through, driven here for THIS xell
  // only (reviveTick's due-set is the whole fleet's; see the ⚠ in the header).
  const before = dockerLog().length;
  const nudged = await nudgeXellForTurnDeath(x1.id, {
    signal: 'host-restart', attempt: 1, max: 3, minutes: 5, mode: 'real',
    prompt: hostRestartRevivePrompt({ minutes: 5, attempt: 1, max: 3 }),
    why: 'the zeehive machine restarted under this turn' });
  ok(nudged.nudged === true,
     'the released zee can be resumed at all — which it could NOT be a moment ago: claimZeeTurn refuses '
     + "every resume while the row still says 'working'");
  for (let i = 0; i < 60 && !/--resume/.test(dockerLog().slice(before)); i++) await sleep(100);
  const dl2 = dockerLog().slice(before);
  ok(/--resume/.test(dl2) && dl2.includes(z1.claude_session_id),
     'resuming THIS zee\'s own session (the same session id — its transcript, not a fresh one)');
  ok(/THE ZEEHIVE MACHINE RESTARTED/.test(dl2) && !/CUT SHORT BY A PROVIDER ERROR/.test(dl2),
     'with the RESTART\'s prompt — telling it a provider refused it would send it hunting for a rate limit that never happened');

  // (The REFUSALS — running / paused / restarting / missing / unprobeable / simulate — are proven in
  // B2 above, where they belong: not one of them touches the meta-DB.)

  // ── D. a zee mid-turn in a HEALTHY cage keeps its turn ───────────────────────────────────────
  console.log('\n── D. a live cage is never interrupted ──');
  const x2 = await mkXell('recover-running');
  const z2 = await mkZee(x2.id, { status: 'working' });
  process.env.DOCKER_FAKE_CXELL_STATE = 'running';
  const sweepRunning = await sweep();
  ok(sweepRunning.restarted === 0 && sweepRunning.running >= 1, 'a RUNNING cage is left completely alone');
  const r2 = await zeeRow(z2.id);
  ok(r2.status === 'working' && r2.revive_next_at === null,
     'and the zee working inside it keeps its turn: this loop must never end a turn that is still running, '
     + 'which is exactly what releasing the lock would do');
  process.env.DOCKER_FAKE_CXELL_STATE = 'exited';

  // ── D2. a cage that stopped between turns needs no revive ────────────────────────────────────
  console.log('\n── D2. a cage that was BETWEEN turns is restarted, and nobody is woken ──');
  await q(`UPDATE zee SET viewer_kind='none' WHERE xell_id = ANY($1)`, [[x1.id, x2.id]]);
  const x3 = await mkXell('recover-idle');
  const z3 = await mkZee(x3.id, { status: 'idle' });
  const sweepIdle = await sweep();
  ok(sweepIdle.restarted === 1 && sweepIdle.resumed === 0, 'the cage is back, and no turn was started in it');
  const r3 = await zeeRow(z3.id);
  ok(r3.status === 'idle' && r3.revive_next_at === null,
     'an idle zee is left idle — it was not mid-turn, so there is nothing to reconnect and nothing to say sorry for');

  // ── E. THE INTERLOCK: no seal, no turn ───────────────────────────────────────────────────────
  console.log('\n── E. a cage it could not SEAL is stopped again, and its zee is not resumed ──');
  await q(`UPDATE zee SET viewer_kind='none' WHERE xell_id = $1`, [x3.id]);
  const x4 = await mkXell('recover-unsealed');
  const z4 = await mkZee(x4.id, { status: 'working' });
  process.env.DOCKER_FAKE_SEAL_EXIT = '3';
  const beforeSeal = dockerLog().length;
  const sweepSeal = await sweep();
  delete process.env.DOCKER_FAKE_SEAL_EXIT;
  const dl4 = dockerLog().slice(beforeSeal);
  ok(sweepSeal.unsealed === 1 && sweepSeal.resumed === 0, 'the sweep counts it as UNSEALED and resumes nothing');
  ok(/docker stop cxell_recover-unsealed/.test(dl4),
     'the restart is UNDONE — a running cage with no iptables rules can reach the fleet\'s production '
     + 'databases, which is strictly worse than the stopped cage it found');
  const r4 = await zeeRow(z4.id);
  ok(r4.status === 'working' && r4.revive_next_at === null,
     'and the zee is NOT reconnected: no turn may start in a cage whose seal we could not prove');
  // …which is also the proof of what the whole "reconnect" half is FOR: while the phantom lock
  // stands, the queenzee's own resume door is shut to this zee.
  const refused = await nudgeXellForTurnDeath(x4.id, { signal: 'host-restart', mode: 'real', prompt: 'x' });
  ok(refused.nudged === false && refused.refused === 'turn-in-flight',
     "a zee still marked 'working' cannot be resumed by ANYTHING — the turn lock is the single-writer "
     + 'guard, which is why the restarted cages above had to have it released explicitly');
  const t4 = await tendState(x4.id);
  ok(t4.open === true && /FIREWALL COULD NOT BE RE-APPLIED/.test(t4.full || ''),
     'a human is raised instead, told exactly which step failed');
  ok(/STOPPED the cage again/.test(t4.full || '') && /retries the whole restart/.test(t4.full || ''),
     '…what the queenzee did about it, and that the next pass retries the whole sequence (so it self-heals)');
} finally {
  await cleanup();
  await pool.end().catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);

// A HUMAN MUST BE ABLE TO RESTART ONE XELL'S CAGE, FROM THE CONSOLE.
//
// WHAT THE AUTOMATIC RECOVERY CANNOT SEE (test/cxell-recover.test.mjs is the other half). The sweep
// acts on what `docker inspect` will admit to: a cage that is EXITED. The failure an operator
// actually sits in front of is the opposite one — the container is RUNNING, its sshd is dead, its
// agent is hung, the terminal will not attach and the zee has not spoken for an hour. Every pass of
// the loop walks past that cage as healthy ('running' is its first and cheapest verdict), and until
// this existed the only cure was a host session with a docker socket: something most operators of a
// hive do not have, and no caged zee has ever had.
//
// THE DANGEROUS PART IS THE FORCE, and it is where most of these assertions are. Restarting a cage
// that is genuinely running ENDS the turn inside it. So: it is never the default (a running cage is
// refused without `force`), the console PROBES the cage before it asks (so the confirm can say
// truthfully whether a live turn is about to be killed), and the turn that dies is ended honestly —
// lock released, ledger closed unmetered, death filed — rather than abandoned.
//
// AND IT MUST NOT BECOME A SECOND POLICY. This runs the recovery loop's OWN sequence
// (start → ssh door → SEAL → only then a turn) with its refusals intact: a missing cage is never
// recreated, an unprobeable one is never guessed at, a retired xell is refused, a nested queenzee
// (PROVISION_MODE=simulate) touches nothing, and a cage that comes back but cannot be SEALED is
// stopped again with a human raised and no turn resumed.
//
// WHAT IS FENCED HERE:
//   A. the STORY (pure): a hand-restarted cage is its own signal with its own wording, and the zee
//      is told a HUMAN did it — the host-restart prompt would blame a machine that never rebooted;
//   B. the SURFACE (static): the route, the API wrapper, and the THREE places the button appears —
//      the honeycomb flower (with its context menu), the xell card, and the terminal modal, which is
//      where a dead cage is actually discovered;
//   C. the RESTART: the order against the real docker seam, the released turn, and the IMMEDIATE
//      resume (a human is standing there — five minutes of blank terminal reads as "it failed");
//   D. the REFUSALS: running-without-force, missing, unprobeable, retired, simulate;
//   E. the INTERLOCKS: no seal → no turn; and an undeliverable resume falls back to the ladder
//      rather than being lost.
//
// ⚠ Every live call here is confined to THIS TEST'S OWN project: DATABASE_URL may be a shared
// meta-DB, and this path stops and starts real containers by name. restartXellCxell takes a xell id,
// so the confinement is the id — never a sweep. Everything created is deleted in a finally.
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

// ── A. THE STORY A HAND-RESTARTED CAGE TELLS (pure — no database, no daemon) ──────────────────
console.log('\n── A. a cage a human bounced is its own kind of death ──');
const { CAGE_RESTART_DEATH, HOST_RESTART_DEATH, decideRevive, REVIVE_BACKOFF_MIN,
        MAX_REVIVE_ATTEMPTS } = await import('../server/src/lib/turn-death.js');
const { cageRestartRevivePrompt } = await import('../server/src/queenzee/revive.js');

ok(CAGE_RESTART_DEATH.kind === 'transient' && CAGE_RESTART_DEATH.signal === 'cage-restart',
   'it is TRANSIENT — the session, the cage disk, the branch and the database all survived it, exactly '
   + 'as they survive a reboot');
ok(CAGE_RESTART_DEATH.signal !== HOST_RESTART_DEATH.signal,
   '…and a SEPARATE signal from a host restart, because everything downstream says what happened: the '
   + 'prompt the zee reads, the tend a spent ladder raises, the column somebody groups by later');
const sched = decideRevive({ ...CAGE_RESTART_DEATH, attempts: 0 });
ok(sched.action === 'revive' && sched.delayMinutes === REVIVE_BACKOFF_MIN[0],
   'the POLICY does not branch on it: same 5/15/45 ladder, same three attempts, same human at the end');
ok(/a human restarted this zee's cxell under this turn/.test(sched.reason) && !/provider/.test(sched.reason),
   'only the WORDS branch — the schedule line names the human, not a provider error that never happened');
ok(/a transient provider error/.test(decideRevive({ kind: 'transient', signal: '529', attempts: 0 }).reason)
   && /the zeehive machine restarted/.test(decideRevive({ ...HOST_RESTART_DEATH, attempts: 0 }).reason),
   '…and the two that were already right are untouched');

const prompt = cageRestartRevivePrompt({ by: 'ada@console' });
ok(/RESTARTED YOUR CONTAINER/.test(prompt) && /ada@console/.test(prompt),
   'the resumed zee is told a NAMED human restarted its container');
ok(!/THE ZEEHIVE MACHINE RESTARTED/.test(prompt) && !/PROVIDER ERROR/.test(prompt),
   '…not that the machine rebooted (it did not) and not that a provider refused it (nobody did) — both '
   + 'would send it hunting for an outage that never happened');
ok(/YOUR FILES SURVIVED/.test(prompt) && /YOUR PROCESSES DID NOT/.test(prompt)
   && /`zee build --wait`/.test(prompt),
   'it states both halves an agent cannot see for itself: the disk survived, the background poll it may '
   + 'be sitting in did not');
ok(/A HUMAN IS WATCHING THIS XELL RIGHT NOW/.test(prompt),
   'and the fact that only this prompt has: somebody is standing at the console waiting to see if it '
   + 'comes back, so proving it is alive comes before anything else');
ok(/`zee status`/.test(prompt) && /Re-orient BEFORE you act/.test(prompt)
   && /do not `zee tend` about the restart/.test(prompt),
   're-orient first, and do not raise a human about a restart the human standing there performed');
ok(/if you were genuinely stuck/i.test(prompt),
   '…and it invites the one report only the zee can give: whether it was actually wedged');

console.log('\n── A2. the ladder can replay it when the immediate resume could not be delivered ──');
const revive = read('server/src/queenzee/revive.js');
ok(/cageRestart \? cageRestartRevivePrompt/.test(revive),
   'reviveTick hands a cage-restart revive the cage-restart prompt — the fallback path must not lie either');
ok(/cage-restart|CAGE_RESTART_DEATH\.signal/.test(revive.slice(revive.indexOf('const cageRestart'), revive.indexOf('const cageRestart') + 200)),
   '…recognised off the zee row\'s revive_signal, which is what the death wrote there');

// ── B. THE SURFACE: one verb, reachable from the two places it is needed ──────────────────────
console.log('\n── B. the route, and the buttons that reach it ──');
const routes = read('server/src/api/routes.js');
ok(/router\.post\('\/xells\/:id\/cxell\/restart', requireQueenzeeLoops/.test(routes),
   'the restart is loop-owned work: an API-only instance refuses it rather than driving the fleet without '
   + 'the single-queenzee lock');
ok(/router\.get\('\/xells\/:id\/cxell', requireQueenzeeLoops/.test(routes),
   'and the state probe sits beside it, so the console can ask what the cage is doing before it asks the human');
ok(/restartXellCxell\(req\.params\.id, \{[\s\S]{0,120}force: !!req\.body\?\.force/.test(routes),
   'force is explicit in the body — never inferred, because it is the flag that ends a live turn');
const api = read('web/src/api.js');
ok(/cxell\/restart/.test(api) && /export async function cxellStatus/.test(api),
   'both are wrapped for the console');
const cage = read('web/src/cage.js');
ok(/await cxellStatus\(x\.id\)/.test(cage) && cage.indexOf('await cxellStatus') < cage.indexOf('await showConfirm('),
   'THE CONFIRM PROBES FIRST: what it warns about ("a turn is live in there") is read from the cage itself, '
   + 'not from the dashboard\'s cached row — a confirm that guesses teaches operators to ignore confirms');
ok(/A TURN IS LIVE/.test(cage) && /st\.mid_turn/.test(cage),
   '…and it says so in those words, only when it is true');
ok(/force: running/.test(cage),
   'force is sent only for a cage that is actually running — the case where a stop is destructive');
ok(/is GONE/.test(cage) && /none of this zee.{0,2}s uncollected work/.test(cage),
   'a cage that is GONE is reported as gone, never as a failed restart: nothing here recreates a container');
ok(/RE-APPLY the egress firewall/.test(cage) && /cannot be sealed is never left running/.test(cage),
   'the dialog states the seal, because that is the step whose failure stops everything after it');
ok(/r\.held_paused/.test(cage) && /is PAUSED, and a[\s\S]{0,40}resume is a turn/.test(cage),
   'and the one outcome that looks like a half-failure is named: the cage came back, the resume did not, '
   + 'because the pause switch is holding it — "press play" is the fix, not another restart');
const app = read('web/src/App.jsx');
ok(/data-testid="restart-cage"/.test(app) && /restartXellCage\(x, onDone\)/.test(app),
   'the xell card carries the button, beside the terminal it is the cure for');
const term = read('web/src/ZeeTerminal.jsx');
ok(/data-testid="term-restart-cage"/.test(term) && /restartXellCage\(xell, null\)/.test(term),
   'and so does the terminal modal — the place a wedged cage is actually discovered');
ok(/\['error', 'closed'\]\.includes\(status\)/.test(term),
   '…highlighted exactly when the socket failed, which is the moment the operator is looking for it');
ok(term.includes("import { restartXellCage } from './cage.js'") && app.includes("from './cage.js'"),
   'both call the SAME handler (App imports ZeeTerminal, so the shared confirm text lives in its own module)');

// THE HONEYCOMB. A verb that exists only on the xell card is, in practice, a verb that does not
// exist: the flower is the surface operators watch, and the first report back on this feature was
// "i don't see the restart". So the cage verb must be IN petalVerbs — which is the single list the
// flower buttons AND the right-click context menu are both built from.
const hive = read('web/src/hive/HiveCanvas.jsx');
const sessionPetal = hive.slice(hive.indexOf('  v[2] = cxell'), hive.indexOf('  v[2] = cxell') + 220);
ok(/'terminal', 'nudge', 'cage'/.test(sessionPetal) && /xPaused \?/.test(sessionPetal),
   'the flower\'s SESSION petal carries ⟳ cage beside the terminal — for a cxell in either pause state, '
   + 'because a paused xell is exactly one that may need its cage bounced');
ok(/: \(xPaused \? \['resume'\] : \['pause'\]\);/.test(sessionPetal),
   '…and NOT for a xell with no caged zee: there is no container to restart, and a button that can only '
   + 'return a refusal is worse than no button');
ok(/cage: '⟳'/.test(hive) && /cage: '⟳ Restart cage'/.test(hive)
   && /cage: 'Restart this zee/.test(hive),
   'it is drawn, named in the right-click menu, and tooltipped — an unlabelled glyph on a canvas is '
   + 'not a surfaced verb');
ok(/const VERB_MENU_TONE = \{[^}]*cage: 'danger'/.test(hive)
   && /const VERB_ACCENT = \{[\s\S]{0,220}cage: 'error'/.test(hive),
   '…in the destructive tone it shares with pause and done: if a turn is live in there, this ends it');
ok(/if \(kind === 'cage'\) \{ restartXellCage\(x, refresh\); return; \}/.test(app),
   'and the flower\'s click dispatches to the SAME shared handler as the card and the terminal — three '
   + 'surfaces, one confirm, one set of refusals');

// …and it is actually DRAWN where it can be clicked. The flower buttons are a canvas row clipped to
// their petal, while their hit-rects are NOT clipped — so a row too wide for the hexagon is the one
// failure that looks like the feature working: a button half-cut (or invisible) whose rect still
// answers clicks. Adding a fourth verb to the SESSION petal is exactly the change that can cause it,
// so this runs the REAL drawing code (esbuild JSX→JS, like manager-hexagon.test.mjs) and checks the
// geometry rather than trusting the eye. Sizes: the honeycomb's flower at ordinary zoom up to the
// layout max (168). At the layout FLOOR (24) rows overflow and are clipped — including the MACHINE
// petal's four that predate this — and a 24px hexagon with 15px pills is unusable either way.
console.log('\n── B2. the flower row still fits inside its petal with the fourth verb on it ──');
const { transformSync } = await import('esbuild');
const { writeFileSync, rmSync } = await import('node:fs');
const { pointInHex, flowerCenters } = await import('../web/src/hive/hex.js');
const tmpMod = join(ROOT, 'web/src/hive/.cxell-restart.test-build.mjs');
writeFileSync(tmpMod, transformSync(hive, { loader: 'jsx', format: 'esm' }).code);
let drawFlowerButtons, petalVerbs, xellContextMenuItems;
try { ({ drawFlowerButtons, petalVerbs, xellContextMenuItems } = await import(tmpMod)); }
finally { rmSync(tmpMod, { force: true }); }

// A canvas recorder whose measureText is PESSIMISTIC about emoji: one em per glyph (⟳ and ⏸ are
// narrower than that in Segoe UI, 💬 about that). Measuring optimistically here would pass a row
// that clips in a browser, which is the whole thing being tested.
const recorder = () => new Proxy({
  font: '', canvas: { width: 1, height: 1 },
  measureText(t) {
    const px = Number((/(\d+(?:\.\d+)?)px/.exec(this.font || '') || [0, 12])[1]);
    return { width: [...String(t)].length * px };
  },
}, { get: (t, p) => (p in t ? t[p] : () => {}), set: (t, p, v) => { t[p] = v; return true; } });

const caged = { id: 'X', slug: 'cage-flower', zee_type: 'worker', status: 'claimed', task_id: 't',
  hive_status: 'occ-working', viewer_kind: 'ssh-terminal', viewer_url: 'ssh://x',
  stack: [{ role: 'server' }, { role: 'webapp' }] };
ok(petalVerbs(caged, { ahead: 2 })[2].includes('cage')
   && !petalVerbs({ ...caged, viewer_kind: null, viewer_url: null }, { ahead: 2 })[2]?.includes('cage')
   && Object.keys(petalVerbs({ ...caged, is_production: true }, null)).length === 0,
   'the REAL petalVerbs offers it for a cxell, withholds it from a xell with no cage, and production '
   + 'keeps no verbs at all');
ok(xellContextMenuItems(caged, { ahead: 2 }).some((i) => i.kind === 'cage' && /Restart cage/.test(i.label)
     && i.tone === 'danger'),
   'and the right-click menu — the surface that needs no aiming at a 20px pill — lists it in words');

let clipped = [];
for (const size of [40, 60, 90, 120, 168]) {
  const centers = flowerCenters(0, 0, size);
  const rects = drawFlowerButtons(recorder(), centers, size, caged, { ahead: 2, behind: 0 });
  for (const r of rects) {
    const mx = r.x + r.w / 2, my = r.y + r.h / 2;
    // its OWN petal: the clip is per-petal, so spilling into the neighbour is still spilling
    const c = centers.reduce((a, b) => (Math.hypot(b[0] - mx, b[1] - my) < Math.hypot(a[0] - mx, a[1] - my) ? b : a));
    const corners = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];
    if (!corners.every(([px, py]) => pointInHex(px, py, c[0], c[1], size))) clipped.push(`${r.kind}@${size}`);
  }
}
ok(clipped.length === 0,
   `every flower button — all four session verbs among them — is drawn wholly inside its own petal at `
   + `every ordinary flower size${clipped.length ? ` (spilled: ${clipped.join(', ')})` : ''}`);
const wide = drawFlowerButtons(recorder(), flowerCenters(0, 0, 60), 60, caged, { ahead: 2, behind: 0 });
ok(wide.some((r) => r.kind === 'cage') && wide.filter((r) => r.kind === 'cage').length === 1,
   '…and the cage button is one of them, exactly once');

// ── C/D/E. THE RESTART ITSELF (throwaway postgres + the fake docker on PATH) ──────────────────
const DOCKER_LOG = join(process.env.TMPDIR || '/tmp', `cxell-restart-docker-${process.pid}.log`);
process.env.DOCKER_LOG = DOCKER_LOG;
process.env.PATH = `${join(ROOT, 'test', '_bin')}:${process.env.PATH}`;
const dockerLog = () => (existsSync(DOCKER_LOG) ? readFileSync(DOCKER_LOG, 'utf8') : '');
const dropDockerLog = () => { try { if (existsSync(DOCKER_LOG)) unlinkSync(DOCKER_LOG); } catch { /* fine */ } };
dropDockerLog();

const url = process.env.DATABASE_URL;
if (!url) {
  // A cxell has no DATABASE_URL (the meta-DB is the queenzee's). Say so LOUDLY rather than passing
  // quietly: A and B are real evidence, C/D/E are not yet run.
  console.log(`\n${failures === 0 ? 'ALL PASSED ✓ (so far)' : `${failures} FAILURE(S) ✗`}`);
  console.log('SKIPPED: C/D/E need DATABASE_URL (a throwaway meta-DB) — run them where one exists');
  process.exit(failures === 0 ? 0 : 1);
}

const { q, one, pool } = await import('../server/src/db/pool.js');
const { tendState } = await import('../server/src/lib/status.js');
const { startTurn } = await import('../server/src/lib/turn-ledger.js');
const { restartXellCxell, probeXellCxell } = await import('../server/src/queenzee/cxell-recover.js');

const PID = '00000000-0000-4000-8000-0000000f5c02';
const cleanup = async () => {
  try { await q(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* already gone */ }
  try { await q(`DELETE FROM project_pause WHERE project_id=$1`, [PID]); } catch { /* no such row */ }
  try { if (existsSync(DOCKER_LOG)) unlinkSync(DOCKER_LOG); } catch { /* fine */ }
};

try {
  await cleanup();
  await q(`INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'cxell-restart',$2,'main')`, [PID, ROOT]);
  await q(`INSERT INTO provider_token (project_id, provider, token, token_hint, label) VALUES ($1,'claude','sk-fake','sk-…ake','restart-acct')`, [PID]);
  // A PROD DB IN THE FLEET, so the re-seal has something real to block: a hand-restarted cage must
  // come back with the SAME block list a spawn applies (lib/cxell-seal.js — one query, three callers).
  await q(`INSERT INTO container (project_id, role, tier, isolation, name, host, host_port)
           VALUES ($1,'db','prod','shared','restart_db_prod','10.77.0.11',54331)`, [PID]);
  const xource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'main') RETURNING *`, [PID]);
  const rt = await one(`SELECT id FROM agent_runtime WHERE key='claude-code-cxell'`);
  let n = 0;
  const mkXell = async (slug) => one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, self_token_hash)
     VALUES ($1,$2,$3,$4,$5,'working',$6) RETURNING *`,
    [PID, xource.id, slug, `spinoff/${slug}`, `/tmp/restart/${slug}`, `hash-${slug}`]);
  const mkZee = async (xellId, over = {}) => one(
    `INSERT INTO zee (xell_id, attach_mode, entrypoint, kind, runtime_id, viewer_kind, viewer_url,
                      claude_session_id, model, status)
     VALUES ($1,'headless-spawn','cxell-cli','headless',$2,$3,'ssh://zee@127.0.0.1:2222',$4,'opus',$5) RETURNING *`,
    [xellId, rt?.id || null, over.viewerKind ?? 'ssh-terminal',
     over.sid ?? `00000000-0000-4000-8000-0000000000${String(++n).padStart(2, '0')}`,
     over.status ?? 'working']);
  const zeeRow = (id) => one(`SELECT * FROM zee WHERE id=$1`, [id]);

  // ── C. THE WEDGED CAGE: running, and useless ────────────────────────────────────────────────
  console.log('\n── C. a RUNNING cage is refused, until a human insists ──');
  const x1 = await mkXell('restart-wedged');
  const z1 = await mkZee(x1.id);
  const t1 = await startTurn({ zee: z1, xell: x1, kind: 'spawn', sessionId: z1.claude_session_id });
  ok(!!t1 && t1.ended_at === null, 'setup: a zee mid-turn in a cage docker calls RUNNING — the state the sweep cannot help with');

  process.env.DOCKER_FAKE_CXELL_STATE = 'running';
  const probe = await probeXellCxell(x1.id);
  ok(probe.ok && probe.state === 'running' && probe.mid_turn === true && probe.zee_status === 'working',
     'the probe the console asks first reports the cage running AND a turn live in it — the two facts the '
     + 'confirm dialog has to be truthful about');

  dropDockerLog();
  const soft = await restartXellCxell(x1.id, { by: 'ada@console' });
  ok(soft.ok === false && soft.verdict === 'running' && !/docker (start|stop)/.test(dockerLog()),
     'without force it is REFUSED and nothing is touched — the default must never end a live turn');
  ok((await zeeRow(z1.id)).status === 'working',
     '…and the zee keeps its turn, exactly as the automatic sweep leaves a running cage alone');

  console.log('\n── C2. …and then it is stopped, restarted, re-sealed, and the zee is resumed ──');
  dropDockerLog();
  const forced = await restartXellCxell(x1.id, { by: 'ada@console', force: true });
  const dl1 = dockerLog();
  ok(forced.ok === true && forced.verdict === 'restarted',
     `the forced restart is performed (${JSON.stringify({ verdict: forced.verdict, resumed_now: forced.resumed_now })})`);
  const iStop = dl1.indexOf('docker stop cxell_restart-wedged');
  const iStart = dl1.indexOf('docker start cxell_restart-wedged');
  const iSsh = dl1.indexOf('cxell-sshd.sh');
  const iSeal = dl1.indexOf('cxell-firewall.sh');
  ok(iStop >= 0 && iStart > iStop,
     'a running cage is STOPPED first and then started — `docker start` alone is a no-op on a running '
     + 'container, so without the stop nothing inside it would actually be restarted');
  ok(iSsh > iStart && iSeal > iSsh,
     'then the same order the reboot recovery uses: the attend door (sshd is a process and died with the '
     + 'container), then THE SEAL (iptables rules live in the container network namespace and died too)');
  ok(/CXELL_BLOCK_TCP=[^\n]*10\.77\.0\.11:54331/.test(dl1),
     '…sealed with the fleet\'s prod DBs in the block list, from the same query a spawn seals with');
  ok(!/docker run/.test(dl1) && !/docker rm/.test(dl1),
     'and nothing is recreated or removed: the zee\'s uncollected work lives on that container\'s disk');

  // THE KILLED TURN, read as the LEDGER ROW it was — by the time this call returns the zee row has
  // legitimately moved on (the immediate resume of C3 claims a NEW turn on it), so asserting the zee
  // is 'errored' here would only be asserting that the resume had not happened yet.
  const t1a = await one(`SELECT * FROM zee_turn WHERE id=$1`, [t1.id]);
  ok(t1a.ended_at !== null && t1a.status === 'errored',
     "the turn the restart killed is ENDED, not abandoned — a row left open is a lock claimZeeTurn "
     + 'refuses forever, and no message, landing approval or revive could ever reach this zee again');
  ok(/restarted this cxell by hand/.test(t1a.stop_reason || '')
     && /while it was still running/.test(t1a.stop_reason || ''),
     `and the row says who did what (${String(t1a.stop_reason).slice(0, 70)}…)`);
  ok(t1a.metered === false,
     'and it is closed as UNMETERED zero, not a measured zero: the turn spent whatever it spent before '
     + 'the container went down, and the provider never got to report it');
  const turns = await q(`SELECT id FROM zee_turn WHERE zee_id=$1`, [z1.id]);
  ok(turns.length === 2,
     '…and the LOCK really came off: a second turn row exists, which only claimZeeTurn can create and '
     + 'which it refuses outright while the killed turn still holds the zee');
  const r1 = await zeeRow(z1.id);
  ok(r1.revive_class === 'transient' && r1.revive_signal === 'cage-restart',
     'the death is filed under its own signal — "how many turns did operators bounce?" is a GROUP BY');
  ok((await tendState(x1.id)).open === false,
     'no human is raised: the human is right here, and they did this on purpose');

  console.log('\n── C3. the resume is IMMEDIATE, because somebody is watching ──');
  // The resume is fire-and-forget (a turn runs for minutes), and the fake docker logs the ARGV first
  // and the prompt it is fed on stdin only once it has drained it — so wait for the stdin block, not
  // for the command line, or the prompt assertions race the pipe.
  for (let i = 0; i < 100 && !/>>STDIN/.test(dockerLog()); i++) await sleep(100);
  const dl2 = dockerLog();
  ok(forced.resumed_now === true && /--resume/.test(dl2) && dl2.includes(z1.claude_session_id),
     'the zee\'s own session is resumed on the spot (the same session id — its transcript, not a fresh one) '
     + 'rather than in five minutes: an operator staring at a blank terminal reads a wait as a failure');
  ok(/RESTARTED YOUR CONTAINER/.test(dl2) && /ada@console/.test(dl2),
     '…and it is told, by name, who restarted it');
  ok(r1.revive_next_at === null,
     'and the ladder schedule is CLEARED once the resume is delivered — otherwise the zee would be revived '
     + 'a second time, five minutes later, on top of a turn already running');
  const evs = await q(
    `SELECT raw FROM session_event WHERE zee_id=$1 AND hook_event_name='cxell-restart'
      ORDER BY ts, id`, [z1.id]);
  const ev1 = evs[evs.length - 1];
  ok(ev1?.raw?.by === 'ada@console' && ev1.raw.force === true && ev1.raw.verdict === 'restarted',
     'the whole thing is answerable in SQL afterwards: who pressed it, whether they forced it, what happened');
  ok(evs.length === 2 && evs[0].raw.force === false && evs[0].raw.verdict === 'running',
     '…including the press that was REFUSED: "somebody tried to bounce this cage and was told no" is '
     + 'exactly as much a part of the audit trail as the one that went through');

  // ── D. THE REFUSALS ─────────────────────────────────────────────────────────────────────────
  console.log('\n── D. what a button is not allowed to do ──');
  const x2 = await mkXell('restart-gone');
  const z2 = await mkZee(x2.id, { status: 'working' });
  process.env.DOCKER_FAKE_CXELL_STATE = 'missing';
  dropDockerLog();
  const gone = await restartXellCxell(x2.id, { by: 'ada@console', force: true });
  ok(gone.ok === false && gone.verdict === 'missing' && !/docker (start|run)/.test(dockerLog()),
     'a cage that is GONE is never recreated — a fresh container wearing its name would have none of the '
     + "zee's work, and re-dispatching is a human's decision, not a button's");
  ok((await zeeRow(z2.id)).status === 'working',
     '…and the zee\'s turn is left exactly as it was: nothing was restarted, so nothing died');

  process.env.DOCKER_FAKE_CXELL_STATE = 'unreachable';
  dropDockerLog();
  const blind = await restartXellCxell(x2.id, { by: 'ada@console', force: true });
  ok(blind.ok === false && blind.verdict === 'unknown' && !/docker (start|stop)/.test(dockerLog()),
     'a cage that could not be PROBED is left alone: a probe that cannot run is UNKNOWN, never a false '
     + '"down" (the containers.js doctrine), and acting on one would stop a healthy cage');

  process.env.DOCKER_FAKE_CXELL_STATE = 'exited';
  dropDockerLog();
  const sim = await restartXellCxell(x2.id, { by: 'ada@console', mode: 'simulate' });
  ok(sim.verdict === 'would-restart' && !/docker start/.test(dockerLog()),
     'a NESTED queenzee (PROVISION_MODE=simulate) starts nothing: its meta-DB is a CLONE of the fleet\'s, '
     + 'so every cage named in it is somebody else\'s live container');

  await q(`UPDATE xell SET status='retired' WHERE id=$1`, [x2.id]);
  dropDockerLog();
  const retired = await restartXellCxell(x2.id, { by: 'ada@console', force: true });
  ok(retired.ok === false && retired.verdict === 'no-cxell' && /retired/.test(retired.reason || '')
     && dockerLog() === '',
     'a retired xell is refused before docker is touched at all — its cage is MEANT to be gone, and the '
     + 'refusal says which of the two "no" answers this is');
  const noXell = await restartXellCxell('00000000-0000-4000-8000-00000000face', { by: 'ada@console' });
  ok(noXell.ok === false && noXell.verdict === 'no-xell', 'and an id that is not a xell is a verdict, not a crash');

  // ── E. THE INTERLOCK: no seal, no turn ──────────────────────────────────────────────────────
  console.log('\n── E. a cage it could not SEAL is stopped again, and its zee is not resumed ──');
  const x3 = await mkXell('restart-unsealed');
  const z3 = await mkZee(x3.id, { status: 'working' });
  process.env.DOCKER_FAKE_SEAL_EXIT = '3';
  dropDockerLog();
  const unsealed = await restartXellCxell(x3.id, { by: 'ada@console' });
  delete process.env.DOCKER_FAKE_SEAL_EXIT;
  const dl3 = dockerLog();
  ok(unsealed.ok === false && unsealed.verdict === 'unsealed' && !unsealed.resumed_now,
     'the restart reports UNSEALED and resumes nothing');
  ok(/docker stop cxell_restart-unsealed/.test(dl3.slice(dl3.indexOf('cxell-firewall.sh'))),
     'the restart is UNDONE after the seal fails — a running cage with no iptables rules can reach the '
     + 'fleet\'s production databases, which is strictly worse than the cage the operator complained about');
  ok((await zeeRow(z3.id)).status === 'working',
     'and no turn is started in a cage whose seal could not be proved — the interlock does not care who asked');
  const t3 = await tendState(x3.id);
  ok(t3.open === true && /FIREWALL COULD NOT BE RE-APPLIED/.test(t3.full || '')
     && /by hand from the console/.test(t3.full || ''),
     'a human is raised, told which step failed and that this cage was restarted BY HAND (not by the sweep) '
     + '— the difference decides whether they go looking for a reboot');

  console.log('\n── E2. a resume that cannot be delivered falls back to the ladder, never nowhere ──');
  const x4 = await mkXell('restart-paused');
  const z4 = await mkZee(x4.id, { status: 'working' });
  await startTurn({ zee: z4, xell: x4, kind: 'spawn', sessionId: z4.claude_session_id });
  await q(`INSERT INTO project_pause (project_id, paused) VALUES ($1, true)
             ON CONFLICT (project_id) DO UPDATE SET paused = true`, [PID]);
  process.env.DOCKER_FAKE_CXELL_STATE = 'exited';
  const paused = await restartXellCxell(x4.id, { by: 'ada@console' });
  await q(`UPDATE project_pause SET paused = false WHERE project_id = $1`, [PID]);
  ok(paused.verdict === 'restarted' && paused.resumed_now === false && paused.held_paused === true,
     'the cage still comes back (a paused project is not a broken one) but the RESUME is refused — a revive '
     + 'is a turn, and every level of the pause switch refuses a turn (nudgeCxell itself only enforces the '
     + 'fleet-wide level; the ladder checks all three, and so must this path, which skips the ladder)');
  ok(!/--resume/.test(dockerLog().slice(dockerLog().indexOf('docker start cxell_restart-paused'))),
     '…and it is refused BEFORE the resume is delivered, not reported after the fact');
  const r4 = await zeeRow(z4.id);
  ok(r4.status === 'errored' && r4.revive_signal === 'cage-restart' && !!r4.revive_next_at,
     '…so the death stays filed on the ladder with its schedule intact: the zee is picked up in ~5 minutes '
     + 'with the same prompt, instead of the resume being silently lost');
  ok(paused.in_minutes >= 1,
     'and the caller is told when that will be, so the console can say it out loud rather than look broken');
} finally {
  await cleanup();
  await pool.end().catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);

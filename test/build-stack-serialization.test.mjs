// ONE COMPOSE STACK, ONE `docker compose up` AT A TIME.
//
// THE LIVE FAILURE (2026-09-02, omnibiz, local AND ugreen-nas): the readiness proof builds every
// unbuilt role of a xell, and it kicked server and webapp off TOGETHER. They are two container ROWS
// but ONE compose project, and omnibiz's spinoff compose says `webapp: depends_on: [server]`, so
// `up -d webapp` creates the SERVER container too. The two invocations raced, and the server build
// died on its own container:
//
//   Network omnibiz-spin-quiet-atlas-34a97a_spinoff  Creating   ← logged twice in one build
//   Container omnibiz_spin_server_quiet-atlas-34a97a Creating
//   service:server:1 Error response from daemon: Conflict. The container name
//   "/omnibiz_spin_server_quiet-atlas-34a97a" is already in use by container "e570a1f0…".
//
// "Error response from daemon" is INFRA to classifyBuildFailure, an INFRA proof failure writes
// build_readiness_record='missing', and 'missing' STOPS the pool fill — which is why omnibiz
// stopped provisioning xells while its containers were, in fact, up. The loser was not even wrong:
// its sibling had created that container correctly one second earlier.
//
// So this drives the REAL buildContainer against the REAL meta-DB with a FAKE build-container.sh
// (config.repoRoot is pointed at a fixture, so no docker and no compile) and asserts what the daemon
// cares about: two roles of ONE xell never sit inside the script at the same time, while two
// DIFFERENT xells still do (serializing the whole fleet would turn a 12-xell hive into a queue).
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PROVISION_MODE = 'simulate';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { config } = await import('../server/src/config.js');
const { buildContainer, onStack, stackKeyFor } = await import('../server/src/lib/build.js');

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tag = randomUUID().slice(0, 8);
const CTX = `stack-${tag}`;
const SB = 34100, WB = 36200;          // a ladder no live project and no other test walks
let projId = null;
const realRepoRoot = config.repoRoot;

// ── 1. the serializer itself, with no database and no spawn in the way ────────────────────────
console.log('\n── the queue: same stack waits, different stacks do not ──');
{
  const log = [];
  const task = (name, ms) => async () => { log.push(`start ${name}`); await sleep(ms); log.push(`end ${name}`); };

  await Promise.all([onStack('a', task('a1', 60)), onStack('a', task('a2', 10))]);
  ok(log.join(',') === 'start a1,end a1,start a2,end a2',
     `two tasks on one key run nose-to-tail (${log.join(',')})`);

  log.length = 0;
  await Promise.all([onStack('x', task('x', 60)), onStack('y', task('y', 60))]);
  ok(log[0].startsWith('start') && log[1].startsWith('start'),
     `two DIFFERENT keys overlap (${log.join(',')}) — one xell's build must not queue behind another's`);

  log.length = 0;
  const boom = onStack('b', async () => { throw new Error('build blew up'); }).catch(() => 'caught');
  const after = onStack('b', task('after', 5));
  ok(await boom === 'caught', 'a task that THROWS rejects to its own caller');
  await after;
  ok(log.join(',') === 'start after,end after',
     'and the next task on that key still runs — a failed build never wedges the stack');

  log.length = 0;
  let release;
  const stuck = onStack('c', () => new Promise((r) => { release = r; }));   // never finishes on its own
  const t0 = Date.now();
  await onStack('c', task('bounded', 1), { maxWaitMs: 40 });
  ok(Date.now() - t0 < 1000 && log.join(',') === 'start bounded,end bounded',
     `a build that never returns does not freeze the stack forever — the wait is bounded `
     + `(${Date.now() - t0}ms), because a possible race beats a permanent freeze`);
  release(); await stuck;

  ok(stackKeyFor({ docker_ctx: 'ugreen-nas', owner_xell_id: 'X' }) === 'ugreen-nas::X'
     && stackKeyFor({ docker_ctx: 'ugreen-nas', owner_xell_id: 'Y' })
        !== stackKeyFor({ docker_ctx: 'ugreen-nas', owner_xell_id: 'X' }),
     'the key is (run context, xell): one xell is one compose project');
}

// ── 2. the real buildContainer, twice, on one xell ────────────────────────────────────────────
const fixture = mkdtempSync(join(tmpdir(), 'zh-stack-'));
const LOG = join(fixture, 'invocations.log');
mkdirSync(join(fixture, 'scripts'), { recursive: true });
// Stands in for scripts/build-container.sh: records when it is INSIDE the docker work, and emits
// the same one JSON line the projector parses.
writeFileSync(join(fixture, 'scripts', 'build-container.sh'), `#!/usr/bin/env bash
role="$2"
echo "start $role" >> "${LOG}"
sleep 0.6
echo "end $role" >> "${LOG}"
printf '{"ok":true,"head":"deadbee","hot":false,"method":"fake","service":"%s"}\\n' "$role"
`);

const mkXell = async (slug, serverPort, webPort) => {
  const wt = join(fixture, slug);          // one worktree per xell (the column is unique)
  mkdirSync(wt, { recursive: true });
  const x = (await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, ready_at)
     VALUES ($1,(SELECT id FROM xource WHERE project_id=$1),$2,$3,$4,'ready',true,now()) RETURNING *`,
    [projId, slug, `spinoff/${slug}`, wt])).id;
  const ids = {};
  for (const [role, port] of [['server', serverPort], ['webapp', webPort]]) {
    ids[role] = (await one(
      `INSERT INTO container (project_id,role,tier,isolation,name,image_tag,docker_ctx,host,host_port,
          internal_port,url,compose_project,compose_file,owner_xell_id,health)
       VALUES ($1,$2,'spinoff','per-xell',$3,$4,$5,'10.9.9.9',$6,$7,$8,$9,'docker-compose.spinoff.yml',$10,'down')
       RETURNING id`,
      [projId, role, `stack-${slug}-${role}`, `stack-${role}:${slug}`, CTX, port,
       role === 'server' ? 3000 : 5173, `http://10.9.9.9:${port}`, `stack-${slug}`, x])).id;
  }
  return { xell: x, ...ids };
};
const settle = async (ids, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    const rows = await q(`SELECT health FROM container WHERE id = ANY($1)`, [ids]);
    if (rows.every((r) => r.health !== 'building')) return rows;
    if (Date.now() - t0 > ms) throw new Error('builds did not settle');
    await sleep(50);
  }
};
const lines = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean) : []);

try {
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch, env_file, port_server_base, port_web_base, port_slot_mod)
     VALUES ($1,$2,'main','.env',$3,$4,1) RETURNING id`,
    [`zt-stack-${tag}`, fixture, SB, WB])).id;
  await q(`INSERT INTO xource (project_id, ref) VALUES ($1,'main')`, [projId]);
  await q(`INSERT INTO pool_config (project_id, target_ready) VALUES ($1,0)`, [projId]);

  config.repoRoot = fixture;   // the build path spawns OUR script, not the real one

  console.log('\n── the proof kicks both roles of one xell off together (the omnibiz shape) ──');
  const a = await mkXell(`stack-a-${tag}`, SB, WB);
  const [vs, vw] = await Promise.all([buildContainer(a.server, {}), buildContainer(a.webapp, {})]);
  ok(vs?.status === 'building' && vw?.status === 'building',
     'BOTH builds are accepted and both rows spin immediately — the queue is behind the daemon, '
     + 'not in front of the operator');
  await settle([a.server, a.webapp]);
  const seq = lines();
  ok(seq.length === 4, `both builds really ran (${seq.join(' | ')})`);
  const interleaved = seq.some((l, i) => i % 2 === 0 && !l.startsWith('start'))
    || seq.some((l, i) => i % 2 === 1 && !l.startsWith('end'))
    || seq[0].split(' ')[1] !== seq[1].split(' ')[1];
  ok(!interleaved,
     'and never at the same time — no second `compose up` while the first is still creating '
     + 'the network and the depends_on container (the Conflict cannot happen)');
  const built = await q(`SELECT role, health, last_build_error FROM container WHERE id = ANY($1)`,
    [[a.server, a.webapp]]);
  ok(built.every((r) => r.health === 'up' && !r.last_build_error),
     'both roles end UP with no build error — waiting is not failing');

  console.log('\n── two DIFFERENT xells still build at the same time ──');
  writeFileSync(LOG, '');
  const b = await mkXell(`stack-b-${tag}`, SB + 10, WB + 10);
  const c = await mkXell(`stack-c-${tag}`, SB + 20, WB + 20);
  await Promise.all([buildContainer(b.server, {}), buildContainer(c.server, {})]);
  await settle([b.server, c.server]);
  const seq2 = lines();
  ok(seq2.length === 4 && seq2[0].startsWith('start') && seq2[1].startsWith('start'),
     `both are inside the script together (${seq2.join(' | ')}) — the lock is per stack, not global`);
} finally {
  config.repoRoot = realRepoRoot;
  await q(`DELETE FROM xell_uses_container WHERE xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [projId]).catch(() => {});
  await q(`DELETE FROM container WHERE project_id=$1`, [projId]).catch(() => {});
  await q(`DELETE FROM xell WHERE project_id=$1`, [projId]).catch(() => {});
  await q(`DELETE FROM pool_config WHERE project_id=$1`, [projId]).catch(() => {});
  await q(`DELETE FROM xource WHERE project_id=$1`, [projId]).catch(() => {});
  await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  await pool.end();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);

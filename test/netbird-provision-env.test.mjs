// NETBIRD MESH — provisioner integration + the health-monitor join sweep (docs/netbird-mesh-plan.md
// §6 phase 3). When a project manifest opts tiers.spinoff.mesh.enabled AND the queenzee has the mesh
// configured (meshEnabled), provisioning mints the per-xell peer and its ONE-TIME setup key rides
// the .zeehive.env projection + the build-env relay; the health monitor then calls markPeerJoined
// once the sidecar agent answers. Every branch rides an injected fake management API (the same
// makeApi pattern as test/netbird-mesh.test.mjs); the mesh_peer intent rows run against a real
// postgres — DATABASE_URL.
//
// Covered:
//   • provision mints the per-xell 'xell' peer (status minted) when manifest + meshEnabled
//   • a mint FAILURE degrades provision to legacy-only — the xell exists, no row, never a throw
//   • the guards: mesh DISABLED → no mint; manifest NOT opted in → no mint
//   • markJoinedMeshPeers (the health/monitor path) stamps JOINED once the control plane lists the
//     peer; a peer not listed yet stays minted; disabled mesh skips
//   • .zeehive.env carries SPINOFF_MESH_MGMT_URL always and SPINOFF_MESH_SETUP_KEY ONLY while the
//     row is still 'minted'; a re-emit before join PRESERVES the key from the current file; an
//     environment can never override the two SPINOFF_MESH_* names (reserved); after join a re-emit
//     drops the consumed key
//   • meshBuildEnv (the build-path relay) reads the key from the worktree file — {} on a mesh-less
//     xell/queenzee, URL-only when no key has been written yet
//   • the health monitor wires the sweep (static)
import { mkdtempSync, rmSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.PROVISION_MODE = 'simulate';
process.env.BUILD_MODE = 'simulate';

const ROOT = new URL('..', import.meta.url).pathname;
const { q, one, pool } = await import('../server/src/db/pool.js');
const { config } = await import('../server/src/config.js');
const { provisionXell, emitXellEnv, meshBuildEnv } = await import('../server/src/lib/provision.js');
const nb = await import('../server/src/lib/netbird.js');
const { loadManifest } = await import('../server/src/lib/manifest.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

const meshOn = () => { config.netbirdApiUrl = 'https://mesh.test.invalid'; config.netbirdApiToken = 't'; };
const meshOff = () => { config.netbirdApiUrl = null; config.netbirdApiToken = null; };
meshOff(); // start from the standing default

// ── the fake management API: groups + setup keys + peers, plus a call log ──────────────────────
const makeApi = ({ peers = [], failSetupKeys = false } = {}) => {
  const state = { groups: [], keys: [], peers: [...peers], calls: [] };
  const request = async (method, path, body) => {
    state.calls.push(`${method} ${path}`);
    if (method === 'GET' && path === '/api/groups') return { status: 200, json: state.groups };
    if (method === 'POST' && path === '/api/groups') {
      const g = { id: `g-${state.groups.length + 1}`, name: body.name };
      state.groups.push(g);
      return { status: 200, json: g };
    }
    if (method === 'POST' && path === '/api/setup-keys') {
      if (failSetupKeys) return { status: 500, json: { message: 'control plane refuses keys (stub)' } };
      const k = { id: `sk-${state.keys.length + 1}`, key: `KEY-${state.keys.length + 1}`, ...body };
      state.keys.push(k);
      return { status: 200, json: k };
    }
    if (method === 'GET' && path === '/api/peers') return { status: 200, json: state.peers };
    return { status: 500, json: { message: `stub: unhandled ${method} ${path}` } };
  };
  return { request, state };
};

function projection(dir) {
  const path = join(dir, '.zeehive.env');
  if (!existsSync(path)) return { missing: true, vars: {}, text: '' };
  const text = readFileSync(path, 'utf8');
  const vars = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) vars[m[1]] = m[2];
  }
  return { path, text, vars };
}

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const ctx = `zt-mesh-${tag}`;
const root = mkdtempSync(join(tmpdir(), `mesh-p-${tag}-`));
const cleanups = [];
let projId = null, projPlainId = null, machineId = null;

const baseManifest = loadManifest(ROOT).manifest;
const meshOnManifest = JSON.parse(JSON.stringify(baseManifest));
meshOnManifest.tiers = meshOnManifest.tiers || {};
meshOnManifest.tiers.spinoff = meshOnManifest.tiers.spinoff || {};
meshOnManifest.tiers.spinoff.mesh = { enabled: true };

try {
  machineId = (await one(
    `INSERT INTO machine (key, docker_ctx, host_ip, max_xells, enabled)
     VALUES ($1,$2,'10.9.0.5',20,true) RETURNING id`, [`zt-mesh-${tag}`, ctx])).id;
  cleanups.push(() => q(`DELETE FROM machine WHERE id=$1`, [machineId]));
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch, manifest, compose_spinoff)
     VALUES ($1,$2,'main',$3::jsonb,'docker-compose.spinoff.yml') RETURNING id`,
    [`zt-mesh-${tag}`, join(root, 'proj'), JSON.stringify(meshOnManifest)])).id;
  cleanups.push(() => q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {}));
  await q(`INSERT INTO xource (project_id, ref) VALUES ($1,'main')`, [projId]);
  await q(`INSERT INTO pool_config (project_id, target_ready, default_db_coupling)
           VALUES ($1,0,'db-isolated')`, [projId]);
  await q(`INSERT INTO machine_pool (machine_id, project_id, pool_size, dev_priority) VALUES ($1,$2,0,5)`,
    [machineId, projId]);

  // a second project with the SAME real manifest but NO tiers.spinoff.mesh block — the guard test's
  // "manifest not opted in" side needs its own project (the first project opts the mesh in).
  projPlainId = (await one(
    `INSERT INTO project (name, repo_root, main_branch, manifest, compose_spinoff)
     VALUES ($1,$2,'main',$3::jsonb,'docker-compose.spinoff.yml') RETURNING id`,
    [`zt-mesh-plain-${tag}`, join(root, 'proj-plain'), JSON.stringify(baseManifest)])).id;
  await q(`INSERT INTO xource (project_id, ref) VALUES ($1,'main')`, [projPlainId]);
  await q(`INSERT INTO pool_config (project_id, target_ready, default_db_coupling)
           VALUES ($1,0,'db-isolated')`, [projPlainId]);
  await q(`INSERT INTO machine_pool (machine_id, project_id, pool_size, dev_priority) VALUES ($1,$2,0,5)`,
    [machineId, projPlainId]);

  const provision = async ({ meshEnabled = true } = {}) => {
    if (meshEnabled) meshOn(); else meshOff();
    const api = makeApi();
    const x = await provisionXell({ projectId: projId, mode: 'simulate', machineCtx: ctx,
                                    mesh: { request: api.request } });
    return { x, api };
  };

  // ── 1. provision mints the per-xell peer when manifest mesh.enabled AND meshEnabled ──────────
  section('provision mints the per-xell peer (phase 3)');
  const { x: a, api: apiA } = await provision({ meshEnabled: true });
  ok(!!a?.id && !!a.slug, 'the xell provisions normally');
  const rowA = await one(
    `SELECT * FROM mesh_peer WHERE project_id=$1 AND kind='xell' AND removed_at IS NULL AND xell_id=$2`,
    [projId, a.id]);
  ok(!!rowA && rowA.hostname === a.slug && rowA.status === 'minted' && rowA.nb_setup_key_id === 'sk-1',
     `a minted 'xell' intent row exists for the slug (${a.slug}, key id sk-1)`);
  ok(apiA.state.calls.some((c) => c === 'POST /api/setup-keys')
     && apiA.state.groups.some((g) => g.name === 'xells'),
     'the mint drove the control plane (group ensured, one-off setup key minted)');
  ok(!JSON.stringify(rowA).includes('KEY-1'), 'the key itself is NEVER stored on the row');

  // ── 2. a mint failure degrades provision to LEGACY-ONLY ──────────────────────────────────────
  section('a mint failure degrades to legacy-only, never blocks');
  const apiBad = makeApi({ failSetupKeys: true });
  const xBad = await provisionXell({ projectId: projId, mode: 'simulate', machineCtx: ctx,
                                     mesh: { request: apiBad.request } });
  ok(!!xBad?.id, 'the xell still provisions when the control plane refuses the key');
  const badRows = await q(
    `SELECT id FROM mesh_peer WHERE xell_id=$1 AND kind='xell'`, [xBad.id]);
  ok(badRows.length === 0, 'no intent row is left behind by a failed mint');

  // ── 3. guards: mesh disabled, and a manifest that does not opt in ─────────────────────────────
  section('guards: mesh disabled / manifest not opted in → no mint');
  meshOff();   // config is ON from the sections above; the disabled branch needs it OFF
  const apiOff = makeApi();
  const xOff = await provisionXell({ projectId: projId, mode: 'simulate', machineCtx: ctx,
                                     mesh: { request: apiOff.request } });
  ok(!!xOff?.id, 'provision works on a mesh-less queenzee');
  ok(apiOff.state.calls.length === 0 && !(await one(
    `SELECT id FROM mesh_peer WHERE xell_id=$1 AND kind='xell'`, [xOff.id])),
     'mesh disabled → no control-plane call, no intent row (the standing invariant)');

  meshOn();
  const apiNo = makeApi();
  const xNo = await provisionXell({ projectId: projPlainId, mode: 'simulate', machineCtx: ctx,
                                    mesh: { request: apiNo.request } });
  ok(!!xNo?.id, 'provision works when the manifest does not opt the mesh in');
  ok(apiNo.state.calls.length === 0 && !(await one(
    `SELECT id FROM mesh_peer WHERE xell_id=$1 AND kind='xell'`, [xNo.id])),
     'manifest NOT opted in → no mint even with the mesh configured');

  // ── 4. the health-monitor join sweep: markJoinedMeshPeers stamps JOINED once the sidecar answers ──
  section('markJoinedMeshPeers: the health/monitor path stamps JOINED when the sidecar answers');
  const apiJoinA = makeApi({ peers: [{ id: 'p-A', hostname: a.slug, ip: '100.64.0.7', connected: true }] });
  const sweepA = await nb.markJoinedMeshPeers({ request: apiJoinA.request });
  ok(sweepA.joined.includes(a.slug), `the sweep stamped '${a.slug}' joined`);
  const joinedA = await one(`SELECT * FROM mesh_peer WHERE xell_id=$1`, [a.id]);
  ok(joinedA.status === 'joined' && joinedA.nb_peer_id === 'p-A' && String(joinedA.ip) === '100.64.0.7',
     'the control plane\'s LIVE half (peer id + mesh IP) is cached onto the row');

  meshOff();
  const skip = await nb.markJoinedMeshPeers({ request: apiJoinA.request });
  ok(skip.skipped === 'mesh disabled' && skip.joined.length === 0,
     'mesh disabled → the sweep is a legible no-op');
  meshOn();

  // ── 5. .zeehive.env carries the key only while the sidecar has NOT joined ────────────────────
  section('the projection: key while minted, mgmt URL always, preserved across re-emit, reserved');
  // a fresh xell B (minted by provision, never joined) — mkdir its worktree so emitXellEnv can write
  const { x: b } = await provision({ meshEnabled: true });
  mkdirSync(b.worktree_path, { recursive: true });
  const KEY_B = 'KEY-1';   // the fake API mints KEY-1 first, then KEY-2, …
  await emitXellEnv(b.id, { meshSetupKey: KEY_B });
  let p = projection(b.worktree_path);
  ok(p.vars.SPINOFF_MESH_MGMT_URL === 'https://mesh.test.invalid',
     `the management URL is projected (${p.vars.SPINOFF_MESH_MGMT_URL ?? '(none)'})`);
  ok(p.vars.SPINOFF_MESH_SETUP_KEY === KEY_B,
     `the one-time setup key is projected while the row is minted (${p.vars.SPINOFF_MESH_SETUP_KEY ?? '(none)'})`);

  // a re-emit BEFORE join (rename/reconcile) must preserve the key from the file — it is the carrier
  await emitXellEnv(b.id);
  p = projection(b.worktree_path);
  ok(p.vars.SPINOFF_MESH_SETUP_KEY === KEY_B,
     'a re-emit before join PRESERVES the key from the current file (the key is never in the meta-DB)');

  // an environment can never override the two SPINOFF_MESH_* names (reserved)
  const envId = (await one(
    `INSERT INTO environment (project_id, key, tier, label, is_default)
     VALUES ($1,'dev','dev','mesh env fixture',true) RETURNING id`, [projId])).id;
  cleanups.push(() => q(`DELETE FROM environment WHERE id=$1`, [envId]));
  await q(`INSERT INTO environment_var (environment_id, name, value, is_secret)
           VALUES ($1,'WHICH_ENV','mesh-test',false),($1,'SPINOFF_MESH_SETUP_KEY','HIJACK',false)`, [envId]);
  await emitXellEnv(b.id);
  p = projection(b.worktree_path);
  ok(p.vars.WHICH_ENV === 'mesh-test', 'the dev environment still merges its ordinary vars');
  ok(p.vars.SPINOFF_MESH_SETUP_KEY === KEY_B && !/HIJACK/.test(p.text),
     'an environment cannot override SPINOFF_MESH_SETUP_KEY (reserved name holds)');

  // the sidecar answers → the sweep stamps B joined → a re-emit drops the consumed key
  const apiJoinB = makeApi({ peers: [{ id: 'p-B', hostname: b.slug, ip: '100.64.0.8', connected: true }] });
  await nb.markJoinedMeshPeers({ request: apiJoinB.request });
  const rowB = await one(`SELECT status FROM mesh_peer WHERE xell_id=$1`, [b.id]);
  ok(rowB.status === 'joined', 'B is joined after the sweep');
  await emitXellEnv(b.id);
  p = projection(b.worktree_path);
  ok(p.vars.SPINOFF_MESH_MGMT_URL === 'https://mesh.test.invalid'
     && p.vars.SPINOFF_MESH_SETUP_KEY === undefined,
     'after join the consumed key is DROPPED (a stale one-off key must never ride a recreated sidecar)');
  ok(!/HIJACK/.test(p.text), '…and the reserved name still never leaks from the environment');

  // mesh disabled → the whole mesh block leaves the file (the standing invariant, file-shaped)
  meshOff();
  await emitXellEnv(b.id);
  p = projection(b.worktree_path);
  ok(p.vars.SPINOFF_MESH_MGMT_URL === undefined && p.vars.SPINOFF_MESH_SETUP_KEY === undefined,
     'mesh disabled → no mesh lines in .zeehive.env at all (legacy projection is unchanged)');
  meshOn();

  // ── 6. meshBuildEnv (build-path relay) — {} on mesh-less, URL-only before the key exists ────────
  section('meshBuildEnv: the build-path relay reads the key from the worktree file');
  meshOff();
  const offEnv = meshBuildEnv(b.worktree_path, { manifest: meshOnManifest });
  ok(Object.keys(offEnv).length === 0, 'mesh disabled → meshBuildEnv is {} (legacy build env byte-identical)');
  meshOn();
  // B's file currently has no key (joined + last emit was mesh-off). Use a fresh minted xell C to
  // simulate the FIRST real-mode provision shape: minted row whose key has not been written yet.
  const { x: c } = await provision({ meshEnabled: true });
  mkdirSync(c.worktree_path, { recursive: true });
  const urlOnly = meshBuildEnv(c.worktree_path, { manifest: meshOnManifest });
  ok(urlOnly.SPINOFF_MESH_MGMT_URL === 'https://mesh.test.invalid'
     && urlOnly.SPINOFF_MESH_SETUP_KEY === undefined,
     'before the .zeehive.env exists the relay passes the mgmt URL only (sidecar idles without a key)');
  await emitXellEnv(c.id, { meshSetupKey: 'KEY-1' });
  const withKey = meshBuildEnv(c.worktree_path, { manifest: meshOnManifest });
  ok(withKey.SPINOFF_MESH_MGMT_URL === 'https://mesh.test.invalid'
     && withKey.SPINOFF_MESH_SETUP_KEY === 'KEY-1',
     'once the projection carries the key the relay passes it (the compose mesh service can join)');

  // ── 7. the health monitor wires the sweep (static) ────────────────────────────────────────────
  section('the health monitor wires the sweep');
  const containersSrc = readFileSync(new URL('../server/src/queenzee/containers.js', import.meta.url), 'utf8');
  ok(/import\s*{\s*markJoinedMeshPeers\s*}\s*from\s*'\.\.\/lib\/netbird\.js'/.test(containersSrc),
     'containers.js imports markJoinedMeshPeers');
  ok(/markJoinedMeshPeers\(\)/.test(containersSrc), '…and calls it from the container health tick');
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  meshOff();
  for (const c of cleanups.reverse()) { try { await c(); } catch { /* best-effort teardown */ } }
  for (const pid of [projId, projPlainId]) {
    if (!pid) continue;
    await q(`DELETE FROM environment WHERE project_id=$1`, [pid]).catch(() => {});
    await q(`DELETE FROM mesh_peer WHERE project_id=$1`, [pid]).catch(() => {});
    await q(`DELETE FROM xell_uses_container WHERE xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [pid]).catch(() => {});
    await q(`DELETE FROM container WHERE project_id=$1`, [pid]).catch(() => {});
    await q(`DELETE FROM xell WHERE project_id=$1`, [pid]).catch(() => {});
    await q(`DELETE FROM xource WHERE project_id=$1`, [pid]).catch(() => {});
    await q(`DELETE FROM pool_config WHERE project_id=$1`, [pid]).catch(() => {});
    await q(`DELETE FROM machine_pool WHERE project_id=$1`, [pid]).catch(() => {});
    await q(`DELETE FROM project WHERE id=$1`, [pid]).catch(() => {});
  }
  if (machineId) await q(`DELETE FROM machine WHERE id=$1`, [machineId]).catch(() => {});
  await pool.end().catch(() => {});
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);

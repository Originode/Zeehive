// NETBIRD MESH — control-plane client + peer lifecycle (lib/netbird.js, migration 249;
// docs/netbird-mesh-plan.md §3–§5, phase 1). A FAKE management-API adapter covers every
// control-plane branch with no NetBird anywhere; the mesh_peer intent rows run against a real
// postgres — DATABASE_URL.
//
// Covered:
//   • mesh DISABLED (no NETBIRD_API_URL/TOKEN) → every entry point is a legible no-op, and the
//     reap-time deregister still stamps intent rows (bookkeeping is not a control-plane call)
//   • mintPeer: group ensured, ONE-OFF setup key minted with auto_groups, intent row inserted —
//     and the key is in the ANSWER ONLY, never stored on the row
//   • active-hostname uniqueness: a second active peer on one hostname is refused by the index,
//     and a REMOVED row does not block the hostname's reuse
//   • markPeerJoined caches the control plane's LIVE half (nb_peer_id, ip) onto the row
//   • deregisterXellPeers: control-plane delete + row stamp; a failed delete KEEPS the row
//     active (the janitor retries); 404 = already gone = success
//   • sweepOrphanMeshPeers: removed-row peers and retired-slug peers are deleted; an UNKNOWN
//     hostname is reported, never deleted (the docker-repair unknown-slug stance)
//   • the reaper wires deregisterXellPeers (static), riding its own destructive verdict
//
// RUN:  DATABASE_URL=... node test/netbird-mesh.test.mjs
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { q, one, pool } from '../server/src/db/pool.js';
import { config } from '../server/src/config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nb = await import('../server/src/lib/netbird.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);
const cleanups = [];

// ── the fake management API: groups + setup keys + peers, plus a call log ──────────────────────
const makeApi = ({ peers = [], failDelete = false } = {}) => {
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
      const k = { id: `sk-${state.keys.length + 1}`, key: `KEY-${state.keys.length + 1}`, ...body };
      state.keys.push(k);
      return { status: 200, json: k };
    }
    if (method === 'GET' && path === '/api/peers') return { status: 200, json: state.peers };
    if (method === 'DELETE' && path.startsWith('/api/peers/')) {
      if (failDelete) return { status: 500, json: { message: 'control plane on fire (stub)' } };
      const id = decodeURIComponent(path.split('/').pop());
      const i = state.peers.findIndex((p) => p.id === id);
      if (i === -1) return { status: 404, json: null };
      state.peers.splice(i, 1);
      return { status: 200, json: null };
    }
    return { status: 500, json: { message: `stub: unhandled ${method} ${path}` } };
  };
  return { request, state };
};

try {
  section('disabled mesh is a legible no-op');
  ok(!nb.meshEnabled(), 'meshEnabled() is false with no NETBIRD_API_URL/TOKEN in the env');
  const off = await nb.mintPeer({ projectId: '00000000-0000-0000-0000-000000000000', kind: 'xell', hostname: 'x' });
  ok(off.ok === false && off.disabled === true, 'mintPeer answers disabled, never throws');
  const offReq = await nb.netbirdRequest('GET', '/api/peers');
  ok(offReq.status === 0 && /mesh disabled/.test(offReq.reason), 'the default adapter refuses legibly too');

  // Enable the mesh for the rest of the run — config is this process's singleton, and every call
  // below rides the injected fake adapter, so no real address is ever dialed.
  config.netbirdApiUrl = 'http://stub.invalid';
  config.netbirdApiToken = 'stub-token';

  section('meshFqdn (pure)');
  ok(nb.meshFqdn('wise-delta-a1b2') === `wise-delta-a1b2.${config.meshDomain}`, 'hostname + mesh domain');
  ok(nb.meshFqdn(null) === null, 'no hostname → null, never ".domain"');

  section('setup: project + xells');
  const proj = await one(
    `INSERT INTO project (name, repo_root) VALUES ('netbird-mesh-test', '/tmp/x') RETURNING id`);
  cleanups.push(() => q(`DELETE FROM project WHERE id=$1`, [proj.id]));
  const xource = await one(
    `INSERT INTO xource (project_id, ref) VALUES ($1, 'main') RETURNING id`, [proj.id]);
  cleanups.push(() => q(`DELETE FROM xource WHERE id=$1`, [xource.id]));
  const mkXell = (slug, status) => one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`, [proj.id, xource.id, slug, `spinoff/${slug}`, status]);
  const xell = await mkXell('mesh-live-1', 'claimed');
  const retired = await mkXell('mesh-retired-1', 'retired');
  cleanups.push(() => q(`DELETE FROM xell WHERE id IN ($1,$2)`, [xell.id, retired.id]));
  cleanups.push(() => q(`DELETE FROM mesh_peer WHERE project_id=$1`, [proj.id]));

  section('mintPeer');
  const api = makeApi();
  const minted = await nb.mintPeer(
    { projectId: proj.id, kind: 'xell', hostname: 'mesh-live-1', xellId: xell.id },
    { request: api.request });
  ok(minted.ok === true && minted.setupKey === 'KEY-1', 'the one-shot setup key is in the answer');
  ok(api.state.groups.some((g) => g.name === 'xells'), 'the kind group was ensured');
  ok(api.state.keys[0]?.auto_groups?.[0] === api.state.groups[0].id
     && api.state.keys[0]?.usage_limit === 1 && api.state.keys[0]?.ephemeral === true,
     'the key is one-off, usage-limit 1, ephemeral, auto-grouped');
  const row = await one(`SELECT * FROM mesh_peer WHERE hostname='mesh-live-1'`);
  ok(row?.status === 'minted' && row.nb_setup_key_id === 'sk-1' && row.xell_id === xell.id,
     'the intent row is inserted (kind binding, setup-key id for audit)');
  ok(!JSON.stringify(row).includes('KEY-1'), 'the key itself is NEVER stored');

  section('active-hostname uniqueness');
  const dup = await nb.mintPeer(
    { projectId: proj.id, kind: 'xell', hostname: 'mesh-live-1', xellId: xell.id },
    { request: api.request }).catch((e) => ({ ok: false, reason: e.message }));
  ok(dup.ok === false && /mesh_peer_active_hostname|duplicate/.test(dup.reason || ''),
     'a second ACTIVE peer on one hostname is refused by the index');

  section('markPeerJoined');
  api.state.peers.push({ id: 'p-1', hostname: 'mesh-live-1', ip: '100.64.0.7', connected: true });
  const joined = await nb.markPeerJoined('mesh-live-1', { request: api.request });
  ok(joined.ok === true, 'join marks ok');
  const jrow = await one(`SELECT * FROM mesh_peer WHERE hostname='mesh-live-1'`);
  ok(jrow.status === 'joined' && jrow.nb_peer_id === 'p-1' && String(jrow.ip) === '100.64.0.7',
     'the LIVE half (peer id + mesh IP) is cached onto the row');

  section('deregisterXellPeers');
  const failing = makeApi({ peers: [{ id: 'p-1', hostname: 'mesh-live-1' }], failDelete: true });
  const held = await nb.deregisterXellPeers(xell.id, { request: failing.request });
  ok(held.ok === false && held.removed === 0 && held.problems?.length === 1,
     'a failed control-plane delete KEEPS the row active (the janitor retries)');
  ok((await one(`SELECT removed_at FROM mesh_peer WHERE hostname='mesh-live-1'`)).removed_at === null,
     'the intent row is untouched by the failure');
  const dereg = await nb.deregisterXellPeers(xell.id, { request: api.request });
  ok(dereg.ok === true && dereg.removed === 1, 'delete + stamp on the happy path');
  ok(api.state.peers.length === 0, 'the control-plane peer is gone');
  const gone = await one(`SELECT * FROM mesh_peer WHERE hostname='mesh-live-1'`);
  ok(gone.status === 'removed' && gone.removed_at !== null, 'the row says removed, with a timestamp');
  ok((await nb.deregisterXellPeers(xell.id, { request: api.request })).removed === 0,
     'idempotent: nothing active → removed 0, ok');

  section('a removed hostname is reusable');
  const reuse = await nb.mintPeer(
    { projectId: proj.id, kind: 'xell', hostname: 'mesh-live-1', xellId: xell.id },
    { request: api.request });
  ok(reuse.ok === true, 'the partial unique index frees the hostname once the old row is removed');
  await q(`UPDATE mesh_peer SET status='removed', removed_at=now() WHERE id=$1`, [reuse.row.id]);

  section('sweepOrphanMeshPeers');
  const sweepApi = makeApi({ peers: [
    { id: 'p-removed', hostname: 'mesh-live-1' },      // newest row says removed → delete
    { id: 'p-retired', hostname: 'mesh-retired-1' },   // no row, slug is a RETIRED xell → delete
    { id: 'p-alien', hostname: 'somebody-elses-peer' } // no row, unknown slug → report only
  ] });
  const sweep = await nb.sweepOrphanMeshPeers({ request: sweepApi.request });
  ok(sweep.ok && sweep.deleted.includes('mesh-live-1') && sweep.deleted.includes('mesh-retired-1'),
     `dead-by-intent peers are deleted (${sweep.deleted.join(', ')})`);
  ok(sweep.unknown.includes('somebody-elses-peer')
     && sweepApi.state.peers.some((p) => p.id === 'p-alien'),
     'an unknown hostname is reported, NEVER deleted');

  section('the reaper wires the deregister (static)');
  const reaper = readFileSync(resolve(ROOT, 'server/src/queenzee/reaper.js'), 'utf8');
  ok(/import\s*{\s*deregisterXellPeers\s*}\s*from\s*'\.\.\/lib\/netbird\.js'/.test(reaper),
     'reaper imports deregisterXellPeers');
  ok(/deregisterXellPeers\(xellId,\s*{\s*controlPlane:\s*destructive\s*}\)/.test(reaper),
     'and the control-plane delete rides the reap\'s own destructive verdict');
} finally {
  for (const c of cleanups.reverse()) { try { await c(); } catch { /* best-effort teardown */ } }
  await pool.end();
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);

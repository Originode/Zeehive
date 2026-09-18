// THE MESH CONFIG STORE, LIVE (migration 259 + lib/mesh-config.js + lib/mesh-status.js + the
// console routes) — the db-backed half of test/mesh-config.test.mjs.
//
// Runs against a REAL postgres (DATABASE_URL; `zee db-sandbox --migrate` in a cage), so it proves
// the migration itself (the table, its checks, the upsert), the store-over-env precedence against
// the real config seam, and the HTTP contract the console builds against — FIELDS IN, HINTS OUT.
//
// Covered here:
//   • PUT stores the row; GET returns values + { set, hint } per secret and NEVER a secret value
//   • "generate" mints a valid datastore key server-side through the route (the human act)
//   • store-over-env: the console's domain/port/secrets take over `config`; ENV is still honored
//     for every field the row does not set (the backcompat the card requires)
//   • `enabled: false` is inert — the env rules again, the row is only a draft
//   • clearing (null) and rotating a secret; a CHANGE-ME paste is a 400 naming the field
//   • mesh-status: the management probe (bounded, injected), the mesh_peer counts by status, and
//     the route-source tally summary
//   • applyMeshConfig on a fresh boot with no row leaves the env exactly as it was
import { randomUUID } from 'node:crypto';
import express from 'express';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (s) => console.log(`\n── ${s} ──`);

const { q, one, pool } = await import('../server/src/db/pool.js');
const { config } = await import('../server/src/config.js');
const mc = await import('../server/src/lib/mesh-config.js');
const { meshStatusFor, peerCounts } = await import('../server/src/lib/mesh-status.js');
const { router } = await import('../server/src/api/routes.js');

const tag = randomUUID().slice(0, 8);
const machineIds = [];
const projectIds = [];
let machineId = null;

const app = express();
app.use(express.json());
app.use('/api', router);
const server = app.listen(0, '127.0.0.1');
await new Promise((res) => server.once('listening', res));
const BASE = `http://127.0.0.1:${server.address().port}/api`;
const fetchJSON = async (u, opts = {}) => {
  const r = await fetch(u, opts);
  let data = null;
  try { data = await r.json(); } catch { /* no body */ }
  return { status: r.status, data };
};
const putJSON = (u, body) => fetchJSON(u, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// The config seam keys this test moves; restored in the finally so a later suite is unaffected.
const SEAM = ['netbirdApiUrl', 'netbirdApiToken', 'meshDomain', 'netbirdSignalUri', 'netbirdRelayEndpoint',
  'netbirdDatastoreEncryptionKey', 'netbirdRelayAuthSecret', 'netbirdGatewaySetupKey',
  'netbirdMgmtGrpcPort', 'netbirdMgmtApiPort', 'netbirdSignalPort', 'netbirdRelayPort', 'netbirdDashHttpPort'];
const saved = Object.fromEntries(SEAM.map((k) => [k, config[k]]));
// A baseline env the installation had BEFORE the console existed.
const ENV_DOMAIN = 'env-baseline.example';
const ENV_RELAY_SECRET = 'env-relay-secret-0123456789';
const NEW_KEY = Buffer.alloc(32, 11).toString('base64');
const UUID = (s) => s;

try {
  machineId = (await one(
    `INSERT INTO machine (key, docker_ctx, can_build, enabled) VALUES ($1,$2,true,true) RETURNING id`,
    [`mc-${tag}`, `zt-mc-${tag}`])).id;
  machineIds.push(machineId);
  const machine = { id: machineId, key: `mc-${tag}`, docker_ctx: `zt-mc-${tag}` };

  // The pre-console installation: an env that already had a domain + relay secret.
  config.meshDomain = ENV_DOMAIN;
  config.netbirdRelayAuthSecret = ENV_RELAY_SECRET;
  config.netbirdDatastoreEncryptionKey = null;
  config.netbirdApiUrl = null;
  config.netbirdApiToken = null;
  config.netbirdMgmtApiPort = 33074;

  section('a fresh boot with no row leaves the env exactly as it was');
  {
    const before = { ...config };
    const r = await mc.applyMeshConfig({ machineId });
    ok(r.applied === false && /no console mesh config/.test(r.reason), 'no row → not applied, and the reason says so');
    ok(config.meshDomain === before.meshDomain && config.netbirdRelayAuthSecret === before.netbirdRelayAuthSecret,
       'the env is untouched (the backcompat the card requires)');
    const read = await mc.meshConfigFor(machineId);
    ok(read.configured === false && read.enabled === false && read.resolved.values.mesh_domain === ENV_DOMAIN,
       'and the read model still shows the env\'s domain as what would be used');
  }

  section('PUT /mesh-config — fields in, hints out');
  {
    const put = await putJSON(`${BASE}/machines/${machineId}/mesh-config`, {
      by: 'tester@console', enabled: true, mesh_domain: 'mesh.console',
      mgmt_api_port: 3443, signal_uri: 'netbird-signal:10000',
      datastore_encryption_key: 'generate', relay_auth_secret: 'generate',
    });
    ok(put.status === 200 && put.data.enabled === true, `the write is accepted [${put.status}]`);
    const key = (await one(`SELECT datastore_encryption_key FROM mesh_config WHERE machine_id=$1`, [machineId])).datastore_encryption_key;
    ok(mc.isValidDatastoreKey(key), 'the row holds a server-side generated, valid 32-byte base64 key');
    ok(put.data.secrets.datastore_encryption_key.hint === `…${key.slice(-4)}`, 'and the API answered its HINT');
    ok(!JSON.stringify(put.data).includes(key) && !JSON.stringify(put.data).includes(ENV_RELAY_SECRET)
       && !/CHANGE-ME/.test(JSON.stringify(put.data)),
       'no secret value appears anywhere in the response');
    const got = await fetchJSON(`${BASE}/machines/${machineId}/mesh-config`);
    ok(got.status === 200 && got.data.values.mesh_domain === 'mesh.console' && got.data.values.mgmt_api_port === 3443,
       'GET returns the row\'s values');
    ok(got.data.secrets.api_token.set === false && got.data.secrets.api_token.hint === null, 'an unset secret reads as unset');
  }

  section('store-over-env into the config seam, env still honored elsewhere');
  {
    const r = await mc.applyMeshConfig({ machineId });
    const key = (await one(`SELECT datastore_encryption_key FROM mesh_config WHERE machine_id=$1`, [machineId])).datastore_encryption_key;
    ok(r.applied === true, 'an enabled row is applied');
    ok(config.meshDomain === 'mesh.console' && config.netbirdMgmtApiPort === 3443, 'the row\'s domain and port took over the env');
    ok(config.netbirdDatastoreEncryptionKey === key, 'the row\'s generated key is in the seam (the stand-up renders management.json from it)');
    ok(config.netbirdRelayAuthSecret !== ENV_RELAY_SECRET && config.netbirdRelayAuthSecret.length === 64,
       'the row\'s generated relay secret beat the env one');
    ok(config.netbirdSignalUri === 'netbird-signal:10000' && config.netbirdRelayEndpoint === null,
       'a set field from the row and an untouched one from the env are resolved in the same pass');
    ok(config.netbirdApiUrl === 'https://netbird-management:443', 'an enabled row with no URL gets the compose-internal default');
  }

  section('the read model reports where each value came from');
  {
    const read = await mc.meshConfigFor(machineId);
    ok(read.resolved.source.mesh_domain === 'store' && read.resolved.source.mgmt_api_port === 'store'
       && read.resolved.source.relay_endpoint === 'unset',
       `per-field sources: ${JSON.stringify(read.resolved.source.mesh_domain)}/${read.resolved.source.mgmt_api_port}/${read.resolved.source.relay_endpoint}`);
    ok(read.resolved.readiness.ready === true && read.resolved.readiness.missing.length === 0,
       'readiness is green now that both management.json secrets exist');
    ok(read.is_queenzee_host === false, 'a machine that is not the queenzee host is marked as such');
  }

  section('editable is the panel\'s read-only note, and the same fact the stand-up plan uses');
  {
    const offHost = await mc.meshConfigFor(machineId);
    ok(offHost.editable === false,
       'a machine that is not the queenzee host cannot stand the plane up — the panel says read-only');
    // The mesh-profile services live in the queenzee's OWN compose project, so the ctx IS the
    // answer. Flip it and back rather than inserting a second `default` machine, which would be
    // visible to every other resolver for the length of the test.
    await q(`UPDATE machine SET docker_ctx='default' WHERE id=$1`, [machineId]);
    try {
      const onHost = await mc.meshConfigFor(machineId);
      ok(onHost.editable === true && onHost.is_queenzee_host === true,
         'the queenzee host itself is editable — configure and stand up');
    } finally {
      await q(`UPDATE machine SET docker_ctx=$1 WHERE id=$2`, [machine.docker_ctx, machineId]);
    }
  }

  section('the console\'s own field name (management_url) round-trips as api_url');
  {
    const put = await putJSON(`${BASE}/machines/${machineId}/mesh-config`, { management_url: 'https://mgmt.console:443' });
    ok(put.status === 200, `the console's PUT is accepted [${put.status}]`);
    ok(put.data.fields.management_url === 'https://mgmt.console:443' && put.data.fields.mesh_domain === 'mesh.console',
       `GET projects the row under the console's field names [${JSON.stringify(put.data.fields)}]`);
    ok(put.data.values.api_url === 'https://mgmt.console:443', 'and the write landed in the canonical column');
    const cleared = await putJSON(`${BASE}/machines/${machineId}/mesh-config`, { management_url: null });
    ok(cleared.data.fields.management_url === null, 'a cleared management_url reads back empty, not stale');
  }

  section('a config-carrying console write ENABLES the machine (no separate on switch in the panel)');
  {
    const second = (await one(
      `INSERT INTO machine (key, docker_ctx, can_build, enabled) VALUES ($1,$2,true,true) RETURNING id`,
      [`mc-${tag}-c`, `zt-mc-${tag}-c`])).id;
    machineIds.push(second);
    // The panel's save body is {...fields} + non-empty secret drafts — no `enabled`.
    const put = await putJSON(`${BASE}/machines/${second}/mesh-config`, {
      management_url: 'https://mgmt.console:443', mesh_domain: 'mesh.console', datastore_encryption_key: 'generate' });
    ok(put.data.enabled === true && put.data.applied === true,
       `a row the console filled in is ENABLED and applied [enabled ${put.data.enabled}]`);
    ok(config.netbirdApiUrl === 'https://mgmt.console:443',
       'so the queenzee can reach the plane it just described, before any stand-up ran');
    // An UPDATE never flips the switch, and an explicit value always wins.
    const off = await putJSON(`${BASE}/machines/${second}/mesh-config`, { enabled: false });
    const stillOff = await putJSON(`${BASE}/machines/${second}/mesh-config`, { mesh_domain: 'mesh.again' });
    ok(off.data.enabled === false && stillOff.data.enabled === false,
       'disabling is sticky across later writes (an update does not re-enable)');
  }

  section('a write carrying NO configuration never enables the mesh by itself');
  {
    // The route strips `by`, so `{}` here is what an empty body (or the panel's save before its
    // config read resolved, when `fields` is still {}) actually sends. It is not a decision: no row,
    // no enabled default, nothing for the chrome to read as a configured-but-unreachable plane.
    const third = (await one(
      `INSERT INTO machine (key, docker_ctx, can_build, enabled) VALUES ($1,$2,true,true) RETURNING id`,
      [`mc-${tag}-d`, `zt-mc-${tag}-d`])).id;
    machineIds.push(third);
    const empty = await putJSON(`${BASE}/machines/${third}/mesh-config`, {});
    ok(empty.status === 200 && empty.data.enabled === false && empty.data.applied === false,
       `an empty write enables nothing [enabled ${empty.data.enabled}]`);
    const none = await one(`SELECT 1 AS x FROM mesh_config WHERE machine_id=$1`, [third]);
    ok(!none, 'and it plants no row at all');
  }

  section('a disabled row is inert; the env rules again');
  {
    await putJSON(`${BASE}/machines/${machineId}/mesh-config`, { enabled: false });
    const read = await mc.meshConfigFor(machineId);
    ok(read.enabled === false && read.configured === true, 'the draft is stored but disabled');
    // Put the seam back to what the console wrote, then re-apply: a disabled row must not write.
    config.meshDomain = ENV_DOMAIN; config.netbirdMgmtApiPort = 33074;
    const r = await mc.applyMeshConfig({ machineId });
    ok(r.applied === false && /disabled/.test(r.reason), 'applyMeshConfig refuses to apply it');
    ok(config.meshDomain === ENV_DOMAIN && config.netbirdMgmtApiPort === 33074, 'and the env is what stands');
    await putJSON(`${BASE}/machines/${machineId}/mesh-config`, { enabled: true });
  }

  section('clearing, rotating, and refusing a bad secret — all by name');
  {
    const cleared = await putJSON(`${BASE}/machines/${machineId}/mesh-config`, { relay_auth_secret: null });
    ok(cleared.status === 200 && cleared.data.secrets.relay_auth_secret.set === false, 'null clears a secret');
    const rotated = await putJSON(`${BASE}/machines/${machineId}/mesh-config`, { datastore_encryption_key: NEW_KEY });
    ok(rotated.data.secrets.datastore_encryption_key.hint === `…${NEW_KEY.slice(-4)}`, 'a pasted key replaces the generated one');
    const bad = await putJSON(`${BASE}/machines/${machineId}/mesh-config`, { datastore_encryption_key: 'CHANGE-ME-nope' });
    ok(bad.status === 400 && /placeholder/.test(bad.data.error), `a CHANGE-ME paste is a 400 that names the field [${bad.status}]`);
    const typo = await putJSON(`${BASE}/machines/${machineId}/mesh-config`, { mesh_domian: 'x.example' });
    ok(typo.status === 400 && /unknown mesh config field/.test(typo.data.error), 'a typo is refused, never dropped');
    const genToken = await putJSON(`${BASE}/machines/${machineId}/mesh-config`, { api_token: 'generate' });
    ok(genToken.status === 400 && /control plane/.test(genToken.data.error), 'the API token cannot be generated server-side');
    const missing = await fetchJSON(`${BASE}/machines/${randomUUID()}/mesh-config`);
    ok(missing.status === 400 && /machine not found/.test(missing.data.error), 'an unknown machine is a named 400');
  }

  section('the stand-up\'s first-PAT write: recorded write-only, and applied');
  {
    // What recordBootstrappedPat does after netbird-bootstrap.js mints the token (proven live in
    // test/netbird-live-api.test.mjs; its wiring into the step is proven in build-bootstrap.test.mjs).
    const pat = `nbp_${'A'.repeat(36)}`;
    const read = await mc.recordBootstrappedPat(machineId, pat, { values: { ...mc.envSnapshot(), mesh_domain: 'mesh.console', mgmt_api_port: 3443, datastore_encryption_key: NEW_KEY } });
    ok(read.secrets.api_token.set === true && read.secrets.api_token.hint === 'nbp_…AAAA', 'the PAT is stored and only its hint is readable');
    const raw = await one(`SELECT api_token FROM mesh_config WHERE machine_id=$1`, [machineId]);
    ok(raw.api_token === pat, 'the store holds the value itself (write-only, not write-never)');
    ok(config.netbirdApiToken === pat && config.netbirdApiUrl, 'and lib/netbird.js now resolves URL+token from the store');
    const boot = await import('../server/src/lib/netbird.js');
    ok(boot.meshEnabled() === true, 'meshEnabled() is true — the queenzee can talk to the plane it stood up');
  }

  section('GET /mesh-status — probe, peer counts, route tally');
  {
    const projectId = (await one(
      `INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`, [`mc-${tag}`, '/tmp/mc'])).id;
    projectIds.push(projectId);
    // Peers for THIS machine (joined + minted + degraded) and one for ANOTHER — the counts must be
    // this machine's, and every status must be present in the answer even at zero.
    const otherMachine = (await one(
      `INSERT INTO machine (key, docker_ctx, can_build, enabled) VALUES ($1,$2,true,true) RETURNING id`,
      [`mc-${tag}-b`, `zt-mc-${tag}-b`])).id;
    machineIds.push(otherMachine);
    const mk = (status, hostname, mid) => q(
      `INSERT INTO mesh_peer (project_id, kind, hostname, machine_id, status) VALUES ($1,'machine',$2,$3,$4)`,
      [projectId, hostname, mid, status]);
    await mk('joined', `mc-${tag}-a`, machineId);
    await mk('minted', `mc-${tag}-b`, machineId);
    await mk('degraded', `mc-${tag}-c`, machineId);
    await mk('joined', `mc-${tag}-other`, otherMachine);
    ok(JSON.stringify(peerCounts([{ status: 'joined', n: 2 }, { status: 'bogus', n: 5 }])) ===
       JSON.stringify({ total: 7, by_status: { minted: 0, joined: 2, removed: 0, degraded: 0 }, active: 2 }),
       'peerCounts is pure, starts every status at zero, and ignores an unknown one');
    const probeArgs = [];
    const status = await meshStatusFor(machine, {
      probe: async (args) => { probeArgs.push(args); return { ok: true, host: 'netbird-management', port: 443, url: 'https://netbird-management:443', verdict: 'ok' }; },
      tally: async () => ({ window_days: 14, by_source: { mesh: 5, 'legacy-port': 1 }, by_kind: {}, days: [], error: null }),
    });
    ok(status.management.ok === true && status.management.host === 'netbird-management', 'the probe verdict is reported');
    ok(probeArgs[0]?.attempts === 2, 'the probe is the BOUNDED two-dial read, not the stand-up\'s retry loop');
    ok(status.peers.total === 3 && status.peers.by_status.joined === 1 && status.peers.by_status.minted === 1
       && status.peers.by_status.degraded === 1 && status.peers.by_status.removed === 0,
       `counts are this machine\'s, by status [${JSON.stringify(status.peers.by_status)}]`);
    ok(status.routes.by_source.mesh === 5 && status.routes.by_source['legacy-port'] === 1 && status.routes.window_days === 14,
       'the route-source tally summary is the telemetry phase 5 is gated on');
    // The console's projection of the same facts (web/src/Mesh.jsx): peers.counts, peers.list,
    // management.reachable, tally — emitted alongside the canonical keys so the panel needs no
    // translation layer, and pinned here so the two shapes cannot drift apart silently.
    ok(status.peers.counts.total === 3 && status.peers.counts.joined === 1 && status.peers.counts.removed === 0,
       'peers.counts is by_status + total under the console\'s name');
    ok(status.peers.list.length === 3 && status.peers.list.every((p) => p.hostname && p.kind === 'machine' && p.status),
       'peers.list carries the rows themselves (hostname · kind · status)');
    ok(status.management.reachable === true && status.management.error === undefined,
       'management.reachable mirrors the probe');
    ok(status.tally === status.routes && Array.isArray(status.tally.days),
       'tally is the console\'s name for the same route summary, days included');
    ok(status.mesh.api_token.set === true && status.mesh.api_token.hint === 'nbp_…AAAA'
       && !JSON.stringify(status).includes(`nbp_${'A'.repeat(36)}`),
       'status carries the token HINT only — never the value');
    // The real route, against the real table — the probe will fail (no plane resolves here), which
    // is exactly the bounded, non-throwing answer a status page must give.
    const http = await fetchJSON(`${BASE}/machines/${machineId}/mesh-status`);
    ok(http.status === 200 && http.data.peers.total === 3 && http.data.management.ok === false,
       `GET /mesh-status answers 200 with the peer counts and a non-ok probe [${http.data.management?.verdict}]`);
    const notFound = await fetchJSON(`${BASE}/machines/${randomUUID()}/mesh-status`);
    ok(notFound.status === 404, 'an unknown machine is a 404');
  }
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  try {
    for (const k of SEAM) config[k] = saved[k];
    for (const id of projectIds) {
      await q(`DELETE FROM mesh_peer WHERE project_id=$1`, [id]).catch(() => {});
      await q(`DELETE FROM project WHERE id=$1`, [id]).catch(() => {});
    }
    for (const id of machineIds) await q(`DELETE FROM machine WHERE id=$1`, [id]).catch(() => {});
  } catch (e) { console.error('CLEANUP ERROR:', e); }
  server.close();
  await pool.end();
  console.log(fail ? `\n${fail} FAILED` : '\nall good');
  process.exit(fail ? 1 : 0);
}

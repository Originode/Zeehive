// DEVICE XHIPS — the driver's pure transforms + the DB-backed register/discover paths (035/048).
// The pure parts (deviceConfig, deviceLoop) run with no DB. The register + auto-discover paths run
// the REAL lib/devices.js against this xell's isolated DB (self-namespaced fixtures, cleaned up),
// in PROVISION_MODE=simulate so no docker side effects fire. Skipped when no DATABASE_URL is set.
process.env.PROVISION_MODE = 'simulate';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { deviceConfig, deviceLoop, registerPhysicalDevice, discoverUsbDevices, deviceBootState, listAdbDevices } =
  await import('../server/src/lib/devices.js');

// ── deviceConfig: the manifest device block → resolved config (pure) ──────────────────────────────
test('deviceConfig: absent block → disabled, emulator defaults', () => {
  const c = deviceConfig({ manifest: {} });
  assert.equal(c.enabled, false);
  assert.equal(c.kind, 'emulator');
  assert.equal(c.auto, false);
  assert.equal(c.adbBase, 5600);
  assert.equal(c.vncBase, 6700);
  assert.equal(c.cxellImage, null);
});

test('deviceConfig: a physical device project with a custom cxell image + ports', () => {
  const c = deviceConfig({ manifest: {
    device: { enabled: true, kind: 'physical', cxell_image: 'zeehive/zee-agent-android', auto: true },
    tiers: { spinoff: { ports: { device: { adb_base: 5800, viewer_base: 6900 } } } },
  } });
  assert.equal(c.enabled, true);
  assert.equal(c.kind, 'physical');
  assert.equal(c.auto, true);
  assert.equal(c.cxellImage, 'zeehive/zee-agent-android');
  assert.equal(c.adbBase, 5800);
  assert.equal(c.vncBase, 6900);
});

test('deviceConfig: an unknown kind falls back to emulator', () => {
  assert.equal(deviceConfig({ manifest: { device: { enabled: true, kind: 'nonsense' } } }).kind, 'emulator');
});

// ── deviceLoop: the build→install→run→observe recipe (pure) ───────────────────────────────────────
test('deviceLoop: every adb command is prefixed and screenshot Reads back', () => {
  const handle = { adb_prefix: 'adb -s host:5600', connect: 'adb connect host:5600',
                   transport: 'emulator', kind: 'emulator', viewer_url: 'http://h:6700' };
  const loop = deviceLoop(handle);
  assert.ok(loop.install.startsWith('adb -s host:5600 install'));
  assert.ok(loop.launch.includes('am start'));
  assert.ok(loop.screenshot.includes('screencap -p'));
  assert.equal(loop.viewer, 'http://h:6700');
  assert.match(loop.note, /throwaway/);   // emulator note
});

test('deviceLoop: a shared physical device is told to clean up after itself', () => {
  const loop = deviceLoop({ adb_prefix: 'adb -H h -P 5037 -s S', connect: 'x', transport: 'usb-shared', kind: 'physical' });
  assert.match(loop.note, /SHARED real device/);
});

// ── deviceBootState: inconclusive in simulate (no docker exec) ─────────────────────────────────────
test('deviceBootState: simulate mode is always inconclusive (never traps a device)', async () => {
  assert.equal(await deviceBootState({ docker_ctx: 'default', name: 'x' }), 'unknown');
});

// ── DB-backed: register + auto-discover ───────────────────────────────────────────────────────────
const hasDb = !!process.env.DATABASE_URL;
test('register + discover against the isolated DB', { skip: hasDb ? false : 'no DATABASE_URL' }, async (t) => {
  const { q, one, pool } = await import('../server/src/db/pool.js');
  const tag = randomUUID().slice(0, 8);
  const projId = (await one(`INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`,
    [`zt-dev-${tag}`, `/tmp/zt-${tag}`])).id;
  const machId = (await one(
    `INSERT INTO machine (key, docker_ctx, can_device, max_xells, enabled)
     VALUES ($1,$2,true,0,true) RETURNING id`, [`zt-dev-${tag}`, `zt-ctx-${tag}`])).id;

  t.after(async () => {
    await q(`DELETE FROM container WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM machine WHERE id=$1`, [machId]);
    await q(`DELETE FROM project WHERE id=$1`, [projId]);
    await pool.end();
  });

  // NETWORK device → address-based adb prefix
  const net = await registerPhysicalDevice({ projectId: projId, machineId: machId,
    transport: 'net', adbPort: 5555, host: '10.0.0.9' });
  assert.equal(net.device.transport, 'network');
  assert.equal(net.device.adb_prefix, 'adb -s 10.0.0.9:5555');
  assert.equal(net.device.connect, 'adb connect 10.0.0.9:5555');

  // USB device → server-based adb prefix, serial from conn_ref
  const usb = await registerPhysicalDevice({ projectId: projId, machineId: machId,
    transport: 'usb', serial: 'ABC123' });
  assert.equal(usb.device.transport, 'usb-shared');
  assert.equal(usb.device.serial, 'ABC123');
  assert.equal(usb.device.adb_prefix, `adb -H ${usb.device.adb_host} -P ${usb.device.adb_port} -s ABC123`);
  assert.equal(usb.device.adb_port, 5037);   // the shared adb-server port, not a per-device port

  // a usb device with no serial is refused
  await assert.rejects(() => registerPhysicalDevice({ projectId: projId, machineId: machId, transport: 'usb' }),
    /serial/);

  // auto-discovery in simulate: adb-host returns nothing → nothing registered, honest arrays
  const disc = await discoverUsbDevices(machId, { projectId: projId });
  assert.equal(disc.ok, true);
  assert.deepEqual(disc.registered, []);
  assert.deepEqual(disc.skipped, []);

  // listAdbDevices: simulate short-circuits to an empty listing (no adb/docker side effects)
  const listed = await listAdbDevices(machId, { projectId: projId });
  assert.equal(listed.ok, true);
  assert.equal(listed.source, 'simulate');
  assert.deepEqual(listed.devices, []);

  // decommission a SHARED physical device removes only the registration row — there is no container
  // to stop, so docker is skipped (not a failed/orphaned stop) and the phone is untouched.
  const { decommissionContainer } = await import('../server/src/queenzee/containers.js');
  const dev = await registerPhysicalDevice({ projectId: projId, machineId: machId, transport: 'net', host: '10.0.0.5', adbPort: 5555 });
  const dec = await decommissionContainer(dev.device.id, { force: false });
  assert.equal(dec.ok, true);
  assert.equal(dec.docker?.skipped, true);   // physical device: no container, docker step skipped
  assert.equal(dec.orphaned, false);
  assert.equal(await one(`SELECT id FROM container WHERE id=$1`, [dev.device.id]), null);
});

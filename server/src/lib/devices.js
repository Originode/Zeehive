// Device xhips — the driver that ATTACHES a mobile device to a xell so a zee can build apps into
// it. A device is just another container row (role='device'), so the health monitor, decommission
// and reaper already carry it; this module owns only the parts that ARE new: what the container is
// (an Android emulator image, or a link to a physical phone), which host can run it (KVM), and how
// a zee reaches it (adb over TCP).
//
// Two shapes under one role:
//   emulator (per-xell)  : docker-run budtmo/docker-android on a can_device machine, on zee-hive-net,
//                          adb published + a noVNC viewer. owner_xell_id set → the reaper tears it
//                          down with the xell, no extra code.
//   physical (shared)    : a real phone reachable over network adb, pre-registered as a shared device
//                          row on a machine; a xell LINKS it ('uses'), like a shared dev db. Released
//                          (unlinked) at teardown; never removed.
//
// Reachability: the cxell runs on the queenzee's local daemon while a device runs on a (Linux)
// can_device machine — a different daemon — so they MEET OVER TCP on the LAN, exactly as the cxell
// already reaches its app tier ("co-location is unnecessary; they meet over TCP"). The binding hands
// the zee `adb connect <host_ip>:<adb_port>`; the egress firewall is default-allow, so nothing opens.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pool, q, one } from '../db/pool.js';
import { config } from '../config.js';
import { broadcast } from './events.js';
import { logline } from './logbus.js';
import { cleanGitEnv } from './git.js';
import { computePorts } from './provision.js';
import { namingFor } from './manifest.js';
import { deviceCapableMachine, machineForCtx } from './machines.js';

const MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

// The Android emulator image. budtmo/docker-android boots an AVD and exposes adb (5555) + a noVNC
// web viewer (6080); the tag names the API level. Overridable per-project (manifest device.image)
// and per-install (env), because the "right" Android version is a project's call, not ours.
const DEFAULT_EMULATOR_IMAGE = process.env.DEVICE_EMULATOR_IMAGE || 'budtmo/docker-android:emulator_14';
const ADB_INTERNAL = 5555;   // the port adb listens on inside the emulator image
const VNC_INTERNAL = 6080;   // the noVNC web viewer inside the emulator image
const ADB_SERVER_PORT = Number(process.env.ADB_SERVER_PORT) || 5037;   // the shared adb server (usb host)
// The container that shares a machine's USB-attached phones over TCP (see provisionAdbHost). sorccu/adb
// is the long-standing tiny "adb server over the network" image; override for a pinned/own build.
const ADB_HOST_IMAGE = process.env.ADB_HOST_IMAGE || 'sorccu/adb';

// The project's device declaration (manifest `device:` block). enabled is the gate; everything else
// has a sane default so a project can opt in with a single `device: { enabled: true }`.
export function deviceConfig(project) {
  const d = project?.manifest?.device || {};
  const ports = project?.manifest?.tiers?.spinoff?.ports?.device || {};
  return {
    enabled: !!d.enabled,
    kind: d.kind === 'physical' ? 'physical' : 'emulator',
    image: d.image || DEFAULT_EMULATOR_IMAGE,
    // The cxell image this project's zee runs in. A device project that BUILDS apps sets this to the
    // Android SDK variant (docker/zeehive/Dockerfile.zee-agent-android → zeehive/zee-agent-android) so
    // the zee has JDK+SDK for `./gradlew`; null → the slim base. Read by spawnCxell.
    cxellImage: d.cxell_image || null,
    // auto=true attaches a device at DISPATCH; default false keeps it lazy/on-demand (`zee device`) —
    // an emulator is heavy (~GB RAM + a CPU), so we never boot one for a xell that may not test on it.
    auto: !!d.auto,
    adbBase: Number(ports.adb_base) || 5600,
    vncBase: Number(ports.viewer_base) || 6700,
    emulatorDevice: d.emulator_device || process.env.DEVICE_EMULATOR_NAME || 'Samsung Galaxy S10',
  };
}

// The device already attached to this xell, if any (the resolved handle a zee/binding reads).
export async function deviceForXell(xellId) {
  const c = await one(
    `SELECT c.*, host(c.host) AS host_addr FROM xell_uses_container uc
       JOIN container c ON c.id = uc.container_id
      WHERE uc.xell_id = $1 AND c.role = 'device' LIMIT 1`, [xellId]);
  if (!c) return null;
  return deviceHandle(c);
}

// The shape both the binding and the `zee device` verb hand back: how to REACH the device + the exact
// build→install→run→observe loop, so a zee never has to guess the commands. Three transports, one
// contract — `adbPrefix` is the ready-made `adb …` command prefix for every later call:
//   emulator / network-adb : the device speaks adb over its OWN tcp addr → `adb connect host:port`,
//                            then `adb -s host:port …`.
//   usb-shared             : the device is USB-plugged into a MACHINE whose adb SERVER is shared over
//                            tcp (host:5037) — no `adb connect`; talk to that server and target the
//                            device by its real serial → `adb -H host -P 5037 -s <serial> …`.
// The usb case is encoded on the row as conn_ref='usb:<serial>' with host_port = the shared adb
// server port; everything else is address-based.
function deviceHandle(c) {
  const host = c.host_addr || c.host || 'localhost';
  const usbSerial = typeof c.conn_ref === 'string' && c.conn_ref.startsWith('usb:')
    ? c.conn_ref.slice(4) : null;
  const transport = usbSerial ? 'usb-shared' : (c.isolation === 'per-xell' ? 'emulator' : 'network');
  const adbPrefix = usbSerial
    ? `adb -H ${host} -P ${c.host_port} -s ${usbSerial}`
    : `adb -s ${host}:${c.host_port}`;
  const connect = usbSerial
    ? `adb -H ${host} -P ${c.host_port} devices   # USB-shared: ${usbSerial} should be listed (no 'adb connect' needed)`
    : `adb connect ${host}:${c.host_port}`;
  return {
    id: c.id,
    role: 'device',
    name: c.name,
    kind: c.isolation === 'per-xell' ? 'emulator' : 'physical',
    transport,
    platform: 'android',
    health: c.health,
    adb_host: host,
    adb_port: c.host_port,
    serial: usbSerial || `${host}:${c.host_port}`,   // the `-s` target
    connect,                                          // run this first
    adb_prefix: adbPrefix,                            // then every command is `${adb_prefix} …`
    viewer_url: c.url || null,                        // noVNC web screen (emulator only)
    image: c.image_tag || null,
    docker_ctx: c.docker_ctx || null,
  };
}

// The human-facing "how a zee drives this device" block — spelled out because a zee guessing adb
// invocations wastes its turn. Mirrors the `build`/`db` sections of the xell binding.
export function deviceLoop(handle, { buildApkHint = './gradlew assembleDebug' } = {}) {
  const p = handle.adb_prefix;
  return {
    how: 'This is YOUR Android device — build your app, install it, launch it, and VERIFY it visually. '
       + `It is reachable over adb (already firewall-allowed) as a ${handle.transport} device. Run the `
       + 'connect line once, then every command is the adb_prefix below.',
    connect: handle.connect,
    adb_prefix: p,
    build_apk: buildApkHint,
    install: `${p} install -r <path-to>.apk`,
    launch: `${p} shell am start -n <package>/.MainActivity`,
    logcat: `${p} logcat -d`,
    screenshot: `${p} exec-out screencap -p > /tmp/shot.png   # then Read /tmp/shot.png to SEE your app`,
    viewer: handle.viewer_url,
    note: 'VERIFY WITH YOUR EYES: after launching, capture a screenshot and Read it — a build that '
        + 'installs is not a build that works. Use logcat to read crashes/stack traces.'
        + (handle.kind === 'emulator' ? ' The device is throwaway (torn down with this xell), so install/uninstall freely.'
           : ' This is a SHARED real device — clean up after yourself (uninstall your app when done).'),
  };
}

// WHERE an emulator can run: the first can_device machine (a machine-wide capability). Refused with the
// FIX when none exists, so "no device host" is an actionable message, not a crash-looping container.
async function pickDeviceHost(preferCtx = null) {
  if (preferCtx) {
    const m = await machineForCtx(preferCtx);
    if (m?.can_device && m.enabled) return m;
  }
  const m = await deviceCapableMachine();
  if (!m) {
    throw new Error('no can_device machine — an Android emulator needs a Linux host with /dev/kvm. '
      + 'Mark a machine can_device in the console (container matrix → machine knobs), or tether a '
      + 'physical device to one and register it.');
  }
  return m;
}

// ── ATTACH (the lazy entry — dispatch-auto, the `zee device` verb, or a human action) ──────────
// Idempotent: a xell that already has a device gets its existing handle back. Otherwise stand up (or
// link) one and return the handle. kind defaults to the project's manifest choice.
export async function attachDeviceXhip(xellId, { kind = null } = {}) {
  const existing = await deviceForXell(xellId);
  if (existing) return { ok: true, attached: false, already: true, device: existing };

  const xell = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
  if (!xell) throw new Error('xell not found');
  if (['retired', 'tearing-down'].includes(xell.status)) {
    throw new Error(`${xell.slug} is ${xell.status} — cannot attach a device to a torn-down xell`);
  }
  const project = await one(`SELECT * FROM project WHERE id=$1`, [xell.project_id]);
  const cfg = deviceConfig(project);
  const want = kind || cfg.kind;
  return want === 'physical'
    ? linkPhysicalDevice(xell, project)
    : runEmulatorDevice(xell, project, cfg);
}

// EMULATOR — a per-xell Android emulator container, docker-run like the isolated per-xell db.
async function runEmulatorDevice(xell, project, cfg) {
  // Where its app tier runs — try to co-locate the emulator there when that host is also can_device,
  // else the best can_device host. Either way they meet over TCP, so cross-host is fine.
  const appCtx = (await one(
    `SELECT docker_ctx FROM container WHERE owner_xell_id=$1 AND role='server' AND docker_ctx IS NOT NULL LIMIT 1`,
    [xell.id]))?.docker_ctx || null;
  const machine = await pickDeviceHost(appCtx);
  const ctx = machine.docker_ctx;
  const host = machine.host_ip || project.dev_host_ip || config.devHostIp || null;
  const { slot } = computePorts(xell.slug, project);
  const adbPort = cfg.adbBase + slot;
  const vncPort = cfg.vncBase + slot;
  const nm = namingFor(project, 'device', xell.slug);
  const name = nm.container;
  const image = cfg.image;

  if (MODE === 'real') {
    // --privileged: budtmo/docker-android needs /dev/kvm for hardware accel; privileged is the image's
    // documented run mode. On zee-hive-net so a same-daemon cxell can also resolve it by name; the
    // published host ports are the universal path (the cxell reaches it at host:adbPort over the LAN).
    const run = spawnSync('docker',
      ['--context', ctx, 'run', '-d', '--name', name, '--restart', 'unless-stopped', '--privileged',
       '--network', 'zee-hive-net',
       '-p', `${adbPort}:${ADB_INTERNAL}`, '-p', `${vncPort}:${VNC_INTERNAL}`,
       '-e', `EMULATOR_DEVICE=${cfg.emulatorDevice}`, '-e', 'WEB_VNC=true',
       '--label', `zeehive.project=${project.name}`, '--label', 'zeehive.role=device',
       '--label', `zeehive.slug=${xell.slug}`, image],
      { encoding: 'utf8', timeout: 180000, windowsHide: true, env: cleanGitEnv() });
    if (run.status !== 0) {
      throw new Error(`emulator container ${name} failed to start on ${machine.key}: ${(run.stderr || '').slice(-300)}`);
    }
  }

  const url = host ? `http://${host}:${vncPort}` : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [c] } = await client.query(
      `INSERT INTO container (project_id, role, tier, isolation, name, image_tag, docker_ctx, network,
                              host, host_port, internal_port, url, owner_xell_id, health)
       VALUES ($1,'device','spinoff','per-xell',$2,$3,$4,'zee-hive-net',$5,$6,$7,$8,$9,$10) RETURNING *`,
      [xell.project_id, name, image, ctx, host, adbPort, ADB_INTERNAL, url, xell.id,
       MODE === 'real' ? 'up' : 'unknown']);
    await client.query(
      `INSERT INTO xell_uses_container (xell_id, container_id, relation) VALUES ($1,$2,'owns')`,
      [xell.id, c.id]);
    await client.query('COMMIT');
    broadcast('container', c);
    logline('device', `attached EMULATOR ${name} to ${xell.slug} on ${machine.key} — adb ${host || 'localhost'}:${adbPort}${url ? `, viewer ${url}` : ''}`);
    return { ok: true, attached: true, device: deviceHandle({ ...c, host_addr: host }), machine: machine.key };
  } catch (err) {
    await client.query('ROLLBACK');
    if (MODE === 'real') {
      spawnSync('docker', ['--context', ctx, 'rm', '-f', name],
        { encoding: 'utf8', timeout: 30000, windowsHide: true });   // the row that owned it is gone
    }
    throw err;
  } finally {
    client.release();
  }
}

// PHYSICAL — link a pre-registered shared device that is not already in use by another live xell.
async function linkPhysicalDevice(xell, project) {
  const free = await one(
    `SELECT c.*, host(c.host) AS host_addr FROM container c
      WHERE c.project_id=$1 AND c.role='device' AND c.isolation='shared'
        AND NOT EXISTS (
          SELECT 1 FROM xell_uses_container uc JOIN xell x ON x.id = uc.xell_id
           WHERE uc.container_id = c.id AND x.status <> 'retired')
      ORDER BY c.created_at LIMIT 1`, [xell.project_id]);
  if (!free) {
    throw new Error(`no free physical device for ${project.name} — every registered device is in use, `
      + 'or none is registered. Register one against a can_device machine first (POST /api/devices).');
  }
  await q(`INSERT INTO xell_uses_container (xell_id, container_id, relation) VALUES ($1,$2,'uses')
           ON CONFLICT DO NOTHING`, [xell.id, free.id]);
  broadcast('container', free);
  logline('device', `linked PHYSICAL device ${free.name} to ${xell.slug} — adb ${free.host_addr}:${free.host_port}`);
  return { ok: true, attached: true, device: deviceHandle(free), physical: true };
}

// ── DETACH (on-demand release; teardown is handled by the reaper for free) ─────────────────────
// A per-xell emulator is stop/rm'd + its row dropped (like decommissionContainer). A linked physical
// device is only UNLINKED — never removed. The reaper already does both at xell teardown; this is the
// explicit mid-life "give the device back" for a zee that finished on-device testing.
export async function detachDeviceXhip(xellId) {
  const c = await one(
    `SELECT c.* FROM xell_uses_container uc JOIN container c ON c.id = uc.container_id
      WHERE uc.xell_id=$1 AND c.role='device' LIMIT 1`, [xellId]);
  if (!c) return { ok: true, detached: false, note: 'no device attached' };

  if (c.isolation === 'per-xell') {
    if (MODE === 'real' && c.docker_ctx) {
      spawnSync('docker', ['--context', c.docker_ctx, 'rm', '-f', c.name],
        { encoding: 'utf8', timeout: 60000, windowsHide: true });
    }
    await q(`DELETE FROM container WHERE id=$1`, [c.id]);   // cascades the junction
    broadcast('container', { id: c.id, project_id: c.project_id, deleted: true });
    logline('device', `detached + removed emulator ${c.name} from xell ${xellId}`);
    return { ok: true, detached: true, removed: true, name: c.name };
  }
  await q(`DELETE FROM xell_uses_container WHERE xell_id=$1 AND container_id=$2`, [xellId, c.id]);
  broadcast('container', c);
  logline('device', `unlinked physical device ${c.name} from xell ${xellId} (device untouched)`);
  return { ok: true, detached: true, removed: false, name: c.name };
}

// ── REGISTER a physical device (human/API action) ──────────────────────────────────────────────
// Model a real phone as a shared device row on a can_device machine. DATA about hardware that exists —
// no container is run for it; a zee LINKS it via attach(kind:'physical'). Two transports:
//   transport='net' (default) : the phone speaks adb over its own tcp addr (`adb tcpip`); adbPort is
//                               that port, host is the phone's reachable IP (defaults to the machine's).
//   transport='usb'           : the phone is USB-plugged into the machine, shared through that
//                               machine's adb SERVER (see provisionAdbHost). adbPort is the SERVER port
//                               (5037), and `serial` is the phone's adb serial — stored as conn_ref
//                               'usb:<serial>' so the handle targets `-H host -P 5037 -s <serial>`.
export async function registerPhysicalDevice({ projectId, machineId, adbPort = null, serial = null,
                                               transport = 'net', name = null, label = null, host = null }) {
  const project = await one(`SELECT * FROM project WHERE id=$1`, [projectId]);
  if (!project) throw new Error('project not found');
  const m = await one(`SELECT * FROM machine WHERE id=$1`, [machineId]);
  if (!m) throw new Error('machine not found');
  if (!m.can_device) throw new Error(`machine ${m.key} is not can_device — mark it so before registering a device on it`);
  const usb = transport === 'usb';
  if (usb && !serial) throw new Error('a usb device needs its adb `serial` (from `adb devices` on the shared host)');
  const port = Number(adbPort) || (usb ? ADB_SERVER_PORT : 0);
  if (!Number.isInteger(port) || port <= 0) throw new Error('adbPort must be a positive integer (net: the phone\'s tcpip port; usb: the shared adb server port)');
  const hostAddr = host || m.host_ip || project.dev_host_ip || config.devHostIp || null;
  const suffix = usb ? String(serial).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16) : String(port);
  const cname = name || `${namingFor(project, 'device', 'phys').container.replace(/_phys$/, '')}_${m.key.replace(/-/g, '_')}_${suffix}`;
  const row = await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, network, host,
                            host_port, internal_port, url, conn_ref, health)
     VALUES ($1,'device','dev','shared',$2,$3,NULL,$4,$5,$6,$7,$8,'unknown')
     ON CONFLICT (project_id, name) DO UPDATE
       SET docker_ctx=EXCLUDED.docker_ctx, host=EXCLUDED.host, host_port=EXCLUDED.host_port,
           conn_ref=EXCLUDED.conn_ref
     RETURNING *`,
    [projectId, cname, m.docker_ctx, hostAddr, port, ADB_INTERNAL, label || null,
     usb ? `usb:${serial}` : null]);
  broadcast('container', row);
  logline('device', `registered ${usb ? 'USB' : 'NETWORK'} device ${cname} on ${m.key} — `
    + (usb ? `adb -H ${hostAddr} -P ${port} -s ${serial}` : `adb connect ${hostAddr}:${port}`));
  return { ok: true, device: deviceHandle({ ...row, host_addr: hostAddr }) };
}

// ── SHARING USB DEVICES: the adb-host container ─────────────────────────────────────────────────
// A phone plugged into a machine over USB is visible ONLY to that machine's local adb server. To
// SHARE it with cxells (which run on the queenzee's daemon, and with other machines), we run ONE
// small container ON that machine that (a) owns the USB bus (`/dev/bus/usb` + privileged) and (b)
// re-exports the adb server over TCP (`adb -a … server` on 5037, published). Then any client reaches
// EVERY plugged phone with `adb -H <machine> -P 5037 -s <serial>` — hot-plug included, no per-device
// setup. This containerizes the "usb host" so the queenzee manages it like any other xhip.
//
// SECURITY: an adb server on 0.0.0.0:5037 has NO auth — anyone who reaches it controls every attached
// device (install/shell/root). It MUST be firewalled to the trusted LAN. That is an operator setting
// on the machine, not something this code can enforce; provisionAdbHost logs the warning.
export async function provisionAdbHost(machineId, { image = ADB_HOST_IMAGE, port = ADB_SERVER_PORT } = {}) {
  const m = await one(`SELECT * FROM machine WHERE id=$1`, [machineId]);
  if (!m) throw new Error('machine not found');
  if (!m.can_device) throw new Error(`machine ${m.key} is not can_device — mark it so first`);
  const name = `zeehive_adbhost_${m.key.replace(/-/g, '_')}`;
  if (MODE === 'real') {
    // --privileged + the raw USB bus so adb inside sees the phones; --net=host is simplest for adb's
    // server on this port (it also serves mdns). unless-stopped so it survives a machine reboot.
    const run = spawnSync('docker',
      ['--context', m.docker_ctx, 'run', '-d', '--name', name, '--restart', 'unless-stopped',
       '--privileged', '-v', '/dev/bus/usb:/dev/bus/usb', '-p', `${port}:${port}`,
       '--label', 'zeehive.role=adb-host', '--label', `zeehive.machine=${m.key}`,
       '-e', `ADB_SERVER_PORT=${port}`, image],
      { encoding: 'utf8', timeout: 120000, windowsHide: true, env: cleanGitEnv() });
    if (run.status !== 0 && !/already in use/i.test(run.stderr || '')) {
      throw new Error(`adb-host container ${name} failed on ${m.key}: ${(run.stderr || '').slice(-300)}`);
    }
  }
  logline('device', `adb-host up on ${m.key}: ${name} sharing USB devices at ${m.host_ip || '<machine>'}:${port} `
    + '— FIREWALL this port to the trusted LAN (an open adb server is unauthenticated root on every attached phone)');
  return { ok: true, name, machine: m.key, adb_server: `${m.host_ip || m.docker_ctx}:${port}`,
           list: `adb -H ${m.host_ip || '<machine>'} -P ${port} devices` };
}

// Enumerate the phones plugged into a machine's shared adb host — `adb devices` inside the adb-host
// container. Returns [{ serial, state }]. What a human/dashboard calls before registering, and what
// discovery would auto-register from. Empty (or an error) when no adb-host runs there.
export async function listUsbDevices(machineId) {
  const m = await one(`SELECT * FROM machine WHERE id=$1`, [machineId]);
  if (!m) throw new Error('machine not found');
  if (MODE !== 'real') return { ok: true, machine: m.key, devices: [], note: 'simulate mode' };
  const name = `zeehive_adbhost_${m.key.replace(/-/g, '_')}`;
  const r = spawnSync('docker', ['--context', m.docker_ctx, 'exec', name, 'adb', 'devices'],
    { encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (r.status !== 0) {
    return { ok: false, machine: m.key, devices: [],
      error: `could not reach the adb-host on ${m.key} (${(r.stderr || 'no adb-host container?').slice(-160)}) — provision one first` };
  }
  const devices = (r.stdout || '').split('\n').slice(1)   // drop the "List of devices attached" header
    .map((l) => l.trim()).filter(Boolean)
    .map((l) => { const [serial, state] = l.split(/\s+/); return { serial, state: state || 'unknown' }; });
  return { ok: true, machine: m.key, devices };
}

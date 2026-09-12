// MACHINE × PROJECT BUILD BOOTSTRAP — "make this machine buildable", one console click (ticket #173
// follow-on). The build-readiness probe (lib/build-readiness.js) NAMES what is missing on a
// (machine, project) pair; this module is the QUEENZEE-PERFORMED action that CREATES those missing
// DEV prerequisites and reports per prerequisite what it did.
//
// CONTRACT (the card's hard boundaries):
//   • QUEENZEE-performed, HUMAN-clicked. No agent ever runs docker; this module is the queenzee
//     running the action a human started from the console.
//   • It only CREATES what the project's manifest DECLARES for the spinoff (DEV) tier — external
//     networks and the shared dev db. It NEVER invents infrastructure (no registry, no machine, no
//     volume — a volume is DATA and is never auto-created), never removes/prunes/reconfigures
//     anything that exists, and never touches a running container.
//   • PLAN FIRST: performBuildBootstrap({ dryRun:true }) returns the ordered plan and performs
//     nothing; the console shows that plan before a human commits.
//   • Idempotent: a step re-checks before it creates, and re-running after a partial failure
//     cannot duplicate anything (a network create is refused by docker when it exists; the dev-db
//     provision has its own in-flight lock and an ON CONFLICT upsert).
//   • Every docker call goes through the probe's bounded ASYNC dockerAdapter (never spawnSync —
//     a sync adapter would serialize every call on the single Node event loop and freeze the
//     queenzee). A test injects a stub here the same way build-readiness.test.mjs does.
//   • DEV-ONLY GUARD: refuses, in code, to CREATE a network/volume the PROD tier also declares.
//     A machine whose context ALSO hosts this project's prod stack is DISCLOSED (the plan names it
//     for the human to confirm), not refused — in the single-host topology dev and prod share the
//     host, so refusing there would switch the bootstrap off on the most common installation.
//   • Every action is RECORDED: who asked, what ran, what came back (build_bootstrap_action).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { one } from '../db/pool.js';
import { config } from '../config.js';
import { probeBuildReadiness, dockerAdapter } from './build-readiness.js';
import { sharedDevDb, provisionDevDb, queenzeeHostCtx } from './machines.js';
import { meshEnabled, mintPeer, netbirdRequest, probeManagementApi } from './netbird.js';
import { broadcast } from './events.js';
import { logline } from './logbus.js';

// ── the DEV-only guard ────────────────────────────────────────────────────────
// The bootstrap creates DEV prerequisites, so it must NEVER create a network/volume the project's
// PROD tier also declares — a name collision would silently satisfy (or half-satisfy) a prod
// dependency. This is the PRECISE prod protection: it reads what the manifest ACTUALLY declares
// (never a name convention), and refuses in code so a test can prove it.
// The OTHER fact — the machine's docker context ALSO hosting this project's PROD stack — is a
// DISCLOSURE, not a refusal. In the single-host topology (this product's default) the same docker
// host carries dev AND prod, so refusing there would switch the bootstrap off on the most common
// installation. hostProdDisclosure() surfaces it for the human to confirm instead: the bootstrap
// still creates only what the spinoff tier declares (none of which the prod tier declares, by the
// guard above) and touches no existing container, volume or network.
export function guardDevOnly(machine, project) {
  const prodReq = project.manifest?.tiers?.prod?.requires;
  const spinReq = project.manifest?.tiers?.spinoff?.requires;
  if (prodReq && spinReq) {
    const names = (l) => (l || []).map((n) => (typeof n === 'string' ? n : n.name));
    const prod = new Set([...names(prodReq.networks), ...(prodReq.volumes || [])]);
    const dev = new Set([...names(spinReq.networks), ...(spinReq.volumes || [])]);
    const overlap = [...dev].filter((n) => prod.has(n));
    if (overlap.length) {
      throw new Error(
        `refusing to bootstrap dev prerequisites on '${machine.key}': network/volume `
        + `${overlap.join(', ')} is also declared by the PROD tier — the bootstrap never creates `
        + `prod infrastructure.`);
    }
  }
}

// When the machine's docker context ALSO hosts this project's PROD stack (single-host topology),
// the bootstrap can still run — it creates only what the spinoff tier declares, none of which the
// prod tier declares (guardDevOnly enforces that), and touches no existing container/volume/network —
// but the human must confirm they understand the host carries prod. Returns that disclosure (a
// sentence the plan shows before a human commits), or null when the host does not run prod here.
export async function hostProdDisclosure(machine, project, createNames = []) {
  const ctx = machine.docker_ctx;
  const prodSite = await one(
    `SELECT 1 FROM deploy_site WHERE project_id=$1 AND docker_ctx=$2 AND tier='prod' LIMIT 1`,
    [project.id, ctx]);
  const prodContainer = await one(
    `SELECT 1 FROM container WHERE project_id=$1 AND docker_ctx=$2 AND tier='prod' LIMIT 1`,
    [project.id, ctx]);
  if (!prodSite && !prodContainer) return null;
  const names = createNames.length ? createNames.join(', ') : 'nothing';
  return `this host ('${ctx}') also runs this project's PROD ${prodSite ? 'deploy site' : 'container'}; `
    + `the bootstrap will create only ${names}, none of which the prod tier declares, and it touches `
    + `no existing container, volume or network.`;
}

// ── the mesh control plane (docs/netbird-mesh-plan.md §3.1 / §11 NOT-done #1) ────────────────
// Standing the NetBird control plane up used to be a raw human op — `compose --profile mesh up -d`,
// hand-write netbird/management.json, set NETBIRD_API_URL/TOKEN/NETBIRD_GATEWAY_SETUP_KEY, back up
// the datastore. It is now a STEP on this same human-gated bootstrap card: the queenzee performs it
// on its OWN docker context (the machine it runs on — where the control plane's compose project
// lives), writes management.json from the shipped example, brings up ONLY the three control-plane
// services, health-checks the management API, and names the env the operator still sets by hand.
//
// Two lines this step never crosses:
//   • It never invents or stores a secret. The management API token is minted through NetBird's own
//     flow by a human; the two management.json secrets are taken from the operator's env or left as
//     placeholders, and a placeholder REFUSES the stand-up rather than starting NetBird on a known
//     example secret.
//   • It never touches the queenzee's own containers: compose is invoked with the three mesh service
//     names, so the server/webapp/meta-db are not in the command at all.
// NOT gated on meshEnabled(): NETBIRD_API_URL/TOKEN are set AFTER stand-up (they point the queenzee
// AT the plane), so gating on them would make the step that creates the control plane require the
// control plane. The only gate is that this machine IS the queenzee's host.
export const MESH_CONTROL_PLANE_CONTAINER = 'zeehive_netbird_management';
// The control plane only — NOT mesh-gateway (needs a human-minted setup key) and NOT the dashboard
// (needs an OIDC provider). Both would crash-loop with an empty key/OIDC and make a good stand-up
// look failed; the operator brings them up once the env below exists.
export const MESH_CONTROL_PLANE_SERVICES = ['netbird-management', 'netbird-signal', 'netbird-relay'];
const PLACEHOLDER_SECRET = /CHANGE-ME/i;

// PURE: substitute the values ZEEHIVE knows into the shipped example and NOTHING else. The two
// secret fields are only ever taken from the operator's env — this function never generates key
// material, so what it writes is either the example's placeholder (which the caller refuses) or a
// value the operator already holds.
export function renderManagementJson(templateText, overrides = {}) {
  const doc = JSON.parse(templateText);
  if (overrides.signalUri) doc.Signal = { ...doc.Signal, URI: overrides.signalUri };
  if (overrides.relayAddress) doc.Relay = { ...doc.Relay, Addresses: [overrides.relayAddress] };
  if (overrides.relaySecret) doc.Relay = { ...doc.Relay, Secret: overrides.relaySecret };
  if (overrides.datastoreEncryptionKey) doc.DataStoreEncryptionKey = overrides.datastoreEncryptionKey;
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// PURE: the secrets that are still placeholders, i.e. what a human must supply before the control
// plane may start. Empty = usable. Naming them is the point: silently starting NetBird on the
// example's known secret is exactly the "invent or store a secret" this step refuses.
export function managementJsonMissingSecrets(doc) {
  const missing = [];
  if (PLACEHOLDER_SECRET.test(String(doc?.DataStoreEncryptionKey || ''))) {
    missing.push('DataStoreEncryptionKey (set NETBIRD_DATASTORE_ENCRYPTION_KEY)');
  }
  if (PLACEHOLDER_SECRET.test(String(doc?.Relay?.Secret || ''))) {
    missing.push('Relay.Secret (set NETBIRD_RELAY_AUTH_SECRET)');
  }
  return missing;
}

// Materialize <composeDir>/netbird/management.json (the path the compose files bind-mount) from the
// shipped example, idempotently: an operator's own file is NEVER overwritten, it is only checked for
// placeholders. Returns { file, written } or { error } — never throws for an outcome.
export function ensureManagementJson(composeFile, { repoRoot = config.repoRoot } = {}) {
  const dir = dirname(composeFile);
  const file = join(dir, 'netbird', 'management.json');
  if (existsSync(file)) {
    try {
      const missing = managementJsonMissingSecrets(JSON.parse(readFileSync(file, 'utf8')));
      if (missing.length) {
        return { error: `netbird/management.json at '${file}' still carries placeholder secret(s): `
          + `${missing.join(', ')} — fill them in and re-run. ZEEHIVE never invents or stores a secret.` };
      }
      return { file, written: false };
    } catch (e) {
      return { error: `netbird/management.json at '${file}' is not readable JSON (${e.message})` };
    }
  }
  const example = [join(dir, 'netbird', 'management.json.example'),
                   join(repoRoot, 'docker', 'zeehive', 'netbird', 'management.json.example')]
    .find((p) => existsSync(p));
  if (!example) {
    return { error: `no netbird/management.json at '${file}' and no shipped example to generate one `
      + `from — point MESH_COMPOSE_FILE at the install's compose file (which sits beside its netbird/ `
      + `directory), or copy docker/zeehive/netbird/management.json.example to '${file}' and fill it in.` };
  }
  const rendered = renderManagementJson(readFileSync(example, 'utf8'), {
    signalUri: config.netbirdSignalUri,
    relayAddress: config.netbirdRelayEndpoint,
    relaySecret: config.netbirdRelayAuthSecret,
    datastoreEncryptionKey: config.netbirdDatastoreEncryptionKey,
  });
  const missing = managementJsonMissingSecrets(JSON.parse(rendered));
  if (missing.length) {
    return { error: `the control plane's management config still needs ${missing.join(', ')} before `
      + `it can start — set those on the queenzee's install and re-run. No secret was invented or written.` };
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, rendered);
  } catch (e) {
    return { error: `could not write '${file}': ${e.message}` };
  }
  return { file, written: true };
}

// The env a human still sets AFTER the services are up. NETBIRD_API_TOKEN is minted on the control
// plane through NetBird's own flow and handed to the queenzee's env by a human — this step never
// mints or stores it. NETBIRD_GATEWAY_SETUP_KEY is a one-off key for the mesh-gateway peer; the
// queenzee's own env does not carry it (the gateway container reads the install .env), so it is
// always named rather than probed.
function meshOperatorEnv() {
  const missing = [];
  const already = [];
  const note = (name, present) => (present ? already : missing).push(name);
  note('NETBIRD_API_URL', Boolean(config.netbirdApiUrl));
  note('NETBIRD_API_TOKEN', Boolean(config.netbirdApiToken));
  missing.push('NETBIRD_GATEWAY_SETUP_KEY (a one-off setup key for the zeehive-gw gateway peer)');
  return { missing, already };
}

// ── the planner ───────────────────────────────────────────────────────────────
// Run the probe and turn its failing checks into an ORDERED list of steps the performer can run.
// Each step: { kind, target, why, action, status, detail, stderr }.
//   kind   'network' | 'shared-dev-db' | 'mesh-machine-peer' (performable) | 'cannot'
//          (a human action, not a queenzee one)
//   status 'planned' (not yet performed) | 'cannot' (never performable)
// A step is 'cannot' when the bootstrap is NOT the right tool: a missing volume (DATA), a missing
// registry / build machine (configuration + credentials, a human's decision), a compose file that
// does not resolve (a repo/manifest defect), or an alias a running container lost (never touched).
export async function planBuildBootstrap(machine, project, { docker = dockerAdapter } = {}) {
  // The probe reads project.db_coupling to decide whether a shared dev db is expected at all
  // (buildReadinessForProject attaches it from pool_config before probing). Attach it here too so
  // a direct planBuildBootstrap caller gets the same answer — never assume the caller did.
  if (project?.id && !project.db_coupling) {
    const pc = await one(`SELECT default_db_coupling FROM pool_config WHERE project_id=$1`, [project.id]);
    if (pc?.default_db_coupling) project.db_coupling = pc.default_db_coupling;
  }
  // The precise DEV-only guard — throws when the spinoff tier declares a network/volume the PROD
  // tier also declares. Host-level prod is a DISCLOSURE (below), not a refusal.
  guardDevOnly(machine, project);
  const probe = await probeBuildReadiness(machine, project, { docker });

  const check = (name) => probe.checks.find((c) => c.check === name);
  const ctxCheck = check('context-reachable');
  // REFUSE THE WHOLE ACTION when the daemon is unreachable: never half-run a bootstrap against a
  // machine we could not reach (manager's rule; a network create would fail blind and the probe
  // cannot even tell us what is missing).
  if (ctxCheck && !ctxCheck.ok && ctxCheck.unknown) {
    return {
      probe, steps: [], disclosure: null,
      refused: `cannot act on '${machine.key}' (${machine.docker_ctx}): the docker context is not `
        + `reachable — ${ctxCheck.detail}. Fix the machine's context/daemon and re-check; the `
        + `bootstrap never runs against a daemon it cannot reach.`,
    };
  }

  const steps = [];
  const cannot = (checkName, target, action, reason) => steps.push({
    kind: 'cannot', target, why: checkName.detail, action: action || null,
    status: 'cannot', detail: reason, stderr: null,
  });

  const req = check('requires-present');
  if (req && !req.ok) {
    const requires = project.manifest?.tiers?.spinoff?.requires || {};
    const nets = (requires.networks || []).map((n) =>
      typeof n === 'string' ? { name: n, aliases: [] } : { name: n.name, aliases: n.aliases || [] });
    const vols = requires.volumes || [];
    const aliasComplaint = /missing required alias/.test(req.detail);
    for (const n of nets) {
      const r = await docker(machine.docker_ctx, ['network', 'inspect', n.name, '--format', '{{.Name}}']);
      if (r.unknown) {
        cannot(req, `network '${n.name}'`, null,
          `could not verify network '${n.name}' on '${machine.docker_ctx}': ${r.reason}`);
      } else if (r.status !== 0) {
        steps.push({
          kind: 'network', target: n.name,
          why: `required external network '${n.name}' does not exist on '${machine.docker_ctx}'`,
          action: `docker network create ${n.name}`,
          status: 'planned', detail: null, stderr: null,
        });
      } else if (aliasComplaint && req.detail.includes(n.name)) {
        cannot(req, `network '${n.name}' aliases`, null,
          `network '${n.name}' exists on '${machine.docker_ctx}' but the probe reports missing `
          + `required alias(es) — a container was recreated without them. The bootstrap never `
          + `reconfigures a running container; re-create it via compose.`);
      }
    }
    for (const v of vols) {
      const r = await docker(machine.docker_ctx, ['volume', 'inspect', v]);
      if (r.unknown) {
        cannot(req, `volume '${v}'`, null,
          `could not verify volume '${v}' on '${machine.docker_ctx}': ${r.reason}`);
      } else if (r.status !== 0) {
        cannot(req, `volume '${v}'`, null,
          `required external volume '${v}' does not exist on '${machine.docker_ctx}' — external `
          + `volumes are DATA and are NEVER auto-created. Create it from the project's bootstrap `
          + `doc, then re-check.`);
      }
    }
  }

  const sdb = check('shared-dev-db');
  if (sdb && !sdb.ok) {
    steps.push({
      kind: 'shared-dev-db', target: 'shared dev db',
      why: sdb.detail,
      action: `provision the shared dev db for ${project.name} on ${machine.key} (provisionDevDb)`,
      status: 'planned', detail: null, stderr: null,
    });
  }

  const reg = check('registry-for-handoff');
  if (reg && !reg.ok) {
    cannot(reg, 'registry / build machine', null,
      reg.detail + ' Set project.registry (or SPINOFF_REGISTRY) to a registry the build host and '
      + 'this machine can both reach, or tick can_build on this machine / add a build-capable '
      + 'machine — a bootstrap never invents a registry.');
  }

  const comp = check('compose-resolves');
  if (comp && !comp.ok) {
    cannot(comp, 'spinoff compose', null, comp.detail);
  }

  // MESH CONTROL PLANE (docs/netbird-mesh-plan.md §3.1 / §11 NOT-done #1). The mesh-profile
  // services live in the queenzee's OWN compose project, so this step only ever applies to the
  // machine the queenzee runs on (docker_ctx = queenzeeHostCtx()). The plan REPORTS whether it is
  // up: a running management container is an 'already-present' step (so the plan still answers the
  // question), anything else is the performable stand-up. See the block above for why this is not
  // gated on meshEnabled().
  if (machine.docker_ctx === queenzeeHostCtx()) {
    const insp = await docker(machine.docker_ctx,
      ['inspect', MESH_CONTROL_PLANE_CONTAINER, '--format', '{{.State.Status}}']);
    if (insp.unknown) {
      steps.push({
        kind: 'mesh-control-plane', target: machine.docker_ctx,
        why: `could not check the NetBird control plane on '${machine.docker_ctx}': ${insp.reason}`,
        action: null, status: 'cannot',
        detail: `the control plane could not be checked on '${machine.docker_ctx}': ${insp.reason}. `
          + `The stand-up runs on the queenzee's own docker context; a cage has no docker at all.`,
        stderr: null,
      });
    } else if (insp.status === 0 && /running/i.test((insp.stdout || '').trim())) {
      steps.push({
        kind: 'mesh-control-plane', target: machine.docker_ctx,
        why: `the NetBird control plane runs on the queenzee's own context '${machine.docker_ctx}'`,
        action: null, status: 'already-present',
        detail: `container '${MESH_CONTROL_PLANE_CONTAINER}' is running — nothing to stand up`,
        stderr: null,
      });
    } else {
      steps.push({
        kind: 'mesh-control-plane', target: machine.docker_ctx,
        why: `the NetBird control plane is not running on the queenzee's own context `
          + `'${machine.docker_ctx}' (docs/netbird-mesh-plan.md §3.1)`,
        action: `write netbird/management.json from the shipped example, then `
          + `docker compose --profile mesh up -d ${MESH_CONTROL_PLANE_SERVICES.join(' ')} `
          + `and health-check the management API`,
        status: 'planned', detail: null, stderr: null,
      });
    }
  }

  // MESH MACHINE PEER (docs/netbird-mesh-plan.md §3.2 phase 2): the bootstrap CARD is the
  // human-gated seam that installs the mesh agent on a build/db host. When the queenzee has the
  // mesh configured (meshEnabled) and this machine has no ACTIVE kind='machine' peer yet, the plan
  // names the peer the perform step mints. A dry-run only SHOWS it — perform creates the intent
  // row + the one-time setup key. Mesh unset → no step, ever (the standing invariant). A machine
  // with a peer already (from another project's bootstrap — one active peer per machine, hostname
  // = machine key) needs no second step.
  if (meshEnabled()) {
    const existing = await one(
      `SELECT id FROM mesh_peer WHERE machine_id=$1 AND kind='machine' AND removed_at IS NULL LIMIT 1`,
      [machine.id]);
    if (!existing) {
      steps.push({
        kind: 'mesh-machine-peer', target: machine.key,
        why: `machine '${machine.key}' has no NetBird mesh peer yet (docs/netbird-mesh-plan.md §3.2)`,
        action: `mint the machine's mesh peer + one-time setup key (control-plane API)`,
        status: 'planned', detail: null, stderr: null,
      });
    }
  }

  // A fully-ready machine with nothing to create and no mesh peer to mint → the plan is empty.
  if (probe.status === 'ok' && !steps.length) return { probe, steps: [], refused: null, disclosure: null };

  // Host-level prod is a DISCLOSURE the human confirms, not a refusal: in the single-host topology
  // dev and prod share the docker host, so refusing there would switch the bootstrap off by default.
  // Only attach it when there is something the bootstrap will actually create — a mesh peer and the
  // mesh control plane are the queenzee's own control-plane objects, not this project's DEV
  // prerequisites, so neither triggers the docker disclosure.
  const createNames = steps
    .filter((s) => s.status === 'planned' && s.kind !== 'mesh-machine-peer' && s.kind !== 'mesh-control-plane')
    .map((s) => s.target);
  let disclosure = null;
  if (createNames.length) {
    disclosure = await hostProdDisclosure(machine, project, createNames);
    if (disclosure) {
      steps.unshift({
        kind: 'disclosure', target: 'prod stack on this host',
        why: 'this machine\'s docker context also runs this project\'s PROD stack',
        action: null, status: 'disclosure', detail: disclosure, stderr: null,
      });
    }
  }

  return { probe, steps, refused: null, disclosure };
}

// ── the performer ─────────────────────────────────────────────────────────────
// Run ONE planned step idempotently and return its result:
//   { status: 'created'|'already-present'|'cannot'|'failed'|'started', detail, stderr }
async function performStep(step, machine, project, { docker, provisionDb, mesh = {} }) {
  if (step.kind === 'network') {
    // Idempotent: re-check before creating (a previous run, or a human, may have got there first).
    const exists = await docker(machine.docker_ctx, ['network', 'inspect', step.target, '--format', '{{.Name}}']);
    if (!exists.unknown && exists.status === 0) {
      return { status: 'already-present',
               detail: `network '${step.target}' already exists on '${machine.docker_ctx}'`, stderr: null };
    }
    const r = await docker(machine.docker_ctx, ['network', 'create', step.target]);
    if (r.unknown) {
      return { status: 'failed',
               detail: `could not create network '${step.target}' on '${machine.docker_ctx}': ${r.reason}`,
               stderr: null };
    }
    if (r.status !== 0) {
      // Idempotence under a race: the network appeared between our inspect and create, so docker
      // refuses with "already exists" — that is already-present, not a failure.
      if (/already exists/i.test((r.stderr || '') + (r.stdout || ''))) {
        return { status: 'already-present',
                 detail: `network '${step.target}' already exists on '${machine.docker_ctx}' (appeared between check and create)`,
                 stderr: null };
      }
      return { status: 'failed',
               detail: `docker network create '${step.target}' failed on '${machine.docker_ctx}'`,
               stderr: (r.stderr || r.stdout || '').trim() };
    }
    return { status: 'created',
             detail: `network '${step.target}' created on '${machine.docker_ctx}'`, stderr: null };
  }

  if (step.kind === 'shared-dev-db') {
    // Idempotent: the row already there means the prerequisite is present.
    const existing = await sharedDevDb(project.id, machine.docker_ctx);
    if (existing) {
      return { status: 'already-present',
               detail: `shared dev db '${existing.name}' already present on '${machine.docker_ctx}'`,
               stderr: null };
    }
    try {
      const r = await provisionDb(project.id, machine.id);
      return { status: 'started',
               detail: `dev db provisioning started on ${machine.key}: ${r?.name || 'db'} (${r?.image || 'image'}) — the db chip appears when it finishes`,
               stderr: null };
    } catch (e) {
      // The provision lock ("already running") means a provision IS in flight — idempotent, not a failure.
      if (/already running/i.test(e.message || '')) {
        return { status: 'started',
                 detail: `a dev db provision for ${project.name} on ${machine.key} is already running — no duplicate started`,
                 stderr: null };
      }
      return { status: 'failed', detail: e.message, stderr: null };
    }
  }

  if (step.kind === 'mesh-control-plane') {
    // The stand-up (§3.1). Idempotent at every stage: an already-running management container skips
    // compose, an existing management.json is checked but never overwritten, and a second perform
    // after a successful one reports already-present. A refused secret, a missing compose file or an
    // unreachable daemon is a NAMED cannot — never a half-started control plane.
    const file = config.meshComposeFile;
    if (!file || !existsSync(file)) {
      return { status: 'cannot',
               detail: `the queenzee's compose file was not found at '${file}' — set MESH_COMPOSE_FILE to the `
                 + `install's compose file (the one defining the mesh profile) and re-run. The control plane `
                 + `lives in the queenzee's own compose project, on the queenzee's own docker context.`,
               stderr: null };
    }
    const insp = await docker(machine.docker_ctx,
      ['inspect', MESH_CONTROL_PLANE_CONTAINER, '--format', '{{.State.Status}}']);
    if (insp.unknown) {
      return { status: 'cannot',
               detail: `could not reach '${machine.docker_ctx}' to inspect the control plane: ${insp.reason}`,
               stderr: null };
    }
    const running = insp.status === 0 && /running/i.test((insp.stdout || '').trim());
    let started = false;
    if (!running) {
      const mj = ensureManagementJson(file);
      if (mj.error) return { status: 'cannot', detail: mj.error, stderr: null };
      const up = await docker(machine.docker_ctx,
        ['compose', '-f', file, '--profile', 'mesh', 'up', '-d', ...MESH_CONTROL_PLANE_SERVICES]);
      if (up.unknown) {
        return { status: 'failed',
                 detail: `could not run compose on '${machine.docker_ctx}': ${up.reason}`, stderr: null };
      }
      if (up.status !== 0) {
        return { status: 'failed',
                 detail: `docker compose --profile mesh up failed on '${machine.docker_ctx}' from '${file}'`,
                 stderr: (up.stderr || up.stdout || '').trim() };
      }
      started = true;
    }
    // Health-check the management API (bounded dial + retry; injected for tests, same seam as the
    // netbird request adapter the machine-peer step takes).
    const hc = await (mesh.probeApi || probeManagementApi)({});
    const { missing, already } = meshOperatorEnv();
    const envLine = `by hand on the queenzee: ${missing.join(', ')}`
      + (already.length ? ` (already set: ${already.join(', ')})` : '');
    if (!hc.ok) {
      return { status: 'failed',
               detail: `the control plane containers ${started ? 'started' : 'are running'} from '${file}' but `
                 + `the management API at ${hc.host}:${hc.port} is not answering `
                 + `(${hc.verdict || hc.reason}) — check the service logs; then set ${envLine}.`,
               stderr: null };
    }
    return { status: started ? 'created' : 'already-present',
             detail: `control plane ${started ? 'brought up' : 'already running'} on '${machine.docker_ctx}' `
               + `(${MESH_CONTROL_PLANE_SERVICES.join(', ')}) — the management API answered at `
               + `${hc.host}:${hc.port}. Set ${envLine}. No secret was minted or stored by this step.`,
             stderr: null };
  }

  if (step.kind === 'mesh-machine-peer') {
    // The bootstrap CARD's mesh half (§3.2): mint the machine's peer + one-time setup key. The key
    // is returned ONCE — it rides the step result (the human-approved action's receipt) and is
    // never stored on the row; the agent install on the host consumes it at first join.
    if (!meshEnabled()) {
      return { status: 'cannot', detail: 'mesh disabled — nothing to mint', stderr: null };
    }
    const existing = await one(
      `SELECT id FROM mesh_peer WHERE machine_id=$1 AND kind='machine' AND removed_at IS NULL LIMIT 1`,
      [machine.id]);
    if (existing) {
      return { status: 'already-present',
               detail: `machine '${machine.key}' already has an active mesh peer`, stderr: null };
    }
    try {
      const mint = await mintPeer({ projectId: project.id, kind: 'machine', hostname: machine.key,
                                    machineId: machine.id },
                                  { request: mesh.request || netbirdRequest });
      if (!mint.ok) {
        return { status: 'failed',
                 detail: `machine peer mint ${mint.disabled ? 'disabled' : 'failed'} (${mint.reason})`,
                 stderr: null };
      }
      return { status: 'created',
               detail: `machine peer '${machine.key}' minted — one-time setup key ${mint.setupKey} `
                 + `(hand it to the host's agent install; it is shown ONLY here and never stored)`,
               stderr: null };
    } catch (e) {
      return { status: 'failed', detail: e.message, stderr: null };
    }
  }

  return { status: 'cannot', detail: `no performer for step kind '${step.kind}'`, stderr: null };
}

function overallStatus(results) {
  if (!results.length) return 'already-present';
  if (results.some((s) => s.status === 'failed')) return 'failed';
  if (results.some((s) => s.status === 'created' || s.status === 'started')) return 'performed';
  if (results.some((s) => s.status === 'cannot')) return 'cannot';
  return 'already-present';
}

async function record(projectId, machineId, actor, dryRun, status, reason, steps) {
  return one(
    `INSERT INTO build_bootstrap_action (project_id, machine_id, actor, dry_run, status, reason, steps)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id`,
    [projectId, machineId, actor, dryRun, status, reason, JSON.stringify(steps)]);
}

async function loadProjectWithCoupling(projectId) {
  const project = await one(`SELECT * FROM project WHERE id=$1`, [projectId]);
  if (!project) throw new Error('project not found');
  // Same coupling attach buildReadinessForProject does — the probe reads project.db_coupling to
  // decide whether a shared dev db is expected at all.
  const pc = await one(`SELECT default_db_coupling FROM pool_config WHERE project_id=$1`, [projectId]);
  if (pc?.default_db_coupling) project.db_coupling = pc.default_db_coupling;
  return project;
}

// THE ENTRY: dryRun returns the plan and performs nothing; otherwise performs each step, re-runs
// the probe, and records the whole action. Never throws for a verdict outcome (a missing
// machine/project row still throws — the row is gone).
export async function performBuildBootstrap(projectId, machineId,
  { dryRun = false, docker = dockerAdapter, provisionDb = provisionDevDb,
    actor = 'human@console', mesh = {} } = {}) {
  const project = await loadProjectWithCoupling(projectId);
  const machine = await one(`SELECT * FROM machine WHERE id=$1`, [machineId]);
  if (!machine) throw new Error('machine not found');

  // THE DEV-ONLY GUARD — the name-overlap refusal fires before any plan is built or performed.
  // (Host-level prod is a disclosure in the plan, not a refusal: see hostProdDisclosure.)
  try {
    guardDevOnly(machine, project);
  } catch (e) {
    const row = await record(projectId, machineId, actor, dryRun, 'refused', e.message, []);
    logline('machine', `bootstrap REFUSED on ${machine.key} for ${project.name} by ${actor}: ${e.message}`);
    return { status: 'refused', reason: e.message, steps: [], probe: null, action_id: row.id };
  }

  const { probe, steps, refused, disclosure } = await planBuildBootstrap(machine, project, { docker });
  if (refused) {
    const row = await record(projectId, machineId, actor, dryRun, 'refused', refused, []);
    logline('machine', `bootstrap REFUSED on ${machine.key} for ${project.name} by ${actor}: ${refused}`);
    return { status: 'refused', reason: refused, steps: [], probe, action_id: row.id };
  }

  if (dryRun) {
    const row = await record(projectId, machineId, actor, true, 'planned', null, steps);
    return { status: 'planned', plan: steps, probe, action_id: row.id, disclosure };
  }

  const results = [];
  for (const step of steps) {
    // A disclosure is information for the human, not a step to perform — keep it in the results
    // so the audit records it, but never hand it to the performer.
    if (step.kind === 'disclosure' || step.status === 'cannot') { results.push(step); continue; }
    results.push({ ...step, ...(await performStep(step, machine, project, { docker, provisionDb, mesh })) });
  }

  // Re-run the probe so the returned verdict is what is now TRUE, not what the action hoped.
  const freshProbe = await probeBuildReadiness(machine, project, { docker });
  const status = overallStatus(results);
  const row = await record(projectId, machineId, actor, false, status, null, results);
  logline('machine', `bootstrap ${status} on ${machine.key} for ${project.name} by ${actor}: `
    + results.map((s) => `${s.kind}:${s.target}=${s.status}`).join(', '));
  broadcast('machine', { id: machineId });
  return { status, results, probe: freshProbe, action_id: row.id, disclosure };
}

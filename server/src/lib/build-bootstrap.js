// MACHINE × PROJECT BUILD BOOTSTRAP — "make this machine buildable", one console click (ticket #173
// follow-on). The build-readiness probe (lib/build-readiness.js) NAMES what is missing on a
// (machine, project) pair; this module is the QUEENZEE-PERFORMED action that CREATES those missing
// DEV prerequisites and reports per prerequisite what it did.
//
// CONTRACT (the card's hard boundaries):
//   • QUEENZEE-performed, HUMAN-clicked. No agent ever runs docker; this module is the queenzee
//     running the action a human started from the console.
//   • It only CREATES what the project's manifest DECLARES for the spinoff (DEV) tier — external
//     networks, a volume the manifest explicitly marks `create: empty` (the project's own authority
//     that empty is a valid start), and the shared dev db. It NEVER invents infrastructure (no
//     registry, no machine, and never a PLAIN volume — a volume is DATA and is never auto-created),
//     never removes/prunes/reconfigures anything that exists, and never touches a running container.
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
import { meshEnabled, mintPeer, netbirdRequest, probeManagementApi,
         MESH_CONTROL_PLANE_CONTAINER, MESH_CONTROL_PLANE_SERVICES } from './netbird.js';
// The production first-PAT bootstrap (the store seed under the version pin) and the console's mesh
// config it is read from. Imported, not re-implemented: this step stands the plane up, the config
// tells it WHAT to stand up, and netbird-bootstrap.js mints the account the ManagerType-none plane
// cannot create for itself.
import { bootstrapFirstPat } from './netbird-bootstrap.js';
import { applyMeshConfig, composeEnvFor, meshResolvedForPerformer, recordBootstrappedPat } from './mesh-config.js';
// Re-exported: the step's callers (and its tests) have named both here since it shipped.
export { MESH_CONTROL_PLANE_CONTAINER, MESH_CONTROL_PLANE_SERVICES };
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
// lives), renders management.json from the values the human saved in the console (or the operator's
// env — lib/mesh-config.js resolves store-over-env), brings up ONLY the three control-plane
// services, health-checks the management API, and then bootstraps the FIRST API token into the
// pinned store so the queenzee can actually talk to the plane it just created.
//
// Two lines this step never crosses:
//   • It never INVENTs a secret. The datastore key and relay secret come from the mesh config (a
//     human's console click may have minted them — that is the human act) or the operator's env; a
//     placeholder REFUSES the stand-up rather than starting NetBird on a known example secret. The
//     one credential this step does create, the first PAT, is minted by 0.78.1's own store format
//     under the version pin (lib/netbird-bootstrap.js) and stored write-only in the mesh config.
//   • It never touches the queenzee's own containers: compose is invoked with the three mesh service
//     names, so the server/webapp/meta-db are not in the command at all.
// NOT gated on meshEnabled(): NETBIRD_API_URL/TOKEN are set AFTER stand-up (they point the queenzee
// AT the plane), so gating on them would make the step that creates the control plane require the
// control plane. The only gate is that this machine IS the queenzee's host.
const PLACEHOLDER_SECRET = /CHANGE-ME/i;

// The overrides the shipped example is rendered with: the resolved mesh config, which is the
// console's row over the operator's env (lib/mesh-config.js). Read from `config` because
// applyMeshConfig has already folded the row in — the stand-up does not need a second lookup.
function managementJsonOverrides() {
  return {
    signalUri: config.netbirdSignalUri,
    relayAddress: config.netbirdRelayEndpoint,
    relaySecret: config.netbirdRelayAuthSecret,
    datastoreEncryptionKey: config.netbirdDatastoreEncryptionKey,
  };
}

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
    missing.push('DataStoreEncryptionKey (set it in the console\'s mesh config, or NETBIRD_DATASTORE_ENCRYPTION_KEY)');
  }
  if (PLACEHOLDER_SECRET.test(String(doc?.Relay?.Secret || ''))) {
    missing.push('Relay.Secret (set it in the console\'s mesh config, or NETBIRD_RELAY_AUTH_SECRET)');
  }
  return missing;
}

// PURE: the overrides that may REPLACE a placeholder in an existing file — and only a placeholder.
// A value an operator put there themselves is never a candidate, which is the line that makes
// "fill the example's CHANGE-ME" and "never overwrite the operator's secret" the same rule.
export function placeholderFill(doc, overrides = {}) {
  const fill = {};
  if (overrides.datastoreEncryptionKey && PLACEHOLDER_SECRET.test(String(doc?.DataStoreEncryptionKey || ''))) {
    fill.datastoreEncryptionKey = overrides.datastoreEncryptionKey;
  }
  if (overrides.relaySecret && PLACEHOLDER_SECRET.test(String(doc?.Relay?.Secret || ''))) {
    fill.relaySecret = overrides.relaySecret;
  }
  return fill;
}

// Materialize <composeDir>/netbird/management.json (the path the compose files bind-mount) from the
// shipped example, idempotently. Returns { file, written, filled? } or { error } — never throws for
// an outcome.
//
// An operator's own file is never OVERWRITTEN: a value they set is left exactly as it is. The one
// write this makes to an existing file is filling a still-placeholder secret with a value the mesh
// config actually has — refusing to do that would leave "paste it in the console" unable to finish
// the job it was clicked for, and hand-editing the file as the only way out.
export function ensureManagementJson(composeFile, { repoRoot = config.repoRoot, overrides = managementJsonOverrides() } = {}) {
  const dir = dirname(composeFile);
  const file = join(dir, 'netbird', 'management.json');
  if (existsSync(file)) {
    try {
      const text = readFileSync(file, 'utf8');
      const doc = JSON.parse(text);
      const missing = managementJsonMissingSecrets(doc);
      if (!missing.length) return { file, written: false };
      const fill = placeholderFill(doc, overrides);
      if (!Object.keys(fill).length) {
        return { error: `netbird/management.json at '${file}' still carries placeholder secret(s): `
          + `${missing.join(', ')} — set them in the console's mesh config (or the queenzee's env) and `
          + `re-run the stand-up, or fill them in by hand. ZEEHIVE never invents or stores a secret.` };
      }
      const rendered = renderManagementJson(text, fill);
      const still = managementJsonMissingSecrets(JSON.parse(rendered));
      if (still.length) {
        return { error: `netbird/management.json at '${file}' still needs ${still.join(', ')} — set `
          + `them in the console's mesh config (or the queenzee's env) and re-run the stand-up.` };
      }
      writeFileSync(file, rendered);
      return { file, written: true, filled: true };
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
  const rendered = renderManagementJson(readFileSync(example, 'utf8'), overrides);
  const missing = managementJsonMissingSecrets(JSON.parse(rendered));
  if (missing.length) {
    return { error: `the control plane's management config still needs ${missing.join(', ')} before `
      + `it can start — set them in the console's mesh config (or the queenzee's env) and re-run. `
      + `No secret was invented or written.` };
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, rendered);
  } catch (e) {
    return { error: `could not write '${file}': ${e.message}` };
  }
  return { file, written: true };
}

// What a human still has to provide AFTER the services are up. The mesh config (console) or the
// operator env may already carry the first two — NETBIRD_API_URL/TOKEN are resolved from both by
// lib/mesh-config.js, and the first PAT is bootstrapped by this step when neither has one.
// NETBIRD_GATEWAY_SETUP_KEY is a one-off key for the mesh-gateway peer; the queenzee's own env does
// not carry it (the gateway container reads the install .env), so it is always named, not probed.
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
// A step is 'cannot' when the bootstrap is NOT the right tool: a PLAIN missing volume (DATA), a
// missing registry / build machine (configuration + credentials, a human's decision), a compose
// file that does not resolve (a repo/manifest defect), or an alias a running container lost (never
// touched). It is 'planned' for a declared network, a `create: empty` volume, the shared dev db,
// and (on the queenzee's own host) the mesh control plane.
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

  // The probe already INSPECTED every declared item and attached the misses as structure; the
  // planner reads that structure instead of re-inspecting (the old `/missing required alias/`
  // regex over free text is gone — decision record, item 2). Classification, per category:
  const req = check('requires-present');
  if (req && !req.ok) {
    const missing = req.missing || null;
    if (!missing) {
      // A check recorded before the structured shape (or one that could not be verified): name it
      // rather than guess. The bootstrap never half-runs on a classification it does not have.
      cannot(req, 'requires-present', null, req.detail);
    } else {
      for (const name of missing.networks || []) {
        steps.push({
          kind: 'network', target: name,
          why: `required external network '${name}' does not exist on '${machine.docker_ctx}'`,
          action: `docker network create ${name}`,
          status: 'planned', detail: null, stderr: null,
        });
      }
      for (const a of missing.aliases || []) {
        cannot(req, `network '${a.network}' aliases`, null,
          `network '${a.network}' exists on '${machine.docker_ctx}' but is missing required `
          + `alias(es): ${(a.aliases || []).join(', ')} — a container was recreated without them. `
          + `The bootstrap never reconfigures a running container; re-create it via compose.`);
      }
      for (const v of missing.volumes || []) {
        if (v.create === 'empty') {
          // The manifest — the project's OWN authority — declares empty a valid start (decision
          // record, item 3). Every other volume is DATA: named, never created.
          steps.push({
            kind: 'volume', target: v.name,
            why: `required external volume '${v.name}' does not exist on '${machine.docker_ctx}' `
              + `and the manifest marks it safe to create empty`,
            action: `docker volume create ${v.name}`,
            status: 'planned', detail: null, stderr: null,
          });
        } else {
          cannot(req, `volume '${v.name}'`, null,
            `required external volume '${v.name}' does not exist on '${machine.docker_ctx}' — external `
            + `volumes are DATA and are NEVER auto-created. Create it from the project's bootstrap `
            + `doc, then re-check.`);
        }
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

  if (step.kind === 'volume') {
    // The create:empty opt-in only (decision record, item 3). Same idempotent shape as the network
    // performer: inspect → create → tolerate the "already exists" race, so a re-run after a partial
    // failure cannot fail on a volume the first run made.
    const exists = await docker(machine.docker_ctx, ['volume', 'inspect', step.target]);
    if (!exists.unknown && exists.status === 0) {
      return { status: 'already-present',
               detail: `volume '${step.target}' already exists on '${machine.docker_ctx}'`, stderr: null };
    }
    const r = await docker(machine.docker_ctx, ['volume', 'create', step.target]);
    if (r.unknown) {
      return { status: 'failed',
               detail: `could not create volume '${step.target}' on '${machine.docker_ctx}': ${r.reason}`,
               stderr: null };
    }
    if (r.status !== 0) {
      if (/already exists/i.test((r.stderr || '') + (r.stdout || ''))) {
        return { status: 'already-present',
                 detail: `volume '${step.target}' already exists on '${machine.docker_ctx}' (appeared between check and create)`,
                 stderr: null };
      }
      return { status: 'failed',
               detail: `docker volume create '${step.target}' failed on '${machine.docker_ctx}'`,
               stderr: (r.stderr || r.stdout || '').trim() };
    }
    return { status: 'created',
             detail: `volume '${step.target}' created (empty) on '${machine.docker_ctx}'`, stderr: null };
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
    // compose, an existing management.json has only its placeholders filled (never an operator's own
    // value), and a second perform after a successful one reports already-present. A refused secret,
    // a missing compose file or an unreachable daemon is a NAMED cannot — never a half-started plane.
    const file = config.meshComposeFile;
    if (!file || !existsSync(file)) {
      return { status: 'cannot',
               detail: `the queenzee's compose file was not found at '${file}' — set MESH_COMPOSE_FILE to the `
                 + `install's compose file (the one defining the mesh profile) and re-run. The control plane `
                 + `lives in the queenzee's own compose project, on the queenzee's own docker context.`,
               stderr: null };
    }
    // THE CONSOLE'S VALUES for THIS machine, with the secrets (the one reader that must have them —
    // the API layer never calls this). Everything the step does below is stated in terms of these,
    // so the console is the source of truth and the env is only the fallback.
    const performer = await meshResolvedForPerformer(machine.id);
    const values = performer.values;
    const mjOverrides = {
      signalUri: values.signal_uri, relayAddress: values.relay_endpoint,
      relaySecret: values.relay_auth_secret, datastoreEncryptionKey: values.datastore_encryption_key,
    };
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
      const mj = ensureManagementJson(file, { overrides: mjOverrides });
      if (mj.error) return { status: 'cannot', detail: mj.error, stderr: null };
      // The ports/domain/secrets ride as ENV on the compose child, never as argv: they are what the
      // containers are created with, and the install's .env stops being the only place they live.
      const up = await docker(machine.docker_ctx,
        ['compose', '-f', file, '--profile', 'mesh', 'up', '-d', ...MESH_CONTROL_PLANE_SERVICES],
        { env: composeEnvFor(values) });
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
    if (!hc.ok) {
      const { missing, already } = meshOperatorEnv();
      const envLine = `by hand on the queenzee: ${missing.join(', ')}`
        + (already.length ? ` (already set: ${already.join(', ')})` : '');
      return { status: 'failed',
               detail: `the control plane containers ${started ? 'started' : 'are running'} from '${file}' but `
                 + `the management API at ${hc.host}:${hc.port} is not answering `
                 + `(${hc.verdict || hc.reason}) — check the service logs; then set ${envLine}.`,
               stderr: null };
    }
    // THE FIRST PAT (§3.1 / §11): a ManagerType-none plane has no supported way to create its first
    // account, so with no token anywhere this bootstraps it into the pinned store and records it in
    // the mesh config. Only when NO token exists — an operator's env token is never overwritten.
    let patNote = null;
    let warning = null;
    if (!config.netbirdApiToken) {
      const boot = await (mesh.bootstrapPat || bootstrapFirstPat)({
        docker, ctx: machine.docker_ctx, dataKey: values.datastore_encryption_key,
        probe: mesh.probeApi || probeManagementApi,
        ...(mesh.storeDir ? { storeDir: mesh.storeDir } : {}),
        ...(mesh.openStore ? { openStore: mesh.openStore } : {}),
      });
      if (boot.ok) {
        const cfg = await recordBootstrappedPat(machine.id, boot.token, { values: performer.values });
        await applyMeshConfig({ machineId: machine.id });
        patNote = `The first API token was bootstrapped into the control plane (v${boot.version}) and `
          + `stored write-only in this machine's mesh config (hint ${cfg.secrets.api_token.hint}) — the `
          + `queenzee now reaches the plane without a hand-set env token.`;
      } else if (boot.token) {
        // The store WAS seeded and written back — only what came AFTER it failed. That token is in
        // the control plane and its plaintext exists nowhere else, so record it rather than drop it:
        // a retry would see an existing account (alreadyPresent) and ask a human to mint a PAT by
        // hand, the exact hand-edit §1 removes, with the minted token unrecoverable. A WARNING, not
        // a note — the plane did not answer, so the human must still read the service logs.
        const cfg = await recordBootstrappedPat(machine.id, boot.token, { values: performer.values });
        await applyMeshConfig({ machineId: machine.id });
        warning = `the first API token WAS minted and stored write-only `
          + `(hint ${cfg.secrets.api_token.hint}), but the control plane did not come up clean: `
          + `${boot.reason}`;
      } else if (boot.alreadyPresent || boot.refused) {
        warning = `the first API token was NOT bootstrapped: ${boot.reason}`;
      } else {
        warning = `the first API token could not be bootstrapped: ${boot.reason}`;
      }
    }
    const { missing, already } = meshOperatorEnv();
    const envLine = missing.length
      ? `Still set by hand on the queenzee: ${missing.join(', ')}`
        + (already.length ? ` (already set: ${already.join(', ')})` : '')
      : `Nothing left by hand (already set: ${already.join(', ')})`;
    const secretLine = patNote
      ? patNote
      : `No secret was minted or stored by this step — the datastore key and relay secret come from `
        + `the mesh config (console or env), and the first PAT is bootstrapped here when none exists.`;
    return { status: started ? 'created' : 'already-present',
             ...(warning ? { warning } : {}),
             detail: `control plane ${started ? 'brought up' : 'already running'} on '${machine.docker_ctx}' `
               + `(${MESH_CONTROL_PLANE_SERVICES.join(', ')}) — the management API answered at `
               + `${hc.host}:${hc.port}. ${envLine} ${secretLine}`
               + (warning ? ` ${warning}` : ''),
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
//
// `kinds` SCOPES a perform to the named step kinds only (the Mesh panel's control-plane stand-up
// must not create a project's networks/dev-db as a side effect of standing up the mesh). The plan
// is still computed in full — the dev-only guard, the refusal and the prod disclosure all fire on
// the whole picture — but only steps of the requested kinds are performed and recorded. null =
// every performable step (the 🔧 card's behaviour).
export async function performBuildBootstrap(projectId, machineId,
  { dryRun = false, docker = dockerAdapter, provisionDb = provisionDevDb,
    actor = 'human@console', mesh = {}, kinds = null } = {}) {
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
    if (kinds && !kinds.includes(step.kind)) continue;   // scoped action: leave unrelated steps alone
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

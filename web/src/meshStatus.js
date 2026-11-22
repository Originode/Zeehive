// IS THE MESH CONTROL PLANE UP? The one place the console turns the per-machine mesh-status read
// into words — the same split gatewayHealth.js makes for the LLM gateway, and for the same reason:
// a PURE function kept out of the JSX so every surface that shows the mesh says the SAME thing, and
// so it can be tested in plain node.
//
// The state is a WORD, colour is reinforcement. And the honesty rule that matters most here: a read
// that FAILED is not a verdict. If the console cannot read the status (no server route yet, a 500,
// an unreachable server), the chip must NOT say MESH DOWN — it says it could not read, muted. Only
// `management.reachable === false` from an ANSWERED read is an outage, and only that one is loud.
//
// Why it exists: the control plane is the routing substrate (mesh-routes.js). While it is down the
// fleet silently falls back to legacy ports, and until this chip the only place that fact lived was
// a collapsed per-machine panel — so a human had to already suspect the mesh to find out it was
// gone. `meshStatusWord` is what the always-visible chip in the status line says instead.

// Poll gently: the status is management health + peer counts, neither of which moves on a
// sub-minute timescale, and this rides the console HEADER (always mounted) rather than a panel a
// human opened. One read a minute is the whole cost.
export const MESH_POLL_MS = 60_000;

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const tri = (v) => (v === true ? true : v === false ? false : null);

// IS THIS FLEET SUPPOSED TO HAVE A MESH? Tri-state, and the distinction is the whole point of the
// chip's quiet state: FALSE means "deliberately not configured" (nobody set a management URL and no
// secret is stored — the design decision, and every route answers legacy-port by design), while
// NULL means "cannot tell" (the config read failed and nobody said), which is never rendered as
// either "not set up" or "down".
//
// An explicit enabled/configured flag from EITHER read wins: the server half may put the decision
// on mesh-status (the mesh is enabled for the fleet) instead of inferring it from stored config, and
// a fleet with an explicit `enabled: false` is not "unreadable" — it is off on purpose.
export function meshConfigured(cfg, status) {
  // `status.mesh.enabled` is the server's own spelling (lib/mesh-status.js nests the mesh's switch
  // under `mesh`); the top level and the canonical `configured` are tolerated too, so the chip
  // reads the same answer whichever of the two reads answered.
  const explicit = tri(cfg?.enabled) ?? tri(status?.enabled) ?? tri(status?.mesh?.enabled)
    ?? tri(cfg?.configured) ?? tri(status?.configured);
  if (explicit !== null) return explicit;
  if (!cfg) return null;
  if (nonEmpty(cfg.fields?.management_url)) return true;
  if (Object.values(cfg.secrets || {}).some((s) => s && s.set)) return true;
  return false;
}

// The chip's word for a machine's mesh state. `configured` is meshConfigured()'s tri-state,
// `status` the server's { management:{reachable,error}, peers, tally }, `error` a READ failure, and
// `address` the management URL the CONFIG holds (the status read may not repeat it — naming the
// address that does not answer is the whole actionability of the down chip).
export function meshStatusWord({ configured = null, status = null, error = null, machineKey = null,
                                 address = null } = {}) {
  const mgmt = status?.management || null;
  const addr = mgmt?.url || mgmt?.address || status?.url || address || null;
  const where = machineKey ? ` on ${machineKey}` : '';
  const at = addr ? ` at ${addr}` : '';

  if (mgmt?.reachable === true) {
    return {
      kind: 'mesh_ok',
      loud: false,
      chip: `mesh: up${at}`,
      why: `The self-hosted NetBird control plane answers${at}${where}, so mesh routes are being `
         + 'handed out.',
    };
  }
  // DELIBERATELY not configured — checked BEFORE the down branch, because a fleet with no mesh is
  // not an outage: routing answers legacy-port by design (that is the config's documented no-op).
  if (configured === false) {
    return {
      kind: 'mesh_not_set_up',
      loud: false,
      chip: 'mesh: not set up',
      why: 'No mesh is configured for this fleet — no management URL and none of the three mesh '
         + 'secrets are set, so every route deliberately answers legacy-port. Click to open the '
         + 'queenzee-host machine\'s Mesh panel and configure it.',
    };
  }
  if (mgmt?.reachable === false) {
    return {
      kind: 'mesh_down',
      loud: true,
      chip: `⚠ MESH DOWN${addr ? ` — no management${at}` : ' — management unreachable'}`,
      why: `The mesh control plane's management API does not answer${at}${where}`
         + (mgmt.error ? ` (${mgmt.error})` : '')
         + '. Mesh routing is not being handed out, so the fleet is falling back to legacy ports. '
         + 'Open the machine\'s Mesh panel to stand the control plane up or fix its connection.',
    };
  }
  if (error) {
    // A read that FAILED is not a verdict. Say so, muted: screaming MESH DOWN off a 404 console
    // route would be the same class of lie as reading a well-formed answer off the wrong server.
    return {
      kind: 'mesh_unknown',
      loud: false,
      chip: 'mesh: status unreadable',
      why: `The console could not read the mesh status${where}: ${error}. This is a READ failure, `
         + 'not a verdict — nothing here claims the control plane is down.',
    };
  }
  return {
    kind: 'mesh_unknown',
    loud: false,
    chip: 'mesh: no verdict yet',
    why: `A management URL is configured${where}, so this fleet DOES expect a mesh, but the status `
       + 'read has not reported whether management answers yet.',
  };
}

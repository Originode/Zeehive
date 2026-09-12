// THE ALWAYS-VISIBLE MESH INDICATOR — the mesh control plane's state in the console status line.
//
// The per-machine Mesh panel (Mesh.jsx) answers "what IS the mesh doing on this machine?" for a
// human who already suspected something. This answers the other question — "is the mesh up at all?"
// — from the console's global chrome, for a human who has never opened that panel. The card asked
// for exactly three states, and the important one is the loud one: mesh configured-or-enabled and
// management unreachable is an OUTAGE (the fleet is falling back to legacy ports), and it must be
// the most obvious thing on the screen, not a fact inside a collapsed panel.
//
//   configured + management unreachable → ⚠ MESH DOWN, danger, LOUD, click-through to the panel
//   deliberately not configured         → "mesh: not set up", quiet neutral, click-through to set it up
//   management reachable                → "mesh: up", calm green
//   could not read / nothing settled    → muted "no verdict" — NEVER the loud state (meshStatus.js)
//
// It reads the SAME two endpoints the panel reads (api.js getMeshConfig + getMeshStatus) for the
// ONE machine that can host the control plane — the queenzee host, since the plane runs in the
// queenzee's own compose project (netbird.js MESH_CONTROL_PLANE_CONTAINER). There is no fleet-wide
// mesh read to ride, so this polls gently: one pair of small GETs a minute, and only while this
// component is mounted (the console header — always).
//
// Body/wrapper split, the same one Mesh.jsx makes: MeshStatusChipBody is a PURE FUNCTION OF PROPS so
// a test can render every state through react-dom/server and read the markup back; the fetches and
// the timer live in the default export.
import React, { useState, useEffect, useCallback } from 'react';
import { getMeshConfig, getMeshStatus } from './api.js';
import { normalizeMeshConfig } from './Mesh.jsx';
import { meshStatusWord, meshConfigured, MESH_POLL_MS } from './meshStatus.js';

// PURE. `host` is the machine whose control plane this is (null → nothing to say, render nothing),
// `cfg` the normalized mesh config (null = unreadable), `status` the server's status read,
// `error` a read failure message, `onOpenMesh(key)` the click-through.
export function MeshStatusChipBody({ host = null, cfg = null, status = null, error = null, onOpenMesh = null }) {
  if (!host) return null;
  const word = meshStatusWord({
    configured: meshConfigured(cfg, status), status, error, machineKey: host.key,
    // The config read is where the URL lives; the status read may not repeat it.
    address: cfg?.fields?.management_url || null,
  });
  const open = onOpenMesh ? () => onOpenMesh(host.key) : null;
  return (
    <span className={`mesh-status ${word.kind}${word.loud ? ' loud' : ''}`}
          data-testid="mesh-status" data-kind={word.kind} data-loud={word.loud ? '1' : undefined}
          // The loud state is a live alarm, not decoration: assistive tech hears the transition.
          role={word.loud ? 'status' : undefined}
          title={word.why + (open ? `\n\nClick to open the Mesh panel on ${host.key}.` : '')}
          onClick={open || undefined}
          style={open ? { cursor: 'pointer' } : undefined}>
      {' · '}{word.chip}
    </span>
  );
}

// The stateful chip: resolve the queenzee-host machine, then poll config + status together. Both
// reads are tolerated to fail independently — the panel's tolerance, so a server half that has not
// shipped the route yet degrades to a muted chip rather than a console error.
export default function MeshStatusChip({ machines = [], onOpenMesh = null }) {
  const host = (machines || []).find((m) => m && m.is_queenzee_host) || null;
  const id = host?.id || null;
  const [cfg, setCfg] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  const read = useCallback(async () => {
    if (!id) return;
    const [c, s] = await Promise.all([
      getMeshConfig(id).then((r) => ({ ok: true, v: normalizeMeshConfig(r) }))
        .catch(() => ({ ok: false })),
      getMeshStatus(id).then((r) => ({ ok: true, v: r }))
        .catch((e) => ({ ok: false, e: e?.error || e?.message || String(e) })),
    ]);
    // A failed read must not leave the previous verdict standing (a green chip over a route that
    // now 500s is worse than no chip): clear it into the unknown state, where the word says so.
    setCfg(c.ok ? c.v : null);
    setStatus(s.ok ? s.v : null);
    setError(s.ok ? null : s.e);
  }, [id]);

  useEffect(() => {
    if (!id) return undefined;
    read();
    const t = setInterval(read, MESH_POLL_MS);
    return () => clearInterval(t);
  }, [id, read]);

  return <MeshStatusChipBody host={host} cfg={cfg} status={status} error={error}
                             onOpenMesh={onOpenMesh} />;
}

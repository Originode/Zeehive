-- MESH PEER REGISTRY (docs/netbird-mesh-plan.md §4, phase 1).
--
-- The authoritative mapping between fleet rows and NetBird control-plane peers. The split of
-- authority is the point of the table (every reconciler bug becomes this question):
--   * the META-DB is authoritative for INTENT — which peers should exist. A control-plane peer
--     with no active row here is a leak the janitor deletes.
--   * the CONTROL PLANE is authoritative for LIVE state — the assigned IP, connectedness.
--     ip/nb_peer_id are caches stamped on join and refreshed by the janitor.
--
-- One peer kind per fleet noun: 'machine' (a build/db host), 'xell' (a spin stack's sidecar),
-- 'xhip' (a device stack), 'gateway' (the queenzee machine's cage-facing hop). hostname is the
-- mesh identity (<slug>/<machine-key>) and is unique among ACTIVE peers only — a retired xell's
-- removed row must not block a future xell from ever reusing a hostname.
--
-- Setup keys are minted ephemeral/usage-1 via the management API and referenced here by id for
-- audit; the KEY ITSELF is never stored (it is consumed at join). The management API token is
-- queenzee config (env), never a row.
CREATE TABLE IF NOT EXISTS mesh_peer (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES project ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('machine','xell','xhip','gateway')),
  xell_id         uuid REFERENCES xell ON DELETE SET NULL,
  machine_id      uuid REFERENCES machine ON DELETE SET NULL,
  hostname        text NOT NULL,
  nb_peer_id      text,
  nb_setup_key_id text,
  ip              inet,
  status          text NOT NULL DEFAULT 'minted' CHECK (status IN ('minted','joined','removed','degraded')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz,
  -- the kind names which fleet noun the peer is bound to
  CONSTRAINT mesh_peer_kind_binding CHECK (
    (kind = 'xell')    = (xell_id IS NOT NULL) AND
    (kind = 'machine') = (machine_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS mesh_peer_active_hostname
  ON mesh_peer (hostname) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS mesh_peer_xell_idx ON mesh_peer (xell_id);
CREATE INDEX IF NOT EXISTS mesh_peer_project_idx ON mesh_peer (project_id, kind);

COMMENT ON TABLE mesh_peer IS 'Fleet row <-> NetBird control-plane peer mapping (docs/netbird-mesh-plan.md). Meta-DB = intent (which peers should exist); control plane = live state (ip, connectedness — cached here). removed_at set = deregistered; active hostnames are unique.';

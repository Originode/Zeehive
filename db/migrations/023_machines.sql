-- Machines: the physical docker hosts the hive runs on, as first-class rows — ugreen-nas,
-- mardale-prod, this PC, and whatever joins later. Before this, "where" lived as bare docker
-- context strings scattered across container/deploy_site rows, and nothing could say what a host
-- IS: whether it can compile (the NAS cannot), how many dev xells it should carry, or which host
-- new work should land on first.
--
--   docker_ctx   : the docker context name (on the queenzee's machine) that reaches this host's
--                  daemon. UNIQUE — one row per daemon; container.docker_ctx joins here.
--   host_ip      : the LAN address xell URLs use when a xell spawns here (NULL → legacy default).
--   can_build    : is this host suitable for COMPILING images? false ⇒ xells that run here get
--                  their build_ctx pointed at the best can_build machine (registry handoff).
--   dev_priority : spawn preference for DEV xells. 0 ⇒ never a dev spawn target (mardale-prod).
--                  Higher wins: the pool fills and dispatch claims on the highest-priority
--                  machine with room first.
--   pool_size    : how many READY (pre-warmed) xells the pool maintainer keeps on this machine.
--                  Per-machine; when any dev machine exists these replace pool_config.target_ready.
--   max_xells    : hard cap of live dev xells (ready + claimed + working) on this machine.
--
-- A dev machine also needs its OWN shared dev db (a container row: role='db', tier='dev',
-- isolation='shared', docker_ctx = this machine) — a xell's app tier must never reach across
-- contexts for its database. Provisioning REFUSES a machine with no dev db rather than silently
-- pointing at another host's postgres.
CREATE TABLE IF NOT EXISTS machine (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,40}$'),
  label        text,
  docker_ctx   text NOT NULL UNIQUE,
  host_ip      text,
  can_build    boolean NOT NULL DEFAULT false,
  dev_priority integer NOT NULL DEFAULT 0 CHECK (dev_priority >= 0),
  pool_size    integer NOT NULL DEFAULT 0 CHECK (pool_size >= 0),
  max_xells    integer NOT NULL DEFAULT 0 CHECK (max_xells >= 0),
  enabled      boolean NOT NULL DEFAULT true,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

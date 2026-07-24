-- SHIP BUNDLE — ship several DEFERRED production ships as ONE combined deploy.
--
-- Defer (039) exists so a human can let landings pile up on main and then make ONE ship instead
-- of a prod deploy per commit. But the console only ever let a human RESUME one deferred ship at a
-- time — and resuming N of them is back to N deploys of (identically) the current main tip, which
-- is exactly the "noisy and needless" thing defer set out to avoid. Bundling closes that: the
-- human clicks once, the queenzee elects ONE deferred ship per prod site as the CARRIER, re-aims
-- it at the current main tip and ships it, and every other deferred ship for that site RIDES that
-- single build — their landed work is already in the main tip it builds, so they share its verdict.
--
-- `bundled_into` is that ride-along link: a set-aside (still pending + deferred) ship pointing at
-- the carrier whose one real deploy will resolve it. The carrier itself has bundled_into = NULL
-- (it is the thing that builds). When the carrier's runShip finishes, every row that points at it
-- is resolved to the carrier's status (shipped/failed) from that one deploy. ON DELETE SET NULL so
-- a carrier that is later withdrawn simply frees its riders back to plain-deferred.
ALTER TABLE ship_request
  ADD COLUMN IF NOT EXISTS bundled_into uuid REFERENCES ship_request(id) ON DELETE SET NULL;

-- Riders are looked up by their carrier when the carrier's deploy settles.
CREATE INDEX IF NOT EXISTS ship_request_bundled_into_idx ON ship_request (bundled_into)
  WHERE bundled_into IS NOT NULL;

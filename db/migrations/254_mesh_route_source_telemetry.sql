-- MESH ROUTE SOURCE TELEMETRY — the number that gates phase 5 (docs/netbird-mesh-plan.md §3.4,
-- §6 phase 5, §10 follow-up 3).
--
-- §3.4 made every `zee routes` answer carry a `source` ('mesh' | 'legacy-port') precisely so the
-- migration is observable per caller, and §6 says phase 5 (drop the generated per-xell `ports:`,
-- remove the allocator) ships only once "router `source` telemetry shows no `legacy-port`
-- consumers for per-xell targets". Until this table there was no telemetry at all: the answer was
-- derived, printed and forgotten, and the gate it exists to open had nothing to read.
--
-- ONE COUNTER ROW PER (day, target_kind, source). What the gate asks is a COUNT over a window
-- ("any legacy-port answers in the last N days?"), not a per-call play-by-play — so this is a
-- counter, not an event ledger: the recorder bumps `n` with an UPSERT and the table stays tiny
-- however often `zee routes` is called. `day` is the UTC date, computed explicitly in SQL, because
-- a per-day tally must not move when the meta-DB's local timezone setting does.
--
-- The recorder is catch-guarded and best-effort (lib/mesh-route-telemetry.js): telemetry must
-- never fail the read it describes, and a database that has not applied this migration must
-- degrade to "no telemetry", never to a broken `zee routes`. Read by `zee routes --tally`
-- (GET /api/xell/self/routes/tally, MANAGER only) — NOT by the `zee ops` digest, which
-- test/delivery-telemetry.test.mjs (TKT-42) pins against growth.
CREATE TABLE IF NOT EXISTS mesh_route_stat (
  day         date NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('db','server','webapp')),
  source      text NOT NULL CHECK (source IN ('mesh','legacy-port')),
  n           bigint NOT NULL DEFAULT 0,
  first_at    timestamptz NOT NULL DEFAULT now(),
  last_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, target_kind, source)
);

COMMENT ON TABLE mesh_route_stat IS
  'Per-day counter of `zee routes` answers, by target kind and source (docs/netbird-mesh-plan.md '
  '§3.4 / §6 phase 5): the telemetry phase 5 is gated on. Bumped best-effort by '
  'lib/mesh-route-telemetry.js; read by `zee routes --tally` (GET /api/xell/self/routes/tally).';

-- THE MANAGER MANUAL: `zee routes --tally` — the phase-5 gate, readable by the zees who own the
-- decision (docs/netbird-mesh-plan.md §3.4/§6/§10 follow-up 3; migration 254 holds the counter).
--
-- Phase 5 (drop the generated per-xell `ports:`, delete the allocator) ships only once router
-- `source` telemetry shows no `legacy-port` consumers for per-xell targets. That tally is
-- FLEET-WIDE, so it belongs to the manager surface — the same trade `zee ops` makes (fleet
-- visibility for a role that does not write) — and it is a flag on the router's own verb rather
-- than a field on the routes answer, whose shape is a settled contract about ONE xell.
--
-- House rule 8: what a zee is told is versioned like code, so the CLI usage line for `zee routes`
-- advertises `--tally` in the same change as this text. The flag does NOT add a verb, so
-- test/cxell-cli-drift.test.mjs (e) has nothing new to demand of the WORKER manual — this section
-- goes to the manager manual, where the flag's audience lives. `dev-lead`, `router`, `master`,
-- `infra-medic` and `queenzee-minister` all inherit this text, so patching `manager` is the whole
-- of it.
--
-- APPENDED, not anchored, for the reason 123 gives: the manager manual is human-editable in the
-- harness manager, so any line to anchor on may have moved. The guard returns early when the
-- section is already there, and harness_memory_put (house rule 9 / 076) replaces the ONE entry and
-- keeps every sibling. Flag-level detail stays in the CLI's usage text — restating it here is how
-- the two drift.
DO $$
DECLARE
  txt text;
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;
  IF txt LIKE '%zee routes --tally%' THEN
    RAISE NOTICE 'manager manual: the route-source tally is already documented';
    RETURN;
  END IF;

  txt := txt || $hz$

### The phase-5 gate — `zee routes --tally`

`zee routes` is every zee's read of how IT reaches its own db/server/webapp, and each answer says
which world produced it: `mesh` (a joined mesh peer) or `legacy-port` (the recorded host:port).
Migration 254 counts those answers per UTC day, target kind and source, and this flag reads the
count back:

```
zee routes --tally [--days N]
```

**It is MANAGER-only**, because the tally is fleet-wide — reach it when you are asked whether the
mesh migration is actually landing, or when deciding phase 5 of `docs/netbird-mesh-plan.md`:
stopping per-xell port publishing and deleting the allocator is gated on the answer being **no
`legacy-port` consumers for per-xell targets**, over a window long enough to mean something.
`--days` widens the window (default 14, clamped to 90).

The payload carries `by_source` and `by_kind` totals plus the raw per-day rows. Two honest limits,
stated in the payload rather than hidden: a role a xell does not have records NO row (there was no
answer), and a shared dev db answers through its HOST's machine peer by design — read `by_kind`,
not just the total, before concluding anything about a rollout. A database behind the migration
ledger answers an `error` beside empty buckets instead of failing.

$hz$;
  PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
  RAISE NOTICE 'manager manual: zee routes --tally documented';
END $$;

-- DOCUMENT `zee infra` IN THE WORKER MANUAL — the verb family reaches the CLI and the API, so it
-- must reach the manual too (house rule 8 / test/cxell-cli-drift.test.mjs (e): a verb a zee has must
-- be a verb its manual mentions). Stage 3, build item 3.
--
-- The infra-medic surface is capability-gated: the SERVER refuses a plain worker with a clear 403,
-- so the manual can name the family for every zee without granting anything — wearing the
-- infra-medic harness IS the grant (plan §7.2). The runbook proper lives in the medic's OWN memory
-- (238); this edit adds the index lines + a pointer so a worker that INHERITS the manual knows the
-- door exists and who it belongs to.
--
-- Anchored + idempotent, the 090/085/111 pattern: locate BY PATH via harness_memory_get, do nothing
-- when already documented or when the anchor has moved (a RAISE NOTICE, never a throw — the drift
-- lint is the one that catches a moved anchor), and write back through harness_memory_put. No
-- hand-rolled jsonb on the bundle anywhere (house rule 9).
DO $$
DECLARE
  txt      text;
  verbline text;
  section  text;
  anchor   text := '# ASK for the next free db/migrations number (NOT gated)';
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'zee-base manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;
  IF txt LIKE '%zee infra%' THEN
    RAISE NOTICE 'zee-base manual: zee infra is already documented';
    RETURN;
  END IF;
  IF position(anchor IN txt) = 0 THEN
    RAISE NOTICE 'zee-base manual: the migration-number anchor has moved — add the zee infra verb family by hand';
    RETURN;
  END IF;

  verbline := $hz$  zee infra readiness [--machine <key>] [--refresh]   # run/read machine×project readiness for YOUR project (NOT gated)
  zee infra proof --xell <slug>                       # BURN-IN a pooled xell of YOUR project — throwaway containers (NOT gated)
  zee infra bootstrap --plan --machine <id>           # the DRY-RUN plan performBuildBootstrap already computes (NOT gated)
  zee infra bootstrap --perform --machine <id> [--reason "…"]   # HUMAN-GATED CARD → the queenzee performs on approval
  zee infra settings                                  # NON-SECRET projection of YOUR project's settings (never a token or password)
  zee infra propose --change '<json>' --reason "…"    # HUMAN-GATED settings card → the queenzee applies on approval$hz$;

  section := $hz$
### `zee infra …` — the INFRA-MEDIC surface (provision-proof plan §7)

`zee infra` is the infra-medic's surface: it reads YOUR project's provisioning evidence (the
readiness ladder, proof verdicts, bootstrap plans, the non-secret settings projection) and raises
the two HUMAN-GATED CARDS that change real infra or settings. The server gates EVERY subcommand on
the calling xell's effective harness chain carrying the `infra-troubleshoot` capability — a plain
worker is refused with a clear 403, so wearing the infra-medic harness IS the grant. Read wide,
write through gates: `readiness` / `proof` / `bootstrap --plan` / `settings` are NOT gated;
`bootstrap --perform` and `propose` are HUMAN-GATED CARDS that perform NOTHING until a human
approves, then the queenzee performs and the card becomes the receipt. The full runbook is the
infra-medic harness's own memory (`memory/infra-medic-manual.md`). Standing refusals, always: never
ask for a write DSN to the meta-DB (postgres refuses, not a prompt), never route around a gate, and
report unfixed faults with the named check.$hz$;

  txt := replace(txt, anchor, anchor || E'\n' || verbline || section);

  PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
  RAISE NOTICE 'zee-base manual: documented the zee infra verb family';
END $$;

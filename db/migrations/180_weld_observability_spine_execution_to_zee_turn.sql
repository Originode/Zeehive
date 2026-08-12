-- THE OBSERVABILITY SPINE — execution → zee_turn → llm_gateway_request (the drill-down waterfall)
-- (docs/hierarchical-workflow-adoption.md §3.2 — the observability join; the WELD stage)
--
-- The workflow run plane (execution, 177) and the observability ledgers (zee_turn, 153;
-- llm_gateway_request, 154) have lived apart: a human looking at what an execution did had no
-- path to the turns that did it, and a human looking at a turn had no path to the execution it
-- belonged to. This migration welds them so the chain
--
--     execution → zee_turn → llm_gateway_request
--
-- becomes the drill-down waterfall. Every row in the chain is a byproduct of a DOOR (the
-- queenzee's state transitions write zee_turn; the gateway proxy writes llm_gateway_request;
-- the engine writes execution) — nothing is agent-submitted.
--
-- TWO additions, both additive + idempotent:
--
--   1. zee_turn.execution_id — a NULLABLE FK to execution(id). The QUEENZEE stamps it when it
--      starts a turn for a DISPATCHED execution (spawn / resume / interactive), so the turn
--      records which execution it advanced. A turn with no execution keeps recording with
--      execution_id NULL (every historic turn and every standalone turn — the fleet's ordinary
--      xells — is exactly that). No backfill.
--
--   2. xell.execution_id — a NULLABLE FK to execution(id). The xell is the durable work unit
--      (it survives zee swaps and re-dispatches), so it is the natural home for "which execution
--      is this xell's zee working on". It is what lets the queenzee KNOW the execution when it
--      starts a turn (the stamp above) and when it handles `zee handover --result` / `zee await` —
--      both of which resolve the execution from the CALLER's xell, never from an agent-named id.
--      Stamped when a dispatch binds a zee to an execution (the workflow dispatch path — the
--      simulate-gated part proven through test/workflow-weld.test.mjs).
--
-- FORWARD-ONLY: ADD COLUMN IF NOT EXISTS, so a second migrate pass is a clean no-op. The DOWN
-- thinking (never run in prod): DROP INDEX zee_turn_execution_idx, DROP INDEX xell_execution_idx,
-- then ALTER TABLE … DROP COLUMN execution_id on each. Nothing existing reads either column, so
-- the weld is inert on databases where the workflow plane has never run.
ALTER TABLE zee_turn ADD COLUMN IF NOT EXISTS execution_id uuid REFERENCES execution(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS zee_turn_execution_idx ON zee_turn (execution_id) WHERE execution_id IS NOT NULL;

ALTER TABLE xell ADD COLUMN IF NOT EXISTS execution_id uuid REFERENCES execution(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS xell_execution_idx ON xell (execution_id) WHERE execution_id IS NOT NULL;

-- ── THE WORKER MANUAL: `zee handover` and `zee await` ─────────────────────────────────────────
-- House rule 8 — what a zee is told is versioned like code: the CLI usage, the API and the manual
-- move together, and test/cxell-cli-drift.test.mjs §e fails the build until the manual names every
-- verb the CLI advertises. Both new verbs are WORKER verbs (any zee), so they belong in the worker
-- manual (the cxell-zee-manual memory entry on the zee-base harness).
--
-- FORM: 076's harness_memory_get/_put — by PATH, idempotent, every sibling memory entry preserved
-- (house rule 9; test/harness-memory-migrations.test.mjs fails anything that hand-rolls it). Same
-- shape as 129/133, which documented `zee turn` / `zee creds --export` for exactly this reason.
DO $mig$
DECLARE
  txt           text;
  changed       boolean := false;
  list_old      text := E'zee item [<id>] --status <s> [--progress N] [--note "…"]   # report where YOUR work item has got to\n';
  list_new      text := E'zee item [<id>] --status <s> [--progress N] [--note "…"]   # report where YOUR work item has got to\nzee handover --result <json>                        # store your typed result on the execution you are on (interim, until the data plane)\nzee await [--for <hours>]                            # END your turn, hold a lease, mark the execution waiting (the anti-spin primitive)\n';
  anchor_sec    text := E'### `zee sync` — catch up / rebase your branch onto current main';
  section       text;
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'worker manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;

  section := $sec$### `zee handover` · `zee await` — the workflow execution the zee is on

`POST /api/xell/self/handover` `{ result }` · `POST /api/xell/self/await` `{ for? }`. When this xell is
bound to a PLANE-3 EXECUTION (the hierarchical-workflow model — docs/hierarchical-workflow-model.md),
`zee handover` stores a TYPED RESULT on that execution's `outputs`, and `zee await` ENDS the current
turn (tokens stop — the anti-spin primitive) and puts the execution into `waiting` under a HELD lease.
Both resolve the execution from THIS xell's binding — you never name an execution id; the queenzee
reads it off your xell, the way every other identity in the cage is resolved for you.

- `zee handover --result '<json>'` — interim-store the typed result on `execution.outputs` until the
  stage-2 data plane (ports) exists. The result is a JSON value (object, array, string, number — pass
  it quoted). This is the interim hand-over of "what the work produced".
- `zee await [--for <hours>]` — you are WAITING on something outside the model (a human gate, an
  external service, a timer). Instead of spinning and burning tokens, end the turn now, hold a lease
  on the execution (default 24h; `--for` overrides in hours), and mark it `waiting`. When the wait is
  over the queenzee resumes the work. A turn with no execution is refused — there is nothing to hold.

Both are REQUESTS through the API like every zee verb — the queenzee acts on your behalf and records
the byproduct (execution.outputs, the lease, the waiting state). No agent writes a ledger row by hand.

$sec$;

  IF position(list_new IN txt) = 0 THEN
    IF position(list_old IN txt) > 0 THEN
      txt := replace(txt, list_old, list_new); changed := true;
    ELSE
      RAISE NOTICE 'worker manual: the zee item CLI line has moved — the cheat-sheet lines were not added';
    END IF;
  END IF;

  IF position('### `zee handover`' IN txt) = 0 THEN
    IF position(anchor_sec IN txt) > 0 THEN
      txt := replace(txt, anchor_sec, section || E'\n' || anchor_sec); changed := true;
    ELSE
      RAISE NOTICE 'worker manual: the zee sync section has moved — appending the handover/await section at the end';
      txt := txt || E'\n' || section; changed := true;
    END IF;
  END IF;

  IF changed THEN
    PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
    RAISE NOTICE 'worker manual: zee handover and zee await documented';
  ELSE
    RAISE NOTICE 'worker manual: zee handover/await were already documented — nothing to do';
  END IF;
END
$mig$;

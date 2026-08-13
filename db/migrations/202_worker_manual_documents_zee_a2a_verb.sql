-- THE WORKER MANUAL: `zee a2a` — a zee sends an A2A message to an EXTERNAL agent.
--
-- WHY: phase 4 (P4) of the A2A adoption adds the outbound `zee a2a <card-url> --message "…"`
-- verb (plan §6 P4). The manual must name the verb a worker has — the CLI-drift test (section e)
-- fails a verb that no manual mentions: "an agent cannot use a door nobody told it about".
--
-- FORM: 076's harness_memory_get/_put — by PATH, idempotent, every sibling memory entry
-- preserved (house rule 9; test/harness-memory-migrations.test.mjs fails anything that
-- hand-rolls it). Two independent edits, each guarded on its own text: the verb line in the
-- cheat-sheet (anchored on `zee inbox`, its stable neighbour) and a short subsection placed
-- before "### `zee report` · `zee inbox`". An anchor that has moved appends at the end and says
-- so with a NOTICE, so the verb is documented on any database.
DO $mig$
DECLARE
  txt       text;
  changed   boolean := false;
  verbline  text;
  list_anchor text := E'zee inbox [--all]                                 # read what other zees sent you';
  section   text;
  sec_anchor text := E'### `zee report` · `zee inbox` — talking to your MANAGER';
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'worker manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;

  -- 1. the verb line in the CLI cheat-sheet, next to its neighbour `zee inbox`.
  verbline := E'zee a2a <card-url> --message "…"                        # send an A2A SendMessage to an EXTERNAL agent card URL — queenzee-mediated and recorded (NOT gated)';
  IF position(verbline IN txt) = 0 THEN
    IF position(list_anchor IN txt) > 0 THEN
      txt := replace(txt, list_anchor, list_anchor || E'\n' || verbline); changed := true;
    ELSE
      RAISE NOTICE 'worker manual: the zee inbox cheat-sheet line has moved — the zee a2a list line was not added';
    END IF;
  END IF;

  -- 2. a short section of its own, before the talking-to-your-manager deep-dive.
  section := $hz$### `zee a2a <card-url> --message "…"` — talk to an EXTERNAL agent

A2A (docs/a2a-protocol-plan.md) is the wire format for agent-to-agent conversations. This verb is
the outbound half for a target OUTSIDE the fleet: `zee a2a <card-url> --message "…"` sends an A2A
`SendMessage` to an external agent's card URL. It is QUEENZEE-MEDIATED — you never dial the
external server directly, the queenzee makes the HTTP call on your behalf — and the call is
RECORDED at the transport layer (like the LLM gateway records its calls), so the fleet always has
a record of what you asked an external agent to do even if that server never answers.

The <card-url> is the external agent's A2A card (an `AgentCard`, served by the external server at
`/.well-known/agent-card.json` or its own per-agent card URL). The queenzee fetches the card,
reads the JSON-RPC endpoint it declares, and POSTs the message there. Your message body is the
message text; the answer is the external server's JSON-RPC result (or a clear refusal).

```
zee a2a https://partner.example.com/a2a/v1/agents/support/card --message "ticket #4821 is done — closing"
```

NOT gated — it is your own xell making an outbound call, like `zee build`. It is not a way to
reach another zee in the fleet: internal conversations stay `zee say` / `zee report`, which are
already recorded in `zee_message`.

$hz$;

  IF position('### `zee a2a' IN txt) = 0 THEN
    IF position(sec_anchor IN txt) > 0 THEN
      txt := replace(txt, sec_anchor, section || sec_anchor);
    ELSE
      RAISE NOTICE 'worker manual: the report/inbox section has moved — appending the zee a2a section at the end';
      txt := txt || E'\n' || section;
    END IF;
    changed := true;
  END IF;

  IF changed THEN
    PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
    RAISE NOTICE 'worker manual: zee a2a documented';
  ELSE
    RAISE NOTICE 'worker manual: zee a2a was already documented — nothing to do';
  END IF;
END $mig$;

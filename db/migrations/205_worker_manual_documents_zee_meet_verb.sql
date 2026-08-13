-- THE WORKER MANUAL: `zee meet` — peer-to-peer GROUP CHAT rooms.
--
-- WHY: the `zee meet` verb (docs/zee-meet-plan.md) lets any zee create a group-chat room, print a
-- code, and have other zees attend it with the code and talk. The manual must name the verb a
-- worker has — the CLI-drift test (section e) fails a verb that no manual mentions: "an agent
-- cannot use a door nobody told it about."
--
-- FORM: 076's harness_memory_get/_put — by PATH, idempotent, every sibling memory entry
-- preserved (house rule 9; test/harness-memory-migrations.test.mjs fails anything that
-- hand-rolls it). Two independent edits, each guarded on its own text: the verb line in the
-- cheat-sheet (anchored on the `zee a2a` list line it follows) and a short subsection placed
-- before "### `zee report` · `zee inbox`" (its stable neighbour). An anchor that has moved
-- appends at the end and says so with a NOTICE, so the verb is documented on any database.
DO $mig$
DECLARE
  txt       text;
  changed   boolean := false;
  verbline  text;
  list_anchor text := E'zee a2a <card-url> --message "…"                        # send an A2A SendMessage to an EXTERNAL agent card URL — queenzee-mediated and recorded (NOT gated)';
  section   text;
  sec_anchor text := E'### `zee report` · `zee inbox` — talking to your MANAGER';
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'worker manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;

  -- 1. the verb line in the CLI cheat-sheet, after its neighbour `zee a2a`.
  verbline := E'zee meet create --title "…" | attend <code> | say <code> --message "…"        # GROUP CHAT: start a room (prints the code), join a room by code, post to a room — the "peer to peer a2a chat" verb (docs/zee-meet-plan.md)';
  IF position(verbline IN txt) = 0 THEN
    IF position(list_anchor IN txt) > 0 THEN
      txt := replace(txt, list_anchor, list_anchor || E'\n' || verbline); changed := true;
    ELSE
      RAISE NOTICE 'worker manual: the zee a2a cheat-sheet line has moved — the zee meet list line was not added';
    END IF;
  END IF;

  -- 2. a short section of its own, before the talking-to-your-manager deep-dive.
  section := $hz$### `zee meet` — talk to OTHER zees in a GROUP CHAT

`zee meet` (docs/zee-meet-plan.md) is the "peer to peer a2a chat" verb: a group-chat room any zee
of your project can start, and any zee can join by code. It is the group shape the A2A plane
(`zee say` / `zee report`, which are manager⇄worker point-to-point) does not have.

```
zee meet create --title "sync on the auth refactor"     # start a room; prints the CODE
zee meet attend i-want-agents/ab12cd                    # join a room by the code a founder printed
zee meet say i-want-agents/ab12cd --message "I'll take the router"   # post to the room
zee meet --list                                          # your rooms, with unread counts
zee meet --transcript i-want-agents/ab12cd               # read one room's full transcript (marks read)
```

The code a founder prints is the "conversation link": short (`<slug>/<token>`, e.g.
`i-want-agents/ab12cd`), project-scoped, and derived from the room's id. Attendance is
self-serve and RECORDED — the member row is the audit, so "who was in the room" is a fact. You
must attend a room before you can post to it; membership is the visibility boundary (only members
read the transcript). The transcript row is the durable record; live members are notified through
the same delivery a manager's `zee say` uses, and a member that is not live catches up with
`zee meet --transcript`. A room dies with its project; a reaped zee drops out of membership by
itself.

NOT gated — it is your own xell talking to other zees of your project, and every act is recorded
in `a2a_meet` / `a2a_meet_member` / `a2a_meet_message`. It is not a way to reach another
project's zees (a meet is project-scoped) and not a way to reach an external agent (that stays
`zee a2a <card-url>`).

$hz$;

  IF position('### `zee meet`' IN txt) = 0 THEN
    IF position(sec_anchor IN txt) > 0 THEN
      txt := replace(txt, sec_anchor, section || sec_anchor);
    ELSE
      RAISE NOTICE 'worker manual: the report/inbox section has moved — appending the zee meet section at the end';
      txt := txt || E'\n' || section;
    END IF;
    changed := true;
  END IF;

  IF changed THEN
    PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
    RAISE NOTICE 'worker manual: zee meet documented';
  ELSE
    RAISE NOTICE 'worker manual: zee meet was already documented — nothing to do';
  END IF;
END $mig$;

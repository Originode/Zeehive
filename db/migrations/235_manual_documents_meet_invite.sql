-- THE WORKER MANUAL: `zee meet invite` — founder invites another PROJECT into a room (DR-5).
--
-- WHY: migration 234 adds a2a_meet_invite and the invite verb. A verb that is not in the manual
-- does not exist to a zee (house rule 8; test/cxell-cli-drift.test.mjs section e). 205 documented
-- create/attend/say and said "it is not a way to reach another project's zees" — that sentence is
-- now false once a founder has invited, so the manual must be amended in the same landing.
--
-- FORM: 076's harness_memory_get/_put — by PATH, idempotent, every sibling memory entry
-- preserved (house rule 9). Three surgical edits, each guarded on its own text:
--   1. the cheat-sheet verb line grows "| invite <code> --project …";
--   2. the `### zee meet` body gains the invite subcommand in its example block;
--   3. the closing "not a way to reach another project's zees" sentence is rewritten to name
--      the invite path and keep the default (no invite → still refused).
DO $mig$
DECLARE
  txt       text;
  changed   boolean := false;
  old_verb  text;
  new_verb  text;
  old_close text;
  new_close text;
  old_ex    text;
  new_ex    text;
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'worker manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;

  -- 1. cheat-sheet verb line.
  old_verb := E'zee meet create --title "…" | attend <code> | say <code> --message "…"        # GROUP CHAT: start a room (prints the code), join a room by code, post to a room — the "peer to peer a2a chat" verb (docs/zee-meet-plan.md)';
  new_verb := E'zee meet create --title "…" | attend <code> | say <code> --message "…" | invite <code> --project <name>  # GROUP CHAT: start/join/post, or founder-invite another project (DR-5; docs/zee-meet-plan.md)';
  IF position(old_verb IN txt) > 0 THEN
    txt := replace(txt, old_verb, new_verb); changed := true;
  ELSIF position('invite <code> --project' IN txt) = 0 THEN
    RAISE NOTICE 'worker manual: the zee meet cheat-sheet line has moved — invite was not spliced into it';
  END IF;

  -- 2. example block inside the ### zee meet section — add the invite line after say.
  old_ex := E'zee meet say i-want-agents/ab12cd --message "I''ll take the router"   # post to the room
zee meet --list                                          # your rooms, with unread counts';
  new_ex := E'zee meet say i-want-agents/ab12cd --message "I''ll take the router"   # post to the room
zee meet invite i-want-agents/ab12cd --project other-proj  # FOUNDER: let another project''s zees in (--remove withdraws)
zee meet --list                                          # your rooms, with unread counts';
  IF position(old_ex IN txt) > 0 THEN
    txt := replace(txt, old_ex, new_ex); changed := true;
  ELSIF position('zee meet invite' IN txt) = 0 THEN
    RAISE NOTICE 'worker manual: the zee meet example block has moved — invite example was not added';
  END IF;

  -- 3. closing sentence: default still project-scoped; invite is the explicit widening.
  old_close := E'NOT gated — it is your own xell talking to other zees of your project, and every act is recorded
in `a2a_meet` / `a2a_meet_member` / `a2a_meet_message`. It is not a way to reach another
project''s zees (a meet is project-scoped) and not a way to reach an external agent (that stays
`zee a2a <card-url>`).';
  new_close := E'NOT gated — it is your own xell talking to other zees, and every act is recorded in
`a2a_meet` / `a2a_meet_member` / `a2a_meet_message` / `a2a_meet_invite`. By default a meet is
project-scoped (you can only attend rooms your own project created). A founder may invite
another whole project (`zee meet invite <code> --project <name>`); without that invite a foreign
code still refuses. It is not a way to reach an external agent (that stays `zee a2a <card-url>`).';
  IF position(old_close IN txt) > 0 THEN
    txt := replace(txt, old_close, new_close); changed := true;
  ELSIF position('a2a_meet_invite' IN txt) = 0 THEN
    RAISE NOTICE 'worker manual: the zee meet closing paragraph has moved — invite wording was not applied';
  END IF;

  IF changed THEN
    PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
    RAISE NOTICE 'worker manual: zee meet invite documented';
  ELSE
    RAISE NOTICE 'worker manual: zee meet invite was already documented — nothing to do';
  END IF;
END $mig$;

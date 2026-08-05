-- THE ROUTER MAY ASK FOR A MANAGER — and a router is ONE-SHOT.
--
-- Two operator decisions, one migration, because they are the same sentence about the same zee:
--
--   "allow routers to mint managers if the task is substantial pending human approval.
--    routers should be one shot and context cleared regularly to reduce token consumption"
--
-- ── (A) THE MANAGER-MINT GATE ────────────────────────────────────────────────────────────────
--
-- Until now a manager could only ever appear by a HUMAN's click (lib/manager-spawn.js, POST
-- /api/managers), and `zee dispatch` refuses a manager harness outright for the reason written into
-- that file: "a manager that could mint managers is a fleet that grows sideways with nobody's
-- consent". That reason survives here EXACTLY — what changes is who may ASK.
--
-- The router is the project's front door: it is the one zee that sees a raw human prompt before
-- anyone has sized it, so it is the one that knows when a request is too big for a single worker
-- (a programme of work, several strands, a crew). Before this its only options were to dispatch one
-- worker at a thing that needed a crew, or to say so in a report nobody may be reading. Now it may
-- file a REQUEST, and a human decides — the same shape as prod-bind (029), a landed seed (049), a
-- xource clean (111) and a credential injection (132):
--
--   router  → files the request (`zee mint-manager --reason "…" --task "…"`)
--   human   → approves or rejects it in the console
--   queenzee→ runs createManagerZee itself on approval (the xell, the type stamp, the read-only
--             prod role, the manager harness) — the router never spawns anything.
--
-- So the fleet still cannot grow sideways without consent: nothing here lets an agent create a
-- manager, and the approve path is the same human-owned code the console button already calls.
--
-- ── (B) ONE-SHOT ROUTERS ─────────────────────────────────────────────────────────────────────
--
-- `harness.one_shot` (this migration) makes every queenzee-started turn for a wearer a FRESH
-- session instead of a resume. A router is the fleet's most-invoked agent and the least in need of
-- a transcript: each routing request is a self-contained unit (recompose this prompt, decide the
-- dispatch, report), while the accumulated context is re-sent, and re-billed, on every turn for the
-- rest of that cage's life. One-shot turns cost the briefing, not the history.
--
-- What makes it safe rather than merely cheap: a router's state does not live in its transcript.
-- The routing request carries its own ROUTER POLICY snapshot (lib/router.js already tells it to
-- obey that over "anything you remember"), its crew is `zee zees`, its plan is the work board, and
-- its inbox is `zee inbox`. What it DOES lose is memory of what it routed ten minutes ago, so the
-- persona below says so in as many words and points at the verbs that answer it.
--
-- The column is a HARNESS setting, like `enable_reflection` (112) and `upload_conversations_on_done`
-- (110): it belongs to the persona, an operator can turn it off in the console, and any harness that
-- wants the same economics can have it. Only `router` is switched on here.

-- ── (A1) the request table — shaped like xource_clean_request (111) ──────────────────────────
CREATE TABLE IF NOT EXISTS manager_mint_request (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  -- the ROUTER that asked. SET NULL if it is reaped — the ask, and the manager it produced, remain
  -- facts about the project.
  xell_id      uuid REFERENCES xell(id) ON DELETE SET NULL,
  zee_id       uuid REFERENCES zee(id)  ON DELETE SET NULL,
  reason       text NOT NULL,            -- why this needs a CREW and not one worker (the human reads this)
  task         text,                     -- the programme the manager would be briefed with
  harness_key  text,                     -- which manager persona (NULL = `manager`)
  title        text,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected','created','failed','withdrawn')),
  result       jsonb,                    -- what the mint actually did (slug, xell id) — the receipt
  created_xell_id uuid REFERENCES xell(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_by   text,
  finished_at  timestamptz,
  dismissed_at timestamptz,
  dismissed_by text
);

COMMENT ON TABLE manager_mint_request IS
  'A ROUTER asking a human for a MANAGER zee (149). The router files it, a human decides it, and the QUEENZEE runs createManagerZee on approval — no agent may create a manager. Shaped like xource_clean_request (111).';

-- At most one OPEN request per asking xell — one card from one router, like every other gate.
CREATE UNIQUE INDEX IF NOT EXISTS manager_mint_request_open_uq
  ON manager_mint_request (xell_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS manager_mint_request_project_idx
  ON manager_mint_request (project_id, status, requested_at DESC);

-- ── (B1) the harness switch ──────────────────────────────────────────────────────────────────
ALTER TABLE harness ADD COLUMN IF NOT EXISTS one_shot boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN harness.one_shot IS
  'ONE-SHOT TURNS (149): every queenzee-started turn for a wearer runs in a FRESH session instead of resuming the last one, so context does not accumulate across turns (queenzee/nudge.js). The prompt gains a re-orientation preamble naming the persona files in the cage, because a fresh session remembers nothing. Default false; ON for `router`.';

UPDATE harness SET one_shot = true WHERE key = 'router' AND project_id IS NULL AND NOT one_shot;

-- ── (A2) THE MANAGER MANUAL — document the verb the CLI now has ──────────────────────────────
-- House rule 8: what a zee is told moves with the CLI. test/cxell-cli-drift.test.mjs fails the build
-- if a MANAGER-only verb is missing from the manager manual, and it is right to: `zee harness` was
-- shipped, routed and tested with no manual saying it existed. Anchored + idempotent, NOTICE on a
-- moved anchor (the 111 pattern).
DO $mig$
DECLARE
  txt     text;
  anchor  text := '### `zee xource-clean`';
  section text;
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE '149: no manager manual on this database — nothing to document';
  ELSIF position('zee mint-manager' in txt) > 0 THEN
    RAISE NOTICE '149: the manager manual already documents `zee mint-manager` — no-op';
  ELSE
    section :=
      E'### `zee mint-manager` — ask a human for ANOTHER MANAGER (ROUTER only)\n'
   || E'`POST /api/xell/self/mint-manager` `{ reason, task?, harness?, title? }`. A manager is added by a\n'
   || E'HUMAN — that has not changed, and no agent may create one. What a ROUTER may do (149) is ASK: when a\n'
   || E'prompt arriving at the front door is a PROGRAMME rather than a task — several strands, a crew, work\n'
   || E'that will outlive one worker''s cage — file a request and a human decides it in the console. On\n'
   || E'approval the QUEENZEE runs the mint itself (the xell, the manager type stamp, the read-only prod\n'
   || E'role, the manager persona); you spawn nothing.\n\n'
   || E'- **`--reason` is required and it is the argument**: say why one well-briefed worker will NOT do.\n'
   || E'  "this is big" is not a reason; "four independent strands, each needing its own branch and review,\n'
   || E'  and the first three block the fourth" is.\n'
   || E'- **`--task`** is the PROGRAMME the new manager will be briefed with. Write it as you would a\n'
   || E'  dispatch brief; omitted, the manager gets the fleet''s default "work out what matters and\n'
   || E'  propose it" brief, which wastes a turn you could have spent for it.\n'
   || E'- ONE open request at a time, like every other gate. `--status` reads where it got to,\n'
   || E'  `--withdraw` un-asks it. A rejection is a normal answer: it usually means "dispatch a worker".\n'
   || E'- It is NOT a way to grow your own authority: the minted manager is a peer, not your crew, and it\n'
   || E'  holds exactly the manager verbs you hold — production read-only, no landing, no push.\n\n';
    IF position(anchor in txt) > 0 THEN
      txt := replace(txt, anchor, section || anchor);
      RAISE NOTICE '149: manager manual — `zee mint-manager` documented above %', anchor;
    ELSE
      txt := txt || E'\n' || section;
      RAISE NOTICE '149: manager manual — anchor % not found; `zee mint-manager` appended at the end', anchor;
    END IF;
    PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
  END IF;
END $mig$;

-- ── (A3 + B2) THE ROUTER PERSONA — the two things its wearer must now know ───────────────────
-- Anchored replace of the "What you are not" close, which is where the persona already tells the
-- router what it may not do. Both additions are TRUE ONLY AFTER THIS MIGRATION, so they go in with
-- it rather than in a doc: a router that does not know it is one-shot will write itself notes it
-- will never read, and one that does not know about the gate will keep spending a worker on a
-- programme.
DO $mig$
DECLARE
  txt   text;
  old_t text := 'You never mint managers, never route to yourself, and when a';
  new_t text := 'You do not CREATE managers — but when a request is genuinely a PROGRAMME rather than a task'
             || E'\n(several strands, a crew, work that outlives one worker''s cage), you may ASK a human for one:'
             || E'\n`zee mint-manager --reason "why one worker will not do" --task "the programme"`. A human decides'
             || E'\nand the queenzee mints it; a rejection means "dispatch a worker", which is the common answer.'
             || E'\nOne open ask at a time, and never for a job you could brief a single zee to finish.'
             || E'\n'
             || E'\n**You are ONE-SHOT.** Every turn you are given runs in a FRESH session: you do not remember the'
             || E'\nlast routing request, what you dispatched for it, or anything you told yourself. That is'
             || E'\ndeliberate — you are the most-invoked agent in the fleet and a transcript you re-send every'
             || E'\nturn is the fleet''s largest avoidable cost. So take your state from the world, every time:'
             || E'\nthe ROUTER POLICY snapshot in the request (it outranks anything you think you remember),'
             || E'\n`zee zees` for your crew and the concurrency cap, `zee work --board` for the plan, `zee inbox`'
             || E'\nfor what was said to you. Never promise a human you will "remember" or "follow up on" anything:'
             || E'\nif it must survive your turn, put it in the work item, the dispatch brief or your report.'
             || E'\n'
             || E'\nYou never route to yourself, and when a';
BEGIN
  SELECT bundle->>'personality' INTO txt FROM harness WHERE key = 'router' AND project_id IS NULL;
  IF txt IS NULL THEN
    RAISE NOTICE '149: no router harness on this database — nothing to brief';
  ELSIF position('You are ONE-SHOT' in txt) > 0 THEN
    RAISE NOTICE '149: the router persona already carries the mint + one-shot clauses — no-op';
  ELSIF position(old_t in txt) = 0 THEN
    RAISE NOTICE '149: the router persona''s "What you are not" close has moved — left untouched (patch it by hand)';
  ELSE
    UPDATE harness SET bundle = jsonb_set(bundle, '{personality}', to_jsonb(replace(txt, old_t, new_t)))
     WHERE key = 'router' AND project_id IS NULL;
    RAISE NOTICE '149: the router now knows it may ASK for a manager, and that it is one-shot';
  END IF;
END $mig$;

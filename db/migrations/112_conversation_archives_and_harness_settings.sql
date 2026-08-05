-- CONVERSATION ARCHIVES + HARNESS ARCHIVAL SETTINGS.
--
-- Two features, one migration:
--
--  (A) A zee can UPLOAD its xell conversation to the queenzee (`zee upload-conversation`),
--      and a manager can REVIEW those archives (`zee conversations`). The conversation is the
--      session transcript inside the cxell (~/.claude/projects/-work-repo/<sid>.jsonl) — the
--      zee reads it and POSTs it (verb), or the queenzee reads it from the cxell when a
--      harness's "upload conversations on done" is on. The archive row is a RECEIPT about a
--      throwaway xell's work, so it outlives the xell: xell_id is ON DELETE SET NULL (like
--      prod_seed_request / visual_verify_offer), and project_id + xell_slug keep it findable.
--
--  (B) Two per-harness booleans the console's harness manager renders as checkboxes:
--        upload_conversations_on_done  — when a wearer proposes done, archive the conversation
--        enable_reflection             — when a wearer's work ships, re-invoke it for the
--                                        post-ship reflection pass (the ship gate checks this)
--      Plain NOT NULL booleans with defaults that preserve today's behaviour: reflection stays
--      ON by default (it always ran), upload-on-done stays OFF by default (it is new and opt-in).

CREATE TABLE IF NOT EXISTS xell_conversation (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  xell_id     uuid REFERENCES xell(id) ON DELETE SET NULL,
  xell_slug   text,
  zee_id      uuid REFERENCES zee(id) ON DELETE SET NULL,
  session_id  text,
  title       text,
  content     text NOT NULL,                 -- the raw JSONL transcript (source of truth)
  events      jsonb NOT NULL DEFAULT '[]'::jsonb,  -- parsed lines (for structured review)
  line_count  int  NOT NULL DEFAULT 0,
  byte_count  bigint NOT NULL DEFAULT 0,
  uploaded_by text NOT NULL DEFAULT 'verb' CHECK (uploaded_by IN ('verb','done','human')),
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS xell_conversation_xell_idx
  ON xell_conversation (xell_id, created_at DESC);
CREATE INDEX IF NOT EXISTS xell_conversation_project_idx
  ON xell_conversation (project_id, created_at DESC);

ALTER TABLE harness ADD COLUMN IF NOT EXISTS upload_conversations_on_done boolean NOT NULL DEFAULT false;
ALTER TABLE harness ADD COLUMN IF NOT EXISTS enable_reflection boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN harness.upload_conversations_on_done IS
  'When a zee wearing this harness proposes done, the queenzee archives its conversation (best-effort). Default false = opt-in.';
COMMENT ON COLUMN harness.enable_reflection IS
  'When a zee wearing this harness has its work SHIPPED, re-invoke it for the post-ship reflection pass. Default true (preserves the always-on behaviour).';

-- ── WORKER MANUAL (zee-base → cxell-zee-manual.md): document `zee upload-conversation` ─────────
DO $$
DECLARE
  txt     text;
  anchor  text := 'zee verify-webapp                             # offer your built webapp URL to a HUMAN in the console (open or dismiss; NOT gated)';
  section text := '### `zee report` · `zee inbox` — talking to your MANAGER';
  line    text;
  para    text;
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'worker manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;
  IF txt LIKE '%zee upload-conversation%' THEN
    RAISE NOTICE 'worker manual: zee upload-conversation is already documented';
    RETURN;
  END IF;
  IF position(anchor IN txt) = 0 OR position(section IN txt) = 0 THEN
    RAISE NOTICE 'worker manual: an anchor has moved — add zee upload-conversation by hand';
    RETURN;
  END IF;

  line := 'zee upload-conversation                            # UPLOAD this xell''s conversation to the queenzee (archived; a manager can review it)';
  txt := replace(txt, anchor, anchor || E'\n' || line);

  para := E'### `zee upload-conversation` — archive this xell''s conversation\n'
       || E'`POST /api/xell/self/upload-conversation`. Uploads the CURRENT conversation (your session\n'
       || E'transcript inside the cxell) to the queenzee, where it is archived as a `xell_conversation`\n'
       || E'row and can be reviewed by your manager (`zee conversations`) or a human in the console.\n'
       || E'\n'
       || E'It is NOT gated and acts immediately (like `zee working`): the archive is a fact about a\n'
       || E'throwaway xell''s work, not a request. The verb reads the transcript yourself and POSTs it;\n'
       || E'when your harness has "upload conversations on done" ON, the queenzee ALSO archives the\n'
       || E'conversation automatically when you propose done (`zee done`) — you do not have to call\n'
       || E'this separately. Use it whenever you want the record captured earlier (before a swap, a\n'
       || E'long investigation, a handoff to a human).\n'
       || E'\n';
  txt := replace(txt, section, para || section);

  PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
  RAISE NOTICE 'worker manual: documented zee upload-conversation';
END $$;

-- ── MANAGER MANUAL (manager → manager-zee-manual.md): document `zee conversations` ────────────
DO $$
DECLARE
  txt     text;
  anchor  text := 'zee inbox [--all] [--json]                   # what your workers sent you (incl. post-ship reflections)';
  section text := '### `zee inbox` — what the crew told you';
  line    text;
  para    text;
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;
  IF txt LIKE '%zee conversations%' THEN
    RAISE NOTICE 'manager manual: zee conversations is already documented';
    RETURN;
  END IF;
  IF position(anchor IN txt) = 0 OR position(section IN txt) = 0 THEN
    RAISE NOTICE 'manager manual: an anchor has moved — add zee conversations by hand';
    RETURN;
  END IF;

  line := 'zee conversations [--xell <slug>]                  # review your crew''s uploaded conversation archives';
  txt := replace(txt, anchor, anchor || E'\n' || line);

  para := E'### `zee conversations` — review your crew''s conversation archives\n'
       || E'`GET /api/xell/self/conversations`. Lists the conversation archives YOUR workers uploaded\n'
       || E'(`zee upload-conversation`, or the "upload on done" harness setting). Each row shows the\n'
       || E'worker, when it was archived, the session title, and how big the transcript is. `--xell\n'
       || E'<slug>` narrows to one worker; `--full` returns the whole transcript for review.\n'
       || E'\n'
       || E'It is scoped exactly like the rest of your crew verbs: you can only ever see archives of\n'
       || E'xells you dispatched (a worker sees none). Use it to audit what a zee actually did — a\n'
       || E'handoff, a post-mortem, a "what was it working on" before you suggest it done.\n'
       || E'\n';
  txt := replace(txt, section, para || section);

  PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
  RAISE NOTICE 'manager manual: documented zee conversations';
END $$;

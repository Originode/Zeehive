-- MEDIC CALL — a blocked zee gets a voice to call the ⛑ MEDIC (the patient-voice card).
--
-- The routing policy and the no-auto-spawn rule are DECIDED; this migration builds them, it does not
-- re-open them. A `zee medic --reason "…"` is a TOKEN-SCOPED self verb (like `zee tend`): it opens no
-- gate, blocks nothing, and is every zee's (worker AND manager). What it does is RECORD a call with
-- the xell's own infra evidence, then route it:
--
--   • a LIVE medic is attending this project (status NOT retired/converged/errored) → ATTACH: the
--     call is linked to that medic (status 'attended', medic_id set) and the medic is resumed with
--     the call verbatim + evidence, in the background. Nothing new is spawned.
--   • none is → RAISES THE EMERGENCY: the call becomes an entry in fleet.medic_emergency
--     (source 'called', carrying the zee's own words) so the console's ⛑ names the zee and a human
--     dispatches. NOTHING auto-spawns a new medic.
--
-- ONE LIVE CALL PER XELL is the rate limit, and it is a partial unique index: a second call while an
-- 'open'/'attended' row exists UPDATES that row (fresh reason/kind/evidence), never inserts — so a
-- blocked zee cannot stack calls, and a zee that keeps hitting the same fault keeps ONE current ask.
--
-- The medic's SIDE is two new registry tools (lib/medic-tools.js: calls / call_answer) with a
-- SELECT+UPDATE grant on medic_call — the ONLY new medic-role grant this card allows. `call_answer`
-- posts the resolution note back to the calling xell as a zee_message (the same delivery managers.js
-- uses for `zee say`), and a declined call says why and points at `zee tend`.
--
-- House rules 8 & 9: `zee medic` is documented in the manual of every zee type that has it — worker
-- (zee-base, cxell-zee-manual.md) and manager (manager, manager-zee-manual.md) — BY PATH through
-- harness_memory_get/_put, guarded on its own text and on anchors that have not moved. The CLI usage,
-- the CLI case, the API route and this manual move together (test/cxell-cli-drift.test.mjs §e).
--
-- Idempotent, additive, forward-only.

CREATE TABLE IF NOT EXISTS medic_call (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  xell_id       uuid NOT NULL REFERENCES xell(id) ON DELETE CASCADE,
  zee_id        uuid REFERENCES zee(id) ON DELETE SET NULL,
  kind          text NOT NULL DEFAULT 'other'
                  CHECK (kind IN ('db','build','provision','network','other')),
  reason        text NOT NULL CHECK (length(btrim(reason)) > 0),
  evidence      jsonb NOT NULL DEFAULT '[]'::jsonb,
  status        text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','attended','resolved','declined','withdrawn')),
  medic_id      uuid REFERENCES medic(id) ON DELETE SET NULL,
  resolution    text,               -- the medic's answer (or the withdrawal/decline note)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ONE live call per xell: 'open' (raised, awaiting a human dispatch) and 'attended' (a medic is on
-- it) both hold the lane. A second call from the same xell UPDATES the live row instead of inserting.
CREATE UNIQUE INDEX IF NOT EXISTS medic_call_one_live_per_xell
  ON medic_call (xell_id) WHERE status IN ('open','attended');

CREATE INDEX IF NOT EXISTS medic_call_project_idx
  ON medic_call (project_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS medic_call_medic_idx
  ON medic_call (medic_id, status) WHERE medic_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS medic_call_xell_idx
  ON medic_call (xell_id, created_at DESC);

-- ── the WORKER manual: document `zee medic` (every zee's verb) ──────────────────────────────────
DO $$
DECLARE
  wtxt      text;
  wchanged  boolean := false;
  wverbline text;
  wlist_anchor text := E'zee tend --reason "…" | --clear                  # raise/lower "I need a human" — the BRIEF reason is required';
  wsection  text;
  wsec_anchor text := E'### `zee tend` — raise "I need a human"';
BEGIN
  wtxt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF wtxt IS NOT NULL AND wtxt NOT LIKE '%`zee medic`%' AND wtxt NOT LIKE '%zee medic --reason%' THEN
    -- (a) the verb line in the CLI cheat-sheet, next to its neighbour `zee tend`.
    wverbline := $hz$zee medic --reason "…" [--kind db|build|provision|network|other] [--status] [--clear]   # call the ⛑ MEDIC: recorded with YOUR xell's infra evidence — attached to a LIVE medic on the project, or RAISED as a CALLED emergency (source "called") a human dispatches. NOTHING auto-spawns. A fault in your OWN code/tests is zee tend, not a medic$hz$;
    IF position(wlist_anchor IN wtxt) > 0 THEN
      wtxt := replace(wtxt, wlist_anchor, wlist_anchor || E'\n' || wverbline);
      wchanged := true;
    ELSE
      RAISE NOTICE 'worker manual: the zee tend list line has moved — the zee medic list line was not added';
    END IF;

    -- (b) a short section of its own, before the zee tend section.
    wsection := $hz$### `zee medic` — a blocked zee calls the ⛑ MEDIC

`POST /api/xell/self/medic` `{ reason, kind?, status?, clear? }`. When a fault is NOT yours to fix —
the shared dev db refuses, provision cannot burn in, docker on a host is wedged — call the medic
instead of guessing. Every zee may call it (worker AND manager); it opens no gate and blocks nothing.

A call is RECORDED server-side with the xell's own infra evidence (a failing db preflight, a failing
provision proof, an INFRA-classed build failure, a provision fault card). A call with NO evidence is
still recorded and never refused — but the answer tells you plainly: a medic fixes ZEEHIVE
config/infra. A fault in your own code or tests is `zee tend`, not a medic.

Routing is decided, and it NEVER auto-spawns: if a LIVE medic is already attending this project your
call is ATTACHED — that medic is resumed with your words plus the evidence. If none is, the call
RAISES THE EMERGENCY: the console's ⛑ shows it as a CALLED emergency naming your zee, and a human
dispatches. `--kind db|build|provision|network|other` labels the call; `--status` reads it; `--clear`
withdraws it. The medic's answer arrives in your inbox like any message.

$hz$;
    IF position('### `zee medic`' IN wtxt) = 0 THEN
      IF position(wsec_anchor IN wtxt) > 0 THEN
        wtxt := replace(wtxt, wsec_anchor, wsection || E'\n' || wsec_anchor);
      ELSE
        RAISE NOTICE 'worker manual: the zee tend section heading has moved — appending the zee medic section at the end';
        wtxt := wtxt || E'\n' || wsection;
      END IF;
      wchanged := true;
    END IF;

    IF wchanged THEN
      PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', wtxt);
      RAISE NOTICE 'worker manual: zee medic documented';
    ELSE
      RAISE NOTICE 'worker manual: zee medic could not be documented (anchors moved)';
    END IF;
  ELSE
    RAISE NOTICE 'worker manual: zee medic is already documented (or no entry on this database) — nothing to do';
  END IF;
END $$;

-- ── the MANAGER manual: a manager may call `zee medic` too ──────────────────────────────────────
DO $$
DECLARE
  mtxt      text;
  mchanged  boolean := false;
  mverbline text;
  mlist_anchor text := E'zee tend --reason "…" | --clear              # "I need a human in the console"';
  msection  text;
  msec_anchor text := E'### `zee creds` — what this cage holds';
BEGIN
  mtxt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF mtxt IS NOT NULL AND mtxt NOT LIKE '%`zee medic`%' AND mtxt NOT LIKE '%zee medic --reason%' THEN
    mverbline := $hz$zee medic --reason "…" [--kind db|build|provision|network|other] [--status] [--clear]   # a BLOCKED ZEE'S call for the ⛑ MEDIC — yours too: recorded with this xell's infra evidence, attached to a LIVE medic on the project or RAISED as a CALLED emergency for a human to dispatch. NEVER auto-spawns$hz$;
    IF position(mlist_anchor IN mtxt) > 0 THEN
      mtxt := replace(mtxt, mlist_anchor, mlist_anchor || E'\n' || mverbline);
      mchanged := true;
    ELSE
      RAISE NOTICE 'manager manual: the zee tend list line has moved — the zee medic list line was not added';
    END IF;

    msection := $hz$### `zee medic` — YOU may call the ⛑ MEDIC too

`POST /api/xell/self/medic` `{ reason, kind?, status?, clear? }` — the same verb a blocked worker
has. A manager can hit a ZEEHIVE infra fault that no cage can fix (a wedged shared db, a host docker
state, a provision pair that will not burn in); call the medic rather than burning your crew. It
opens no gate, blocks nothing, and NEVER auto-spawns: if a LIVE medic is already on this project your
call is ATTACHED to it (your words + evidence resume it), and if none is it becomes a CALLED
emergency in the console ⛑ for a human to dispatch. Your call is recorded with this xell's infra
evidence; a code/test fault in your own work is `zee tend`, not a medic.

$hz$;
    IF position('### `zee medic`' IN mtxt) = 0 THEN
      IF position(msec_anchor IN mtxt) > 0 THEN
        mtxt := replace(mtxt, msec_anchor, msection || E'\n' || msec_anchor);
      ELSE
        RAISE NOTICE 'manager manual: the creds section heading has moved — appending the zee medic section at the end';
        mtxt := mtxt || E'\n' || msection;
      END IF;
      mchanged := true;
    END IF;

    IF mchanged THEN
      PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', mtxt);
      RAISE NOTICE 'manager manual: zee medic documented';
    ELSE
      RAISE NOTICE 'manager manual: zee medic could not be documented (anchors moved)';
    END IF;
  ELSE
    RAISE NOTICE 'manager manual: zee medic is already documented (or no entry on this database) — nothing to do';
  END IF;
END $$;

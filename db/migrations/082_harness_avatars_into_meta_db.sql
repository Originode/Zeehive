-- HARNESS AVATARS INTO THE META-DB — the last harness thing that was a file.
--
-- 080 moved every harness's TEXT into its row and deleted the folders, leaving one artefact behind:
-- `harnesses/<key>/avatar.svg`, resolved from the ZEEHIVE PROJECT's repo through avatar_path. That
-- looked harmless (art, not agent-facing text) and it was not: the badge is how a harness is
-- recognised in every picker, hexagon and connector wire, and it 404s on any queenzee that cannot
-- read that repo — which is exactly the situation the console screenshot showed for the crew.
--
-- An avatar is an SVG. An SVG is text. So it goes in the row like everything else: bundle->>'avatar_svg'
-- is served by GET /api/harnesses/:key/avatar, avatar_path is cleared, and the files are deleted in this
-- same commit. lib/harness.js then touches no filesystem at all — no repo roots to resolve, nothing to
-- be missing, and a harness is complete on any machine that can reach the meta-DB.
--
-- Guarded like 080: only fills a row that has no avatar_svg yet, so a badge replaced in the console is
-- never clobbered by a re-run.

DO $$
DECLARE b jsonb;
BEGIN
  SELECT bundle INTO b FROM harness WHERE key = 'hermes';
  IF b IS NULL THEN RAISE NOTICE 'harness hermes: not on this database'; RETURN; END IF;
  IF coalesce(btrim(b->>'avatar_svg'), '') = '' THEN
    b := jsonb_set(b, '{avatar_svg}', to_jsonb($hz$<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="Hermes harness">
  <!-- Original placeholder badge for the Hermes harness (an abstract winged-messenger glyph).
       NOT the Hermes brand logo — drop the official asset here to replace it. -->
  <circle cx="32" cy="32" r="30" fill="#1c2333" stroke="#5b8cff" stroke-width="2"/>
  <!-- wings -->
  <path d="M14 26 q10 -6 18 0 q-8 -1 -18 4 z" fill="#7bd0e0"/>
  <path d="M50 26 q-10 -6 -18 0 q8 -1 18 4 z" fill="#7bd0e0"/>
  <!-- messenger stroke: an upward chevron over a baseline -->
  <path d="M22 42 L32 24 L42 42" fill="none" stroke="#e0a53b" stroke-width="4"
        stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="20" y1="48" x2="44" y2="48" stroke="#e0a53b" stroke-width="4" stroke-linecap="round"/>
</svg>
$hz$::text));
    UPDATE harness SET bundle = b WHERE key = 'hermes';
    RAISE NOTICE 'harness hermes: avatar SVG stored in the meta-DB';
  END IF;
END $$;

DO $$
DECLARE b jsonb;
BEGIN
  SELECT bundle INTO b FROM harness WHERE key = 'manager';
  IF b IS NULL THEN RAISE NOTICE 'harness manager: not on this database'; RETURN; END IF;
  IF coalesce(btrim(b->>'avatar_svg'), '') = '' THEN
    b := jsonb_set(b, '{avatar_svg}', to_jsonb($hz$<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="Manager Zee harness">
  <!-- A manager hexagon with three satellites: the crew seated around it, which is exactly how the
       honeycomb lays a manager's workers out (adjacent cells). -->
  <circle cx="32" cy="32" r="30" fill="#1c2333" stroke="#e0a53b" stroke-width="2"/>
  <path d="M32 16 L42 22 L42 34 L32 40 L22 34 L22 22 Z" fill="none" stroke="#e0a53b" stroke-width="3"
        stroke-linejoin="round"/>
  <circle cx="32" cy="28" r="4" fill="#e0a53b"/>
  <circle cx="16" cy="46" r="5" fill="none" stroke="#5b8cff" stroke-width="3"/>
  <circle cx="32" cy="50" r="5" fill="none" stroke="#5b8cff" stroke-width="3"/>
  <circle cx="48" cy="46" r="5" fill="none" stroke="#5b8cff" stroke-width="3"/>
  <path d="M27 38 L18 42 M32 40 L32 45 M37 38 L46 42" stroke="#8b97a8" stroke-width="2" stroke-linecap="round"/>
</svg>
$hz$::text));
    UPDATE harness SET bundle = b WHERE key = 'manager';
    RAISE NOTICE 'harness manager: avatar SVG stored in the meta-DB';
  END IF;
END $$;

-- No row may point at a file any more: the path would 404 wherever the repo is not readable, which is
-- the whole defect this closes. The route reads bundle->>'avatar_svg' and nothing else.
UPDATE harness SET avatar_path = NULL WHERE avatar_path IS NOT NULL;

COMMENT ON COLUMN harness.avatar_path IS
  'LEGACY, always NULL since 082. A harness avatar is an SVG in bundle->>''avatar_svg'' — the meta-DB '
  'owns it, like the rest of the harness, so a badge cannot depend on a repo being readable.';

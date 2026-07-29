-- THE MANAGER MANUAL: a manager does not choose the KEY of a persona it mints.
--
-- 085 wrote the `zee harness` section, and the fix that landed after it (TKT-23-8EE4, S1) changed the
-- verb's contract underneath that text: `selfHarnessCreate` now DERIVES the stored key from the
-- caller's project and the label, and REFUSES a caller-supplied `key` instead of quietly renaming it.
-- Keys are unique across every scope and both `zee dispatch --harness <key>` and
-- `harness_memory_put('<key>', …)` address a harness by key, so a chosen key reaches the whole fleet
-- from inside one project — and the uniqueness collision doubled as an existence oracle for rows the
-- caller cannot see. A manager that is never told this reads the refusal as a bug.
--
-- Two edits, both in the text 085 added, both narrow:
--   * the RULE, next to the paragraph that mints one (why, not just what: the key is an address);
--   * the VERB LINE, which still advertised `[--new]` alongside `[<key>]` — i.e. a key on creation,
--     the one thing the code refuses. `scripts/zee`'s usage line is corrected in the same commit
--     (house rule 8: what a zee is told moves with the code).
--
-- NOT added: the disable/delete guards this fix also deepened. A manager's manual is not the place a
-- gate is restated — the refusal says it, at the moment it fires, naming the xells that are wearing
-- the persona. Nothing 085 wrote claims otherwise, so there was nothing to correct there.
--
-- Anchored + idempotent in the 065/071/079/085 sense: returns early when the rule is already there,
-- refuses to guess when an anchor has moved, and goes through harness_memory_put (house rule 9 / 076)
-- so every sibling memory entry survives. No folder half (080 detached every harness row), so there
-- is no bundle_hash to clear.
DO $$
DECLARE
  txt     text;
  oldverb text := E'zee harness [<key>] [--new] [--delete] [--parent <key>] [--personality-file <f>]\n'
               || E'                                             # YOUR PROJECT''S worker personas: list, read, mint, edit';
  newverb text := E'zee harness [<key>] [--delete] [--parent <key>] [--personality-file <f>] | --new --label "…"\n'
               || E'                                             # YOUR PROJECT''S worker personas: list, read, edit, mint';
  anchor  text := 'A persona you create belongs to **your project**';
  rule    text;
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;
  IF txt LIKE '%The KEY is derived, never chosen%' THEN
    RAISE NOTICE 'manager manual: the derived-key rule is already there';
    RETURN;
  END IF;
  IF position(oldverb IN txt) = 0 OR position(anchor IN txt) = 0 THEN
    RAISE NOTICE 'manager manual: an anchor has moved — left untouched (add the derived-key rule by hand)';
    RETURN;
  END IF;

  rule := E'**The KEY is derived, never chosen** — from your project and the label (`<project>-<label>`,\n'
       || E'slugged). A `key` you send is refused rather than quietly renamed: a key is how a harness is\n'
       || E'addressed on a dispatch and in a fleet-wide migration, so the global key space is not one\n'
       || E'project''s to spend. The answer names the key you got; dispatch and edit with that.\n'
       || E'\n';

  txt := replace(txt, oldverb, newverb);
  txt := replace(txt, anchor, rule || anchor);

  PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
  RAISE NOTICE 'manager manual: the key of a minted persona is DERIVED, and the verb line no longer offers one';
END $$;

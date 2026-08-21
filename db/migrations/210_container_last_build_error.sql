-- A FAILED BUILD MUST SAY WHY — ticket #173 / TKT-173-FE90.
--
-- THE DEFECT: lib/build.js finalizes a failed build with health='down' and one logline carrying
-- only the LAST stderr line, into a 300-line ring buffer. The container row kept last_build_commit /
-- last_built_at / hot_build and NO error at all. 20 omnibiz containers on 'default' have failed
-- forever with no retrievable reason. A zee inside a cage (no docker CLI) that sees
-- `zee build --wait` go building → down gets only "the build FAILED. Check the queenzee terminal"
-- — and the terminal scrolled past it.
--
-- THE FIX: persist the failure reason on the row itself. Cleared on the next successful build
-- (and when a fresh build starts), set on every failure path (script exit, thrown error, stranded
-- 'building' catch). getBuildStatus returns it; `zee build --wait` prints it; the console chip
-- tooltip shows it. The log ring remains for live scrolling — this column is the durable answer.
ALTER TABLE container
  ADD COLUMN IF NOT EXISTS last_build_error text;

COMMENT ON COLUMN container.last_build_error IS
  'Why the most recent build of this container failed. NULL = never failed, or the last build succeeded (cleared on success / when a new build starts). Truncated stderr or thrown-message from lib/build.js — survives the 300-line log ring so a zee can read it after the fact.';

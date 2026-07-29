-- THE PROJECTION REACHED THE HOST WORKTREE. THE ZEE READS A COPY (ticket #15, the third half).
--
-- .zeehive.env is written into the HOST worktree (lib/provision.emitXellEnv). A cxell zee never
-- reads that file: it reads a `docker cp` COPY taken at spawn (lib/cxell.cloneIntoCxell). So the
-- ticket #15 rule fix and the boot reconcile that followed it (078) both stopped at the worktree,
-- and every zee ALREADY in a cage kept the values it was born with — a manager bound to production
-- read-only, told it holds production, reading a file that named its own throwaway spinoff db. The
-- boot reconcile made that worse in one specific way: once it repaired the host file, the host
-- comparison said "unchanged" at every later emit while the cage copy stayed stale forever.
--
-- lib/provision.refreshLiveCxellEnv now pushes the projection into the live cxell as well, comparing
-- the copy IN THE CAGE. Two columns for that outcome, deliberately separate from 078's pair:
--   env_cxell_refreshed_at — when the LIVE cxell's copy was last verified/refreshed;
--   env_cxell_error        — why the last cage refresh FAILED, cleared by the next success.
--
-- Separate because the remedies are different and the states are not the same state:
-- env_projection_error means the file on disk disagrees with the meta-DB (re-point the xell);
-- env_cxell_error means the host file is right and the ZEE cannot see it (an unreachable container).
-- Folded into one column, every host-side xell with no cage would have flown a broken badge.
-- lib/fleet.js selects x.*, so the console's env chip carries both with no extra query.
ALTER TABLE xell ADD COLUMN IF NOT EXISTS env_cxell_refreshed_at timestamptz;
ALTER TABLE xell ADD COLUMN IF NOT EXISTS env_cxell_error        text;

COMMENT ON COLUMN xell.env_cxell_refreshed_at IS
  'When the LIVE cxell''s copy of .zeehive.env was last verified/refreshed from the meta-DB '
  '(lib/provision.refreshLiveCxellEnv). NULL = never — including every xell that has no cage.';
COMMENT ON COLUMN xell.env_cxell_error IS
  'Why the last refresh of the LIVE cxell''s .zeehive.env copy failed, NULL when the last one '
  'succeeded or there was no live cxell. The host file can be perfectly correct while the zee reads '
  'something else; this is the difference, instead of a swallowed .catch().';

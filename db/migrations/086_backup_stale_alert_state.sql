-- WHO HAS BEEN TOLD, AND WHEN — ticket #26 (the stale-restore-point alert).
--
-- The alert has to be bounded: fire when the newest GOOD dump is older than two policy intervals, and
-- then at most once per policy interval, so a three-day outage is a few pings rather than one every
-- maintenance tick. That bound needs to remember the last ping, and it has to remember it ACROSS A
-- RESTART — because the failure that produced this ticket was itself a restart ("interrupted by server
-- restart"). In-memory state would forget precisely when the incident is worst, and would then re-ping
-- on every boot, which is how an alert earns a mute.
--
-- backup_alerted_at   when a human was last told the restore point was stale (NULL = never).
-- backup_alert_open   is that alert still outstanding? Lets exactly ONE "backups recovered" ping go out
--                     when a good dump finally lands — and only to someone who was already woken, so a
--                     recovery notice can never become chatter on its own.
ALTER TABLE pool_config ADD COLUMN IF NOT EXISTS backup_alerted_at timestamptz;
ALTER TABLE pool_config ADD COLUMN IF NOT EXISTS backup_alert_open boolean NOT NULL DEFAULT false;

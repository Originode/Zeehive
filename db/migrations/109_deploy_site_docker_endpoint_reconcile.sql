-- DEPLOY SITE DOCKER ENDPOINT — the Deploy sites tab becomes the source of truth for docker
-- contexts, and the queenzee auto-heals its local context to match.
--
-- deploy_site already names WHICH context a tier uses (docker_ctx, a context NAME) and the host
-- (host, an IP/DNS). It did NOT carry the full endpoint a `docker context create/update
-- --docker host=<endpoint>` needs — so a human had to re-point the context on the queenzee host
-- by hand (docker context update …) and nothing in the system remembered it.
--
-- docker_endpoint : the full endpoint string the site's docker_ctx should dial —
--   tcp://10.2.0.16:2375, ssh://mnrevelo@ssh.omnibiz.express, … A NULL endpoint means "no
--   reconcile" (the local 'default' daemon, or a site whose reachability is managed elsewhere).
--   The queenzee's reconcile loop (lib/context-reconcile.js) creates/updates the docker context
--   to match this on site save and every tick, so editing the tab IS the fix.

ALTER TABLE deploy_site ADD COLUMN IF NOT EXISTS docker_endpoint text;

-- Backfill: every non-'default' site that carries an IP/DNS host becomes a LAN tcp:2375 endpoint
-- — turning the CURRENT state into the declared truth, so the queenzee heals back to it after any
-- drift (e.g. an ad-hoc `docker context update` pointing mardale-prod at SSH while the LAN is
-- down — the next reconcile restores the tab's truth).
UPDATE deploy_site
   SET docker_endpoint = 'tcp://' || host || ':2375'
 WHERE docker_endpoint IS NULL
   AND docker_ctx <> 'default'
   AND host IS NOT NULL;

COMMENT ON COLUMN deploy_site.docker_endpoint IS
  'The full docker endpoint (host= string) the queenzee reconciles the site''s docker_ctx to. NULL = no reconcile (e.g. the local daemon). Source of truth for the context endpoint — lib/context-reconcile.js.';

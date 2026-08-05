-- ALLOW DNS HOSTNAMES IN HOST COLUMNS
--
-- The columns that name WHERE a docker context / daemon lives were typed `inet`, which only
-- accepts IP addresses. A docker context endpoint can be a DNS name (tcp://docker.example.com:2375),
-- a machine row already stores its host as text, and a container's published host can be a docker
-- network name (postgresql://user@meta-db:5432/…). Cast every one to text so a hostname can be
-- stored; the inet→text cast via host() also strips any netmask that slipped in.
--
-- project.dev_host_ip / prod_host_ip — deprecated in favour of deploy_site (015) but still read as
-- the fallback host for xell URLs (rename-xell.js, provision.js).
-- deploy_site.host — "LAN or WG address of the daemon host" (spec §5).
-- container.host — the published/reachable host of a container (an IP or a docker network name).

ALTER TABLE project     ALTER COLUMN dev_host_ip TYPE text USING host(dev_host_ip);
ALTER TABLE project     ALTER COLUMN prod_host_ip TYPE text USING host(prod_host_ip);
ALTER TABLE deploy_site ALTER COLUMN host TYPE text USING host(host);
ALTER TABLE container   ALTER COLUMN host TYPE text USING host(host);

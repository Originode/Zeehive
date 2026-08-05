-- RECONCILE PRODUCTION XELLS WITH THEIR DEPLOY SITES
--
-- Spec §5.2: ONE production xell per prod site — 'production' for the default site,
-- 'production-<key>' for the rest. Lifecycle bugs left the two out of step:
--
--   1. deleteSite() removed a site but NOT the production xell it minted → orphaned xells whose
--      site is gone. Measured live: omnibiz kept showing a 'production-mardale-prod-alt' hexagon
--      long after the mardale-prod-alt site was removed.
--   2. a non-default prod site with ZERO containers is a configuration leftover (added in the
--      console but never provisioned) — yet it still minted a phantom 'production-<key>' hexagon.
--      Measured live: Zeehive showed a 'production-prod-mardale-prod' hexagon from an empty site
--      pointing at the OmniBiz NAS.
--   3. legacy hand-typed prod containers were never linked to their site's production xell, so a
--      real prod stack read as an EMPTY hexagon. Measured live: omnibiz had 11 prod rows, 0 owns
--      links.
--
-- Forward, lib/sites.js keeps xells in step with site create/rename/delete, and
-- createSharedContainer/adoption link prod rows as they are made. This migration is the one-time
-- sweep that reconciles what the bugs left behind. Idempotent: a DB already reconciled has
-- nothing matching any statement.

-- 1. Drop empty non-default prod sites (0 containers). A non-default prod site with no containers
--    is an artifact: its prod xell has nothing to own, no ship can target a site with no stack,
--    and the console re-creates it trivially if it was ever wanted. Container.site_id is FK
--    ON DELETE SET NULL (migration 015), so no container row is harmed. ship_request.site_id and
--    deploy_lock.site_id are NO ACTION — a site with shipping history is KEPT, whatever it holds.
DELETE FROM deploy_site s
 WHERE s.tier = 'prod' AND NOT s.is_default
   AND NOT EXISTS (SELECT 1 FROM container c WHERE c.site_id = s.id)
   AND NOT EXISTS (SELECT 1 FROM ship_request sr WHERE sr.site_id = s.id)
   AND NOT EXISTS (SELECT 1 FROM deploy_lock dl WHERE dl.site_id = s.id);

-- 2. Delete production xells that no longer have a matching prod site. 'production' requires a
--    default prod site; 'production-<key>' requires a prod site with that key. The xells removed
--    in step 1's wake (their site is gone) and the truly orphaned ones (the site was deleted
--    before this migration) both match here. A xell is deleted only when NOTHING references it —
--    the CASCADE tables (task NO ACTION, plus ship_request / deploy_lock / zee / container /
--    db_refresh / prod_bind_request / migration_number_claim) must all be empty for it, so the
--    cleanup never destroys real history or a live container.
DELETE FROM xell x
 WHERE x.is_production
   AND NOT EXISTS (SELECT 1 FROM task t WHERE t.xell_id = x.id)
   AND NOT EXISTS (SELECT 1 FROM ship_request sr WHERE sr.xell_id = x.id)
   AND NOT EXISTS (SELECT 1 FROM deploy_lock dl WHERE dl.xell_id = x.id)
   AND NOT EXISTS (SELECT 1 FROM zee z WHERE z.xell_id = x.id)
   AND NOT EXISTS (SELECT 1 FROM container c WHERE c.owner_xell_id = x.id)
   AND NOT EXISTS (SELECT 1 FROM db_refresh dr WHERE dr.xell_id = x.id)
   AND NOT EXISTS (SELECT 1 FROM prod_bind_request pbr WHERE pbr.xell_id = x.id)
   AND NOT EXISTS (SELECT 1 FROM migration_number_claim mnc WHERE mnc.xell_id = x.id)
   AND NOT EXISTS (
        SELECT 1 FROM deploy_site s
         WHERE s.project_id = x.project_id AND s.tier = 'prod'
           AND ((x.slug = 'production' AND s.is_default)
             OR (x.slug = 'production-' || s.key))
       );

-- 3. Link every prod container to its site's production xell ('owns') — the same shape
--    self-onboard, adoption and createSharedContainer use, so a site's whole stack shows on its
--    production hexagon. Idempotent: the PK is (xell_id, container_id), and the LEFT JOIN skips
--    rows already linked.
INSERT INTO xell_uses_container (xell_id, container_id, relation)
SELECT x.id, c.id, 'owns'
  FROM container c
  JOIN deploy_site s ON s.id = c.site_id AND s.tier = 'prod'
  JOIN xell x ON x.project_id = s.project_id AND x.is_production
             AND x.slug = CASE WHEN s.is_default THEN 'production' ELSE 'production-' || s.key END
  LEFT JOIN xell_uses_container uc ON uc.xell_id = x.id AND uc.container_id = c.id
 WHERE uc.container_id IS NULL
ON CONFLICT DO NOTHING;

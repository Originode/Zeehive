-- REVOKE THE SECRET COLUMNS FROM READ-ONLY PROD ROLES, AND DROP THE ORPHANED ONES (TKT-96-4127 / TKT-102-8016)
--
-- A manager zee holds the LIVE production database through a dedicated SELECT-only postgres role
-- (`zee_ro_<slug>`). Two defects, closed here for the roles that EXIST already:
--
--   1. TKT-96-4127 — "read-only" was scoped as "no writes" when it also needed to be "no secrets":
--      the role's `GRANT SELECT ON ALL TABLES` handed it every stored secret in plaintext —
--      provider_token.token (incl. GitHub push tokens), environment_var.value (is_secret rows),
--      langfuse_config.admin_password / secret_key / public_key / org_* keys,
--      langfuse_project_map.secret_key / public_key, and xell.prod_ro_dsn. The provision code
--      (lib/prod-readonly.js, landed on main) now mints FUTURE roles without these; THIS migration
--      fixes the roles minted before that landed.
--
--   2. TKT-102-8016 — the old dropProdReader REVOKEd too little (it missed sequence privileges and
--      the default-privileges entry), so DROP ROLE failed at reap and the LOGIN role silently
--      outlived its xell. 13 of 16 prod zee_ro_* roles belonged to RETIRED xells, each still a live
--      LOGIN credential holding SELECT ON ALL TABLES. Part 1 drops those orphans.
--
-- MECHANISM. Postgres table-level SELECT covers EVERY column, and a column-level REVOKE does NOT
-- beat a table-level grant (verified against a real postgres). So the fix is the reverse of the
-- usual shape: REVOKE the table-level SELECT on each secret-bearing table, then GRANT back
-- column-level SELECT on every NON-secret column. The NON-secret list is computed from
-- information_schema at runtime (mirroring the provision code's secretTableSql): a column whose
-- name ends in `_hint` stays readable, and any column WITH a `_hint` sibling is a secret value.
-- count(*) and the *_hint columns stay readable; SELECT naming a secret column (or `SELECT *`) is
-- refused by the server.
--
-- ORPHAN ROLES. A role is an orphan when no LIVE xell's slug maps to it (the inverse of
-- roRoleName(): lower + [^a-z0-9]+ → _ + truncate to 40, verified byte-for-byte against the JS).
-- DROP OWNED BY revokes every privilege the role holds (tables, sequences, schema, the database
-- CONNECT grant, and the default-privileges entry) — a read-only role owns no objects, so shared
-- objects are untouched — then DROP ROLE.
--
-- Idempotent: REVOKE/GRANT and DROP OWNED BY are re-runnable, and a fresh database (every cxell db)
-- has no zee_ro_% roles, so both loops are empty.

-- ── PART 1: DROP ORPHANED READ-ONLY ROLES (their xell is retired, or the row is gone) ────────────
DO $$
DECLARE
  r record;
  live_roles text[];
BEGIN
  IF to_regclass('public.xell') IS NOT NULL THEN
    -- The role names a LIVE xell legitimately holds — the inverse of roRoleName(). No
    -- role='manager' filter: only managers are ever minted zee_ro_ roles, and skipping the filter
    -- keeps this migration robust on a schema whose xell table predates 052's `role` column.
    SELECT array_agg('zee_ro_' || left(regexp_replace(lower(COALESCE(x.slug,'')), '[^a-z0-9]+', '_', 'g'), 40))
      INTO live_roles
      FROM xell x
      WHERE x.status NOT IN ('retired', 'tearing-down', 'husk');

    FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'zee\_ro\_%'
    LOOP
      -- NULL live_roles = no live xells at all → every zee_ro_% role is an orphan.
      IF live_roles IS NULL OR NOT (r.rolname = ANY(live_roles)) THEN
        EXECUTE format('DROP OWNED BY %I', r.rolname);
        EXECUTE format('DROP ROLE %I', r.rolname);
        RAISE NOTICE 'dropped orphaned read-only prod role %', r.rolname;
      END IF;
    END LOOP;
  END IF;
END $$;

-- ── PART 2: HARDEN THE SECRET COLUMNS ON THE ROLES THAT REMAIN (live managers) ───────────────────
-- Each block REVOKEs table-level SELECT on one secret-bearing table and re-GRANTs column-level
-- SELECT on every non-secret column, computed from the live schema — the same rule the provision
-- code uses, so an existing role ends up exactly as restrictive as a newly-minted one.
DO $$
DECLARE
  r record;
  _cols text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'zee\_ro\_%'
  LOOP
    IF to_regclass('public.provider_token') IS NOT NULL THEN
      EXECUTE format('REVOKE SELECT ON public.provider_token FROM %I', r.rolname);
      SELECT string_agg(quote_ident(a.column_name), ', ' ORDER BY a.ordinal_position) INTO _cols
        FROM information_schema.columns a
       WHERE a.table_schema = 'public' AND a.table_name = 'provider_token'
         AND a.column_name NOT IN ('token')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns b
                          WHERE b.table_schema = a.table_schema AND b.table_name = a.table_name
                            AND b.column_name = a.column_name || '_hint');
      IF _cols IS NOT NULL THEN
        EXECUTE format('GRANT SELECT (%s) ON public.provider_token TO %I', _cols, r.rolname);
      END IF;
    END IF;

    IF to_regclass('public.environment_var') IS NOT NULL THEN
      EXECUTE format('REVOKE SELECT ON public.environment_var FROM %I', r.rolname);
      SELECT string_agg(quote_ident(a.column_name), ', ' ORDER BY a.ordinal_position) INTO _cols
        FROM information_schema.columns a
       WHERE a.table_schema = 'public' AND a.table_name = 'environment_var'
         AND a.column_name NOT IN ('value')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns b
                          WHERE b.table_schema = a.table_schema AND b.table_name = a.table_name
                            AND b.column_name = a.column_name || '_hint');
      IF _cols IS NOT NULL THEN
        EXECUTE format('GRANT SELECT (%s) ON public.environment_var TO %I', _cols, r.rolname);
      END IF;
    END IF;

    IF to_regclass('public.langfuse_config') IS NOT NULL THEN
      EXECUTE format('REVOKE SELECT ON public.langfuse_config FROM %I', r.rolname);
      SELECT string_agg(quote_ident(a.column_name), ', ' ORDER BY a.ordinal_position) INTO _cols
        FROM information_schema.columns a
       WHERE a.table_schema = 'public' AND a.table_name = 'langfuse_config'
         AND a.column_name NOT IN ('public_key', 'secret_key', 'admin_password', 'org_public_key', 'org_secret_key')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns b
                          WHERE b.table_schema = a.table_schema AND b.table_name = a.table_name
                            AND b.column_name = a.column_name || '_hint');
      IF _cols IS NOT NULL THEN
        EXECUTE format('GRANT SELECT (%s) ON public.langfuse_config TO %I', _cols, r.rolname);
      END IF;
    END IF;

    IF to_regclass('public.langfuse_project_map') IS NOT NULL THEN
      EXECUTE format('REVOKE SELECT ON public.langfuse_project_map FROM %I', r.rolname);
      SELECT string_agg(quote_ident(a.column_name), ', ' ORDER BY a.ordinal_position) INTO _cols
        FROM information_schema.columns a
       WHERE a.table_schema = 'public' AND a.table_name = 'langfuse_project_map'
         AND a.column_name NOT IN ('public_key', 'secret_key')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns b
                          WHERE b.table_schema = a.table_schema AND b.table_name = a.table_name
                            AND b.column_name = a.column_name || '_hint');
      IF _cols IS NOT NULL THEN
        EXECUTE format('GRANT SELECT (%s) ON public.langfuse_project_map TO %I', _cols, r.rolname);
      END IF;
    END IF;

    IF to_regclass('public.xell') IS NOT NULL THEN
      EXECUTE format('REVOKE SELECT ON public.xell FROM %I', r.rolname);
      SELECT string_agg(quote_ident(a.column_name), ', ' ORDER BY a.ordinal_position) INTO _cols
        FROM information_schema.columns a
       WHERE a.table_schema = 'public' AND a.table_name = 'xell'
         AND a.column_name NOT IN ('prod_ro_dsn')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns b
                          WHERE b.table_schema = a.table_schema AND b.table_name = a.table_name
                            AND b.column_name = a.column_name || '_hint');
      IF _cols IS NOT NULL THEN
        EXECUTE format('GRANT SELECT (%s) ON public.xell TO %I', _cols, r.rolname);
      END IF;
    END IF;
  END LOOP;
END $$;

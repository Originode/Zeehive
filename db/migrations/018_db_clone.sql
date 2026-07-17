-- db-clone: a per-xell DATABASE inside the shared dev postgres, cloned from a maintained
-- template (CREATE DATABASE … TEMPLATE — a file-level copy, seconds not minutes).
--
-- WHY: every xell shared ONE dev database, so the /ooney schema gate — which diffs the xell's
-- catalog against prod — saw the UNION of every in-flight xell's DDL. Two xells doing schema
-- work blocked each other's ship with drift neither could explain (xell A's unlanded migration
-- is not at main's tip, so xell B's gate reads A's tables as unexplained). A clone gives each
-- DB-change xell its own catalog: "my database = prod + MY pending migrations" becomes checkable
-- per xell, and the shared dev database goes back to being DDL-frozen — drift on it means
-- something again.
--
-- NOTE: the enum value is only ADDED here (usable next transaction, per PG12+ semantics);
-- nothing in this file may reference 'db-clone' as a value.
ALTER TYPE db_coupling ADD VALUE IF NOT EXISTS 'db-clone';

-- The xell's own database name INSIDE the shared dev container (e.g. zee_swift_harbor_a1b2c3).
-- Authoritative: set when the clone is created, survives xell renames, dropped by the reaper.
ALTER TABLE xell ADD COLUMN IF NOT EXISTS clone_db_name text;

-- When the clone TEMPLATE database inside this (db) container was last rebuilt from the live
-- database. Only meaningful on the shared dev db container; NULL = never built.
ALTER TABLE container ADD COLUMN IF NOT EXISTS clone_tpl_at timestamptz;

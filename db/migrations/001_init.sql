-- ZEEHIVE meta schema — the single source of truth for xells / zees / containers / events.
-- Enums encode the xell capability matrix; triggers/constraints encode the impossibilities.
-- Applied once by server/src/db/migrate.js (tracked in schema_migrations).

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid() (also core in pg13+)

-- ── enums ───────────────────────────────────────────────────────────────────
CREATE TYPE source_coupling  AS ENUM ('full-isolated','sparse-overlay');
CREATE TYPE db_coupling      AS ENUM ('db-isolated','db-shared-dev','db-shared-prod');
CREATE TYPE xell_status      AS ENUM ('provisioning','ready','claimed','working','idle',
                                      'awaiting-done','tearing-down','retired','error','husk');
CREATE TYPE container_role   AS ENUM ('db','server','webapp','infra');
CREATE TYPE container_tier   AS ENUM ('dev','prod','spinoff');
CREATE TYPE container_iso    AS ENUM ('shared','per-xell');
CREATE TYPE container_health AS ENUM ('up','down','building','purged','unknown');
CREATE TYPE zee_attach       AS ENUM ('skill-claim','headless-spawn');
CREATE TYPE zee_status       AS ENUM ('spawning','online','working','idle','stopped','errored');
CREATE TYPE task_status      AS ENUM ('queued','assigned','working','done','cancelled');

-- ── a managed repo (project-agnostic; OmniBiz is row #1) ─────────────────────
CREATE TABLE project (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text UNIQUE NOT NULL,
  repo_root       text NOT NULL,
  main_branch     text NOT NULL DEFAULT 'main',
  docker_ctx_dev  text,
  docker_ctx_prod text,
  dev_host_ip     inet,
  prod_host_ip    inet,
  compose_dev     text,
  compose_spinoff text,
  compose_prod    text,
  env_file        text,
  port_server_base int NOT NULL DEFAULT 3100,
  port_web_base    int NOT NULL DEFAULT 5200,
  port_slot_mod    int NOT NULL DEFAULT 90,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ── extensible registry of agent backends a zee can run on ───────────────────
CREATE TABLE agent_runtime (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key               text UNIQUE NOT NULL,   -- claude-code-local | claude-code-remote | gpt-codex | …
  label             text NOT NULL,          -- 'Claude Code (local)' …
  vendor            text NOT NULL,          -- anthropic | openai | …
  driver            text NOT NULL,          -- agent-sdk | claude-cli | remote-api | none
  viewer_kind       text NOT NULL,          -- web | desktop-protocol | none
  viewer_url_template text,                 -- e.g. https://claude.ai/…/{session}
  enabled           boolean NOT NULL DEFAULT false,
  sort_order        int NOT NULL DEFAULT 100
);

-- ── the source a xell branches from; READ-ONLY, immutable per xell ───────────
CREATE TABLE xource (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES project ON DELETE CASCADE,
  ref         text NOT NULL,                 -- e.g. 'main' (local-centric)
  head_commit text,
  read_only   boolean NOT NULL DEFAULT true,
  UNIQUE (project_id, ref)
);

-- ── the isolated environment ─────────────────────────────────────────────────
CREATE TABLE xell (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES project ON DELETE CASCADE,
  xource_id          uuid NOT NULL REFERENCES xource,          -- immutable (trigger)
  slug               text NOT NULL,
  branch             text NOT NULL,                            -- spinoff/<slug>
  worktree_path      text UNIQUE,
  git_dir            text,
  head_commit        text,
  last_synced_commit text,
  source_coupling    source_coupling NOT NULL DEFAULT 'sparse-overlay',
  db_coupling        db_coupling     NOT NULL DEFAULT 'db-shared-dev',
  status             xell_status     NOT NULL DEFAULT 'provisioning',
  is_pooled          boolean NOT NULL DEFAULT true,
  is_clean           boolean,
  merged_into_xource boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  ready_at           timestamptz,
  retired_at         timestamptz,
  UNIQUE (project_id, slug),
  -- IMPOSSIBILITY: a xell can only ever be on its own spinoff/ branch …
  CONSTRAINT xell_branch_is_spinoff CHECK (branch LIKE 'spinoff/%')
  -- … and can never track its xource's branch — enforced together with xource
  -- immutability by trigger xell_guard() below (needs a subquery, so not a CHECK).
);

-- ── every container, first-class ─────────────────────────────────────────────
CREATE TABLE container (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES project ON DELETE CASCADE,
  role          container_role NOT NULL,
  tier          container_tier NOT NULL,
  isolation     container_iso  NOT NULL,
  name          text NOT NULL,             -- omnibiz_db_dev / omnibiz_spin_server_<slug>
  image_tag     text,
  docker_ctx    text,
  host          inet,
  host_port     int,
  internal_port int,
  url           text,
  compose_project text,
  compose_file  text,
  network       text,
  conn_ref      text,                       -- secret NAME only, never the password
  owner_xell_id uuid REFERENCES xell ON DELETE CASCADE,   -- set iff isolation='per-xell'
  health        container_health NOT NULL DEFAULT 'unknown',
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- per-xell containers have an owner; shared singletons do not
  CONSTRAINT container_owner_matches_isolation
    CHECK ((isolation = 'per-xell') = (owner_xell_id IS NOT NULL)),
  -- container names are unique within a project (used for idempotent upserts)
  UNIQUE (project_id, name)
);
CREATE INDEX container_project_role_idx ON container (project_id, role, tier);
CREATE INDEX container_owner_idx        ON container (owner_xell_id);

-- ── what containers a xell TALKS TO (owns its server/web/db, uses shared db/infra) ─
CREATE TABLE xell_uses_container (
  xell_id      uuid NOT NULL REFERENCES xell ON DELETE CASCADE,
  container_id uuid NOT NULL REFERENCES container ON DELETE CASCADE,
  relation     text NOT NULL CHECK (relation IN ('owns','uses')),
  PRIMARY KEY (xell_id, container_id)
);

-- ── an agent bound to exactly one xell ───────────────────────────────────────
CREATE TABLE zee (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  xell_id           uuid NOT NULL REFERENCES xell ON DELETE CASCADE,
  claude_session_id text UNIQUE,
  pid               int,
  proc_start        text,
  session_name      text,
  name              text,        -- codename; set ONLY while status='working', else NULL
  entrypoint        text,        -- claude-desktop | headless-sdk | headless-cli
  kind              text,        -- interactive | headless
  attach_mode       zee_attach NOT NULL,
  runtime_id        uuid REFERENCES agent_runtime,
  viewer_url        text,        -- deep link to VIEW this session (captured at spawn)
  viewer_kind       text,        -- web | desktop-protocol | none
  model             text,
  system_prompt_ref text,
  allowed_tools     jsonb,
  permission_mode   text,
  skills            jsonb,
  status            zee_status NOT NULL DEFAULT 'spawning',
  transcript_path   text,
  cwd               text,
  cost_usd          numeric NOT NULL DEFAULT 0,
  last_event_at     timestamptz,
  last_stop_reason  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  attached_at       timestamptz,
  decommissioned_at timestamptz
);
-- a xell has at most one LIVE zee at a time
CREATE UNIQUE INDEX one_active_zee_per_xell ON zee (xell_id)
  WHERE status IN ('spawning','online','working','idle');
CREATE INDEX zee_status_idx ON zee (status);

-- ── the opaque intake ("new prompt"); queenzee never inspects prompt_text ────
CREATE TABLE task (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES project ON DELETE CASCADE,
  prompt_text         text NOT NULL,
  source              text,           -- skill | webapp-intake | api
  req_source_coupling source_coupling,
  req_db_coupling     db_coupling,
  req_runtime_id      uuid REFERENCES agent_runtime,
  status              task_status NOT NULL DEFAULT 'queued',
  xell_id             uuid REFERENCES xell,
  zee_id              uuid REFERENCES zee,
  created_at          timestamptz NOT NULL DEFAULT now(),
  assigned_at         timestamptz,
  done_at             timestamptz,
  done_by             text            -- 'done' is HUMAN-set → triggers the reaper
);
CREATE INDEX task_status_idx ON task (status);

-- ── observability feed (harness hooks + passive poller) ──────────────────────
CREATE TABLE session_event (
  id                bigserial PRIMARY KEY,
  ts                timestamptz NOT NULL DEFAULT now(),
  source            text,             -- hook | poller
  hook_event_name   text,
  claude_session_id text,
  zee_id            uuid REFERENCES zee ON DELETE SET NULL,
  xell_id           uuid REFERENCES xell ON DELETE SET NULL,
  pid               int,
  cwd               text,
  agent_id          text,
  tool_name         text,
  permission_mode   text,
  stop_reason       text,
  raw               jsonb
);
CREATE INDEX session_event_session_idx ON session_event (claude_session_id, ts DESC);
CREATE INDEX session_event_zee_idx     ON session_event (zee_id, ts DESC);

-- ── queenzee maintenance ─────────────────────────────────────────────────────
CREATE TABLE db_snapshot (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES project ON DELETE CASCADE,
  source     text,               -- prod | dev
  dump_path  text,
  size_bytes bigint,
  sha        text,
  taken_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE db_refresh (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  xell_id     uuid NOT NULL REFERENCES xell ON DELETE CASCADE,
  snapshot_id uuid REFERENCES db_snapshot,
  method      text,              -- init_db | pg_restore
  started_at  timestamptz,
  finished_at timestamptz,
  status      text
);
CREATE TABLE pool_config (
  project_id             uuid PRIMARY KEY REFERENCES project ON DELETE CASCADE,
  target_ready           int NOT NULL DEFAULT 3,
  default_source_coupling source_coupling NOT NULL DEFAULT 'sparse-overlay',
  default_db_coupling    db_coupling     NOT NULL DEFAULT 'db-shared-dev',
  default_runtime_id     uuid REFERENCES agent_runtime,
  prod_backup_cron       text,
  refresh_interval_sec   int NOT NULL DEFAULT 3600
);

-- ── triggers: enforce the two impossibilities ────────────────────────────────
CREATE FUNCTION xell_guard() RETURNS trigger AS $$
DECLARE
  xref text;
BEGIN
  -- a xell cannot be re-pointed to a different xource (cannot track another branch)
  IF (TG_OP = 'UPDATE') AND (NEW.xource_id IS DISTINCT FROM OLD.xource_id) THEN
    RAISE EXCEPTION 'xell.xource_id is immutable (a xell cannot track a different xource)';
  END IF;
  -- a xell's working branch can never equal its xource's ref
  SELECT ref INTO xref FROM xource WHERE id = NEW.xource_id;
  IF xref IS NOT NULL AND NEW.branch = xref THEN
    RAISE EXCEPTION 'xell.branch (%) may not equal its xource ref (%)', NEW.branch, xref;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER xell_guard_trg
  BEFORE INSERT OR UPDATE ON xell
  FOR EACH ROW EXECUTE FUNCTION xell_guard();

-- keep updated_at-ish freshness on zee via last_event_at is handled in app code.

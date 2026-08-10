-- HIERARCHICAL WORKFLOW MODEL — CROSS-CUTTING ENTITIES + LEASES — the entity/lease plane
--
-- Stage 5 of the serial rollout (docs/hierarchical-workflow-adoption.md §5). On top of the
-- stage-1 tables (plan/plan_version/work_node/dependency, union graph, cycle detection) and
-- the stage-3 durability plane (run/execution/event/checkpoint) this migration delivers the
-- ENTITY COLLAPSE: `entity` (anything that can be assigned work — person, model, script,
-- service, pool, org unit, or another plan — as parameter values, NOT subtypes), the
-- member/calendar lookups, the `lease` (what makes the collapse real: a crashed worker and
-- a person who went on holiday are the same event — the lease lapsed, requeue it), the
-- `allocation` capacity ledger, and the three operational views the sweeper and dashboards
-- read (lease_expiring / entity_load / orphaned_work).
--
-- DESIGN OF RECORD: docs/hierarchical-workflow-schema.sql (cross-cutting + PLANE 3 lease/
-- allocation + OPERATIONAL VIEWS). Departures from it are ZEEHIVE welds or stage boundaries,
-- and each is named below:
--
--   • `calendar` is NOT created here — stage 1 (165) already did, because
--     work_node.calendar_id references it. Only entity.calendar_id's FK is added.
--
--   • `entity.plan_id` references the ZEEHIVE `plan` table, which carries the tenancy weld
--     plan.project_id (165/167). The general DDL's plan is silent on tenancy; ZEEHIVE binds a
--     plan to a project at the root (adoption §2), and entity.plan_id just points at it.
--
--   • `execution.entity_id` was a PLAIN uuid from stage 3 (177) — "FK to entity() lands with
--     stage 5 (entities)". This migration adds that FK (the 172 precedent: a column stubbed
--     as a plain uuid until its table lands, then the FK added additively). All existing
--     execution rows have NULL entity_id, so the constraint is satisfiable everywhere.
--
--   • Capability matching (adoption §5 stage 5): the REQUIREMENTS side (work_node
--     req_capabilities/req_constraints/req_selection/req_candidates/req_quantity/req_mode +
--     the wn_capabilities_idx GIN) landed with stage 1 (166/176). This migration delivers the
--     SUPPLY side: entity.capabilities with a GIN index. Resolution (invariant E1) stays
--     application code at dispatch time, exactly as the DDL's invariant summary says.
--
--   • kind_hint is DISPLAY-ONLY (design §6): dashboards show an icon from it; engine logic
--     must NEVER branch on it. test/entity-kind-hint-lint.test.mjs fails the build if any
--     engine file branches on it.
--
--   • The lease SWEEPER that reads lease_expiring is a LATER stage. nudge.js and revive.js
--     (the special-cased wake paths) stay in place, untouched, for now; the sweeper runs
--     alongside them once it lands.
--
-- FORWARD-ONLY: every object is created idempotently (CREATE TABLE IF NOT EXISTS / CREATE OR
-- REPLACE VIEW / the DO-block duplicate_object pattern). A second migrate pass is a clean
-- no-op. The DOWN thinking (never run in prod): DROP VIEW orphaned_work, entity_load,
-- lease_expiring; DROP TABLE allocation, lease, entity_member, entity (children first); the
-- FKs on execution drop with the constraint; then DROP TYPE lease_state, cancellability,
-- dispatch_mode in reverse order of creation.

-- ── stage-5 enum types ──────────────────────────────────────────────────────────
-- How an entity receives work (design §6.2). Push = engine calls out and holds a short
-- lease (HTTP service, model call). Pull = work lands in a queue, the entity claims it and
-- holds a long lease (person, batch worker). The whole "waiting" concept dissolves into a
-- long lease held by a pull entity.
DO $$ BEGIN
  CREATE TYPE dispatch_mode AS ENUM ('push', 'pull');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- What happens when the engine asks an entity to stop (design §6.6). 'immediate' stops
-- synchronously; 'cooperative' honours a cancellation request, eventually; 'never' means
-- orphaned work EXISTS and is tracked by the orphaned_work view rather than pretended away.
DO $$ BEGIN
  CREATE TYPE cancellability AS ENUM ('immediate', 'cooperative', 'never');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A lease is held while work is in flight; it lapses (expired) or is released/revoked. The
-- sweeper's read set is WHERE state='held' AND expires_at <= now() — the universal timeout.
DO $$ BEGIN
  CREATE TYPE lease_state AS ENUM ('held', 'released', 'expired', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── CROSS-CUTTING: ENTITY ────────────────────────────────────────────────────────
-- Anything that can be assigned work and eventually return a result. Person, model, script,
-- service, pool, org unit, another plan — the differences are PARAMETER VALUES, not types.
-- There is deliberately no discriminated union: a script gets `assign` as a subprocess
-- spawn, a service gets an HTTP call, a model gets an inference request, a person gets a
-- row in their task inbox, and the ENGINE CANNOT TELL THEM APART — it holds a lease and
-- waits. kind_hint exists so dashboards can show an icon; the moment engine logic branches
-- on it the abstraction has failed (design §6).
CREATE TABLE IF NOT EXISTS entity (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  kind_hint       text,                      -- display only. NEVER branch on this.

  -- CONTRACT
  capabilities    text[] NOT NULL DEFAULT '{}',
  accepts         jsonb,                     -- JSON Schema for input
  produces        jsonb,                     -- JSON Schema for output

  -- BEHAVIOUR (attributes, not subtypes)
  dispatch        dispatch_mode  NOT NULL DEFAULT 'push',
  latency         jsonb,                     -- {dist: 'pert', optimistic, likely, pessimistic}
  reliability     numeric(5,4)   NOT NULL DEFAULT 1.0
                      CHECK (reliability BETWEEN 0 AND 1),
  cost_model      jsonb,                     -- {unit: time|token|call|currency, rate}
  cancellable     cancellability NOT NULL DEFAULT 'cooperative',
  deterministic   boolean        NOT NULL DEFAULT false,

  -- CAPACITY
  concurrency     integer        NOT NULL DEFAULT 1 CHECK (concurrency > 0),
  calendar_id     uuid,
  rate_limit      jsonb,                     -- {n, per_seconds, burst}
  consumable      boolean        NOT NULL DEFAULT false,
                  -- false: capacity returns on release (people, workers, licences)
                  -- true:  capacity is spent permanently (budget, materials)
  capacity_total  numeric,                   -- required when consumable
  capacity_used   numeric        NOT NULL DEFAULT 0,

  -- COMPOSITION
  plan_id         uuid,                      -- set => assigning work launches a plan

  enabled         boolean        NOT NULL DEFAULT true,
  created_at      timestamptz    NOT NULL DEFAULT now(),
  updated_at      timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT entity_consumable_needs_capacity
      CHECK (NOT consumable OR capacity_total IS NOT NULL),
  CONSTRAINT entity_capacity_not_overdrawn
      CHECK (capacity_total IS NULL OR capacity_used <= capacity_total)
);

-- The supply side of capability matching: a node's req_capabilities match an entity's
-- capabilities via GIN containment. The requirements side (work_node.req_*) landed in 166.
CREATE INDEX IF NOT EXISTS entity_capabilities_idx ON entity USING gin (capabilities);
CREATE INDEX IF NOT EXISTS entity_plan_idx         ON entity (plan_id) WHERE plan_id IS NOT NULL;

-- Pools and org units: an entity whose capacity is drawn from its members.
CREATE TABLE IF NOT EXISTS entity_member (
  parent_id  uuid NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  member_id  uuid NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  weight     numeric NOT NULL DEFAULT 1,
  PRIMARY KEY (parent_id, member_id),
  CONSTRAINT entity_member_no_self CHECK (parent_id <> member_id)
);

-- entity.calendar_id — the DDL declares this FK inline on entity, but the calendar table
-- landed with stage 1 (165). Explicitly named as the DDL names it (entity_calendar_fk).
DO $$ BEGIN
  ALTER TABLE entity
    ADD CONSTRAINT entity_calendar_fk
    FOREIGN KEY (calendar_id) REFERENCES calendar(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- entity.plan_id — a plan-backed entity: assigning work to this entity LAUNCHES a workflow
-- (design §6.5). Referenced additively, named as the DDL names it.
DO $$ BEGIN
  ALTER TABLE entity
    ADD CONSTRAINT entity_plan_fk
    FOREIGN KEY (plan_id) REFERENCES plan(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- execution.entity_id — the stage-3 column was a PLAIN uuid (177: "FK to entity() lands
-- with stage 5"). Added under the auto-generated inline-FK name so the schema dump matches
-- a DDL that declared `REFERENCES entity(id)` on the column.
DO $$ BEGIN
  ALTER TABLE execution
    ADD CONSTRAINT execution_entity_id_fkey
    FOREIGN KEY (entity_id) REFERENCES entity(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── PLANE 3 — LEASE ─────────────────────────────────────────────────────────────
-- The lease is what makes the entity collapse real. A crashed worker and a person who went
-- on holiday are the SAME event: the lease lapsed, requeue it. One timeout mechanism, one
-- recovery path, and no separate 'wait' node kind — waiting is a long lease held by a pull
-- entity. `expires_at > claimed_at` is enforced by a CHECK; a lapsed lease is a fact the
-- lease_expiring view exposes to the sweeper, not an error in the schema.
CREATE TABLE IF NOT EXISTS lease (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL REFERENCES execution(id) ON DELETE CASCADE,
  entity_id    uuid NOT NULL REFERENCES entity(id),
  state        lease_state NOT NULL DEFAULT 'held',
  claimed_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  released_at  timestamptz,
  CONSTRAINT lease_expiry_after_claim CHECK (expires_at > claimed_at)
);

-- E4: exactly one active lease per execution. A partial unique index (WHERE state='held')
-- lets an execution hold released/expired/revoked lease HISTORY while refusing a second
-- concurrent holder. This is the "one wake path" guarantee: an execution cannot be claimed
-- twice, so a lapsed lease can only be requeued after the old one leaves 'held'.
CREATE UNIQUE INDEX IF NOT EXISTS lease_one_active_per_execution
  ON lease (execution_id)
  WHERE state = 'held';

-- The sweeper's read set. Expiry is the universal timeout, covering crashed workers and
-- absent humans identically — this index is what makes the sweep a range scan, not a scan.
CREATE INDEX IF NOT EXISTS lease_expiry_sweep_idx ON lease (expires_at) WHERE state = 'held';

-- ── PLANE 3 — ALLOCATION ────────────────────────────────────────────────────────
-- Capacity accounting. Renewable entities are leased and released; consumable entities are
-- debited permanently (compensation must explicitly re-credit). The entity_capacity_not_
-- overdrawn CHECK on entity is what makes a consumable overdraw REFUSE rather than go
-- negative.
CREATE TABLE IF NOT EXISTS allocation (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL REFERENCES execution(id) ON DELETE CASCADE,
  entity_id    uuid NOT NULL REFERENCES entity(id),
  quantity     numeric NOT NULL DEFAULT 1 CHECK (quantity > 0),
  mode         allocation_mode NOT NULL DEFAULT 'exclusive',
  from_ts      timestamptz NOT NULL,
  to_ts        timestamptz,
  released     boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS alloc_entity_window_idx ON allocation (entity_id, from_ts, to_ts);

-- ── OPERATIONAL VIEWS ───────────────────────────────────────────────────────────
-- Leases about to lapse. The sweeper reads this: expiry is the universal timeout, covering
-- crashed workers and absent humans identically. (The sweeper itself is a later stage; the
-- view is the contract it reads, and it is exercised by test/workflow-stage5.test.mjs.)
CREATE OR REPLACE VIEW lease_expiring AS
    SELECT l.*, e.run_id, e.work_node_id, en.name AS entity_name, en.cancellable
    FROM lease l
    JOIN execution e ON e.id = l.execution_id
    JOIN entity en   ON en.id = l.entity_id
    WHERE l.state = 'held' AND l.expires_at <= now();

-- Entities currently over/under capacity. The engine reads headroom before dispatching;
-- a negative headroom means a consumable debit went through while capacity was exhausted
-- (which the entity_capacity_not_overdrawn CHECK on the row itself makes impossible) or a
-- non-consumable entity is over-committed (the dispatcher's job to avoid, not the schema's).
CREATE OR REPLACE VIEW entity_load AS
    SELECT en.id, en.name, en.concurrency,
           count(*) FILTER (WHERE l.state = 'held') AS active,
           en.concurrency - count(*) FILTER (WHERE l.state = 'held') AS headroom
    FROM entity en
    LEFT JOIN lease l ON l.entity_id = en.id
    GROUP BY en.id, en.name, en.concurrency;

-- Orphaned work: race losers and cancellations against entities that cannot be stopped
-- (design §6.6, invariant E6). Do NOT paper over this — it still consumes capacity and may
-- still produce side effects. Track it, honestly.
CREATE OR REPLACE VIEW orphaned_work AS
    SELECT e.id AS execution_id, e.run_id, e.work_node_id, en.name AS entity_name
    FROM execution e
    JOIN entity en ON en.id = e.entity_id
    WHERE e.state = 'cancelled' AND en.cancellable = 'never';

COMMENT ON TABLE entity IS
  'Cross-cutting: anything that can be assigned work and eventually return a result. Person, model, script, service, pool, org unit, another plan — parameter values, not subtypes. kind_hint is display-only: engine logic must never branch on it (test/entity-kind-hint-lint.test.mjs).';
COMMENT ON TABLE entity_member IS
  'Cross-cutting: a pool/org-unit entity whose capacity is drawn from its members.';
COMMENT ON TABLE lease IS
  'PLANE 3: one held lease per execution (lease_one_active_per_execution). Expiry is the UNIVERSAL timeout — a lapsed lease requeues the work, identically for a crashed worker and an absent human.';
COMMENT ON TABLE allocation IS
  'PLANE 3: capacity accounting. Renewable entities are leased/released; consumable entities are debited permanently.';
COMMENT ON VIEW lease_expiring IS
  'Operational: held leases at or past expiry. The sweeper reads this — one timeout mechanism, one recovery path.';
COMMENT ON VIEW entity_load IS
  'Operational: active vs concurrency headroom per entity, for dispatch-time admission.';
COMMENT ON VIEW orphaned_work IS
  'Operational: cancelled executions bound to cancellable=never entities (invariant E6) — still consuming capacity and possibly producing side effects.';

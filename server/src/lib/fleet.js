// Read model for the dashboard: project header, N-of-M status line, grouped container
// inventory, and one entry per xell (container stack + its live zee + runtime badge).
import { q, one } from '../db/pool.js';
import { projectHeads } from './git.js';
import { listMachines } from './machines.js';
import { hiveStatus, hiveLabel } from './hive-status.js';
import { buildLandingPad } from '../queenzee/landingpad.js';
import { deviceConfig } from './devices.js';
import { reasonPair } from './status.js';
import { listDoneSuggestions } from './managers.js';
import { holdingByRef } from '../queenzee/landgate.js';

export async function defaultProject() {
  return one(`SELECT * FROM project ORDER BY created_at LIMIT 1`);
}

// What each db container CONTAINS (db_instance, 019): primary + clone template + per-xell
// clones. Shipped as a JSON aggregate so the chip can say what lives inside without another
// round-trip; owner_slug names a clone's xell, and a clone with NO owner is an orphan worth
// seeing. Non-db containers aggregate to []. Correlated on `c.id`, so it drops into any query
// that has a `container c` in scope (the inventory query AND each xell's stack query).
const INSTANCES_AGG = `
    (SELECT coalesce(json_agg(json_build_object(
              'id', di.id, 'name', di.name, 'kind', di.kind,
              'owner_xell_id', di.owner_xell_id, 'owner_slug', ox.slug,
              'prod_diff', di.prod_diff, 'prod_diff_at', di.prod_diff_at,
              'refreshed_at', di.refreshed_at)
            ORDER BY CASE di.kind WHEN 'primary' THEN 0 WHEN 'template' THEN 1
                                  WHEN 'clone' THEN 2 ELSE 3 END, di.name), '[]'::json)
       FROM db_instance di LEFT JOIN xell ox ON ox.id = di.owner_xell_id
      WHERE di.container_id = c.id) AS instances`;

// The per-fleet git/ship context shared by every xell: the heads its xource refs resolve to, and
// what production is currently serving. Read ONCE for the whole fleet, never per xell — a dashboard
// poll must not shell out to git N times.
async function fleetGitContext(project) {
  // Two local ref reads for the whole fleet, not one per xell — this is a dashboard poll.
  const heads = projectHeads(project.repo_root, project.main_branch || 'main');
  // What production is RUNNING: the last ship that actually landed. NULL until one does — see the
  // note in timeline.js getDiffs; nothing recorded the hand-deploys that predate the ship gate.
  const deployed = await one(
    `SELECT commit, finished_at FROM ship_request WHERE project_id=$1 AND status='shipped'
       ORDER BY finished_at DESC NULLS LAST LIMIT 1`, [project.id]);
  return { heads, deployed };
}

// The xell rows (one per non-retired xell) BEFORE their container stacks are attached. Kept
// separate from decoration so a caller can stream: fetch the cheap list first, then resolve each
// xell's stack one at a time and emit it the moment it is ready.
async function fetchXellRows(pid) {
  return q(
    `SELECT x.*, xo.ref AS xource_ref,
            z.id AS zee_id, z.name AS zee_name, z.status AS zee_status, z.title AS zee_title,
            z.claude_session_id, z.session_name, z.viewer_url, z.viewer_kind,
            z.cost_usd, z.attach_mode, z.cli_active, z.monitor_source, z.last_monitor_at,
            z.permission_mode, z.kind AS zee_kind,
            r.label AS runtime_label, r.key AS runtime_key,
            -- the harness this xell wears (config layer — persona/skills), NULL = core only
            hn.key AS harness_key, hn.label AS harness_label,
            -- RESOLVED ENVIRONMENT (migration 043): which env this xell is loaded with, by the same
            -- rule lib/environments.js uses — an explicit pin, else the default env of the computed
            -- tier (prod for a xell on production — live, read-only or being it — else dev).
            -- env_var_count surfaces the empty case (an empty env adds nothing to .zeehive.env
            -- — the safe, dormant state).
            env.env_key, env.env_tier, env.env_pinned, env.env_var_count,
            -- FLEET BURN (per xell): sum of what EVERY zee this xell has ever hosted consumed —
            -- tokens + $ — not just the currently-shown zee (z above is one row). A cxell xell can
            -- outlive several zees; the card figure must be the xell's whole burn. Cheap subquery on
            -- the zee(xell_id) index. NB: fleet-own consumption, NOT Anthropic account %/limits.
            (SELECT COALESCE(SUM(zb.input_tokens + zb.output_tokens
                                 + zb.cache_read_tokens + zb.cache_write_tokens), 0)
               FROM zee zb WHERE zb.xell_id = x.id) AS burn_tokens,
            (SELECT COALESCE(SUM(zb.cost_usd), 0)
               FROM zee zb WHERE zb.xell_id = x.id) AS burn_cost,
            (SELECT t.id FROM task t WHERE t.xell_id = x.id
               AND t.status IN ('assigned','working') ORDER BY t.created_at DESC LIMIT 1) AS task_id,
            -- LIVE SIGNALS the hive status derivation needs but the row itself doesn't hold: a
            -- land/ship request pending a human, the zee's tend (needs-attention) ping, and whether
            -- production's shields are down (a deploy holds the prod lock). Folded into the one row
            -- read so the honeycomb's per-xell status costs no extra round-trips (see lib/hive-status).
            EXISTS(SELECT 1 FROM land_request lr WHERE lr.xell_id = x.id
                     AND lr.status IN ('pending','approved') AND lr.dismissed_at IS NULL) AS land_pending,
            -- QUEUED for the runway (067): another xell's landing is open on this ref, so this
            -- one's push is in the holding pattern. It is NOT a card and asks nothing of a human —
            -- but a zee gone quiet waiting for a runway must not read as merely idle.
            EXISTS(SELECT 1 FROM land_request lh WHERE lh.xell_id = x.id
                     AND lh.status = 'holding' AND lh.cleared_at IS NULL) AS land_holding,
            -- deferred_at IS NULL: a ship a human DEFERRED is deliberately set aside, so it no
            -- longer nags on the xell's hexagon as "ship awaiting a human".
            EXISTS(SELECT 1 FROM ship_request sr WHERE sr.xell_id = x.id
                     AND sr.status IN ('pending','approved','shipping') AND sr.dismissed_at IS NULL
                     AND sr.deferred_at IS NULL) AS ship_pending,
            -- The two PROD-DATA asks a zee can only REQUEST: a bind to the live production database
            -- (prod_bind_request, 029) and a queenzee-run seed of production (prod_seed_request,
            -- 049). Both are held gates awaiting a human, so both light the hexagon — without this
            -- a zee could ask and never be answered: the request existed only in the queenzee log.
            EXISTS(SELECT 1 FROM prod_bind_request pbr WHERE pbr.xell_id = x.id
                     AND pbr.status = 'pending') AS prod_bind_pending,
            EXISTS(SELECT 1 FROM prod_seed_request psr WHERE psr.xell_id = x.id
                     AND psr.status IN ('pending','approved','running')
                     AND psr.dismissed_at IS NULL) AS seed_pending,
            tnd.hook_event_name = 'tend-request' AS tend_pending,
            -- …and WHY. A tend says "a human is needed here"; without the reason the console could
            -- only say that much, and the human had to open the session and read a transcript to
            -- find out what for. The zee gives one brief line when it raises (self.selfTend) — it
            -- rides here so the card and the "waiting on you" chip can show it.
            tnd.reason AS tend_reason, tnd.ts AS tend_at,
            -- readiness HINTS (zee said "this looks land/ship-ready" without calling the gated verb):
            -- same latest-event-wins ride as tend, one per kind.
            (SELECT se.hook_event_name FROM session_event se
               WHERE se.xell_id = x.id AND se.hook_event_name IN ('landhint-request','landhint-clear')
               ORDER BY se.ts DESC LIMIT 1) = 'landhint-request' AS land_hint,
            (SELECT se.hook_event_name FROM session_event se
               WHERE se.xell_id = x.id AND se.hook_event_name IN ('shiphint-request','shiphint-clear')
               ORDER BY se.ts DESC LIMIT 1) = 'shiphint-request' AS ship_hint,
            -- A MANAGER zee suggested this xell is finished: a held decision, raised by another
            -- agent rather than by this xell's own zee, and it must be visible or a manager's
            -- suggestion is as invisible as the prod-bind ask used to be.
            EXISTS(SELECT 1 FROM done_suggestion ds WHERE ds.target_xell_id = x.id
                     AND ds.status = 'pending' AND ds.dismissed_at IS NULL) AS done_suggested,
            -- the manager this xell reports to (its slug, for the card/hexagon)
            (SELECT mx.slug FROM xell mx WHERE mx.id = x.manager_xell_id) AS manager_slug,
            EXISTS(SELECT 1 FROM deploy_lock dl2 WHERE dl2.project_id = x.project_id
                     AND dl2.container = 'prod') AS prod_lock_active,
            dl.container IS NOT NULL AS holds_prod_lock, dl.phase AS prod_lock_phase
       FROM xell x
       LEFT JOIN deploy_lock dl ON dl.xell_id = x.id AND dl.container = 'prod'
       -- the xell's LATEST tend event (raise or clear): its OPEN state and, when open, the brief
       -- reason the zee gave. One lateral instead of two correlated scans of the same rows.
       LEFT JOIN LATERAL (
         SELECT se.hook_event_name, se.ts, se.raw->>'reason' AS reason
           FROM session_event se
          WHERE se.xell_id = x.id AND se.hook_event_name IN ('tend-request','tend-clear')
          ORDER BY se.ts DESC LIMIT 1
       ) tnd ON true
       LEFT JOIN harness hn ON hn.id = x.harness_id
       JOIN xource xo ON xo.id = x.xource_id
       -- The xell's zee, PREFERRING a living one but falling back to the most recent dead one.
       -- The old join took only living zees, so a session whose PROCESS died (app closed, laptop
       -- rebooted, one liveness blip) vanished from its card entirely — reading as "no session"
       -- when the session JSONL is on disk and resumable and the zee row still holds the viewer
       -- link. Process death is not session death; the card shows detached instead of nothing.
       LEFT JOIN LATERAL (
         SELECT * FROM zee zz WHERE zz.xell_id = x.id
          ORDER BY CASE WHEN zz.status IN ('spawning','online','working','idle') THEN 0 ELSE 1 END,
                   zz.created_at DESC
          LIMIT 1
       ) z ON true
       LEFT JOIN agent_runtime r ON r.id = z.runtime_id
       -- resolved environment: the pin if set, else the default env of the computed tier
       LEFT JOIN LATERAL (
         SELECT e.id AS env_id, e.key AS env_key, e.tier AS env_tier,
                (x.environment_id IS NOT NULL) AS env_pinned,
                (SELECT count(*) FROM environment_var ev WHERE ev.environment_id = e.id) AS env_var_count
           FROM environment e
          WHERE e.project_id = x.project_id
            AND ((x.environment_id IS NOT NULL AND e.id = x.environment_id)
              -- the SQL copy of lib/environments.js isOnProduction(): a xell on production —
              -- writing it (db-shared-prod), READING it (db-prod-readonly, the manager binding) or
              -- being it (is_production) — is loaded with the prod environment. Keep the two in
              -- step; ticket #15 was them disagreeing about the read-only case.
              OR (x.environment_id IS NULL AND e.is_default
                  AND e.tier = CASE WHEN x.is_production
                                      OR x.db_coupling IN ('db-shared-prod','db-prod-readonly')
                                    THEN 'prod'::container_tier ELSE 'dev'::container_tier END))
          ORDER BY (e.id = x.environment_id) DESC
          LIMIT 1
       ) env ON true
      WHERE x.project_id = $1 AND x.status <> 'retired'
      ORDER BY x.created_at`, [pid]);
}

// Can a browser shell open into this container row? Mirrors terminal-bridge.resolveShellTarget:
//   • a PER-XELL process role (runner:process, owner set) has no container of its own — its shell
//     is the queenzee at the worktree, which works even while the role is DOWN → always shellable;
//   • everything else is a real docker container → shellable only when it's running ('up').
// The process signal is the manifest's per-role runner (what build.js reads), spinoff-tier default
// as fallback; db is never a process role, and a SHARED prod server/webapp is a real container.
function containerShellable(project, c) {
  if (c.role !== 'db' && c.owner_xell_id) {
    const m = project?.manifest;
    if ((m?.roles?.[c.role]?.runner || m?.tiers?.spinoff?.runner || null) === 'process') return true;
  }
  return c.health === 'up';
}

// Attach a xell's resolved container stack + xource/deploy heads. Mutates and returns `x`. One
// stack query per xell — the streamable unit of work.
async function decorateXell(x, heads, deployed, project) {
  const stack = await q(
    `SELECT c.id, c.role, c.name, c.url, c.tier, c.health, c.owner_xell_id, c.isolation,
            c.hot_build, c.last_build_commit, c.last_built_at, c.busy_since, c.busy_op,
            c.docker_ctx, c.build_ctx,
            (SELECT ox.slug FROM xell ox WHERE ox.id = c.owner_xell_id) AS owner_slug,
            c.prod_diff, c.prod_diff_at, uc.relation, ${INSTANCES_AGG}
       FROM xell_uses_container uc JOIN container c ON c.id = uc.container_id
      WHERE uc.xell_id = $1
      ORDER BY CASE c.role WHEN 'db' THEN 1 WHEN 'server' THEN 2 WHEN 'webapp' THEN 3 ELSE 4 END`,
    [x.id]);
  // Can a browser shell open into this container? (drives the chip menu's Shell item.) A PROCESS
  // role (runner:process — Zeehive's own server/webapp) has no container of its own: its shell is
  // the queenzee's container at the xell's worktree (terminal-bridge resolveShellTarget), which
  // works whenever the worktree exists — even while the process is down, which is exactly when you
  // want in to debug it. Everything else IS a docker container, so it needs to be running ('up').
  for (const c of stack) c.shellable = containerShellable(project, c);
  x.stack = stack;
  // Does THIS project support device xhips (manifest device.enabled)? Drives whether the card shows
  // the attach-device affordance. device_kind is the project's default shape (emulator|physical), so
  // the card can label the button without re-reading the manifest. A real prod xell never gets one.
  const dcfg = deviceConfig(project);
  x.device_enabled = !x.is_production && dcfg.enabled;
  x.device_kind = dcfg.kind;
  // pretty-print the name column exactly like the mockup expects
  x.zee_display_name = x.zee_status === 'working' ? x.zee_name : null;

  // DISPLAY status for the hive hexagon (lib/hive-status): the raw lifecycle status projected onto
  // the operator vocabulary, folding in the live gate/attention signals fetched with the row. The
  // label ships too so the web only owns the colour map, not a second copy of the wording.
  x.hive_status = hiveStatus(x, {
    landPending: x.land_pending === true,
    shipPending: x.ship_pending === true,
    tendPending: x.tend_pending === true,
    landHint: x.land_hint === true,
    shipHint: x.ship_hint === true,
    prodBindPending: x.prod_bind_pending === true,
    seedPending: x.seed_pending === true,
    doneSuggested: x.done_suggested === true,
    landHolding: x.land_holding === true,
    prodUnprotected: x.is_production && x.prod_lock_active === true,
  });
  x.hive_status_label = hiveLabel(x.hive_status);
  // The open TEND, with the reason the zee gave for calling a human (null when no tend is open).
  // hive_status already says THAT one is open; this says WHAT FOR — the console renders it beside
  // the ask instead of sending the human into the session to find out.
  // BOTH forms, split on the way out: `reason` is the one line a chip/card row can hold, `full` is
  // the whole text when there is more of it (null when there isn't). Clipping only, never editing —
  // the first cut of this clamped the payload itself, and a tend reporting a prod problem reached
  // the console as "…re-tasking a manager wi…" with the rest unreadable anywhere.
  const why = reasonPair(x.tend_reason);
  x.tend = x.tend_pending === true
    ? { open: true, reason: why.brief, full: why.full, at: x.tend_at || null }
    : null;
  delete x.tend_reason; delete x.tend_at;
  delete x.land_pending; delete x.ship_pending; delete x.tend_pending; delete x.prod_lock_active;
  delete x.land_hint; delete x.ship_hint;
  delete x.prod_bind_pending; delete x.seed_pending;
  // done_suggested stays on the row (not deleted): the console renders the decision card from it.

  // Fleet burn for THIS xell — sum across all its zees. pg returns bigint/numeric as strings; coerce
  // to Number so the dashboard can format it (a xell's lifetime burn is well within double precision).
  x.burn = { tokens: Number(x.burn_tokens || 0), cost: Number(x.burn_cost || 0) };
  delete x.burn_tokens; delete x.burn_cost;

  // What this xell TRACKS (its xource), and the head that ref currently resolves to.
  //   a work xell → local main.
  //   production  → origin, the backup mirror. Read from the local origin/main tracking ref, so
  //                 this never touches the network — and nothing builds from it either.
  x.remote_source = x.is_production ? { ...heads.origin } : { ...heads.local };

  // Production's equivalent of a xell's head: the commit it is actually serving. Kept separate
  // from head_commit rather than overloading it — head_commit means "provisioned at", which is
  // a different (and, for prod, meaningless) question.
  if (x.is_production) x.deployed_commit = deployed?.commit || null;
  return x;
}

// Stream a project's xells one at a time: the cheap list is fetched up front, then each xell's
// container stack is resolved and handed to `onXell` the moment it is ready — so the dashboard can
// paint a hexagon per xell as its data arrives instead of blocking on the whole fleet. Returns the
// project (or null) so the caller can still emit a "no project" tail.
export async function streamXells(projectId, onXell) {
  const project = projectId
    ? await one(`SELECT * FROM project WHERE id = $1`, [projectId])
    : await defaultProject();
  if (!project) return null;
  const { heads, deployed } = await fleetGitContext(project);
  const rows = await fetchXellRows(project.id);
  for (const x of rows) {
    await decorateXell(x, heads, deployed, project);
    await onXell(x);
  }
  return project;
}

export async function getFleet(projectId) {
  const project = projectId
    ? await one(`SELECT * FROM project WHERE id = $1`, [projectId])
    : await defaultProject();
  if (!project) return null;
  const pid = project.id;

  const pool = await one(`SELECT * FROM pool_config WHERE project_id = $1`, [pid]);

  const { heads, deployed } = await fleetGitContext(project);

  const instancesAgg = INSTANCES_AGG;

  // grouped container inventory
  const containers = await q(
    `SELECT c.id, c.role, c.tier, c.isolation, c.name, c.url, c.host_port, c.health,
            c.owner_xell_id, c.hot_build, c.last_build_commit, c.last_built_at,
            c.docker_ctx, c.build_ctx,
            (SELECT ox.slug FROM xell ox WHERE ox.id = c.owner_xell_id) AS owner_slug,
            -- where a PROCESS role (docker_ctx NULL) lives: its site's context, so the machine
            -- matrix can place it in the right column instead of 'elsewhere'
            (SELECT ds.docker_ctx FROM deploy_site ds WHERE ds.id = c.site_id) AS site_docker_ctx,
            c.busy_since, c.busy_op, c.prod_diff, c.prod_diff_at, ${instancesAgg}
       FROM container c WHERE c.project_id = $1
       ORDER BY c.role, c.tier, c.name`, [pid]);
  // Same shell-capability the xell stack carries (decorateXell) — the MATRIX renders these rows,
  // so without it every matrix chip reads "shell unavailable" even for an up process role.
  for (const c of containers) c.shellable = containerShellable(project, c);
  const groups = { db: [], server: [], webapp: [], device: [], other: [] };
  for (const c of containers) (groups[c.role] || groups.other).push(c);

  // The hive's machines with THIS project's pool sizes (machine_pool, 025) — the matrix renders
  // one column per row here, and its pool knob edits this project's number, not a global one.
  const machines = await listMachines(pid);

  // xells with their resolved container stack + live zee + runtime label. Same rows + decoration
  // the streaming path emits — just collected into an array here rather than flushed one by one.
  const xells = await fetchXellRows(pid);
  for (const x of xells) await decorateXell(x, heads, deployed, project);

  // FLEET-CUMULATIVE BURN: what every run across the whole project consumed (tokens + $), summed
  // over all zees. Computed straight from the zee rows (one query) rather than adding up the per-xell
  // figures on the client, so it also counts zees on retired xells the card list no longer shows.
  // NB: this is the fleet's OWN consumption only — Anthropic's account-wide %/limits are not exposed
  // to us (only their /usage shows those).
  const fleetBurn = await getFleetBurn(pid);

  // production is a xell too, but it's not a pooled work-xell — exclude it from the counts
  const work = xells.filter((x) => !x.is_production);
  const total = work.length;
  const inUse = work.filter((x) => ['working', 'claimed', 'idle', 'awaiting-done'].includes(x.status)).length;
  const working = work.filter((x) => x.status === 'working').length;

  // prod backups: settings + most recent FINISHED dump + count, plus any in-flight job (so the
  // panel can show a spinner while a backup runs).
  const lastBackup = await one(
    `SELECT id, dump_path, size_bytes, taken_at, source, status FROM db_snapshot
       WHERE project_id=$1 AND source='prod' AND status='finished' ORDER BY taken_at DESC LIMIT 1`, [pid]);
  const runningBackup = await one(
    `SELECT id, dump_path, taken_at FROM db_snapshot
       WHERE project_id=$1 AND source='prod' AND status='running' ORDER BY taken_at DESC LIMIT 1`, [pid]);
  const backupCount = await one(
    `SELECT count(*)::int AS n FROM db_snapshot WHERE project_id=$1 AND source='prod' AND status='finished'`, [pid]);
  // The newest ATTEMPT, whatever became of it. `last` above is the newest SUCCESS, so on its own it
  // cannot distinguish "backed up 27 hours ago, on schedule" from "backed up 27 hours ago and every
  // attempt since has FAILED" — and backupDue() counts a failed row as the window's attempt, so one
  // failure pushes the next good dump a full interval away. Silently, until now. (TKT-22-4F0E: the
  // human's fear is about DATA, and backup FRESHNESS is the reading that actually speaks to it.)
  const lastAttempt = await one(
    `SELECT id, taken_at, status, error FROM db_snapshot
       WHERE project_id=$1 AND source='prod' ORDER BY taken_at DESC LIMIT 1`, [pid]);
  const backup = {
    config: {
      backup_dir: pool?.backup_dir ?? null,
      backup_ctx: pool?.backup_ctx ?? null,
      backup_interval_sec: pool?.backup_interval_sec ?? 86400,
      max_backups: pool?.max_backups ?? 14,
      backup_tables: pool?.backup_tables ?? null,   // null/[] ⇒ full-database backups (the default)
    },
    last: lastBackup,
    last_attempt: lastAttempt || null,
    count: backupCount?.n ?? 0,
    running: runningBackup || null,
  };

  // Pushes to main being HELD for human verification. Open ones only: this drives a blocking
  // banner, and a blocked zee is stuck until someone acts on it.
  //
  // Two extra facts per row, both about the RUNWAY it sits on (#11 gap 2). `runway_occupant` says this
  // is the landing that OWNS the ref right now — the oldest open one, exactly what landgate's
  // runwayOccupant() picks — and `holders` counts the zees queued behind it. Together they are what
  // makes a DISMISSED approval visible again: dismissal hides a receipt, and a landing with zees stacked
  // behind it is not a receipt, it is a blocker. Computed here, in the same SQL and the same ordering
  // the tower uses, so the console can never disagree with the gate about who is on the runway.
  const landing = await q(
    `SELECT lr.*, x.slug AS xell_slug,
            lr.kind = 'push' AND NOT EXISTS (
              SELECT 1 FROM land_request o
                WHERE o.project_id = lr.project_id AND o.ref = lr.ref AND o.kind = 'push'
                  AND o.status IN ('pending','approved')
                  AND (o.requested_at, o.id) < (lr.requested_at, lr.id)) AS runway_occupant,
            (SELECT count(*)::int FROM land_request h
               WHERE lr.kind = 'push' AND h.project_id = lr.project_id AND h.ref = lr.ref
                 AND h.kind = 'push' AND h.status = 'holding' AND h.cleared_at IS NULL) AS holders
       FROM land_request lr LEFT JOIN xell x ON x.id = lr.xell_id
       WHERE lr.project_id = $1 AND lr.status IN ('pending','approved')
       ORDER BY lr.requested_at DESC`, [pid]);

  // THE APPROACH QUEUE — who is stacked up behind those decisions (067). Fetched separately, and
  // deliberately NOT merged into `landing`: that list is "cards a human must answer", and putting a
  // holding row in it would raise exactly the second question the runway exists to prevent. The
  // console renders these UNDER the card that owns the runway, as information, with no buttons.
  const holding = await holdingByRef(pid);

  // Ships awaiting a human, plus whoever holds prod right now. `auto_release_at` drives the
  // console's countdown + Hold prompt; the card renders a padlock on the holder.
  // Open ships, plus anything that FINISHED in the last 15 minutes: a card that vanished the
  // instant the build ended took its result — and its build log — with it, so the human's only
  // view of a just-shipped (or just-failed) deploy was gone before they could read it.
  const shipping = await q(
    `SELECT s.*, x.slug AS xell_slug FROM ship_request s JOIN xell x ON x.id = s.xell_id
       WHERE s.project_id = $1 AND s.dismissed_at IS NULL
         AND (s.status IN ('pending','approved','shipping')
          OR (s.status IN ('shipped','failed')
              AND COALESCE(s.finished_at, s.decided_at) > now() - interval '15 minutes'))
       ORDER BY s.requested_at DESC`, [pid]);
  const prodLock = await one(
    `SELECT dl.*, x.slug AS xell_slug FROM deploy_lock dl JOIN xell x ON x.id = dl.xell_id
       WHERE dl.project_id = $1 AND dl.container = 'prod'`, [pid]);

  // Ship asks that were REFUSED — the ones that never became a row. requestShip refuses outright
  // when the work is not landed (or the ship ref will not resolve), and until this existed the
  // refusal lived only in the queenzee's ring-buffer log: the zee had asked, the human saw an empty
  // production panel, and the two could not be reconciled ("xells insist they have ship requests…
  // i see zero"). Latest-event-wins per xell (shipgate → lib/status.setShipRefusal), still-current
  // only, and bounded to a day so a refusal a zee has moved on from does not haunt the panel.
  const refusedRows = await q(
    `SELECT DISTINCT ON (se.xell_id)
            se.xell_id, se.ts, se.hook_event_name, se.raw->>'reason' AS reason, x.slug AS xell_slug
       FROM session_event se JOIN xell x ON x.id = se.xell_id
      WHERE x.project_id = $1 AND x.status <> 'retired'
        AND se.hook_event_name IN ('ship-refused','ship-refused-clear')
        AND se.ts > now() - interval '24 hours'
      ORDER BY se.xell_id, se.ts DESC`, [pid]);
  const shipRefused = refusedRows
    .filter((r) => r.hook_event_name === 'ship-refused')
    .map((r) => {
      const why = reasonPair(r.reason);
      return { xell_id: r.xell_id, xell_slug: r.xell_slug, at: r.ts, reason: why.brief, full: why.full };
    });

  // PROD-DATA asks awaiting a human: a zee asking to be BOUND to the live production database, and
  // a zee asking the queenzee to run a landed SEED file against production. Both render on the
  // asking xell's card (App.jsx → ProdData.jsx). Recently-decided seeds ride along for 15 minutes,
  // like ships, so the receipt of what just ran on prod does not vanish before it can be read.
  const prodBind = await q(
    `SELECT pbr.*, x.slug AS xell_slug FROM prod_bind_request pbr
       LEFT JOIN xell x ON x.id = pbr.xell_id
      WHERE pbr.project_id = $1 AND pbr.status = 'pending'
      ORDER BY pbr.requested_at DESC`, [pid]);
  const prodSeed = await q(
    `SELECT psr.*, x.slug AS live_xell_slug FROM prod_seed_request psr
       LEFT JOIN xell x ON x.id = psr.xell_id
      WHERE psr.project_id = $1 AND psr.dismissed_at IS NULL
        AND (psr.status IN ('pending','approved','running')
         OR (psr.status IN ('seeded','failed')
             AND COALESCE(psr.finished_at, psr.decided_at) > now() - interval '15 minutes'))
      ORDER BY psr.requested_at DESC`, [pid]);

  // The LANDING PAD: landings + shipments merged into one chronological FIFO queue, with the item
  // currently on the pad (being processed) flagged so the UI can spin it.
  const landingPad = await buildLandingPad(pid);

  // A manager zee's open "this xell is finished" suggestions. Same altitude as the prod-data asks:
  // a decision only a human may make, on a xell that keeps working until they make it.
  const doneSuggestions = await listDoneSuggestions(pid, { open: true });

  return {
    project,
    pool,
    heads,
    status: { total, inUse, working, ready: work.filter((x) => x.status === 'ready').length },
    containers: groups,
    machines,
    backup,
    xells,
    fleet_burn: fleetBurn,
    landing,
    holding,
    shipping,
    ship_refused: shipRefused,
    prod_bind: prodBind,
    prod_seed: prodSeed,
    prod_lock: prodLock || null,
    landing_pad: landingPad,
    done_suggestions: doneSuggestions,
  };
}

// The fleet burn read model, standalone (also its own endpoint: GET /api/fleet/burn). Returns the
// project-cumulative total AND a per-xell breakdown grouped by xell, both summed across every zee
// the xell has hosted. Retired xells still count toward the cumulative total (their zees really did
// burn tokens) but are not listed per-xell, matching the card list which hides retired xells.
//   { fleet: { tokens, cost, input, output, cache_read, cache_write, zees },
//     xells: [{ xell_id, slug, is_production, tokens, cost, zees }, …] }
// IMPORTANT: these are the FLEET's OWN consumption only. Account-wide %/limits (how much of the
// plan is used) are NOT available here — only Anthropic's /usage surfaces those; this tracks solely
// what our own runs spent.
export async function getFleetBurn(projectId) {
  const pid = projectId
    || (await one(`SELECT id FROM project ORDER BY created_at LIMIT 1`))?.id;
  if (!pid) return null;

  const fleet = await one(
    `SELECT COALESCE(SUM(z.input_tokens), 0)::bigint       AS input,
            COALESCE(SUM(z.output_tokens), 0)::bigint      AS output,
            COALESCE(SUM(z.cache_read_tokens), 0)::bigint  AS cache_read,
            COALESCE(SUM(z.cache_write_tokens), 0)::bigint AS cache_write,
            COALESCE(SUM(z.input_tokens + z.output_tokens
                         + z.cache_read_tokens + z.cache_write_tokens), 0)::bigint AS tokens,
            COALESCE(SUM(z.cost_usd), 0) AS cost,
            COUNT(z.id)::int AS zees
       FROM zee z JOIN xell x ON x.id = z.xell_id
      WHERE x.project_id = $1`, [pid]);

  const perXell = await q(
    `SELECT x.id AS xell_id, x.slug, x.is_production,
            COALESCE(SUM(z.input_tokens + z.output_tokens
                         + z.cache_read_tokens + z.cache_write_tokens), 0)::bigint AS tokens,
            COALESCE(SUM(z.cost_usd), 0) AS cost,
            COUNT(z.id)::int AS zees
       FROM xell x LEFT JOIN zee z ON z.xell_id = x.id
      WHERE x.project_id = $1 AND x.status <> 'retired'
      GROUP BY x.id, x.slug, x.is_production
      ORDER BY tokens DESC, cost DESC`, [pid]);

  const num = (v) => Number(v || 0);
  return {
    fleet: {
      tokens: num(fleet?.tokens), cost: num(fleet?.cost),
      input: num(fleet?.input), output: num(fleet?.output),
      cache_read: num(fleet?.cache_read), cache_write: num(fleet?.cache_write),
      zees: num(fleet?.zees),
    },
    xells: perXell.map((r) => ({
      xell_id: r.xell_id, slug: r.slug, is_production: r.is_production,
      tokens: num(r.tokens), cost: num(r.cost), zees: num(r.zees),
    })),
  };
}

export async function listRuntimes() {
  return q(`SELECT id, key, label, vendor, viewer_kind, enabled, sort_order
              FROM agent_runtime ORDER BY sort_order, label`);
}

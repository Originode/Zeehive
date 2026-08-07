// THE ROUTER ZEE — the project's front door (migration 139).
//
// A ROUTER is ONE zee per project whose whole job is intake: it accepts a human's RAW prompt,
// recomposes it into a brief a zee can execute, and decides the dispatch — provider, model,
// autonomy mode, harness — under the operator's ROUTER POLICY (lib/router-policy.js). The console's
// composer routes every worker prompt THROUGH it: with no live router, the Dispatch button is
// disabled and the one honest button is "Deploy router".
//
// STRUCTURALLY it is a MANAGER-type xell wearing the `router` harness, and that choice is the whole
// safety story — every wall a router needs already exists for managers, as refusals in code rather
// than prose:
//   • it cannot LAND — the landgate declines a manager push without even raising a request;
//   • it cannot SHIP — refuseForManager, same sentence everywhere;
//   • production is READ-ONLY — the manager dispatch path mints a SELECT-only role;
//   • it MAY `zee sync` — rolling its worktree forward to the xource's current main is the one
//     write-shaped thing it is allowed, and it only touches its own cage;
//   • it dispatches workers through the same `zee dispatch` verb a manager holds.
//
// SINGULARITY is policy, not code: the `router` harness ships with model_policy `{"limit": 1}`
// (the per-project wearer cap, enforced in assignHarness), so "the router" is one zee unless an
// operator deliberately raises the cap.
import { q, one, pool } from '../db/pool.js';
import { logline } from './logbus.js';
import { broadcast } from './events.js';
import { resolveHarness } from './harness.js';
import { effectiveModelPolicy } from './model-policy.js';
import { effectiveRouterPolicy, providerInSchedule } from './router-policy.js';
import { resolveProjectId } from './project-resolve.js';

export const ROUTER_HARNESS_KEY = 'router';

// Statuses that count as "this xell is gone" everywhere else in the tree (harness.js
// reinjectHarnessIntoLiveXells uses the same set). Everything else is a LIVE wearer.
const GONE = `('retired','tearing-down','husk')`;

export async function routerHarness() {
  return resolveHarness(ROUTER_HARNESS_KEY);
}

// Does this xell WEAR the router persona (the `router` harness or a descendant of it)? The one
// predicate behind the router's extra refusal: a manager may still ask `zee ship` (it deploys
// main's tip, human-gated), but a ROUTER may not — it routes prompts; it lands nothing and ships
// nothing, and the ship gate is the one manager door that must close further for it.
export async function isRouterXell(xell) {
  if (!xell?.harness_id) return false;
  let cur = await one(`SELECT id, key, parent_id FROM harness WHERE id=$1`, [xell.harness_id]);
  let hops = 0;
  while (cur && hops++ < 32) {
    if (cur.key === ROUTER_HARNESS_KEY) return true;
    cur = cur.parent_id ? await one(`SELECT id, key, parent_id FROM harness WHERE id=$1`, [cur.parent_id]) : null;
  }
  return false;
}

// Every LIVE router xell on a project, newest first, with the zee currently in it (its model and
// its runtime's vendor — what the console's "swap it with a better model" UI shows and changes).
//
// A ROUTER IS A WEARER OF `router` **OR OF ANY DESCENDANT OF IT** — the same chain-walk
// isRouterXell does, because the two must never disagree about one xell. Matching the constant key
// alone was the bug: a project's OWN router persona is necessarily a descendant (a project-scoped
// harness carries a project-derived key, `<project>-<label>`, and may only inherit a system-wide
// harness or its own project's — see lib/harness.js and migration 086), so its wearer was invisible
// here while isRouterXell called it a router. That project then read as "no live router — deploy
// one" WITH one live, the composer offered Deploy router (a second router, since the wearer cap
// counts one harness row), and every prompt routed on it was refused.
//
// PROJECT SCOPE stays where it always was — `x.project_id = $1`, on the XELL. A descendant scoped to
// another project cannot be worn across projects (harness_scope_guard refuses it), so widening WHICH
// personas count cannot widen WHOSE routers are returned.
const ROUTER_FAMILY = `
  WITH RECURSIVE router_family AS (
    SELECT id, 0 AS depth FROM harness WHERE key = $2
    UNION ALL
    SELECT h.id, f.depth + 1 FROM harness h JOIN router_family f ON h.parent_id = f.id
     WHERE f.depth < 32
  )`;   // depth cap = isRouterXell's 32 hops: 046's trigger refuses a cycle, raw SQL does not.

export async function liveRouters(projectId) {
  if (!projectId) return [];
  return q(
    `${ROUTER_FAMILY}
     SELECT x.id, x.slug, x.status, x.zee_type, x.db_coupling, x.created_at,
            z.id AS zee_id, z.status AS zee_status, z.model AS zee_model, z.created_at AS zee_created_at,
            rt.key AS runtime_key, rt.vendor AS runtime_vendor, rt.label AS runtime_label
       FROM xell x
       JOIN router_family f ON f.id = x.harness_id
       LEFT JOIN LATERAL (
         SELECT * FROM zee z WHERE z.xell_id = x.id ORDER BY z.created_at DESC LIMIT 1
       ) z ON true
       LEFT JOIN agent_runtime rt ON rt.id = z.runtime_id
      WHERE x.project_id = $1 AND x.status NOT IN ${GONE}
      ORDER BY x.created_at DESC`,
    [projectId, ROUTER_HARNESS_KEY]);
}

// The one sentence for "this project has no router", said by the read model AND by the routing
// refusal, so a console reading the status and a caller reading the throw are never told two
// different things about the same project.
export const NO_LIVE_ROUTER = 'no live ROUTER on this project — deploy one first (the composer\'s '
  + '"Deploy router" button, or POST /api/router/deploy).';

// WHICH PROJECT — resolved the way every other entry point resolves one (lib/project-resolve.js: an
// id OR a name), because these verbs are addressed from the same places the rest of the API is. A
// bare uuid was assumed: a caller that named its project got `invalid input syntax for type uuid`
// out of the lookup's WHERE clause instead of the answer — "no live ROUTER on this project — deploy
// one" — which is the detection this read model exists to give. An unknown project still refuses,
// naming the projects that do exist (UnknownProject), rather than reporting an empty fleet.
async function routerProjectId(project) {
  if (!project) throw new Error('project required');
  return resolveProjectId({ project });
}

// ── the read model: GET /api/router/status?project=… ─────────────────────────────────────────
// One call answers the composer's three questions: is there a router (→ may I dispatch?), what is
// it running on (→ the redeploy/swap chip), and what does its policy currently say (→ the knobs,
// and which providers the schedule excludes right now).
export async function routerStatus(project) {
  const projectId = await routerProjectId(project);
  const h = await routerHarness();
  if (!h || !h.enabled) {
    return { present: false, deployable: false, routers: [], limit: null, policy: null, harness: null,
             reason: 'no `router` harness on this database — run the migrations (139) first' };
  }
  const [policy, modelPolicy, routers] = await Promise.all([
    effectiveRouterPolicy(h), effectiveModelPolicy(h), liveRouters(projectId)]);
  const limit = modelPolicy.limit;
  // Which providers the schedule window excludes AT THIS MOMENT — advisory, for the console to
  // annotate; the router itself applies the snapshot it is handed with each request.
  const now = new Date();
  const scheduled_out = Object.keys(policy.provider_schedule || {})
    .filter((p) => !providerInSchedule(policy, p, now));
  return {
    present: routers.length > 0,
    routers: routers.map((r) => ({
      xell_id: r.id, slug: r.slug, status: r.status,
      zee_status: r.zee_status || null, model: r.zee_model || null,
      provider: r.runtime_vendor || null, runtime: r.runtime_key || null,
      runtime_label: r.runtime_label || null, since: r.zee_created_at || r.created_at,
    })),
    limit,
    at_limit: limit != null && routers.length >= limit,
    deployable: limit == null || routers.length < limit,
    policy,
    scheduled_out,
    // ABSENCE IS AN ANSWER, not an empty list a caller has to interpret: a project with no live
    // router says so, in the words the routing refusal uses.
    reason: routers.length ? null : NO_LIVE_ROUTER,
    harness: { key: h.key, label: h.label,
               glyph: (typeof h.bundle === 'string' ? JSON.parse(h.bundle) : h.bundle || {}).glyph || null },
  };
}

// The brief a freshly deployed router starts from. Deliberately a JOB (the same reasoning as
// DEFAULT_MANAGER_BRIEF): the persona (the `router` harness) carries the full manual; this is the
// kick that makes an idle cage read it and stand ready.
export const DEFAULT_ROUTER_BRIEF = [
  'You are this project\'s ROUTER zee. Your manual is your harness persona — read it now.',
  '',
  'In short: humans hand you RAW PROMPTS (messages marked 🧭 ROUTING REQUEST, each carrying a',
  'snapshot of your router policy). You recompose each into a brief a zee can execute, decide the',
  'dispatch — provider (by the policy\'s weights/schedule), model, autonomy mode, worker harness —',
  'then deploy it onto a CARD (`zee work --new` if none covers it, then `zee assign --item <id>`)',
  'and report what you routed and why. You do NOT manage the zees you deploy — the card follows them.',
  '',
  'You land nothing and ship nothing (structurally refused), production is read-only to you, and',
  '`zee sync` keeps your worktree current with the xource. Orient now (`zee status`, `zee harness`,',
  '`zee creds`, and the repo manual), then wait for routing requests — do not invent work.',
].join('\n');

// ── deploy: POST /api/router/deploy ──────────────────────────────────────────────────────────
// A human's act, from the composer's "Deploy router" button. No prompt text is accepted — a
// router's job is fixed and its brief is DEFAULT_ROUTER_BRIEF; what a human picks is the PROVIDER
// and MODEL it thinks with (the composer shows exactly those two controls).
export async function deployRouter({ project, provider = null, provider_token_id = null,
                                     model = null, mode = null, runtime = null } = {}) {
  const projectId = await routerProjectId(project);
  const status = await routerStatus(projectId);
  if (!status.harness) throw new Error(status.reason);
  if (!status.deployable) {
    throw new Error(`the router harness is limited to ${status.limit} live xell(s) per project and `
      + `${status.routers.length} already live (${status.routers.map((r) => r.slug).join(', ')}) — `
      + 'redeploy or swap the existing router instead of adding another.');
  }
  const { dispatchXell } = await import('../queenzee/intake.js');
  const out = await dispatchXell({
    // the RESOLVED id — the dispatch lands in the project the status was read for, whatever the
    // caller called it.
    task: DEFAULT_ROUTER_BRIEF, project: projectId, title: 'router zee', zee_type: 'manager',
    harness: ROUTER_HARNESS_KEY,
    ...(model ? { model } : {}), ...(mode ? { mode } : {}), ...(runtime ? { runtime } : {}),
    headless: true, provider, provider_token_id,
  });
  logline('router', `ROUTER deployed on ${out.slug} — intake is open (prod read-only, no land/ship)`);
  return { ...out, zee_type: 'manager', router: true };
}

// ── redeploy / "swap it with a better model": POST /api/router/redeploy ──────────────────────
// Same xell row, NEW zee — the console half of a swap, aimed at the router: same branch, same
// containers, same read-only prod bind; only WHO routes (provider/model) changes. With no live
// router it degrades to a fresh deploy, so the button is honest in both states.
export async function redeployRouter({ project, xell_id = null, provider = null,
                                       provider_token_id = null, model = null, mode = null,
                                       by = 'human@console' } = {}) {
  const projectId = await routerProjectId(project);
  const routers = await liveRouters(projectId);
  const target = xell_id ? routers.find((r) => String(r.id) === String(xell_id)) : routers[0];
  if (!target) return deployRouter({ project: projectId, provider, provider_token_id, model, mode });
  const { swapXellZeeAsHuman } = await import('../queenzee/self.js');
  const out = await swapXellZeeAsHuman({
    xellId: target.id, harness: ROUTER_HARNESS_KEY, task: DEFAULT_ROUTER_BRIEF,
    model, mode, by, provider, provider_token_id,
  });
  if (out?.ok) logline('router', `ROUTER on ${target.slug} redeployed (${provider || 'same provider'}${model ? ` / ${model}` : ''})`);
  return { ...out, router: true, xell_id: target.id, slug: target.slug };
}

// ── CUSTOM DEPLOYMENT — the human's explicit decision, riding on a routing request ───────────
// The composer may expand a "Custom deployment" panel (the same provider/model/mode/harness
// pickers a direct dispatch offers) and whatever it pins travels with the raw prompt as a
// DECISION, not a hint: the router uses those settings for the dispatch instead of deciding them
// itself. Anything left unpinned stays the router's call, so a PARTIAL pin is normal (only a
// provider, say) and the block renders only what was configured.
//
// VALIDATED HERE, not in the route, so the refusal is the same whoever calls — and validated
// against the very read model the composer's pickers are built from (lib/dispatch-options.js), so
// a setting the picker offered can never be one this refuses. An unknown provider/model/harness is
// refused LOUDLY, naming what IS available: the same discipline as dispatch-options' blocked_reason,
// because a routing request that names a model the spawn would reject is a refusal that arrives
// after the prompt was written.
//
// A MODEL WITHOUT A PROVIDER IS REFUSED. Model ids are per vendor (`opus` is claude's, not
// codex's), so pinning one without saying whose it is would make the router pick the provider and
// then be unable to honour the model — a decision the human did not make, silently widened.
export async function resolveCustomDeployment(projectId, custom = null) {
  if (!custom || typeof custom !== 'object') return null;
  const str = (v) => (v == null ? '' : String(v).trim());
  const want = {
    provider: str(custom.provider), model: str(custom.model), harness: str(custom.harness),
    mode: custom.mode === null || custom.mode === undefined || custom.mode === '' ? null : custom.mode,
  };
  if (!want.provider && !want.model && !want.harness && want.mode === null) return null;

  const out = {};
  // The HARNESS first: it carries the model policy the provider/model choices are then judged
  // against, exactly as the composer re-reads its options when the persona changes.
  if (want.harness) {
    const { listHarnesses } = await import('./harness.js');
    const wearable = await listHarnesses({ zeeType: 'worker', projectId });
    const hit = wearable.find((h) => h.key === want.harness || String(h.id) === want.harness);
    if (!hit) {
      throw new Error(`unknown harness "${want.harness}" for a worker on this project — available: `
        + `${wearable.map((h) => h.key).join(', ') || 'none'}`);
    }
    out.harness = hit.key;
  }
  const { dispatchOptions } = await import('./dispatch-options.js');
  const opts = await dispatchOptions({ projectId, harness: out.harness || undefined, zeeType: 'worker' });
  const pickable = opts.providers.filter((p) => !p.blocked_reason);
  if (want.provider) {
    const hit = opts.providers.find((p) => p.provider === want.provider);
    if (!hit) {
      throw new Error(`unknown provider "${want.provider}" — this project offers: `
        + `${opts.providers.map((p) => p.provider).join(', ') || 'none'}`);
    }
    if (hit.blocked_reason) {
      throw new Error(`cannot pin provider "${want.provider}": ${hit.blocked_reason} — pickable here: `
        + `${pickable.map((p) => p.provider).join(', ') || 'none'}`);
    }
    out.provider = hit.provider;
  }
  if (want.model) {
    if (!out.provider) {
      throw new Error(`a model is per provider — pin the provider too (model "${want.model}" means `
        + `nothing without one; pickable providers here: ${pickable.map((p) => p.provider).join(', ') || 'none'})`);
    }
    const row = opts.providers.find((p) => p.provider === out.provider);
    if (!row.models.some((m) => m.key === want.model)) {
      throw new Error(`unknown model "${want.model}" on ${out.provider} — allowed here: `
        + `${row.models.map((m) => m.key).join(', ') || 'none'}`);
    }
    out.model = want.model;
  }
  if (want.mode !== null) {
    const { resolveMode } = await import('../queenzee/intake.js');
    const m = resolveMode(want.mode);          // throws "mode must be 1–5 (1=plan … 5=bypass)"
    out.mode = Number(want.mode);
    out.mode_key = m.key;
  }
  return Object.keys(out).length ? out : null;
}

// The block the router reads. ONE line of settings, marked as a decision rather than a hint, and
// only the fields that were actually configured — the router decides the rest under the policy
// snapshot above it.
function customDeploymentLines(custom) {
  if (!custom) return [];
  const bits = [];
  if (custom.provider) bits.push(`provider=${custom.provider}`);
  if (custom.model) bits.push(`model=${custom.model}`);
  if (custom.mode != null) bits.push(`mode=${custom.mode}${custom.mode_key ? ` (${custom.mode_key})` : ''}`);
  if (custom.harness) bits.push(`harness=${custom.harness}`);
  if (!bits.length) return [];
  return ['',
    'CUSTOM DEPLOYMENT (the human configured this — use these settings for the dispatch): '
      + bits.join(', '),
    'Anything not listed there is still yours to decide under the policy above.'];
}

// THE AUDIT ROW IS CAPPED; THE DELIVERY IS NOT. zee_message.body stores at most this many chars,
// and the CUSTOM DEPLOYMENT block sits AFTER the raw prompt — so a plain slice() would cut the
// human's explicit decision off the end of a long prompt and leave an audit trail saying they
// configured nothing, which is the opposite of what happened. The RAW PROMPT is what gives way
// instead: head (marker + policy snapshot) and tail (the decision) both survive, and the cut says
// so. Nothing here touches the router policy's own max_task_chars — that is the ceiling for the
// brief the ROUTER writes, and it rides in the snapshot untouched.
export const AUDIT_BODY_MAX = 20000;
const AUDIT_CUT = '\n… [prompt truncated in this audit row — the router was sent it in full]';
export function auditBody(head, prompt, tail = '') {
  const full = tail ? `${head}\n${prompt}\n${tail}` : `${head}\n${prompt}`;
  if (full.length <= AUDIT_BODY_MAX) return full;
  const room = AUDIT_BODY_MAX - head.length - tail.length - AUDIT_CUT.length - 2;
  if (room <= 0) return full.slice(0, AUDIT_BODY_MAX);   // head+tail alone overflow — nothing better to do
  return `${head}\n${prompt.slice(0, room)}${AUDIT_CUT}${tail ? `\n${tail}` : ''}`;
}

// ── route: POST /api/router/route — the composer's Dispatch button, with a router present ────
// Hands the RAW prompt to the live router as a 🧭 ROUTING REQUEST: the message carries the prompt
// VERBATIM plus a snapshot of the effective router policy, so the router always obeys the knobs
// as they are NOW, not as they were when it was briefed. Stored in zee_message (kind 'directive',
// the human→zee kind) for the same audit trail every crew conversation gets; delivery itself goes
// through sendMessageToXell so pasted images ride along as real files.
//
// `custom` is the composer's optional CUSTOM DEPLOYMENT panel (see resolveCustomDeployment): the
// human's explicit provider/model/mode/harness decision, rendered as its own block after the
// prompt. With none configured the body is byte-for-byte what it always was.
//
// IDEMPOTENCY (150): the composer is fire-and-forget — App.jsx runDispatch closes the modal and
// reports through a toast, and a double-click (or Cmd+Enter landing in the same tick) can fire
// onDispatch twice for ONE human action. Without a guard here that was two 🧭 ROUTING REQUEST
// messages for one prompt, and the router dispatched a worker for each: the double-deploy.
// `client_request_id` is the composer's per-composition key (stable across a double-submit); the
// FIRST call wins and records the key, and a SECOND call that names a key already recorded for
// the same project within the dedup window is refused LOUDLY — never silently dropped — so a
// human who genuinely wants to re-send can tell the refusal from the double-submit. The wall is
// the partial UNIQUE index on router_route_dedup (migration 150): two concurrent calls with the
// same key race there, and postgres lets exactly one through.
const ROUTE_DEDUP_WINDOW_MS = 60_000;   // the composer is one click; a window far larger than that
                                        // still cannot collide with a genuine later re-send.

// Prune the dedup ledger opportunistically (the window is short; a sweep on every route keeps the
// table from growing past ~a minute of routing traffic). Best-effort — a failed prune never
// refuses a route.
async function pruneRouteDedup(projectId) {
  try {
    await q(`DELETE FROM router_route_dedup WHERE project_id=$1 AND created_at < now() - ($2::int || ' seconds')::interval`,
      [projectId, Math.ceil(ROUTE_DEDUP_WINDOW_MS / 1000)]);
  } catch (e) { logline('router', `could not prune route-dedup ledger: ${e.message}`); }
}

export async function routeRawPrompt({ project, prompt, images = [], harness_hint = null,
                                       custom = null, by = 'human@console',
                                       client_request_id = null } = {}) {
  const projectId = await routerProjectId(project);
  const text = String(prompt || '').trim();
  if (!text && !(Array.isArray(images) && images.length)) throw new Error('a routing request needs a prompt');
  const status = await routerStatus(projectId);
  if (!status.present) throw new Error(NO_LIVE_ROUTER);
  const router = status.routers[0];

  // THE DEDUP GATE — one routing request per human action (150). Runs BEFORE any message is
  // written, so a refused duplicate costs nothing. A caller with no key is a caller outside the
  // composer (a CLI, a script, an MCP client): there is nothing to dedupe, and the route behaves
  // exactly as it always did.
  const key = String(client_request_id || '').trim();
  if (key) {
    await pruneRouteDedup(projectId);
    const prior = await one(
      `SELECT dm.message_id, dm.to_xell_id, m.body
         FROM router_route_dedup dm JOIN zee_message m ON m.id = dm.message_id
        WHERE dm.project_id=$1 AND dm.client_request_id=$2`, [projectId, key]);
    if (prior) {
      throw new Error(
        `this routing request (client_request_id "${key}") was already enqueued for ${router.slug} `
        + `a moment ago — it looks like a double-submit of ONE action, so it was not enqueued again. `
        + 'If you genuinely mean to send it a second time, re-open the composer (a fresh composition '
        + 'carries a fresh request id).');
    }
  }

  const policy = status.policy || {};
  const deployment = await resolveCustomDeployment(projectId, custom);
  const head = [
    `🧭 ROUTING REQUEST from ${by}`,
    '',
    `ROUTER POLICY (obey THIS snapshot over anything you remember): ${JSON.stringify(policy)}`,
    ...(status.scheduled_out.length
      ? [`Providers outside their schedule window right now (UTC): ${status.scheduled_out.join(', ')}`] : []),
    ...(harness_hint
      ? [`The human opened the composer from the "${harness_hint}" persona button — a HINT, not a decision; you pick the harness.`] : []),
    '',
    '── RAW PROMPT (recompose per your manual, then dispatch) ──',
  ].join('\n');
  const tail = customDeploymentLines(deployment).join('\n');
  const body = tail ? `${head}\n${text}\n${tail}` : `${head}\n${text}`;

  // The audit row first (kind 'directive' — the human→zee kind zee_message already knows), then
  // the real delivery, then the row corrected with what actually happened — the same shape as
  // managers.postMessage, carried here because a routing request also has IMAGES to deliver.
  //
  // ATOMICITY of the message row and the dedup ledger row. The message insert and the dedup insert
  // run on ONE client inside ONE transaction: a concurrent call with the same key either (a) sees
  // the committed ledger row at its pre-check and is refused before writing anything, or (b) races
  // our transaction, in which case the ledger's UNIQUE index refuses its insert and ITS transaction
  // rolls its message back. Either way exactly one message row survives for one key — the duplicate
  // is never left in zee_message. A non-key path (no client_request_id) skips the ledger entirely
  // and is a plain single insert, byte-for-byte what it always was.
  const row = await (async () => {
    if (!key) {
      return one(
        `INSERT INTO zee_message (project_id, from_xell_id, from_slug, to_xell_id, to_slug, kind, body, meta)
         VALUES ($1, NULL, $2, $3, $4, 'directive', $5, $6::jsonb) RETURNING *`,
        [projectId, by, router.xell_id, router.slug, auditBody(head, text, tail),
         JSON.stringify({ by, routing_request: true,
                          ...(deployment ? { custom_deployment: deployment } : {}) })]);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const run = async (text, params) => (await client.query(text, params)).rows;
      const [msg] = await run(
        `INSERT INTO zee_message (project_id, from_xell_id, from_slug, to_xell_id, to_slug, kind, body, meta)
         VALUES ($1, NULL, $2, $3, $4, 'directive', $5, $6::jsonb) RETURNING *`,
        [projectId, by, router.xell_id, router.slug, auditBody(head, text, tail),
         JSON.stringify({ by, routing_request: true, client_request_id: key,
                          ...(deployment ? { custom_deployment: deployment } : {}) })]);
      await run(
        `INSERT INTO router_route_dedup (project_id, to_xell_id, client_request_id, message_id)
         VALUES ($1,$2,$3,$4)`,
        [projectId, router.xell_id, key, msg.id]);
      await client.query('COMMIT');
      return msg;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      // A UNIQUE violation on the ledger means a concurrent call with the same key won — its
      // transaction committed, its message row is the one that stands. Our transaction rolled back,
      // so nothing of ours survives; refuse LOUDLY, exactly as the pre-insert gate would have.
      if (e?.code === '23505') {
        throw new Error(
          `this routing request (client_request_id "${key}") was already enqueued for ${router.slug} `
          + `a moment ago — it looks like a double-submit of ONE action, so it was not enqueued again. `
          + 'If you genuinely mean to send it a second time, re-open the composer (a fresh composition '
          + 'carries a fresh request id).');
      }
      throw e;
    } finally { client.release(); }
  })();
  const { sendMessageToXell } = await import('../queenzee/nudge.js');
  const delivery = await sendMessageToXell(router.xell_id, { text: body, images, by, messageId: row.id });
  await q(
    `UPDATE zee_message SET delivered=$2, delivery=$3::jsonb
      WHERE id=$1 AND NOT COALESCE((delivery->>'undelivered')::boolean, false)`,
    [row.id, !!delivery.sent, JSON.stringify(delivery)]);
  broadcast('zee-message', { id: row.id, to_xell_id: router.xell_id, from_xell_id: null, kind: 'directive' });
  logline('router', `routing request → ${router.slug}: ${text.replace(/\s+/g, ' ').slice(0, 120)}`
    + (deployment ? ` [custom: ${Object.entries(deployment).filter(([k]) => k !== 'mode_key').map(([k, v]) => `${k}=${v}`).join(' ')}]` : '')
    + (delivery.sent ? ` [${delivery.delivery || 'delivered'}]` : ` [not delivered: ${delivery.reason || delivery.error || '—'}]`));
  return { ok: true, routed: true, router: { xell_id: router.xell_id, slug: router.slug },
           message_id: row.id, delivered: !!delivery.sent, delivery,
           // What was actually pinned, as RESOLVED — the console echoes the human's decision back
           // rather than the raw form fields it sent.
           custom_deployment: deployment };
}

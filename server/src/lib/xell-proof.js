// PROVISION PROOF — the xell-level burn-in: prove the chips before a zee is handed them.
// docs/provision-proof-plan.md §4.1 + docs/provision-proof-kit/stage-1-proof-machinery.md.
//
// THE GAP THIS CLOSES: a pooled xell is stamped status='ready' the moment its row is inserted,
// and nothing ever proves the chips it claims. The db preflight (#53) opens the projected DSN but
// gates nothing; no app tier is ever built before a zee's first `zee build` (TKT-178 address-pool
// exhaustion, TKT-85 clone-db port collisions); and the binding can change after the only preflight
// ran (dispatch-time attach/clone re-point the DSN — #47/TKT-181). All three pass every static
// check and surface only on a real build/up/probe, on the ZEE's clock, after dispatch.
//
// So proveXell performs the SAME act a zee would perform — the real build, the real `up`, the real
// port probe, the real `SELECT 1` — on the POOL's clock, before the xell can be claimed:
//
//   1. db-open            — DELEGATE to preflightXell (lib/preflight.js). Its contract is "never
//                           writes to what it checks", and this module BUILDS — that is WHY they are
//                           separate modules. Its skip semantics (prod never opened, db-less
//                           couplings skipped-with-reason) ride through unchanged.
//   2. app-build:<role>   — for each buildable role (server/webapp, exactly as build.js BUILDABLE):
//                           invoke the SAME build path `zee build` takes (lib/build.js →
//                           build-container.sh with the meta-DB's recorded compose/env/port facts).
//                           Whatever a project's build is — generated compose, own compose,
//                           `runner: process` — the proof exercises the one path the zee will use,
//                           so proof and reality cannot drift. A `runner: process` role has NO
//                           container build: SKIPPED with the reason (its worktree warm + db-open
//                           carry the value there).
//   3. app-serve:<role>   — the container is up AND the published port answers (probePublishedRole,
//                           the same fact serving_head already requires, build.js:586).
//
// Each failure is classified with the existing classifyBuildFailure (migration 233): the INFRA |
// CODE class rides on the check — it decides ROUTING later (plan §4.6), never the verdict.
//
// THE PROOF IS EVIDENCE-DERIVED, VERDICT-STAMPED — same pattern as preflight: the authoritative
// facts stay where they already live (container.last_build_commit, health, last_build_error,
// last_build_error_class); the xell row carries the stamped summary (proof_at, proof_error,
// proof_checks, proof_commit).
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   • It never refuses a claim/dispatch/spawn — that is stage 2 (the `required` gate), a different
//     landing. This stage is EVIDENCE + SURFACING only.
//   • It never throws. A proof that can fail its caller would be a new way to fail provisioning,
//     which is a worse bug than the one it exists to catch.
//   • It never runs under simulate: BUILD_MODE=simulate or PROVISION_MODE≠real → prove nothing,
//     stamp nothing. A nested queenzee must never build real containers or record fake green.
import { q, one } from '../db/pool.js';
import { broadcast } from '../lib/events.js';
import { logline } from '../lib/logbus.js';
import { headCommit } from '../lib/git.js';
import { preflightXell } from './preflight.js';
import { buildXell, getBuildStatus, classifyBuildFailure } from './build.js';
import { probePublishedRole, publishedUrl } from '../queenzee/containers.js';

// One proof may take minutes (a docker build on a cold worktree). Bounded so a wedged daemon can
// never pin a proof forever — a proof that hangs is worse than none, the same rule preflight states.
export const PROOF_TIMEOUT_MS = 10 * 60 * 1000;      // 10 minutes
const SETTLE_POLL_MS = 3000;

// A proof only runs when the whole chain is REAL. build.js keys on BUILD_MODE; pool.js keys on
// PROVISION_MODE. If either is simulate, proving would either build real containers against a
// simulated row (wrong) or record a fake green (worse) — so the proof needs both real.
const PROOF_MODE = (process.env.BUILD_MODE === 'simulate' || process.env.PROVISION_MODE !== 'real')
  ? 'simulate' : 'real';

const pass = (check, detail, cls = null) => ({ check, ok: true, skipped: false, detail, class: cls });
const fail = (check, detail, cls = null) => ({ check, ok: false, skipped: false, detail, class: cls });
const skip = (check, detail) => ({ check, ok: true, skipped: true, detail, class: null });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Is this role a `runner: process` row — a bare process started in the worktree (spec §6.1), not a
// docker container build? The row is the truth (build.js: "THE ROW OUTRANKS THE MANIFEST"): a row
// with no image_tag AND no docker_ctx is a process row; the manifest's runner also marks it for a
// pre-naming row that has an image_tag but a process manifest.
function isProcessRole(c, manifest) {
  if (!c) return false;
  const runner = manifest?.roles?.[c.role]?.runner || manifest?.tiers?.spinoff?.runner || null;
  return (!c.image_tag && !c.docker_ctx) || (runner === 'process' && !c.image_tag);
}

// The buildable roles of a xell, matching what `zee build` can actually build (build.js BUILDABLE =
// server + webapp). The manifest may declare other roles buildable (manifest.js defaults buildable
// to role !== 'db'), but there is no build path for them — so the proof covers the roles the zee
// could ever build, and nothing else.
const BUILDABLE_ROLES = ['server', 'webapp'];

// Wait for every container to settle (leave 'building'), bounded by the proof timeout. A build that
// never settles is reported by the caller as a failed app-build check — never thrown here.
async function waitForSettle(xellId, timeoutMs, status) {
  const deadline = Date.now() + timeoutMs;
  let st = await status(xellId);
  while (st.building && Date.now() < deadline) {
    await sleep(SETTLE_POLL_MS);
    st = await status(xellId);
  }
  return st;
}

// Stamp the verdict on the xell row — the notePreflight pattern: evidence stays on the container
// rows, the xell gets the summary. Never throws, and never lets bookkeeping about a proof become a
// second way for the proof to fail. Broadcasts only when the ERROR STATE changes, so a fleet-wide
// sweep of healthy proofs is silent on the stream.
export async function noteProof(xellId, verdict) {
  try {
    const prev = await one(`SELECT proof_error FROM xell WHERE id=$1`, [xellId]);
    if (!prev) return verdict;
    const row = await one(
      `UPDATE xell SET proof_at = now(), proof_error = $2, proof_checks = $3::jsonb, proof_commit = $4
        WHERE id=$1 RETURNING *`,
      [xellId, verdict.error || null, JSON.stringify(verdict.checks || []), verdict.commit || null]);
    if (row && (prev.proof_error || null) !== (verdict.error || null)) broadcast('xell', row);
  } catch { /* the proof itself matters more than the note about it */ }
  return verdict;
}

// The proof verdict → the machine×project record fact (plan §4.6). PURE — exported for tests and
// for the pool queue, which persists it into build_readiness_record.
//
//   ok (all checks green)                 → 'ok'   — the (machine, project) pair works.
//   any failed check classed INFRA        → 'missing' — the fault is the pair's, not the xell's:
//                                          address pools, daemon down, context missing, port bind
//                                          refused. The pool stops filling the pair; proofs skip.
//   any failed check with no class        → 'unknown' — db-open, a settle timeout, an error that
//                                          did not classify: we could not tell, and that is never green.
//   CODE-only failures                    → 'ok'   — the machine CAN build (a CODE failure proves
//                                          infra works); the broken code is a PROJECT fact, carried
//                                          by proof_error (§4.6 CODE).
export function buildReadinessRecordFromProof(verdict) {
  if (!verdict) return null;
  if (verdict.ok) return { status: 'ok', error: null, checks: verdict.checks || [] };
  const failed = (verdict.checks || []).filter((c) => !c.ok && !c.skipped);
  const infra = failed.find((c) => c.class === 'INFRA');
  if (infra) return { status: 'missing', error: `${infra.check}: ${infra.detail}`, checks: verdict.checks || [] };
  const unknown = failed.some((c) => c.class == null);
  return unknown
    ? { status: 'unknown', error: verdict.error, checks: verdict.checks || [] }
    : { status: 'ok', error: null, checks: verdict.checks || [] };
}

// THE BURN-IN — one xell's chips, proven on the pool's clock. Never throws.
//
// opts:
//   roles        — restrict which buildable roles to prove (default ['server','webapp']).
//   timeoutMs    — the whole settle budget (default PROOF_TIMEOUT_MS).
//   mode         — 'real' proves; anything else is a full no-op (default: the module PROOF_MODE,
//                  which is 'real' only when BUILD_MODE≠simulate AND PROVISION_MODE=real).
//   deps         — injection seam for tests: { preflight, buildXell, getBuildStatus,
//                  probePublishedRole, headCommit }. Defaults are the real modules.
//
// Returns { ok, error, checks: [{check, ok, skipped, detail, class}], commit, at }.
export async function proveXell(xellId, {
  roles = null,
  timeoutMs = PROOF_TIMEOUT_MS,
  mode = PROOF_MODE,
  deps = {},
} = {}) {
  const at = new Date().toISOString();
  const {
    preflight = preflightXell,
    build = buildXell,
    status = getBuildStatus,
    probe = probePublishedRole,
    commitOf = headCommit,
  } = deps;

  // SIMULATE: prove nothing, stamp nothing. The no-op is itself a verdict (skipped, with the
  // reason) so a caller that forwards it never crashes — but it is NOT stamped on the xell.
  if (mode !== 'real') {
    return {
      ok: true, error: null,
      checks: [{ check: 'simulate', ok: true, skipped: true,
                 detail: 'simulate mode — proof machinery disabled, nothing stamped', class: null }],
      commit: null, at,
    };
  }

  try {
    const xell = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
    if (!xell) {
      return { ok: false, error: 'no such xell',
               checks: [{ check: 'db-open', ok: false, skipped: false, detail: 'no such xell', class: null }],
               commit: null, at };
    }
    const project = await one(`SELECT manifest FROM project WHERE id=$1`, [xell.project_id]);
    const manifest = project?.manifest || {};
    const want = roles || BUILDABLE_ROLES;

    const checks = [];

    // ── 1. db-open — DELEGATE to the pure preflight (never duplicated here) ────────────────
    const pf = await preflight(xellId);
    const dbChecks = (pf.checks || []).filter((c) => c.check === 'db-open');
    if (dbChecks.length) {
      for (const c of dbChecks) checks.push({ ...c, class: null });
    } else {
      checks.push(fail('db-open', pf.error || 'preflight produced no db-open check'));
    }

    // The buildable container rows of this xell.
    const containers = await q(
      `SELECT * FROM container WHERE owner_xell_id=$1 AND role = ANY($2) ORDER BY role`,
      [xellId, want]);

    // ── 2. app-build:<role> — kick off the real build (same path `zee build` takes) ─────────
    // A role already UP with a successful prior build AND a serving published port is already
    // proven (a backfilled xell that was claimed/built/returned) — no redundant rebuild. Every
    // other non-process role gets the burn-in.
    const toBuild = [];
    for (const c of containers) {
      if (isProcessRole(c, manifest)) continue;                    // process: skip (no container build)
      const st = await status(xellId);
      const cur = st.containers.find((x) => x.role === c.role);
      if (cur && cur.health === 'up' && !cur.last_build_error && cur.published_health === 'up') continue;
      toBuild.push(c.role);
    }
    for (const role of toBuild) {
      try {
        await build(xellId, { role });
      } catch (e) {
        // "already building" is fine — the settle loop below waits for that build. Any other throw
        // is surfaced as a failed app-build check, never thrown out of proveXell.
        logline('proof', `prove ${xell.slug}: build kick for ${role}: ${e.message}`);
      }
    }

    // Wait for every build to settle (bounded).
    const settled = await waitForSettle(xellId, timeoutMs, status);

    // ── 2 (verdict) + 3. app-build / app-serve per role ────────────────────────────────────
    for (const c of containers) {
      const after = settled.containers.find((x) => x.role === c.role);
      const name = c.role;

      if (isProcessRole(c, manifest)) {
        checks.push(skip(`app-build:${name}`,
          'runner:process has no container build — the worktree warm and db-open carry the value here'));
      } else if (after && after.health === 'up' && !after.last_build_error) {
        checks.push(pass(`app-build:${name}`, `built @ ${after.last_build_commit || 'unknown'} (${after.health})`));
      } else if (after && after.health === 'building') {
        checks.push(fail(`app-build:${name}`,
          `build did not settle within ${timeoutMs}ms — still building (see container row)`));
      } else {
        const detail = after?.last_build_error || 'build failed (container down)';
        checks.push(fail(`app-build:${name}`, detail, classifyBuildFailure(detail)));
      }

      const url = publishedUrl(after || c);
      let published;
      try {
        published = await probe(after || c);
      } catch (e) {
        published = 'unknown';
        checks.push(fail(`app-serve:${name}`, `probe failed: ${e.message}`));
        continue;
      }
      if (published === 'up') checks.push(pass(`app-serve:${name}`, `published port answers (${url || 'no url'})`));
      else checks.push(fail(`app-serve:${name}`, `published port ${published} — ${url || 'no url recorded'}`));
    }

    const failed = checks.filter((c) => !c.ok);
    let commit = null;
    if (xell.worktree_path) {
      try { commit = commitOf(xell.worktree_path, 'HEAD'); } catch { /* advisory — never a proof failure */ }
    }
    const verdict = {
      ok: !failed.length,
      error: failed.length ? failed.map((c) => `${c.check}: ${c.detail}`).join(' · ') : null,
      checks,
      commit,
      at,
    };
    await noteProof(xellId, verdict);
    if (!verdict.ok) logline('proof', `${xell.slug}: NOT PROVEN — ${verdict.error}`);
    else logline('proof', `${xell.slug}: proven ✓ (${checks.filter((c) => !c.ok && !c.skipped).length} failed / ${checks.length} checks, @ ${commit ? commit.slice(0, 8) : '?'})`);
    return verdict;
  } catch (e) {
    const verdict = { ok: false, error: `proof: ${e.message}`,
                      checks: [{ check: 'proof', ok: false, skipped: false, detail: e.message, class: null }],
                      commit: null, at };
    await noteProof(xellId, verdict).catch(() => {});
    return verdict;
  }
}

// THE LANDING PAD — one chronological queue for everything the queenzee lands or ships.
//
// Landings (a push to main) and shipments (a deploy to prod) used to be two independent lanes:
// each was processed the instant a human approved it, in its own order, with no shared notion of
// "what is the queenzee working on right now". That is fine until two of them want the queenzee at
// once — then a ship and a landing race, and nobody watching can say which is being worked or what
// is waiting behind it.
//
// The landing pad makes them ONE runway. Every open landing and shipment is listed in the order it
// arrived (by requested_at — the chronological FIFO), and the queenzee processes the queue strictly
// first-in-first-out: exactly ONE item is "on the pad" (being processed) at a time, the rest wait
// their turn, and the item on the pad shows a spinner until it lands/ships or fails.
//
// Division of labour is unchanged: a HUMAN still approves each landing/ship (nothing here bypasses
// the land gate or the ship gate). The pad only decides the ORDER and the ONE-AT-A-TIME in which
// the queenzee acts on the things a human already approved.
import { q, one } from '../db/pool.js';
import { logline } from '../lib/logbus.js';

// Escape hatch: LANDING_PAD_ENABLED=false restores the old behaviour (each approval processed
// immediately, no cross-lane ordering). The gate helpers below then always answer "go".
const ENABLED = process.env.LANDING_PAD_ENABLED !== 'false';

// How long a finished item lingers on the pad as a receipt before it drops off the list.
const RECEIPT_MIN = 5;

// ── the read model the UI renders ─────────────────────────────────────────────
// Merge open (and just-finished) landings + shipments into ONE list, oldest-first, and label each
// with the phase the pad cares about:
//   awaiting-approval — a human has not decided yet (NOT the queenzee's to process)
//   queued            — approved, waiting its turn on the runway
//   processing        — on the pad right now (spinner)
//   done/failed/…     — a receipt, kept briefly
export async function buildLandingPad(projectId) {
  const pid = projectId || (await one(`SELECT id FROM project ORDER BY created_at LIMIT 1`))?.id;
  if (!pid) return { items: [], processing: null, next: null, active: 0, enabled: ENABLED };

  const landings = await q(
    `SELECT lr.id, lr.xell_id, x.slug AS xell_slug, lr.status, lr.requested_at, lr.decided_at,
            lr.landed_at AS finished_at, lr.new_sha AS sha, lr.ref, lr.commits
       FROM land_request lr LEFT JOIN xell x ON x.id = lr.xell_id
      WHERE lr.project_id = $1 AND lr.dismissed_at IS NULL
        AND (lr.status IN ('pending','approved')
          OR (lr.status IN ('landed','rejected','stale')
              AND COALESCE(lr.landed_at, lr.decided_at) > now() - ($2 || ' minutes')::interval))`,
    [pid, String(RECEIPT_MIN)]);

  const ships = await q(
    `SELECT s.id, s.xell_id, x.slug AS xell_slug, s.status, s.requested_at, s.decided_at,
            s.finished_at, s.commit AS sha, s.reason
       FROM ship_request s JOIN xell x ON x.id = s.xell_id
      WHERE s.project_id = $1 AND s.dismissed_at IS NULL
        AND (s.status IN ('pending','approved','shipping')
          OR (s.status IN ('shipped','failed')
              AND COALESCE(s.finished_at, s.decided_at) > now() - ($2 || ' minutes')::interval))`,
    [pid, String(RECEIPT_MIN)]);

  // A landing's ref-move is near-instant, so "processing" for a landing is the brief window it holds
  // the merge lock. Catch it so the spinner is honest even for that flash.
  const merging = new Set(
    (await q(`SELECT xell_id FROM deploy_lock WHERE project_id=$1 AND container='land'`, [pid]))
      .map((l) => l.xell_id));

  return { ...composePad({ landings, ships, merging }), enabled: ENABLED };
}

// The PURE transform behind buildLandingPad: merge landing + ship rows, label each with its runway
// phase, sort chronologically (FIFO), number the in-flight ones, and flag what is on the pad now /
// next up. Split out from the DB fetch so the ordering rules can be exercised without a database
// (server/db tiers don't run for Zeehive's own self-spinoffs). `merging` is the set of xell_ids
// currently holding the land merge lock (a landing mid ref-move).
export function composePad({ landings = [], ships = [], merging = new Set() }) {
  const phaseOf = (r, kind) => {
    if (r.status === 'pending') return 'awaiting-approval';
    if (kind === 'landing') {
      if (r.status === 'approved') return merging.has(r.xell_id) ? 'processing' : 'queued';
      if (r.status === 'landed') return 'done';
      return r.status;                 // rejected | stale
    }
    if (r.status === 'approved') return 'queued';
    if (r.status === 'shipping') return 'processing';
    if (r.status === 'shipped') return 'done';
    return r.status;                   // failed
  };

  const norm = (r, kind) => {
    const phase = phaseOf(r, kind);
    return {
      kind, id: r.id, xell_id: r.xell_id, xell_slug: r.xell_slug || 'unknown', status: r.status, phase,
      processing: phase === 'processing',
      sha: r.sha || null, ref: r.ref || null, reason: r.reason || null,
      commits: Array.isArray(r.commits) ? r.commits.length : null,
      requested_at: r.requested_at, decided_at: r.decided_at, finished_at: r.finished_at,
    };
  };

  const items = [...landings.map((r) => norm(r, 'landing')), ...ships.map((r) => norm(r, 'shipment'))]
    .sort((a, b) => new Date(a.requested_at) - new Date(b.requested_at));

  // FIFO position, numbered over the things still IN the runway (not the receipts).
  const inFlight = new Set(['awaiting-approval', 'queued', 'processing']);
  let pos = 0;
  for (const it of items) it.position = inFlight.has(it.phase) ? (pos += 1) : null;

  const processing = items.find((it) => it.phase === 'processing') || null;
  // What the queenzee will pick up next: the oldest queued item, but only while nothing is on the
  // pad (a spinner already answers "what's next" when something is processing).
  let next = null;
  if (!processing) { next = items.find((it) => it.phase === 'queued') || null; if (next) next.next = true; }

  const active = items.filter((it) => inFlight.has(it.phase)).length;
  return { items, processing, next, active };
}

// ── the FIFO gate the two lanes consult ───────────────────────────────────────
// Is the runway occupied? (a ship mid-build, or a landing mid-merge). When busy, the pad holds
// everything else back so exactly one thing is processed at a time.
async function padBusy(projectId) {
  const shipping = await q(`SELECT 1 FROM ship_request WHERE project_id=$1 AND status='shipping' LIMIT 1`, [projectId]);
  if (shipping.length) return true;
  const merging = await q(`SELECT 1 FROM deploy_lock WHERE project_id=$1 AND container='land' LIMIT 1`, [projectId]);
  return merging.length > 0;
}

// The single oldest APPROVED item across both lanes — the one whose turn it is. Pending items are
// waiting on a human, not the queenzee, so they never gate processing (a younger approved item is
// free to go ahead of an older un-approved one).
async function headOfLine(projectId) {
  const rows = await q(
    `SELECT kind, id, requested_at FROM (
        SELECT 'landing'::text AS kind, id, requested_at FROM land_request
          WHERE project_id=$1 AND status='approved' AND dismissed_at IS NULL
        UNION ALL
        SELECT 'shipment'::text AS kind, id, requested_at FROM ship_request
          WHERE project_id=$1 AND status='approved' AND dismissed_at IS NULL
     ) pad ORDER BY requested_at ASC LIMIT 1`, [projectId]);
  return rows[0] || null;
}

// The land gate / ship gate call this before they act on an approval. 'go' = it is this item's turn
// and the pad is free; 'wait' = something is on the pad, or an earlier item is ahead in line. When
// the pad is disabled this always answers 'go' (old behaviour: process on approval).
export async function shouldProcessNow(projectId, kind, id) {
  if (!ENABLED) return 'go';
  if (await padBusy(projectId)) return 'wait';
  const head = await headOfLine(projectId);
  if (!head) return 'go';                                  // nothing queued — nothing to wait behind
  return head.kind === kind && head.id === id ? 'go' : 'wait';
}

// ── the driver: pull the next item onto the pad ───────────────────────────────
// Runs on a tick, and after every approval/completion, so the runway drains promptly. It processes
// exactly the head of the line, and only when the pad is free — the same FIFO the gate enforces,
// but this is the half that keeps the queue MOVING (a landing queued behind a finished ship still
// needs someone to pick it up). Dynamic imports keep this module free of a static cycle with the
// two lanes it drives.
export async function processPad(projectId) {
  if (!ENABLED) return { disabled: true };
  if (await padBusy(projectId)) return { busy: true };
  const head = await headOfLine(projectId);
  if (!head) return { idle: true };
  try {
    if (head.kind === 'landing') {
      const { landApproved } = await import('./landgate.js');
      const row = await one(`SELECT * FROM land_request WHERE id=$1`, [head.id]);
      if (row && row.status === 'approved') await landApproved(row);
    } else {
      const { runShip } = await import('./shipgate.js');
      await runShip(head.id);
    }
  } catch (e) {
    logline('pad', `processing ${head.kind} ${String(head.id).slice(0, 8)} failed: ${e.message}`);
  }
  return { started: head };
}

export function startLandingPad() {
  if (!ENABLED) { console.log('[queenzee] landing pad DISABLED (LANDING_PAD_ENABLED=false)'); return; }
  const interval = Number(process.env.LANDING_PAD_TICK_MS) || 4000;
  setInterval(async () => {
    try {
      const projects = await q(`SELECT id FROM project`);
      for (const p of projects) await processPad(p.id).catch(() => {});
    } catch (e) { console.error('[landingpad] tick:', e.message); }
  }, interval);
  console.log(`[queenzee] landing pad started (${interval}ms) — FIFO landing/ship processing`);
}

// READ-ONLY PRODUCTION LOGS for ANY zee — the log, and nothing else that lives in the container.
//
// A caged zee ships code to production and then cannot see what that code SAID when it ran. The
// evidence it needs is one stream — the prod app tier's stdout/stderr — and every existing door to
// it hands over far more than that: `zee prod` binds the whole live database, the console's
// container terminal is an exec (a shell), and the file explorer reads the container's filesystem.
// None of those is "let me read the log", and none of them should be the price of reading one.
//
// So this is the narrow door, and NARROW IS THE DESIGN:
//
//   • A CALLER NAMES A ROLE, NEVER A CONTAINER. The container is resolved server-side from the
//     CALLING xell's own project (token → xell → project → tier='prod' rows). There is no
//     parameter anywhere in this module that can point it at a container the caller's project does
//     not own, and no id/name/context the caller supplies is ever dialed.
//   • THE ONLY DOCKER CALLS ARE READS OF THE LOG (docker.js containerLogTail: inspect for the
//     framing, then GET /containers/<name>/logs with follow=0). No exec, no attach, no
//     start/stop/restart, no filesystem. A zee cannot run anything in production through here.
//   • THE DB ROLE IS EXCLUDED. A postgres log echoes statement text — that is production ROW DATA,
//     and production data has its own human gate (`zee prod` / `zee seed`). The readable roles are
//     exactly the roles a zee can SHIP (server, webapp): you may read the log of the thing you can
//     deploy, and nothing else.
//   • EVERY LINE IS REDACTED before it leaves the queenzee. An app log is the most reliable place
//     in the fleet to find a credential someone printed by accident (a DSN with its password, an
//     Authorization header, a vendor key). The masking below is the reason this verb can be open to
//     every zee instead of being a manager's privilege.
//   • THE ANSWER CARRIES NO WAY IN. Role, container name, state, the deployed sha and the lines —
//     never the docker context, the daemon endpoint, the host, the container id or the image.
//   • Bounded: a line count with a hard ceiling, a byte cap while reading, a request timeout.
//     Nothing follows/streams, so a zee cannot hold a connection open on a production daemon.
//
// PRODLOGS_MODE=simulate (inherited from SHIP_MODE when unset, exactly like PRODRO_MODE in
// prod-readonly.js) dials NOTHING. A nested queenzee runs against a CLONE of the real meta-DB —
// real container names, real docker contexts — so an ungated read here would let a xell's own
// subject-under-test reach the real production daemons (docs/nested-queenzee-containment.md, the
// open half of ticket #27). It refuses with the reason instead, and the sources list still works.
import { q, one } from '../db/pool.js';
import { containerLogTail } from './docker.js';

export const PRODLOGS_MODE = (process.env.PRODLOGS_MODE || process.env.SHIP_MODE || 'real') === 'simulate'
  ? 'simulate' : 'real';

// The roles a zee may read. Deliberately the SHIPPABLE set (shipgate.js): the log of what you can
// deploy. 'db' is absent on purpose (row data), and so are 'infra'/'device' (not a zee's code).
export const LOGGABLE_ROLES = ['server', 'webapp'];

export const DEFAULT_TAIL = 200;
export const MAX_TAIL = 1000;
export const MAX_LINE_CHARS = 2000;
export const MAX_READ_BYTES = 1 << 20;     // 1 MiB off the daemon, then truncated:true

// ── REDACTION ─────────────────────────────────────────────────────────────────────────────────
// Ordered, and each rule keeps enough of the line to stay readable (the KEY survives, the VALUE
// does not). This list is DATA: a new credential shape is one row here, not a new code path.
// It is a mask, not a guarantee of purity — a log line that prints a secret with no recognisable
// shape at all cannot be matched by anything. That is why the roles above are narrowed too: the
// two mechanisms are layers, not alternatives.
const REDACTIONS = [
  // a DSN's password: postgres://user:pw@host, redis://…, amqp://… (the user stays — it is not the secret)
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s/@]+)@/gi, (_m, scheme, user) => `${scheme}${user}:***@`],
  // Authorization: Bearer <token> / Basic <blob>
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_m, kind) => `${kind} ***`],
  // key=value / "key": "value" / key: value, for anything that names itself a credential
  [/\b(pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|auth[_-]?token|dsn|conn[_-]?pw)(["']?\s*[:=]\s*["']?)([^\s,;"'&)}\]]+)/gi,
    (_m, key, sep) => `${key}${sep}***`],
  // JWTs, which are their own giveaway
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, 'eyJ***'],
  // vendor key shapes that are secrets wherever they appear
  [/\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|AIza[A-Za-z0-9_-]{20,})/g, '***'],
];

// Mask one line. Returns the line and whether anything was masked, so the answer can TELL the
// reader that redaction happened (a silently altered log is worse than a marked one).
export function redactLogLine(line) {
  let out = String(line ?? '');
  let redacted = false;
  for (const [re, rep] of REDACTIONS) {
    const next = out.replace(re, rep);
    if (next !== out) redacted = true;
    out = next;
  }
  return { line: out, redacted };
}

// "30m" / "2h" / "1d" / "900" (seconds) / an ISO timestamp → a unix timestamp for docker's `since`.
// Null (no window) when absent or unparseable — a bad --since must not silently become "everything
// since the epoch minus something": it becomes "no window", which is what the tail cap already is.
export function sinceToUnix(since, now = Date.now()) {
  const raw = String(since ?? '').trim();
  if (!raw) return null;
  const rel = /^(\d+)\s*([smhd])$/i.exec(raw);
  if (rel) {
    const mult = { s: 1, m: 60, h: 3600, d: 86400 }[rel[2].toLowerCase()];
    return Math.floor(now / 1000) - Number(rel[1]) * mult;
  }
  if (/^\d+$/.test(raw)) return Math.floor(now / 1000) - Number(raw);     // bare number = seconds ago
  const t = Date.parse(raw);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

// Clamp the line count a caller asked for into [1, MAX_TAIL].
export function clampTail(tail) {
  const n = Number.parseInt(tail, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TAIL;
  return Math.min(n, MAX_TAIL);
}

// Raw docker log text → the lines this verb returns: split, drop blanks, keep the LAST `tail`,
// optional plain (never regex — a caller-supplied pattern is not worth a ReDoS on the queenzee)
// case-insensitive substring filter, per-line length cap, then redaction.
export function formatLogLines(text, { tail = DEFAULT_TAIL, grep = null } = {}) {
  const needle = grep ? String(grep).toLowerCase() : null;
  const all = String(text ?? '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  const matched = needle ? all.filter((l) => l.toLowerCase().includes(needle)) : all;
  const kept = matched.slice(-tail);
  let redactions = 0;
  const lines = kept.map((l) => {
    const capped = l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}… [line truncated]` : l;
    const { line, redacted } = redactLogLine(capped);
    if (redacted) redactions++;
    return line;
  });
  return { lines, redactions, scanned: all.length, matched: matched.length };
}

// The PRODUCTION containers of ONE project whose logs are readable, newest-built first. The query
// IS the wall: project_id comes from the caller's own xell, tier is 'prod' and role is in the
// LOGGABLE_ROLES list. Nothing a caller sends reaches it.
export async function prodLogSources(projectId) {
  const rows = await q(
    `SELECT c.role::text AS role, c.name, c.health::text AS health, c.docker_ctx,
            c.last_build_commit, c.last_seen_at, ds.key AS site
       FROM container c
       LEFT JOIN deploy_site ds ON ds.id = c.site_id
      WHERE c.project_id = $1 AND c.tier = 'prod' AND c.role = ANY($2)
      ORDER BY c.role, c.name`,
    [projectId, LOGGABLE_ROLES]);
  return rows;
}

// What a zee sees ABOUT a source. The docker context is read (the queenzee needs it to dial) but
// never published — an answer that named the daemon would be a map to the door this verb exists to
// keep shut.
function publicSource(row) {
  return {
    role: row.role,
    container: row.name,
    site: row.site || null,
    health: row.health || null,
    deployed_commit: row.last_build_commit ? String(row.last_build_commit).slice(0, 10) : null,
  };
}

// The tail of production's log for ONE role of ONE project. `projectId` is the CALLER'S project,
// resolved from its token by the route — never a parameter a zee chooses.
export async function prodLogTail(projectId, {
  role = null, tail = DEFAULT_TAIL, since = null, grep = null, container = null,
} = {}) {
  const sources = await prodLogSources(projectId);
  const project = await one(`SELECT name FROM project WHERE id=$1`, [projectId]);
  const available = sources.map(publicSource);
  if (!sources.length) {
    return { ok: false, project: project?.name || null, sources: [],
      error: `no PRODUCTION container is modelled for ${project?.name || 'this project'} in the roles a zee may read `
        + `(${LOGGABLE_ROLES.join(', ')}). Nothing to read — this is a fact about the project's deploy `
        + `topology, not a refusal.` };
  }
  if (!role) {
    return { ok: true, project: project?.name || null, mode: PRODLOGS_MODE, sources: available,
      note: `read-only production logs. Name a role to read one: \`zee prod-logs <role>\` `
        + `(${[...new Set(sources.map((s) => s.role))].join(' | ')}). The DATABASE is not readable here — `
        + 'a postgres log carries production row data, which is the `zee prod` / `zee seed` gate.' };
  }
  const wanted = String(role).toLowerCase();
  if (!LOGGABLE_ROLES.includes(wanted)) {
    return { ok: false, project: project?.name || null, sources: available,
      error: `'${wanted}' is not a readable role. A zee may read the log of what it can SHIP `
        + `(${LOGGABLE_ROLES.join(', ')}). The prod DATABASE is deliberately not here: its log carries `
        + 'row data, and production data goes through `zee prod` / `zee seed`, which a human decides.' };
  }
  const matching = sources.filter((s) => s.role === wanted
    && (!container || s.name === String(container)));
  if (!matching.length) {
    return { ok: false, project: project?.name || null, sources: available,
      error: container
        ? `no production ${wanted} container named '${container}' in this project`
        : `this project has no production '${wanted}' container` };
  }
  if (matching.length > 1 && !container) {
    return { ok: false, project: project?.name || null, sources: available,
      error: `this project has ${matching.length} production '${wanted}' containers (several deploy `
        + `sites) — name one with --container <name> from the sources list` };
  }
  const row = matching[0];
  const src = publicSource(row);

  if (PRODLOGS_MODE === 'simulate') {
    return { ok: false, simulated: true, project: project?.name || null, mode: PRODLOGS_MODE,
      source: src, sources: available,
      error: 'PRODLOGS_MODE=simulate — this queenzee does not dial production daemons. You are talking to a '
        + 'NESTED queenzee (a subject under test) whose meta-DB is a clone of the real one, so the container '
        + 'this names is a real production container of the real fleet. Ask the real queenzee instead.' };
  }
  if (!row.docker_ctx) {
    return { ok: false, project: project?.name || null, source: src, sources: available,
      error: `the production ${wanted} container has no docker context recorded — the queenzee cannot reach `
        + 'its daemon to read a log (a fault in the container row, not in your request)' };
  }

  const n = clampTail(tail);
  const sinceTs = sinceToUnix(since);
  let raw;
  try {
    raw = await containerLogTail(row.docker_ctx, row.name, { tail: n, sinceTs, maxBytes: MAX_READ_BYTES });
  } catch (e) {
    // The daemon or the container could not be READ. Say so — never return an empty log, which
    // reads as "production is quiet" when it means "nobody asked production anything".
    return { ok: false, project: project?.name || null, source: src, sources: available,
      error: `could not read the production ${wanted} log: ${e.message}` };
  }
  const { lines, redactions, scanned, matched } = formatLogLines(raw.text, { tail: n, grep });
  return {
    ok: true,
    project: project?.name || null,
    mode: PRODLOGS_MODE,
    source: { ...src, state: raw.state || null },
    sources: available,
    tail: n,
    since: since || null,
    grep: grep || null,
    truncated: !!raw.truncated,
    scanned_lines: scanned,
    matched_lines: matched,
    redacted_lines: redactions,
    lines,
    note: 'READ-ONLY: this is the container log and nothing else — no shell, no filesystem, no container '
      + 'control, and credential-shaped values are masked (***) before the lines leave the queenzee.',
  };
}

export default { prodLogSources, prodLogTail, redactLogLine, formatLogLines, sinceToUnix, clampTail,
                 LOGGABLE_ROLES, PRODLOGS_MODE };

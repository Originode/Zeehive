// ZEEHIVE PROD GUARD — a PreToolUse hook that stops a zee deploying to production by hand.
//
// WHY: the landing gate is enforced by a git hook, so a zee physically cannot put code on main
// without a human. Shipping had no such teeth — it was prompt text — and a zee duly ignored it:
// it ran /spin:deploy-guard (a different, file-based lock ZEEHIVE cannot see), then
// `docker --context mardale-prod compose build webapp` by hand. It built an image that nothing
// ran (build without `up -d`), reported success, and left prod on the old image. Prompts do not
// bind a session that is already running, and `defaultMode: bypassPermissions` means nothing
// prompts either. A PreToolUse hook is the only thing left that the model cannot talk past.
//
// WHAT: deny Bash commands that MUTATE production, but only from inside a xell worktree.
//   - Scoped by cwd, so Mark's own sessions in the main repo are untouched.
//   - Read-only docker (ps/logs/inspect/images) stays allowed: a zee verifying a ship should be
//     able to LOOK at prod. It just cannot change it.
//   - The way in is xell-ship.mjs: a human approves, the queenzee deploys from main.
//
// Contract (https://code.claude.com/docs/en/hooks): stdin = {cwd, tool_name, tool_input:{command}};
// deny via stdout JSON hookSpecificOutput.permissionDecision='deny'.
//
// FAILS OPEN on a malformed payload — and only there. This hook sees EVERY Bash call on this
// machine, so a crash must not wedge the tool; there is no network dependency to be "down", and
// the match itself is pure local string work. Anything it does understand, it decides.

import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const API = process.env.ZEEHIVE_API || 'http://localhost:4700';

// Ask the queenzee a yes/no question, synchronously. Only ever called for a command that already
// looks like it touches prod, so this costs nothing on ordinary Bash calls. Returns null if the
// gate can't answer — the caller then FAILS CLOSED, same as the land gate: no approval service
// means no privileged prod access.
//
// The budget is 15s, not 5: db-access resolves container names against the REMOTE prod docker
// context, and over a degraded mardale link that takes 7-10s uncached. With a 5s budget the
// answer never arrived, so a xell a human had bound to prod (/xell-prod) was fail-closed DENIED
// its own database — and allowed on the rare warm-cache call, which is worse than either: a gate
// that flaps teaches a zee it is noise. 15s is paid only on prod-touching commands, and only
// until the queenzee's stale-serving name cache (xell-db.js) makes the endpoint fast again.
function ask(url) {
  try {
    const out = execFileSync('curl', ['-s', '--max-time', '15', '--connect-timeout', '2', url],
      { encoding: 'utf8', timeout: 18000, windowsHide: true });
    return JSON.parse(out);
  } catch { return null; }
}

// ONE deny path, used by every branch. (An earlier version called a `decline()` copied from the
// sibling shell hook, which does not exist here: the hook threw a ReferenceError, and a hook that
// CRASHES fails OPEN silently — it let a dev-db xell straight through to the prod database. Any
// new branch must call this, never invent its own exit.)
function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
  process.exit(0);
}

// ── is this psql invocation provably READ-ONLY? ───────────────────────────────────────────────
//
// Reads of a database are not this hook's business — it exists to stop hand-deploys and writes to
// someone else's data. But the hook only sees a COMMAND STRING, so "is this a read" has to be
// decided from text. That is decidable only when we can SEE the whole statement.
//
// CONSERVATIVE BY CONSTRUCTION. A false "no" costs one clear message and a re-dispatch. A false
// "yes" puts a write on production. So: unknowable => not read-only.
//
// LIMIT, stated plainly: this proves the STATEMENT SHAPE, not the effect. `SELECT f()` where f()
// writes would pass. That is consistent with this hook's stated threat model (it stops
// instruction-following and accident; it is not adversary-proof — a determined zee can obfuscate
// any command). The airtight version is a postgres ROLE with only SELECT grants, where the SERVER
// enforces it and no regex is involved.
function readOnlyPsql(cmd) {
  if (!/\bpsql\b/i.test(cmd)) return false;

  // A shell wrapper means the -c we find belongs to sh, not psql — we would be parsing the wrong
  // language. Don't guess.
  if (/\b(sh|bash|zsh)\s+-c\b/i.test(cmd)) return false;

  // SQL we cannot see: a file, a stdin redirect, a heredoc, or a pipe into psql.
  if (/\s(-f|--file)\b/i.test(cmd)) return false;
  if (/<|\|/.test(cmd)) return false;

  // Every -c payload must be present AND read-only. No -c at all = an interactive shell, whose
  // statements we will never see.
  const stmts = [...cmd.matchAll(/-c\s+(['"])([\s\S]*?)\1/g)].map((m) => m[2]);
  if (!stmts.length) return false;

  // Anything that can write, anywhere in the text — including inside a CTE (`WITH x AS (INSERT…)`),
  // `SELECT … INTO` (which creates a table), and COPY … FROM. EXPLAIN ANALYZE actually RUNS the
  // statement, so it is a write when wrapping one. Cheaper to reject the lot than to parse SQL.
  const WRITES = /\b(insert|update|delete|drop|create|alter|truncate|grant|revoke|vacuum|reindex|cluster|copy|call|do|refresh|import|merge|lock|analyze|reassign|comment|security\s+label)\b/i;
  const READ_LEAD = /^\s*(select|with|show|explain|table|values)\b/i;

  for (const sql of stmts) {
    for (const part of sql.split(';')) {
      const s = part.trim();
      if (!s) continue;
      if (s.startsWith('\\')) {                    // psql meta-commands: \d \dt \l \dn are reads
        if (!/^\\(d|dt|dv|di|ds|df|dn|l|z|sf|echo|pset|timing|x)\b/i.test(s)) return false;
        continue;
      }
      if (!READ_LEAD.test(s)) return false;        // must LEAD with a read verb
      if (WRITES.test(s)) return false;            // …and contain no write verb anywhere
      if (/\binto\b/i.test(s) && /^\s*select\b/i.test(s)) return false;  // SELECT … INTO writes
    }
  }
  return true;
}

// ── does this psql invocation make a SCHEMA CHANGE (DDL)? ───────────────────────────────────────
//
// Prod DB access (the dispatch "Production DB access" toggle → db-shared-prod) is DATA-ONLY by
// promise: a human turns it on for manual data processing — reads and writes — and is told, in a
// very obvious warning, that SCHEMA CHANGES ARE HARD-BLOCKED. Schema on prod moves one way only:
// a migration file, landed on main, shipped by the queenzee. Never a live psql `ALTER`/`DROP`.
//
// This is the enforcement of that promise. Same discipline as readOnlyPsql: we only see a COMMAND
// STRING, so the verdict is decided from text, and it is CONSERVATIVE — a write we cannot fully
// see is treated as possibly-DDL and refused, because a false "no schema change" puts a DROP on
// production. Returns:
//   'ddl'    — a visible statement changes the schema           → HARD BLOCK
//   'ok'     — every statement is visible and contains no DDL   → allow (data read/write)
//   'opaque' — the SQL is not visible (-f / pipe / heredoc / sh -c / no -c) → cannot prove DDL-free
// A command that is not psql at all (docker cp, pg_dump) returns 'ok' — it is not this check's job.
const DDL = /\b(create|alter|drop|truncate|reindex|cluster|reassign|(?:comment\s+on)|grant|revoke|(?:security\s+label)|(?:import\s+foreign\s+schema))\b/i;
function schemaVerdict(cmd) {
  if (!/\bpsql\b/i.test(cmd)) return 'ok';               // not psql — not a schema-change vector here
  if (/\b(sh|bash|zsh)\s+-c\b/i.test(cmd)) return 'opaque'; // the -c we'd read belongs to the shell
  if (/\s(-f|--file)\b/i.test(cmd)) return 'opaque';     // SQL is in a file we cannot inspect
  if (/<|\|/.test(cmd)) return 'opaque';                 // stdin redirect / heredoc / pipe
  const stmts = [...cmd.matchAll(/-c\s+(['"])([\s\S]*?)\1/g)].map((m) => m[2]);
  if (!stmts.length) return 'opaque';                    // interactive shell — statements never seen
  for (const sql of stmts) if (DDL.test(sql)) return 'ddl';
  return 'ok';
}

const SCHEMA_DENIED = [
  'DENIED by the ZEEHIVE prod guard: SCHEMA CHANGES on the production database are hard-blocked.',
  '',
  'Your xell was given the prod database for DATA work — reading and writing rows. It was NOT',
  'given permission to change the SCHEMA. CREATE / ALTER / DROP / TRUNCATE / GRANT / REINDEX and',
  'other DDL are refused here, on purpose: a live schema edit on prod is a band-aid the next',
  'rebuild from main silently reverts, and it is irreversible in the moment.',
  '',
  'THE WAY IN for a schema change:',
  '  1. write it as a migration file under server/sql/migrations/ on your branch,',
  '  2. land it on main (a human approves the push),',
  '  3. it ships to prod through the queenzee with the next deploy.',
  '',
  'Reads and row writes (SELECT / INSERT / UPDATE / DELETE) against your assigned prod db are',
  'still allowed — just put the SQL directly in `psql -c "…"` so this guard can see it.',
].join('\n');

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try { appendFileSync(process.env.ZEEHIVE_HOOK_TRACE || '', `FIRED ${new Date().toISOString()} ${raw.slice(0, 140)}\n`); } catch { /* tracing is opt-in via ZEEHIVE_HOOK_TRACE */ }
  let p;
  try { p = JSON.parse(raw); } catch { process.exit(0); }        // contract break → allow
  const cmd = p?.tool_input?.command;
  const cwd = String(p?.cwd || '');
  if (typeof cmd !== 'string' || !cmd) process.exit(0);

  // ── scope: only zees. A xell worktree lives under <repo>/.claude/worktrees/<slug>. ──────────
  const inXell = /[\\/]\.claude[\\/]worktrees[\\/]/i.test(cwd.replace(/\\/g, '/'));
  if (!inXell) process.exit(0);

  // ── does this command aim at PRODUCTION? ────────────────────────────────────────────────────
  // A prod docker context (`--context mardale-prod`, any *-prod), the prodsrc compose file, or a
  // *_prod container name. Deliberately broad: the cost of a false deny is one clear message.
  const prodTarget =
    /--context[= ]\s*["']?[\w.-]*prod\b/i.test(cmd) ||
    /prodsrc/i.test(cmd) ||
    /\b[\w-]+_prod\b/i.test(cmd);
  if (!prodTarget) process.exit(0);

  // Not a docker/compose command at all (e.g. `psql "$CONN"` against a db-shared-prod database,
  // which is a legitimate, separately-governed thing) → not ours to police.
  if (!/\bdocker\b|\bdocker-compose\b/i.test(cmd)) process.exit(0);

  // ── read-only is fine; mutation is not ──────────────────────────────────────────────────────
  const mutates =
    /\b(build|up|down|restart|stop|start|rm|rmi|exec|cp|create|kill|pull|push|tag|run|prune|scale|commit|load|import)\b/i.test(cmd) ||
    /\bcontext\s+use\b/i.test(cmd);   // switching the default context to prod, then building "locally"
  if (!mutates) process.exit(0);      // ps / images / logs / inspect / stats → look all you like

  // ── prod DATA is not prod CODE ──────────────────────────────────────────────────────────────
  // A hotfix / data-manipulation xell is dispatched with `--db shared-prod`, which makes the prod DB its
  // ASSIGNED container — using it obeys the rules rather than breaking them. This hook only sees a
  // cwd and a string, so it asks the queenzee whose database that is. Deploying prod CODE stays
  // denied for everyone (that is the ship gate's job), and exec into any OTHER prod container
  // (webapp/server/caddy) is still a deploy by hand.
  const dbVerb = /\b(exec|cp)\b/i.test(cmd) && !/\bcompose\b/i.test(cmd);
  if (dbVerb) {
    const answer = ask(`${API}/api/xell/db-access?cwd=${encodeURIComponent(cwd)}`);
    if (answer && answer.allowed && answer.db_container && cmd.includes(answer.db_container)) {
      // Its own database, in a xell a human pointed at prod (the "Production DB access" toggle).
      // DATA work is allowed — but SCHEMA CHANGES are hard-blocked. Prod access is read+write on
      // rows only; DDL goes through a migration + ship, never a live edit. A write we cannot see
      // (a -f file, a piped/heredoc statement) could carry DDL, so it is refused as conservatively
      // as a visible DROP: put the SQL in -c and the guard can prove it is data-only.
      const verdict = schemaVerdict(cmd);
      if (verdict === 'ddl') deny(SCHEMA_DENIED);
      if (verdict === 'opaque') deny(
        SCHEMA_DENIED + '\n\n'
        + 'This command was refused because the SQL was NOT VISIBLE to the guard (it was behind -f, a '
        + 'pipe, a stdin redirect, or `sh -c`) — so it could not be proven free of schema changes. '
        + 'Inline the statement(s) in `psql -c "…"` and re-run.');
      process.exit(0);  // visible, DDL-free — legitimate prod DATA work
    }

    // ── READS ARE NOT GATED ───────────────────────────────────────────────────────────────────
    // A provably read-only psql against a DATABASE container is allowed for any xell, assigned or
    // not. This gate exists to stop hand-deploys and writes to data that isn't yours; a SELECT is
    // neither. It used to deny on the command SHAPE alone (`docker --context …-prod exec … psql`),
    // so `SELECT count(*)` and `DROP TABLE` were identical to it — which made a zee ask its human
    // for prod access just to READ, and taught it that the gate is noise to route around.
    // Deliberately narrow: the target must be a known db container (never omnibiz_webapp_prod),
    // and the SQL must be visible and read-only (see readOnlyPsql — unknowable => denied).
    const dbTarget = (answer?.db_containers || []).some((n) => n && cmd.includes(n));
    if (dbTarget && readOnlyPsql(cmd)) process.exit(0);

    if (answer && !answer.allowed) {
      deny(`DENIED by the ZEEHIVE prod guard: this is not your database.\n\n`
        + `${answer.reason || 'this xell is not attached to the prod database'}.\n\n`
        + 'A hotfix / data-manipulation xell is dispatched with `--db shared-prod`, which ASSIGNS it '
        + 'the prod database — then this exact command is allowed. Ask your human to re-dispatch you '
        + 'that way, or use the database you were actually given.\n\n'
        + 'The flag value is `shared-prod`, NOT `prod`: dispatch prefixes it with "db-", so `--db prod` '
        + 'becomes the non-existent mode `db-prod`.\n\n'
        + 'READS ARE NOT GATED: a plain `psql -c "SELECT …"` against a db container is allowed for '
        + 'any xell. If you are seeing this for a read, the SQL was not VISIBLE to the gate — it was '
        + 'behind -f, a pipe, a stdin redirect, or `sh -c`. Put the statement directly in -c and it '
        + 'goes through. Writes still need the database you were assigned.');
    }
    // answer===null → the gate is unreachable → fall through to the deny below (fail closed).
  }

  deny([
    'DENIED by the ZEEHIVE prod guard: a zee may not deploy to production by hand.',
    '',
    'You are in a xell, and this command mutates PRODUCTION. Building prod yourself ships a',
    'BAND-AID: the image is live but main does not have it, so the next rebuild from main',
    'silently reverts it. (It is also easy to build an image and never run it — a deploy that',
    'looks successful and changes nothing.)',
    '',
    'THE WAY IN — ask, and a human decides:',
    '    node "<ZEEHIVE>/scripts/xell-ship.mjs" <your_xell_id> --reason "<what you are shipping>" --wait',
    '(run it in the BACKGROUND — its exit is your nudge). A human approves in the ZEEHIVE console,',
    'then the QUEENZEE takes the prod lock and deploys from the xource at main, and releases the',
    'lock itself. Your work must be LANDED on main first.',
    '',
    'Do not try to route around this. Do not use /spin:deploy-guard — its lock is invisible to the',
    'queenzee. Read-only docker against prod (ps, logs, inspect, images) is still allowed, and a',
    'xell dispatched with --db shared-prod may use its own prod DATABASE (that is data work, not a deploy).',
  ].join('\n'));
});

// Canary for hooks/prod-guard.mjs. HANDOFF says "re-run the canary after editing" — but no canary
// existed, so the one failure mode it warns about (a hook that CRASHES fails OPEN *silently*, which
// once let a dev-db xell straight through to prod) had nothing watching it. This is that watcher.
//
//   node hooks/prod-guard.canary.mjs
//
// Feeds real stdin payloads to the hook as a child process and asserts on the decision. A hook that
// throws still exits 0 with no stdout — indistinguishable from "allow" — so every case asserts on
// BOTH the decision and the absence of a crash on stderr.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), 'prod-guard.mjs');
const XELL = 'D:/Repos/OmniBiz/omnibiz/.claude/worktrees/canary-not-a-real-xell';
const HOME = 'D:/Repos/Zeehive';

function run(payload) {
  const r = spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 20000 });
  let decision = 'allow', reason = '';
  if ((r.stdout || '').trim()) {
    try {
      const j = JSON.parse(r.stdout);
      decision = j.hookSpecificOutput?.permissionDecision || 'allow';
      reason = j.hookSpecificOutput?.permissionDecisionReason || '';
    } catch { decision = 'UNPARSEABLE'; }
  }
  return { decision, reason, crashed: /Error|Throw|undefined is not/i.test(r.stderr || ''), stderr: r.stderr || '' };
}

const cases = [
  { name: 'non-xell cwd, prod build → allow (Mark\'s own session)',
    p: { cwd: HOME, tool_name: 'Bash', tool_input: { command: 'docker --context mardale-prod compose build webapp' } },
    want: 'allow' },
  { name: 'xell, read-only prod ps → allow (looking is fine)',
    p: { cwd: XELL, tool_name: 'Bash', tool_input: { command: 'docker --context mardale-prod ps' } },
    want: 'allow' },
  { name: 'xell, non-prod command → allow',
    p: { cwd: XELL, tool_name: 'Bash', tool_input: { command: 'npm test' } },
    want: 'allow' },
  { name: 'xell, prod compose build → DENY (ship gate)',
    p: { cwd: XELL, tool_name: 'Bash', tool_input: { command: 'docker --context mardale-prod compose -f docker-compose.prodsrc.yml build webapp' } },
    want: 'deny', expect: /may not deploy to production by hand/ },
  { name: 'xell, exec into prod DB it does not own → DENY, and advises --db shared-prod',
    p: { cwd: XELL, tool_name: 'Bash', tool_input: { command: 'docker --context mardale-prod exec -i omnibiz_db_prod_v184 psql -U postgres -d omnibiz' } },
    // forbid the bad INSTRUCTION, not the string: the message deliberately names `--db prod` in the
    // sentence explaining why it does not work. Banning it outright fails on correct text.
    want: 'deny', expect: /dispatched with `--db shared-prod`/, forbid: /dispatched with `--db prod`/ },
  { name: 'malformed payload → allow (must not wedge every Bash call)',
    p: 'not json at all', want: 'allow', raw: true },

  // ── READS ARE NOT GATED ─────────────────────────────────────────────────────────────────────
  // These must pass for ANY xell, assigned or not. The canary worktree is deliberately not a real
  // xell — that is the whole point: an unassigned zee may still read.
  { name: 'READ: plain SELECT against prod db → allow',
    p: { cwd: XELL, tool_name: 'Bash', tool_input: { command: `docker --context mardale-prod exec omnibiz_db_prod_v184 psql -U postgres -d omnibiz -c "SELECT count(*) FROM core.person"` } },
    want: 'allow' },
  { name: 'READ: SELECT with JOIN/GROUP BY (the real denied query) → allow',
    p: { cwd: XELL, tool_name: 'Bash', tool_input: { command: `docker --context mardale-prod exec omnibiz_db_prod_v184 psql -U postgres -d omnibiz -P pager=off -c "SELECT p.name, count(*) FROM erp_it.dtr_raw_event r JOIN core.person p ON p.entity_id=r.employee_id WHERE r.promote_status = 'promoted' GROUP BY p.name ORDER BY count(*) DESC"` } },
    want: 'allow' },
  { name: 'READ: \\d meta-command → allow',
    p: { cwd: XELL, tool_name: 'Bash', tool_input: { command: `docker --context mardale-prod exec omnibiz_db_prod_v184 psql -U postgres -d omnibiz -c "\\d erp_restaurant.kitchen_claim"` } },
    want: 'allow' },

  // ── WRITES STILL DENIED — the ways a write can wear a read's clothes ─────────────────────────
  { name: 'WRITE: DROP TABLE → DENY',
    p: { cwd: XELL, tool_name: 'Bash', tool_input: { command: `docker --context mardale-prod exec omnibiz_db_prod_v184 psql -U postgres -d omnibiz -c "DROP TABLE core.person"` } },
    want: 'deny' },
  { name: 'WRITE: SELECT smuggling a second statement after ; → DENY',
    p: { cwd: XELL, tool_name: 'Bash', tool_input: { command: `docker --context mardale-prod exec omnibiz_db_prod_v184 psql -U postgres -d omnibiz -c "SELECT 1; DROP TABLE core.person"` } },
    want: 'deny' },
  { name: 'WRITE: data-modifying CTE (WITH … AS (DELETE …)) → DENY',
    p: { cwd: XELL, tool_name: 'Bash', tool_input: { command: `docker --context mardale-prod exec omnibiz_db_prod_v184 psql -U postgres -d omnibiz -c "WITH gone AS (DELETE FROM core.person RETURNING *) SELECT count(*) FROM gone"` } },
    want: 'deny' },
  { name: 'WRITE: SELECT … INTO (creates a table) → DENY',
    p: { cwd: XELL, tool_name: 'Bash', tool_input: { command: `docker --context mardale-prod exec omnibiz_db_prod_v184 psql -U postgres -d omnibiz -c "SELECT * INTO evil FROM core.person"` } },
    want: 'deny' },
  { name: 'UNSEEABLE: psql -f file → DENY (cannot read the SQL)',
    p: { cwd: XELL, tool_name: 'Bash', tool_input: { command: `docker --context mardale-prod exec omnibiz_db_prod_v184 psql -U postgres -d omnibiz -f /tmp/x.sql` } },
    want: 'deny' },
  { name: 'UNSEEABLE: SQL piped into psql → DENY',
    p: { cwd: XELL, tool_name: 'Bash', tool_input: { command: `cat x.sql | docker --context mardale-prod exec -i omnibiz_db_prod_v184 psql -U postgres -d omnibiz` } },
    want: 'deny' },
  { name: 'UNSEEABLE: sh -c wrapper → DENY (the -c is the shell\'s, not psql\'s)',
    p: { cwd: XELL, tool_name: 'Bash', tool_input: { command: `docker --context mardale-prod exec omnibiz_db_prod_v184 sh -c "psql -U postgres -d omnibiz -c 'DROP TABLE core.person'"` } },
    want: 'deny' },
  { name: 'SCOPE: read-only psql but exec into the WEBAPP, not a db → DENY',
    p: { cwd: XELL, tool_name: 'Bash', tool_input: { command: `docker --context mardale-prod exec omnibiz_webapp_prod psql -U postgres -d omnibiz -c "SELECT 1"` } },
    want: 'deny' },
];

let failed = 0;
for (const c of cases) {
  const r = c.raw
    ? (() => { const x = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf8', timeout: 20000 });
               return { decision: (x.stdout || '').trim() ? 'deny' : 'allow', reason: '', crashed: false, stderr: x.stderr || '' }; })()
    : run(c.p);

  const okDecision = r.decision === c.want;
  const okExpect = !c.expect || c.expect.test(r.reason);
  const okForbid = !c.forbid || !c.forbid.test(r.reason);
  const ok = okDecision && okExpect && okForbid && !r.crashed;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  if (!ok) {
    console.log(`        decision=${r.decision} want=${c.want}`);
    if (!okExpect) console.log(`        reason did not match ${c.expect}`);
    if (!okForbid) console.log(`        reason still contains the WRONG flag ${c.forbid}`);
    if (r.crashed) console.log(`        HOOK CRASHED (fails open silently!):\n${r.stderr}`);
  }
}
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);

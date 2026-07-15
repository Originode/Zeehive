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

  const reason = [
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
    'queenzee. Read-only docker against prod (ps, logs, inspect, images) is still allowed.',
  ].join('\n');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
});

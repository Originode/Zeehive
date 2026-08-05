// THE TURN NOBODY COULD SEE — a cage reporting its own interactive turn (TKT-60 #3).
//
// Three kinds of turn run in a cxell. The queenzee STARTS two of them and records both: the SPAWN
// (queenzee/intake.js) and the RESUME (queenzee/nudge.js — a landing approval, a message to a
// finished zee, a clearance, the post-ship reflection, a fleet resume). The third is a turn a human
// or a manager starts by TYPING into the live session in the pane, and nothing in the fleet could
// see it: no hook is installed in a cage, the passive poller skips entrypoint='cxell-cli', and the
// monitor's pgrep cannot tell a generating TUI from one sitting at its prompt. queenzee/reaper.js
// carried that as a KNOWN GAP, and named its own fix — "the cage itself to report turn-start/
// turn-end (the `zee` CLI and token are already in there)".
//
// MEASURED IN A REAL CAGE (claude 2.1.220, 2026-08-04) rather than assumed, because the whole design
// rests on two facts about one CLI:
//   • an interactive / `-p` run FIRES UserPromptSubmit + Stop hooks from the cage's own
//     ~/.claude/settings.json — and zee-attach.sh's pane session is exactly such a run;
//   • `claude --bare` — what EVERY queenzee-started turn runs — fires NEITHER.
// So the hook sees precisely the turns the queenzee cannot, and cannot double-report the ones it
// can. Section C re-runs the second half here (the first needs an API key, so it is recorded above
// as the measurement it was, not faked).
//
// WHAT IS FENCED HERE:
//   A. the VERB (queenzee/self.js selfTurn) against a throwaway postgres: a start marks the zee row
//      working, an end marks it idle/end_turn, an interactive turn records NO COST (a hook knows a
//      turn happened, not what it cost), a queenzee-started turn is not written over, and the xell's
//      own held decision ('awaiting-done') is never mirrored away (TKT-57's rule).
//   B. the INSTALL COMMAND, actually run: it merges into a settings.json that already has hooks and
//      settings of its own, keeps them, and is idempotent.
//   C. the per-vendor declaration: claude declares it, codex and kimi declare nothing (not measured
//      → not guessed), and `--bare` is still what the queenzee's own turns run.
//
// Everything it creates is deleted in a finally, whatever happens.
process.env.TKB_NOTIFY = '0';

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

const { q, one, pool } = await import('../server/src/db/pool.js');
const { selfTurn } = await import('../server/src/queenzee/self.js');
const { adapterFor } = await import('../server/src/lib/cxell-runtimes.js');

const PID = '00000000-0000-4000-8000-0000000f6301';
const cleanup = async () => { try { await q(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* gone */ } };

try {
  await cleanup();
  await q(`INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'turnhook',$2,'main')`, [PID, ROOT]);
  const xource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'main') RETURNING *`, [PID]);
  const mkXell = async (slug, status = 'working') => one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, self_token_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [PID, xource.id, slug, `spinoff/${slug}`, `/tmp/turnhook/${slug}`, status, `hash-${slug}`]);
  const rt = await one(`SELECT id FROM agent_runtime WHERE key='claude-code-cxell'`);
  const mkZee = async (xellId, over = {}) => one(
    `INSERT INTO zee (xell_id, attach_mode, entrypoint, kind, runtime_id, viewer_kind, viewer_url,
                      claude_session_id, model, status, last_stop_reason,
                      cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
     VALUES ($1,'headless-spawn','cxell-cli','headless',$2,'ssh-terminal','ssh://zee@127.0.0.1:1',
             $3,'opus',$4,'end_turn',3.5,10,20,30,40) RETURNING *`,
    // a session id per zee: the column is UNIQUE (one live session belongs to one zee)
    [xellId, rt?.id || null, over.sid ?? randomUUID(), over.status ?? 'idle']);
  const rowOf = (id) => one(
    `SELECT status, name, last_stop_reason, cost_usd::float8 AS cost, input_tokens FROM zee WHERE id=$1`, [id]);

  // ── A. THE VERB ─────────────────────────────────────────────────────────────────────────────
  console.log('\n── A. the cage reports its own turn ──');
  const x = await mkXell('turnhook-typed');
  const z = await mkZee(x.id);
  const before = await rowOf(z.id);
  ok(before.status === 'idle', 'the zee starts idle — which is what it ALSO said all through the '
     + 'interactive turns nobody could see');

  const start = await selfTurn(x, { state: 'start' });
  const working = await rowOf(z.id);
  ok(start.ok === true && working.status === 'working',
     'THE FIX: `zee turn --start` marks the zee row WORKING, so the hive and a manager\'s `zee zees` '
     + 'show a busy worker while a human or a manager talks to it');
  ok(!!working.name, 'and it is NAMED, as a working zee is (the same rule every other turn follows)');
  ok(working.cost === 3.5 && Number(working.input_tokens) === 10,
     'and NOTHING is charged: a hook knows a turn happened, not what it cost — only a turn the '
     + 'queenzee itself ran reports usage');
  ok(/no cost is recorded/i.test(start.message || ''),
     '…and the answer SAYS so rather than leaving a caller to assume the burn moved');

  const end = await selfTurn(x, { state: 'end' });
  const idle = await rowOf(z.id);
  ok(end.ok === true && idle.status === 'idle' && idle.last_stop_reason === 'end_turn',
     "`zee turn --end` puts it back to idle with 'end_turn' — the same ending a spawned or resumed "
     + 'turn writes');
  ok(idle.name === null, 'and drops the codename, as every other turn ending does');
  ok(idle.cost === 3.5, 'still nothing charged at the end either');

  const ev = await one(
    `SELECT count(*)::int AS n FROM session_event
      WHERE xell_id=$1 AND hook_event_name IN ('interactive-turn-start','interactive-turn-end')`, [x.id]);
  ok(ev.n === 2, `both boundaries are answerable in SQL afterwards (session_event × ${ev.n})`);

  // A2. it must not write over a turn the queenzee is running.
  const busy = await mkXell('turnhook-busy');
  const bz = await mkZee(busy.id, { status: 'working' });
  await q(`UPDATE zee SET last_stop_reason='landing approved' WHERE id=$1`, [bz.id]);
  const dup = await selfTurn(busy, { state: 'start' });
  const still = await rowOf(bz.id);
  ok(dup.ok === true && dup.recorded === false && still.last_stop_reason === 'landing approved',
     'a start while a QUEENZEE-started turn is in flight changes nothing — the two doors cannot '
     + 'fight over one row (belt to the braces of `--bare` firing no hooks at all)');

  // A3. TKT-57's rule: the xell's held decision is never mirrored away.
  const held = await mkXell('turnhook-awaiting', 'awaiting-done');
  await mkZee(held.id);
  await selfTurn(held, { state: 'start' });
  const hx = await one(`SELECT status FROM xell WHERE id=$1`, [held.id]);
  ok(hx.status === 'awaiting-done',
     "a zee that PROPOSED DONE and is then typed at keeps its xell at 'awaiting-done' — an "
     + 'interactive turn must not delete a decision a human is holding');

  // A4. the boring cases.
  const bad = await selfTurn(x, { state: 'sideways' });
  ok(bad.ok === false && /start.*end/.test(bad.error || ''), 'an unknown state is refused, and says what is allowed');
  const empty = await mkXell('turnhook-nozee');
  const none = await selfTurn(empty, { state: 'start' });
  ok(none.ok === false && /no live zee/.test(none.error || ''),
     'a xell with no live zee is refused rather than silently recording nothing');

  // ── B. THE INSTALL COMMAND, RUN FOR REAL ────────────────────────────────────────────────────
  console.log('\n── B. the install merges, keeps what is there, and repeats cleanly ──');
  const home = mkdtempSync(join(tmpdir(), 'turnhook-home-'));
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
      skipDangerousModePermissionPrompt: true,
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo somebody-elses-hook' }] }] },
    }, null, 2));
    const cmd = adapterFor('claude-code-cxell').turnHookCmd();
    const run = () => execFileSync('bash', ['-lc', cmd], { env: { ...process.env, HOME: home } }).toString().trim();
    ok(run() === 'TURNHOOK_OK', 'the cage prints its own verdict (TURNHOOK_OK), like every other install here');
    const after = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    const cmds = (k) => (after.hooks?.[k] || []).flatMap((g) => (g.hooks || []).map((h) => h.command));
    ok(cmds('UserPromptSubmit').some((c) => c.startsWith('zee turn --start')),
       'a prompt submitted in the pane reports the turn START');
    ok(cmds('Stop').some((c) => c.startsWith('zee turn --end')), 'and the turn END when the session stops');
    ok(cmds('Stop').includes('echo somebody-elses-hook'),
       'while whatever was already hooked there SURVIVES — this file is not ours to own');
    ok(after.skipDangerousModePermissionPrompt === true, 'and so does every other setting in it');
    ok(cmds('UserPromptSubmit').every((c) => / \|\| true$/.test(c) && />\/dev\/null/.test(c)),
       'the hook can never break the session (|| true) and writes NO stdout — a UserPromptSubmit '
       + "hook's stdout is injected into the prompt itself");
    run();
    const twice = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    const n = (twice.hooks?.Stop || []).flatMap((g) => g.hooks || []).filter((h) => /zee turn/.test(h.command)).length;
    ok(n === 1, `running it again leaves exactly ONE turn hook (got ${n}) — it runs at every spawn`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  // ── C. PER VENDOR, MEASURED — never guessed ─────────────────────────────────────────────────
  console.log('\n── C. which runtimes declare a hook, and which turns run --bare ──');
  ok(typeof adapterFor('claude-code-cxell').turnHookCmd === 'function',
     'claude declares the hook install (measured in the image: -p fires the hooks, --bare does not)');
  for (const key of ['codex-cxell', 'kimi-code-cxell']) {
    ok(!adapterFor(key).turnHookCmd,
       `${key} declares NOTHING — unmeasured is left alone, exactly as it is for firstRunSeedCmd`);
  }
  ok(/--bare/.test(adapterFor('claude-code-cxell').execCmd({})),
     'and every QUEENZEE-started claude turn still runs --bare — which fires no hooks, so the two '
     + 'reporting paths cannot double-count a turn');
} finally {
  await cleanup();
  await pool.end().catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);

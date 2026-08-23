// CAPTURE THE CLI'S STRUCTURED ERROR + EXIT CODE, AND CLASSIFY THE UNKNOWN DEATH COHORT WITH EVIDENCE
// (ticket #78 — "Capture the CLI's structured error and exit code").
//
// MEASURED live (2026-08-21): 68% of classified deaths are revive_class='unknown', and for 60 of the
// 65 unknown rows the signal was already in last_stop_reason — the classifier's rules did not read
// it. The 5 bare-'error' rows are the honest 'unknown'. A further 16 rows are not deaths at all.
//
// WHAT IS FENCED HERE:
//   A. the widened CLASSIFIER, driven by the REAL stop-reason strings measured in the fleet:
//        "Not signed in. … grok login --device-code"        → TERMINAL/auth
//        "There's an issue with the selected model (…)…"    → TERMINAL/model
//        "cxell claude exited 137 with no result event: "   → TRANSIENT/killed (a SIGKILL/OOM)
//        "end_turn" / "post-ship reflection" / manager msgs / swaps → 'none' (NOT deaths)
//        "error" and friends                                → stays UNKNOWN (the honest default)
//   B. the layered classifier (classifyTurnDeathEx): a bare 'error' message with exit code 137, a
//      structured error, or a stderr tail beside it is classified from THAT signal, not guessed at;
//   C. the CAPTURE on the zee row: noteTurnDeath stores the exit code, a bounded stderr tail and the
//      vendor's structured error (migration 213 columns), and a non-death drops OUT of the cohort
//      (revive_class stays NULL);
//   D. the BACKFILL: the migration's UPDATE patterns re-classify existing 'unknown' rows from their
//      last_stop_reason, and leave the bare-'error' cohort unknown.
//
// Everything it creates is deleted in a finally, whatever happens.
process.env.PROVISION_MODE = 'real';
process.env.TKB_NOTIFY = '0';

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// ── A. THE WIDENED CLASSIFIER (pure — no database) ──────────────────────────────────────────────
const { classifyTurnDeath, classifyTurnDeathEx, decideRevive } = await import('../server/src/lib/turn-death.js');
const c = (t) => classifyTurnDeath(t);

console.log('\n── A. the measured fleet strings now get a class ──');
for (const [msg, kind, signal] of [
  ['Not signed in. To authenticate without a browser, run:\n  grok login --device-code', 'terminal', 'auth'],
  ["There's an issue with the selected model (deepseek-chat). It may not exist or you may not have access to the model.", 'terminal', 'model'],
  ["There's an issue with the selected model (deepseek-reasoner). It may not exist or you may not have access to the model.", 'terminal', 'model'],
  ['cxell claude exited 137 with no result event: ', 'transient', 'killed'],
  ['cxell claude exited 137 with no result event: JS stack trace\nFATAL ERROR: CALL_AND_RETRY_LAST Allocation failed', 'transient', 'killed'],
]) {
  const r = c(msg);
  ok(r.kind === kind && r.signal === signal,
     `${kind}/${signal}: ${JSON.stringify(msg.slice(0, 52))} → ${r.kind}/${r.signal}`);
}

console.log('\n── A2. the rows that are NOT deaths get the \'none\' kind, not \'unknown\' ──');
for (const [msg] of [
  ['end_turn'], ['end_turn (usage unreported)'], ['post-ship reflection'],
  ['message from manager-zee-c7ba3d'], ['swapped out by manager-zee-44019d → dev-architect / dev-reviewer'],
]) {
  const r = c(msg);
  ok(r.kind === 'none' && r.signal === 'healthy',
     `none/healthy: ${JSON.stringify(msg.slice(0, 48))} → ${r.kind}/${r.signal}`);
}
ok(decideRevive({ kind: 'none' }).action === 'none',
   "decideRevive treats 'none' as no action — a non-death is not revived and not tended");

console.log('\n── A3. the honest default stays: what cannot be classified stays UNKNOWN ──');
ok(c('error').kind === 'unknown' && c('').kind === 'unknown' && c(null).kind === 'unknown',
   "the bare 'error' cohort and an empty message stay UNKNOWN — the card shrinks the cohort with "
   + 'evidence, it does not guess louder');

// ── A4. A TRANSPORT FAILURE AGAINST OUR OWN GATEWAY WEARS THE GATEWAY'S NAME ─────────────────────
// 2026-08-22: the gateway address minted into cages moved to host.docker.internal:4701, a port no
// compose file published. For ~13h every dispatch died with "API Error: Unable to connect to API
// (ConnectionRefused)" — the VENDOR's words — so it read as "all three providers down". The
// transport failure was ours; the name on it was theirs. This is the classifier rule that owns it.
// The gateway context is PASSED IN (the classifier stays dependency-free): the addresses our cages
// are given, and whether ALL of this zee's AI traffic crosses our gateway (a cxell CLI does).
console.log('\n── A4. ConnectionRefused/ENOTFOUND against OUR gateway host names the GATEWAY ──');
const gwCtx = {
  gatewayAddresses: ['http://host.docker.internal:4701', 'http://zeehive_server:4701'],
  allTrafficIsGateway: true,
};
for (const [msg, kind, signal] of [
  // The exact outage: no address in the text, but a cxell's traffic ALL crosses our gateway, so a
  // transport failure IS against our gateway.
  ['API Error: Unable to connect to API (ConnectionRefused)', 'transient', 'gateway-unreachable'],
  ['API Error: connect ECONNREFUSED host.docker.internal:4701', 'transient', 'gateway-unreachable'],
  ['connect ENOTFOUND zeehive_server:4701', 'transient', 'gateway-unreachable'],
  ['API Error: socket hang up at http://host.docker.internal:4701', 'transient', 'gateway-unreachable'],
]) {
  const r = classifyTurnDeath(msg, gwCtx);
  ok(r.kind === kind && r.signal === signal,
     `${kind}/${signal}: ${JSON.stringify(msg.slice(0, 52))} → ${r.kind}/${r.signal}`);
}
// The rewritten message names the GATEWAY and the address it tried — never the vendor's sentence alone.
const gwMsg = classifyTurnDeath('API Error: connect ECONNREFUSED host.docker.internal:4701', gwCtx);
ok(gwMsg.message === 'zeehive gateway unreachable at http://host.docker.internal:4701 (ECONNREFUSED)',
   `the message is rewritten to name the gateway + address (${JSON.stringify(gwMsg.message)})`);
// Without the gateway context, the SAME transport failure stays the generic 'closed' (the vendor's
// name) — a non-cxell caller, or a death that never names our address, is not OURS to rename.
ok(classifyTurnDeath('API Error: connect ECONNREFUSED api.anthropic.com:443').signal === 'closed',
   'a connection refusal against a FOREIGN host stays the generic closed signal (the vendor\'s name)');
ok(classifyTurnDeath('API Error: connect ECONNREFUSED host.docker.internal:4701').signal === 'closed',
   'a connection refusal with NO gateway context stays closed — the caller must pass the gateway');
// A genuine vendor outage THROUGH a working gateway (the proxy answers 502 "gateway upstream
// unreachable") is NOT our gateway being down — the gateway itself answered, so the death is
// never named OURS. (Its exact signal is the pre-existing 5xx/closed transient bucket; what the
// new rule must never do is claim it for the gateway.)
const upstream = classifyTurnDeath('gateway upstream unreachable: connect ECONNREFUSED api.anthropic.com:443', gwCtx);
ok(upstream.kind === 'transient' && upstream.signal !== 'gateway-unreachable',
   'a genuine vendor outage through the gateway is NOT named OURS — the gateway itself answered '
   + `(got ${upstream.kind}/${upstream.signal})`);
// The layered classifier carries the gateway context into the stderr tail.
ok(classifyTurnDeathEx({ message: 'error', err: 'API Error: Unable to connect to API (ConnectionRefused)', gateway: gwCtx }).signal === 'gateway-unreachable',
   'classifyTurnDeathEx layers the gateway context onto the stderr tail');
// POLICY IS UNCHANGED: gateway-unreachable rides the same transient ladder, and the reason names the gateway.
const gwVerdict = decideRevive({ kind: 'transient', signal: 'gateway-unreachable', attempts: 0 });
ok(gwVerdict.action === 'revive' && gwVerdict.delayMinutes === 5 && /gateway/.test(gwVerdict.reason),
   'gateway-unreachable rides the SAME transient ladder and the revive reason names the gateway');

// ── B. THE LAYERED CLASSIFIER — a bare message with exit code / structured error / stderr tail ──
console.log('\n── B. classify from the captured exit code, structured error and stderr tail ──');
ok(classifyTurnDeathEx({ message: 'error', code: 137 }).kind === 'transient'
   && classifyTurnDeathEx({ message: 'error', code: 137 }).signal === 'killed',
   "'error' + exit 137 → killed/transient (a SIGKILL beside a bare message is a kill, not a mystery)");
ok(classifyTurnDeathEx({ message: 'error', result: { is_error: true, error: { type: 'authentication_error', message: 'invalid x-api-key' } } }).kind === 'terminal'
   && classifyTurnDeathEx({ message: 'error', result: { is_error: true, error: { type: 'authentication_error', message: 'invalid x-api-key' } } }).signal === 'auth',
   "'error' + a structured error whose message says 'invalid x-api-key' → terminal/auth");
ok(classifyTurnDeathEx({ message: 'error', err: 'API Error: 529 overloaded' }).signal === '529',
   "'error' + a stderr tail that says '529 overloaded' → transient/529");
ok(classifyTurnDeathEx({ message: 'error' }).kind === 'unknown'
   && classifyTurnDeathEx({ message: 'error', code: 0, err: '' }).kind === 'unknown',
   "'error' with NO other signal stays unknown — a captured-but-empty signal is not a guess");

// ── C/D. THE CAPTURE AND THE BACKFILL (throwaway postgres) ──────────────────────────────────────
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

const { q, one, pool } = await import('../server/src/db/pool.js');
const revive = await import('../server/src/queenzee/revive.js');

const PID = '00000000-0000-4000-8000-0000000f59a1';
const cleanup = async () => {
  try { await q(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* already gone */ }
};
let n = 0;
const row = (id) => one(`SELECT * FROM zee WHERE id=$1`, [id]);

try {
  await cleanup();
  await q(`INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'turn-death-capture',$2,'main')`, [PID, ROOT]);
  const xource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'main') RETURNING *`, [PID]);
  const rt = await one(`SELECT id FROM agent_runtime WHERE key='claude-code-cxell'`);
  const mkXell = async (slug) => one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, self_token_hash)
     VALUES ($1,$2,$3,$4,$5,'working',$6) RETURNING *`,
    [PID, xource.id, slug, `spinoff/${slug}`, `/tmp/turn-death-capture/${slug}`, `hash-${slug}`]);
  const mkZee = async (xellId, stopReason = null) => one(
    `INSERT INTO zee (xell_id, attach_mode, entrypoint, kind, runtime_id, viewer_kind, viewer_url,
                      claude_session_id, model, status, last_stop_reason)
     VALUES ($1,'headless-spawn','cxell-cli','headless',$2,'ssh-terminal','ssh://zee@127.0.0.1:2222',
             $3,'opus','errored',$4) RETURNING *`,
    [xellId, rt?.id || null, `00000000-0000-4000-8000-0000000000${++n}`, stopReason]);

  // ── C. the capture lands on the zee row ───────────────────────────────────────────────────────
  console.log('\n── C. noteTurnDeath captures exit code, stderr tail and the structured error ──');
  const x1 = await mkXell('capture-killed');
  const z1 = await mkZee(x1.id);
  const noted1 = await revive.noteTurnDeath({ zeeId: z1.id, xellId: x1.id, slug: x1.slug,
    reason: 'cxell claude exited 137 with no result event: ',
    code: 137, err: 'FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed', source: 'turn' });
  ok(noted1.kind === 'transient' && noted1.signal === 'killed',
     `a SIGKILL classifies as killed/transient (${JSON.stringify(noted1)})`);
  const r1 = await row(z1.id);
  ok(r1.revive_class === 'transient' && r1.revive_signal === 'killed',
     'the zee row carries the classification');
  ok(r1.last_death_code === 137, `the exit code is captured on the row (${r1.last_death_code})`);
  ok((r1.last_death_stderr || '').includes('Allocation failed'),
     `a bounded tail of stderr is captured (${JSON.stringify((r1.last_death_stderr || '').slice(0, 40))}…)`);
  ok(r1.revive_class_source === 'live',
     `a LIVE classification is stamped — decided at the moment of death, not by the backfill (${r1.revive_class_source})`);

  // a NON-DEATH drops out of the cohort entirely
  const x2 = await mkXell('capture-not-a-death');
  const z2 = await mkZee(x2.id);
  const noted2 = await revive.noteTurnDeath({ zeeId: z2.id, xellId: x2.id, slug: x2.slug,
    reason: 'end_turn', source: 'turn' });
  ok(noted2.kind === 'none' && !noted2.scheduled && !noted2.tended,
     `a healthy 'end_turn' is not a death (${JSON.stringify(noted2)})`);
  const r2 = await row(z2.id);
  ok(r2.revive_class === null && r2.revive_signal === null && r2.revive_next_at === null,
     'and it leaves the cohort: revive_class stays NULL, so it cannot be counted as an unknown death');
  ok(r2.revive_class_source === 'live',
     "and it was EXAMINED (source 'live') — 'not a death' stays distinguishable from 'never processed'");

  // a bare 'error' WITH the exit code beside it classifies from the exit code
  const x3 = await mkXell('capture-error-with-code');
  const z3 = await mkZee(x3.id);
  const noted3 = await revive.noteTurnDeath({ zeeId: z3.id, xellId: x3.id, slug: x3.slug,
    reason: 'error', code: 137, source: 'turn' });
  const r3 = await row(z3.id);
  ok(noted3.kind === 'transient' && noted3.signal === 'killed' && r3.last_death_code === 137,
     "a bare 'error' + exit 137 classifies as killed and captures the code — the card's honest case");

  // a bare 'error' with NO other signal stays unknown, and nothing is captured
  const x4 = await mkXell('capture-bare-error');
  const z4 = await mkZee(x4.id);
  const noted4 = await revive.noteTurnDeath({ zeeId: z4.id, xellId: x4.id, slug: x4.slug,
    reason: 'error', source: 'turn' });
  const r4 = await row(z4.id);
  ok(noted4.kind === 'unknown' && r4.revive_class === 'unknown' && r4.last_death_code === null
     && r4.last_death_stderr === null && r4.last_death_error === null,
     "a bare 'error' with nothing beside it stays UNKNOWN and captures nothing — the honest default");
  ok(r4.revive_class_source === 'live',
     'and it was still EXAMINED at death time (source live) — the honest unknown is a decision, not an omission');

  // ── C-GATEWAY. a transport failure against OUR gateway is named OURS on the row ─────────────
  console.log('\n── C-GATEWAY. a ConnectionRefused against our gateway wears the GATEWAY\'s name ──');
  // The exact 2026-08-22 outage sentence. The zee is a cxell-cli (mkZee above), so ALL of its AI
  // traffic crosses our gateway — a transport failure with no address is STILL against our gateway.
  const xg = await mkXell('capture-gateway');
  const zg = await mkZee(xg.id, 'API Error: Unable to connect to API (ConnectionRefused)');
  const notedg = await revive.noteTurnDeath({ zeeId: zg.id, xellId: xg.id, slug: xg.slug,
    reason: 'API Error: Unable to connect to API (ConnectionRefused)', source: 'turn' });
  ok(notedg.kind === 'transient' && notedg.signal === 'gateway-unreachable',
     `the outage classifies as transient/gateway-unreachable (${JSON.stringify(notedg)})`);
  const rg = await row(zg.id);
  ok(rg.revive_class === 'transient' && rg.revive_signal === 'gateway-unreachable',
     'the zee row records the gateway signal — "how often does the fleet die on the gateway?" is one GROUP BY');
  ok(/^zeehive gateway unreachable at http:\/\/host\.docker\.internal:4701/.test(rg.last_stop_reason || ''),
     `the stop_reason names the GATEWAY and the address — never the vendor's sentence alone (${JSON.stringify((rg.last_stop_reason || '').slice(0, 80))}…)`);
  ok((notedg.message || '').includes('zeehive gateway unreachable at'),
     'noteTurnDeath returns the rewritten message so the turn ledger closes with the gateway\'s name');

  // ── D. the BACKFILL re-classifies existing unknown rows from their last_stop_reason ───────────
  console.log('\n── D. the backfill patterns classify the measured unknown cohort ──');
  // The exact UPDATEs from migration 213, applied to seeded 'unknown' rows — proving the SQL
  // patterns read the same real messages the JS classifier now reads.
  // A row the classifier filed as 'unknown' carries a turn-death event (noteTurnDeath always records
  // one), and 213's backfill only touched 'unknown' rows — so the seeded 'unknown' rows that stand in
  // for the 213 cohort need the event too, or migration 215's event guard would rightly skip them.
  const seed = async (slug, reason) => {
    const x = await mkXell(slug);
    const z = await mkZee(x.id, reason);
    // the backfill only touches rows the classifier already filed as 'unknown'
    await q(`UPDATE zee SET revive_class = 'unknown', revive_signal = NULL WHERE id=$1`, [z.id]);
    await q(`INSERT INTO session_event (source, hook_event_name, zee_id) VALUES ('queenzee','turn-death',$1)`, [z.id]);
    return z;
  };
  const za = await seed('backfill-auth', 'Not signed in. To authenticate without a browser, run:\n  grok login --device-code');
  const zm = await seed('backfill-model', "There's an issue with the selected model (deepseek-chat). It may not exist or you may not have access to the model.");
  const zk = await seed('backfill-killed', 'cxell claude exited 137 with no result event: ');
  const zn1 = await seed('backfill-end', 'end_turn');
  const zn2 = await seed('backfill-swap', 'swapped out by manager-zee-44019d → dev-reviewer');
  const ze = await seed('backfill-bare', 'error');
  // a row that matches the non-death pattern but was NEVER examined — it has no turn-death event, so
  // 215 must NOT claim it as a backfill decision (and 213 may or may not have NULLed it)
  const xnever = await mkXell('backfill-never-processed');
  const znever = await mkZee(xnever.id, 'end_turn');

  // the EXACT 213 backfill, as applied to these seeded 'unknown' rows
  await q(`UPDATE zee SET revive_class = 'terminal', revive_signal = 'auth'
            WHERE revive_class = 'unknown' AND last_stop_reason ILIKE '%not signed in%'`);
  await q(`UPDATE zee SET revive_class = 'terminal', revive_signal = 'model'
            WHERE revive_class = 'unknown' AND last_stop_reason ILIKE '%issue with the selected model%'`);
  await q(`UPDATE zee SET revive_class = 'transient', revive_signal = 'killed'
            WHERE revive_class = 'unknown' AND last_stop_reason ILIKE '%exited 137%'`);
  await q(`UPDATE zee SET revive_class = NULL, revive_signal = NULL
            WHERE revive_class = 'unknown' AND (
                     last_stop_reason LIKE 'end_turn%'
                  OR last_stop_reason LIKE 'post-ship reflection%'
                  OR last_stop_reason ILIKE 'message from manager-%'
                  OR last_stop_reason ILIKE 'swapped out by manager-%')`);

  ok((await row(za.id)).revive_class === 'terminal' && (await row(za.id)).revive_signal === 'auth',
     "a seeded 'Not signed in' unknown row → terminal/auth (15 measured rows)");
  ok((await row(zm.id)).revive_class === 'terminal' && (await row(zm.id)).revive_signal === 'model',
     "a seeded 'issue with the selected model' unknown row → terminal/model (17 measured rows)");
  ok((await row(zk.id)).revive_class === 'transient' && (await row(zk.id)).revive_signal === 'killed',
     "a seeded 'exited 137' unknown row → transient/killed (5 measured rows)");
  ok((await row(zn1.id)).revive_class === null && (await row(zn2.id)).revive_class === null,
     "seeded non-death unknown rows (end_turn, swapped out) drop OUT of the cohort (16 measured rows)");
  ok((await row(ze.id)).revive_class === 'unknown',
     "a seeded bare 'error' row stays UNKNOWN — the 5 rows with no signal are left alone");

  // ── E. the PROVENANCE — migration 215, marking who decided each row's class ────────────────────
  console.log('\n── E. migration 215 stamps the backfill provenance (and distinguishes never-processed) ──');
  // migration 215's exact SQL — a fresh additive column, then the reclassification markers
  await q(`ALTER TABLE zee ADD COLUMN IF NOT EXISTS revive_class_source text`);
  await q(`UPDATE zee SET revive_class_source = 'backfill-2026-08-21'
            WHERE revive_class_source IS NULL
              AND (   (revive_signal = 'auth'   AND last_stop_reason ILIKE '%not signed in%')
                   OR (revive_signal = 'model'  AND last_stop_reason ILIKE '%issue with the selected model%')
                   OR (revive_signal = 'killed' AND last_stop_reason ILIKE '%exited 137%')
                   OR (revive_class = 'unknown' AND (   last_stop_reason ILIKE '%not signed in%'
                                                     OR last_stop_reason ILIKE '%issue with the selected model%'
                                                     OR last_stop_reason ILIKE '%exited 137%')))`);
  await q(`UPDATE zee z SET revive_class_source = 'backfill-2026-08-21'
            WHERE z.revive_class_source IS NULL
              AND (z.revive_class IS NULL OR z.revive_class = 'unknown')
              AND (   z.last_stop_reason LIKE 'end_turn%'
                   OR z.last_stop_reason LIKE 'post-ship reflection%'
                   OR z.last_stop_reason ILIKE 'message from manager-%'
                   OR z.last_stop_reason ILIKE 'swapped out by manager-%')
              AND EXISTS (SELECT 1 FROM session_event se
                           WHERE se.zee_id = z.id AND se.hook_event_name = 'turn-death')`);
  await q(`UPDATE zee z SET revive_class_source = 'live'
            WHERE z.revive_class_source IS NULL
              AND z.revive_class IS NOT NULL
              AND EXISTS (SELECT 1 FROM session_event se
                           WHERE se.zee_id = z.id AND se.hook_event_name = 'turn-death')`);

  ok((await row(za.id)).revive_class_source === 'backfill-2026-08-21'
     && (await row(zm.id)).revive_class_source === 'backfill-2026-08-21'
     && (await row(zk.id)).revive_class_source === 'backfill-2026-08-21',
     'the 213-reclassified groups are marked as a backfill decision (auth/model/killed)');
  ok((await row(zn1.id)).revive_class_source === 'backfill-2026-08-21'
     && (await row(zn2.id)).revive_class_source === 'backfill-2026-08-21',
     "and the non-death NULL rows 213 touched are ALSO marked — 'examined and not a death' is not 'never processed'");
  ok((await row(ze.id)).revive_class_source === 'live',
     'a bare-unknown row is marked LIVE — it was examined at death time and honestly left unknown, '
     + 'not rewritten by the backfill (the still-unknown cohort, provenance intact)');
  ok((await row(znever.id)).revive_class_source === null,
     "a row matching the non-death pattern but with NO turn-death event stays NULL source — "
     + "it was never examined, and 215 does not pretend otherwise");

  // a row live-classified BEFORE the provenance column existed (real class + turn-death event)
  const xl = await mkXell('backfill-historical-live');
  const zl = await mkZee(xl.id);
  await q(`UPDATE zee SET revive_class='transient', revive_signal='429' WHERE id=$1`, [zl.id]);
  await q(`INSERT INTO session_event (source, hook_event_name, zee_id) VALUES ('queenzee','turn-death',$1)`, [zl.id]);
  await q(`UPDATE zee z SET revive_class_source = 'live'
            WHERE z.revive_class_source IS NULL
              AND z.revive_class IS NOT NULL
              AND EXISTS (SELECT 1 FROM session_event se
                           WHERE se.zee_id = z.id AND se.hook_event_name = 'turn-death')`);
  ok((await row(zl.id)).revive_class_source === 'live',
     'a pre-215 live classification (real class + turn-death event) is marked LIVE, so NULL source '
     + 'means exactly one thing: never examined');

} finally {
  await cleanup();
  await pool.end().catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);

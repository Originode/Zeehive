// QUARANTINE A PROVIDER ACCOUNT THAT ANSWERED 401 (ticket #50).
//
// WHAT IS FENCED HERE:
//   A. the PURE DECISION — only a terminal AUTH death quarantines; credit/account/model/transient
//      do not (pausing a healthy balance or a mis-paired key is the failure this ticket was held
//      behind TKT-51 / TKT-48 for);
//   B. the I/O half against a throwaway postgres — pause the account with the vendor sentence as
//      the reason and `queenzee` as the actor, return the next ACTIVE sibling, and refuse to
//      auto-resume;
//   C. noteTurnDeath wiring — a zee attributed via provider_token_id is quarantined on auth; a
//      SPAWN death with a healthy sibling DEFERS the tend (intake will fail over once); a death
//      with NO sibling tends with "NO healthy sibling remains";
//   D. attribution — zee.provider_token_id is what the quarantine reads, so burn and failures are
//      answerable per account in SQL.
//
// Everything it creates is deleted in a finally, whatever happens.
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { decideAccountQuarantine, quarantineOnAuthDeath, findActiveSibling }
  = await import('../server/src/lib/account-quarantine.js');
const { setProviderAccountPaused, tokenForSpawn } = await import('../server/src/lib/provider-tokens.js');
const { q, one, pool } = await import('../server/src/db/pool.js');
const { tendState } = await import('../server/src/lib/status.js');
const revive = await import('../server/src/queenzee/revive.js');

// ── A. PURE DECISION ──────────────────────────────────────────────────────────────────────────
console.log('\n── A. only a terminal AUTH death quarantines ──');
ok(decideAccountQuarantine({ kind: 'terminal', signal: 'auth' }).quarantine === true
   && decideAccountQuarantine({ kind: 'terminal', signal: 'auth' }).failover === true,
   'terminal/auth → quarantine + may failover');
for (const [kind, signal] of [
  ['terminal', 'credit'], ['terminal', 'account'], ['terminal', 'model'],
  ['transient', '429'], ['transient', '529'], ['unknown', null],
]) {
  const d = decideAccountQuarantine({ kind, signal });
  ok(d.quarantine === false && d.failover === false,
     `${kind}/${signal || '∅'} → leave alone (not an auth-key failure)`);
}

const PID = randomUUID();
const cleanup = async () => {
  try { await q(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* already gone */ }
};

try {
  await q(
    `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
       VALUES ($1, 'account-quarantine-test', '/tmp/aq', 'master', 'aq', 'postgres')`, [PID]);

  const addAcct = async (provider, label, { createdAt = null } = {}) => {
    const row = await one(
      `INSERT INTO provider_token (project_id, provider, label, token, token_hint, created_at)
         VALUES ($1,$2,$3,$4,$5, COALESCE($6::timestamptz, now())) RETURNING id, label`,
      [PID, provider, label, `sk-ant-oat01-${label}-000000000000000000000000`, `hint-${label}`, createdAt]);
    return row;
  };

  // ── B. I/O: pause the dead account, hand back the sibling ───────────────────────────────────
  console.log('\n── B. quarantine pauses the account and names the sibling ──');
  // older sibling first, then the "newest" one tokenForSpawn would pick
  const biz = await addAcct('claude', 'biz', { createdAt: '2026-01-01T00:00:00Z' });
  const dead = await addAcct('claude', 'expired-oauth', { createdAt: '2026-06-01T00:00:00Z' });

  const picked = await tokenForSpawn(PID, 'claude');
  ok(picked.id === dead.id, 'precondition: the freshest ACTIVE account is the one that will die');

  const q1 = await quarantineOnAuthDeath({
    projectId: PID, accountId: dead.id, provider: 'claude',
    kind: 'terminal', signal: 'auth',
    reason: 'API Error: 401 Authentication Fails, Your api key: sk-ant-oat01-CAAA is invalid',
  });
  ok(q1.acted === true && q1.paused === true, 'the dead account is PAUSED');
  ok(q1.accountLabel === 'expired-oauth', 'it names the account it paused');
  ok(q1.siblingId === biz.id && q1.siblingLabel === 'biz' && q1.noSibling === false,
     `it returns the healthy sibling for a one-shot failover (got ${q1.siblingLabel})`);

  const pausedRow = await one(`SELECT paused_at, paused_by, reason FROM provider_token WHERE id=$1`, [dead.id]);
  ok(!!pausedRow.paused_at && pausedRow.paused_by === 'queenzee',
     'paused_by is the queenzee — never auto-resumed; a human clicks Resume');
  ok(/auth-terminal/.test(pausedRow.reason) && /401/.test(pausedRow.reason),
     `the pause reason carries the vendor sentence (${(pausedRow.reason || '').slice(0, 80)}…)`);
  ok(!/sk-ant-oat01-CAAA/.test(pausedRow.reason || ''),
     'the raw key is scrubbed out of the pause reason');

  const after = await tokenForSpawn(PID, 'claude');
  ok(after.id === biz.id, 'tokenForSpawn now skips the quarantined account and picks the sibling');

  // Never auto-resume: calling quarantine again on an already-paused row is a no-op pause, and
  // setProviderAccountPaused(false) is the ONLY resume path (a human's click).
  const still = await one(`SELECT paused_at FROM provider_token WHERE id=$1`, [dead.id]);
  ok(!!still.paused_at, 'the quarantined account stays paused — nothing here resumes it');

  console.log('\n── B2. no sibling → noSibling:true ──');
  await setProviderAccountPaused(PID, biz.id, true, { by: 'test', reason: 'parked for B2' });
  const only = await addAcct('claude', 'lone', { createdAt: '2026-07-01T00:00:00Z' });
  const q2 = await quarantineOnAuthDeath({
    projectId: PID, accountId: only.id, provider: 'claude',
    kind: 'terminal', signal: 'auth', reason: 'API Error: 401 invalid x-api-key',
  });
  ok(q2.acted && q2.paused && q2.noSibling === true && !q2.siblingId,
     'when every sibling is gone, noSibling is true — that is the human-visible notice trigger');

  console.log('\n── B3. non-auth deaths do not pause anything ──');
  const credit = await addAcct('openai', 'codex-paid');
  const q3 = await quarantineOnAuthDeath({
    projectId: PID, accountId: credit.id, provider: 'openai',
    kind: 'terminal', signal: 'credit', reason: 'Your credit balance is too low',
  });
  ok(q3.acted === false, 'a CREDIT death is not a quarantine');
  ok(!(await one(`SELECT paused_at FROM provider_token WHERE id=$1`, [credit.id])).paused_at,
     'and the account is still ACTIVE');

  // ── C. noteTurnDeath wiring ─────────────────────────────────────────────────────────────────
  console.log('\n── C. noteTurnDeath quarantines the attributed account ──');
  // Unpause biz so we have a sibling again; leave expired-oauth paused.
  await setProviderAccountPaused(PID, biz.id, false, { by: 'test' });
  // Make biz the only active claude account besides a fresh dead-one we will attribute.
  const doomed = await addAcct('claude', 'doomed', { createdAt: '2026-08-01T00:00:00Z' });

  const xource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'main') RETURNING *`, [PID]);
  const rt = await one(`SELECT id FROM agent_runtime WHERE key='claude-code-cxell'`);
  const mkXell = (slug) => one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, self_token_hash)
     VALUES ($1,$2,$3,$4,$5,'working',$6) RETURNING *`,
    [PID, xource.id, slug, `spinoff/${slug}`, `/tmp/aq/${slug}`, `hash-${slug}`]);
  const mkZee = (xellId, tokenId) => one(
    `INSERT INTO zee (xell_id, attach_mode, entrypoint, kind, runtime_id, viewer_kind,
                      claude_session_id, model, status, provider_token_id)
     VALUES ($1,'headless-spawn','cxell-cli','headless',$2,'ssh-terminal',$3,'opus','errored',$4)
     RETURNING *`,
    [xellId, rt?.id || null, randomUUID(), tokenId]);

  const xSpawn = await mkXell('aq-spawn-failover');
  const zSpawn = await mkZee(xSpawn.id, doomed.id);
  const verbatim = 'API Error: 401 {"type":"authentication_error","message":"invalid x-api-key"}';
  const filed = await revive.noteTurnDeath({
    zeeId: zSpawn.id, xellId: xSpawn.id, slug: xSpawn.slug,
    reason: verbatim, resumable: false, source: 'spawn',
  });
  ok(filed.kind === 'terminal' && filed.signal === 'auth', 'spawn 401 classifies as terminal/auth');
  ok(filed.quarantined === true, 'and the attributed account was quarantined');
  ok(filed.siblingId === biz.id, `siblingId is returned for the spawn failover (${filed.siblingLabel})`);
  ok(filed.tended === false,
     'SPAWN + sibling → tend is DEFERRED (intake will fail over; a tend on a soon-working xell would lie)');
  ok((await tendState(xSpawn.id)).open === false, 'the hexagon is not lit — failover owns the next step');
  ok(!!(await one(`SELECT paused_at FROM provider_token WHERE id=$1`, [doomed.id])).paused_at,
     'doomed is paused in the meta-DB');

  console.log('\n── C2. SPAWN with no sibling → human-visible notice ──');
  // Pause biz so nothing remains; attribute a fresh account.
  await setProviderAccountPaused(PID, biz.id, true, { by: 'test', reason: 'parked for C2' });
  const last = await addAcct('claude', 'last-one', { createdAt: '2026-08-15T00:00:00Z' });
  const xNone = await mkXell('aq-no-sibling');
  const zNone = await mkZee(xNone.id, last.id);
  const filed2 = await revive.noteTurnDeath({
    zeeId: zNone.id, xellId: xNone.id, slug: xNone.slug,
    reason: verbatim, resumable: false, source: 'spawn',
  });
  ok(filed2.quarantined === true && filed2.noSibling === true && filed2.tended === true,
     'no sibling → quarantined AND tended');
  const tNone = await tendState(xNone.id);
  ok(tNone.open === true, 'the hexagon shows a TEND — the human-visible notice');
  ok(/NO healthy sibling remains/i.test(tNone.full || tNone.reason || ''),
     `the tend says no healthy sibling remains (${(tNone.full || '').slice(0, 120)}…)`);
  ok(/QUARANTINED/i.test(tNone.full || ''), 'and that the account was quarantined');
  ok(/last-one/.test(tNone.full || ''), 'and it names the account this zee actually ran on');

  console.log('\n── C3. a mid-turn AUTH death quarantines and tends (no failover of the turn) ──');
  await setProviderAccountPaused(PID, biz.id, false, { by: 'test' });
  const mid = await addAcct('claude', 'mid-turn', { createdAt: '2026-08-20T00:00:00Z' });
  const xMid = await mkXell('aq-mid-turn');
  const zMid = await mkZee(xMid.id, mid.id);
  const filed3 = await revive.noteTurnDeath({
    zeeId: zMid.id, xellId: xMid.id, slug: xMid.slug,
    reason: verbatim, source: 'turn',
  });
  ok(filed3.quarantined === true && filed3.tended === true,
     'mid-turn auth → quarantine + tend (the cage is still there; credential-inject is the fix)');
  ok(filed3.siblingId === biz.id, 'sibling is still reported (for the next dispatch), but the turn is not retried');

  console.log('\n── D. attribution column is what the quarantine reads ──');
  const xOrphan = await mkXell('aq-no-attr');
  // zee with NO provider_token_id — the pre-211 shape
  const zOrphan = await one(
    `INSERT INTO zee (xell_id, attach_mode, entrypoint, kind, runtime_id, viewer_kind,
                      claude_session_id, model, status)
     VALUES ($1,'headless-spawn','cxell-cli','headless',$2,'ssh-terminal',$3,'opus','errored')
     RETURNING *`,
    [xOrphan.id, rt?.id || null, randomUUID()]);
  const filed4 = await revive.noteTurnDeath({
    zeeId: zOrphan.id, xellId: xOrphan.id, slug: xOrphan.slug,
    reason: verbatim, source: 'turn',
  });
  ok(filed4.kind === 'terminal' && filed4.tended === true && !filed4.quarantined,
     'a zee with no provider_token_id still tends, but cannot quarantine (nothing to attribute)');

  // findActiveSibling is the same order as tokenForSpawn
  const sib = await findActiveSibling(PID, 'claude', mid.id);
  ok(sib?.id === biz.id, 'findActiveSibling returns the freshest ACTIVE other account');

} finally {
  await cleanup();
  await pool.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILURE(s)` : '\nall ok');
process.exit(fail ? 1 : 0);

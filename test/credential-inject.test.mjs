// CREDENTIAL-INJECTION test — a rotated or repaired provider key reaches a LIVE cage without a
// re-spawn, and ONLY under a human gate.
//
// Covers, in order:
//   • decideLiveCagesNeedingKey — the PURE decision "which live cages hold an older key" (a cage
//     born before the account's current key needs it; a cage born after already holds it);
//   • rewriteCageEnv — the PURE /etc/environment rewrite (replace-or-append ONLY the credential
//     lines, leave every other line byte-for-byte intact, DEDUPE managed keys, DROP a disconnected
//     provider's vars, scrub newlines out of every value, mask every token in the receipt);
//   • the fix-pass PURE gates — the grant-ledger shapes (providerRunEnv answers from
//     xell_provider_grant, not a challenge value — see the DB-backed [1] section), scrubEnvValue
//     ([9]), scrubSecrets ([10]), providerInjectionEnv + manifest reconciliation ([5] residual);
//   • the gate end to end — raiseRotationRequest → a pending card naming the count → approve with an
//     INJECTED mock runner (this xell has no docker) → the row lands 'completed' with a per-xell
//     receipt, and the mock's captured rewrite text proves the right lines changed;
//   • [1] the grant LEDGER — providerRunEnv answers from xell_provider_grant and FAILS CLOSED:
//     granted-then-rotated, no-record, paused, and the happy path returning the granted account's env;
//   • [5]+[8] the injection is RESTRICTED to the request's provider (another connected provider's
//     line is untouched) and DROPS a disconnected provider's vars;
//   • [3] dismissing a PENDING request frees the one-open slot (the next rotation raises a fresh card);
//   • the auth-death trigger — raiseAuthDeathRequest scoped to the xell, approve → injected AND one
//     revive scheduled on the zee row (the column revive.js owns);
//   • the failure path — a cage write that fails lands a `failed` receipt with a readable reason,
//     not a throw; and PROVISION_MODE=simulate marks a DRY-RUN completion (never execs).
//
// Runs against a throwaway postgres. PROVISION_MODE is forced 'real' so the full gate runs; the
// docker exec is INJECTED, so nothing docker is ever reached.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

process.env.PROVISION_MODE = 'real';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { q, one, pool } = await import('../server/src/db/pool.js');
const { decideLiveCagesNeedingKey, rewriteCageEnv, raiseRotationRequest, raiseAuthDeathRequest,
        decideCredentialInject, listCredentialInjectRequests, dismissCredentialInject,
        scrubSecrets, providerEnvKeys, disconnectedProviderEnvKeys, providerInjectionEnv,
        manifestFromEnvText } =
  await import('../server/src/lib/credential-inject.js');
const { scrubEnvValue, recordXellProviderGrant, providerRunEnv } = await import('../server/src/lib/provider-tokens.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// ── the INJECTED runner: reads/writes a fake cage's /etc/environment, never docker ─────────────
function mockRunner(initialEnv, { failWrite = false, failAuth = false } = {}) {
  const state = { env: initialEnv };
  const calls = { writes: [], reads: 0, authSetups: 0 };
  return {
    state, calls,
    async readEnv() { calls.reads++; return { ok: true, text: state.env }; },
    async writeEnv({ slug, text }) {
      calls.writes.push({ slug, text });
      if (failWrite) return { ok: false, error: 'mock /etc/environment write failed (read-only fs)' };
      state.env = text;
      return { ok: true };
    },
    async authSetup({ slug, adapter }) {
      calls.authSetups++;
      if (failAuth) return { required: true, ok: false, verdict: 'AUTH_FAILED', said: 'codex login: invalid key (masked sk-…)' };
      return { required: false, ok: true };   // claude adapter has no authSetupCmd
    },
  };
}

const OLD = 'sk-ant-oat01-AAAA-BBBB-CCCC-DDDD-EEEE';
const NEW = 'sk-ant-oat01-1111-2222-3333-4444-5555';
const INITIAL_ENV = [
  'ZEEHIVE_XELL_TOKEN=abc123',
  'ZEEHIVE_API=http://queenzee:4700',
  'ZEE_RUNTIME=claude-code-cxell',
  'ANTHROPIC_AUTH_TOKEN=' + OLD,
  'CLAUDE_CODE_OAUTH_TOKEN=' + OLD,
  'ZEE_PROVIDERS=claude',
  'ZEE_PROVIDER_CLAUDE_TOKEN=' + OLD,
  'ZEE_PROVIDER_CLAUDE_HINT=sk-ant-oat01-…EEEE',
  '',
].join('\n');

try {
  // ── 1. the PURE decision: which live cages hold an older key ────────────────
  console.log('\n── decideLiveCagesNeedingKey (pure table test) ──');
  const cages = [
    { id: 'a', slug: 'cage-a', born_at: '2026-08-01T00:00:00Z' },
    { id: 'b', slug: 'cage-b', born_at: '2026-08-03T00:00:00Z' },
    { id: 'c', slug: 'cage-c', born_at: '2026-08-05T00:00:00Z' },
    { id: 'd', slug: 'cage-d', born_at: null },            // undatable
  ];
  const need = decideLiveCagesNeedingKey({ cages, accountCreatedAt: '2026-08-04T00:00:00Z' });
  ok(need.map((x) => x.slug).join(',') === 'cage-a,cage-b',
     `cages born before the key are stale (got: ${need.map((x) => x.slug).join(',') || 'none'})`);
  ok(!need.some((x) => x.slug === 'cage-c'), 'a cage born after the new key already holds it');
  ok(!need.some((x) => x.slug === 'cage-d'), 'an undatable cage is not proven stale → skipped');
  ok(need.every((x) => x.reason), 'each stale cage carries a human reason');
  ok(decideLiveCagesNeedingKey({ cages, accountCreatedAt: null }).length === 0,
     'no rotation time → nothing is proven stale');

  // ── 2. the PURE rewrite: /etc/environment, credential lines only ────────────
  console.log('\n── rewriteCageEnv (pure table test) ──');
  const rewritten = rewriteCageEnv({
    currentText: INITIAL_ENV,
    newEnv: {
      CLAUDE_CODE_OAUTH_TOKEN: NEW,
      ANTHROPIC_AUTH_TOKEN: NEW,
      ZEE_PROVIDERS: 'claude',
      ZEE_PROVIDER_CLAUDE_TOKEN: NEW,
      ZEE_PROVIDER_CLAUDE_HINT: 'sk-ant-oat01-…5555',
      ZEE_PROVIDER_CLAUDE_LABEL: 'my account',
    },
  });
  const text = rewritten.text;
  ok(text.includes('ZEEHIVE_XELL_TOKEN=abc123'), 'non-credential line is left intact');
  ok(text.includes('ZEEHIVE_API=http://queenzee:4700'), 'second non-credential line is left intact');
  ok(text.includes('ZEE_RUNTIME=claude-code-cxell'), 'runtime line is left intact');
  ok(text.includes('ANTHROPIC_AUTH_TOKEN=' + NEW) && !text.includes('ANTHROPIC_AUTH_TOKEN=' + OLD),
     'the vendor env token line is REPLACED in place');
  ok(text.includes('ZEE_PROVIDER_CLAUDE_TOKEN=' + NEW), 'the every-provider token line is replaced');
  ok(text.includes('ZEE_PROVIDER_CLAUDE_LABEL=my account'), 'a NEW key is appended (was absent)');
  ok(text.trim().split('\n').length === INITIAL_ENV.split('\n').length + 1,
     'one line appended, every existing line position preserved');
  const keys = rewritten.changed.map((c) => c.key);
  ok(keys.includes('ANTHROPIC_AUTH_TOKEN') && keys.includes('ZEE_PROVIDER_CLAUDE_LABEL'),
     'the receipt lists the changed keys');
  ok(rewritten.changed.every((c) => !String(c.oldHint || '').includes(OLD.slice(6))
      && !String(c.newHint || '').includes(NEW.slice(6))),
     'the receipt carries MASKED hints only — no token tail reaches a result row');
  ok(rewritten.changed.every((c) => !String(c.oldHint || '').includes('1111-2222')),
     'and the full token never appears in the receipt');

  // ── 2b. the fix-pass PURE gates: [1] ledger-shaped scrub, [9] newline scrub, [10] secret scrub ──
  console.log('\n── the fix-pass pure gates (scrubEnvValue / scrubSecrets / providerInjectionEnv / manifest) ──');
  const scrubbed = rewriteCageEnv({
    currentText: 'ZEEHIVE_XELL_TOKEN=abc\nANTHROPIC_AUTH_TOKEN=sk-ant-OLD\n',
    newEnv: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-NEW', ZEE_PROVIDER_CLAUDE_LABEL: 'my\naccount' },
  });
  ok(scrubbed.text.includes('ZEE_PROVIDER_CLAUDE_LABEL=myaccount') && !scrubbed.text.includes('\naccount'),
     '[9] a newline in a label is STRIPPED, never emitted (line injection closed)');
  ok(!/my\s*\n/.test(scrubbed.text), '[9] and no stray line was created by the newline');
  ok(scrubEnvValue('a\nb\rc') === 'abc', '[9] scrubEnvValue strips \\n and \\r');
  const scrub = scrubSecrets('401 your api key: sk-ant-oat01-AAAA-BBBB-CCCC-DDDD-EEEE is invalid; kc-abcdefghijklmnop; ghp_1234567890abcdefgh');
  ok(!scrub.includes('AAAA-BBBB') && scrub.includes('sk-…'),
     '[10] scrubSecrets masks a sk-ant-…-shaped token');
  ok(scrub.includes('kc-…') && !scrub.includes('kc-abcdefghij'), '[10] …and a kimi kc-…-shaped key');
  ok(scrub.includes('gh…') && !scrub.includes('ghp_1234567890'), '[10] …and a github ghp_…-shaped token');

  // [5] the injection env for ONE provider contains only that provider's vars; the MANIFEST is
  // reconciled by rewriteCageEnv from what is actually present in the file (no over-claiming).
  const injEnv = providerInjectionEnv({
    provider: 'claude', token: NEW,
    everyEnv: { ZEE_PROVIDERS: 'claude,openai',
                ZEE_PROVIDER_CLAUDE_TOKEN: 'stale', ZEE_PROVIDER_CLAUDE_LABEL: 'my account', ZEE_PROVIDER_CLAUDE_HINT: 'sk-ant-oat01-…5555',
                ZEE_PROVIDER_OPENAI_TOKEN: 'sk-proj-openai', ZEE_PROVIDER_OPENAI_LABEL: 'openai' },
  });
  ok(injEnv.ZEE_PROVIDER_CLAUDE_TOKEN === NEW, '[5] the request provider\'s token is the fresh one');
  ok(injEnv.ZEE_PROVIDER_CLAUDE_LABEL === 'my account', '[5] the request provider\'s label rides along');
  ok(injEnv.ZEE_PROVIDER_OPENAI_TOKEN === undefined, '[5] ANOTHER provider\'s namespaced var is NOT in the set');
  ok(injEnv.ZEE_PROVIDERS === undefined, '[5] the manifest is NOT set in the injection env — it is reconciled from the file');
  // [5] residual: rewriting a file that has claude+openai vars but only injecting claude yields a
  // manifest naming BOTH (both vars present) — and one naming only the providers actually present.
  const manifestText = rewriteCageEnv({
    currentText: 'ZEEHIVE_XELL_TOKEN=abc\nZEE_PROVIDERS=claude,openai,deepseek\nZEE_PROVIDER_CLAUDE_TOKEN=sk-ant-OLD\nZEE_PROVIDER_OPENAI_TOKEN=sk-proj-openai\n',
    newEnv: injEnv,
    dropKeys: disconnectedProviderEnvKeys({ ZEE_PROVIDERS: 'claude,openai' }),
  });
  ok(manifestFromEnvText(manifestText.text).join(',') === 'claude,openai',
     '[5] the reconciled manifest names EXACTLY the providers whose vars are present (openai untouched, deepseek dropped)');
  ok(manifestText.text.includes('ZEE_PROVIDERS=claude,openai') && !manifestText.text.includes('deepseek'),
     '[5] the manifest line in the file matches the present set — no over-claiming');
  const drops = disconnectedProviderEnvKeys({ ZEE_PROVIDERS: 'claude,openai' });
  ok(drops.includes('ZEE_PROVIDER_DEEPSEEK_TOKEN'), '[8] a provider absent from the manifest is in the DROP set');
  ok(!drops.includes('ZEE_PROVIDER_OPENAI_TOKEN'), '[8] a provider still in the manifest is NOT dropped');

  // ── 3. throwaway rows: a project, a claude account, two live cages ──────────
  console.log('\n── the gate end to end (rows + raise + list + approve + receipt) ──');
  await q(`DELETE FROM project WHERE name='credinjecttest'`);
  const project = await one(
    `INSERT INTO project (name, repo_root, main_branch) VALUES ('credinjecttest', '/tmp/credinject', 'main') RETURNING *`);
  // The account's current key was set 2 hours ago.
  const acct = await one(
    `INSERT INTO provider_token (project_id, provider, token, token_hint, label, created_at)
     VALUES ($1,'claude',$2,'sk-ant-oat01-…5555','test account', now() - interval '2 hours') RETURNING *`,
    [project.id, NEW]);
  const rt = await one(`SELECT id FROM agent_runtime WHERE key='claude-code-cxell'`);
  // cage-a: its zee was born 3 hours ago → BEFORE the current key → needs the injection.
  // cage-b: its zee was born 1 hour ago → AFTER the current key → already holds it.
  const xsource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'main') RETURNING *`, [project.id]);
  const cageA = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, head_commit, status, zee_type, self_token_hash, created_at)
     VALUES ($1,$2,'ci-cage-a','spinoff/ci-cage-a',$3,'head','working','worker','ci-a-hash', now() - interval '4 hours') RETURNING *`,
    [project.id, xsource.id, '/tmp/ci-a']);
  const cageB = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, head_commit, status, zee_type, self_token_hash, created_at)
     VALUES ($1,$2,'ci-cage-b','spinoff/ci-cage-b',$3,'head','working','worker','ci-b-hash', now() - interval '2 hours') RETURNING *`,
    [project.id, xsource.id, '/tmp/ci-b']);
  const zeeA = await one(
    `INSERT INTO zee (xell_id, entrypoint, status, kind, attach_mode, runtime_id, model, created_at)
     VALUES ($1,'cxell-cli','idle','headless','headless-spawn',$2,'sonnet', now() - interval '3 hours') RETURNING *`,
    [cageA.id, rt.id]);
  await one(
    `INSERT INTO zee (xell_id, entrypoint, status, kind, attach_mode, runtime_id, model, created_at)
     VALUES ($1,'cxell-cli','idle','headless','headless-spawn',$2,'sonnet', now() - interval '1 hours') RETURNING *`,
    [cageB.id, rt.id]);

  // ── 4. trigger (a): a human connected/replaced an account → rotation request ─
  const raised = await raiseRotationRequest({ projectId: project.id, provider: 'claude', accountId: acct.id });
  ok(raised.ok === true && raised.request?.status === 'pending', 'rotation request records a PENDING row');
  ok(raised.request?.kind === 'rotation', 'and it is a rotation (project-wide) request');
  ok(raised.request?.cage_count === 1, `the card says how many live cages hold an older key (got ${raised.request?.cage_count})`);
  ok(raised.cages?.length === 1 && raised.cages[0].slug === 'ci-cage-a',
     'the naming names the stale cage (cage-a), not the one already holding the new key');

  const dup = await raiseRotationRequest({ projectId: project.id, provider: 'claude', accountId: acct.id });
  ok(dup.ok === true && dup.request?.id === raised.request?.id && dup.note,
     're-raising while one is pending hands back the SAME request (one open rotation per project+provider)');

  const list1 = await listCredentialInjectRequests(project.id, { open: true });
  ok(list1.some((r) => r.id === raised.request?.id), 'listCredentialInjectRequests includes the pending ask');

  // ── 5. approve with the INJECTED runner → the queenzee performs the injection ─
  const runnerA = mockRunner(INITIAL_ENV);
  const approved = await decideCredentialInject(raised.request.id, 'approved', 'human@test',
    { mode: 'real', runner: runnerA });
  ok(approved?.status === 'completed', `approve performs the injection → COMPLETED (${approved?.status})`);
  ok(approved?.result?.ok === true, 'the receipt says the injection succeeded');
  ok(approved?.result?.per_xell?.length === 1, 'the receipt is per-xell');
  ok(approved?.result?.per_xell[0]?.xell_slug === 'ci-cage-a', 'and names the cage that was injected');
  ok(approved?.result?.per_xell[0]?.ok === true, 'the per-xell receipt is ok');
  ok(approved?.result?.per_xell[0]?.written === true, 'the env was actually written');
  ok(runnerA.calls.writes.length === 1, 'the performer wrote the cage env exactly once');
  const writtenText = runnerA.calls.writes[0].text;
  ok(writtenText.includes('ANTHROPIC_AUTH_TOKEN=' + NEW), 'the written /etc/environment carries the new token');
  ok(writtenText.includes('ZEEHIVE_XELL_TOKEN=abc123'), 'and still carries the non-credential lines');
  ok(writtenText.includes('ZEE_PROVIDER_CLAUDE_LABEL=test account'), 'and appended the new every-provider label line');
  ok(approved?.result?.per_xell[0]?.changed?.length > 0, 'the receipt lists the changed lines');

  // ── 6. a REJECTED request touches nothing ──────────────────────────────────
  const rej = await raiseRotationRequest({ projectId: project.id, provider: 'claude', accountId: acct.id });
  const rejected = await decideCredentialInject(rej.request.id, 'rejected', 'human@test', { mode: 'real', runner: mockRunner('') });
  ok(rejected?.status === 'rejected', 'a rejected request flips to rejected');
  ok(runnerA.calls.writes.length === 1, 'rejecting performs NO write (the earlier write is the only one)');

  // ── 7. the auth-death trigger: a zee dies on a 401 → a card beside its tend ─
  console.log('\n── the auth-death trigger → a card scoped to the xell ──');
  const deathRaised = await raiseAuthDeathRequest({
    xellId: cageA.id, projectId: project.id, provider: 'claude',
    reason: '401 Authentication Fails, Your api key: ****5555 is invalid',
    errorQuote: '401 Authentication Fails, Your api key: ****5555 is invalid',
  });
  ok(deathRaised.ok === true && deathRaised.request?.kind === 'auth-death'
     && deathRaised.request?.xell_id === cageA.id,
     'an auth death raises a pending auth-death request scoped to that xell');
  ok((deathRaised.request?.reason || '').includes('claude') && (deathRaised.request?.reason || '').includes('401'),
     'the card names the account and quotes the error');
  const deathDup = await raiseAuthDeathRequest({
    xellId: cageA.id, projectId: project.id, provider: 'claude', reason: '401 again', errorQuote: '401 again' });
  ok(deathDup.request?.id === deathRaised.request?.id && deathDup.note,
     'a second death on the same xell+provider refreshes the SAME card, not a second one');

  const deathRunner = mockRunner(INITIAL_ENV);
  const deathApproved = await decideCredentialInject(deathRaised.request.id, 'approved', 'human@test',
    { mode: 'real', runner: deathRunner });
  ok(deathApproved?.status === 'completed', 'approving an auth-death request injects and completes');
  ok(deathApproved?.result?.per_xell?.[0]?.xell_slug === 'ci-cage-a', 'it injected into the dead zee\'s cage');
  const zeeAfter = await one(`SELECT revive_next_at, revive_signal, revive_class FROM zee WHERE id=$1`, [zeeA.id]);
  ok(zeeAfter?.revive_next_at !== null && zeeAfter?.revive_signal === 'credential-injected',
     'the injection schedules ONE revive on the zee row (revive.js owns that column)');
  ok(deathApproved?.result?.per_xell?.[0]?.revive?.ok === true, 'and the receipt says so');

  // ── 8. the FAILURE path lands a `failed` receipt, not a throw ──────────────
  console.log('\n── the failure path: a cage write that fails ──');
  await q(`UPDATE credential_inject_request SET status='pending', dismissed_at=NULL WHERE id=$1`, [deathRaised.request.id]);
  // (reset the auth-death request so we can fail it on purpose)
  await q(`UPDATE credential_inject_request SET status='pending' WHERE id=$1`, [deathRaised.request.id]);
  const failRunner = mockRunner(INITIAL_ENV, { failWrite: true });
  const failed = await decideCredentialInject(deathRaised.request.id, 'approved', 'human@test',
    { mode: 'real', runner: failRunner });
  ok(failed?.status === 'failed', `a failed cage write lands a FAILED receipt (${failed?.status})`);
  ok(failed?.result?.ok === false, 'the receipt says the injection did not fully succeed');
  ok((failed?.result?.per_xell?.[0]?.error || '').includes('could not write /etc/environment'),
     'the per-xell failure has a readable reason, not a throw');

  // ── 9. an authSetup that fails lands a failed receipt too ──────────────────
  console.log('\n── an authSetup that does not report AUTH_OK → a failed receipt ──');
  await q(`UPDATE credential_inject_request SET status='pending' WHERE id=$1`, [deathRaised.request.id]);
  const authFailRunner = mockRunner(INITIAL_ENV, { failAuth: true });
  const authFailed = await decideCredentialInject(deathRaised.request.id, 'approved', 'human@test',
    { mode: 'real', runner: authFailRunner });
  ok(authFailed?.status === 'failed', `an AUTH_FAILED verdict lands a FAILED receipt (${authFailed?.status})`);
  ok((authFailed?.result?.per_xell?.[0]?.error || '').includes('AUTH_OK'),
     'the receipt names the missing AUTH_OK verdict, not a stack trace');
  ok(authFailRunner.calls.authSetups === 1, 'the adapter auth setup was re-run exactly once');

  // ── 10. PROVISION_MODE=simulate marks a DRY-RUN, never execs ───────────────
  console.log('\n── PROVISION_MODE=simulate → a DRY-RUN completion ──');
  await q(`UPDATE credential_inject_request SET status='pending' WHERE id=$1`, [deathRaised.request.id]);
  const simRunner = mockRunner(INITIAL_ENV);
  const sim = await decideCredentialInject(deathRaised.request.id, 'approved', 'human@test',
    { mode: 'simulate', runner: simRunner });
  ok(sim?.status === 'completed' && sim?.result?.dry_run === true,
     'a nested queenzee marks the request completed as a DRY-RUN');
  ok(simRunner.calls.writes.length === 0, 'and performs NO docker exec');

  // ── 11. dismiss is "seen it", never a decision ─────────────────────────────
  console.log('\n── dismiss ──');
  const dismissed = await dismissCredentialInject(sim.id, 'human@test');
  ok(dismissed?.dismissed_at !== null, 'dismiss marks seen-it (dismissed_at) without changing status');
  const listAfterDismiss = await listCredentialInjectRequests(project.id, { open: true });
  ok(!listAfterDismiss.some((r) => r.id === sim.id), 'a dismissed request leaves the open view');

  // ── 12. [3] dismissing a PENDING request frees the one-open slot ───────────
  console.log('\n── [3] dismiss of a PENDING request frees the one-open slot ──');
  const pendingRot = await raiseRotationRequest({ projectId: project.id, provider: 'claude', accountId: acct.id });
  ok(pendingRot.ok === true && pendingRot.request?.status === 'pending', '[3] a fresh rotation is pending');
  await dismissCredentialInject(pendingRot.request.id, 'human@test');
  const listAfterPendingDismiss = await listCredentialInjectRequests(project.id, { open: true });
  ok(!listAfterPendingDismiss.some((r) => r.id === pendingRot.request.id),
     '[3] the dismissed PENDING request leaves the open view (still holding no slot)');
  const freshRot = await raiseRotationRequest({ projectId: project.id, provider: 'claude', accountId: acct.id });
  ok(freshRot.ok === true && freshRot.request?.status === 'pending',
     '[3] raising again after a dismiss creates a NEW pending card');
  ok(freshRot.request?.id !== pendingRot.request?.id,
     '[3] the new card is NOT the invisible dismissed one — the slot was freed');

  // ── 13. [5]+[8] the injection is restricted to the request provider ────────
  console.log('\n── [5]+[8] injection restricted to the request provider; disconnected vars dropped ──');
  await q(`INSERT INTO provider_token (project_id, provider, token, token_hint, label)
           VALUES ($1,'openai','sk-proj-OPENAI-ACTIVE-KEY-1234567890','sk-proj-…7890','openai account')`,
          [project.id]);
  const RICH_ENV = [
    'ZEEHIVE_XELL_TOKEN=abc123',
    'ANTHROPIC_AUTH_TOKEN=' + OLD,
    'CLAUDE_CODE_OAUTH_TOKEN=' + OLD,
    'ZEE_PROVIDERS=claude,openai,deepseek',
    'ZEE_PROVIDER_CLAUDE_TOKEN=' + OLD,
    'ZEE_PROVIDER_CLAUDE_HINT=sk-ant-oat01-…EEEE',
    'ZEE_PROVIDER_OPENAI_TOKEN=sk-proj-stale-openai-key',
    'ZEE_PROVIDER_OPENAI_LABEL=openai account',
    'ZEE_PROVIDER_DEEPSEEK_TOKEN=sk-deepseek-revoked-key',
    'ZEE_PROVIDER_DEEPSEEK_LABEL=deepseek account',
    '',
  ].join('\n');
  const richRot = await raiseRotationRequest({ projectId: project.id, provider: 'claude', accountId: acct.id });
  const richRunner = mockRunner(RICH_ENV);
  const richApproved = await decideCredentialInject(richRot.request.id, 'approved', 'human@test',
    { mode: 'real', runner: richRunner });
  ok(richApproved?.status === 'completed', '[5]+[8] approve of a claude rotation completes');
  const richText = richRunner.calls.writes[0].text;
  ok(richText.includes('ZEE_PROVIDER_CLAUDE_TOKEN=' + NEW), '[5] the request provider IS injected with the fresh key');
  ok(richText.includes('ZEE_PROVIDER_OPENAI_TOKEN=sk-proj-stale-openai-key'),
     '[5] ANOTHER connected provider\'s line is byte-for-byte UNTOUCHED');
  ok(!richText.includes('ZEE_PROVIDER_DEEPSEEK_TOKEN'), '[8] a DISCONNECTED provider\'s vars are DROPPED');
  ok(richText.includes('ZEE_PROVIDERS=claude,openai') && !richText.includes('ZEE_PROVIDERS=claude,openai,deepseek'),
     '[5]+[8] the manifest is recomputed to the connected set');
  const grantAfterInject = await one(`SELECT * FROM xell_provider_grant WHERE xell_id=$1 AND provider='claude'`,
                                     [richApproved.result.per_xell[0].xell_id]);
  ok(grantAfterInject && grantAfterInject.provider_token_id === acct.id,
     '[1] the injection performer RECORDS the grant (the other door that puts a key in a cage)');

  // ── 14. [1] the LEDGER: providerRunEnv answers from the recorded grant, failing closed ──
  console.log('\n── [1] the grant ledger: granted-then-rotated / no-record / paused ──');
  // A fresh grant row for cageA on the CURRENT account (created_at matches the row).
  await recordXellProviderGrant({ xellId: cageA.id, provider: 'claude', providerTokenId: acct.id, grantedBy: 'spawn' });
  const happy = await providerRunEnv(project.id, 'claude', { xellId: cageA.id });
  ok(happy.ok === true && happy.account === 'test account',
     '[1] a grant whose account is active and unchanged returns ITS env (the cage already holds that key)');
  ok(happy.env?.ANTHROPIC_AUTH_TOKEN === NEW, '[1] …and that env is the GRANTED account\'s, not the freshest');

  // ROTATED: replace the account's key in place (setProviderToken bumps created_at) → the grant no
  // longer matches → refuse.
  await q(`UPDATE provider_token SET token=$2, token_hint=$3, created_at=now() WHERE id=$1`,
          [acct.id, 'sk-ant-oat01-ROTATEDROTATEDROTATEDROTATED', 'sk-ant-oat01-…ROT']);
  const rotated = await providerRunEnv(project.id, 'claude', { xellId: cageA.id });
  ok(rotated.ok === false && rotated.status === 'refused' && /injection/.test(rotated.error),
     '[1] a grant whose account was REPLACED in place (rotated) is REFUSED, naming the injection card');

  // NO-RECORD: a cage with no grant at all → refuse, fail closed.
  const noRecord = await providerRunEnv(project.id, 'claude', { xellId: cageB.id });
  ok(noRecord.ok === false && noRecord.status === 'refused' && /no record/.test(noRecord.error),
     '[1] a cage with NO grant record is REFUSED, fail-closed');

  // PAUSED: restore the account, grant it to cageB, then pause it → refuse.
  await q(`UPDATE provider_token SET token=$2, token_hint=$3, paused_at=NULL WHERE id=$1`,
          [acct.id, NEW, 'sk-ant-oat01-…5555']);
  await recordXellProviderGrant({ xellId: cageB.id, provider: 'claude', providerTokenId: acct.id, grantedBy: 'spawn' });
  const pausedHappy = await providerRunEnv(project.id, 'claude', { xellId: cageB.id });
  ok(pausedHappy.ok === true, '[1] the re-granted cageB can pull its granted account (pre-pause sanity)');
  await q(`UPDATE provider_token SET paused_at=now() WHERE id=$1`, [acct.id]);
  const paused = await providerRunEnv(project.id, 'claude', { xellId: cageB.id });
  ok(paused.ok === false && paused.status === 'refused' && /paused|rotated|deleted/.test(paused.error),
     '[1] a grant whose account is PAUSED is REFUSED');

  // NO-XELL: the door requires a caller identity.
  const noXell = await providerRunEnv(project.id, 'claude', {});
  ok(noXell.ok === false && noXell.status === 'refused',
     '[1] the door refuses without a caller xell identity (nothing to answer from)');

  console.log(failures ? `\n${failures} FAILED` : '\nall good');
  process.exit(failures ? 1 : 0);
} finally {
  await pool.end().catch(() => {});
}

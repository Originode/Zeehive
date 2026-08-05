// PROVIDER ACCOUNT PAUSE (migration 104) — pausing a connected AI-provider account disables it
// for every dispatch surface without disconnecting it.
//
// The enforcement lives in the ONE token read every spawn funnels through (provider-tokens.js):
//   • tokenForSpawn(tokenId)        — a PAUSED account is refused even when its id is named, so
//                                     no surface (console prompt button, manager deploy, swap,
//                                     MCP) can route around the pause;
//   • tokenForSpawn(no tokenId)     — the generic pick skips paused accounts and takes the
//                                     freshest ACTIVE one; a type whose every account is paused
//                                     refuses;
//   • assertProviderDispatchable()  — the pre-flight in spawnHeadless that also stops runtimes
//                                     which never read a meta-DB token (claude-remote, the host
//                                     SDK) when every account of a provider is paused.
// Plus the read model: listProviderTokens exposes paused/paused_at/paused_by/reason per account
// and all_paused per type, so the console can render the pause and stop offering paused accounts.
//
// No docker, no fake runtime: this is purely the lib layer against the meta-DB, so it stands up a
// throwaway project + provider_token rows and tears them down in a finally.
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { setProviderAccountPaused, listProviderTokens, tokenForSpawn, spawnCreds, assertProviderDispatchable }
  = await import('../server/src/lib/provider-tokens.js');

// ── WEB WIRING: every api.js function CALLED in a console file must be imported ──────────────
// Shipped 2026-07-31 with a ReferenceError: ProjectSetup.jsx called pauseProviderAccount /
// resumeProviderAccount (added in the same change) but never imported them. esbuild leaves an
// undeclared identifier as a global reference and still builds, so the bundle deployed with the
// calls present and the definitions absent — the pause button threw and nothing happened, and the
// resume button could never appear because the paused state was never reached. This scan is the
// guard: for every web/src/*.jsx, any api.js export that the file CALLS must be imported from
// './api.js' (or declared locally — local helpers/props with the same name live there too).
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const webSrc = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'src');
const apiSrc = readFileSync(resolve(webSrc, 'api.js'), 'utf8');
const apiExports = new Set([
  ...[...apiSrc.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]),
  ...[...apiSrc.matchAll(/export\s+(?:async\s+)?const\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]),
]);
const importedFromApi = (src) => {
  // union ALL `import { … } from './api.js'` blocks — a file may have several (Dispatch.jsx does)
  const out = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*api\.js'/g)) {
    for (const s of m[1].split(',')) {
      const name = s.trim().split(/\s+as\s+/)[0];
      if (name) out.add(name);
    }
  }
  return out;
};
const locallyDeclared = (src, name) =>
  new RegExp(`\\b(?:function|class|const|let|var)\\s+${name}\\b`).test(src)
  || new RegExp(`\\b${name}\\s*=`).test(src);
const missing = [];
for (const f of readdirSync(webSrc).filter((f) => f.endsWith('.jsx') || f.endsWith('.js'))) {
  if (f === 'api.js') continue;   // defines the exports; nothing to import
  const src = readFileSync(resolve(webSrc, f), 'utf8');
  const imported = importedFromApi(src);
  for (const name of apiExports) {
    if (!new RegExp(`\\b${name}\\s*\\(`).test(src)) continue;   // not CALLED → nothing to import
    if (imported.has(name)) continue;
    if (locallyDeclared(src, name)) continue;                    // a local fn/prop of that name
    missing.push(`${f} calls ${name} but never imports it from './api.js'`);
  }
}
console.log('\n── the console never CALLS an api.js function it did not import ──');
ok(missing.length === 0, missing.length ? `MISSING IMPORTS: ${missing.join(' · ')}` : 'every api.js function a console file calls is imported or declared locally');

const client = new pg.Client({ connectionString: url });
await client.connect();
const PID = randomUUID();
const token = (p) => ({
  claude: 'sk-ant-oat01-00000000000000000000000000000000',
  openai: 'sk-000000000000000000000000000000000000',
  kimi: 'kimi-key-00000000000000000000000000000000',
  deepseek: 'sk-000000000000000000000000000000000000',
}[p]);

try {
  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
       VALUES ($1, 'provider-pause-test', '/tmp/provider-pause-test', 'master', 'ppause', 'postgres')`, [PID]);

  const addAcct = async (provider, label) => (await client.query(
    `INSERT INTO provider_token (project_id, provider, label, token, token_hint)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [PID, provider, label, token(provider), `hint-${label}`])).rows[0].id;

  console.log('\n── pause one account of several: it is refused by id, skipped by the generic pick ──');
  const a1 = await addAcct('claude', 'first');
  const a2 = await addAcct('claude', 'second');
  await setProviderAccountPaused(PID, a1, true, { by: 'mark@console', reason: 'rate-limited' });

  let listed = (await listProviderTokens(PID)).find((p) => p.provider === 'claude');
  ok(listed.accounts.length === 2 && !listed.all_paused,
     'read model: two claude accounts, not all paused');
  const pausedAcct = listed.accounts.find((a) => a.id === a1);
  ok(pausedAcct.paused === true && pausedAcct.paused_by === 'mark@console' && pausedAcct.reason === 'rate-limited',
     'read model: the paused account carries paused/paused_by/reason');
  ok(!listed.accounts.find((a) => a.id === a2).paused, 'read model: the sibling account stays active');

  let refused = false;
  try { await tokenForSpawn(PID, 'claude', { tokenId: a1 }); } catch (e) { refused = /PAUSED/.test(e.message); }
  ok(refused, 'tokenForSpawn(a1) refuses the paused account and names the pause');

  const picked = await tokenForSpawn(PID, 'claude');
  ok(picked.id === a2, 'generic pick skips the paused account and takes the active sibling');

  console.log('\n── pause every account: the provider as a whole is disabled ──');
  await setProviderAccountPaused(PID, a2, true, { by: 'mark@console' });
  listed = (await listProviderTokens(PID)).find((p) => p.provider === 'claude');
  ok(listed.all_paused === true, 'read model: all_paused when every account is paused');

  refused = false;
  try { await tokenForSpawn(PID, 'claude'); } catch (e) { refused = /PAUSED/.test(e.message); }
  ok(refused, 'generic pick refuses when every claude account is paused');

  refused = false;
  try { await spawnCreds(PID, 'claude', { tokenId: a1 }); } catch (e) { refused = /PAUSED/.test(e.message); }
  ok(refused, 'spawnCreds (the cxell spawn path) refuses a paused pinned account');

  refused = false;
  try { await assertProviderDispatchable(PID, 'claude'); } catch (e) { refused = /PAUSED/.test(e.message); }
  ok(refused, 'assertProviderDispatchable refuses an all-paused provider (covers remote/local runtimes)');

  console.log('\n── a provider with no accounts is not "all paused" (claude remote/local need no token) ──');
  let noAcctThrew = false;
  try { await assertProviderDispatchable(PID, 'deepseek'); } catch { noAcctThrew = true; }
  ok(!noAcctThrew, 'assertProviderDispatchable does not throw for a type with no accounts');

  console.log('\n── resume: the account is dispatchable again ──');
  await setProviderAccountPaused(PID, a1, false, { by: 'mark@console' });
  const resumed = await tokenForSpawn(PID, 'claude', { tokenId: a1 });
  ok(resumed.id === a1, 'after resume, tokenForSpawn accepts the account again');
  listed = (await listProviderTokens(PID)).find((p) => p.provider === 'claude');
  ok(listed.accounts.find((a) => a.id === a1).paused === false && listed.all_paused === false,
     'read model: resume clears paused and all_paused');

  console.log('\n── paused accounts are still deletable ──');
  await setProviderAccountPaused(PID, a2, true, { by: 'mark@console' });
  await client.query(`DELETE FROM provider_token WHERE id = $1`, [a2]);
  listed = (await listProviderTokens(PID)).find((p) => p.provider === 'claude');
  ok(listed.accounts.length === 1, 'a paused account can be deleted like any other');
} finally {
  await client.query(`DELETE FROM provider_token WHERE project_id = $1`, [PID]).catch(() => {});
  await client.query(`DELETE FROM project WHERE id = $1`, [PID]).catch(() => {});
  await client.end();
}

console.log(fail ? `\n✗ ${fail} check(s) FAILED` : '\n✓ provider pause: all checks passed');
process.exit(fail ? 1 : 0);

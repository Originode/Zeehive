// AUTO-SEED / AUTO-DONE — the project-scoped operator policies that skip the human gate for
// prod seeds and for manager-raised done suggestions (migration 122).
//
// The landing gate already had auto-approve switches for landings and ships (022); this adds the
// two flanking ones, and this test proves each does what it says while the guards stay intact:
//   1. auto_approve_seed=ON → a prod-seed request is approved AND RUN with no human — status
//      'seeded', decided_by 'auto-approve@policy'. The anti-band-aid rule for data is untouched:
//      an UNLANDED seed file is still refused even under the policy.
//   2. auto_done=ON → a MANAGER's done suggestion is confirmed automatically — the target xell is
//      retired and its task marked done, decided_by 'auto-done@policy'. The reap's own guard is
//      untouched: a genuinely mid-turn (status 'working') xell is STILL refused, and its card stays
//      open for a human. And a WORKER's own `zee done` is a different path entirely — there is no
//      done_suggestion row at all, so the policy cannot touch it.
// Everything it creates is torn down in a finally, whatever happens.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.SEED_MODE = 'simulate';        // never touch a real database
process.env.PROVISION_MODE = 'simulate';   // never tear down a real machine
process.env.PRODRO_MODE = 'simulate';
process.env.TKB_NOTIFY = '0';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

const client = new pg.Client({ connectionString: url });
const tmp = mkdtempSync(join(tmpdir(), 'autopolicy-'));
const PID = '00000000-0000-4000-8000-00000000f111';    // fixed ids so cleanup is total even on crash
const ids = { xource: '00000000-0000-4000-8000-00000000f222',
  site: '00000000-0000-4000-8000-00000000f333' };
const MID = '00000000-0000-4000-8000-00000000f444';    // manager xell
const TID = '00000000-0000-4000-8000-00000000f555';    // idle worker xell (reapable)
const BID = '00000000-0000-4000-8000-00000000f666';    // busy worker xell (not reapable)
const XID = '00000000-0000-4000-8000-00000000f777';    // seed-asking xell

async function cleanup({ files = false } = {}) {
  try { await client.query(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* */ }
  if (files) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } }
}

try {
  await client.connect();
  await cleanup();

  // ── a real git repo with a LANDED seed file on master ──
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  mkdirSync(join(repo, 'server', 'sql', 'seeds'), { recursive: true });
  writeFileSync(join(repo, 'server/sql/seeds/2026-08-03-lookups.sql'),
    "INSERT INTO lookup (k) VALUES ('auto') ON CONFLICT DO NOTHING;\n");
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'landed seed');
  const head = git(repo, 'rev-parse', 'HEAD');

  const wt = join(tmp, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'spinoff/autoseed', wt, 'master');
  // an UNLANDED seed: committed on the branch only
  writeFileSync(join(wt, 'server/sql/seeds/9999-not-landed.sql'), 'SELECT 1;\n');
  git(wt, 'add', '-A'); git(wt, 'commit', '-qm', 'unlanded seed');

  // ── the isolated project: prod site + prod db row (simulate never inspects docker) ──
  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,'autopolicy-test',$2,'master','autopolicy','postgres')`, [PID, repo]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [ids.xource, PID]);
  await client.query(
    `INSERT INTO deploy_site (id, project_id, key, tier, is_default) VALUES ($1,$2,'local','prod',true)`,
    [ids.site, PID]);
  await client.query(
    `INSERT INTO container (project_id, role, tier, isolation, name, site_id, health, conn_ref)
       VALUES ($1,'db','prod','shared','autopolicy_db_prod',$2,'up','postgresql://postgres@autopolicy-db:5432/autopolicy')`,
    [PID, ids.site]);
  const seedXell = (await client.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled)
       VALUES ($1,$2,'autoseed','spinoff/autoseed',$3,'working',false) RETURNING id`,
    [PID, ids.xource, wt])).rows[0].id;

  const mgr = (await client.query(
    `INSERT INTO xell (id, project_id, xource_id, slug, branch, status, is_pooled, zee_type)
       VALUES ($1,$2,$3,'automgr','spinoff/automgr','working',false,'manager') RETURNING *`,
    [MID, PID, ids.xource])).rows[0];
  const worker = (await client.query(
    `INSERT INTO xell (id, project_id, xource_id, slug, branch, status, is_pooled, zee_type, manager_xell_id)
       VALUES ($1,$2,$3,'autowork','spinoff/autowork','working',false,'worker',$4) RETURNING *`,
    [TID, PID, ids.xource, MID])).rows[0];
  const busy = (await client.query(
    `INSERT INTO xell (id, project_id, xource_id, slug, branch, status, is_pooled, zee_type, manager_xell_id)
       VALUES ($1,$2,$3,'autobusy','spinoff/autobusy','working',false,'worker',$4) RETURNING *`,
    [BID, PID, ids.xource, MID])).rows[0];
  const mkZee = (xell, status, cliActive) => client.query(
    `INSERT INTO zee (xell_id, attach_mode, status, kind, entrypoint, cli_active, monitor_source,
                      last_monitor_at, last_event_at, viewer_kind)
       VALUES ($1,'headless-spawn',$2,'cxell','cxell-cli',$3,'cxell-pgrep',now(),now(),'none')`,
    [xell.id, status, cliActive]);
  await mkZee(worker, 'idle', true);   // finished its turn, sitting in an attached cxell → reapable
  await mkZee(busy, 'working', true);  // genuinely mid-turn → must be refused
  const mkTask = (xell) => client.query(
    `INSERT INTO task (project_id, xell_id, prompt_text, status) VALUES ($1,$2,'do the thing','working')`,
    [PID, xell.id]);
  await mkTask(worker); await mkTask(busy);

  const { requestProdSeed } = await import('../server/src/queenzee/seedgate.js');
  const { suggestDone } = await import('../server/src/lib/managers.js');

  const seedRow = async (id) => (await client.query(`SELECT * FROM prod_seed_request WHERE id=$1`, [id])).rows[0];
  const xellStatus = async (id) => (await client.query(`SELECT status FROM xell WHERE id=$1`, [id])).rows[0].status;

  // ── 1. auto_approve_seed ────────────────────────────────────────────────────
  console.log('\n── auto_approve_seed ──');
  // OFF by default: the same file is HELD.
  const off = await requestProdSeed({ xellId: seedXell, files: ['2026-08-03-lookups.sql'], reason: 'baseline' });
  ok(off.request?.status === 'pending', 'with the policy OFF a seed request is still HELD pending a human');
  ok(off.request?.decided_by == null, '…and nothing decided it');

  // Flipping the switch does NOT retroactively decide old asks — the baseline stays pending.
  await client.query(`UPDATE project SET auto_approve_seed=true WHERE id=$1`, [PID]);
  const firstRow = await seedRow(off.request.id);
  ok(firstRow.status === 'pending', 'flipping the switch does NOT auto-decide an already-open ask');
  const { decideProdSeed } = await import('../server/src/queenzee/seedgate.js');
  await decideProdSeed(off.request.id, 'rejected', 'test@human');   // clear it so a fresh ask can be filed

  // Unlanded is refused even under the policy — the anti-band-aid rule is not the part being skipped.
  const unlanded = await requestProdSeed({ xellId: seedXell, files: ['9999-not-landed.sql'], reason: 'nope' });
  ok(unlanded.ok === false && /not on master/.test(unlanded.reason || ''),
     'an UNLANDED seed is STILL refused under auto-seed (the queenzee runs only landed files)');

  // A landed seed under the policy → auto-approved AND RUN in one call.
  const auto = await requestProdSeed({ xellId: seedXell, files: ['2026-08-03-lookups.sql'], reason: 'auto me' });
  ok(auto.ok === true && auto.request?.status === 'seeded',
     `auto-seed: a landed seed request is approved AND RUN in one call (status ${auto.request?.status})`);
  ok(auto.request?.decided_by === 'auto-approve@policy', '…and the audit trail says the policy decided it');
  ok(auto.request?.result?.applied?.length === 1 && auto.request.result.applied[0].ok === true,
     '…and the per-file run outcome is recorded (SEED_MODE=simulate)');

  // ── 2. auto_done ────────────────────────────────────────────────────────────
  console.log('\n── auto_done ──');
  // OFF by default: a manager's suggestion is HELD.
  const offDone = await suggestDone({ manager: mgr, target: worker, reason: 'baseline' });
  ok(offDone.suggestion?.status === 'pending', 'with the policy OFF a done suggestion is still HELD pending a human');
  ok(offDone.suggestion?.decided_by == null, '…and nothing decided it');

  // Clear the baseline so a fresh suggestion can be raised under the policy.
  const { decideDoneSuggestion } = await import('../server/src/lib/managers.js');
  await decideDoneSuggestion(offDone.suggestion.id, 'rejected', 'test@human');

  // ON → a manager's suggestion is confirmed automatically, and the finished xell is closed.
  await client.query(`UPDATE project SET auto_done=true WHERE id=$1`, [PID]);
  const autoDone = await suggestDone({ manager: mgr, target: worker, reason: 'auto-close me' });
  ok(autoDone.ok === true && autoDone.suggestion?.status === 'approved',
     `auto-done: a manager's done suggestion is confirmed automatically (status ${autoDone.suggestion?.status})`);
  ok(autoDone.suggestion?.decided_by === 'auto-done@policy', '…and the audit trail says the policy decided it');
  ok(autoDone.suggestion?.result?.ok === true, '…and the reap actually succeeded');
  ok(await xellStatus(worker.id) === 'retired', '…and the finished xell is retired');
  ok((await client.query(`SELECT status FROM task WHERE xell_id=$1`, [worker.id])).rows[0].status === 'done',
     '…and its task is marked done');
  const { inboxFor } = await import('../server/src/lib/managers.js');
  const mgrBox = await inboxFor(mgr.id);
  ok(mgrBox.some((m) => /auto-done policy/.test(m.body) && /CONFIRMED/.test(m.body) && /autowork/.test(m.body)),
     '…and the manager is told the AUTO-DONE POLICY confirmed it, not a human');

  // The reap's own guard is untouched: a genuinely mid-turn xell is still refused, and the card
  // stays OPEN for a human rather than being consumed by a refusal (done-suggestion-refused-reap).
  const busyDone = await suggestDone({ manager: mgr, target: busy, reason: 'this one is busy' });
  ok(busyDone.ok === true && busyDone.suggestion?.status === 'pending',
     'a mid-turn xell is STILL refused under auto-done — the suggestion stays a pending card');
  ok(await xellStatus(busy.id) === 'working', '…and the busy xell is untouched');

  console.log(fail ? `\n${fail} check(s) FAILED` : '\nall checks passed');
} catch (err) {
  console.error('\nTEST ERROR:', err);
  fail++;
} finally {
  await cleanup({ files: true });
  await client.end().catch(() => {});
}
process.exit(fail ? 1 : 0);

// A REPAIRED HARNESS REACHES THE ZEES ALREADY RUNNING — not just the next ones.
//
// This is the last thread of ticket #1. The manual was fixed in the DB and the fleet stayed broken,
// because the harness files are materialized into a xell at DISPATCH: a zee already working kept the
// persona it was born with. "New zees only" is exactly what left every manager zee briefed on
// nothing for weeks, and the injection path into a live cxell already existed (a harness re-assign
// uses it) — so this is wiring, not machinery.
//
// SINCE MIGRATION 080 the trigger is a SAVE, not a boot refresh: the meta-DB owns a harness's text,
// so updateHarness() — the console's harness manager, or a migration followed by one — is the only
// way it ever moves, and therefore the only place that can push it into a running zee.
//
// The two conditions on that wiring are what this test is really about:
//   1. ONLY WHEN THE BUNDLE CHANGED. A save that no-ops must write NOTHING into a running zee's
//      worktree — a zee's workspace is its own, and a queenzee reaching into it uninvited is worse
//      than the bug.
//   2. IT IS LOGGED. A file appearing under a live zee is otherwise indistinguishable from the zee
//      having written it.
// Plus the inheritance case: a child harness's effective persona is the merged chain, so repairing a
// PARENT changes what a xell wearing the CHILD should hold.
//
// (This file used to build harness FOLDERS in a throwaway repo and call refreshHarnesses(). There are
// no harness folders any more — the rows below carry their own text, which is the point of 080.)
//
// Every call below passes `mode: 'real'` EXPLICITLY, because there is now a fourth rule and it is
// the default: the injection obeys PROVISION_MODE, so a NESTED queenzee (whose fleet rows are the
// REAL fleet's — a xell's db is a clone of the meta-DB) only reports what it would have written.
// This file is the LIVE half of that contract and must keep saying so out loud; the simulate half
// is test/nested-queenzee-fleet-guard.test.mjs.
//
// No docker in a cxell, so the final `docker exec` cannot run here — which makes this the perfect
// place to pin the THIRD rule: when the write cannot be performed, the log must SAY so. Reporting
// "re-injected 0 file(s)" as a success is worse than silence: it tells a human a running zee holds
// files it does not hold. So the assertions below are about SELECTION (which xells) and HONESTY
// (what each outcome is called), with the docker exec itself as the boundary.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { config } = await import('../server/src/config.js');
const { q, one, pool } = await import('../server/src/db/pool.js');
const { recentLogs } = await import('../server/src/lib/logbus.js');
const H = await import('../server/src/lib/harness.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const REAL_ROOT = config.repoRoot;
const tag = randomUUID().slice(0, 8);
const parentKey = `zt-par-${tag}`;      // the one that gets repaired
const childKey = `zt-kid-${tag}`;       // inherits it — its effective persona changes too
const KEYS = [parentKey, childKey];
const tmp = mkdtempSync(join(tmpdir(), 'reinject-'));
const repo = join(tmp, 'repo');
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
const since = () => recentLogs(400).length;
const linesSince = (n) => recentLogs(400).slice(n).filter((l) => l.scope === 'harness').map((l) => l.msg);

let projId = null;
const madeXells = [];

try {
  // ── two DB-OWNED harnesses (parent + a child that inherits it) and xells wearing them ───────
  mkdirSync(repo, { recursive: true });
  git('init', '-q', '-b', 'master'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), 'reinject fixture\n');
  git('add', '-A'); git('commit', '-qm', 'base');

  projId = (await one(`INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'master') RETURNING id`,
    [`zt-reinj-${tag}`, repo])).id;
  const xource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [projId]);
  const bundleV1 = (key) => JSON.stringify({
    label: key, summary: 'fixture', zee_type: 'worker', personality: `persona v1 ${tag}`,
    skills: [{ name: 'zt-skill', when: 'd', body: 'body v1' }],
  });
  const parentH = await one(
    `INSERT INTO harness (key,label,bundle,bundle_hash,enabled,is_law_core) VALUES ($1,$1,$2,'v1',true,false) RETURNING id`,
    [parentKey, bundleV1(parentKey)]);
  const childH = await one(
    `INSERT INTO harness (key,label,bundle,bundle_hash,enabled,is_law_core,parent_id) VALUES ($1,$1,$2,'v1',true,false,$3) RETURNING id`,
    [childKey, bundleV1(childKey), parentH.id]);

  const mkXell = async (slug, harnessId, { live = false } = {}) => {
    const x = await one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, harness_id)
         VALUES ($1,$2,$3,$4,$5,'working',false,$6) RETURNING id, slug`,
      [projId, xource.id, slug, `spinoff/${slug}`, join(tmp, slug), harnessId]);
    madeXells.push(x.id);
    if (live) {
      // what "a live zee" means to the injector: a cxell-cli zee, still running, ssh-terminal viewer
      await q(`INSERT INTO zee (xell_id, runtime_id, attach_mode, status, entrypoint, viewer_kind)
               VALUES ($1, (SELECT id FROM agent_runtime LIMIT 1), 'headless-spawn', 'working', 'cxell-cli', 'ssh-terminal')`, [x.id]);
    }
    return x;
  };
  const wearer = await mkXell(`zt-wear-${tag}`, parentH.id, { live: true });   // wears the repaired one
  const heir = await mkXell(`zt-heir-${tag}`, childH.id, { live: true });      // wears its CHILD
  const asleep = await mkXell(`zt-idle-${tag}`, parentH.id);                   // no live zee at all

  // ── 1. a SAVE that changes the parent's text ────────────────────────────────────────────────
  console.log('\n── saving a harness edit reaches the zees already running ──');
  let n = since();
  await H.updateHarness(parentKey, { personality: `persona v2 ${tag}` }, { mode: 'real' });
  let log = linesSince(n);
  // each LIVE wearer is acted on and named. In this cage the docker write cannot succeed, so the
  // outcome must be the honest failure line rather than a claim of success.
  const touched = (slug) => log.filter((m) => m.startsWith(`${slug}:`));
  ok(touched(wearer.slug).length > 0, 'the xell WEARING the repaired harness is acted on while it runs');
  ok(touched(heir.slug).length > 0, 'and so is one wearing a harness that INHERITS it (its effective persona changed too)');
  // (the per-file "could not inject X" lines come from the injector itself; the DECISION lines are
  // the ones a human scans, and each of those must carry the cause)
  const decisions = (slug) => touched(slug).filter((m) => /re-injected|injection FAILED|no files to inject/.test(m));
  ok(decisions(wearer.slug).length > 0 && decisions(wearer.slug).every((m) => /harness ".*" changed/.test(m)),
     'every decision line says WHY it happened — a file appearing under a live zee must not look self-written');
  ok(touched(wearer.slug).some((m) => /injection FAILED/.test(m) && /still on its OLD persona/.test(m)),
     'with no docker reachable it reports the FAILURE and the consequence, never "re-injected 0 file(s)"');
  ok(!touched(wearer.slug).some((m) => /re-injected 0 file/.test(m)), 'and never claims a write that did not happen');
  ok(log.some((m) => m.includes(asleep.slug) && /next dispatch/.test(m)),
     'a xell with no live zee is reported as picking it up at its next dispatch, not silently dropped');
  ok(log.some((m) => m.includes(parentKey) && /updated harness/.test(m)), 'the save itself is logged');

  // ── 2. a save that changes NOTHING must not touch a running zee's worktree ──────────────────
  console.log('\n── and a no-op save writes nothing at all ──');
  n = since();
  await H.updateHarness(parentKey, { personality: `persona v2 ${tag}` }, { mode: 'real' });   // same text again
  log = linesSince(n);
  ok(!log.some((m) => /re-injected|injection FAILED/.test(m)), 'no injection attempt at all: nothing changed, nothing written');
  ok(!log.some((m) => /next dispatch/.test(m)), 'and nothing is even considered — the whole path is skipped');
  ok(log.some((m) => /updated harness/.test(m)), 'the save itself still happened (it was simply identical)');

  // ── 3. edit ONE harness: only that harness's wearers are touched ─────────────────────────────
  console.log('\n── editing one harness only re-injects the xells that wear it (or inherit it) ──');
  n = since();
  await H.updateHarness(parentKey, { personality: `persona v3 ${tag}` }, { mode: 'real' });
  log = linesSince(n);
  const hit = log.filter((m) => /re-injected|injection FAILED|next dispatch/.test(m));
  ok(hit.some((m) => m.includes(wearer.slug)), 'the wearer of the edited harness is re-injected');
  ok(hit.some((m) => m.includes(heir.slug)), 'the heir too — a parent edit changes the child chain');
  ok(!log.some((m) => new RegExp(`updated harness "${childKey}"`).test(m)),
     'the CHILD row is not itself rewritten (only its parent moved — the heir inherits the change)');

  // ── 4. the selector is callable on its own, and answers with the counts ─────────────────────
  const direct = await H.reinjectHarnessIntoLiveXells(parentH.id, { mode: 'real' });
  ok(direct.xells === 3 && direct.injected + direct.failed + direct.skipped === 3,
     `reinjectHarnessIntoLiveXells() covers every wearer incl. heirs, and every one is accounted for `
     + `(${direct.xells} xells: ${direct.injected} injected, ${direct.failed} failed, ${direct.skipped} not live)`);
  ok(direct.failed === 2 && direct.skipped === 1,
     'the two LIVE zees are counted as failures here (no docker in a cage), the sleeping one as not-live');
  const none = await H.reinjectHarnessIntoLiveXells(randomUUID(), { mode: 'real' });
  ok(none.xells === 0 && none.injected === 0, 'and a harness nobody wears is a clean no-op');
} finally {
  for (const id of madeXells) await q(`DELETE FROM zee WHERE xell_id=$1`, [id]).catch(() => {});
  for (const id of madeXells) await q(`DELETE FROM xell WHERE id=$1`, [id]).catch(() => {});
  if (projId) await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  await q(`DELETE FROM harness WHERE key = ANY($1)`, [KEYS]).catch(() => {});
  config.repoRoot = REAL_ROOT;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  await pool.end().catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

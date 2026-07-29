// A HARNESS NEEDS NO REPO — nothing about it is on any filesystem.
//
// This file used to reproduce the deployed-queenzee bug from the other side: a file-backed harness's
// `dir` was resolved against the ZEEHIVE PROJECT's repo_root, not config.repoRoot, because
// Dockerfile.server copies server/ scripts/ db/ hooks/ skill/ into /app and deliberately NOT
// harnesses/ — so the deployed queenzee looked under /app, found nothing, and dispatched manager zees
// with no manual for weeks while every test on a checkout passed.
//
// Migrations 080 and 082 removed the class of bug rather than the instance: the meta-DB owns a
// harness's TEXT *and* its badge SVG (an SVG is text), `harnesses/` is gone from the repo entirely, and
// lib/harness.js reads no filesystem at all. So what this test pins now is the invariant that replaced
// the old resolution rules:
//
//   1. a container with NO harnesses/ anywhere — no project repo, no runtime copy — still briefs a
//      zee completely: the manager's persona, its skill and its 15k manual all come out of the row;
//   2. the files a cxell receives are GENERATED from that row, and each one says so (the banner is
//      what stops a zee "fixing" a page that is regenerated on the next assignment);
//   3. nothing is file-backed any more, and the read models no longer report a files_missing state
//      that cannot happen;
//   4. the AVATAR is served from the row and validated as an SVG — the badge cannot 404 because a
//      repo is unreadable, which is what it did on every project whose console could not see this one;
//   5. an empty row is still LOUD (that half of the old bug is real and unchanged): bundle_empty on
//      the read models and the boot summary naming the key.
//
// Every row it creates is torn down in a finally, and the harness rows it touches are restored.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const hollowKey = `zt-hollow-${tag}`;         // a row with nothing in it — the one empty state left
const tmp = mkdtempSync(join(tmpdir(), 'harn-root-'));
const runtime = join(tmp, 'app');             // the IMAGE: server code, no harnesses/
const projectRepo = join(tmp, 'repo');        // a project repo with NOTHING harness-shaped in it
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

let projId = null, projName = null;
const snapshot = await q(`SELECT id, bundle, bundle_hash, label, parent_id, zee_type, dir FROM harness`);

try {
  // ── the deployed container, reproduced — and this time nothing needs the folder ─────────────
  mkdirSync(join(runtime, 'server', 'src'), { recursive: true });   // /app: code only
  mkdirSync(projectRepo, { recursive: true });
  writeFileSync(join(projectRepo, 'README.md'), `a project repo with no harnesses/ at all ${tag}\n`);
  git(projectRepo, 'init', '-q', '-b', 'master');
  git(projectRepo, 'config', 'user.email', 't@t'); git(projectRepo, 'config', 'user.name', 't');
  git(projectRepo, 'add', '-A'); git(projectRepo, 'commit', '-qm', 'base');

  // The self project is 'Zeehive' — use that name when it is free (the real resolution path), a
  // unique one when this DB already has it (a dev's own checkout), so the test never collides.
  projName = (await one(`SELECT id FROM project WHERE lower(name)='zeehive'`)) ? `zt-harnroot-${tag}` : 'Zeehive';
  projId = (await one(`INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'master') RETURNING id`,
    [projName, projectRepo])).id;
  await q(`INSERT INTO harness (key,label,bundle,enabled,is_law_core) VALUES ($1,$2,'{}'::jsonb,true,false)`,
    [hollowKey, `Hollow ${tag}`]);

  config.repoRoot = runtime;                  // ← the line that used to be the whole bug
  ok(!existsSync(join(config.repoRoot, 'harnesses')),
     'the runtime root carries NO harnesses/ folder (the deployed server image)');
  ok(!existsSync(join(projectRepo, 'harnesses')),
     'and neither does the project repo — since 082 there is nothing harness-shaped on any disk');
  ok(!existsSync(join(REAL_ROOT, 'harnesses')),
     'not even in this checkout: harnesses/ is gone from the repo entirely');

  // ── 1. the row briefs the zee, with no folder anywhere ──────────────────────────────────────
  console.log('\n── the manager harness is complete with no harnesses/ text on any disk ──');
  const row = await one(`SELECT * FROM harness WHERE key='manager'`);
  ok(row.dir === null, 'the row is DB-owned (dir IS NULL) — nothing projects over it');
  const full = await H.getHarnessFull('manager');
  ok(!!full.glyph, `glyph: ${full.glyph || '(EMPTY)'}`);
  ok(full.summary.length > 20, `summary: ${full.summary.slice(0, 60) || '(EMPTY)'}…`);
  ok(full.personality.length > 800, `personality: ${full.personality.length} chars (the ~960-char persona)`);
  const skill = full.skills.find((s) => /dispatch-brief/.test(s.name));
  ok(!!skill?.body, `the dispatch-brief skill is there (${skill?.body?.length || 0} chars of body)`);
  const manual = full.memory.find((m) => /manager-zee-manual/.test(m.path));
  ok((manual?.text || '').length > 12000, `the manager-zee-manual.md memory is there (${manual?.text?.length || 0} chars)`);
  ok(/zee dispatch/.test(manual?.text || '') && /ZERO push access/.test(manual?.text || ''),
     'and it is the real manual (it teaches `zee dispatch` and the zero-push rule)');
  ok(full.zee_type === 'manager', 'the 054 type pairing is on the row');
  ok(full.bundle_empty === false, 'the read model reports it as carrying something');

  // ── 2. the files a cxell gets are GENERATED from the row, and say so ────────────────────────
  console.log('\n── it materializes into a cxell as generated files ──');
  const files = H.harnessFiles(await H.effectiveHarness(row));
  const rels = files.map((f) => f.relPath);
  for (const want of ['.zeehive/harness/PERSONA.md', '.zeehive/harness/memory/manager-zee-manual.md',
                      '.claude/skills/dispatch-brief/SKILL.md']) {
    ok(rels.includes(want), `harnessFiles() materializes ${want}`);
  }
  const manualFile = files.find((f) => f.relPath === '.zeehive/harness/memory/manager-zee-manual.md');
  ok((manualFile?.text || '').length > 12000, 'the materialized manual carries the whole text (not an empty file)');
  ok(manualFile.text.includes(manual.text), 'and it is the row\'s text, verbatim');
  // the banner is the anti-"I fixed the manual and nothing happened" guard
  ok(/^<!-- GENERATED by ZEEHIVE from the meta-DB/.test(manualFile.text),
     'every generated file OPENS with the stamp (a reader sees it before the content)');
  ok(/harness `manager`/.test(manualFile.text) && /memory `memory\/manager-zee-manual\.md`/.test(manualFile.text),
     'naming the harness and the entry it was generated from');
  ok(/Editing THIS copy changes nothing/.test(manualFile.text) && /harness manager/.test(manualFile.text),
     'and saying an edit here is overwritten, plus where the real source is');
  const skillFile = files.find((f) => f.relPath === '.claude/skills/dispatch-brief/SKILL.md');
  ok(skillFile.text.startsWith('---\nname: dispatch-brief'),
     'a SKILL.md still leads with its frontmatter (the banner goes below, or a provider stops seeing a skill)');
  ok(skillFile.text.includes('GENERATED by ZEEHIVE'), 'but it carries the stamp too');

  // provenance: an INHERITED entry names the harness that owns it, not the one being worn
  const leadFiles = H.harnessFiles(await H.effectiveHarness(await one(`SELECT * FROM harness WHERE key='dev-lead'`)));
  const leadManual = leadFiles.find((f) => f.relPath.endsWith('manager-zee-manual.md'));
  ok(!!leadManual && /harness `manager`/.test(leadManual.text),
     'a harness that INHERITS the manual stamps it with the parent that owns it (dev-lead → manager)');

  // ── 3. nothing is file-backed, and the impossible state is not reported ─────────────────────
  console.log('\n── no harness is file-backed any more ──');
  const backed = await one(`SELECT count(*)::int AS n FROM harness WHERE dir IS NOT NULL`);
  ok(backed.n === 0, `no harness row carries a dir (${backed.n})`);
  const list = await H.listHarnesses();
  ok(list.length > 0 && list.every((h) => !('files_missing' in h) && !('file_backed' in h)),
     'and the read model reports neither files_missing nor file_backed — states that can no longer exist');
  ok(typeof H.loadHarnessDir === 'undefined' && typeof H.refreshHarnesses === 'undefined',
     'the folder loader and the boot projection are GONE from the module, not merely unused');

  // ── 4. the badge, now also in the row ───────────────────────────────────────────────────────
  console.log('\n── the avatar is served from the meta-DB, not resolved on disk ──');
  const mgrRow = await one(`SELECT bundle, avatar_path FROM harness WHERE key='manager'`);
  ok(mgrRow.avatar_path === null, 'no row points at a file (avatar_path is legacy and NULL)');
  const svg = H.harnessAvatarSvg(mgrRow.bundle);
  ok(!!svg && /^<svg[\s>]/i.test(svg), `the badge comes out of the row as an SVG (${(svg || '').length} chars)`);
  ok(!!full.avatar_svg && full.avatar_svg === svg, 'and the editor read model carries it, so the console can change it');
  ok((await H.listHarnesses()).find((h) => h.key === 'manager')?.avatar_url === '/api/harnesses/manager/avatar',
     'the list model advertises the badge route for a harness that has one');
  ok((await H.listHarnesses()).find((h) => h.key === 'dev-scribe')?.avatar_url === null,
     'and null for one that has none — the console does not request an image that cannot exist');
  // it is served to a browser, so what counts as a badge is validated where it is read
  ok(H.harnessAvatarSvg({ avatar_svg: '<script>alert(1)</script>' }) === null, 'a non-SVG stored badge is refused');
  ok(H.harnessAvatarSvg({}) === null && H.harnessAvatarSvg(null) === null, 'and a missing one is simply null');
  const badSave = await H.updateHarness('manager', { avatar_svg: 'not an svg' }).catch((e) => e.message);
  ok(/must be an SVG/.test(String(badSave)), `the authoring path refuses it too, with a sentence ("${String(badSave).slice(0, 40)}…")`);
  ok(typeof H.harnessAvatarFile === 'undefined' && typeof H.harnessBase === 'undefined',
     'the on-disk avatar resolution and its repo-root machinery are GONE from the module');

  // ── 5. an EMPTY row is still loud ───────────────────────────────────────────────────────────
  console.log('\n── a harness that would brief a zee with nothing is still loud ──');
  const hollow = (await H.listHarnesses()).find((x) => x.key === hollowKey);
  ok(hollow?.bundle_empty === true, 'GET /api/harnesses reports bundle_empty for a row with nothing in it');
  const before = recentLogs(300).length;
  const sum = await H.logHarnessSummary();
  const lines = recentLogs(300).slice(before).filter((l) => l.scope === 'harness').map((l) => l.msg);
  ok(lines.some((m) => /^harnesses: /.test(m) && m.includes(hollowKey)),
     'and the boot summary names it — the empty half of the old bug is unchanged');
  ok(sum.empty >= 1 && !sum.empty_keys.some((k) => k.startsWith('manager')),
     `the healthy ones are counted as loaded (${sum.loaded} loaded, ${sum.empty} empty)`);

  // ── the fallback root still works (host-process mode) ───────────────────────────────────────
  console.log('\n── and with no project row at all, a harness is still complete ──');
  await q(`DELETE FROM project WHERE id=$1`, [projId]); projId = null;
  const orphaned = await H.getHarnessFull('manager');
  ok(orphaned.personality.length > 800 && orphaned.memory.some((m) => (m.text || '').length > 12000),
     'no project, no repo, no folder: the persona and the manual come out of the row regardless');
  ok(!!H.harnessAvatarSvg((await one(`SELECT bundle FROM harness WHERE key='manager'`)).bundle),
     'and so does the badge — this is the state every other project\'s console was failing in');
} finally {
  config.repoRoot = REAL_ROOT;
  if (projId) await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  await q(`DELETE FROM harness WHERE key=$1`, [hollowKey]).catch(() => {});
  // put every harness row back exactly as we found it
  for (const r of snapshot) {
    await q(`UPDATE harness SET bundle=$2, bundle_hash=$3, label=$4, parent_id=$5, zee_type=$6, dir=$7 WHERE id=$1`,
      [r.id, JSON.stringify(r.bundle), r.bundle_hash, r.label, r.parent_id, r.zee_type, r.dir]).catch(() => {});
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  await pool.end().catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

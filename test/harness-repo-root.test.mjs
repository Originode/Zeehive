// HARNESS FOLDER RESOLUTION — the deployed-queenzee bug, reproduced.
//
// A file-backed harness's `dir` ('harnesses/manager') is relative to the ZEEHIVE PROJECT's repo
// (project.repo_root — the clone self-onboard.js registers), NOT to config.repoRoot, which is only
// where the running server's code sits. On a checkout those are the same folder, which is exactly
// why test/manager-zee.test.mjs passed while production was broken: Dockerfile.server copies
// server/ scripts/ db/ hooks/ skill/ into /app and deliberately NOT harnesses/, so the deployed
// queenzee resolved every harness folder under /app, found none, and kept the EMPTY seed bundle —
// manager zees were dispatched with no manual at all.
//
// This test reproduces that container: a config.repoRoot with NO harnesses/ folder, plus a project
// row whose repo_root DOES have one. It asserts:
//   1. refreshHarnesses() populates `manager` from the PROJECT repo (label, glyph, summary, the
//      full personality, the dispatch-brief skill, the 12.9k manual, bundle_hash + head_commit);
//   2. harnessFiles() materializes PERSONA.md, the manual and the SKILL.md into a cxell;
//   3. the resolution really came from the project row (a probe harness that exists ONLY there);
//   4. the avatar resolves from the same base, and stays containment-guarded;
//   5. an unreadable folder is LOUD: last good bundle kept, a logline naming the key, and
//      files_missing / bundle_empty on the read models;
//   6. the fallback still works: no project row → config.repoRoot (host-process mode).
// Every row it creates is torn down in a finally, and the harness rows it touches are restored.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { config } = await import('../server/src/config.js');
const { q, one, pool } = await import('../server/src/db/pool.js');
const { recentLogs } = await import('../server/src/lib/logbus.js');
const H = await import('../server/src/lib/harness.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const REAL_ROOT = config.repoRoot;
const tag = randomUUID().slice(0, 8);
const probeKey = `zt-probe-${tag}`;           // a harness folder that exists ONLY in the project repo
const ghostKey = `zt-ghost-${tag}`;           // a harness whose folder exists nowhere
const tmp = mkdtempSync(join(tmpdir(), 'harn-root-'));
const runtime = join(tmp, 'app');             // the IMAGE: server code, no harnesses/
const projectRepo = join(tmp, 'repo');        // the PROJECT repo: harnesses/ live here
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

let projId = null, projName = null;
const snapshot = await q(`SELECT id, bundle, bundle_hash, head_commit, avatar_path, label, parent_id, zee_type FROM harness`);

try {
  // ── the deployed container, reproduced ─────────────────────────────────────
  mkdirSync(join(runtime, 'server', 'src'), { recursive: true });   // /app: code only
  mkdirSync(projectRepo, { recursive: true });
  cpSync(join(REAL_ROOT, 'harnesses'), join(projectRepo, 'harnesses'), { recursive: true });
  // a probe harness that exists in the PROJECT repo and nowhere else — it is the proof that the
  // resolution went through project.repo_root rather than stumbling onto some other checkout.
  const probeDir = join(projectRepo, 'harnesses', probeKey);
  mkdirSync(join(probeDir, 'skills', 'probe-skill'), { recursive: true });
  writeFileSync(join(probeDir, 'HARNESS.yml'),
    `version: 1\nlabel: Probe ${tag}\nglyph: "🛰"\nsummary: proof the project repo was read\nzee_type: worker\n`);
  writeFileSync(join(probeDir, 'PERSONALITY.md'), `probe personality ${tag}\n`);
  writeFileSync(join(probeDir, 'skills', 'probe-skill', 'SKILL.md'),
    `---\nname: probe-skill\ndescription: proves skills load from the project repo\n---\n\nprobe body ${tag}\n`);
  git(projectRepo, 'init', '-q', '-b', 'master');
  git(projectRepo, 'config', 'user.email', 't@t'); git(projectRepo, 'config', 'user.name', 't');
  git(projectRepo, 'add', '-A'); git(projectRepo, 'commit', '-qm', 'harnesses');

  // The self project is 'Zeehive' — use that name when it is free (the real resolution path), a
  // unique one when this DB already has it (a dev's own checkout), so the test never collides.
  projName = (await one(`SELECT id FROM project WHERE lower(name)='zeehive'`)) ? `zt-harnroot-${tag}` : 'Zeehive';
  projId = (await one(`INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'master') RETURNING id`,
    [projName, projectRepo])).id;
  await q(`INSERT INTO harness (key, label, dir, enabled, is_law_core) VALUES ($1,$2,$3,true,false)`,
    [probeKey, `Probe ${tag}`, `harnesses/${probeKey}`]);
  await q(`INSERT INTO harness (key, label, dir, enabled, is_law_core) VALUES ($1,$2,$3,true,false)`,
    [ghostKey, `Ghost ${tag}`, `harnesses/${ghostKey}-nowhere`]);
  const ghostBefore = await one(`SELECT bundle, bundle_hash FROM harness WHERE key=$1`, [ghostKey]);

  config.repoRoot = runtime;                  // ← the whole bug, in one line
  ok(!existsSync(join(config.repoRoot, 'harnesses')),
     'the runtime root carries NO harnesses/ folder (the deployed server image)');
  ok(existsSync(join(projectRepo, 'harnesses', 'manager')),
     "but the Zeehive project's repo_root does");

  console.log('\n── refreshHarnesses() reads the PROJECT repo ──');
  await H.refreshHarnesses();
  const row = await one(`SELECT * FROM harness WHERE key='manager'`);
  const b = typeof row.bundle === 'string' ? JSON.parse(row.bundle) : (row.bundle || {});
  ok(row.bundle_hash !== null, `harness.bundle_hash is populated (${row.bundle_hash})`);
  ok(row.head_commit !== null, `harness.head_commit is populated (${String(row.head_commit).slice(0, 8)})`);
  ok(row.label === 'Manager Zee', `the label comes from the folder (${row.label})`);
  ok(row.avatar_path === 'harnesses/manager/avatar.svg', 'the avatar path is recorded');

  console.log('\n── GET /api/harnesses/manager/full comes back POPULATED ──');
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
  ok(full.zee_type === 'manager' && b.zee_type === 'manager', 'the 054 type pairing survives the resolution');
  ok(full.files_missing === false && full.bundle_empty === false,
     'the read model reports it as present and non-empty');

  console.log('\n── it materializes into a cxell as real files ──');
  const files = H.harnessFiles(await H.effectiveHarness(row));
  const rels = files.map((f) => f.relPath);
  for (const want of ['.zeehive/harness/PERSONA.md', '.zeehive/harness/memory/manager-zee-manual.md',
                      '.claude/skills/dispatch-brief/SKILL.md']) {
    ok(rels.includes(want), `harnessFiles() materializes ${want}`);
  }
  ok((files.find((f) => f.relPath === '.zeehive/harness/memory/manager-zee-manual.md')?.text || '').length > 12000,
     'the materialized manual carries the whole 12.9k text (not an empty file)');

  console.log('\n── the base really came from project.repo_root ──');
  const probe = await H.getHarnessFull(probeKey);
  ok(probe.personality.includes(`probe personality ${tag}`),
     'a harness folder that exists ONLY in the project repo is loaded (so the base was its repo_root)');
  ok(probe.skills.some((s) => s.body?.includes(`probe body ${tag}`)), 'its skill folder loads too');
  ok(H.harnessBase(`harnesses/${probeKey}`) === projectRepo.replace(/\\/g, '/'),
     'harnessBase() names the project repo for that folder');

  console.log('\n── the avatar resolves from the same base, and stays guarded ──');
  const avatar = await H.harnessAvatarFile('harnesses/manager/avatar.svg');
  ok(!!avatar && avatar.replace(/\\/g, '/').startsWith(projectRepo.replace(/\\/g, '/')),
     `GET /api/harnesses/manager/avatar finds the SVG (${avatar ? 'under the project repo' : '404 — BROKEN'})`);
  ok(await H.harnessAvatarFile('../../etc/passwd') === null, 'an escaping avatar_path is refused');
  ok(await H.harnessAvatarFile('harnesses/manager/../../../etc/passwd') === null,
     'and so is one that climbs out of harnesses/');
  ok(await H.harnessAvatarFile('docs/cxell-zee-manual.md') === null, 'a path outside harnesses/ is refused');

  console.log('\n── an unreadable harness folder is LOUD ──');
  const ghost = (await H.listHarnesses()).find((x) => x.key === ghostKey);
  ok(ghost?.files_missing === true, 'GET /api/harnesses reports files_missing for the unreadable one');
  ok(ghost?.bundle_empty === true, 'and bundle_empty — it would brief a zee with nothing');
  const ghostAfter = await one(`SELECT bundle, bundle_hash FROM harness WHERE key=$1`, [ghostKey]);
  ok(ghostAfter.bundle_hash === ghostBefore.bundle_hash,
     'the last good bundle is KEPT (a bad mount never blanks a live harness)');
  const logged = recentLogs(200).filter((l) => l.scope === 'harness' && l.msg.includes(ghostKey));
  ok(logged.some((l) => /FOLDER MISSING/.test(l.msg)), 'the refresh logs it by key, loudly');
  ok(logged.some((l) => /repo_root/.test(l.msg)), 'and the logline says WHERE a harness folder lives');
  const mgrList = (await H.listHarnesses()).find((x) => x.key === 'manager');
  ok(mgrList.files_missing === false && mgrList.bundle_empty === false,
     'while the healthy ones report clean (the flag distinguishes them)');

  console.log('\n── fallback: no project row → config.repoRoot (host-process mode) ──');
  await q(`DELETE FROM project WHERE id=$1`, [projId]); projId = null;
  config.repoRoot = REAL_ROOT;
  await H.refreshHarnessRoots();
  ok(H.harnessRoots().length === 1 && H.harnessRoots()[0] === REAL_ROOT.replace(/\\/g, '/'),
     'with no project repo to read, the only root is config.repoRoot');
  const direct = H.loadHarnessDir('harnesses/manager');
  ok(!!direct.bundle && !direct.missing, 'loadHarnessDir() still reads the checkout unchanged');
  ok((direct.bundle.memory || []).some((m) => /manager-zee-manual/.test(m.path) && m.text?.length > 12000),
     'and the manual comes with it (test/manager-zee.test.mjs keeps passing)');
  const nowhere = H.loadHarnessDir(`harnesses/${probeKey}`);
  ok(nowhere.missing === true && /looked under/.test(nowhere.errors[0]),
     'a folder under no root is reported missing, naming the roots it looked under');
} finally {
  config.repoRoot = REAL_ROOT;
  if (projId) await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  await q(`DELETE FROM harness WHERE key = ANY($1)`, [[probeKey, ghostKey]]).catch(() => {});
  // put every harness row back exactly as we found it (the refresh above rewrote real rows)
  for (const r of snapshot) {
    await q(`UPDATE harness SET bundle=$2, bundle_hash=$3, head_commit=$4, avatar_path=$5, label=$6, parent_id=$7, zee_type=$8 WHERE id=$1`,
      [r.id, JSON.stringify(r.bundle), r.bundle_hash, r.head_commit, r.avatar_path, r.label, r.parent_id, r.zee_type]).catch(() => {});
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  await pool.end().catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

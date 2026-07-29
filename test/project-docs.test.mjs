// PROJECT ENTRY-POINT DOCS — ONE source of truth, generated as one file per AI provider.
//
// An agent opens the project's entry-point markdown before it designs anything. Those files were
// whatever the repo happened to have committed: nothing at all for a project that never wrote one, no
// way to give a fleet-wide instruction without a commit, and one file per provider convention
// (AGENTS.md, CLAUDE.md, …) to keep in step by hand. Migration 081 moved them where the harnesses
// already live — the meta-DB — and 083 fixed the GRAIN: a row is the CONTENTS, and `targets` names
// which provider entry points the queenzee generates from it (lib/agent-docs.js). One text, N files,
// nothing to paste twice and nothing to drift.
//
// The thing that must not break is the repo. A generated file landing on top of a committed CLAUDE.md
// would replace the project's own instructions with an operator's, dirty every xell's worktree, and
// put a file nobody wrote into a landing diff. So this asserts, against the real DB and a real git
// repo standing in for a cxell's /work/repo:
//   1. the TARGET REGISTRY's own contract (every path passes the shape rules, keys and paths unique,
//      the defaults exist) and the AUTHORING rules: unknown target refused, targets and rel_path are
//      exclusive, two rows may not generate the same file, and the PATH RULES for a custom path
//      (relative, .md, no '..', not .git/ or .zeehive/);
//   2. the FAN-OUT and the generated text: one body → one file per target, each stamped with what
//      generated it, who reads it and its siblings; the body verbatim; the XELL STACK appended when a
//      xell is named and cleanly absent when it is not; disabled/empty rows skipped;
//   3. the TRACKED-FILE REFUSAL, run against real `git ls-files` — the exact script the injector
//      executes inside the cage, so this is the decision itself and not a paraphrase of it;
//   4. that an untracked write is git-EXCLUDED, so the artefact can never travel into a commit;
//   5. and the INJECTOR'S OWN RETURN VALUE, driven through the real writeGeneratedDocIntoCxell with a
//      fake `docker` on PATH.
//
// (5) exists because of a bug that shipped: the function read `await dk(...)` as a string, but dk
// resolves { code, out, err }, so the verdict was always '[object Object]' and every doc the container
// really wrote came back written:false — the write worked and the report lied. Section 3 was green
// throughout, because extracting the shell script and running it under bash never touches the JS that
// parses the answer. Testing the half you wrote by hand and trusting the seam is the whole lesson.
//
// (1)'s registry half exists for the same reason one layer up: a vendor path is a FACT with a URL
// behind it, and the cost of getting one wrong is a file no agent ever opens — silent, and invisible
// from inside ZEEHIVE. Everything it creates is deleted in a finally, whatever happens.
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { q, one, pool } = await import('../server/src/db/pool.js');
const P = await import('../server/src/lib/project-docs.js');
const A = await import('../server/src/lib/agent-docs.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
const tmp = mkdtempSync(join(tmpdir(), 'projdocs-'));
const repo = join(tmp, 'work-repo');
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
let projId = null;

try {
  projId = (await one(`INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'master') RETURNING id`,
    [`zt-docs-${tag}`, join(tmp, 'src')])).id;

  // ── 1a. the TARGET REGISTRY's own contract ──────────────────────────────────────────────────
  // These are vendor facts (one documented convention per entry), and code elsewhere trusts them
  // blindly: whatever path is written here is the path the queenzee writes into every xell.
  console.log('\n── the provider registry (lib/agent-docs.js) ──');
  ok(A.AGENT_DOC_TARGETS.length >= 8, `it knows a real spread of providers (${A.AGENT_DOC_TARGETS.length})`);
  const badTarget = A.AGENT_DOC_TARGETS.filter((t) => !P.validateTargetPath(t.path).ok);
  ok(!badTarget.length,
     `every registry path passes the same shape rules an operator's does (${badTarget.map((t) => t.key).join(', ') || 'all good'})`);
  ok(new Set(A.TARGET_KEYS).size === A.TARGET_KEYS.length, 'no two entries share a key (a key is DATA in project_doc.targets)');
  const paths = A.AGENT_DOC_TARGETS.map((t) => t.path.toLowerCase());
  ok(new Set(paths).size === paths.length, 'and no two claim the same file — one entry per FILE, not per vendor');
  const naked = A.AGENT_DOC_TARGETS.filter((t) => !t.url || !(t.reads || []).length);
  ok(!naked.length, `each one says who reads it and links the vendor's own doc (${naked.map((t) => t.key).join(', ') || 'all good'})`);
  ok(A.DEFAULT_TARGET_KEYS.includes('claude') && A.DEFAULT_TARGET_KEYS.includes('agents'),
     `the defaults are CLAUDE.md + AGENTS.md (${A.DEFAULT_TARGET_KEYS.join(', ')}) — this fleet's own agent, and the standard ~20 tools read`);
  ok(A.targetByKey('claude').path === 'CLAUDE.md' && A.targetByKey('agents').path === 'AGENTS.md',
     'and they resolve to the filenames those tools actually open');
  ok(A.targetCatalogue().every((t) => t.key && t.path && !('frontmatter' in t)),
     'the catalogue served to the console carries the operator-facing half only');
  let unknownKey = null;
  try { A.resolveTargets(['claude', 'notatool']); } catch (e) { unknownKey = e.message; }
  ok(/unknown agent doc target/.test(unknownKey || ''),
     'an unknown key is REFUSED, not skipped — a target that generates nothing is an instruction nobody receives');

  // ── 1b. the path rules for the custom-path escape hatch ────────────────────────────────────
  console.log('\n── which paths an operator may claim by hand ──');
  for (const good of ['AGENTS.md', 'CLAUDE.md', 'docs/agents/ONBOARDING.md', './AGENTS.md']) {
    ok(P.validateDocPath(good).ok, `allowed: ${good}`);
  }
  for (const [bad, why] of [['/etc/passwd', 'absolute'], ['../outside.md', 'climbs out'],
                            ['a/../../b.md', 'climbs out mid-path'], ['AGENTS.txt', 'not markdown'],
                            ['.git/hooks/x.md', 'inside .git'], ['.zeehive/harness/memory/x.md', 'harness space'],
                            ['', 'empty']]) {
    const v = P.validateDocPath(bad);
    ok(!v.ok, `refused (${why}): ${JSON.stringify(bad)} — ${v.reason}`);
  }
  ok(P.validateDocPath('./AGENTS.md').path === 'AGENTS.md', "a leading './' is normalised away");
  ok(!P.validateDocPath('.rules').ok && P.validateTargetPath('.rules').ok,
     'a non-.md convention is the REGISTRY\'s to name, never a text box\'s (.rules, .goosehints, .mdc)');

  // ── 1c. the authoring rules ────────────────────────────────────────────────────────────────
  console.log('\n── what an operator may save ──');
  // The flow this whole surface exists for: paste the contents, name no file at all.
  const src = await P.createProjectDoc(projId, {
    title: 'House rules', body: `# House rules ${tag}\n\nRun the tests.\n` });
  ok(src.rel_path === null && src.targets.length === A.DEFAULT_TARGET_KEYS.length,
     `contents with no path get the default providers (${src.targets.join(', ')}) — nobody has to pick filenames to start writing`);
  let both = null;
  try { await P.createProjectDoc(projId, { rel_path: 'X.md', targets: ['gemini'], body: 'x' }); }
  catch (e) { both = e.message; }
  ok(/not both/.test(both || ''),
     `targets AND a custom path is refused in words, never silently ranked ("${(both || '').slice(0, 40)}…")`);
  let clash = null;
  try { await P.createProjectDoc(projId, { targets: ['claude'], body: 'a second CLAUDE.md' }); }
  catch (e) { clash = e.message; }
  ok(/already generates CLAUDE\.md/.test(clash || ''),
     `two rows may not generate the same file ("${(clash || '').slice(0, 52)}…")`);
  const custom = await P.createProjectDoc(projId, { rel_path: 'docs/agents/ONBOARDING.md', body: `onboarding ${tag}\n` });
  ok(custom.rel_path === 'docs/agents/ONBOARDING.md' && !custom.targets.length,
     'a custom path is still available for a one-off doc');
  let dup = null;
  try { await P.createProjectDoc(projId, { rel_path: 'docs/agents/onboarding.md', body: 'x' }); }
  catch (e) { dup = e.message; }
  ok(/already has a doc/.test(dup || ''),
     `a second row for the same path is refused, case-insensitively ("${(dup || '').slice(0, 44)}…")`);
  let badPath = null;
  try { await P.createProjectDoc(projId, { rel_path: '../escape.md', body: 'x' }); }
  catch (e) { badPath = e.message; }
  ok(/bad path/.test(badPath || ''), 'and so is a path outside the repo, at the authoring surface');

  // ── 2. what gets generated ──────────────────────────────────────────────────────────────────
  // ONE body, one file per target — the point of 083. `.cursor/rules/*.mdc` is in the set because it
  // is the awkward one: a different extension, and frontmatter that only counts at byte 0.
  console.log('\n── one text, one file per provider ──');
  await P.updateProjectDoc(src.id, { targets: ['claude', 'agents', 'gemini', 'cursor'], rel_path: null });
  const files = await P.projectDocFiles(projId);
  const at = (p) => files.find((f) => f.relPath === p);
  ok(files.length === 5,
     `both rows generate their files (${files.map((f) => f.relPath).join(', ')})`);
  ok(!!at('CLAUDE.md') && !!at('AGENTS.md') && !!at('GEMINI.md') && !!at('.cursor/rules/zeehive-project.mdc'),
     'the four providers ticked on ONE source each get their own path');
  ok(at('CLAUDE.md').text.includes(`# House rules ${tag}`) && at('GEMINI.md').text.includes(`# House rules ${tag}`),
     'carrying the same body verbatim — there is nothing to paste twice and nothing to drift');
  ok(at('CLAUDE.md').text.startsWith('<!-- GENERATED by ZEEHIVE'),
     'the file OPENS with the stamp — a reader sees it before the content');
  ok(at('CLAUDE.md').text.includes('`CLAUDE.md`') && /Editing THIS copy changes nothing/.test(at('CLAUDE.md').text),
     'which names the path and says an edit here is overwritten');
  ok(/Docs tab/.test(at('CLAUDE.md').text), 'and where the source actually is');
  ok(/Read by:.*Claude Code/.test(at('CLAUDE.md').text), 'it says which agents read this particular file');
  ok(at('CLAUDE.md').text.includes('also generates: AGENTS.md, GEMINI.md, .cursor/rules/zeehive-project.mdc'),
     'and NAMES its siblings — two files that silently agree are two files somebody will edit apart');
  const mdc = at('.cursor/rules/zeehive-project.mdc').text;
  ok(mdc.startsWith('---\nalwaysApply: true\n---\n'),
     'a provider that needs frontmatter gets it at byte 0, ABOVE the stamp (Cursor ignores it anywhere else)');
  ok(mdc.indexOf('<!-- GENERATED') < mdc.indexOf(`# House rules ${tag}`), '…with the stamp still ahead of the body');
  ok(!at('CLAUDE.md').text.startsWith('---'), 'and a provider that does not need frontmatter is not given any');
  ok(at('docs/agents/ONBOARDING.md').text.includes(`onboarding ${tag}`)
     && !/also generates/.test(at('docs/agents/ONBOARDING.md').text),
     'a custom-path row generates exactly its one file, with no siblings to claim');

  // ── 2b. the XELL STACK appendix ────────────────────────────────────────────────────────────
  // The half an operator cannot write: which containers are THIS xell's. Generated from the meta-DB
  // per xell, which is why the same source produces a different file in every cage.
  console.log('\n── every generated file carries THIS xell\'s stack ──');
  const stackXource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [projId]);
  const stackXell = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, db_coupling,
                       source_coupling, is_pooled)
       VALUES ($1,$2,$3,'spinoff/zt-stack','/tmp/zt-stack','working','db-isolated','sparse-overlay',false)
     RETURNING id, slug`, [projId, stackXource.id, `zt-stack-${tag}`]);
  for (const [role, name, port, url] of [['server', `zt_srv_${tag}`, 4825, 'http://localhost:4825'],
                                         ['db', `zt_db_${tag}`, 5525, null]]) {
    const c = await one(
      `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, host_port, url, owner_xell_id)
       VALUES ($1,$2,'spinoff','per-xell',$3,'default',$4,$5,$6) RETURNING id`,
      [projId, role, name, port, url, stackXell.id]);
    await q(`INSERT INTO xell_uses_container (xell_id, container_id, relation) VALUES ($1,$2,'owns')`,
      [stackXell.id, c.id]);
  }
  const forXell = await P.projectDocFiles(projId, { xellId: stackXell.id });
  const claude = forXell.find((f) => f.relPath === 'CLAUDE.md').text;
  ok(claude.includes(stackXell.slug) && claude.includes('spinoff/zt-stack'),
     'the file names the xell and branch the agent woke up in');
  ok(claude.includes(`zt_srv_${tag}`) && claude.includes(`zt_db_${tag}`) && claude.includes('http://localhost:4825'),
     'and its OWN containers, with how to reach them');
  ok(/db-isolated/.test(claude) && /DATABASE_URL/.test(claude) && /\.zeehive\.env/.test(claude),
     'the database coupling, and the generated file the credential really lives in');
  ok(!/postgresql:\/\//.test(claude),
     'never a DSN — a conn_ref can carry a password, and this text lands in a workspace an agent may quote');
  ok(/zee build/.test(claude) && /zee status/.test(claude),
     'how to build and verify, and the command that RE-RESOLVES all of it (names and ports are data, not documentation)');
  ok(forXell.every((f) => f.text.includes(stackXell.slug)),
     'every provider file gets the appendix — not just the one somebody remembered');
  ok(claude.indexOf(`# House rules ${tag}`) < claude.indexOf('Your xell'),
     "the project's own words come FIRST; the stack is an appendix under its own heading");
  ok(!at('CLAUDE.md').text.includes('Your xell'),
     'and with no xell named, the instructions still generate — only the appendix is absent');

  await P.updateProjectDoc(custom.id, { enabled: false });
  ok((await P.projectDocFiles(projId)).length === 4, 'disabling a row takes its file out');
  await P.updateProjectDoc(custom.id, { enabled: true, body: '' });
  ok((await P.projectDocFiles(projId)).length === 4,
     'and so does emptying its body (a doc that says nothing is worse than none — a zee believes it has been briefed)');
  ok((await P.deleteProjectDoc(custom.id)).deleted, 'a doc can be deleted');
  await q(`DELETE FROM xell_uses_container WHERE xell_id=$1`, [stackXell.id]);
  await q(`DELETE FROM container WHERE owner_xell_id=$1`, [stackXell.id]);
  await q(`DELETE FROM xell WHERE id=$1`, [stackXell.id]);

  // ── 3. the tracked-file refusal, decided by real git ────────────────────────────────────────
  // This runs the SAME shell the injector execs inside the cxell (lib/cxell.js), against a real repo:
  // the decision itself, not a description of it. There is no docker in a cxell to exec into, and the
  // git behaviour is the whole point.
  console.log('\n── a generated doc never overwrites a file the project committed ──');
  mkdirSync(repo, { recursive: true });
  git('init', '-q', '-b', 'master'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  writeFileSync(join(repo, 'CLAUDE.md'), '# the project\'s OWN committed instructions\n');
  git('add', '-A'); git('commit', '-qm', 'the repo brings its own CLAUDE.md');

  // the injector's script, verbatim from lib/cxell.js — kept in one place so a change there is
  // caught here rather than diverging quietly
  const cxellSrc = readFileSync('server/src/lib/cxell.js', 'utf8');
  const block = cxellSrc.slice(cxellSrc.indexOf('export async function writeGeneratedDocIntoCxell'),
                               cxellSrc.indexOf('export async function removeCxell'));
  const steps = [...block.matchAll(/^\s*'([^']*)',$/gm)].map((m) => m[1])
    .filter((l) => l && !l.startsWith('exec') && l !== '-i' && l !== 'bash' && l !== '-lc');
  ok(steps.includes('cd /work/repo') && steps.some((l) => /git ls-files --error-unmatch/.test(l)),
     'the injector really asks git before writing (its script is read out of the source here)');
  // the target path is interpolated by the caller (shell-quoted there), so it is supplied here the
  // same way: everything else is the source's own lines, in the source's own order.
  ok(block.includes('P=${sq(safe)}'), 'and the path it asks about is the shell-quoted target');
  const run = (relPath, text) => {
    const script = [`cd ${repo}`, `P='${relPath}'`,
      ...steps.filter((l) => l !== 'cd /work/repo')].join('\n');
    const r = spawnSync('bash', ['-lc', script], { input: text, encoding: 'utf8' });
    return { verdict: String(r.stdout || '').trim().split('\n').pop(), status: r.status, err: r.stderr };
  };

  const tracked = run('CLAUDE.md', 'GENERATED — must not land\n');
  ok(tracked.verdict === 'TRACKED', `a tracked path answers TRACKED (${tracked.verdict}) and is not written`);
  ok(readFileSync(join(repo, 'CLAUDE.md'), 'utf8').includes("project's OWN"),
     "the project's committed file is byte-for-byte untouched");
  ok(git('status', '--porcelain') === '', 'and the worktree is still clean — nothing to dirty a landing diff');

  const fresh = run('AGENTS.md', `${P.docBanner('AGENTS.md')}\n\ngenerated body ${tag}\n`);
  ok(fresh.verdict === 'WROTE', `an untracked path is written (${fresh.verdict})`);
  ok(readFileSync(join(repo, 'AGENTS.md'), 'utf8').includes(`generated body ${tag}`), 'with the generated content');

  // ── 4. …and excluded, so it cannot travel into a commit ─────────────────────────────────────
  ok(existsSync(join(repo, '.git/info/exclude'))
     && readFileSync(join(repo, '.git/info/exclude'), 'utf8').split('\n').includes('AGENTS.md'),
     'the written path is added to .git/info/exclude');
  ok(git('status', '--porcelain') === '',
     'so `git status` stays clean with the generated file present — it can never land in a diff');
  const again = run('AGENTS.md', `regenerated ${tag}\n`);
  ok(again.verdict === 'WROTE' && readFileSync(join(repo, 'AGENTS.md'), 'utf8').includes(`regenerated ${tag}`),
     'regenerating it overwrites the artefact (the row is the source, every time)');
  ok(readFileSync(join(repo, '.git/info/exclude'), 'utf8').split('\n').filter((l) => l === 'AGENTS.md').length === 1,
     'and the exclude entry is not appended twice');

  // a doc in a SUBDIRECTORY: the injector must create it
  const nested = run('docs/agents/ONBOARDING.md', 'nested\n');
  ok(nested.verdict === 'WROTE' && existsSync(join(repo, 'docs/agents/ONBOARDING.md')),
     'a doc in a subdirectory has its directories created');

  // ── an edit reaches the zees ALREADY RUNNING ────────────────────────────────────────────────
  // Same rule a harness save obeys: "new zees only" is the failure that left a fleet briefed on stale
  // text. In THIS cxell PROVISION_MODE is simulate (a nested queenzee's fleet rows are the real
  // fleet's), so the correct behaviour is to REPORT the live xells it would have regenerated in and
  // exec into none of them — and to say which, never a silent skip.
  console.log('\n── saving a doc pushes it into live zees (reported, not executed, in simulate) ──');
  const { recentLogs } = await import('../server/src/lib/logbus.js');
  const liveXell = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled)
       VALUES ($1,$2,$3,'spinoff/zt-doc','/tmp/zt-doc','working',false) RETURNING id, slug`,
    [projId, stackXource.id, `zt-doclive-${tag}`]);
  await q(`INSERT INTO zee (xell_id, runtime_id, attach_mode, status, entrypoint, viewer_kind)
           VALUES ($1, (SELECT id FROM agent_runtime LIMIT 1), 'headless-spawn', 'working', 'cxell-cli', 'ssh-terminal')`,
    [liveXell.id]);
  const before = recentLogs(300).length;
  await P.updateProjectDoc(src.id, { body: `# edited ${tag}\n` });
  const said = recentLogs(300).slice(before).filter((l) => l.scope === 'project-doc').map((l) => l.msg);
  ok(said.some((m) => /NOT pushed into 1 live xell/.test(m) && /PROVISION_MODE=/.test(m)),
     'the push obeys PROVISION_MODE and says so rather than execing into another zee\'s cxell');
  ok(said.some((m) => m.includes(liveXell.slug)),
     'and NAMES the live xell it would have regenerated in — a report, never a silent skip');

  // ── 5. the injector's own return value, through a fake docker ────────────────────────────────
  // dk() spawns `docker` off PATH, so a shim IS the real code path: spawn, stdin, close, parse. No
  // container, no cage, and every branch of the verdict reachable.
  console.log('\n── the injector parses what the container answers ──');
  const bin = join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'docker'), '#!/usr/bin/env bash\ncat > /dev/null\nif [ -n "$FAKE_DOCKER_STDERR" ]; then echo "$FAKE_DOCKER_STDERR" >&2; fi\nprintf "%s" "$FAKE_DOCKER_OUT"\nexit "${FAKE_DOCKER_CODE:-0}"\n', { mode: 0o755 });
  const realPath = process.env.PATH;
  process.env.PATH = `${bin}:${realPath}`;
  const C = await import('../server/src/lib/cxell.js');
  const inject = (out, extra = {}) => {
    process.env.FAKE_DOCKER_OUT = out;
    Object.assign(process.env, extra);
    return C.writeGeneratedDocIntoCxell({ slug: `zt-${tag}`, relPath: 'AGENTS.md', text: 'body\n' });
  };
  try {
    const wrote = await inject('WROTE\n');
    ok(wrote.written === true && wrote.rel === 'AGENTS.md' && wrote.path === '/work/repo/AGENTS.md',
       `WROTE → written:true (${JSON.stringify(wrote)})`);
    const trackedR = await inject('TRACKED\n');
    ok(trackedR.written === false && trackedR.skipped === 'tracked' && /tracked by git/.test(trackedR.reason),
       'TRACKED → written:false with the reason a human reads');
    // the shell prints its verdict LAST; earlier chatter (a git warning, say) must not win
    const noisy = await inject('warning: something\nWROTE\n');
    ok(noisy.written === true, 'the LAST line is the verdict — earlier output does not decide it');
    ok((await inject('WROTE')).written === true, 'and a verdict with no trailing newline still parses');
    // the bug's own signature: an answer the parser cannot read must be LOUD, never a silent skip
    const junk = await inject('[object Object]\n');
    ok(junk.written === false && junk.skipped === 'unknown' && /could not read the container/.test(junk.reason),
       `an unreadable answer is reported as unknown, quoting it (${JSON.stringify(junk.reason.slice(-32))})`);
    const empty = await inject('');
    ok(empty.skipped === 'unknown', 'so is no answer at all');
    // a failed exec REJECTS (dk does) — the caller logs it rather than counting a write
    process.env.FAKE_DOCKER_CODE = '1';
    const failed = await inject('', { FAKE_DOCKER_STDERR: 'no such container' }).catch((e) => e);
    ok(failed instanceof Error && /exited 1/.test(failed.message),
       `a docker failure throws instead of reporting a write (${String(failed.message).slice(0, 42)}…)`);
  } finally {
    process.env.PATH = realPath;
    delete process.env.FAKE_DOCKER_OUT; delete process.env.FAKE_DOCKER_CODE; delete process.env.FAKE_DOCKER_STDERR;
  }

  // ── the rows die with the project ───────────────────────────────────────────────────────────
  console.log('\n── lifecycle ──');
  const n = (await P.listProjectDocs(projId)).length;
  ok(n === 1, `the project has its doc listed (${n} source row generating 4 provider files)`);
  await q(`DELETE FROM zee WHERE xell_id=$1`, [liveXell.id]);
  await q(`DELETE FROM project WHERE id=$1`, [projId]);
  const after = await q(`SELECT count(*)::int AS n FROM project_doc WHERE project_id=$1`, [projId]);
  ok(after[0].n === 0, 'and they are deleted with the project (ON DELETE CASCADE)');
  projId = null;
} finally {
  if (projId) await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  await pool.end().catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

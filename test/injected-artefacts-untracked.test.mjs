// INJECTED ARTEFACTS ARE NOT SOURCE — nothing the queenzee writes into a xell may be tracked.
//
// The queenzee injects per-xell state into every workspace: the harness persona + memory
// (`.zeehive/harness/`), the skills it materializes (`.claude/skills/`), and delivered mail
// (`.zee-inbox/`). `.gitignore` has covered those directories since the first time one was swept
// into a commit — but an ignore rule DOES NOT APPLY to a file already in the index, and
// `.zeehive/harness/memory/cxell-zee-manual.md` was in it. Every cxell's injected copy therefore
// read as a modification to a tracked file, and the fleet paid for it repeatedly:
//   • 7c00642 and cad07a8 — commits whose ONLY purpose was undoing the injection,
//   • 28ff5c3 — a `git add -A` that swept it INTO a landing,
//   • and a land that stopped dead on a merge CONFLICT between master's manual and an injected copy.
// The version that had not happened yet is the expensive one: a zee lands its injected copy and
// silently overwrites the repo's manual with a stale injection of it.
//
// So this asserts the mechanism, not the incident: the ignore rules exist, and NOTHING under those
// directories is in the index — which is the only state in which the rules actually bite.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' }).trim();

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// Every directory the queenzee WRITES into a live workspace. Adding one here without ignoring it
// (and while something in it is tracked) fails, which is the point.
const INJECTED = ['.zeehive/', '.claude/', '.zee-inbox/'];

console.log('\n── the ignore rules are in place ──');
const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
for (const dir of INJECTED) {
  ok(new RegExp(`^${dir.replace('.', '\\.')}$`, 'm').test(ignore), `.gitignore ignores ${dir}`);
}

console.log('\n── and NOTHING in them is tracked (an ignore rule cannot save an indexed file) ──');
for (const dir of INJECTED) {
  const tracked = git('ls-files', dir).split('\n').filter(Boolean);
  ok(tracked.length === 0,
     tracked.length
       ? `${dir} has ${tracked.length} TRACKED file(s) — untrack with \`git rm --cached\`: ${tracked.join(', ')}`
       : `${dir} has no tracked files`);
}

console.log('\n── so a fresh injection cannot dirty the tree ──');
// The real artefact, in this very cxell: the manual is ON DISK (a zee reads it) and INVISIBLE to git.
const manual = '.zeehive/harness/memory/cxell-zee-manual.md';
if (existsSync(join(ROOT, manual))) {
  ok(readFileSync(join(ROOT, manual), 'utf8').length > 1000,
     'the injected manual is present on disk and readable (untracking must never delete it)');
  const ignored = execFileSync('git', ['-C', ROOT, 'check-ignore', '-v', manual],
    { encoding: 'utf8' }).trim();
  ok(/\.gitignore:\d+:/.test(ignored), `git ignores it: ${ignored.split('\t')[0]}`);
} else {
  // running from a plain checkout (no injection) — the tracked-file assertions above are the test
  console.log('  · no injected manual in this checkout — skipping the on-disk half');
}
ok(!git('status', '--porcelain').split('\n').some((l) => /\.zeehive\/|\.claude\/|\.zee-inbox\//.test(l)),
   'git status reports nothing from any injected directory');

console.log('\n── the manual has ONE home, and it is not a repo file ──');
// Its home is the meta DB (harness zee-base, seeded by 047, amended by migration since). A repo copy
// would drift from that row the day the next migration lands — the scripts/zee lesson.
ok(!existsSync(join(ROOT, 'docs', 'cxell-zee-manual.md')),
   'there is no docs/cxell-zee-manual.md (the meta DB is the single source)');
// (harnesses/core/HARNESS.yml used to be in this list and carried the note itself; migration 080
// moved every harness's text into the meta-DB and the file is gone — docs/dev-crew.md replaces it as
// the doc most likely to send a reader looking for a manual.)
const live = ['README.md', 'CLAUDE.md', 'HANDOFF.md', 'docs/harness-proposal.md',
  'docs/schema-catchup-plan.md', 'docs/dev-crew.md', 'server/src/lib/harness.js'];
for (const f of live) {
  // A mention is only allowed when the same line SAYS it does not exist — the point is that no
  // reader is ever sent to that path, not that the six characters never appear.
  const bad = readFileSync(join(ROOT, f), 'utf8').split('\n')
    .filter((l) => l.includes('docs/cxell-zee-manual.md'))
    .filter((l) => !/\b(no|not|never|dead|removed|superseded)\b/i.test(l));
  ok(bad.length === 0, bad.length
    ? `${f} still POINTS at the dead path: "${bad[0].trim().slice(0, 80)}"`
    : `${f} does not point at that dead path`);
}

// ── the OTHER class of injected artefact: a path the operator chooses ────────────────────────────
// Project entry-point docs (migration 081) are generated into a xell at a repo-relative path like
// AGENTS.md — outside the directories above, so an ignore rule cannot be the guard. The guard is that
// the injector asks git first and refuses a TRACKED path, then excludes what it writes. This repo is
// the perfect witness: its own CLAUDE.md is tracked, so a project doc could never overwrite it.
console.log('\n── a generated project doc can never overwrite a tracked file ──');
{
  const tracked = (p) => { try { git('ls-files', '--error-unmatch', '--', p); return true; } catch { return false; } };
  ok(tracked('CLAUDE.md'), "this repo's own CLAUDE.md is tracked (the file a generated doc must not touch)");
  const injector = readFileSync(join(ROOT, 'server/src/lib/cxell.js'), 'utf8');
  const block = injector.slice(injector.indexOf('writeGeneratedDocIntoCxell'), injector.indexOf('export async function removeCxell'));
  ok(/git ls-files --error-unmatch/.test(block) && /echo TRACKED/.test(block),
     'the injector asks git before writing and answers TRACKED rather than overwriting');
  ok(/\.git\/info\/exclude/.test(block),
     'and adds what it DOES write to .git/info/exclude, so the artefact cannot reach a commit');
  // the decision itself is exercised against a real repo in test/project-docs.test.mjs
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);

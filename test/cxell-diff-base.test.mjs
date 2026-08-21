// THE CXELL SOURCE-DIFF BASE — the fork point off the source, not the recorded head_commit.
//
// THE DEFECT (ticket: "xell diffs show against the xell's OWN commit instead of the source"):
// cxellDiff / cxellPatch measured the source diff against the recorded head_commit. That value is
// the PROVISIONING base until the first sync — correct — but deliverXourceIntoCxell then fetches the
// source into the cage as refs/remotes/origin/main and syncCxellWithXource MERGES it into the zee's
// branch, and head_commit is updated to that MERGED HEAD on land/collect/sync. The merged HEAD
// already CONTAINS the source, so `git diff <head_commit>` reads only the uncommitted delta: the
// committed work vanishes and the "source diff" becomes the zee's own-commit diff (the reported
// symptom). The host worktree path (worktreeDiff) already did this right via merge-base(ref, HEAD);
// the cxell paths are the ones that lost the fork-point base.
//
// THE FIX: cxellDiffScript / cxellPatchBody now compute $SRC = merge-base(origin/main, HEAD) once a
// sync has delivered origin/main (the merge made that the source tip), else merge-base(base, HEAD) —
// the fork point off the source, exactly what worktreeDiff uses. The source shortstat and the
// DiffViewer patch measure against $SRC, so a zee that has committed AND synced still shows its
// committed work, and the old own-commit read (0 files) is the bug this test fails on.
//
// This file runs the EXACT scripts cxellDiff/cxellPatch run inside a cage, against a real throwaway
// repo with no docker in the way (the same technique as test/cxell-sync-abort-safety.test.mjs §9).
// `cxellSourceBase` is where the base is decided, and `cxellDiffScript` / `cxellPatchBody` are the
// complete scripts — exported precisely so the base is pinned here, not just the number (a test
// asserting "+33/−2" would have passed against the bug).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { cxellDiffScript, cxellPatchBody, cxellSourceBase, parseCxellDiff } =
  await import('../server/src/lib/cxell.js');

// ── a real repo in the shape of a SYNCED cxell ──────────────────────────────────────────────────
//   master:  B0 (base) → M1 (main moves after the zee forks)
//   branch:  B0 → Z1 (adds a.txt) → Z2 (adds b.txt)
//   sync:    origin/main delivered (= M1), merged into the branch → M2 (the merged HEAD head_commit
//            is updated to). A live cxell would then be at HEAD = M2.
const repo = mkdtempSync(join(tmpdir(), 'zeehive-cxelldiff-'));
const g = (...args) => {
  const r = execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return String(r).trim();
};
let B0, M1, M2;
try {
  g('init', '-q', '-b', 'master');
  g('config', 'user.email', 'test@zeehive'); g('config', 'user.name', 'zeehive test');
  writeFileSync(join(repo, 'README.md'), '# base\n');
  g('add', '-A'); g('commit', '-qm', 'base');
  B0 = g('rev-parse', 'HEAD');
  g('branch', 'spinoff/zee');
  // main moves after the zee forks — the source tip the sync will deliver
  writeFileSync(join(repo, 'MAIN.md'), 'main moved\n');
  g('add', '-A'); g('commit', '-qm', 'main moves');
  M1 = g('rev-parse', 'master');
  // the zee's committed work, on its branch
  g('checkout', '-q', 'spinoff/zee');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  g('add', '-A'); g('commit', '-qm', 'zee adds a');
  writeFileSync(join(repo, 'b.txt'), 'two\nlines\n');
  g('add', '-A'); g('commit', '-qm', 'zee adds b');

  console.log('\n── the source diff BEFORE the first sync: the fork point is the provisioning base ──');
  // No refs/remotes/origin/main yet — the clone was a bundle of the branch only. $SRC falls back to
  // merge-base(B0, HEAD) = B0, so the zee's committed work must show.
  const pre = parseCxellDiff(execFileSync('bash', ['-lc', cxellDiffScript(B0, repo)], { encoding: 'utf8' }));
  ok(pre.files === 2 && pre.insertions === 3 && pre.deletions === 0,
     `source diff vs the provisioning base shows the committed work (files=${pre.files} ins=${pre.insertions} del=${pre.deletions})`);
  ok(pre.ahead === 2, `ahead counts the two unlanded commits (ahead=${pre.ahead})`);

  console.log('\n── the reported defect: AFTER a sync, diffing the merged HEAD shows nothing ──');
  g('update-ref', 'refs/remotes/origin/main', M1);       // deliver the source into the cage
  g('merge', '--no-edit', 'refs/remotes/origin/main');   // the sync's merge
  M2 = g('rev-parse', 'HEAD');                           // what head_commit is updated to
  // The OLD behaviour — `git diff --shortstat <head_commit>` where head_commit IS the merged HEAD:
  // the merged HEAD already contains the source, so only the uncommitted delta (0 here) shows.
  const oldBuggy = parseCxellDiff(execFileSync('bash', ['-lc', [
    `cd ${repo} || exit 3`,
    'echo "$(git rev-parse HEAD)"',
    `echo "$(git rev-list --count refs/remotes/origin/main..HEAD)"`,
    `echo "$(git diff --shortstat ${M2})"`,
    'echo "$(git diff --shortstat HEAD)"',
    'echo "$(git status --porcelain | wc -l)"',
  ].join('\n')], { encoding: 'utf8' }));
  ok(oldBuggy.files === 0,
     `(the bug, pinned: diffing the recorded head_commit directly reads 0 files — committed work vanished)`);

  console.log('\n── the fix: AFTER a sync, the source diff measures from the FORK POINT ──');
  const post = parseCxellDiff(execFileSync('bash', ['-lc', cxellDiffScript(M2, repo)], { encoding: 'utf8' }));
  ok(post.files === 2 && post.insertions === 3 && post.deletions === 0,
     `source diff vs the fork point STILL shows the committed work (files=${post.files} ins=${post.insertions} del=${post.deletions})`);
  ok(post.ahead >= 1, `ahead still counts the unlanded commits (ahead=${post.ahead})`);
  ok(post.own.files === 0, `own diff stays the uncommitted read (own.files=${post.own.files})`);
  ok(post.dirty === 0, `and a clean tree stays clean (dirty=${post.dirty})`);

  console.log('\n── the DiffViewer patch: source shows the committed work, own shows only the delta ──');
  // cxellPatchBody echoes `BASE:<sha>` (the base actually used) before the patch, exactly as
  // cxellPatch emits it; split the same way cxellPatch does.
  const splitBase = (out) => {
    const nl = out.indexOf('\n');
    return { base: nl >= 0 ? out.slice(0, nl) : out, text: nl >= 0 ? out.slice(nl + 1) : '' };
  };
  const srcPatch = splitBase(execFileSync('bash', ['-lc', `{ ${cxellPatchBody(M2, 'source', repo)}; } 2>/dev/null`],
    { encoding: 'utf8' }));
  ok(srcPatch.base === `BASE:${M1}`,
     `the source patch's base is the FORK POINT (origin/main), not the merged HEAD (${srcPatch.base.slice(0, 12)}…)`);
  ok(srcPatch.text.includes('diff --git a/a.txt') && srcPatch.text.includes('diff --git a/b.txt'),
     'and the patch shows the COMMITTED work (a.txt + b.txt) — not just the uncommitted delta');

  const ownPatch = splitBase(execFileSync('bash', ['-lc', `{ ${cxellPatchBody(M2, 'own', repo)}; } 2>/dev/null`],
    { encoding: 'utf8' }));
  ok(ownPatch.base === `BASE:${M2}`, `the own patch's base is HEAD (${ownPatch.base.slice(0, 12)}…)`);
  ok(ownPatch.text.trim() === '', 'and the own patch is empty on a clean tree');

  console.log('\n── the base decision is pinned in the script, not just the number ──');
  const src = cxellSourceBase(B0);
  ok(/merge-base refs\/remotes\/origin\/main HEAD/.test(src),
     'the script prefers the fork point against origin/main when that ref exists');
  ok(/merge-base \$\{?\w*\}? HEAD/.test(src) || /merge-base \w+ HEAD/.test(src),
     'and falls back to merge-base(<base>, HEAD) before the first sync');
  ok(!/git diff --shortstat \$\{?b\}?/.test(cxellDiffScript(B0, repo)),
     'the shortstat is measured against $SRC, never the recorded head_commit directly');
} catch (e) {
  console.error('\n✗ FAIL (threw):', e?.stack || e?.message || e);
  fail++;
} finally {
  rmSync(repo, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} failure(s)` : '\nall good');
process.exit(fail ? 1 : 0);

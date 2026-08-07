# GH013 — "push declined due to repository rule violations"

What to do when the console's **↑ Push** or **⇅ PR** comes back saying GitHub refused the push by
*repository rule*. Written after 2026-08-04, when a PR from the console failed with exactly that
sentence and the console's answer was git's raw stderr.

## What it is (and what it is not)

A **ruleset** (repo Settings → Rules → Rulesets, or an org-level one, or classic branch protection)
is enforced by GitHub at push time and is **invisible to git until it fires**. The token's
`permissions` block can say `push: true` — that is what lights the Push/PR buttons — and the *repo*
can still refuse the ref update. GitHub says so as:

```
remote: error: GH013: Repository rule violations found for refs/heads/zeehive/main.
remote: - Changes must be made through a pull request.
 ! [remote rejected] main -> zeehive/main (push declined due to repository rule violations)
```

**It is not a divergence, and it is not a credential problem.** That sentence contains the word
"rejected", which is why Zeehive used to answer it with "pull or reconcile first" — a fix for a
problem you do not have. `describeRuleViolation()` in `server/src/lib/remote-git.js` classifies it
BEFORE the divergence check (the same precedence the `workflow`-scope refusal earned), quotes
GitHub's own bullet lines back — they are the only accurate statement of the rule — and adds the one
fix that rule has. A refusal comes back as `state:'refused-rules'` with `rule` and `rule_bullets`.

## The rules, and what each one means here

| GitHub says | `rule` | what to do |
|---|---|---|
| Changes must be made through a pull request / At least N approving reviews (GH006) | `pull-request-required` | On **Push**: use **⇅ PR** — that is what the button is for. On the **PR side branch**: the ruleset targets *every* branch, not just the default one. Narrow its target, or add a bypass for the token's actor. |
| Push cannot contain secrets / GITHUB PUSH PROTECTION | `secrets` | A secret is in the **commits**, not just the working tree. Rotate it, rewrite the history that carries it, push again — or allow that one finding at the unblock URL GitHub prints (surfaced as `unblock_url`). |
| Cannot update this protected ref / force pushes blocked | `force` | Zeehive **never force-pushes to main**. For a PR head branch it degrades instead: plain fast-forward push, then a fresh `…-<sha8>` head (a create). If both are refused, name a new head branch in the PR dialog. |
| Commits must have verified signatures | `signatures` | Zeehive's commits are unsigned. Sign them on the queenzee, bypass the actor, or drop the rule for the branch. |
| Restrict creations | `creations` | The side branch cannot be created — reuse an existing head branch, or bypass the actor. |
| Required status checks / linear history / branch-name / file-path / file-size / commit-message / author-email | as named | Reported with the rule and its fix; most are settings changes, not local ones. |

## Before you click: the pre-flight

`remoteAccess()` also reads `GET /repos/{owner}/{repo}/rules/branches/{branch}` for the default
branch (`branchRules()`), so the console can warn *before* the click: the Push button carries the
warning in its tooltip and Project setup shows a **⚠ ruleset: use PR, not Push** chip.

Two deliberate choices:

- **`can_push` stays true.** The token's permission and the repo's rules are two different facts,
  and a ruleset may carry a bypass for this actor that the endpoint cannot tell us about. The
  warning informs; it does not take the button away.
- **An unreadable rules endpoint is not an error.** A token that cannot read rules (or an older
  GitHub Enterprise) returns `checked:false` and every consumer behaves exactly as it did before —
  the git-level classification still catches the refusal when it happens.

## What Zeehive will never do about it

Bypass it. There is no `--force` to main, no `-c http.…` trick and no retry loop against the rule:
an outbound push is a human's click behind a confirm dialog, and a rule the repo's owners set is
theirs to change. The most Zeehive does is pick a *different, new* head branch when the rule refuses
to update an existing one — a create, which rewrites nothing.

Covered by `test/github-rulesets.test.mjs` (real bare repos + pre-receive hooks printing GitHub's
byte-shape, stubbed REST).

## What the probe found on 2026-08-04 (Originode/Zeehive)

Read live from the GitHub API, unauthenticated, by the same `branchRules()` the console now calls:

- the repo is **public**, not archived, default branch **`master`**;
- `GET /rules/branches/master` and `/rules/branches/main` both return **`[]`** — there is **no
  branch ruleset** on either;
- a `zeehive/master` head branch from an earlier PR attempt already exists on the remote (pushed
  2026-07-31), so a re-run needs to *update* that ref, which is why the force-block fallback exists.

So the GH013 that failed the PR was **not** a branch rule. What is left, in order of likelihood:

1. **Secret-scanning push protection** — on by default for public repos, reported as GH013, and it
   is not a branch rule so it does not appear in `/rules/branches`. This is the leading candidate,
   and it is exactly the case whose detail (`Push cannot contain secrets`, the file, the unblock
   URL) the old `err.slice(-300)` threw away — leaving only the "(push declined due to repository
   rule violations)" tail the report quoted.
2. An **organisation-level ruleset** whose target this branch matched at the time.
3. The `workflow`-scope refusal, which is a different message and already had its own hint.

**This is a narrowing, not a diagnosis** — reproducing it needs a write-scoped PAT, which no cxell
holds. The next PR attempt now reports the rule, the file and the fix in its own words, so it will
say which of the three it was rather than leaving anyone to guess again.

## CONFIRMED, 2026-08-04 — and it was a fabricated test fixture

The shipped classifier answered the question on the next click. GitHub's block, in the console's
own words:

> GitHub refused this push by REPOSITORY RULE, not by credentials or divergence — "GITHUB PUSH
> PROTECTION"; "Push cannot contain secrets". **Found in: `test/cxell-credential-vendor.test.mjs:63`,
> `test/cxell-provider-env.test.mjs:36`.**

Both lines were the same string: a **DeepSeek-shaped test fixture**, `sk-` followed by 32 invented
hex characters — the exact partner pattern GitHub keys DeepSeek on. It was never a credential; it
was written on 2026-08-04 (commits `a872221`, `e791971`) so the vendor-attribution tests would have
a realistic shape to work on. A made-up string, in two test files, refusing every push of the repo.

Two things follow, and they are separate:

1. **Going forward is fixed.** The fixture now breaks the character class
   (`sk-notArealDeepseekKey…` — alnum, so `lib/provider-tokens.js` still accepts it; never hex, so
   GitHub's pattern cannot match it), and `test/secret-shaped-fixtures.test.mjs` fails the build on
   any tracked file that carries one of twelve high-confidence vendor patterns. The other technique
   worth copying is already in those files: build the fixture at runtime, so no literal exists to
   scan.
2. **The commits already written still carry it**, and push protection scans every commit in the
   push range — not the tip. So sanitising HEAD does not by itself unblock the PR. The choice is a
   human's:
   - **click the unblock URL GitHub printed** (the console now surfaces it) — correct here, because
     the string is a fabricated fixture and not a live key, and it is one click; or
   - rewrite the history that carries it, which rewrites `master`.

**No rotation is needed for this one** — nothing was ever issued against it. That claim rests on the
commits that introduced it being test fixtures in this repo; if there is any doubt, whoever wrote
`a872221` should confirm before the bypass is clicked.

## The third option: a SQUASHED SNAPSHOT (2026-08-05)

Sanitising the tip did not unblock the PR, and that is not a bug — **push protection scans every
commit in the push range, not the ref.** The string was added in `a872221` and removed in `df10664`;
both are in the range, so GitHub kept refusing. That left two options, one of which rewrites the
project's main branch.

There is a third, and the console now offers it automatically when the refusal is a rule a squash
can actually fix (`squashHelps` in `web/src/api.js`: `secrets`, `file-size`, `signatures`,
`commit-message`, `linear-history`, `author-email`):

> **Open the PR from a squashed snapshot?** One commit carrying the current tree of `master`, on top
> of the remote base. The review diff is identical, the intermediate commits are not pushed, and
> nothing local is rewritten.

Mechanically it is one `git commit-tree`: the tree of local `<branch>`, parented on
`origin/<base>`. No checkout, no branch move, no rewrite — one dangling object that is pushed to the
head branch and then forgotten. **The local repository is untouched**, which is the point: the
alternative was rewriting `master`.

**It is not a bypass.** GitHub's own remediation is "remove the secret from the commits"; a snapshot
removes it from the commits *being pushed*. Push protection still runs and would still refuse a
snapshot whose tree carried a secret — which is exactly why the fixture lint has to stay green.

Two honesty rules are built in:

- the PR body **says** it is a snapshot, names the base it was built on, and states that the
  intermediate commits are not included — a reviewer must never think they are seeing every commit;
- it is **not offered for ref-level rules** (`pull-request-required`, `branch-name`, `creations`): a
  snapshot would be refused too, and an offer that cannot work is worse than none.

Proven end to end in `test/github-pr-squash.test.mjs`, against a bare repo whose pre-receive hook
scans the push range with `git log -S` the way push protection does: the ordinary PR is refused, the
squashed one opens, the pushed tree is byte-identical, and the local repo comes out unchanged.

## The recurring case — and the lint that now catches it before it ships (2026-08-05)

The 2026-08-04 incident had a second half nobody wanted to relearn: the hex fixture was removed in
`df10664`, the TIP was clean, and the range STILL refused every push because push protection scans
the commits, not the tip. That is not a one-off — it is the shape of the recurring failure:

1. a test adds a secret-shaped fixture (`sk-` + 32 invented hex chars is enough);
2. a later commit removes it again, so the tree is clean;
3. every push from that branch re-scans the range, finds the string, and refuses (GH013);
4. the only way forward is the squashed snapshot, which silently drops the branch's own history.

**`test/secret-shaped-fixtures.test.mjs` now scans the HISTORY as well as the tree.** It pipes
`git log -p` and checks every ADDED line against the same twelve vendor patterns, so a string that
was ever introduced into the branch's history fails the build the moment it lands — before it can
sit in a range for 112 commits. The two known 2026-08-04 introductions are grandfathered by commit

**Credential test fixtures are now GENERATED, not hand-written (2026-08-07).**
`test/_bin/tokens.mjs` builds every vendor's token SHAPE at runtime (`fakeTokens.claude()`,
`.deepseek()`, `.openaiProject()`, `.github()`, …), so no credential-shaped literal can ever exist
in a test file again — the whole "a fake that accidentally matches a vendor pattern" class is gone
by construction. The generator's outputs satisfy OUR shape predicates and are verified never to
match any of the twelve lint patterns.
sha (a forward-only repo does not rewrite history), and each grandfather entry is verified to still
be exactly that incident, so the list cannot rot into a licence for the next one.

The fix for a branch that ALREADY carries a secret-shaped string in its range is still the same as
it was: rewrite the introducing commit out of the history (a human call — it rewrites branch
history), or open the PR from the squashed snapshot. The lint is what stops the *next* branch from
ever being in that position.

## The COMMIT verb — "commit locally, then push" (2026-08-07)

The lint prevents FUTURE incidents, but a branch that already carries the string in its range still
forces the squash today. The permanent fix for that is GitHub's own **push-protection bypass list**
(repo Settings → Code security → Secret scanning → Push protection): add the specific
secret-shaped value and pushes containing it stop being blocked — no squash, no history rewrite,
no local change. For an org repo the setting lives at the ORG level.

For the everyday "I want to commit my local work and push it" flow, the console's header now has a
**⚑ Commit** button (and the git-graph broken-pipe modal keeps its Clear / Stash / Commit doors).
⚑ Commit stages every dirty TRACKED path on the xource (`git add -u`, so untracked junk and
ignored `.claude/` worktrees never ride along) and creates a real commit on `main` with the message
you type — then ↑ Push or ⇅ PR carries it. `commitXourceDirty` in `server/src/lib/xource-clean.js`
is the one-step door; it is PROVISION_MODE-gated and refuses mid-merge / off-main exactly like
commitXourceStaged.

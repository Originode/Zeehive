---
name: orient-in-a-new-repo
description: Use at the START of any job in a codebase you have not worked in — before designing, before editing, before deciding the task is impossible.
---

Twenty minutes, in this order. Stop as soon as you can answer the four questions at the bottom.

1. **The project's own instructions.** `AGENTS.md` or `CLAUDE.md` at the root, then `README`, then
   the docs they point at. These outrank anything you infer. A handover/history document is
   rationale only — read it for *why*, never for current facts (paths, names and tooling in one are
   usually years stale).
2. **How it runs and how it is tested.** The scripts/targets the project itself documents, and one
   existing test read end to end. Note how a test is invoked here — that is how you will prove your
   change, and it is rarely what you would have guessed.
3. **The shape.** Top-level directories and what each owns. Where does a request enter, and where
   does it reach storage? Name the two or three files your job actually lives in.
4. **The precedent.** Find something already built like the thing you are about to build, and read
   two examples of it. Your change copies their shape — naming, layout, error handling, tests. This
   step is what makes a diff reviewable, and skipping it is the most common way a correct change
   still gets rejected.
5. **Recent history.** The last handful of commits touching your area: what the team is currently
   doing to this code, and what they just stopped doing.

Then write down, in four lines:

- **entry point** — where the behaviour starts;
- **the file(s) I will change**;
- **the example I am copying**;
- **how I will prove it works** — the command, and what its output must say.

If you cannot fill those in, you have not oriented; keep reading. If you filled them in ten minutes
ago, stop reading and start building — research that produces nothing built is a failed turn.

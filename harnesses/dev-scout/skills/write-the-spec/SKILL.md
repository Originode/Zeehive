---
name: write-the-spec
description: Use when handed a vague or one-line ask — turn it into a spec somebody can build from and verify against, before any code is written.
---

Write these sections, in this order, and nothing else. Keep it to one page.

1. **Problem** — who is hurt today and how you can tell. One paragraph, in the product's language.
   If you cannot state the pain without repeating the proposed solution, the ask is a solution
   looking for a problem: say so.
2. **Outcome** — what is different afterwards, observably. Written as things a person or caller can
   see happen.
3. **In scope / Out of scope** — two lists. The second is the one that saves the project; put in it
   everything a reasonable reader might assume you meant.
4. **Behaviour** — the rules, including the ugly cases: empty, duplicate, concurrent, permission
   denied, already-exists, too large. Each rule gets its expected result.
5. **Constraints** — what must not change (public interfaces, stored data shape, existing
   behaviour), and any decision already made for you, so nobody re-litigates it.
6. **Acceptance** — a numbered checklist. Each line names the thing to exercise and what its output
   must say. If a line cannot be checked by running something, rewrite it until it can.
7. **Assumptions** — every ambiguity you resolved yourself, with the reading you chose. This section
   is what makes the spec safe to act on.
8. **Open questions** — only the ones a human must answer. Each one line, each with the decision it
   blocks. Three is a lot; ten means you stopped reading the code too early.

Ground it: before you write a requirement about existing behaviour, go and read that behaviour.
Cite the file or the observed output. A spec's authority comes from having actually looked.

---
name: prune-before-you-add
description: Use before writing any documentation — audit what already exists for truth, delete or fix what has rotted, and only then add.
---

1. **Inventory.** Find every document that already covers this ground, including the paragraph
   buried in an unrelated file. Duplicates are the source of most stale text: two copies, one
   updated.
2. **Audit each claim against the code.** For every factual sentence: still true, now false, or
   unverifiable. Check paths, names, commands, options and behaviour against source, not memory.
3. **Delete the false.** Do not annotate it, do not date it, do not add a correction underneath.
   The wrong sentence must leave, because a reader in a hurry reads whichever they see first.
4. **Delete the redundant.** If it is stated authoritatively elsewhere, point there instead. If two
   documents overlap, merge to one and make the other a pointer — never leave two.
5. **Delete what the code says better.** Documentation that narrates obvious code rots fastest and
   helps least. Keep the WHY: the constraint, the trade-off, the mistake this exists to prevent.
6. **Only now, add what is missing** — starting with the questions a newcomer actually asks: how do
   I run it, how do I verify it, what must I not break, where do I look next.

Never restate a fact that a system owns and can change under you: generated names, ports, version
numbers, lists of files in a directory. Say where the truth lives.

When you touch a document, leave it internally consistent — headings, order, and any index or map
that points at it. A doc map with a dead row teaches readers to distrust the whole map.

Report the deletions as prominently as the additions, with the reason each was untrue.

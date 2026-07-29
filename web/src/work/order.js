// WORK TRACKER — the ORDERING MATHS behind a drag, kept as a pure function on purpose.
//
// Dropping a card between two other cards is the one piece of the board that is genuinely
// ALGORITHMIC, and it is the piece a browser is needed to exercise — which is why it lives here,
// in plain JS with no React and no DOM, where `test/work-console.test.mjs` can import it directly
// and check the awkward cases (first slot, last slot, moving a card DOWN its own column) without
// pretending to have a browser.
//
// WHY A MIDPOINT AND NOT A RENUMBER: `sort_order` is a double so a re-order can write ONE row —
// the average of the new neighbours — instead of renumbering the whole column. A renumber is N
// writes, it races every other client editing that column, and it turns a drag into a migration.
// Doubles do run out of precision after ~50 splits of the same gap; the server may renormalise a
// column whenever it likes and nothing here depends on the numbers being pretty.
//
// THE OFF-BY-ONE THIS FUNCTION EXISTS TO GET RIGHT: the gap the human aimed at is numbered against
// the column WITH the dragged card still in it. Lift the card out and every gap below it shifts up
// by one — so moving a card DOWN its own column and dropping it "between B and C" must not be
// written as "after C". `wasAt` is that correction, and it applies only within the card's own
// column (across columns the card was never in the target list to begin with).

const so = (n) => (typeof n?.sort_order === 'number' ? n.sort_order : null);

// items: the TARGET column's cards, in display order (may still contain the dragged card).
// itemId: the card being dropped. index: the gap it was dropped on, 0 = before the first card.
// → { at, before, after, sortOrder } — `at` is the slot in the list WITHOUT the dragged card.
export function placement(items, itemId, index) {
  const list = Array.isArray(items) ? items : [];
  const rest = list.filter((i) => i.id !== itemId);
  const wasAt = list.findIndex((i) => i.id === itemId);
  let want = index === undefined || index === null ? rest.length : index;
  if (wasAt >= 0 && want > wasAt) want -= 1;                 // see the header: the lifted-card shift
  const at = Math.max(0, Math.min(want, rest.length));
  const before = rest[at - 1] || null;
  const after = rest[at] || null;
  let sortOrder;
  if (before && after) sortOrder = ((so(before) ?? 0) + (so(after) ?? (so(before) ?? 0) + 2)) / 2;
  else if (before) sortOrder = (so(before) ?? 0) + 1;        // last: one step past the tail
  else if (after) sortOrder = (so(after) ?? 0) - 1;          // first: one step before the head
  else sortOrder = 0;                                        // dropped into an empty column
  return { at, before, after, sortOrder };
}

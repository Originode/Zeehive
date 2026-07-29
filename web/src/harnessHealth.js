// IS THIS HARNESS CARRYING ANYTHING? The one place the console turns the health field the API reports
// — `bundle_empty` (no personality, no skills, no memory in the harness row) — into words.
//
// It is a pure function, kept out of the JSX so every surface that shows a harness (the harness
// manager, the dispatch picker, the honeycomb badge) says the SAME thing, and so it can be tested
// in plain node.
//
// Why it exists at all: a harness that carries NOTHING used to render identically to one
// carrying a 12.9k manual — same label, same badge, same picker row. That is how every manager zee
// in the deployed queenzee ran for weeks with a blank persona and nobody could see it. So the state
// is a WORD ("⚠ empty" / "⚠ no files"), never a shade: colour is reinforcement, not the signal.
export function emptyWarning(h) {
  if (!h) return null;
  if (h.bundle_empty) {
    return {
      kind: 'bundle_empty',
      chip: '⚠ empty',
      why: 'This harness carries no personality, no skills and no memory — a zee wearing it is '
         + 'briefed with nothing beyond the law layer.',
    };
  }
  return null;
}

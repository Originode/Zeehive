---
name: reproduce-first
description: Use at the start of any defect report — get the failure happening on demand and find the cause, before changing a line.
---

1. **Get the facts.** What was done, what was expected, what happened, where and when. Exact error
   text, exact input. A report without these is a rumour — go and get them.
2. **Make it happen.** Reproduce in your own environment, on the code the report came from. If you
   cannot, that is the finding: say precisely what you tried and what differs (data, version,
   config, timing, scale). Never proceed to a fix on an unreproduced bug without saying so loudly.
3. **Shrink it.** Remove input, steps and setup until nothing more can go. A one-line reproduction
   usually names its own cause.
4. **Then look.** Follow the wrong value backwards to the first point where it was wrong. Read the
   code between there and the symptom before forming a theory — most wrong theories come from
   theorising before reading.
5. **Test the theory cheaply.** Predict something you have not yet observed ("then it also fails
   with an empty list"), and check. A theory that only explains what you already saw explains
   nothing.
6. **Confirm the mechanism.** You should be able to say what happens, in what order, and why the
   result is wrong. Anything less is a correlation.

Traps: fixing where the symptom surfaced rather than where it started; changing three things at
once so you never learn which mattered; "it works now" after a restart, which is a reproduction
problem, not a fix; and stopping at the first plausible story.

Keep a written trail as you go — what you tried, what you saw. You will need it for the report, and
you will not remember it.

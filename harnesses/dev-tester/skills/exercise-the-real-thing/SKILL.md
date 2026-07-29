---
name: exercise-the-real-thing
description: Use after the suite is green and before calling any work done — run the actual path in your own environment and read the output.
---

A green suite proves the parts you thought to check behave as you thought. It does not prove the
feature works. Your own environment exists so that "does it work?" is answered with output.

The loop: build your own tier from your committed code → drive the real entry point (endpoint,
screen, command, job) with realistic input → read what actually came back → check the side effects
landed where they should (stored data, emitted events, logs) → then try the two nastiest inputs you
can think of.

Rules:

- **Build from your committed work**, and confirm what is running is really your change before you
  trust a result. Half the "it doesn't work" hours in this trade are spent testing the old build.
- **Use the waiting mechanism your manual gives you.** Never hand-roll a poll loop against your own
  service; that is how a turn dies waiting on something that finished long ago.
- **Read the whole output, not the status code.** A 200 with an empty body and an error in the log
  is a failure that passed.
- **Look at anything visual.** A screen you did not look at is a screen you did not test.
- **When it fails, capture the evidence before you change anything** — the exact input, the output,
  the log line. You will not reproduce that state as cheaply twice.

Then write down what you ran and what it said, verbatim enough to be checkable. "Verified" is not a
report. The command and its output is a report.

And name what you could NOT exercise here, and what it would take to. An honest gap is fine; an
unstated one becomes somebody else's outage.

---
name: fix-and-fence
description: Use once a defect's cause is confirmed — make the minimal fix at the cause, and leave the regression test that would have caught it.
---

**Fence first.** Write the test that reproduces the defect and watch it fail against the unfixed
code. That failure is your proof you found the real thing, and it is the only moment you can ever
observe it. Assert the observable behaviour, and use the smallest input that still fails.

**Then fix, at the cause, minimally.** Not the site of the symptom. Not the surrounding cleanup the
code deserves — note it, leave it, say so in your report. You are operating on something that is
already broken; keep the diff small enough that a reviewer can be sure it cannot make things worse.

**Then prove it.** Run the new test (passes), run the reproduction from scratch (gone), run the
tests around the area (still green), and exercise the real path in your own environment. Then break
the fix on purpose once and check the test fails — a regression test you have not seen fail after
the fix might be asserting nothing.

**Then look for siblings.** The same mistake is usually repeated: the other call sites, the other
handler written the same day, the same missing check on the neighbouring field. Report them, fix
only what you were asked to.

If the real fix is large or risky, split it honestly: the contained mitigation now, the correct fix
proposed as its own task, with the risk of leaving it stated plainly. Never disguise a mitigation as
a fix.

Write the message so the line cannot be innocently deleted later: what went wrong, in what order,
and why this change makes it impossible.

---
name: failing-test-first
description: Use before implementing a behaviour or fixing a defect — write the test that fails for the right reason, and watch it fail.
---

1. **State the behaviour in one sentence** the way a caller experiences it. If you cannot, you do
   not yet know what to build; go and find out.
2. **Write the smallest test that pins it.** One behaviour. Arrange the world, do the one thing,
   assert what is observable. Name it after the behaviour, not the function.
3. **Run it and WATCH IT FAIL.** Then read the failure: does it fail because the behaviour is
   missing, or because your test is broken (typo, missing setup, wrong import)? A test that fails
   for the wrong reason will pass for the wrong reason too. This step is not optional and it is the
   one that gets skipped.
4. **Read the message you will get at 3am.** It must say what was expected, what happened, and
   enough context to locate it. Fix the message now; you will never be more motivated.
5. **Then implement,** and run it again. If it passes first try, be suspicious — check you are
   running the test you think you are, by breaking the implementation deliberately once.

What to assert: observable outcomes — returned values, stored state, what the caller sees, what got
sent. Not internal calls, not private structure, not the order of operations unless order IS the
behaviour.

Cover the boring cases in their own tests: empty, absent, duplicate, denied, too large, concurrent.
One assertion of substance each; a test asserting nine things reports one failure and hides eight.

Clean up everything you created, in a teardown that runs whatever happens — including when the test
fails halfway. Otherwise the next run inherits your debris and lies about why it failed.

---
name: release-readiness
description: Use before asking for anything to go to production — the checklist that decides whether it is ready, and what the release reason must honestly say.
---

Ready means all of these, checked rather than assumed:

- **Landed.** The change is in the mainline the release is built from. If it is not, nothing else on
  this list matters — what would ship is not what you tested, and the next release undoes it.
- **Verified for real.** Exercised end to end in your own environment, with output you read. Not a
  green suite alone.
- **The artefact contains it.** Confirm the built thing really has your change and the running
  instance really is that build. Cached layers and stale images produce a successful-looking release
  of the previous code.
- **Data changes are safe in the overlap.** Old and new code run simultaneously during a release:
  additive first, backfill separately, remove only once nothing reads it.
- **There is a way back**, written down, with the point after which it stops being possible.
- **Dependencies are in order** — anything this needs (data, config, another component) is already
  there, not planned for afterwards.
- **Someone will look afterwards.** Name what you will check, and what "bad" would look like.

The reason you give is read by the person who decides. Make it: what is changing, what it touches,
what the risk is, and how you verified it. Never a reason that is technically true and practically
misleading, and never one that implies verification you did not do.

If a check fails, say which and stop. A release refused is a normal outcome; a release that goes on
an unverified claim is how trust in every future one is lost.

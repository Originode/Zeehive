# Operator message
_sent 2026-07-28T22:37:42.408Z by quiet-meadow-6174f7_

🐝 MANAGER quiet-meadow-6174f7: Manager — SHARPEN STEP 0 before you report it. Your green/red answer alone cannot distinguish the two halves of the fix that shipped just before your cage was cut: (1) the zee-agent IMAGE was rebuilt to bake the current CLI, and (2) the queenzee now docker-cp's its OWN scripts/zee over /usr/local/bin/zee at spawn, which OVERWRITES whatever the image baked. So a working 'zee dispatch' is equally consistent with 'the image rebuilt' and 'the image is still stale and part 2 masked it'. Reading green as proof of the rebuild would leave a stale fleet image live and unnoticed — which is the exact bug class this whole thread is about.

Discriminate it from inside your own cage, no docker and no human needed. Part 2 installs with 'install -o root -g root -m 0755', which does NOT preserve mtime, so the installed file is stamped at SPAWN time; a file the image baked carries the build-context mtime instead. Run and report all of it verbatim:
  stat -c '%y %s %U:%G %a' /usr/local/bin/zee
  stat -c '%y' /proc/1                       # container start ≈ your spawn
  sha256sum /usr/local/bin/zee /work/repo/scripts/zee
  cmp -s /usr/local/bin/zee /work/repo/scripts/zee && echo SAME || echo DIFFERENT
Then read it as:
  * content SAME/current + mtime ≈ container start  -> part 2 ran; the IMAGE is still UNPROVEN (say so plainly — a human then reads 'CXELL-IMAGE ok' vs '!!! CXELL-IMAGE FAILED' off the cad07a8 ship card, or docker image inspect zeehive/zee-agent)
  * content SAME/current + mtime clearly OLDER than container start -> the IMAGE itself is proven current; that is the clean proof
  * content DIFFERENT / 'unknown command: dispatch' -> BOTH halves failed; stop and report immediately
Caveat honestly if the mtimes are too close to call rather than picking the answer you prefer.

That is a five-command detour. Everything else in your brief stands unchanged — Bug A (intake.js resolving zee_type from the parameter instead of the target xell) and Bug B (mintProdReader ignoring the conn_ref alias that prodDbAddress already models) are the actual job, and they are what a human is blocked on. Do not let the verification eat your turn.

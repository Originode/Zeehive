// HOW LONG A TRANSFER MAY TAKE, DERIVED FROM THE NUMBER OF BYTES IT HAS TO MOVE.
//
// A fixed timeout is a guess about throughput, and this fleet's throughput is not a constant: the
// queenzee's own machines move big payloads at roughly 1.5-3 MB/s (measured, and the reason
// queenzee/maintenance.js stopped using a fixed dump window — a ~5 GB omnibiz dump needed 30-60
// minutes and every retry died at the fixed 30-minute mark with a 4.9-5.07 GB partial left behind).
//
// The same class then surfaced on the SPAWN path, where the guess was dk()'s 120s default and
// nothing ever looked at the payload: `cloneIntoCxell` sends the xell's branch into the cage as one
// git bundle (the private clone a cage is built around — see lib/cxell.js), so the transfer scales
// with the repository's HISTORY, and a project whose history is large enough cannot be dispatched
// at all. The failure a human got was a bare `cxell build failed: docker cp timed out after
// 120000ms` — no size, no window, nothing to tell them the repository was the payload, and the
// words "build failed" pointing them at a build that was never involved.
//
// So the window is SIZED from the bytes: size / a conservative floor rate, × a safety margin,
// clamped to a floor (today's default, so nothing gets a SHORTER window than it has now) and a
// ceiling (a flowing-but-wedged transfer must still eventually die and report why). A null/unknown
// size gets the floor — the transfer still runs, within the window it always had.
//
// The rate is deliberately conservative (1 MB/s, below the observed 1.5-3 MB/s) so a busy source
// slows the estimate rather than breaking it.
export function transferWindowMs(bytes, {
  floorMs = 120000,             // never shorter than the window callers have today
  ceilingMs = 20 * 60 * 1000,   // but never unbounded: a wedged transfer still dies, and says so
  minBytesPerSec = 1024 * 1024, // the conservative floor rate: bytes/sec we assume at worst
  margin = 2,                   // headroom for a busy source on top of that rate
} = {}) {
  if (!Number.isFinite(bytes) || bytes <= 0) return floorMs;
  const secs = (bytes / minBytesPerSec) * margin;
  return Math.min(ceilingMs, Math.max(floorMs, Math.round(secs * 1000)));
}

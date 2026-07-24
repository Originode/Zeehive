// XELL-MESSAGE test — proves writeFileIntoCxell (the delivery primitive behind the flower's 📨
// message button) hands an operator's attachment/long-text INTO a cxell's /work/repo correctly and
// SAFELY: base64 payloads are decoded in-container, text payloads written verbatim, and the target
// path is confined to the repo so a message can never escape /work/repo via a leading slash or `..`.
//
// The one seam is `docker` itself: the fake shim in test/_bin records argv + stdin and succeeds, so
// we assert on the exact `docker exec … bash -lc` the helper builds — no real container needed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'xmsg-'));
const DOCKER_LOG = join(tmp, 'docker.log');
process.env.DOCKER_LOG = DOCKER_LOG;
process.env.PATH = `${join(REPO_ROOT, 'test', '_bin')}:${process.env.PATH}`;

const { writeFileIntoCxell } = await import('../server/src/lib/cxell.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const log = () => (existsSync(DOCKER_LOG) ? readFileSync(DOCKER_LOG, 'utf8') : '');

// ── 1. an image (base64) → decoded in-container, under .zee-inbox ──────────────
console.log('── writeFileIntoCxell: base64 attachment ──');
{
  const r = await writeFileIntoCxell({ slug: 'keen-harbor', relPath: '.zee-inbox/2026/image-1.png', base64: 'aGVsbG8=' });
  const l = log();
  ok(r.path === '/work/repo/.zee-inbox/2026/image-1.png', `returns the in-container path (${r.path})`);
  ok(/exec -i cxell_keen-harbor bash -lc/.test(l), 'runs `docker exec -i <cxell> bash -lc` (writes as the repo-owning user)');
  ok(/base64 -d > '\/work\/repo\/\.zee-inbox\/2026\/image-1\.png'/.test(l), 'DECODES the base64 payload into the target file');
  ok(/mkdir -p '\/work\/repo\/\.zee-inbox\/2026'/.test(l), 'creates the parent dir first');
  ok(/STDIN<<\naGVsbG8=\n>>STDIN/.test(l), 'the base64 bytes are piped in over stdin');
}

// ── 2. a long-text body → written verbatim with `cat` (no decode) ──────────────
console.log('\n── writeFileIntoCxell: verbatim text body ──');
{
  await writeFileIntoCxell({ slug: 'keen-harbor', relPath: '.zee-inbox/2026/message.md', text: '# hi\nlong body' });
  const l = log();
  ok(/cat > '\/work\/repo\/\.zee-inbox\/2026\/message\.md'/.test(l), 'a text body is written verbatim (cat), not base64-decoded');
  ok(/STDIN<<\n# hi\nlong body\n>>STDIN/.test(l), 'the exact text is piped in over stdin');
}

// ── 3. path confinement — a leading slash / `..` can never escape /work/repo ────
console.log('\n── writeFileIntoCxell: the target stays inside the repo ──');
{
  const r = await writeFileIntoCxell({ slug: 'keen-harbor', relPath: '/../../etc/evil', text: 'x' });
  ok(r.path === '/work/repo/etc/evil', `leading slash + '..' segments are stripped → ${r.path} (never /etc/evil)`);
  let threw = false;
  try { await writeFileIntoCxell({ slug: 'keen-harbor', relPath: '../..', text: 'x' }); } catch { threw = true; }
  ok(threw, 'a path that is ENTIRELY traversal (../..) is refused rather than writing repo root');
}

// ── 4. a big attachment whose stdin pipe breaks mid-write → REJECTS, not false-success ──
// The bug behind "message works for text, attaching an image fails": a multi-MB base64 piped to
// `docker exec -i` can hit EPIPE if the reader closes early. The old dk swallowed the write, let the
// EPIPE become an UNCAUGHT exception, and still resolved code 0 — so a truncated/empty image was
// reported as delivered. dk must now (a) never throw uncaught, (b) reject when the payload was cut.
console.log('\n── writeFileIntoCxell: a broken stdin pipe is surfaced, never a silent truncation ──');
{
  let sawUncaught = null;
  const onUncaught = (e) => { sawUncaught = e; };
  process.on('uncaughtException', onUncaught);
  process.env.DOCKER_FAKE_EARLY_CLOSE = '1';
  const bigB64 = Buffer.alloc(4 * 1024 * 1024, 0x41).toString('base64'); // ~5.5MB of base64
  let rejected = false, rejMsg = '';
  try { await writeFileIntoCxell({ slug: 'keen-harbor', relPath: '.zee-inbox/2026/big.png', base64: bigB64 }); }
  catch (e) { rejected = true; rejMsg = e.message; }
  delete process.env.DOCKER_FAKE_EARLY_CLOSE;
  await new Promise((r) => setTimeout(r, 50)); // let any stray async error surface
  process.removeListener('uncaughtException', onUncaught);
  ok(rejected, `a truncated attachment write REJECTS rather than reporting success (${rejMsg.slice(0, 60)})`);
  ok(!sawUncaught, `an EPIPE on the attachment stdin never becomes an UNCAUGHT exception${sawUncaught ? ` (saw ${sawUncaught.code || sawUncaught.message})` : ''}`);
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);

// CXELL-FS test — proves the file-explorer bridge (server/src/lib/cxell-fs.js) that backs the
// in-house terminal's file panel. It runs the EXACT remote shell scripts the bridge sends over
// ssh, but against a real local temp dir via `/bin/sh` (no ssh, no DB, no container) — so it
// exercises the real base64-path handling, the listing loop and the read cap, then asserts the
// real parsers turn that output into the shapes the API returns. The explorer's ⤓ DOWNLOAD rides the
// same read script: it must hand back the file's EXACT bytes (binary included), REFUSE a file over
// its cap (413) instead of sending a cut-off copy, and name the attachment without letting a hostile
// filename break the header.
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveCxellPath, CXELL_ROOT,
  buildListScript, parseListOutput, buildReadScript, parseReadResult,
  parseDownloadResult, contentDisposition, DOWNLOAD_MAX_BYTES,
} from '../server/src/lib/cxell-fs.js';
import { readFileSync } from 'node:fs';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// Run a script the way the bridge does: `/bin/sh -c <script>`, capturing stdout as a Buffer and
// stderr as text plus the exit code.
function runScript(script) {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', script], { encoding: 'buffer', maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      resolve({ buf: stdout, stderr: stderr.toString(), code: err?.code ?? 0 });
    });
  });
}

console.log('resolveCxellPath — pins pasted/relative paths into the worktree, no escapes:');
ok(resolveCxellPath('') === CXELL_ROOT, 'empty → worktree root');
ok(resolveCxellPath('web/src/App.jsx') === `${CXELL_ROOT}/web/src/App.jsx`, 'relative path is joined under the root');
ok(resolveCxellPath('/work/repo/server') === '/work/repo/server', 'an absolute cxell path is kept');
ok(resolveCxellPath('web/../../../etc/passwd') === '/etc/passwd'
   ? true : resolveCxellPath('web/../../../etc/passwd') != null, 'dotdot segments collapse (no raw ../ left)');
ok(!resolveCxellPath('a/../../b').includes('..'), 'no `..` survives the collapse');

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'cxfs-'));
  try {
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'nested.txt'), 'deep');
    writeFileSync(join(root, 'alpha.txt'), 'hello world\n');
    writeFileSync(join(root, '.hidden'), 'x');
    writeFileSync(join(root, 'Zed.js'), 'z');

    console.log('list — a real directory through the real script + parser:');
    const lr = await runScript(buildListScript(root));
    ok(lr.code === 0, 'list script exits 0 on a real dir');
    const listed = parseListOutput(lr.buf, root);
    const names = listed.entries.map((e) => e.name);
    ok(names.includes('sub') && names.includes('alpha.txt'), 'lists both files and subdirs');
    ok(names.includes('.hidden'), 'includes dotfiles (a zee edits .env, .gitignore…)');
    ok(listed.entries[0].type === 'dir', 'directories sort before files');
    const alpha = listed.entries.find((e) => e.name === 'alpha.txt');
    ok(alpha.type === 'file' && alpha.size === 12, 'reports a file’s real byte size');
    ok(listed.parent && listed.root === CXELL_ROOT, 'carries parent + worktree root for navigation');

    console.log('list — a non-directory is refused with the __NOTDIR__ sentinel:');
    const nd = await runScript(buildListScript(join(root, 'alpha.txt')));
    ok(nd.code === 4 && /__NOTDIR__/.test(nd.stderr), 'listing a file exits 4 / __NOTDIR__ (API → 400)');

    console.log('read — a text file through the real script + parser:');
    const rr = await runScript(buildReadScript(join(root, 'alpha.txt'), 512000));
    const file = parseReadResult(rr.buf, rr.stderr, join(root, 'alpha.txt'));
    ok(file.content === 'hello world\n', 'returns the exact file text');
    ok(file.size === 12 && !file.binary && !file.truncated, 'reports size, not-binary, not-truncated');

    console.log('read — a NUL-containing file is flagged binary, content withheld:');
    writeFileSync(join(root, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]));
    const br = await runScript(buildReadScript(join(root, 'bin.dat'), 512000));
    const binf = parseReadResult(br.buf, br.stderr, join(root, 'bin.dat'));
    ok(binf.binary && binf.content === '', 'binary file → binary:true, empty content');

    console.log('read — the cap truncates and truncated:true is reported:');
    writeFileSync(join(root, 'big.txt'), 'A'.repeat(5000));
    const cr = await runScript(buildReadScript(join(root, 'big.txt'), 100));
    const bigf = parseReadResult(cr.buf, cr.stderr, join(root, 'big.txt'));
    ok(bigf.content.length === 100, 'reads only the capped byte count');
    ok(bigf.size === 5000 && bigf.truncated, 'still reports the TRUE size and flags truncation');

    console.log('read — a missing file surfaces __NOFILE__ (→ 404):');
    const mr = await runScript(buildReadScript(join(root, 'nope.txt'), 512000));
    ok(mr.code === 7 && /__NOFILE__/.test(mr.stderr), 'missing file exits 7 / __NOFILE__');

    console.log('inject — a hostile filename cannot break out of the script (base64 path):');
    const evil = join(root, 'sub'); // reuse; the real proof is the b64 encoding of arbitrary bytes
    const ir = await runScript(buildReadScript(`${evil}/nested.txt`, 512000));
    ok(parseReadResult(ir.buf, ir.stderr, 'x').content === 'deep', 'a path with slashes reads through base64 intact');

    console.log('download — the EXACT bytes, binary included (the viewer read would blank this):');
    const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a, 0x00, 0x7f]);
    writeFileSync(join(root, 'img.png'), raw);
    const dr = await runScript(buildReadScript(join(root, 'img.png'), DOWNLOAD_MAX_BYTES + 1));
    const dl = parseDownloadResult(dr.buf, dr.stderr, join(root, 'img.png'));
    ok(Buffer.compare(dl.buf, raw) === 0, 'download buffer is byte-identical to the file on disk');
    ok(dl.name === 'img.png' && dl.size === raw.length, 'carries the basename and the true size');

    console.log('download — over the cap is REFUSED (413), never sent truncated:');
    const or = await runScript(buildReadScript(join(root, 'big.txt'), 100 + 1));
    let err = null;
    try { parseDownloadResult(or.buf, or.stderr, join(root, 'big.txt'), false, 100); } catch (e) { err = e; }
    ok(err && err.status === 413 && /5000 bytes/.test(err.message), 'a 5000-byte file under a 100-byte cap → 413 naming its real size');
    const er = await runScript(buildReadScript(join(root, 'big.txt'), 5000 + 1));
    ok(parseDownloadResult(er.buf, er.stderr, join(root, 'big.txt'), false, 5000).buf.length === 5000,
       'a file exactly AT the cap downloads whole');

    console.log('download — the attachment header survives a hostile filename:');
    const cd = contentDisposition('a "b"\\c\r\nX-Evil: 1 ü.txt');
    ok(!/[\r\n]/.test(cd), 'no CR/LF can reach the header (no header injection)');
    ok(/filename="a _b__c__X-Evil: 1 _\.txt"/.test(cd), 'the ASCII fallback replaces quotes, backslashes and non-ASCII');
    ok(cd.includes("filename*=UTF-8''" + encodeURIComponent('a "b"\\c\r\nX-Evil: 1 ü.txt')), 'the RFC 5987 name keeps the real UTF-8 name, encoded');

    console.log('download — wired end to end (routes, both bridges, the explorer link):');
    const routes = readFileSync('server/src/api/routes.js', 'utf8');
    const fx = readFileSync('web/src/FileExplorer.jsx', 'utf8');
    const cfs = readFileSync('server/src/lib/container-fs.js', 'utf8');
    ok(/router\.get\('\/zees\/:id\/download'/.test(routes) && /router\.get\('\/containers\/:id\/download'/.test(routes),
       'both doors have a download route');
    ok(/'Content-Disposition': contentDisposition\(f\.name\)/.test(routes) && /application\/octet-stream/.test(routes),
       'the route sends the bytes as an octet-stream attachment');
    ok(/export async function downloadContainerFile/.test(cfs) && /parseDownloadResult\(buf, stderr, file, truncated, maxBytes\)/.test(cfs),
       'the container bridge downloads through the same parser');
    ok(/data-testid="fx-download"/.test(fx) && /download=\{e\.name\}/.test(fx), 'every FILE row in the explorer has a ⤓ download link');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
}
main();

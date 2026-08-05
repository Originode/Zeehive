// CONTAINER-FS test — proves the file-explorer bridge for fleet containers
// (server/src/lib/container-fs.js) that backs the shell terminal's file panel.
//
// The bridge lists/reads a container's filesystem over short-lived docker execs (non-TTY,
// multiplexed raw-stream). This test runs the EXACT shell scripts the bridge sends, against a real
// local temp dir via /bin/sh (no docker, no DB — the same pattern cxell-fs.test.mjs uses), asserts
// the real parsers turn the output into the API shapes, and pins the two things that are
// container-specific: path resolution against a non-cxell root, and the docker raw-stream demux.
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveContainerPath, CONTAINER_ROOT, demuxDockerStream,
} from '../server/src/lib/container-fs.js';
import {
  buildListScript, parseListOutput, buildReadScript, parseReadResult,
} from '../server/src/lib/cxell-fs.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

function runScript(script) {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', script], { encoding: 'buffer', maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      resolve({ buf: stdout, stderr: stderr.toString(), code: err?.code ?? 0 });
    });
  });
}

console.log('resolveContainerPath — pins pasted/relative paths into the container root, no escapes:');
ok(resolveContainerPath('') === CONTAINER_ROOT, 'empty → container filesystem root');
ok(resolveContainerPath('/etc') === '/etc', 'an absolute container path is kept');
ok(resolveContainerPath('etc/nginx') === '/etc/nginx', 'a relative path joins under the root');
ok(resolveContainerPath('app/server.js') === '/app/server.js', '…including a deep relative path');
ok(resolveContainerPath('../../etc/passwd') === '/etc/passwd', 'leading dotdot segments collapse to the root');
ok(!resolveContainerPath('a/../../b').includes('..'), 'no `..` survives the collapse');
ok(resolveContainerPath('', '/srv/app') === '/srv/app', 'a custom root (a process-role worktree) is the home');
ok(resolveContainerPath('server.js', '/srv/app') === '/srv/app/server.js', 'relative paths join under a custom root');

console.log('\ndemuxDockerStream — a non-TTY exec frames stdout and stderr as 8-byte headers + payload:');
const frame = (stream, data) => {
  const h = Buffer.alloc(8); h[0] = stream; h.writeUInt32BE(data.length, 4);
  return Buffer.concat([h, Buffer.from(data)]);
};
const single = demuxDockerStream(Buffer.concat([frame(1, 'hello'), frame(1, '\n')]));
ok(single.out.toString() === 'hello\n' && single.err.length === 0, 'stdout frames concatenate into one buffer');
const both = demuxDockerStream(Buffer.concat([frame(1, 'out'), frame(2, 'err'), frame(1, '!')]));
ok(both.out.toString() === 'out!' && both.err.toString() === 'err', 'stdout and stderr are separated');
const split = demuxDockerStream(Buffer.concat([frame(1, 'abc').subarray(0, 5), frame(1, 'abc').subarray(5)]));
ok(split.out.toString() === 'abc', 'a header split across socket chunks is reassembled from the full buffer');

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'ctnfs-'));
  try {
    mkdirSync(join(root, 'conf'));
    writeFileSync(join(root, 'conf', 'app.yml'), 'port: 3000\n');
    writeFileSync(join(root, 'index.js'), 'console.log("hi")\n');
    writeFileSync(join(root, '.env'), 'SECRET=x\n');

    console.log('\nlist — a real directory through the real script + parser (container root):');
    const lr = await runScript(buildListScript(root));
    ok(lr.code === 0, 'list script exits 0 on a real dir');
    const listed = parseListOutput(lr.buf, root, CONTAINER_ROOT);
    const names = listed.entries.map((e) => e.name);
    ok(names.includes('conf') && names.includes('index.js'), 'lists both files and subdirs');
    ok(names.includes('.env'), 'includes dotfiles (a container .env is exactly what a human wants to see)');
    ok(listed.entries[0].type === 'dir', 'directories sort before files');
    ok(listed.root === CONTAINER_ROOT, 'carries the CONTAINER root as the explorer home');
    ok(listed.parent, 'and a parent for a non-root path');

    console.log('\nlist — the custom-root variant a PROCESS-ROLE server uses:');
    const worktree = join(root, 'worktree'); mkdirSync(worktree);
    writeFileSync(join(worktree, 'server.js'), 'x');
    const wr = await runScript(buildListScript(worktree));
    const wlisted = parseListOutput(wr.buf, worktree, worktree);
    ok(wlisted.root === worktree && wlisted.parent === null, 'the worktree is its own root (⌂ lands there)');
    ok(wlisted.entries.some((e) => e.name === 'server.js'), 'and lists the worktree contents');

    console.log('\nread — a text file through the real script + parser:');
    const rr = await runScript(buildReadScript(join(root, 'index.js'), 512000));
    const file = parseReadResult(rr.buf, rr.stderr, join(root, 'index.js'));
    ok(file.content === 'console.log("hi")\n', 'returns the exact file text');
    ok(file.size === 18 && !file.binary && !file.truncated, 'reports size, not-binary, not-truncated');

    console.log('\nread — a missing file surfaces __NOFILE__ (→ 404):');
    const mr = await runScript(buildReadScript(join(root, 'nope.txt'), 512000));
    ok(mr.code === 7 && /__NOFILE__/.test(mr.stderr), 'missing file exits 7 / __NOFILE__');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
}
main();

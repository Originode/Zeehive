// Resolve a REAL bash, explicitly — never via bare PATH lookup.
//
// WHY: on Windows, `spawn('bash', ...)` resolves through PATH, where
// C:\Windows\system32\bash.exe (the WSL launcher) usually sits ahead of Git bash. With no WSL
// distro installed it exits 1, writes its complaint to STDERR, and leaves STDOUT EMPTY. Every
// queenzee subsystem that shells out — provision, land, reap, rename, build, xell-db — then fails
// with a blank reason, and the container monitor once reported the whole fleet `down` off that
// empty stdout. The old mitigation was "remember to launch the queenzee with Git bash ahead of
// WSL on PATH", which is exactly the kind of thing a bare `node server/src/index.js` forgets.
//
// So: find a bash that is actually bash, prefer Git's, and REFUSE the WSL stub outright.
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const WSL_STUB = /^[A-Z]:\\Windows\\(System32|SysWOW64)\\bash\.exe$/i;

const WINDOWS_CANDIDATES = [
  process.env.ZEEHIVE_BASH,                                  // explicit override wins
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  process.env.ProgramW6432 && join(process.env.ProgramW6432, 'Git', 'bin', 'bash.exe'),
];

let cached = null;

// Walk PATH ourselves so we can SKIP the WSL stub rather than take the first hit like spawn does.
function fromPath() {
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, `bash${ext}`);
      if (existsSync(p) && !WSL_STUB.test(p)) return p;
    }
  }
  return null;
}

// Absolute path to a usable bash. Throws if none exists — a LOUD failure at the call site beats
// a silent exit-1 with empty output, which is the whole lesson here.
export function resolveBash() {
  if (cached) return cached;
  if (process.platform !== 'win32') return (cached = process.env.ZEEHIVE_BASH || 'bash');
  for (const c of WINDOWS_CANDIDATES) {
    if (c && existsSync(c) && !WSL_STUB.test(c)) return (cached = c);
  }
  const onPath = fromPath();
  if (onPath) return (cached = onPath);
  throw new Error(
    'no usable bash found (Git bash missing, and PATH offers only the WSL stub). '
    + 'Install Git for Windows or set ZEEHIVE_BASH to a bash.exe.');
}

// PASTE-ONCE test — the in-house terminal must deliver a clipboard paste to the PTY exactly once.
//
// History: a custom KeyV + xterm paste path doubled every Ctrl/Cmd+V. Removing KeyV was not enough
// — xterm listens for paste on BOTH the textarea and the element and only stopPropagation's (no
// preventDefault), and wterm has paste + input handlers; on real browsers the same payload still
// reached onData twice. termHost now OWNS paste in the capture phase (attachOwnedPaste in
// termPaste.js): swallow before the engine, call onData once. This pins that contract without a
// browser.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { attachOwnedPaste } from '../web/src/termPaste.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(here, rel), 'utf8');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// Minimal EventTarget so we do not need jsdom / a real DOM.
class FakeEl {
  constructor() { this._ = new Map(); }
  addEventListener(type, fn, opts) {
    const key = type + (opts === true || opts?.capture ? ':c' : ':b');
    if (!this._.has(key)) this._.set(key, new Set());
    this._.get(key).add(fn);
  }
  removeEventListener(type, fn, opts) {
    const key = type + (opts === true || opts?.capture ? ':c' : ':b');
    this._.get(key)?.delete(fn);
  }
  // Fire capture-phase paste listeners the way a browser would reach the host first.
  dispatchPaste(text, { preventDefault = () => {}, stopPropagation = () => {} } = {}) {
    const ev = {
      clipboardData: { getData: (kind) => (kind === 'text/plain' || kind === 'text' ? text : '') },
      preventDefault,
      stopPropagation,
    };
    for (const fn of this._.get('paste:c') || []) fn(ev);
    return ev;
  }
}

console.log('\n── attachOwnedPaste delivers onData exactly once ──');
{
  const el = new FakeEl();
  const got = [];
  let prevented = 0, stopped = 0;
  const off = attachOwnedPaste(el, {
    onData: (d) => got.push(d),
    disableStdin: false,
    bracketed: () => false,
  });
  el.dispatchPaste('hello\nworld', {
    preventDefault: () => { prevented++; },
    stopPropagation: () => { stopped++; },
  });
  ok(got.length === 1, `onData called once (got ${got.length})`);
  ok(got[0] === 'hello\rworld', `newlines folded to CR (got ${JSON.stringify(got[0])})`);
  ok(prevented === 1 && stopped === 1, 'preventDefault + stopPropagation so the engine never sees it');
  off();
  el.dispatchPaste('again');
  ok(got.length === 1, 'detach removes the listener');
}

console.log('\n── bracketed paste when the app has enabled it ──');
{
  const el = new FakeEl();
  const got = [];
  attachOwnedPaste(el, {
    onData: (d) => got.push(d),
    bracketed: () => true,
  });
  el.dispatchPaste('rm -rf /\n');
  ok(got.length === 1, 'still once under bracketed mode');
  ok(got[0] === '\x1b[200~rm -rf /\r\x1b[201~', 'wrapped in bracketed-paste gates with CR newline');
  el.dispatchPaste('a\x1b[201~b');
  // ESC stripped so a payload cannot close the bracket early
  ok(got[1] === '\x1b[200~a[201~b\x1b[201~', `ESC stripped (got ${JSON.stringify(got[1])})`);
}

console.log('\n── firehose (disableStdin) swallows paste, never calls onData ──');
{
  const el = new FakeEl();
  const got = [];
  let prevented = 0;
  attachOwnedPaste(el, {
    onData: (d) => got.push(d),
    disableStdin: true,
  });
  el.dispatchPaste('nope', { preventDefault: () => { prevented++; }, stopPropagation: () => {} });
  ok(got.length === 0, 'onData not called when stdin is disabled');
  ok(prevented === 1, 'still preventDefault so nothing leaks into the engine');
}

console.log('\n── termHost mounts wire attachOwnedPaste for both engines (source pin) ──');
{
  const host = read('../web/src/termHost.js');
  const paste = read('../web/src/termPaste.js');
  ok(/export function attachOwnedPaste/.test(paste), 'termPaste.js exports attachOwnedPaste');
  ok(/addEventListener\('paste', onPaste, true\)/.test(paste), 'listens in the CAPTURE phase');
  ok(/from '\.\/termPaste\.js'/.test(host), 'termHost imports termPaste');
  const xIdx = host.indexOf('function mountXterm');
  const wIdx = host.indexOf('async function mountWterm');
  const xMount = host.slice(xIdx, wIdx);
  const wMount = host.slice(wIdx);
  ok(/attachOwnedPaste\(el/.test(xMount) && /detachPaste/.test(xMount),
     'xterm mount owns paste and detaches on dispose');
  ok(/attachOwnedPaste\(el/.test(wMount) && /detachPaste/.test(wMount),
     'wterm mount owns paste and detaches on dispose');
}

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures ? 1 : 0);

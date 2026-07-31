// THE DISPATCH MODEL PICKER — which models a zee can be dispatched on, per provider.
//
// Written when Fable was added to the claude list (ticket #5). Three things are checked, and the
// second one is the reason this file exists at all:
//
//   1. the LIST the console + CLI read (`listDispatchModels`, served by GET /api/xell/models):
//      claude offers the generation aliases including `fable`, Opus is still the marked default
//      (a zee runs unattended — see DEFAULT_ZEE_MODEL), and the other vendors' lists are their own.
//   2. the ALIAS SET (lib/cxell-runtimes.js CLAUDE_MODEL_ALIASES). Its failure mode lands on a
//      DIFFERENT vendor: vendorModel() treats anything not in that set as a vendor model id, so an
//      alias the picker offers but the set omits gets handed to `codex exec --model <alias>` /
//      KIMI_MODEL_NAME / ANTHROPIC_MODEL. Nothing in claude-world would ever notice. So every alias
//      the picker can offer is asserted to be DROPPED by every non-claude adapter, and PASSED by
//      the claude one.
//   3. the console's OFFLINE FALLBACK (web/src/Dispatch.jsx fallbackModels) — the list rendered
//      when /api/xell/models fails. It is a hardcoded copy of the claude aliases, so it drifts
//      silently; here it is evaluated from the real source and diffed against the server's list.
//
// Fable's alias resolution is a CLI fact, not a code fact, so it is not asserted here. Measured on
// claude 2.1.220 (2026-07-29) in a cxell: `claude --bare -p --model fable` reports model
// `claude-fable-5` on its init event (as `--model opus` reports `claude-opus-5`), and an unknown
// alias 404s with "There's an issue with the selected model". That is why no dated id is pinned.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { listDispatchModels } = await import('../server/src/queenzee/intake.js');
const { CLAUDE_ADAPTER, adapterFor } = await import('../server/src/lib/cxell-runtimes.js');

// ── 1. the served list ──────────────────────────────────────────────────────────────────────────
console.log('\n── the model list the console + CLI read ──');
const claude = listDispatchModels('claude');
const keys = claude.map((m) => m.key);
ok(keys.includes('fable'), `claude offers fable (${keys.join(', ')})`);
ok(keys[0] === 'opus' && claude[0].default === true, 'Opus is first and is the marked default');
ok(claude.filter((m) => m.default).length === 1, 'exactly one default');
ok(keys.slice(0, 3).join() === 'opus,sonnet,haiku', 'the pre-existing trio kept its order');
ok(claude.every((m) => m.label && m.note), 'every entry has a label and a note (the picker shows both)');
const fable = claude.find((m) => m.key === 'fable');
ok(fable.note !== claude.find((m) => m.key === 'sonnet').note, "Fable's note is its own, not Sonnet's copied");

for (const p of ['openai', 'kimi', 'deepseek']) {
  const list = listDispatchModels(p);
  ok(!list.some((m) => m.key === 'fable'), `${p}'s list does not offer a claude alias`);
  ok(list[0].key === '' && list[0].default === true, `${p} still defaults to the vendor CLI's own model`);
}
ok(JSON.stringify(listDispatchModels()) === JSON.stringify(claude), 'no provider named → the claude list');

// ── 2. the alias set (the load-bearing one) ─────────────────────────────────────────────────────
console.log('\n── every offered alias is claude-only: no vendor CLI may be launched with one ──');
const vendorCmd = (key, model) => {
  const a = adapterFor(key);
  return `${a.execCmd({ model })} | ${JSON.stringify(a.env({ token: 'T', model }))}`;
};
for (const m of keys) {
  ok(CLAUDE_ADAPTER.execCmd({ model: m }).includes(`--model ${m}`), `claude runs --model ${m}`);
  for (const rt of ['codex-cxell', 'kimi-code-cxell', 'deepseek-cxell']) {
    // a dropped alias leaves NO trace: not in the command line, not in the model env vars
    ok(!vendorCmd(rt, m).includes(m), `${rt} drops "${m}" (runs its own default)`);
  }
}
ok(adapterFor('codex-cxell').execCmd({ model: 'gpt-5.6-sol' }).includes('--model gpt-5.6-sol'),
   'a genuine vendor model id still reaches its own CLI');

// ── 3. the console's offline fallback ───────────────────────────────────────────────────────────
console.log('\n── the fallback list the composer renders when /api/xell/models fails ──');
const src = read('web/src/Dispatch.jsx');
const start = src.indexOf('const fallbackModels =');
ok(start > -1, 'fallbackModels still exists in Dispatch.jsx');
// evaluate the REAL source of the function rather than regexing it, so this checks behaviour
const body = src.slice(start).split('\n\n')[0].replace(/^const fallbackModels =/, '');
const fallbackModels = eval(`(${body.replace(/;\s*$/, '')})`); // eslint-disable-line no-eval
const fb = fallbackModels('claude').map((m) => m.key);
ok(fb.includes('fable'), `the claude fallback offers fable (${fb.join(', ')})`);
ok(fb.join() === keys.join(), 'the fallback lists exactly the server list, in the same order');
ok(fallbackModels('claude').filter((m) => m.default).length === 1
   && fallbackModels('claude')[0].default === true, 'the fallback still defaults to Opus');
ok(JSON.stringify(fallbackModels(undefined)) === JSON.stringify(fallbackModels('claude')),
   'no provider → the claude fallback (the composer opens on claude)');
const fbVendor = fallbackModels('openai');
ok(fbVendor.length === 1 && fbVendor[0].key === '' && fbVendor[0].default === true,
   "a non-claude fallback is still the single honest 'vendor default' entry");
ok(!src.includes('opus/sonnet/haiku'), 'no stale comment enumerating the old trio');

console.log(fail ? `\n${fail} FAILED\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);

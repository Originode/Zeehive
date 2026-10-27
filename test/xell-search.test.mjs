// "ADD A SEARCH BUTTON WITH A HOTKEY TO SEARCH AND FILTER XELLS BY KEYWORDS."
//
// The honeycomb draws ONE level of the work-node tree, so finding a particular xell meant drilling.
// The 🔍 chip in the crumb strip (hotkey `/` or Ctrl/⌘+K) opens a keyword box; while a query is
// set, the honeycomb draws EVERY xell of the project holding ALL the keywords, from any level.
//
// WHAT IS FENCED HERE:
//   1. the RULE (real module, web/src/hive/search.js): tokenising, the AND match over the fields a
//      human types (slug, branch, task, zee, harness, runtime, model, status, card title), and
//      the hotkey — which never fires while typing in an input, and never inside a terminal;
//   2. the WIRING (App.jsx source text, like honeycomb-level-count.test.mjs): the button, the
//      input, the count, the flattened filter, Escape owned by the box, the level chip silenced.
import { searchTokens, xellHaystack, xellMatches, isSearchHotkey } from '../web/src/hive/search.js';
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

console.log('\nsearchTokens');
ok(JSON.stringify(searchTokens('  Auth   REFACTOR ')) === '["auth","refactor"]', 'splits on whitespace, lowercases, drops empties');
ok(searchTokens('').length === 0 && searchTokens(null).length === 0, 'empty / null query → no tokens');

console.log('\nxellMatches — AND over the searchable fields');
const x = { slug: 'calm-delta-5061d6', branch: 'spinoff/calm-delta-5061d6', status: 'working',
  task_text: 'Add a search button', zee_name: 'zee-7', zee_status: 'online', harness_label: 'Dev Base',
  runtime_label: 'Claude Code', zee_model: 'claude-opus', work_item: { title: 'Honeycomb search', status: 'working' } };
ok(xellMatches(x, []), 'no keywords → everything matches');
ok(xellMatches(x, searchTokens('calm')), 'matches the slug');
ok(xellMatches(x, searchTokens('SEARCH button')), 'matches the task text, case-insensitive, every keyword');
ok(xellMatches(x, searchTokens('dev base opus')), 'matches harness + model together');
ok(xellMatches(x, searchTokens('honeycomb')), 'matches the work-item (card) title');
ok(!xellMatches(x, searchTokens('calm grok')), 'ONE keyword missing → no match (AND, not OR)');
ok(xellMatches({ slug: 'p', is_production: true }, searchTokens('prod')), 'production xells answer to "prod"');
ok(xellHaystack(null) === '' && !xellHaystack({ slug: 'a', task_text: null }).includes('null'),
   'missing fields never leak "null"/"undefined" into the haystack');

console.log('\nisSearchHotkey');
const tgt = (tagName, extra = {}) => ({ tagName, isContentEditable: false, closest: () => null, ...extra });
ok(isSearchHotkey({ key: '/', target: tgt('BODY') }), '`/` on the page opens search');
ok(!isSearchHotkey({ key: '/', target: tgt('INPUT') }), '`/` typed in an input stays a `/`');
ok(!isSearchHotkey({ key: '/', target: tgt('TEXTAREA') }), '`/` typed in a composer stays a `/`');
ok(!isSearchHotkey({ key: '/', target: tgt('DIV', { isContentEditable: true }) }), '`/` in contenteditable stays a `/`');
ok(isSearchHotkey({ key: 'k', ctrlKey: true, target: tgt('BODY') }), 'Ctrl+K opens search');
ok(isSearchHotkey({ key: 'K', metaKey: true, target: tgt('INPUT') }), '⌘+K opens search even from an input');
ok(!isSearchHotkey({ key: 'k', ctrlKey: true, target: tgt('TEXTAREA', { closest: (s) => (s === '.xterm' ? {} : null) }) }),
   'Ctrl+K inside a terminal is the shell\'s kill-line, not search');
ok(!isSearchHotkey({ key: 'k', target: tgt('BODY') }) && !isSearchHotkey({ key: '/', ctrlKey: true, target: tgt('BODY') }),
   'plain k / Ctrl+/ do nothing');
ok(!isSearchHotkey(null), 'no event → false');

console.log('\nApp wiring');
const app = readFileSync('web/src/App.jsx', 'utf8');
ok(/import \{ searchTokens, xellMatches, isSearchHotkey \} from '\.\/hive\/search\.js'/.test(app), 'App uses the shared rule');
ok(/data-testid="xell-search-btn"/.test(app) && /data-testid="xell-search-input"/.test(app), 'the 🔍 button and the input render');
ok(/data-testid="xell-search-count"/.test(app), 'a "N of M" count says how many match');
ok(/\.filter\(\(x\) => xellMatches\(x, searchTerms\)\)/.test(app), 'a query filters the project\'s xells (all levels)');
ok(/isSearchHotkey\(e\)/.test(app) && /addEventListener\('keydown', onKey\)/.test(app), 'the hotkey is bound on window');
ok(/e\.stopPropagation\(\);\s*\n\s*setXellQuery\(''\)/.test(app), 'Escape in the box is owned by the box (clears it)');
ok(/levelXellCount != null && !searching/.test(app), 'the "on other levels" chip stays silent while searching');
ok(/setXellQuery\(''\); setXellSearchOpen\(false\); \}, \[projectId\]/.test(app), 'switching project clears the query');

console.log(fail ? `\n✗ ${fail} failure(s)` : '\nALL PASSED ✓');
process.exit(fail ? 1 : 0);

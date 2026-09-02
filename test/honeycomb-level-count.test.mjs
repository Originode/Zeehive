// "ZEEHIVE SEEMS TO MISCOUNT XELLS — it says 16 of 18, but I only see a few."
//
// It did not miscount: the statusline counts EVERY non-retired xell of the project (fleet.js
// status.total/inUse), while the honeycomb — since the work-node levelling (b48f8ff) — draws ONE
// LEVEL of the tree. Two real gaps made that read as a lie:
//
//   1. A xell assigned to an open item under a DONE/CANCELLED (or missing) parent had no level
//      anyone could open — counted by the statusline, drawn NOWHERE. hive/level.js#itemReachable
//      is the rule, and App.jsx surfaces those orphans at the ROOT level.
//   2. Nothing reconciled the whole-project count with the level's hexagons — the statusline now
//      carries an "N on other levels" chip (and a title on the count saying what is counted).
//
// The reachability rule runs on the REAL module; the App wiring (orphan surfacing, the chip) is
// asserted against the source text, exactly like hive-work-nodes.test.mjs does for the levels.
import { itemReachable } from '../web/src/hive/level.js';
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// ── 1. itemReachable: which open items a human can actually drill to ─────────
console.log('\nitemReachable — the openable-level rule (real module)');
const ROOT = 'root';
// the map holds OPEN items only — a terminal or deleted parent is simply absent, like App's openItems
const openMap = (items) => new Map(items.map((i) => [i.id, i]));

const direct = { id: 'a', parent_id: ROOT };
ok(itemReachable(direct, openMap([direct]), ROOT), 'a direct child of the project root is reachable');

const activity = { id: 'act', parent_id: ROOT };
const task = { id: 'task', parent_id: 'act' };
ok(itemReachable(task, openMap([activity, task]), ROOT),
   'a task under an OPEN activity is reachable (shows at its own level)');

ok(!itemReachable(task, openMap([task]), ROOT),
   'a task whose parent is DONE/CANCELLED (absent from the open map) is UNREACHABLE');

const stray = { id: 's', parent_id: 'gone-forever' };
ok(!itemReachable(stray, openMap([stray]), ROOT), 'a task whose parent row is MISSING is unreachable');

const loopA = { id: 'la', parent_id: 'lb' };
const loopB = { id: 'lb', parent_id: 'la' };
ok(!itemReachable(loopA, openMap([loopA, loopB]), ROOT), 'a parent CYCLE is unreachable, not an infinite loop');

ok(itemReachable({ id: 'r', parent_id: null }, openMap([]), ROOT),
   'an item with no parent at all is reachable (nothing to walk)');
ok(typeof itemReachable(direct, openMap([direct]), undefined) === 'boolean',
   'a missing root id does not throw — the call still answers a boolean');

// ── 2. App surfaces orphaned xells at the root level ─────────────────────────
console.log('\nApp: a counted xell is drawn SOMEWHERE');
const app = readFileSync('web/src/App.jsx', 'utf8');
ok(/import \{ itemReachable \} from '\.\/hive\/level\.js'/.test(app),
   'App uses the shared rule from hive/level.js');
ok(/itemReachable\(it, openItemById, rootWorkItem\?\.id\)/.test(app),
   'the root level skips ONLY xells whose deeper node is actually reachable');
ok(/work_item: it, work_children: nodeChildCount\.get\(it\.id\)/.test(app),
   'an orphaned xell surfaces at root WITH its work item (title/status ride the hexagon)');

// ── 3. the statusline reconciles the count with the level ────────────────────
console.log('\nstatusline: the whole-project count explains itself');
ok(/levelXellCount/.test(app) && /otherLevelXells/.test(app),
   'App computes how many xells this level draws vs the project total');
ok(/hiveMode === 'nodes' \? hiveCells\.filter\(\(c\) => !c\.hex_kind\)\.length : null/.test(app),
   'the level count only counts XELL hexagons (not project/worknode seats), nodes mode only');
ok(/data-testid="level-hidden-xells"/.test(app) && /on other levels/.test(app),
   'a "N on other levels" chip renders beside the count when the level hides xells');
ok(/otherLevelXells > 0 &&/.test(app), '…and stays silent when the level shows everything');
ok(/every non-retired xell of this project/.test(app),
   'the count itself carries a title saying WHAT is counted (so 16-of-18 over 5 hexagons reads as levelling)');

console.log(fail ? `\n✗ ${fail} failure(s)` : '\nALL PASSED ✓');
process.exit(fail ? 1 : 0);

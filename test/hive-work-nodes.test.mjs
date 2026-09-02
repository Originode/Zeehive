// THE HONEYCOMB'S WORK-NODE HIERARCHY — hexagons are work_nodes now, not only xells.
//
// The task model: on load the honeycomb shows the TOP-LEVEL work_nodes (one PROJECT hexagon per
// project); clicking one opens the project's root level; a child work_node draws as its assigned
// xell (the familiar hexagon + flower) or as a VACANT dashed seat with an "assign zee" chip;
// drilling into a node makes it the CONTEXT every new prompt is cut under (parent_work_item rides
// the dispatch), and provisioned/itemless xells sit at the level below the project.
//
// Pure decisions (the two node draw functions, wrapTwo) run on the REAL module (esbuild-
// transformed); the wiring — click routing, chip hit-testing, the crumb strip, the dispatch
// context, the server's parent_work_item — is asserted against the source text, exactly like
// xell-context-menu.test.mjs does for the context menu.
import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const hive = readFileSync('web/src/hive/HiveCanvas.jsx', 'utf8');
const app = readFileSync('web/src/App.jsx', 'utf8');
const css = readFileSync('web/src/styles.css', 'utf8');
const intake = readFileSync('server/src/queenzee/intake.js', 'utf8');

// ── 1. the draw layer knows the two new hexagon kinds ─────────────────────────
console.log('\nthe canvas draws project + work-node hexagons');
ok(/hex_kind === 'project'/.test(hive) && /drawProjectHex/.test(hive),
   "a cell whose hex_kind is 'project' is drawn as a PROJECT hexagon");
ok(/hex_kind === 'worknode'/.test(hive) && /drawWorkNodeHex/.test(hive),
   "…and 'worknode' as a vacant work-node seat");
ok(/drawChildrenChip/.test(hive) && /work_children > 0/.test(hive),
   'a xell-backed node with children gets the ⬡ drill-down chip');
ok(/nodeBtns/.test(hive) && /hitNodeBtn/.test(hive),
   'the chips are recorded and hit-tested like the flower buttons');

// the pure functions render without a DOM canvas beyond a stub
const tmp = 'web/src/hive/.hive-work-nodes.test-build.mjs';
writeFileSync(tmp, transformSync(hive, { loader: 'jsx', format: 'esm' }).code);
let mod;
try { mod = await import('../' + tmp); } finally { rmSync(tmp, { force: true }); }
const calls = [];
const ctxStub = new Proxy({}, {
  get: (t, k) => {
    if (k === 'measureText') return (s) => ({ width: String(s).length * 6 });
    if (k === 'createLinearGradient') return () => ({ addColorStop: () => {} });
    return typeof k === 'string' && ['font', 'fillStyle', 'strokeStyle', 'textAlign', 'textBaseline',
      'lineWidth', 'globalAlpha'].includes(k) ? undefined : (...a) => { calls.push(k); };
  },
  set: () => true,
});
const nodeHex = { cx: 100, cy: 100, size: 60, x: { hex_kind: 'worknode', slug: 'a node',
  work_item: { title: 'build the thing', kind: 'task', status: 'queued' }, work_children: 2 } };
const chips = mod.drawWorkNodeHex(ctxStub, nodeHex, { hover: false, dim: false });
ok(chips && chips.assign && chips.assign.w > 0,
   'drawWorkNodeHex returns the ASSIGN chip rect for hit-testing');
const tiny = mod.drawWorkNodeHex(ctxStub, { ...nodeHex, size: 20 }, { hover: false, dim: false });
ok(tiny === null, 'a tiny node hexagon degrades to a dot and offers no chip');
const chip = mod.drawChildrenChip(ctxStub, { cx: 0, cy: 0, size: 60,
  x: { work_children: 3 } }, { hover: false, dim: false });
ok(chip && chip.w > 0, 'drawChildrenChip returns its rect');
ok(mod.drawChildrenChip(ctxStub, { cx: 0, cy: 0, size: 60, x: { work_children: 0 } }, {}) === null,
   '…and draws nothing for a node with no children');

// ── 2. the click routing: drill-down, not the flower ──────────────────────────
console.log('\nclicks on node cells route to the hierarchy, not the flower');
ok(/onOpenProject\?\.\(x\.project\)/.test(hive), 'clicking a project hexagon opens the project level');
ok(/onOpenNode\?\.\(x\.work_item/.test(hive), 'clicking a vacant work-node opens its children');
ok(/nb\.kind === 'assign'\) onNodeAssign\?\./.test(hive), "the 'assign zee' chip dispatches onNodeAssign");
ok(/hx && !xellOf\(hx\.id\)\?\.hex_kind/.test(hive),
   'the right-click xell menu is NOT offered on a node/project cell (no xell verbs there)');

// ── 3. the App levels: projects on load, node context, provisioned at root ────
console.log('\nApp composes the level and carries the context');
// The level the console opens on now comes from the ADDRESS (web/src/route.js): a bare `/` is still
// the top level — every project's root work_node — and `/<project>/<child>/…` opens INSIDE, which is
// the whole point of the path URL. So the assertion is on the fallback, not on a bare literal.
ok(/useState\(initialUrl\.current\.project \? 'nodes' : 'projects'\)/.test(app),
   "the console OPENS on the top level — every project's root work_node — unless the URL names one");
ok(/hex_kind: 'project'/.test(app) && /hex_kind: 'worknode'/.test(app),
   'App synthesises the two cell kinds for the canvas');
ok(/parent_id === ctxItemId/.test(app), "a level's cells are the CONTEXT node's children");
ok(/openXellItem\.has\(x\.id\)/.test(app) && /itemReachable\(it,/.test(app),
   'provisioned / itemless xells sit at the level below the project (root level only) — '
   + 'and a xell on an UNREACHABLE node (terminal/missing parent) surfaces there too');
ok(/hive-crumb/.test(app) && /\.hive-crumbs/.test(css), 'the level breadcrumb exists and is styled');
ok(/parent_work_item: nodePath\[nodePath\.length - 1\]\.id/.test(app),
   'a prompt written inside a level rides with that node as parent_work_item');
ok(/onOpenProject={openProjectLevel} onOpenNode={openNodeLevel} onNodeAssign={assignNodeZee}/.test(app),
   'the canvas is handed the three hierarchy handlers');
ok(/deployWorkItem\(item\.id/.test(app),
   "the vacant seat's assign chip deploys through the board's own verb (deployWorkItem)");

// ── 4. the server half: the dispatch carries the context ──────────────────────
console.log('\nthe dispatch accepts the context and cuts the node');
ok(/work_item_id = null, parent_work_item = null/.test(intake),
   'dispatchXell accepts work_item_id (no double card) and parent_work_item (the context)');
ok(/ensurePromptWorkItem/.test(intake), 'and cuts the card through lib/prompt-work-node.js');
ok(/effectiveType !== 'manager'/.test(intake.slice(intake.indexOf('ensurePromptWorkItem') - 2000,
   intake.indexOf('ensurePromptWorkItem') + 500)), 'managers take no card');

console.log(fail ? `\n✗ ${fail} failure(s)` : '\n✓ honeycomb work-node hierarchy: all green');
process.exit(fail ? 1 : 0);

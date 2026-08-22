// THE '+ HEXAGON' — a persistent create affordance beside the queenzee node, and the hover tooltip
// for work-node hexagons.
//
// Two features land on the honeycomb:
//   1. HOVER TOOLTIPS on task/activity work-node hexagons — a vacant seat or a xell-backed node
//      shows its title/kind/status, through the same imperative DOM pattern as the xell tooltip,
//      with the content built by the PURE workNodeTooltipParts (testable here without a browser).
//   2. A persistent BLANK '+ HEXAGON' in the cell beside the queenzee (0,1). Clicking it opens a
//      DOM menu (prompt / manager / ticket / work_node → project / activity / task). The option
//      lists are pure data (plusMenu.js); a nested project (inside another project's repo tree)
//      forces a git-behavior choice that the server validates against GIT_BEHAVIORS.
//
// Pure decisions run on the REAL module (esbuild-transformed); the wiring — click routing, the
// tooltip router, the App handler, the CreateForm's confinement — is asserted against the source
// text, exactly like hive-work-nodes.test.mjs does.
import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const hive = readFileSync('web/src/hive/HiveCanvas.jsx', 'utf8');
const plus = readFileSync('web/src/hive/plusMenu.js', 'utf8');
const app = readFileSync('web/src/App.jsx', 'utf8');
const setup = readFileSync('web/src/ProjectSetup.jsx', 'utf8');
const css = readFileSync('web/src/styles.css', 'utf8');
const projects = readFileSync('server/src/lib/projects.js', 'utf8');
const migration = readFileSync('db/migrations/232_git_behavior_choice_on_nested_project_onboard.sql', 'utf8');

// ── 0. the pure option lists ──────────────────────────────────────────────────
console.log('\nthe + menu options are pure data, shared by the canvas and the form');
const pm = await import('../web/src/hive/plusMenu.js');
ok(Array.isArray(pm.PLUS_MENU_OPTIONS) && pm.PLUS_MENU_OPTIONS.length === 4,
   'PLUS_MENU_OPTIONS lists the four main options');
ok(pm.PLUS_MENU_OPTIONS.map((o) => o.kind).join(',') === 'prompt,manager,ticket,work_node',
   '…in the requested order: prompt, manager, ticket, work_node');
ok(Array.isArray(pm.WORK_NODE_OPTIONS) && pm.WORK_NODE_OPTIONS.map((o) => o.kind).join(',') === 'project,activity,task',
   'WORK_NODE_OPTIONS is project / activity / task');
ok(pm.GIT_BEHAVIOR_OPTIONS.map((o) => o.value).join(',') === 'submodule,subtree,main_repo',
   'GIT_BEHAVIOR_OPTIONS is submodule / subtree / main_repo');
ok(pm.gitBehaviorLabel('submodule') === 'git submodule', 'gitBehaviorLabel maps a value to its label');
ok(pm.gitBehaviorLabel(null) === '—', 'gitBehaviorLabel falls back to an em-dash');

// ── 1. the work-node hover tooltip content is pure ────────────────────────────
console.log('\nthe work-node hover tooltip builds its content without a browser');
const tmp = 'web/src/hive/.hive-plus-hexagon.test-build.mjs';
writeFileSync(tmp, transformSync(hive, { loader: 'jsx', format: 'esm' }).code);
let mod;
try { mod = await import('../' + tmp); } finally { rmSync(tmp, { force: true }); }
const parts = mod.workNodeTooltipParts({ title: 'ship the gate', kind: 'task', status: 'working', work_children: 2 });
ok(parts.head === 'ship the gate' && parts.kind === 'task' && parts.status === 'working' && parts.children === 2,
   'workNodeTooltipParts carries title/kind/status/children through');
ok(mod.workNodeTooltipParts({}).head === '—' && mod.workNodeTooltipParts({}).kind === 'task',
   '…and degrades to placeholders for an empty item');
ok(/const cellTooltip = \(x, e\) => \{/.test(hive)
   && /x\?\.work_item\) showWorkNodeTooltip/.test(hive)
   && /!x\?\.hex_kind\) showXellTooltip/.test(hive),
   'cellTooltip routes: a work_item cell → node tooltip, a plain xell → xell tooltip, a project → nothing');
ok(/showWorkNodeTooltip = \(item, e\) => \{/.test(hive) && /hive-xell-tooltip/.test(hive),
   'showWorkNodeTooltip reuses the imperative DOM tooltip pattern (no re-render on hover)');

// ── 2. the + hexagon is drawn and hit-tested ──────────────────────────────────
console.log('\nthe + hexagon draws beside the queenzee and answers clicks');
ok(/drawPlusHex/.test(hive), 'drawPlusHex is defined in the canvas');
ok(/geomRef\.current\.plus = \{ cx/.test(hive), 'the + hexagon geometry is recorded for hit-testing');
ok(/const hitPlus = useCallback/.test(hive) && /geomRef\.current\.plus/.test(hive) && /pointInHex/.test(hive),
   'hitPlus hit-tests against the recorded geometry');
ok(/cellCenter\(0, 1/.test(hive), 'the + hexagon sits in the cell BESIDE the queenzee (0,1)');
ok(/plusKey = cellKey\(0, 1\)/.test(hive) && /reserved: new Set\(\[qzKey, plusKey\]\)/.test(hive),
   'the + cell is reserved before any xell is seated, so nothing can sit on it');
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
mod.drawPlusHex(ctxStub, 100, 100, 40, { hover: true });
ok(calls.includes('fill') && calls.includes('stroke') && calls.includes('fillText'),
   'drawPlusHex paints a filled/stroked hexagon with the + glyph');
ok(/setLineDash\(\[6, 4\]\)/.test(hive), '…dashed, so it reads as a NOT-A-WORK-CELL affordance');

// ── 3. the menu wiring ────────────────────────────────────────────────────────
console.log('\nthe click opens a DOM menu, and the four options call back to App');
ok(/openPlusMenu = \(e\) => \{/.test(hive) && /setPlusMenu\(\{ x: e\.clientX/.test(hive),
   'openPlusMenu pins the menu at the cursor');
ok(/hitPlus\(wx, wy\)\) \{ openPlusMenu\(e\); return; \}/.test(hive),
   'a click on the + hexagon opens the menu (not a pan)');
ok(/PLUS_MENU_OPTIONS\.map/.test(hive) && /setPlusSub\(true\)/.test(hive),
   'the menu renders PLUS_MENU_OPTIONS and the work_node item opens the SUB level');
ok(/WORK_NODE_OPTIONS\.map/.test(hive) && /onPlusAction\?\.\(o\.kind/.test(hive),
   '…which lists WORK_NODE_OPTIONS and dispatches through onPlusAction');
ok(/onPlusAction/.test(hive) && /className="ctxmenu hive-plus-ctx"/.test(hive),
   'the + menu is a DOM ctxmenu, not canvas-painted buttons');
ok(/\.hive-plus-ctx/.test(css), 'the + menu is styled');
ok(/if \(plusMenu\) \{ setPlusMenu\(null\); setPlusSub\(false\); return; \}/.test(hive),
   'Escape dismisses the + menu before anything else');

// ── 4. App routes the four options ────────────────────────────────────────────
console.log('\nApp opens the four surfaces the menu names');
ok(/handlePlusAction/.test(app) && /onPlusAction=\{handlePlusAction\}/.test(app),
   'the canvas is handed the App handler');
ok(/case 'prompt': setShowDispatch\(\{\}\); return;/.test(app), "'prompt' opens the dispatch composer");
ok(/case 'manager': setShowManagerMint\(true\); return;/.test(app), "'manager' opens the manager mint");
ok(/setWorkInitialTab\('tickets'\)/.test(app) && /setShowWork\(true\)/.test(app),
   "'ticket' opens the work tracker on the TICKETS tab");
ok(/showManagerMint && \(\s*<Dispatch manager/.test(app), 'the manager variant renders the Dispatch composer');
ok(/initialTab=\{workInitialTab\}/.test(app) && /WorkConsole/.test(app),
   'the tracker receives the forced tab');
ok(/createWorkItem\(\{ project: projectId \|\| project\?\.id, parent_id: parentId, kind/.test(app),
   'activity/task create through the same createWorkItem verb the board uses');
ok(/Open a node first/.test(app), '…and refuse with a sentence when no node is open');

// ── 5. the nested project: confinement + forced git behavior ──────────────────
console.log('\na project inside a project is confined and forces the git behavior');
ok(/hiveMode === 'nodes'\)/.test(app) && /parent_repo_root: project\?\.repo_root \|\| ''/.test(app),
   'inside a project, the + project option carries the parent repo_root');
ok(/setSetupCreate\(true\)/.test(app) && /project=\{setupCreate \? null : project\}/.test(app),
   'the + menu project option always opens CREATE mode (a new project)');
ok(/nested=\{nestedProject\}/.test(app), 'the nested context rides into ProjectSetup');
ok(/function CreateForm\(\{ onCreated, nested = null \}\)/.test(setup), 'CreateForm accepts the nested context');
ok(/git_behavior: gitBehavior/.test(setup), '…and passes git_behavior to createProject/cloneProject');
ok(/GIT_BEHAVIOR_OPTIONS\.map/.test(setup) && /nested-git-opt/.test(setup),
   'the form renders the forced git-behavior choice');
ok(/nested \? nested\.parent_repo_root :/.test(setup), '…and the folder pickers START inside the parent repo');
ok(/confineTo=\{nested \? nested\.parent_repo_root : null\}/.test(setup),
   '…and are confined to it (FsBrowse confineTo)');
ok(/atConfineRoot/.test(setup) && /confineTo/.test(setup),
   'FsBrowse itself hides the ↰ .. button at the confine root');
ok(/must live inside/.test(setup) && /startsWith\(root \+ '\/'\)/.test(setup),
   'the free-text path is guarded too — a path escaping the parent repo is refused with a sentence');
ok(/\.nested-proj/.test(css) && /\.nested-git-opt/.test(css), 'the nested-project form is styled');

// ── 6. the server validates the git-behavior vocabulary ───────────────────────
console.log('\nthe server owns the git-behavior vocabulary');
const gitBehaviorSrc = projects.slice(projects.indexOf('GIT_BEHAVIORS') - 30, projects.indexOf('isValidGitBehavior') + 120);
ok(/GIT_BEHAVIORS = \['submodule', 'subtree', 'main_repo'\]/.test(gitBehaviorSrc),
   'GIT_BEHAVIORS is the same three values the UI offers');
ok(/isValidGitBehavior/.test(gitBehaviorSrc)
   && /GIT_BEHAVIORS\.includes\(b\)/.test(gitBehaviorSrc),
   'isValidGitBehavior accepts null/undefined or a known value');
ok(/git_behavior must be submodule, subtree or main_repo/.test(projects),
   'createProject refuses an unknown value with a sentence');
ok(/git_behavior/.test(projects) && /PATCHABLE/.test(projects.slice(projects.indexOf('PATCHABLE'))),
   'updateProject can patch git_behavior');
ok(/ADD COLUMN IF NOT EXISTS git_behavior text/.test(migration)
   && /CHECK \(git_behavior IS NULL OR git_behavior IN \('submodule', 'subtree', 'main_repo'\)\)/.test(migration),
   'migration 232 adds the column with the same check constraint');

console.log(fail ? `\n✗ ${fail} failure(s)` : '\n✓ + hexagon + work-node tooltips: all green');
process.exit(fail ? 1 : 0);

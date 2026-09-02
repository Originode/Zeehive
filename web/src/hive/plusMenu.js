// THE + HEXAGON'S MENU — pure option lists shared by the honeycomb and the onboard form.
//
// The persistent blank '+ hexagon' beside the queenzee node opens a menu with four kinds of
// creation. These lists are pure data (kind + label + one-line sub) so the DOM menu in HiveCanvas
// stays dumb and a test can assert the options without a browser — the same reason xellTooltipParts
// and xellContextMenuItems live in HiveCanvas.jsx as exported functions. The git-behavior vocabulary
// is ALSO consumed by ProjectSetup.jsx's nested-project CreateForm, so it lives here (a small module)
// rather than inside either file.

export const PLUS_MENU_OPTIONS = [
  { kind: 'prompt', label: '💬 prompt', sub: 'compose a prompt and dispatch a zee' },
  { kind: 'manager', label: '⬢ manager', sub: 'add a manager zee to run a crew' },
  { kind: 'ticket', label: '🎫 ticket', sub: 'file a ticket in the work tracker' },
  { kind: 'work_node', label: '⬡ work node', sub: 'create a project / activity / task' },
];

// The work_node sub-menu. Project at top level onboards a NEW project; inside a project it is a
// NESTED project (confined to the parent's tree, with a forced git-behavior choice — see
// GIT_BEHAVIOR_OPTIONS). Activity/task are cut under the current node (the server owns which
// nestings are legal).
export const WORK_NODE_OPTIONS = [
  { kind: 'project', label: 'project', sub: 'onboard a new project' },
  { kind: 'activity', label: 'activity', sub: 'an activity under the current node' },
  { kind: 'task', label: 'task', sub: 'a task under the current node' },
];

// How a NESTED project's repo joins its parent's git. The console FORCES this choice when a project
// is created inside another project's tree; the server validates the same vocabulary
// (server/src/lib/projects.js GIT_BEHAVIORS / isValidGitBehavior). Keep the two in step.
export const GIT_BEHAVIOR_OPTIONS = [
  { value: 'submodule', label: 'git submodule', sub: 'the parent records this repo as a submodule' },
  { value: 'subtree', label: 'git subtree', sub: "the parent grafts this repo's history as a subtree" },
  { value: 'main_repo', label: 'just use the main repo', sub: 'no nested git — the parent tracks everything' },
];

export const gitBehaviorLabel = (v) =>
  (GIT_BEHAVIOR_OPTIONS.find((o) => o.value === v) || {}).label || v || '—';

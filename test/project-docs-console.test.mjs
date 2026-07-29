// THE DOCS TAB IS THE AUTHORING SURFACE — proving the textbox is the SOURCE, not a filename.
//
// The whole point of 083 is a human-facing one: an operator writes a project's instructions ONCE and
// ticks which AI providers should receive them. If the console still asks for a path first, the model
// underneath does not matter — the operator will keep making one row per file, which is exactly the
// copy-paste-and-drift this replaced. So the surface has to be provable, not asserted in a commit
// message.
//
// It RENDERS THE REAL COMPONENTS (the Landing.jsx / manager-hexagon precedent): ProjectSetup.jsx is
// transformed with esbuild and rendered with react-dom/server, so what is asserted is the markup a
// human actually reads. Three things it must show, because each one is a way an operator gets
// surprised:
//   1. the CONTENTS come first — a body textarea, and no path box on a provider-backed doc;
//   2. the PROVIDERS are a checklist of real filenames with who reads each one, and the surface says
//      which files this text currently generates;
//   3. the SURPRISES are stated where the operator is: a committed file wins, the generated copy is
//      git-excluded, it carries the xell's own stack, and saving reaches zees already running.
// Plus the seam: the catalogue is FETCHED (never hard-coded in web/), and every path the console
// suggests is one the server's own registry actually knows — a filename that exists only in the
// console is a file no agent ever opens.
import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// ── 1. the seam: one source of filenames, and it is the server's ────────────────────────────────
console.log('\n── the console asks the server which files exist ──');
const A = await import('../server/src/lib/agent-docs.js');
const api = read('web/src/api.js');
ok(/getAgentDocTargets = \(\) => fetch\('\/api\/agent-doc-targets'\)/.test(api),
   'web/src/api.js fetches the catalogue from the API');
ok(/router\.get\('\/agent-doc-targets'/.test(read('server/src/api/routes.js')),
   'and the API serves it (routes.js → targetCatalogue)');
const jsx = read('web/src/ProjectSetup.jsx');
const docsSection = jsx.slice(jsx.indexOf('export function ProjectDocsSection'));
// A filename typed into the console is a second source of truth for a vendor fact. The two allowed
// mentions are the human-readable examples in the explainer prose — every path the UI actually USES
// comes from the fetched catalogue.
const hardcoded = [...docsSection.matchAll(/'([A-Za-z0-9_.@/-]*\.(?:md|mdc))'/g)].map((m) => m[1]);
ok(!hardcoded.length, `no provider filename is hard-coded in the Docs tab (${hardcoded.join(', ') || 'none'})`);
for (const m of docsSection.match(/<code>[^<]+<\/code>/g) || []) {
  const p = m.replace(/<\/?code>/g, '');
  if (!/\.(md|mdc)$/.test(p)) continue;
  ok(A.AGENT_DOC_TARGETS.some((t) => t.path === p) || /ONBOARDING/.test(p),
     `the example ${p} is a path the registry really knows`);
}

// A dialog helper called but not imported is a module-scope free identifier: vite builds it happily
// and it throws ReferenceError the first time an operator clicks. That has bitten this console twice
// (see app-dialog-imports.test.mjs), and the provider checklist added another call site.
const dlg = jsx.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/Dialog\.jsx['"]/);
const imported = new Set((dlg ? dlg[1] : '').split(',').map((s) => s.trim()));
for (const name of new Set([...jsx.matchAll(/\b(show(?:Alert|Confirm|Prompt))\s*\(/g)].map((m) => m[1]))) {
  ok(imported.has(name), `ProjectSetup.jsx imports ${name} before calling it`);
}

// ── 2. RENDER IT. What does an operator see? ────────────────────────────────────────────────────
console.log('\n── the rendered surface ──');
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const tmp = resolve(here, '..', 'web/src/.project-docs.test-build.mjs');
writeFileSync(tmp, transformSync(jsx, { loader: 'jsx', format: 'esm' }).code
  // Stub each sibling import with exactly the names it brought — a blanket stub would redeclare them.
  // The components under test read no data of their own beyond their props.
  .replace(/import[^\n]*\.\/(api|Dialog|DiffViewer)\.jsx?['"];?/g, (_m, mod) => ({
    api: 'const getProjectDocs=async()=>[],createProjectDoc=async()=>{},updateProjectDoc=async()=>{},'
       + 'deleteProjectDoc=async()=>{},getAgentDocTargets=async()=>[],getReadiness=async()=>({}),'
       + 'probeRepo=async()=>({}),updateProject=async()=>{},getSites=async()=>[],createSite=async()=>{},'
       + 'updateSite=async()=>{},deleteSite=async()=>{},listDockerContexts=async()=>[],getContainers=async()=>[],'
       + 'createContainer=async()=>{},updateContainer=async()=>{},deleteContainer=async()=>{},'
       + 'getEnvironments=async()=>[],createEnvironment=async()=>{},updateEnvironment=async()=>{},'
       + 'deleteEnvironment=async()=>{},getEnvVars=async()=>[],setEnvVar=async()=>{},deleteEnvVar=async()=>{},'
       + 'importEnv=async()=>{},getProviderTokens=async()=>[],putProviderToken=async()=>{},'
       + 'deleteProviderToken=async()=>{},getMachines=async()=>[],discoverSite=async()=>({}),'
       + 'adoptDiscovered=async()=>({}),purgeProject=async()=>({}),deleteProject=async()=>({}),'
       + 'getProjectPool=async()=>({}),setProjectPool=async()=>{},getHarnesses=async()=>[],'
       + 'browseFs=async()=>({}),getProjects=async()=>[];',
    Dialog: 'const showConfirm=async()=>true,showAlert=async()=>{},showPrompt=async()=>null;',
    DiffViewer: 'const showDiff=()=>{};',
  }[mod] || '')));
let ProjectDocEditor, ProjectDocsSection;
try {
  const mod = await import(`${tmp}?t=${process.pid}`);
  ProjectDocEditor = mod.ProjectDocEditor; ProjectDocsSection = mod.ProjectDocsSection;
} finally { rmSync(tmp, { force: true }); }
ok(typeof ProjectDocEditor === 'function' && typeof ProjectDocsSection === 'function',
   'both halves of the Docs tab are exported and render');

const targets = A.targetCatalogue();
const doc = {
  id: 'd1', title: 'Project instructions', rel_path: null, targets: ['claude', 'agents'],
  body: '# omnibiz\n\nRun the tests before you land.\n', enabled: true, sort: 0,
};
const html = renderToStaticMarkup(React.createElement(ProjectDocEditor, { doc, targets, run: () => {}, busy: false }));

// (1) the CONTENTS lead. The body is a textarea holding the operator's text; the only text input is
// the cosmetic title — a provider-backed doc must not offer a path box at all, because a path here
// is the mistake this replaced.
ok(/<textarea[^>]*>#\s*omnibiz/.test(html.replace(/&#x27;|&quot;/g, '')),
   'the operator\'s CONTENTS are in the textarea — the source of truth, not a filename');
ok(!/AGENTS\.md"|CLAUDE\.md"/.test((html.match(/<input[^>]*type="text"[^>]*>/g) || []).join(' ')),
   'and no path input is offered for a provider-backed doc');
ok(/placeholder="what to call this text/.test(html),
   'the one text box is the cosmetic title, and says so');

// (2) the PROVIDERS: real filenames, who reads them, and what this text generates right now.
ok(/Generate for/.test(html) && /2<\/b> providers/.test(html),
   'it says how many provider files this ONE text generates');
ok(/<code>CLAUDE\.md<\/code>/.test(html) && /<code>AGENTS\.md<\/code>/.test(html),
   'and names them as real paths — rendered as markup, not as escaped tag soup');
// Each row is labelled with the CONVENTION (a glob where the vendor uses a folder), which is what an
// operator recognises; the exact generated filename shows up in the "Generate for" line once ticked.
for (const t of A.AGENT_DOC_TARGETS) {
  ok(html.includes(t.label), `every other provider is one checkbox away (${t.label})`);
}
const boxes = (html.match(/<input type="checkbox"/g) || []).length;
ok(boxes >= targets.length + 1, `every registry entry is offered (${boxes} checkboxes for ${targets.length} targets + enabled)`);
ok(/Claude Code/.test(html) && /OpenAI Codex/.test(html),
   'each one is labelled with the agents that actually read it — the operator is choosing tools, not filenames');
const claudeIdx = html.indexOf('CLAUDE.md');
ok(claudeIdx > 0 && html.indexOf('<textarea') < html.lastIndexOf('docgen'),
   'the provider checklist sits UNDER the text it generates from, not in place of it');

// (3) the SURPRISES, stated where the operator is standing.
const section = renderToStaticMarkup(React.createElement(ProjectDocsSection, {
  project: { id: 'p1' }, run: () => {}, busy: false }));
for (const [re, what] of [
  [/source of truth/i, 'that what they type IS the source'],
  [/one file per provider/i, 'that one file per provider is generated from it'],
  [/committed/i, "that a file the project committed wins over the generated one"],
  [/git excludes/i, 'that the generated copy never lands in a diff'],
  [/that xell's own stack|that xell&#x27;s own stack/i, "that each file carries that xell's own stack"],
  [/already running/i, 'and that saving reaches zees already at work'],
]) {
  ok(re.test(section), `the section says ${what}`);
}
// And the preview, because the stamp/siblings/stack are the parts an operator did NOT type: without a
// way to see them, the first person to read the real file is a zee in a cage.
ok(/preview<\/button>|preview what gets written/.test(html),
   'the editor offers a preview of what the queenzee will really write');
ok(/previewProjectDoc = \(docId\) => siteCall\(`\/api\/project-docs\/\$\{docId\}\/preview`/.test(api)
   && /router\.get\('\/project-docs\/:docId\/preview'/.test(read('server/src/api/routes.js')),
   'served by a read-only route that runs the real generator');

ok(/＋ Project instructions/.test(section),
   'the primary action is "write the instructions", not "add a file"');
ok(/custom path/.test(section), 'with the custom-path escape hatch demoted to a secondary row');

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);

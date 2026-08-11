// THE DEPLOY TAB TREE — machine (master) → deploy type (dev/prod) → role-grouped inventory.
//
// The Deploy tab in Project Setup used to be two flat lists — Deploy sites and Container
// inventory — that never said how they relate. This pins the tree that replaces them: one node
// per MACHINE, its dev/prod deploy TYPES as the branches (named by the deploy site on that
// machine), and the shared container rows grouped by ROLE (db/server/webapp/infra) under each.
//
// Renders the REAL DeployTree (exported from ProjectSetup.jsx) with react-dom/server over a
// fixture. No database.
import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');

// Stub ProjectSetup's only relative imports (./api.js exports everything, ./Dialog.jsx the three
// alerts). Export DeployTree for the test.
const API_NAMES = ('createProject,updateProject,probeRepo,probeRemote,cloneProject,pullProject,githubAccess,'
  + 'pushProject,pullRequestProject,squashHelps,squashOffer,getReadiness,getSites,createSite,updateSite,'
  + 'deleteSite,getPoolConfig,patchPoolConfig,getSharedContainers,createSharedContainer,patchSharedContainer,'
  + 'deleteSharedContainer,getProjectManifestInfo,refreshProjectManifest,buildProjectManifest,'
  + 'writeProjectManifest,getComposeOnboardingPlan,applyComposeOnboarding,getDockerContexts,getRuntimes,'
  + 'getHarnesses,getMachines,getProviderTokens,addProviderToken,deleteProviderAccount,pauseProviderAccount,'
  + 'resumeProviderAccount,getReposHome,listFsDirs,mountHostFolder,purgeDevXells,subscribeCloneProgress,'
  + 'discoverSite,adoptContainers,getEnvironments,createEnvironment,updateEnvironment,deleteEnvironment,'
  + 'getEnvVars,setEnvVar,deleteEnvVar,importEnv,exportEnv,lintEnv,getProjectDocs,createProjectDoc,'
  + 'updateProjectDoc,deleteProjectDoc,getAgentDocTargets,previewProjectDoc,getXourceState,cleanXourceNow,'
  + 'getXourceCleanRequests,decideXourceClean,dismissXourceClean,getWireguard,mintWireguardPeer,'
  + 'setWireguardEndpoint,getProjectApiKeys,createProjectApiKey,revokeProjectApiKey,deleteProjectApiKey');
const stubApi = API_NAMES.split(',').map((n) => `const ${n} = async () => ({ ok: true, containers: [], adopted: [], linked: [], skipped: [] });`).join('\n');
const src = transformSync(read('web/src/ProjectSetup.jsx'), { loader: 'jsx', format: 'esm' }).code
  .replace(/import \{[^}]*\} from ["']\.\/api\.js["'];/, stubApi + '\nexport const __api = 1;')
  .replace(/import \{[^}]*\} from ["']\.\/Dialog\.jsx["'];/, 'const showConfirm = async () => true; const showAlert = async () => {}; const showPrompt = async () => null;')
  // DeployTree is a top-level function declaration — expose it as a named export for the test.
  + '\nexport { DeployTree };';
const tmp = resolve(here, '..', 'web/src/.deploy-tree.test-build.mjs');
writeFileSync(tmp, src);
let DeployTree;
try {
  const mod = await import(`${tmp}?t=${process.pid}`);
  DeployTree = mod.DeployTree;
} finally { rmSync(tmp, { force: true }); }
ok(typeof DeployTree === 'function', 'DeployTree is exported and bundles');

// ── fixture: the shape the live fleet has ────────────────────────────────────────────
const machines = [
  { id: 'm1', key: 'local', label: 'this machine', docker_ctx: 'default', host_ip: null, can_build: true },
  { id: 'm2', key: 'ugreen-nas', label: null, docker_ctx: 'ugreen-nas', host_ip: '10.0.1.18', can_build: false },
];
const sites = [
  { id: 's1', key: 'dev', tier: 'dev', docker_ctx: 'default', host: 'localhost', is_default: true },
  { id: 's2', key: 'local', tier: 'prod', docker_ctx: 'default', host: 'localhost', is_default: true },
  { id: 's3', key: 'ugreen', tier: 'dev', docker_ctx: 'ugreen-nas', host: '10.1.0.18', is_default: false },
];
const c = (id, name, role, tier, docker_ctx) =>
  ({ id, name, role, tier, docker_ctx, site_id: null, host: null, host_port: null, build_script: null, site_key: null, health: 'up' });
const shared = [
  c('c1', 'omnibiz_db_dev_local', 'db', 'dev', 'default'),
  c('c2', 'omnibiz_db_prod', 'db', 'prod', 'default'),
  c('c3', 'omnibiz_server_prod', 'server', 'prod', 'default'),
  c('c4', 'omnibiz_web_prod', 'webapp', 'prod', 'default'),
  c('c5', 'omnibiz_db_dev_ugreen_nas', 'db', 'dev', 'ugreen-nas'),
];
// A per-xell spinoff row must NOT appear in the deploy tree.
const spinoff = c('c6', 'omnibiz_spin_server_x', 'server', 'spinoff', 'default');

const html = renderToStaticMarkup(React.createElement(DeployTree, {
  project: { id: 'p1' }, run: async () => {}, busy: false,
  initial: { machines, sites, containers: [...shared, spinoff] },
}));

console.log('\n── the tree nests machine → deploy type → role ──');
ok(/deploy-tree/.test(html), 'renders a deploy-tree section');
ok(html.includes(`deploy-machine-${machines[0].key}`) && html.includes(`deploy-machine-${machines[1].key}`),
   'one node per machine (local, ugreen-nas)');
ok(/data-tier="dev"/.test(html) && /data-tier="prod"/.test(html),
   'dev AND prod deploy-type branches appear');
ok(/DB:/.test(html) && /Server:/.test(html) && /App:/.test(html),
   'the inventory is grouped by role (db / server / webapp)');

console.log('\n── containers land under their machine + deploy type ──');
const devIdx = html.indexOf('data-tier="dev"');
const prodIdx = html.indexOf('data-tier="prod"');
ok(html.indexOf('omnibiz_db_dev_local') > devIdx && html.indexOf('omnibiz_db_dev_local') < prodIdx,
   "local's dev db sits in the dev branch (before the prod branch)");
ok(html.indexOf('omnibiz_db_prod') > prodIdx && html.indexOf('omnibiz_server_prod') > prodIdx
   && html.indexOf('omnibiz_web_prod') > prodIdx,
   'prod db/server/webapp all sit in the prod branch');
ok(html.indexOf('omnibiz_db_dev_ugreen_nas') > html.indexOf(`deploy-machine-ugreen-nas`),
   "ugreen-nas's dev db sits under its own machine node");

console.log('\n── per-xell stacks are NOT deploy inventory ──');
ok(!html.includes('omnibiz_spin_server_x'),
   'a per-xell spinoff container is absent from the deploy tree (it is not shared deploy inventory)');

const outline = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800);
console.log('\n── rendered outline ──\n' + outline + '…');

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);

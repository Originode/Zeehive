// THE CONTAINER TREE — machine (master) → deploy type (dev/prod) → role-grouped inventory.
//
// Renders the REAL MachineTree with react-dom/server (the db-chip-address precedent) over a
// constructed fixture, and asserts the NESTING — the shape a human asked for when the dashboard's
// machine matrix, the Deploy tab's sites and the inventory were three flat lists that did not say
// how they relate. The tree is the one surface: a machine node, its dev/prod deploy-type branches
// (named by the deploy site on that machine), and the shared container rows grouped by role as the
// leaves. Per-xell spinoff stacks are a collapsible "xell stacks" group under their machine.
//
// No database: pure render over a fixture.
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
const tmp = resolve(here, '..', 'web/src/.machine-tree.test-build.mjs');
writeFileSync(tmp, transformSync(read('web/src/Machines.jsx'), { loader: 'jsx', format: 'esm' }).code
  .replace(/import[^\n]*\.\/(api|Dialog|Container)\.jsx?['"];?/g, (_m, mod) => ({
    api: 'const getDockerContexts=async()=>[],createMachine=async()=>({}),updateMachine=async()=>({}),'
       + 'deleteMachine=async()=>({}),provisionMachineDevDb=async()=>({}),setMachinePool=async()=>({}),'
       + 'setMachinePriority=async()=>({}),getSites=async()=>[],createSite=async()=>({}),'
       + 'registerDevice=async()=>({}),provisionAdbHost=async()=>({}),getUsbDevices=async()=>[],'
       + 'getAdbDevices=async()=>({}),checkMachineConnection=async()=>({});',
    Dialog: 'const showAlert=async()=>{},showConfirm=async()=>true,showPrompt=async()=>null;',
    Container: 'const ContainerChip=({c})=>React.createElement("span",{"data-testid":"chip",title:c.title},c.name);',
  }[mod] || '')));
let MachineTree;
try {
  const mod = await import(`${tmp}?t=${process.pid}`);
  MachineTree = mod.default;
} finally { rmSync(tmp, { force: true }); }
ok(typeof MachineTree === 'function', 'MachineTree is exported and bundles');

// ── fixture: the shape the live fleet has ────────────────────────────────────────────
const machines = [
  { id: 'm1', key: 'local', label: 'this machine', docker_ctx: 'default', host_ip: null,
    can_build: true, can_device: true, max_xells: 12, enabled: true, dev_priority: 5, pool_size: 3, is_queenzee_host: true },
  { id: 'm2', key: 'ugreen-nas', label: null, docker_ctx: 'ugreen-nas', host_ip: '10.0.1.18',
    can_build: false, can_device: false, max_xells: 4, enabled: true, dev_priority: 2, pool_size: 1, is_queenzee_host: false },
];
const sites = [
  { id: 's1', key: 'dev', tier: 'dev', docker_ctx: 'default', host: 'localhost', is_default: true },
  { id: 's2', key: 'local', tier: 'prod', docker_ctx: 'default', host: 'localhost', is_default: true },
  { id: 's3', key: 'ugreen', tier: 'dev', docker_ctx: 'ugreen-nas', host: '10.1.0.18', is_default: false },
];
const c = (id, name, role, tier, isolation, docker_ctx) =>
  ({ id, name, role, tier, isolation, docker_ctx, host: null, host_port: 32770, conn_ref: null, health: 'up', url: null });
const containers = {
  db: [
    c('c1', 'omnibiz_db_dev_local', 'db', 'dev', 'shared', 'default'),
    c('c2', 'omnibiz_db_prod', 'db', 'prod', 'shared', 'default'),
    c('c3', 'omnibiz_db_dev_ugreen_nas', 'db', 'dev', 'shared', 'ugreen-nas'),
  ],
  server: [ c('c4', 'omnibiz_server_prod', 'server', 'prod', 'shared', 'default') ],
  webapp: [ c('c5', 'omnibiz_web_prod', 'webapp', 'prod', 'shared', 'default') ],
  device: [],
  other: [ c('c6', 'omnibiz_spin_server_x', 'server', 'spinoff', 'per-xell', 'default') ],
};

const html = renderToStaticMarkup(React.createElement(MachineTree, {
  machines, containers, sites, projectId: 'p1', spinoffIsProcess: false, onMenu: null, onChanged: null,
}));

console.log('\n── the tree nests machine → deploy type → role ──');
ok(/machine-tree/.test(html), 'renders a machine-tree section');
ok(html.includes(`machine-${machines[0].key}`) && html.includes(`machine-${machines[1].key}`),
   'one node per machine (local, ugreen-nas)');
ok(/data-tier="dev"/.test(html) && /data-tier="prod"/.test(html),
   'dev AND prod deploy-type branches appear under a machine');
ok(html.includes('>dev<') && html.includes('>prod<'), 'the branch tiers are labelled dev / prod');
ok(/· localhost/.test(html) && /· 10\.1\.0\.18/.test(html),
   'a branch shows its deploy site host (the Deploy-tab surface is inside the tree)');
ok(html.includes('DB:') && html.includes('Server:') && html.includes('App:'),
   'the inventory is grouped by role (db / server / webapp)');

console.log('\n── containers land under their machine + tier ──');
ok(html.indexOf('omnibiz_db_dev_local') < html.indexOf('data-tier="prod"'),
   'the local machine\'s dev db sits in its dev branch (before the prod branch)');
ok(html.includes('omnibiz_db_dev_ugreen_nas'), 'the remote machine\'s dev db sits under ugreen-nas');
const prodIndex = html.indexOf('data-tier="prod"');
ok(html.indexOf('omnibiz_db_prod') > prodIndex && html.indexOf('omnibiz_server_prod') > prodIndex
   && html.indexOf('omnibiz_web_prod') > prodIndex,
   'prod db/server/webapp all sit in the prod branch');
ok((html.match(/data-testid="chip"/g) || []).length >= containers.db.length,
   'every db container renders as a chip');

console.log('\n── per-xell stacks are a separate, collapsed group ──');
ok(html.includes('xell stacks') && html.includes('per-xell'),
   'a per-xell stack group exists under its machine');
// The group is collapsed by default (static render = initial state), so its children are absent
// from the tree entirely — which is exactly the point: a per-xell spinoff container is NOT part
// of the dev/prod deploy inventory, and a collapsed group is how the tree says so.
ok(!html.includes('omnibiz_spin_server_x'),
   'a per-xell spinoff container is not rendered in the dev/prod inventory (its group is collapsed)');

const outline = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 700);
console.log('\n── rendered outline ──\n' + outline + '…');

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);

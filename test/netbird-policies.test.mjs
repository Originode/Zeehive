// NETBIRD ACCESS POLICIES (docs/netbird-mesh-plan.md §3.5 / §5) — the default-deny guard that
// keeps the PROD SEAL from weakening at the mesh transport. NetBird is default-deny BETWEEN
// GROUPS: no policy naming a group pair = no flow. So the only prod grant the mesh ever carries is
// a NARROW, named db-port policy that a HUMAN-approved prod bind (decideProdBind) flips. Everything
// here is the bounded injected-adapter shape — NO NetBird, NO postgres (the policy helpers in
// lib/netbird.js make no row writes).
//
// Covered:
//   • policyIsDefaultDenySafe (PURE): a policy that names prod as a DESTINATION may only grant
//     specific ports — empty or '*' port list is refused before any control-plane call
//   • mesh DISABLED → ensurePolicy / ensureProdBindMeshPolicy are legible no-ops (the standing
//     invariant), and prodBindPolicyName is a pure slug → name mapping
//   • ensurePolicy: idempotent find-by-name (no duplicate POSTs), group-name resolution via
//     ensureGroup, POST body shape (rules with group ids + ports), verdict objects — never throws
//   • the BROAD prod grant is refused STRUCTURALLY: zero control-plane calls happen for a
//     dest=prod + ports=['*'] policy
//   • ensureProdBindMeshPolicy: the one flip a prod bind ensures — xells → prod:<dbPort> — and
//     already-present does not stack a duplicate
//   • the decideProdBind wiring (static): the human-approved bind in self.js ensures the mesh
//     policy right after the .zeehive.env re-emit, best-effort (never half-finishes the bind)
//
// RUN:  node test/netbird-policies.test.mjs
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../server/src/config.js';
import {
  policyIsDefaultDenySafe, ensurePolicy, ensureProdBindMeshPolicy, prodBindPolicyName,
} from '../server/src/lib/netbird.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

const meshOn = () => { config.netbirdApiUrl = 'http://mesh.invalid'; config.netbirdApiToken = 't'; };
const meshOff = () => { config.netbirdApiUrl = null; config.netbirdApiToken = null; };
meshOff();

// ── the fake management API: groups + policies with a call log ────────────────────────────────
const makeApi = ({ policies = [], failList = false, failGroupCreate = false, failPolicyCreate = false } = {}) => {
  const state = { groups: [], policies: [...policies], calls: [] };
  const request = async (method, path, body) => {
    state.calls.push(`${method} ${path}`);
    if (method === 'GET' && path === '/api/policies') {
      if (failList) return { status: 500, json: { message: 'control plane down (stub)' } };
      return { status: 200, json: state.policies };
    }
    if (method === 'POST' && path === '/api/policies') {
      if (failPolicyCreate) return { status: 500, json: { message: 'policy create refused (stub)' } };
      const p = { id: `p-${state.policies.length + 1}`, ...body };
      state.policies.push(p);
      return { status: 201, json: p };
    }
    if (method === 'GET' && path === '/api/groups') return { status: 200, json: state.groups };
    if (method === 'POST' && path === '/api/groups') {
      if (failGroupCreate) return { status: 500, json: { message: 'group create refused (stub)' } };
      const g = { id: `g-${state.groups.length + 1}`, name: body.name };
      state.groups.push(g);
      return { status: 200, json: g };
    }
    return { status: 500, json: { message: `stub: unhandled ${method} ${path}` } };
  };
  return { request, state };
};

section('policyIsDefaultDenySafe — the pure prod guard');
ok(policyIsDefaultDenySafe({ destGroups: ['xells'], ports: ['5432'] }).ok,
   'a policy NOT naming prod as destination is fine (default-deny already protects prod by omission)');
ok(policyIsDefaultDenySafe({ destGroups: ['prod'], ports: ['5432'] }).ok,
   'a prod-destination policy granting ONE named port is safe');
ok(!policyIsDefaultDenySafe({ destGroups: ['prod'], ports: ['*'] }).ok,
   "a prod-destination policy granting '*' is refused");
ok(!policyIsDefaultDenySafe({ destGroups: ['prod'], ports: [] }).ok
   && !policyIsDefaultDenySafe({ destGroups: ['prod'] }).ok,
   'an empty/absent port list means ALL ports → refused');
ok(!policyIsDefaultDenySafe({ destGroups: ['prod'], ports: [] }).ok
   && /default-deny/.test(policyIsDefaultDenySafe({ destGroups: ['prod'], ports: ['*'] }).reason || ''),
   'the refusal names the default-deny rule it protects');

section('prodBindPolicyName');
ok(prodBindPolicyName('wise-delta-a1b2') === 'prod-db-for-wise-delta-a1b2',
   'the prod-bind policy name is the stable slug → name mapping a re-bind/reconcile can find');

section('mesh DISABLED → legible no-op (the standing invariant)');
meshOff();
const offPolicy = await ensurePolicy({ name: 'x', sourceGroups: ['xells'], destGroups: ['prod'], ports: ['5432'] });
ok(offPolicy.ok === false && offPolicy.disabled === true, 'ensurePolicy with the mesh unset is a legible no-op');
const offBind = await ensureProdBindMeshPolicy('wise-delta-a1b2');
ok(offBind.ok === true && offBind.skipped === 'mesh disabled',
   'ensureProdBindMeshPolicy with the mesh unset SKIPS (the cage re-seal remains the whole story)');

section('ensurePolicy — validation + idempotent find-by-name');
meshOn();
const noName = await ensurePolicy({ name: null, sourceGroups: ['xells'], destGroups: ['prod'], ports: ['5432'] });
ok(!noName.ok && /needs name/.test(noName.reason || ''), 'missing name → reason, never a control-plane call');

const apiExisting = makeApi({ policies: [{ id: 'p1', name: 'prod-db-for-wise-delta-a1b2' }] });
const ex = await ensurePolicy({
  name: 'prod-db-for-wise-delta-a1b2', sourceGroups: ['xells'], destGroups: ['prod'], ports: ['5432'],
}, { request: apiExisting.request });
ok(ex.ok && ex.existing === true && ex.id === 'p1', 'an existing policy by name is returned as-is (idempotent)');
ok(!apiExisting.state.calls.some((c) => c.startsWith('POST')), 'find-by-name POSTs nothing');

const apiNew = makeApi();
const created = await ensurePolicy({
  name: 'prod-db-for-wise-delta-a1b2', sourceGroups: ['xells'], destGroups: ['prod'], ports: ['5432'],
}, { request: apiNew.request });
ok(created.ok && created.created === true, 'a missing policy is created');
ok(apiNew.state.groups.some((g) => g.name === 'xells') && apiNew.state.groups.some((g) => g.name === 'prod'),
   'group NAMES are resolved to ids through ensureGroup (speak the fleet names)');
const post = apiNew.state.calls.find((c) => c.startsWith('POST /api/policies'));
ok(!!post, 'the policy POST ran');
const posted = apiNew.state.policies[0];
ok(posted?.rules?.[0]?.source?.includes('g-1') && posted?.rules?.[0]?.destination?.includes('g-2'),
   'the POST body carries group ids, not names');
ok(JSON.stringify(posted?.rules?.[0]?.ports) === JSON.stringify(['5432']),
   'the POST body grants the named port, narrow by construction');

section('a BROAD prod grant is refused STRUCTURALLY (zero control-plane calls)');
const apiBroad = makeApi();
const broad = await ensurePolicy({
  name: 'open-prod', sourceGroups: ['xells'], destGroups: ['prod'], ports: ['*'],
}, { request: apiBroad.request });
ok(!broad.ok && /default-deny/.test(broad.reason || ''), 'dest=prod + * is refused in code');
ok(apiBroad.state.calls.length === 0, 'refusal happens BEFORE any control-plane call — the seal never weakens');

section('ensurePolicy — failure verdicts, never throws');
const apiDown = makeApi({ failList: true });
const down = await ensurePolicy({
  name: 'x', sourceGroups: ['xells'], destGroups: ['prod'], ports: ['5432'],
}, { request: apiDown.request });
ok(!down.ok && /list policies/.test(down.reason || ''), 'a control-plane failure is a verdict object, never a throw');

const apiGroupFail = makeApi();
const groupFail = await ensurePolicy({
  name: 'x', sourceGroups: ['xells'], destGroups: ['prod'], ports: ['5432'],
}, { request: makeApi({ failGroupCreate: true }).request });
ok(!groupFail.ok && /create group/.test(groupFail.reason || ''), 'a group-create failure degrades the whole ensure');

section('ensureProdBindMeshPolicy — the one flip a prod bind ensures');
meshOn();
const apiBind = makeApi();
const bind = await ensureProdBindMeshPolicy('wise-delta-a1b2', { request: apiBind.request });
ok(bind.ok && bind.created === true, 'a fresh prod bind ensures the narrow policy');
const bindPolicy = apiBind.state.policies.find((p) => p.name === 'prod-db-for-wise-delta-a1b2');
ok(bindPolicy?.rules?.[0]?.source?.some((_, i) => apiBind.state.groups[i]?.name === 'xells')
   || JSON.stringify(bindPolicy?.rules?.[0]?.source) === JSON.stringify(['g-1']),
   'the bind policy sources the xells group');
ok(bindPolicy?.rules?.[0]?.ports?.length === 1 && bindPolicy.rules[0].ports[0] === '5432',
   'the grant is the single db port — narrow by construction');

const apiRebind = makeApi({ policies: [{ id: 'p1', name: 'prod-db-for-wise-delta-a1b2' }] });
const rebind = await ensureProdBindMeshPolicy('wise-delta-a1b2', { request: apiRebind.request });
ok(rebind.ok && rebind.existing === true, 'a re-bind finds the existing policy and stacks no duplicate');
ok(!apiRebind.state.calls.some((c) => c.startsWith('POST /api/policies')), 're-bind POSTs no duplicate policy');

const apiCustomPort = makeApi();
const customPort = await ensureProdBindMeshPolicy('x-1', { dbPort: 6432, request: apiCustomPort.request });
ok(customPort.ok && apiCustomPort.state.policies[0]?.rules?.[0]?.ports?.[0] === '6432',
   'the db port is the bind\'s own (a non-default prod db port still gets a narrow grant)');

section('the decideProdBind wiring (static) — human-approved bind ensures the mesh half');
const self = readFileSync(resolve(ROOT, 'server/src/queenzee/self.js'), 'utf8');
ok(/ensureProdBindMeshPolicy/.test(self) && /import \{.*ensureProdBindMeshPolicy.*\} from '\.\.\/lib\/netbird\.js'/.test(self),
   'self.js imports the prod-bind policy helper');
ok(/await ensureProdBindMeshPolicy\(bind\.xell\)/.test(self)
   && /catch\(\(e\) => logline\('mesh'/.test(self),
   'decideProdBind ensures the policy on the bind xell, best-effort (a control-plane outage never half-finishes a human-approved bind)');
const hookIdx = self.indexOf('ensureProdBindMeshPolicy(bind.xell)');
const emitIdx = self.indexOf('emitXellEnv(row.xell_id)');
ok(hookIdx > emitIdx, 'the mesh flip runs AFTER the .zeehive.env re-emit — the env half stays the pre-mesh story');

console.log(fail ? `\n${fail} FAILURE(S) ✗` : '\nALL PASSED ✓');
process.exit(fail ? 1 : 0);

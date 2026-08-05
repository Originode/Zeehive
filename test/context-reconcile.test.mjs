// CONTEXT RECONCILE — the Deploy sites tab is the source of truth for docker contexts, and the
// queenzee auto-heals its local context to match.
//
// deploy_site.docker_endpoint (migration 109) is the full endpoint a site's docker_ctx should
// dial. lib/context-reconcile.js makes the real `docker context` match it: CREATE when the
// context is missing, UPDATE when it exists but points elsewhere, no-op when already correct —
// and NEVER touches 'default' or a site with no endpoint. Called on site save and every tick.
//
// This proves, against a FAKE `docker` on PATH that records every context command:
//   1. a missing context → `docker context create <ctx> --docker host=<endpoint>`;
//   2. an existing context with a different endpoint → `docker context update` to the endpoint;
//   3. an already-matching context → no docker command at all;
//   4. docker_ctx 'default' (or no endpoint) → never touched;
//   5. simulate mode (PROVISION_MODE != real) → models only, no docker command;
//   6. reconcileAllContexts walks every declared site and acts only on drift.
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// ── fake docker CLI on PATH that records every invocation ───────────────────────
const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const bin = mkdtempSync(join(tmpdir(), `ctxrec-${tag}-`));
const LOG = join(bin, 'docker.log');
const STATE = join(bin, 'state.json');
writeFileSync(STATE, JSON.stringify({ contexts: [] }));
const shim = join(bin, 'fake-docker.mjs');
writeFileSync(shim, `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const st = JSON.parse(readFileSync(process.env.CTX_STATE, 'utf8'));
const a = process.argv.slice(2);
appendFileSync(process.env.CTX_LOG, a.join(' ') + '\\n');
if (a[0] === 'context' && a[1] === 'ls') {
  for (const c of st.contexts) process.stdout.write(JSON.stringify({ Name: c.name, DockerEndpoint: c.endpoint, Current: false }) + '\\n');
  process.exit(0);
}
if (a[0] === 'context' && (a[1] === 'create' || a[1] === 'update')) {
  const name = a[2];
  const ep = a[a.indexOf('--docker') + 1].replace(/^host=/, '');
  st.contexts = st.contexts.filter((c) => c.name !== name);
  st.contexts.push({ name, endpoint: ep });
  writeFileSync(process.env.CTX_STATE, JSON.stringify(st));
  process.exit(0);
}
process.exit(0);
`);
writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash\nexec node "${shim}" "$@"\n`);
chmodSync(join(bin, 'docker'), 0o755);
process.env.CTX_STATE = STATE;
process.env.CTX_LOG = LOG;
process.env.PATH = `${bin}:${process.env.PATH}`;

const commands = () => {
  try { return readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; }
};
// the reconcile ALWAYS runs `docker context ls` first (to compare) — so "no docker command"
// means no create/update, and the always-present `context ls` is not a mutation.
const mutations = () => commands().filter((c) => c.startsWith('context create') || c.startsWith('context update'));
const setContexts = (ctxs) => { writeFileSync(STATE, JSON.stringify({ contexts: ctxs })); };
const resetLog = () => rmSync(LOG, { force: true });

const { reconcileContext, reconcileAllContexts } = await import('../server/src/lib/context-reconcile.js');

// sites-shaped fixtures (the minimal fields reconcileContext reads)
const sshSite = { key: 'mardale', docker_ctx: 'mardale-prod', docker_endpoint: 'ssh://mnrevelo@ssh.omnibiz.express' };
const lanSite = { key: 'mardale', docker_ctx: 'mardale-prod', docker_endpoint: 'tcp://10.2.0.16:2375' };
const defaultSite = { key: 'local', docker_ctx: 'default', docker_endpoint: 'tcp://localhost:2375' };
const noEpSite = { key: 'dev', docker_ctx: 'ugreen-nas', docker_endpoint: null };

// simulate mode by default (the cxell default); flip to real inside the block that needs it.
process.env.PROVISION_MODE = 'simulate';
setContexts([]);
resetLog();

try {
  console.log('\n── simulate mode models, never touches docker ──');
  await reconcileContext(sshSite);
  ok(commands().length === 0, 'simulate → no docker command (log only)');

  process.env.PROVISION_MODE = 'real';

  console.log('\n── a missing context → create ──');
  setContexts([]); resetLog();
  const created = await reconcileContext(sshSite);
  ok(created.action === 'created', `action=created [${created.action}]`);
  ok(commands().some((c) => c.startsWith(`context create mardale-prod`) && c.includes('ssh://mnrevelo@ssh.omnibiz.express')),
     'docker context create with the SSH endpoint');

  console.log('\n── an existing context pointing elsewhere → update ──');
  setContexts([{ name: 'mardale-prod', endpoint: 'tcp://10.2.0.16:2375' }]); resetLog();
  const updated = await reconcileContext(sshSite);
  ok(updated.action === 'updated', `action=updated [${updated.action}]`);
  ok(commands().some((c) => c.startsWith(`context update mardale-prod`) && c.includes('ssh://mnrevelo@ssh.omnibiz.express')),
     'docker context update to the SSH endpoint');

  console.log('\n── an already-matching context → no-op ──');
  setContexts([{ name: 'mardale-prod', endpoint: 'ssh://mnrevelo@ssh.omnibiz.express' }]); resetLog();
  const noop = await reconcileContext(sshSite);
  ok(noop.action === 'ok', `action=ok [${noop.action}]`);
  ok(mutations().length === 0, 'no docker create/update when already correct');

  console.log('\n── default / no-endpoint sites are never touched ──');
  setContexts([]); resetLog();
  await reconcileContext(defaultSite);
  await reconcileContext(noEpSite);
  ok(mutations().length === 0, 'no docker create/update for default or no-endpoint sites');

  console.log('\n── reconcileAllContexts walks every site and acts only on drift ──');
  const sites = [sshSite, defaultSite, noEpSite];   // one drifted, two skipped
  setContexts([{ name: 'mardale-prod', endpoint: 'tcp://10.2.0.16:2375' }]); resetLog();
  const acted = await reconcileAllContexts(sites);
  ok(acted.length === 1 && acted[0].ctx === 'mardale-prod', `exactly one drifted site acted on [${acted.length}]`);
  ok(mutations().some((c) => c.startsWith('context update mardale-prod')), 'the drifted context was updated');

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  rmSync(bin, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);

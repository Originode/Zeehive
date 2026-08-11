// COMPOSE-GEN — the compose-authorship model (docs/compose-authorship-decision-record.md):
// a project's spinoff compose is a PROJECTION ZEEHIVE generates from zeehive.yml, marked
// GENERATED (ownership lives in the file), standalone-runnable without the harness, carrying
// NO machine facts (placement is meta-DB data), and never written over a project-owned compose.
//
// Pure module test (no db, no docker) against the REAL repo zeehive.yml — which also pins the
// Zeehive conversion itself: the spinoff tier is a compose runner now, and the COMMITTED
// docker-compose.spinoff.yml is byte-identical to what the generator emits (drift check: the
// projection in the repo IS regenerable, not a hand-fork).
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { loadManifest, serverRoleIsProcess } = await import('../server/src/lib/manifest.js');
const { generateSpinoffCompose, writeGeneratedCompose, isGeneratedCompose, GENERATED_MARKER } =
  await import('../server/src/lib/compose-gen.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const repo = loadManifest(ROOT);
console.log('\n── the repo manifest: Zeehive spinoffs are a compose tier now ──');
ok(repo.found && !!repo.manifest, `zeehive.yml parses with no errors (${(repo.errors || []).join('; ') || 'none'})`);
ok(!serverRoleIsProcess(repo.manifest), 'serverRoleIsProcess is FALSE — machine placement is enabled for Zeehive');
ok(repo.manifest?.tiers?.spinoff?.compose === 'docker-compose.spinoff.yml', 'the spinoff tier names its generated compose');

console.log('\n── the generated projection ──');
const { yaml } = generateSpinoffCompose({ name: 'Zeehive', manifest: repo.manifest });
ok(isGeneratedCompose(yaml), `the output opens with the ownership marker ("${GENERATED_MARKER}…")`);
const doc = parse(yaml);
ok(!!doc.services?.server && !!doc.services?.webapp && !!doc.services?.db,
   'services are named BY ROLE (server/webapp/db) — the build-container.sh contract');
ok(doc.services.server.container_name === 'zeehive_spin_server_${SPINOFF_SLUG:-dev}',
   'container names follow the naming templates with the compose-interpolated slug');
ok(doc.services.db.container_name === 'zeehive_db_spin_${SPINOFF_SLUG:-dev}',
   "…including the manifest's db override (zeehive_db_spin_{slug})");
ok((doc.services.server.ports || [])[0] === '${SPINOFF_SERVER_PORT:-4800}:4700'
   && (doc.services.webapp.ports || [])[0] === '${SPINOFF_WEB_PORT:-5300}:5180'
   && (doc.services.db.ports || [])[0] === '${SPINOFF_DB_PORT:-5500}:5432',
   'every port interpolates with a DEFAULT — the file is standalone-runnable without the harness');
const env = doc.services.server.environment || {};
ok(env.PROVISION_MODE === 'simulate' && env.SHIP_MODE === 'simulate' && env.POOL_TARGET_READY === '0',
   'the §6.2 simulate-safety env is BAKED into the server service — safe even outside the harness');
ok(env.DATABASE_URL === 'postgresql://zeehive:zeehive@db:5432/zeehive',
   "the nested queenzee's DATABASE_URL points at its OWN per-xell db service");
ok(doc.services.webapp.build?.args?.ZEEHIVE_API_UPSTREAM === 'server:4700',
   'the webapp is built proxying /api to its sibling server service, not the host gateway');
ok(!!doc.services.db.healthcheck && doc.services.server.depends_on?.db?.condition === 'service_healthy',
   'the server waits on a healthy db (first `up server` brings the pair)');
ok(!/docker_ctx|ugreen|mardale|10\.\d+\.\d+\.\d+|host_ip/.test(yaml),
   'NO machine facts in the output — contexts/IPs/placement stay meta-DB data');

console.log('\n── the committed file IS the projection (drift check) ──');
const committed = readFileSync(join(ROOT, 'docker-compose.spinoff.yml'), 'utf8');
ok(committed === yaml,
   'docker-compose.spinoff.yml in the repo is byte-identical to the generator output — regenerable, not a hand-fork');

console.log('\n── ownership: generated files are ZEEHIVE\'s, project files are not ──');
const tmp = mkdtempSync(join(ROOT, '.composegen-'));
try {
  const owned = writeGeneratedCompose(tmp, 'docker-compose.spinoff.yml', yaml);
  ok(owned.ok && owned.wrote, 'writes freely where no file exists');
  const again = writeGeneratedCompose(tmp, 'docker-compose.spinoff.yml', yaml);
  ok(again.ok && !again.wrote && again.unchanged, 'an identical regeneration is a no-op (unchanged)');
  writeFileSync(join(tmp, 'docker-compose.spinoff.yml'), 'services: { theirs: { image: x } }\n');
  const refused = writeGeneratedCompose(tmp, 'docker-compose.spinoff.yml', yaml);
  ok(!refused.ok && refused.refused && /project's own/.test(refused.reason),
     'REFUSES to overwrite a compose without the marker — an onboarded file is the project\'s own');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S) ✗` : '\nALL PASSED ✓');
process.exit(failures ? 1 : 0);

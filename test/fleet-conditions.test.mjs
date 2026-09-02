// FLEET SNAPSHOT CARRIES CONDITIONS (needs-you #18). The console's needs-you bar must surface a
// blocked project's conditions even when the pool stopped filling and NO xell is waiting — a
// provision halt leaves the bar silent about the one thing it exists to say. For the bar to ride
// the existing poll (no second endpoint to keep in step with), getFleet must carry the project's
// conditions; this pins that contract:
//
//   • a project's conditions arrive under `fleet.conditions`, newest list order preserved (the same
//     rows the conditions editor and every briefing read — one source, three surfaces);
//   • a project with NO conditions arrives with `conditions: []`, not absent and not null (the bar
//     checks `.length`, so absence would render as "undefined conditions");
//   • the snapshot stays scoped: one project's conditions never bleed into another's.
//
// It drives the REAL getFleet (the same function the /fleet poll and the /stream snapshot both call)
// against `zee db-sandbox --migrate`, with a fixture project/repo_root NULL — getFleet must not
// require a git checkout to answer. It creates its own rows and removes them in a finally.
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

import { randomUUID } from 'node:crypto';
import { q, one, pool } from '../server/src/db/pool.js';
import { getFleet } from '../server/src/lib/fleet.js';
import { addProjectCondition } from '../server/src/lib/current-conditions.js';

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
let projId = null, otherId = null;
const clean = [];

try {
  // repo_root is NOT NULL; a nonexistent /tmp path is fine (getFleet's git reads degrade to null and
  // xourceState answers "folder does not exist" — the snapshot must not require a real checkout).
  projId = (await one(`INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`,
    [`zt-fleetcond-${tag}`, `/tmp/zt-fleetcond-${tag}`])).id;
  clean.push(() => q(`DELETE FROM project_condition WHERE project_id=$1`, [projId]));
  clean.push(() => q(`DELETE FROM project WHERE id=$1`, [projId]));
  otherId = (await one(`INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`,
    [`zt-fleetcond-other-${tag}`, `/tmp/zt-fleetcond-other-${tag}`])).id;
  clean.push(() => q(`DELETE FROM project WHERE id=$1`, [otherId]));

  // INSERTED in a deliberately non-alphabetical order ('t…' before 'PROVISION-…'), so a snapshot
  // that accidentally re-sorts by body would produce PROVISION-first and fail the order assertion
  // below — the DB's own list order (oldest first) is the contract every surface relies on.
  const bodies = [
    'these two tests are red on main and are not yours (TKT-54)',
    'PROVISION-INFRA: this project cannot build on machine \'ugreen-nas\' — provision: docker: '
      + 'could not find an available address pool. Medic action: repair what the error names.',
  ];
  for (const b of bodies) await addProjectCondition(projId, b, { actor: null });
  const expect = [...bodies];

  console.log('\n── getFleet carries the project\'s conditions ──');
  const fleet = await getFleet(projId);
  ok(fleet && fleet.project?.id === projId, 'getFleet resolves the fixture project (nonexistent repo_root — no real checkout needed)');
  ok(Array.isArray(fleet.conditions), '`fleet.conditions` is an array');
  ok(fleet.conditions.length === 2, `exactly the fixture's 2 conditions arrive (got ${fleet.conditions.length})`);
  ok(fleet.conditions.map((c) => c.body).join('\n') === expect.join('\n')
     && fleet.conditions[0].id && fleet.conditions[0].updated_at,
     'rows are the condition rows in list order (id + updated_at ride along for the date chip)');

  console.log('\n── scoping: an empty project is [], and one project never bleeds into another ──');
  const other = await getFleet(otherId);
  ok(Array.isArray(other.conditions) && other.conditions.length === 0,
     'a project with no conditions arrives with conditions: [] (the bar checks .length)');
  const onlyMine = fleet.conditions.every((c) => c.project_id === projId);
  ok(onlyMine, 'the fixture project\'s snapshot carries only its own conditions');

  console.log('\nall good');
} finally {
  for (const fn of clean) { try { await fn(); } catch { /* best effort */ } }
  await pool.end();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);

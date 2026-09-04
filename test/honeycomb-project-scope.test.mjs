// WHERE THE HONEYCOMB'S PROJECT SCOPING LIVES — the server, not the render pass.
//
// The console used to re-filter the fleet by project at render (web/src/projectFilter.js): every
// paint dropped any xell whose project_id differed from the selection, as belt-and-braces under the
// stream guards. Projects are segregated on the SERVER now — every xell read is scoped to one
// project in SQL — so that pass re-asked a question already answered, and a second copy of a rule is
// a second place for it to go wrong. It is gone; this test pins what must stay true without it.
//
// Two facts, kept together on purpose, because dropping either one is how foreign hexagons come back:
//   1. the SERVER scopes: the xell list the console reads (snapshot + NDJSON stream) is WHERE
//      x.project_id = $1, so a xell that arrives at the client belongs to the selected project.
//   2. the CLIENT guards STALENESS, not membership: a project switch can land the PREVIOUS
//      selection's stream or snapshot late, and that is answered by force-clearing the map on the
//      new projectId and dropping anything from a stale selection — never by inspecting project_id.
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const app = readFileSync('web/src/App.jsx', 'utf8');
const fleetLib = readFileSync('server/src/lib/fleet.js', 'utf8');
const routes = readFileSync('server/src/api/routes.js', 'utf8');

// ── 1. the server is the scope ────────────────────────────────────────────────
console.log('\nthe server scopes the fleet to ONE project');
ok((fleetLib.match(/WHERE x\.project_id = \$1 AND x\.status <> 'retired'/g) || []).length >= 2,
   'the xell reads (snapshot + stream) are WHERE x.project_id = $1');
ok(/\/fleet\/xells-stream/.test(routes) && /streamXells\(req\.query\.project \|\| null/.test(routes),
   'the NDJSON stream route streams ONE project — the one the client asked for');

// ── 2. the client does not re-filter by project ───────────────────────────────
console.log('\nthe console renders what it was given');
ok(!/projectScoped|belongsToProject|projectFilter/.test(app),
   'App.jsx applies no per-xell project filter to the honeycomb grid');
ok(/const gridXells = streamedXells\.length \? streamedXells : \(fleetMatchesSelection \? \(fleet\.xells \|\| \[\]\) : \[\]\)/.test(app),
   'gridXells is the streamed fleet as it arrived (snapshot fallback only while it matches the selection)');

// ── 3. …but it still refuses STALE data from the project you just left ────────
console.log('\nthe switch guards stay — staleness is a different question from scope');
ok(/if \(projectId !== prevPid\) \{[\s\S]{0,200}?mapRef\.current = new Map\(\)/.test(app),
   'the streamed map force-clears during the render that first sees a new projectId');
ok(/const stillCurrent = \(\) => pidRef\.current === streamProjectId/.test(app),
   'an in-flight stream from the previous selection knows it is stale and drops itself');
ok(/const syncXells = useCallback\(\(rows\) => \{\s*\n\s*if \(pidRef\.current !== projectId\) return;/.test(app),
   'a snapshot from the previous selection never paints the new project');
ok(/const fleetMatchesSelection = !projectId \|\| fleet\.project\?\.id === projectId/.test(app),
   'the fleet-snapshot fallback is used only while that snapshot IS the selected project\x27s');

if (fail) { console.log(`\n✗ ${fail} check(s) failed`); process.exit(1); }
console.log('\n✓ honeycomb project scope: all green');

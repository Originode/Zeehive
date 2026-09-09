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
//      x.project_id = $1, so a xell that arrives at the client belongs to the project it was asked
//      for — the client never re-decides that from `project_id`.
//   2. the CLIENT keys, rather than clears: rows are filed under the selection they were fetched
//      under, so a project switch swaps which map is painted and a late stream or snapshot from the
//      previous selection updates ITS OWN map. Nothing has to be emptied to stay honest — and
//      emptying it is exactly what a human sees as xells being removed and recreated on a switch.
//
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

// ── 3. …and it does not tear the comb down to stay honest ─────────────────────
// The FOLLOW-UP report: "the xells are getting removed and recreated when i change projects, so
// there is definitely filtering happening." A single shared map of streamed xells has to be cleared
// on every switch, and that clear was the last client-side project behaviour left — the comb blanks
// and then rebuilds itself off the wire, and coming back to the project you just left rebuilds it
// again. The store is keyed by project now (web/src/hive/xellCache.js, exercised for real in
// honeycomb-project-switch.test.mjs); what this section pins is that App.jsx still uses it that way.
console.log('\nthe switch is a lookup — no clear, no rebuild');
ok(/import \{ createXellCache \} from '\.\/hive\/xellCache\.js';/.test(app),
   'App.jsx keeps the honeycomb\x27s xells in the per-project store');
ok(!/mapRef\.current = new Map\(\)/.test(app) && !/setXells\(\[\]\)/.test(app),
   'nothing empties them — not on a project switch, not anywhere');
ok(/if \(key !== prevKey\) \{[\s\S]{0,120}?setXells\(cache\.list\(projectId\)\)/.test(app),
   'the render that first sees a new projectId paints THAT project\x27s rows, out of its own map');
ok(/cache\.upsert\(pid, x\)/.test(app) && /cache\.prune\(pid, seen\)/.test(app),
   'the stream upserts by id and prunes at completion — inside the map of the project it streamed');
ok(/const syncXells = useCallback\(\(rows, pid\) =>/.test(app)
   && (app.match(/syncXells\((?:f|fl)\?\.xells \|\| \[\], (?:pid|projectId)\)/g) || []).length === 3,
   'every snapshot adopt names the selection it was fetched under (all 3 call sites)');
ok(/const fleetMatchesSelection = !projectId \|\| fleet\.project\?\.id === projectId/.test(app),
   'the fleet-snapshot fallback — the one read with no key of its own — stays selection-checked');

if (fail) { console.log(`\n✗ ${fail} check(s) failed`); process.exit(1); }
console.log('\n✓ honeycomb project scope: all green');

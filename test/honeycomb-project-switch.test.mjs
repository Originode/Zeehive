// SWITCHING PROJECTS MUST NOT REBUILD THE COMB — the honeycomb's xell store, exercised.
//
// THE REPORT THIS COMES FROM: "the xells are getting removed and recreated when i change projects,
// so there is definitely filtering happening." They were right about the symptom and right about
// the cause: the console kept ONE map of streamed xells, so every project change had to empty it,
// and the comb blanked and then rebuilt itself hexagon by hexagon as the NDJSON stream re-delivered
// rows the browser had held seconds earlier. Switching BACK re-paid the whole cost again.
//
// The store is keyed by project now (web/src/hive/xellCache.js), so a switch is a lookup and a
// re-stream reconciles that project's rows in place. This test runs the store — not a regex over
// it — and asserts the three things that make the symptom impossible to come back:
//
//   1. switching away and back RETURNS the rows, with their identities intact (a hexagon is
//      updated, never removed-and-recreated);
//   2. a write for one project never reaches another's rows, in either direction — which is why no
//      clear is needed and why nothing here has to inspect `project_id`;
//   3. a prune (end of a stream pass) only ever drops ids inside the project it streamed.
//
// The default project is `null` until the fleet resolves an id, so it is exercised as a real
// selection alongside the named ones — it is the key the stream was requested under.
import { createXellCache } from '../web/src/hive/xellCache.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const ids = (rows) => rows.map((x) => x.id).sort();

const A = 'project-a', B = 'project-b';
const a1 = { id: 'a1', slug: 'alpha-one', hive_status: 'occ-working' };
const a2 = { id: 'a2', slug: 'alpha-two', hive_status: 'idle' };
const b1 = { id: 'b1', slug: 'beta-one', hive_status: 'occ-working' };

// ── 1. a switch away and back keeps the hexagons ──────────────────────────────
console.log('\na project switch is a lookup, not a teardown');
const c = createXellCache();
c.upsert(A, a1); c.upsert(A, a2);          // project A streamed in
ok(ids(c.list(A)).join() === 'a1,a2', 'project A holds the xells its stream delivered');

const away = c.list(B);                    // the human switches to B, which has never been streamed
ok(away.length === 0, 'switching to a project not yet streamed shows nothing of the other project');
c.upsert(B, b1);
ok(ids(c.list(B)).join() === 'b1', 'B fills from its own stream');

const back = c.list(A);                    // …and straight back to A
ok(ids(back).join() === 'a1,a2', 'switching BACK to A returns its xells — nothing was removed');
ok(back[0] === a1 && back[1] === a2,
   'and returns the SAME row objects — the hexagons are the ones already drawn, not recreations');

// A re-stream of A on arrival must UPDATE in place, not replace the set.
const a1moved = { ...a1, hive_status: 'idle' };
c.upsert(A, a1moved);
ok(c.list(A).length === 2 && c.list(A)[0] === a1moved,
   'the re-stream that follows a switch updates a hexagon by id (upsert), keeping the rest');
ok(c.list(A) !== c.list(A), 'each read is a fresh array — React repaints on new data');

// ── 2. no bleed, in either direction ──────────────────────────────────────────
console.log('\nrows are filed under the project they were fetched for');
ok(ids(c.list(B)).join() === 'b1', 'writing A never touched B');
c.adopt(B, [b1, { id: 'b2', slug: 'beta-two' }]);   // a fleet snapshot for B
ok(ids(c.list(B)).join() === 'b1,b2' && ids(c.list(A)).join() === 'a1,a2',
   'a snapshot adopted for B replaces B and leaves A exactly as it was');
// A LATE arrival from the project you just left: it belongs to that project, so it lands there —
// neither dropped (switching back would rebuild) nor painted over the project on screen.
c.upsert(A, { id: 'a3', slug: 'alpha-three' });
ok(ids(c.list(A)).join() === 'a1,a2,a3' && ids(c.list(B)).join() === 'b1,b2',
   'a late row from the previous selection is kept under ITS project, not merged into the current one');

// The default project (`null`) is its own selection, not a synonym for any named one.
c.upsert(null, { id: 'd1', slug: 'default-one' });
ok(ids(c.list(null)).join() === 'd1' && ids(c.list(A)).join() === 'a1,a2,a3',
   'the default project (null selection) has its own rows');

// Nothing here reads project_id: rows are taken as they arrived, keyed by the request's project.
c.upsert(B, { id: 'b3', project_id: A, slug: 'server-said-this-is-Bs' });
ok(ids(c.list(B)).join() === 'b1,b2,b3',
   'the store never re-decides membership from project_id — the server already scoped the read');

// ── 3. prune is scoped to the pass that ran ───────────────────────────────────
console.log('\nend of a stream pass prunes only the project it streamed');
c.prune(A, new Set(['a1']));               // A's pass saw only a1
ok(ids(c.list(A)).join() === 'a1', 'ids the pass did not see are dropped from that project');
ok(ids(c.list(B)).join() === 'b1,b2,b3' && ids(c.list(null)).join() === 'd1',
   'and no other project lost a hexagon to it');
c.prune('never-streamed', new Set());
ok(ids(c.list(A)).join() === 'a1', 'a prune for an unknown project is harmless');

if (fail) { console.log(`\n✗ ${fail} check(s) failed`); process.exit(1); }
console.log('\n✓ honeycomb project switch: all green');

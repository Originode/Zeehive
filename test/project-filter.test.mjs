// THE PROJECT-SCOPING FILTER for the console's fleet render surfaces.
//
// The fleet stream, the fleet snapshot and the SSE updates are project-scoped on the server, but a
// project switch can leave the PREVIOUS project's LAST update stream landing after the new selection
// is set — and a foreign xell that reaches the honeycomb paints as a lingering remnant from the
// project you just left. web/src/projectFilter.js is the final gate at render: every surface fed from
// the xell list drops a xell that demonstrably belongs to a DIFFERENT project, at the cost of one
// pass over an already-small list.
//
// The filter is DELIBERATELY lenient (see the module header): it must never blank the grid it cannot
// vouch for. With no project selected there is nothing to filter against, and a xell without a
// project_id cannot be proven foreign — both pass. Only a xell whose project_id is present AND
// differs from the selection is dropped. This test pins that contract so a future tightening that
// blanks the honeycomb on a missing project_id fails loudly instead of shipping a blank grid.
import { belongsToProject, projectScoped } from '../web/src/projectFilter.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

console.log('\n── belongsToProject: what may render under the selected project ──');
ok(belongsToProject({ id: 'x', project_id: 'B' }, 'B'), 'a xell OF the selected project passes');
ok(!belongsToProject({ id: 'x', project_id: 'A' }, 'B'), 'a xell of a DIFFERENT project is dropped');
ok(belongsToProject({ id: 'x', project_id: 'A' }, null), 'no project selected → nothing to filter against, passes');
ok(belongsToProject({ id: 'x' }, 'B'), 'a xell with NO project_id cannot be proven foreign → passes');
ok(belongsToProject({ id: 'x', project_id: '' }, 'B'), 'an empty project_id is treated as absent → passes');
ok(belongsToProject({ id: 'x', project_id: 'B' }, ''), 'an empty selection is treated as none → passes');

console.log('\n── projectScoped: the whole-list gate the render path applies ──');
const foreign = { id: 'a', slug: 'lingering', project_id: 'A' };
const own = { id: 'b', slug: 'current', project_id: 'B' };
const unverifiable = { id: 'c', slug: 'no-pid' };
const all = [foreign, own, unverifiable];

ok(projectScoped(all, 'B').length === 2 && !projectScoped(all, 'B').some((x) => x.id === 'a'),
   'under B the foreign A xell is gone, the B xell and the unverifiable xell stay');
ok(projectScoped(all, null).length === 3, 'no selection keeps every xell (server default)');
ok(projectScoped([], 'B').length === 0, 'an empty list stays empty');
ok(projectScoped(null, 'B').length === 0, 'a missing list is tolerated as empty');
ok(projectScoped(all, 'A').length === 2 && !projectScoped(all, 'A').some((x) => x.id === 'b'),
   'switching BACK to A drops B\'s xell and keeps A\'s plus the unverifiable one — both directions');

if (fail) { console.log(`\n✗ ${fail} check(s) failed`); process.exit(1); }
console.log('\n✓ project-filter all green');

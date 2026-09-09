// THE MEDIC TOOL REGISTRY — the allowlist that IS the meta-plane confinement
// (server/src/lib/medic-tools.js; docs/medic-meta-plane-plan.md §4, DR-7/DR-8; kit stage 4).
//
// What this proves, without a database (the walls that must hold BEFORE any SQL runs):
//   A. TWO REGISTRIES, DISJOINT. No verb name is shared between MEDIC_TOOLS and LANGCHAIN_TOOLS —
//      a zee loop cannot name a medic tool and a medic loop cannot name a zee verb. The loop binds
//      whichever registry it is given, so disjointness is the property that keeps the planes apart.
//   B. ABSENCE IS THE WALL. The medic registry contains NO bash/exec/write/docker/git-mutating
//      verb — the three classes that collapse an in-process boundary are not present to be argued
//      into.
//   C. THE DISPATCH REFUSAL. runMedicTool with an unknown name returns a REFUSAL RESULT (JSON the
//      model can read), never a throw — same contract as runTool.
//   D. ONE STATEMENT PER CALL. An embedded semicolon is refused (a stacked second statement would
//      run unrecorded behind the audited first); a trailing semicolon is fine.
//   E. SHAPE GUARDS. meta_select refuses a write; meta_write refuses a read — each as a visible
//      result, before any pool is touched.
//   F. SIMULATE IS INERT. Under MEDICRW_MODE=simulate a legal SELECT still refuses visibly (the
//      role is not minted; nothing silently falls back to the owner pool).
//   G. THE SOURCE GUARD. guardedSourcePath refuses `../` and absolute escapes; a real in-tree path
//      resolves. There is no write/exec sibling to guard.
//   H. THE ASK ENDS THE TURN. need_human is flagged endsTurn — the loop honors the REGISTRY flag
//      (langchain-zee.js must not hardcode another registry's verb names).
//
// RUN:  node test/medic-registry.test.mjs           (no DATABASE_URL needed)
process.env.MEDICRW_MODE = 'simulate';
process.env.SHIP_MODE = process.env.SHIP_MODE || 'simulate';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://nobody@127.0.0.1:1/void';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { MEDIC_TOOLS, runMedicTool, singleStatement, guardedSourcePath } =
  await import('../server/src/lib/medic-tools.js');
const { LANGCHAIN_TOOLS } = await import('../server/src/lib/langchain-tools.js');

console.log('\n── A. two registries, disjoint ──');
const medicNames = Object.keys(MEDIC_TOOLS);
const zeeNames = Object.keys(LANGCHAIN_TOOLS);
const shared = medicNames.filter((n) => zeeNames.includes(n));
ok(medicNames.length >= 14, `the medic registry is populated (${medicNames.length} verbs)`);
ok(shared.length === 0, `no verb name is shared (${shared.join(', ') || 'none'})`);
for (const [name, d] of Object.entries(MEDIC_TOOLS)) {
  if (d.name !== name) { ok(false, `registry key "${name}" names itself "${d.name}"`); }
}
ok(true, 'every registry key matches its descriptor name');

console.log('\n── B. absence is the wall ──');
const forbidden = ['bash', 'shell', 'exec', 'run', 'write_file', 'edit', 'source_write', 'docker',
  'compose', 'git_commit', 'git_push', 'land', 'ship', 'seed', 'done'];
const present = forbidden.filter((n) => medicNames.includes(n));
ok(present.length === 0, `no exec/write/gate verb exists to be argued into (${present.join(', ') || 'none present'})`);

console.log('\n── C. the dispatch refusal ──');
const medic = { id: '00000000-0000-4000-8000-000000000000', target_project_id: null };
const unknown = JSON.parse(await runMedicTool(medic, { name: 'bash', args: { cmd: 'id' } }));
ok(unknown.ok === false, 'an unknown verb refuses as a RESULT');
ok(!!(unknown.error || unknown.reason), 'the refusal names itself so the model can react');

console.log('\n── D. one statement per call ──');
ok(!!singleStatement('SELECT 1;').sql, 'a trailing semicolon is tolerated');
ok(!!singleStatement('SELECT 1').sql, 'a bare statement passes');
ok(!!singleStatement('').error, 'an empty statement is refused');
ok(!!singleStatement("UPDATE machine SET id=id; DELETE FROM project").error,
   'an embedded semicolon (a stacked second statement) is refused');

console.log('\n── E. shape guards, before any pool ──');
const wr = JSON.parse(await runMedicTool(medic, { name: 'meta_select', args: { sql: 'UPDATE machine SET id=id' } }));
ok(wr.refused === true, 'meta_select refuses a write');
const rd = JSON.parse(await runMedicTool(medic, { name: 'meta_write', args: { sql: 'SELECT 1' } }));
ok(rd.refused === true, 'meta_write refuses a read');

console.log('\n── F. simulate is inert ──');
const sim = JSON.parse(await runMedicTool(medic, { name: 'meta_select', args: { sql: 'SELECT 1' } }));
ok(sim.ok === false, 'a legal SELECT under MEDICRW_MODE=simulate still refuses');
ok(/simulate|not minted|inert/i.test(sim.error || sim.reason || ''),
   'the refusal says WHY (the role is not minted) instead of hanging or falling back');

console.log('\n── G. the source guard ──');
const esc1 = guardedSourcePath('../../../etc/passwd');
ok(!!esc1.error, '`../` escape is refused');
const esc2 = guardedSourcePath('/etc/passwd');
ok(!!esc2.error, 'an absolute path outside the root is refused');
const inTree = guardedSourcePath('server/src/lib/medic-tools.js');
ok(!inTree.error && !!inTree.real, 'a real in-tree path resolves');
ok(!MEDIC_TOOLS.source_write && !MEDIC_TOOLS.source_edit, 'there is no write/edit sibling to guard');

console.log('\n── H. the ask ends the turn — by REGISTRY FLAG, not a hardcoded name ──');
ok(MEDIC_TOOLS.need_human.endsTurn === true, 'need_human declares endsTurn');
const loopSrc = readFileSync(resolve(here, '..', 'server/src/lib/langchain-zee.js'), 'utf8');
ok(/desc\?\.endsTurn/.test(loopSrc), 'the loop honors desc?.endsTurn');
ok(!/tc\.name === 'need_human'/.test(loopSrc), "the loop does not hardcode another registry's verb");

console.log(fail ? `\n${fail} FAILURE(S)` : '\nall good');
process.exit(fail ? 1 : 0);

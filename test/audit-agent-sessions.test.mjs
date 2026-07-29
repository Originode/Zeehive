// AUDIT-AGENT-SESSIONS test — the classifiers behind `node scripts/audit-agent-sessions.mjs`,
// the read-only answer to "is an AI session running that the fleet has lost track of?".
//
// The script itself needs a live queenzee (it is all HTTP GETs), so what is tested here is the
// part that decides what a finding IS — pure functions, fixtures only, no network, no DB:
//
//   • classifyCages    a RUNNING agent container with no live xell is ROGUE; an exited one is
//                      merely DEAD (disk, not tokens); one whose xell is live is ACCOUNTED. The
//                      legacy `zee_cage_*` generation counts as an agent cage — eleven of them
//                      were sitting on the dev machine when this was written, and a rogue-session
//                      hunt that only knows today's prefix walks straight past them.
//   • cageName         mirrors server/src/lib/cxell.js cxellName(). DUPLICATED there on purpose
//                      (that module drags in the db pool + ssh2 and this script must run on
//                      nothing but node + a URL) — so this test reads the real source and fails
//                      if the two ever disagree. A wrong name here would report every live cage
//                      as rogue.
//   • ghostRows        a zee row still marked live whose xell is retired/gone.
//   • classifySession  the asymmetry the whole tool rests on: transcript GROWTH is proof of a live
//                      turn (growth + a row that says the turn is over = OFF-BOOK, unaccounted
//                      tokens), while the ABSENCE of growth proves nothing — a turn blocked on one
//                      long tool call writes nothing for minutes. The first live run of this tool
//                      classified its OWN session as dead that way; the verdict is now
//                      'quiet-while-working' and is explicitly not a finding.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  cageName, isAgentCage, classifyCages, ghostRows, transcriptBytes, classifySession,
  contextsToScan, actionable,
} from '../scripts/audit-agent-sessions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// ── cageName agrees with the queenzee's own cxellName ─────────────────────────
const cxellSrc = readFileSync(resolve(here, '../server/src/lib/cxell.js'), 'utf8');
const nameLine = cxellSrc.match(/export const cxellName = \(slug\) =>([^\n]+)/);
ok(!!nameLine, 'server/src/lib/cxell.js still defines cxellName as a one-liner');
if (nameLine) {
  // Re-create the queenzee's own expression and compare on slugs that exercise the sanitiser.
  const real = new Function('slug', `return ${nameLine[1].replace(/;\s*$/, '')};`);
  for (const slug of ['sunny-meadow-61da4f', 'weird slug/with:chars', 'UPPER_dot.dash-1']) {
    ok(cageName(slug) === real(slug), `cageName("${slug}") === cxellName → ${real(slug)}`);
  }
}
ok(isAgentCage('cxell_sunny-meadow-61da4f'), 'cxell_* is an agent cage');
ok(isAgentCage('zee_cage_fix-statuses-per-xell-e33b29'), 'the legacy zee_cage_* generation counts too');
ok(!isAgentCage('zeehive_db_spin_sunny-meadow-61da4f'), 'a per-xell db container is NOT an agent cage');
ok(!isAgentCage('omnibiz_spin_server_x'), 'a spinoff app container is NOT an agent cage');

// ── classifyCages ────────────────────────────────────────────────────────────
{
  const containers = [
    { name: 'cxell_live-one', state: 'running' },
    { name: 'cxell_gone-one', state: 'running' },                 // no xell → ROGUE
    { name: 'cxell_exited-one', state: 'exited' },                // dead, not rogue
    { name: 'zee_cage_old-thing', state: 'running' },             // legacy, still an agent → ROGUE
    { name: 'zeehive_db_spin_live-one', state: 'running' },       // not a cage at all
  ];
  const { rogue, dead, accounted } = classifyCages(containers, ['live-one', 'other-live']);
  ok(accounted.length === 1 && accounted[0].name === 'cxell_live-one', 'the cage of a live xell is accounted');
  ok(rogue.map((c) => c.name).sort().join(',') === 'cxell_gone-one,zee_cage_old-thing',
     'running cages with no live xell are rogue (both generations)');
  ok(dead.length === 1 && dead[0].name === 'cxell_exited-one', 'an exited cage is dead, not rogue');
  ok(classifyCages([], []).rogue.length === 0, 'an empty daemon yields no findings');
  // A restarting cage is still running code — it must not be filed as dead.
  ok(classifyCages([{ name: 'cxell_x', state: 'restarting' }], []).rogue.length === 1,
     'a restarting cage counts as running (rogue), never as dead');
}

// ── ghostRows ────────────────────────────────────────────────────────────────
{
  const zees = [
    { id: 'a', xell_id: 'x1', decommissioned_at: null },                    // live xell → fine
    { id: 'b', xell_id: 'x9', decommissioned_at: null },                    // xell gone → GHOST
    { id: 'c', xell_id: 'x9', decommissioned_at: '2026-07-01T00:00:00Z' },  // properly stamped
  ];
  const g = ghostRows(zees, ['x1']);
  ok(g.length === 1 && g[0].id === 'b', 'only a non-decommissioned row on a dead xell is a ghost');
}

// ── transcriptBytes ──────────────────────────────────────────────────────────
ok(transcriptBytes(null) === null, 'no sample → null (unknown), never 0');
ok(transcriptBytes({ files: [] }) === 0, 'a cage with no transcript is 0 bytes');
ok(transcriptBytes({ files: [{ size: 10 }, { size: 5 }] }) === 15, 'sizes across sessions are summed');

// ── classifySession ──────────────────────────────────────────────────────────
{
  const s = (n) => ({ files: [{ size: n }] });
  const grow = { sample1: s(100), sample2: s(140) };
  const flat = { sample1: s(100), sample2: s(100) };

  ok(classifySession({ status: 'errored', ...grow }).verdict === 'off-book',
     'GROWING while the row says errored → off-book (unaccounted tokens)');
  ok(classifySession({ status: 'stopped', ...grow }).verdict === 'off-book',
     'GROWING while the row says stopped → off-book');
  ok(classifySession({ status: 'idle', ...grow }).verdict === 'off-book',
     'GROWING while the row says idle → off-book (idle is not a mid-turn status)');
  ok(classifySession({ status: 'working', ...grow }).verdict === 'working',
     'GROWING with a working row → the normal case, not a finding');
  ok(classifySession({ status: 'working', ...flat }).verdict === 'quiet-while-working',
     'FLAT with a working row → quiet-while-working (inconclusive, NOT a dead zee)');
  ok(classifySession({ status: 'errored', ...flat }).verdict === 'stalled',
     'FLAT with a finished row → stalled (holding resources, burning nothing)');
  ok(classifySession({ status: 'working', sample1: null, sample2: null }).verdict === 'unreachable',
     'no sample at all → unreachable, never a burn verdict');
  ok(classifySession({ status: 'errored', ...grow }).delta === 40, 'the growth delta is reported');

  // The exit code must fire on the two things a human has to act on, and on nothing else.
  const A = (sessions, rogue = []) => actionable({ cages: { rogue }, sessions });
  ok(A([{ verdict: 'off-book' }]) === 1, 'off-book burn is actionable (exit 1)');
  ok(A([], [{ name: 'cxell_x' }]) === 1, 'a rogue cage is actionable (exit 1)');
  ok(A([{ verdict: 'quiet-while-working' }, { verdict: 'stalled' }, { verdict: 'quiet' }]) === 0,
     'quiet/stalled rows are reported but do NOT fail the run');
}

// ── contextsToScan: one scan per docker context, however many sites share it ──
{
  const ctxs = contextsToScan([
    ['P1', [{ id: 's1', docker_ctx: 'default', key: 'dev' }, { id: 's2', docker_ctx: 'default', key: 'local' }]],
    ['P2', [{ id: 's3', docker_ctx: 'mardale-prod', key: 'mardale' }, { id: 's4', docker_ctx: null, key: 'dev' }]],
  ]);
  ok(ctxs.length === 2, 'contexts are de-duplicated across projects and sites');
  ok(ctxs.map((c) => c.ctx).sort().join(',') === 'default,mardale-prod', 'a null docker_ctx folds into default');
}

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);

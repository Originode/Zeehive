// "ATTACHED" IS NOT "WORKING" — the two read models that told a manager its finished crew was busy.
//
// THE DEFECT (the siblings of the done-suggestion reap bug, same OR, same hand):
//   • lib/hive-status.js  : working = zee_status==='working' || cli_active===true || status==='working'
//   • lib/managers.js     : crewFor() → working: cli_active === true || zee_status === 'working'
//
// `zee.cli_active` is monitor.js's probe, and for a cxell zee it is a BROAD `pgrep claude|codex|kimi`
// INSIDE the cage. The container is kept after the turn, and once anyone talks to that zee or opens
// its terminal, zee-attach.sh leaves `claude --resume` sitting in the pane for the life of the
// container — so the flag goes true on the first attach and never goes false again. It means
// ATTACHED, not WORKING.
//
// The cost was not cosmetic: a manager's crew read model is its only instrument, and it reported
// five finished workers as `working: true` / `occ-working` all session, which is exactly the state
// in which a manager waits instead of closing them out. The manual's own rule — "a worker that is
// occ-working is working" — was false.
//
// THE FIX (display/report only — reapability is decided by reaper.midTurnVerdict and is NOT touched
// here): the zee's own status says whether a turn is in flight; the monitor's flag is reported under
// the name of the thing it actually observes, `attached`.
//
// Part A is pure (hiveStatus is dependency-free). Part B exercises the real crewFor against an
// isolated throwaway project. Everything it creates is torn down in a finally, whatever happens.
import pg from 'pg';
import { hiveStatus } from '../server/src/lib/hive-status.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

console.log('\n── A. the hexagon: a finished zee in an attached cxell reads idle ──');
// The normal end state of every cxell job: the turn returned (zee 'idle', mirrored onto the xell),
// and a resting `claude --resume` still matches the monitor's pgrep.
ok(hiveStatus({ status: 'idle', zee_status: 'idle', cli_active: true }) === 'occ-idle',
   'idle zee + attached cxell → occ-idle (it was occ-working: "attached" was read as "working")');
ok(hiveStatus({ status: 'idle', zee_status: 'idle', cli_active: false }) === 'occ-idle',
   'idle zee, nothing attached → occ-idle (unchanged)');
// …and nothing about REAL activity changed.
ok(hiveStatus({ status: 'working', zee_status: 'working', cli_active: true }) === 'occ-working',
   'a zee mid-turn still reads occ-working');
ok(hiveStatus({ status: 'working', zee_status: 'working', cli_active: false }) === 'occ-working',
   'and it does not need the monitor to agree — the zee\'s own status is enough');
ok(hiveStatus({ status: 'idle', zee_status: 'working', cli_active: false }) === 'occ-working',
   'a zee that says working outranks a stale xell row');
ok(hiveStatus({ status: 'claimed', zee_status: 'idle', cli_active: true }) === 'occ-claimed',
   'a claimed xell whose zee is idle-but-attached reads claimed, not working');
// Every human-actionable signal still outranks activity, attached or not.
ok(hiveStatus({ status: 'idle', zee_status: 'idle', cli_active: true }, { tendPending: true }) === 'occ-tendRequest',
   'an open tend still outranks it');
ok(hiveStatus({ status: 'idle', zee_status: 'idle', cli_active: true }, { doneSuggested: true }) === 'occ-doneSuggest',
   'and a manager\'s done? suggestion still shows');

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.PROVISION_MODE = 'simulate';
process.env.TKB_NOTIFY = '0';

const client = new pg.Client({ connectionString: url });
const PID = '00000000-0000-4000-8000-0000000d6111';
const XID = '00000000-0000-4000-8000-0000000d6222';
const cleanup = async () => { try { await client.query(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* */ } };

try {
  await client.connect();
  await cleanup();
  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,'crewattached-test','/nonexistent/crewattached','master','crewattached','postgres')`, [PID]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [XID, PID]);

  const mkXell = async (slug, status, type = 'worker', mgr = null) => (await client.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status, is_pooled, zee_type, manager_xell_id)
       VALUES ($1,$2,$3,$4,$5,false,$6,$7) RETURNING *`,
    [PID, XID, slug, `spinoff/${slug}`, status, type, mgr])).rows[0];
  const mkZee = async (x, status, cliActive) => client.query(
    `INSERT INTO zee (xell_id, attach_mode, status, kind, entrypoint, cli_active, monitor_source,
                      last_monitor_at, last_event_at, viewer_kind)
       VALUES ($1,'headless-spawn',$2,'cxell','cxell-cli',$3,'cxell-pgrep',now(),now(),'none')`,
    [x.id, status, cliActive]);

  const mgr = await mkXell('camgr', 'working', 'manager');
  const finished = await mkXell('cafin', 'idle', 'worker', mgr.id);   // turn over, cage attached
  const busy = await mkXell('cabusy', 'working', 'worker', mgr.id);   // genuinely mid-turn
  await mkZee(finished, 'idle', true);
  await mkZee(busy, 'working', true);

  const { crewFor } = await import('../server/src/lib/managers.js');
  const crew = await crewFor(mgr.id);
  const fin = crew.find((c) => c.slug === 'cafin');
  const bsy = crew.find((c) => c.slug === 'cabusy');

  console.log('\n── B. the crew read model a manager decides on ──');
  ok(fin && fin.working === false,
     `a FINISHED worker in an attached cxell reports working:false (got ${JSON.stringify(fin?.working)})`);
  ok(fin && fin.attached === true,
     'the monitor\'s flag is still reported — under the name of what it observes: attached');
  ok(fin && fin.hive_status === 'occ-idle', `its hexagon reads idle (got ${fin?.hive_status})`);
  ok(bsy && bsy.working === true, 'a worker that is genuinely mid-turn still reports working:true');
  ok(bsy && bsy.hive_status === 'occ-working', 'and still reads occ-working');
  ok(fin && fin.zee_status === 'idle' && bsy.zee_status === 'working',
     'the raw zee status is still carried either way — nothing was hidden from the manager');

  console.log(fail ? `\n${fail} check(s) FAILED` : '\nall checks passed');
} catch (err) {
  console.error('\nTEST ERROR:', err);
  fail++;
} finally {
  await cleanup();
  await client.end().catch(() => {});
}
process.exit(fail ? 1 : 0);

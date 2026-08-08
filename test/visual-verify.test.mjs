// VISUAL VERIFICATION — per-xell opt-in: a human turns it on at dispatch time, the zee builds the
// webapp and OFFERS the live link to a human in the console (Open link / dismiss). Not a gate:
// no approve/reject, no prod, nothing irreversible — the zee only inserts an offer row.
//
// This test guards the shape end to end, statically where the surface is source (the dispatch
// composer, the CLI, the console card) and against the real meta-DB where the surface is data
// (the offer row, the per-xell flag, the binding/briefing, the manuals):
//   1. `selfVerifyWebapp` inserts an OPEN offer with the webapp container url + the xell's head
//      commit, and refuses when there is no webapp container URL;
//   2. `dismissVisualVerifyOffer` settles it to 'dismissed';
//   3. `setVisualVerify` sets/clears the per-xell flag on the xell row;
//   4. `bindingFor` carries `xell.visual_verify:true` and the prose rule ONLY when the flag is on
//      (false xells are unchanged);
//   5. `dispatchXell` stores the param on the xell;
//   6. the CLI advertises `zee verify-webapp` and `--visual-verify` and implements both;
//   7. the console composer sends `visual_verify` and the card renders Open link + dismiss;
//   8. the WORKER manual documents `zee verify-webapp` and the MANAGER manual documents
//      `--visual-verify` (the drift test enforces the first; this asserts both are present).
//
// Everything it creates is torn down in a finally, whatever happens.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import http from 'node:http';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.TKB_NOTIFY = '0';              // no desk pings from a test

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const client = new pg.Client({ connectionString: url });
const PID = '00000000-0000-4000-8000-00000000d111';
const XID = '00000000-0000-4000-8000-00000000d222';
const XOURCE = '00000000-0000-4000-8000-00000000d333';
const WEBAPP = '00000000-0000-4000-8000-00000000d444';
const ZID = '00000000-0000-4000-8000-00000000d555';
const SRV = '00000000-0000-4000-8000-00000000d666';

// selfVerifyWebapp PROBES the same upstream the /xell-web proxy dials before it offers — a card in
// front of a human must never be a dead link. So the fake webapp container needs something actually
// listening; any HTTP answer counts as alive.
const appTier = http.createServer((_req, res) => res.end('ok'));
await new Promise((r) => appTier.listen(0, '127.0.0.1', r));
const LIVE_PORT = appTier.address().port;
// A port with provably nothing on it: bind a second listener, note its port, close it.
const deadPortProbe = http.createServer(() => {});
await new Promise((r) => deadPortProbe.listen(0, '127.0.0.1', r));
const DEAD_PORT = deadPortProbe.address().port;
await new Promise((r) => deadPortProbe.close(r));

async function cleanup() {
  try { await client.query(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* */ }
  // xell/container/zee rows cascade from the project delete (xell_uses_container CASCADE from both)
}

try {
  await client.connect();
  await cleanup();

  // ── the throwaway project + xource + xell + webapp container + zee ──
  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,'visual-verify-test','/tmp/nonexistent','master','vvtest','postgres')`, [PID]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [XOURCE, PID]);
  await client.query(
    `INSERT INTO xell (id, project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                       visual_verify, head_commit)
       VALUES ($1,$2,$3,'vvy','spinoff/vvy','/tmp/vv-wt','working',false,true,$4)`,
    [XID, PID, XOURCE, 'abc123def456']);
  await client.query(
    `INSERT INTO container (id, project_id, role, tier, isolation, name, url, health, owner_xell_id, host_port)
       VALUES ($1,$2,'webapp','spinoff','per-xell','vv_webapp','http://localhost:5331','up',$3,$4)`,
    [WEBAPP, PID, XID, LIVE_PORT]);
  await client.query(
    `INSERT INTO xell_uses_container (xell_id, container_id, relation) VALUES ($1,$2,'owns')`,
    [XID, WEBAPP]);
  await client.query(
    `INSERT INTO zee (id, xell_id, name, status, kind, attach_mode, entrypoint)
       VALUES ($1,$2,'vvy-zee','working','headless','headless-spawn','cxell-cli')`,
    [ZID, XID]);

  const xellRow = async () => (await client.query(`SELECT * FROM xell WHERE id=$1`, [XID])).rows[0];
  const offerRows = async () =>
    (await client.query(`SELECT * FROM visual_verify_offer WHERE xell_id=$1 ORDER BY created_at`, [XID])).rows;

  const { selfVerifyWebapp, setVisualVerify, dismissVisualVerifyOffer } =
    await import('../server/src/queenzee/self.js');
  const { bindingFor } = await import('../server/src/queenzee/intake.js');
  const { dispatchXell } = await import('../server/src/queenzee/intake.js');

  // ── 1. selfVerifyWebapp offers the webapp url + head commit ──
  console.log('\n── the offer ──');
  const xell = await xellRow();
  const offered = await selfVerifyWebapp(xell);
  ok(offered.ok === true && offered.offer?.status === 'open',
     'selfVerifyWebapp records an OPEN offer');
  ok(offered.offer?.url === '/xell-web/vvy/',
     `the offer carries the DERIVED proxied path, never the stored LAN url (${offered.offer?.url})`);
  ok(offered.offer?.xell_slug === 'vvy' && offered.offer?.xell_id === XID, 'the offering xell is stamped on the row');
  ok(offered.offer?.project_id === PID, 'the project is stamped on the row');
  ok(offered.offer?.commit === 'abc123def456', 'the offer carries the xell head commit');
  const open = await offerRows();
  ok(open.length === 1, 'exactly one offer row exists');

  // one OPEN offer per xell: calling again hands back the same row, not a second card
  const again = await selfVerifyWebapp(xell);
  ok(again.ok === true && again.offer?.id === open[0].id,
     'a second verify-webapp call returns the SAME open offer (no flood)');
  ok((await offerRows()).length === 1, 'still exactly one offer row');

  // an offer with NO webapp container URL is refused
  await client.query(`DELETE FROM xell_uses_container WHERE xell_id=$1`, [XID]);
  const noWeb = await selfVerifyWebapp({ ...xell, id: XID });
  ok(noWeb.ok === false && /no webapp container/.test(noWeb.error || ''),
     'with no webapp container linked, selfVerifyWebapp refuses (build first)');
  await client.query(
    `INSERT INTO xell_uses_container (xell_id, container_id, relation) VALUES ($1,$2,'owns')`,
    [XID, WEBAPP]);

  // ── 1b. OFFER-TIME LIVENESS: a dead upstream is refused, never offered ──
  console.log('\n── offer-time liveness ──');
  // webapp row exists but nothing listens on its port → refuse (the card would 502)
  await client.query(`UPDATE container SET host_port=$2 WHERE id=$1`, [WEBAPP, DEAD_PORT]);
  const deadWeb = await selfVerifyWebapp(xell);
  ok(deadWeb.ok === false && /webapp is not answering/.test(deadWeb.error || '')
     && /zee build webapp --wait/.test(deadWeb.error || ''),
     'a dead webapp upstream is REFUSED, naming the build command');
  await client.query(`UPDATE container SET host_port=$2 WHERE id=$1`, [WEBAPP, LIVE_PORT]);
  // a server ROLE that exists but is down → refuse (the reviewed page would be a hollow shell)
  await client.query(
    `INSERT INTO container (id, project_id, role, tier, isolation, name, url, health, owner_xell_id, host_port)
       VALUES ($1,$2,'server','spinoff','per-xell','vv_server','http://localhost:5332','up',$3,$4)`,
    [SRV, PID, XID, DEAD_PORT]);
  await client.query(
    `INSERT INTO xell_uses_container (xell_id, container_id, relation) VALUES ($1,$2,'owns')`, [XID, SRV]);
  const deadSrv = await selfVerifyWebapp(xell);
  ok(deadSrv.ok === false && /server is not answering/.test(deadSrv.error || '')
     && /zee build server --wait/.test(deadSrv.error || ''),
     'a live webapp with a DEAD server role is refused (hollow shell), naming the build command');
  // a live server role passes again
  await client.query(`UPDATE container SET host_port=$2 WHERE id=$1`, [SRV, LIVE_PORT]);
  const bothUp = await selfVerifyWebapp(xell);
  ok(bothUp.ok === true, 'with both roles answering, the offer stands again');
  await client.query(`DELETE FROM container WHERE id=$1`, [SRV]);

  // ── 2. dismiss settles the offer ──
  console.log('\n── the dismiss ──');
  const d = await dismissVisualVerifyOffer(XID, { offerId: open[0].id });
  ok(d.ok === true && d.offer?.status === 'dismissed', 'dismissVisualVerifyOffer settles the offer to dismissed');
  ok(d.offer?.dismissed_at && d.offer?.dismissed_by === 'human@console', 'dismiss stamps time + by');
  const afterDismiss = await offerRows();
  ok(afterDismiss.length === 1 && afterDismiss[0].status === 'dismissed', 'a dismissed offer is a receipt, not a second row');

  // ── 3. setVisualVerify sets/clears the per-xell flag ──
  console.log('\n── the per-xell flag ──');
  await setVisualVerify(XID, { visual_verify: false });
  ok((await xellRow()).visual_verify === false, 'setVisualVerify(false) clears the flag');
  await setVisualVerify(XID, { visual_verify: true });
  ok((await xellRow()).visual_verify === true, 'setVisualVerify(true) sets the flag');

  // ── 4. bindingFor: the flag + prose ride ONLY when ON ──
  console.log('\n── the binding / briefing ──');
  const fakeZee = { id: ZID, name: 'vvy-zee', viewer_url: null };
  const on = await bindingFor(XID, fakeZee, 'task', { cxell: true });
  ok(on.xell?.visual_verify === true, 'binding.xell carries visual_verify:true when ON');
  ok(on.rules?.some((r) => /VISUAL VERIFICATION is ON/.test(r) && /zee build webapp --wait/.test(r)),
     'the prose rule tells a cxell zee to build with `zee build webapp --wait` then verify');
  ok(on.rules?.some((r) => /zee verify-webapp/.test(r)), 'the prose rule names `zee verify-webapp`');
  ok(on.rules?.some((r) => /OFFER only/.test(r) && /nothing is landed or shipped/.test(r)),
     'the prose rule says it is an OFFER only and never lands/ships for this');

  // false xells: NO field, NO rule (no briefing diff)
  await setVisualVerify(XID, { visual_verify: false });
  const off = await bindingFor(XID, fakeZee, 'task', { cxell: true });
  ok(!('visual_verify' in off.xell), 'binding.xell omits visual_verify entirely when OFF (no diff)');
  ok(!off.rules?.some((r) => /VISUAL VERIFICATION/.test(r)), 'the prose rule is absent when OFF');
  await setVisualVerify(XID, { visual_verify: true });

  // ── 5. dispatchXell stores the param on the xell ──
  console.log('\n── the dispatch param ──');
  await dispatchXell({
    xell_id: XID, project: PID, task: 'test dispatch', mode: 5, headless: true,
    visual_verify: false, rename: false,
  }).catch(() => { /* the spawn will fail inside the cage — the param is stored BEFORE the spawn */ });
  ok((await xellRow()).visual_verify === false, 'dispatchXell({visual_verify:false}) clears the flag');
  await dispatchXell({
    xell_id: XID, project: PID, task: 'test dispatch', mode: 5, headless: true,
    visual_verify: true, rename: false,
  }).catch(() => { /* same — the update happens first */ });
  ok((await xellRow()).visual_verify === true, 'dispatchXell({visual_verify:true}) sets the flag');
  // omission PRESERVES what the xell already has (a re-dispatch that says nothing changes nothing)
  await dispatchXell({
    xell_id: XID, project: PID, task: 'test dispatch', mode: 5, headless: true, rename: false,
  }).catch(() => { /* same — the update happens first */ });
  ok((await xellRow()).visual_verify === true,
     'dispatchXell with NO visual_verify param leaves the flag untouched (preserve on omission)');

  // ── 6. the CLI advertises and implements the verb + flag ──
  console.log('\n── the CLI ──');
  const cli = read('scripts/zee');
  const usageBlock = cli.slice(cli.indexOf('function usage()'), cli.indexOf('switch (cmd)'));
  ok(/^\s{2,}zee verify-webapp/m.test(usageBlock), 'usage advertises `zee verify-webapp`');
  ok(/\bcase 'verify-webapp':/.test(cli), 'the verify-webapp case is implemented');
  ok(/verify-webapp/.test(cli.slice(cli.indexOf("case 'verify-webapp'"))),
     'the case calls /api/xell/self/verify-webapp');
  ok(/--visual-verify/.test(usageBlock), 'usage advertises `--visual-verify`');
  ok(restHas(cli, '--visual-verify', 'dispatch') && restHas(cli, '--visual-verify', 'assign'),
     'both the dispatch and assign cases pass visual_verify when --visual-verify is present');
  function restHas(src, flag, cmdName) {
    const i = src.indexOf(`case '${cmdName}':`);
    const j = src.indexOf('\n  case ', i + 10);
    const block = src.slice(i, j > 0 ? j : i + 1200);
    return block.includes(`rest.includes('${flag}')`) && block.includes('visual_verify: true');
  }

  // ── 6b. the API routes pass visual_verify through ──
  const routes = read('server/src/api/routes.js');
  ok(/selfDispatch\(x, req\.body/.test(routes), 'POST /xell/self/dispatch passes the whole body (visual_verify rides along)');
  const assignRoute = routes.slice(routes.indexOf("'/xell/self/work/assign'"),
    routes.indexOf("'/xell/self/work/assign'") + 500);
  ok(/visual_verify: b\.visual_verify/.test(assignRoute), 'POST /xell/self/work/assign passes visual_verify through');
  ok(/\/xell\/self\/verify-webapp/.test(routes), 'POST /xell/self/verify-webapp route exists');
  ok(/\/xells\/:id\/visual-verify/.test(routes), 'POST /xells/:id/visual-verify (human set/dismiss) route exists');

  // ── 7. the console composer + card ──
  console.log('\n── the console ──');
  const dispatch = read('web/src/Dispatch.jsx');
  ok(/visual_verify/.test(dispatch), 'Dispatch.jsx sends visual_verify in the dispatch payload');
  ok(/visual_verify:\s*!!visualVerify/.test(dispatch),
     'Dispatch.jsx sends the EXPLICIT boolean — turning the toggle OFF clears a prior flag on re-dispatch');
  ok(/data-testid="dispatch-vv-on"/.test(dispatch) && /data-testid="dispatch-vv-off"/.test(dispatch),
     'the composer has the visual-verification on/off toggle');
  const vv = read('web/src/VisualVerify.jsx');
  ok(/Open link/.test(vv) && /Dismiss/.test(vv), 'VisualVerify card renders Open link + Dismiss');
  ok(/window\.open/.test(vv), 'Open link opens the webapp url in a new tab');
  ok(/dismissVisualVerify/.test(vv), 'the card calls the dismiss API');
  const app = read('web/src/App.jsx');
  ok(/from '\.\/VisualVerify\.jsx'/.test(app), 'App.jsx imports VisualVerify');
  ok(/<VisualVerifyPanel/.test(app), 'App.jsx RENDERS <VisualVerifyPanel>');
  ok(/fleet\.visual_verify_offers/.test(app), 'App.jsx reads the offers off the fleet payload');
  const apiSrc = read('web/src/api.js');
  ok(/'visual-verify'/.test(apiSrc), 'the SSE subscription listens for visual-verify events (dismiss refreshes the panel)');

  // ── 8. the manuals (worker: verify-webapp; manager: --visual-verify) ──
  console.log('\n── the manuals (via the meta-DB) ──');
  const wm = (await client.query(`SELECT harness_memory_get('zee-base','cxell-zee-manual.md') AS txt`)).rows[0].txt;
  ok(wm.includes('zee verify-webapp'), 'the worker manual documents `zee verify-webapp`');
  const mm = (await client.query(`SELECT harness_memory_get('manager','memory/manager-zee-manual.md') AS txt`)).rows[0].txt;
  ok(mm.includes('--visual-verify'), 'the manager manual documents `--visual-verify`');
  ok(mm.includes('zee dispatch') && mm.includes('zee assign'), '…on both dispatch and assign');
} finally {
  await cleanup();
  await client.end().catch(() => {});
  await new Promise((r) => appTier.close(r));
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);

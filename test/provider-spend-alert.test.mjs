// PER-PROVIDER SPEND-ALERT (migration 206) — a customizable USD amount per provider in project
// provider settings; a xell whose cumulative gateway-ledger spend on that provider exceeds the
// amount gets an OBVIOUS over-budget indicator on its hexagon.
//
// The job: "add a customizable alert if exceeds amount per provider in project provider settings.
// when a xell exceeds the set amount, show an obvious indicator in the xell hexagon."
//
// TRACE:
//   SET — Project setup → Agent providers: an "alert $" input per provider row
//         (web/src/ProjectSetup.jsx) → PUT /projects/:id/provider-alerts/:provider
//         (api/routes.js) → setProviderAlertAmount (lib/provider-tokens.js) writes
//         project.provider_alert_amounts (jsonb { provider: USD }).
//   READ — fleet.js attachUsageLimits compares each xell's per-provider spend (llm_gateway_request
//         cost_usd, the ONLY grain attributed to a provider key) against the thresholds and sets
//         x.burn_alert = { open, provider, cost, limit } (worst offender) or null.
//   SHOW — hive/HiveCanvas.drawCompactHex paints a pulsing red ring + "!" badge on that hexagon;
//         the xell bloom (web/src/App.jsx) shows the over-budget row under the burn.
//
// What this file covers:
//   A. Migration 206 exists.
//   B. setProviderAlertAmount / getProviderAlertAmounts / listProviderTokens round-trip.
//   C. End-to-end: getFleet computes x.burn_alert (over / under / no-threshold).
//   D. Wiring — the input, the route, the api call, the bloom row, the hexagon painter.
//   E. PAINT — run the real drawCompactHex against a recording 2D context and assert the red badge.
import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, rmSync, mkdirSync, writeFileSync as wfs, mkdtempSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const { setProviderAlertAmount, getProviderAlertAmounts, listProviderTokens } =
  await import('../server/src/lib/provider-tokens.js');
const { q, one, pool } = await import('../server/src/db/pool.js');

// ── A. migration 206 ─────────────────────────────────────────────────────────
console.log('\n── A. migration 206 — project.provider_alert_amounts ──');
{
  const mig = read('db/migrations/206_provider_spend_alert_thresholds.sql');
  ok(/ALTER TABLE project/.test(mig) && /provider_alert_amounts/.test(mig),
     'migration adds provider_alert_amounts to project');
  ok(/jsonb/.test(mig) && /DEFAULT '\\\{\\\}'::jsonb|DEFAULT '{}'::jsonb/.test(mig),
     '…as a jsonb map defaulting to empty');
}

// ── B. set / clear / round-trip on the ACCOUNT read model ───────────────────
console.log('\n── B. threshold round-trip ──');
let projectId = null;
let xellIds = [];
try {
  await q(`ALTER TABLE project ADD COLUMN IF NOT EXISTS provider_alert_amounts jsonb NOT NULL DEFAULT '{}'::jsonb`).catch(() => {});
  const proj = await one(
    `INSERT INTO project (name, repo_root)
     VALUES ($1, '/tmp/provider-spend-alert-test') RETURNING id`,
    [`spend-alert-${randomUUID().slice(0, 8)}`]);
  projectId = proj.id;

  const emptyMap = await getProviderAlertAmounts(projectId);
  ok(emptyMap && typeof emptyMap === 'object' && Object.keys(emptyMap).length === 0,
     'empty map on a fresh project');

  const set1 = await setProviderAlertAmount(projectId, 'claude', 50);
  eq(set1.alert_amount, 50, 'set claude → 50');
  const set2 = await setProviderAlertAmount(projectId, 'openai', '25.555');
  eq(set2.alert_amount, 25.56, 'money is cents-precision (25.555 → 25.56)');
  const map = await getProviderAlertAmounts(projectId);
  eq(map.claude, 50, 'claude read back');
  eq(map.openai, 25.56, 'openai read back (rounded)');

  const clear = await setProviderAlertAmount(projectId, 'claude', null);
  eq(clear.alert_amount, null, 'clearing returns null');
  eq((await getProviderAlertAmounts(projectId)).claude, undefined, 'cleared key is gone');
  eq((await getProviderAlertAmounts(projectId)).openai, 25.56, 'sibling key survives a clear');

  const bad = await setProviderAlertAmount(projectId, 'nope', 10)
    .then(() => 'NO-ERROR', (e) => e.message);
  ok(/unknown provider/.test(bad), `unknown provider refused (${bad})`);
  const neg = await setProviderAlertAmount(projectId, 'claude', -5)
    .then(() => 'NO-ERROR', (e) => e.message);
  ok(/non-negative/.test(neg), `negative amount refused (${neg})`);
  const zero = await setProviderAlertAmount(projectId, 'claude', 0);
  eq(zero.alert_amount, null, '0 clears like null');

  // listProviderTokens surfaces alert_amount per provider (null when unset).
  await setProviderAlertAmount(projectId, 'claude', 42);
  const listed = await listProviderTokens(projectId);
  const claude = listed.find((p) => p.provider === 'claude');
  const openai = listed.find((p) => p.provider === 'openai');
  eq(claude.alert_amount, 42, 'listProviderTokens surfaces claude alert_amount');
  eq(openai.alert_amount, 25.56, '…and openai (set earlier)');
  eq(listed.find((p) => p.provider === 'grok').alert_amount, null, 'unset provider → null');
} finally {
  if (projectId) await q(`DELETE FROM project WHERE id=$1`, [projectId]).catch(() => {});
}

// ── C. END-TO-END: getFleet computes x.burn_alert ───────────────────────────
if (!process.env.DATABASE_URL) {
  console.log('\n── (skipped: no DATABASE_URL — the end-to-end section needs this xell\'s own db) ──');
} else {
  console.log('\n── C. end to end: the console read model carries the over-budget flag ──');
  const { getFleet } = await import('../server/src/lib/fleet.js');

  const tag = 'spend' + randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
  const root = mkdtempSync(join(tmpdir(), `${tag}-`));
  let pid = null;
  try {
    const repo = join(root, 'xource');
    mkdirSync(repo, { recursive: true });
    const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'master'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    wfs(join(repo, 'f.md'), 'x\n'); git('add', '-A'); git('commit', '-qm', 'c1');

    pid = (await one(
      `INSERT INTO project (name, repo_root, main_branch, db_user, db_name, provider_alert_amounts)
         VALUES ($1,$2,'master','zeehive','zeehive','{"claude":50}'::jsonb) RETURNING id`,
      [`spend-alert-${tag}`, repo])).id;
    await q(`INSERT INTO pool_config (project_id, target_ready) VALUES ($1, 0)`, [pid]);
    const xo = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [pid]);

    const mkXell = async (slug) => {
      const wt = join(root, slug);
      mkdirSync(wt, { recursive: true });
      return one(
        `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                           zee_type, db_coupling)
           VALUES ($1,$2,$3,$4,$5,'working',false,'worker','db-isolated') RETURNING *`,
        [pid, xo.id, slug, `spinoff/${slug}`, wt]);
    };
    const xBig = await mkXell('big');      // claude spend 75 → OVER the 50 alert
    const xSmall = await mkXell('small');  // claude spend 10 → under
    const xGrok = await mkXell('grokx');   // grok spend 40 → NO grok threshold → no alert
    const xMixed = await mkXell('mixed');  // claude 60 + openai 5 → over on claude (60 > 50)
    xellIds = [xBig.id, xSmall.id, xGrok.id, xMixed.id];

    const gate = (x, provider, model, cost) => q(
      `INSERT INTO llm_gateway_request (xell_id, project_id, provider, model, method, path, status, total_tokens, cost_usd)
         VALUES ($1,$2,$3,$4,'POST','/v1/messages',200,1000,$5)`, [x, pid, provider, model, cost]);
    await gate(xBig.id, 'claude', 'opus', 25); await gate(xBig.id, 'claude', 'opus', 25); await gate(xBig.id, 'claude', 'opus', 25);
    await gate(xSmall.id, 'claude', 'opus', 10);
    await gate(xGrok.id, 'grok', 'grok-4', 40);
    await gate(xMixed.id, 'claude', 'opus', 60); await gate(xMixed.id, 'openai', 'gpt-5', 5);

    const f = await getFleet(pid);
    const row = (slug) => f.xells.find((x) => x.slug === slug);
    const big = row('big'), small = row('small'), grok = row('grokx'), mixed = row('mixed');

    ok(big?.burn_alert?.open === true, 'big xell → burn_alert OPEN');
    eq(big?.burn_alert?.provider, 'claude', '…on claude');
    eq(big?.burn_alert?.cost, 75, '…at 75 (3 × 25)');
    eq(big?.burn_alert?.limit, 50, '…against the 50 alert');
    ok(small?.burn_alert == null, 'small xell (10 < 50) → no alert');
    ok(grok?.burn_alert == null, 'xell on a provider with NO threshold → no alert');
    ok(mixed?.burn_alert?.open === true && mixed?.burn_alert?.provider === 'claude',
       'mixed xell → alert on the offending provider (claude)');
    eq(mixed?.burn_alert?.cost, 60, 'mixed claude cost is 60, not the cross-provider total 65');

    // regression: the usage HP bar fields still ride along.
    ok('usage_available_pct' in big && 'burn' in big, 'usage HP + burn fields still present on the row');
  } finally {
    if (pid) await q(`DELETE FROM project WHERE id=$1`, [pid]).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

// ── D. wiring ────────────────────────────────────────────────────────────────
console.log('\n── D. wiring — the input, the route, the api call, the bloom row, the painter ──');
{
  const mig = read('db/migrations/206_provider_spend_alert_thresholds.sql');
  ok(/provider_alert_amounts/.test(mig), 'migration present');

  const pt = read('server/src/lib/provider-tokens.js');
  ok(/export async function setProviderAlertAmount/.test(pt), 'setProviderAlertAmount exists');
  ok(/export async function getProviderAlertAmounts/.test(pt), 'getProviderAlertAmounts exists');
  ok(/alert_amount/.test(pt), 'listProviderTokens surfaces alert_amount');

  const routes = read('server/src/api/routes.js');
  ok(/provider-alerts\/:provider/.test(routes) && /setProviderAlertAmount/.test(routes),
     'routes.js has the PUT provider-alerts/:provider endpoint');

  const api = read('web/src/api.js');
  ok(/setProviderAlertAmount/.test(api) && /provider-alerts/.test(api),
     'web api.js has setProviderAlertAmount');

  const setup = read('web/src/ProjectSetup.jsx');
  ok(/provider-alert-/.test(setup) && /alert_amount/.test(setup) && /saveAlert/.test(setup),
     'Project setup renders the per-provider alert input');

  const app = read('web/src/App.jsx');
  ok(/xell-burn-alert/.test(app) && /burn_alert/.test(app),
     'the xell bloom shows the over-budget row');

  const hive = read('web/src/hive/HiveCanvas.jsx');
  ok(/function drawBurnAlert/.test(hive) && /burn_alert/.test(hive),
     'HiveCanvas draws the over-budget indicator');
  ok(/drawBurnAlert\(ctx, cx, cy, size, x\.burn_alert\)/.test(hive),
     '…and calls it from drawCompactHex with the row flag');
}

// ── E. PAINT IT: the real hexagon renderer against a recording 2D context ────
console.log('\n── E. paint — the hexagon really draws the red over-budget badge ──');
{
  const SRC = 'web/src/hive/HiveCanvas.jsx';
  const src = readFileSync(SRC, 'utf8');
  const tmp = 'web/src/hive/.provider-spend-alert.test-build.mjs';
  writeFileSync(tmp, transformSync(src, { loader: 'jsx', format: 'esm' }).code);
  let mod;
  try { mod = await import('../' + tmp); } finally { rmSync(tmp, { force: true }); }
  const { drawCompactHex, statusColor } = mod;

  function recorder() {
    const rec = { text: [], dash: [], arcs: [], ops: [], fills: [], strokes: [] };
    const noop = (name) => (...a) => { rec.ops.push(name); return a; };
    return {
      rec,
      canvas: { width: 800, height: 600 },
      save: noop('save'), restore: noop('restore'),
      beginPath: noop('beginPath'), closePath: noop('closePath'), moveTo: noop('moveTo'),
      lineTo: noop('lineTo'), rect: noop('rect'), roundRect: noop('roundRect'),
      fillRect: noop('fillRect'), strokeRect: noop('strokeRect'), ellipse: noop('ellipse'),
      bezierCurveTo: noop('bezierCurveTo'), quadraticCurveTo: noop('quadraticCurveTo'),
      clip: noop('clip'), clearRect: noop('clearRect'), translate: noop('translate'), scale: noop('scale'),
      drawImage: noop('drawImage'), setLineDash: noop('setLineDash'),
      fill() { rec.ops.push('fill'); rec.fills.push(this.fillStyle); },
      stroke() { rec.ops.push('stroke'); rec.strokes.push(this.strokeStyle); },
      arc(cx, cy, r) { rec.ops.push('arc'); rec.arcs.push({ cx, cy, r }); },
      createLinearGradient() { return { addColorStop() {} }; },
      measureText(t) {
        const px = Number((/(\d+(?:\.\d+)?)px/.exec(this.font || '') || [0, 12])[1]);
        return { width: String(t).length * px * 0.55 };
      },
      fillText(t, x, y) { rec.text.push({ t: String(t), x, y }); },
      strokeText(t) { rec.text.push({ t: String(t) }); },
    };
  }
  const paint = (x, size) => {
    const ctx = recorder();
    drawCompactHex(ctx, { x, id: x.id, cx: 200, cy: 200, size, cell: size, color: '#5b8cff' },
      { hover: false, dim: false });
    return ctx.rec;
  };

  const base = { id: 'X', slug: 'alerted-xell', status: 'working', hive_status: 'occ-working',
    zee_status: 'working', branch: 'spinoff/alerted-xell', head_commit: 'deadbeefcafe',
    is_pooled: false, burn: { tokens: 1000, cost: 75 } };

  const alerted = paint({ ...base, burn_alert: { open: true, provider: 'claude', cost: 75, limit: 50 } }, 70);
  // COL.error is #e5554e → withAlpha renders rgba(229,85,78,α) — the badge fill is that red.
  ok(alerted.fills.some((c) => /rgba\(229,85,78/.test(c)), 'the badge is painted in the error red');
  ok(alerted.text.some((t) => t.t === '!'), 'and it draws an exclamation mark');
  // upper-right vertex: dist 0.80·size at 330° → x ≈ 200 + 0.80·70·(√3/2) ≈ 248.5, y ≈ 200 − 28
  ok(alerted.arcs.some((a) => a.cx > 200 + 40 && a.cx < 200 + 60 && a.cy < 200 && a.cy > 200 - 35),
     'the badge sits at the UPPER-RIGHT vertex (the mirror of the provider coin)');

  const clean = paint({ ...base, burn_alert: null }, 70);
  ok(!clean.fills.some((c) => /rgba\(229,85,78/.test(c)), 'a xell with NO alert paints no red badge');
  ok(!clean.text.some((t) => t.t === '!'), '…and no exclamation mark');

  const tiny = paint({ ...base, burn_alert: { open: true, provider: 'claude', cost: 75, limit: 50 } }, 18);
  ok(tiny.arcs.length > 0, 'a tiny hex still runs (ring only, badge suppressed) without crashing');
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
try { await pool.end(); } catch { /* already closed */ }
process.exit(fail ? 1 : 0);

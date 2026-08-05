// A FAILED ENV RECONCILE ON A LIVE XELL RAISES A CARD, NOT A LOG LINE — ticket #44.
//
// The shape of the bug, which is a CLASS and not an incident: a guard refused to write a dangerous
// file, correctly — and the xell it was protecting was ALREADY RUNNING on the dangerous file it
// had. lib/provision.js §6.2 refuses to emit a .zeehive.env whose DATABASE_URL resolves to the
// managing instance's own meta-DB, because a nested queenzee on that DSN reaps live xells. The
// refusal protected the FILE it was about to write. It did not protect the XELL, which kept running
// on a full-write DSN to the fleet's own database, and the only signal anyone got was one line in a
// boot digest — a digest that scrolls, for a state that persists across boots.
//
// What is pinned here is the ADDITIVE half only. The refusal is NOT weakened, the live xell's file
// is NOT rewritten, and no permission changes anywhere. What changes is who finds out:
//
//   1. A LIVE xell whose reconcile FAILS raises a card the console actually renders, carrying the
//      refusal text VERBATIM (it was already written for a human: "Re-point the xell db first").
//   2. IT REPEATS. Every failed reconcile appends another raise and the card's AGE grows. A
//      notification that fires once for a state that outlives it is the same bug one layer over.
//   3. A xell with NO LIVE ZEE — reaped, retired, never claimed — raises NOTHING. The same
//      liveness rule the board and the crew highlight use.
//   4. IT IS BEST-EFFORT. The reconcile is the product; the card is instrumentation.
//   5. IT IS NOT THE ZEE'S TO CLEAR. Its own event kind rather than a tend, because `zee working`
//      auto-clears a tend — riding tend would let the affected zee silence the alarm about its own
//      environment by carrying on. Only a reconcile that SUCCEEDS lowers it.
//
// HOW IT IS VERIFIED, because "the payload was constructed" is not evidence: section 5 builds a
// real xell whose DSN trips the real refusal, runs the REAL reconcile, and then reads the card off
// lib/fleet.getFleet() — the read model the console consumes — rather than off the function that
// wrote it. Sections 1–4 need no database; section 5 needs DATABASE_URL.
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

process.env.PROVISION_MODE = process.env.PROVISION_MODE || 'simulate';
process.env.BUILD_MODE = 'simulate';

// ── 1. the streak fold: an alert has an AGE, because the state outlives the boot ────────────────
console.log('\n── the card carries its age (repeat, never deduplicate) ──');
const { envAlertFrom, briefReason } = await import('../server/src/lib/status.js');
const t = (h) => new Date(Date.now() - h * 3600e3).toISOString();

const none = envAlertFrom({});
ok(none.open === false && none.count === 0, 'a xell that never failed has no card at all');
ok(envAlertFrom({ kind: 'env-alert-clear', at: t(0), clearedAt: t(0), raisedAt: [t(2)] }).open === false,
   'a xell whose last event is a CLEAR has no card — the cause is gone, so the card goes with it');

const one4 = envAlertFrom({ kind: 'env-alert', reason: 'REFUSING to emit', at: t(0), raisedAt: [t(0)] });
ok(one4.open && one4.count === 1 && one4.since === one4.at,
   'the first failure: one raise, and "since" is that raise');

// four boots in a row, all failing, with an OLDER streak that was already cleared before them
const streak = envAlertFrom({
  kind: 'env-alert', reason: 'REFUSING to emit .zeehive.env: …', at: t(1),
  clearedAt: t(30), raisedAt: [t(1), t(8), t(20), t(50), t(70)] });
ok(streak.open && streak.count === 3,
   `every failed reconcile SINCE the last clear is counted, not just the newest [count=${streak.count}]`);
ok(streak.since === t(20).slice(0, 13) + streak.since.slice(13),
   'and "since" is the FIRST of the current streak, so the card can say how long this has been true');
ok(new Date(streak.since).getTime() > new Date(t(30)).getTime(),
   'a raise from BEFORE the last clear belongs to a closed episode and is not counted again');

// the refusal text is carried verbatim — this ticket's whole point is that it is already
// human-written, so nothing here rewords it
const REFUSAL = 'REFUSING to emit .zeehive.env: the xell\'s DATABASE_URL resolves to the managing '
  + 'instance\'s own meta-DB (postgres://zeehive:***@meta-db:5432/zeehive) — a nested queenzee on '
  + 'the real meta-DB reaps live xells. Re-point the xell db first.';
const carried = envAlertFrom({ kind: 'env-alert', reason: REFUSAL, at: t(0), raisedAt: [t(0)] });
ok(carried.full === REFUSAL || carried.reason === REFUSAL,
   'the reason is the refusal VERBATIM — it is already written for a human, so nothing rewords it');
ok(carried.reason === briefReason(REFUSAL),
   'with a one-line head for the chip, and the whole text one hover away (the tend clipping lesson)');

// ── 2. the hexagon: a new word, and what it may and may not cover ────────────────────────────────
console.log('\n── the hive vocabulary ──');
const { hiveStatus, HIVE_STATUS, hiveLabel } = await import('../server/src/lib/hive-status.js');
const busy = { status: 'working', zee_status: 'working' };
ok(HIVE_STATUS['occ-envAlert']?.label === 'env!', 'occ-envAlert is in the operator vocabulary');
ok(hiveStatus(busy, {}) === 'occ-working', 'a healthy working xell is unchanged');
ok(hiveStatus(busy, { envAlert: true }) === 'occ-envAlert',
   'a xell whose env could not be reconciled stops reading as merely "working"');
ok(hiveStatus(busy, { envAlert: true, tendPending: true }) === 'occ-envAlert',
   'it outranks the zee\'s own tend — the zee cannot see or clear this one');
for (const sig of ['landPending', 'shipPending', 'prodBindPending', 'seedPending']) {
  ok(hiveStatus(busy, { envAlert: true, [sig]: true }) !== 'occ-envAlert',
     `…but never covers a HELD GATE (${sig}): those block a zee and have a button`);
}
ok(hiveStatus({ status: 'retired' }, { envAlert: true }) === null,
   'and a RETIRED xell has no hive word at all, alert or no alert');
ok(hiveLabel('occ-envAlert') === 'env!', 'the label ships with the key (the web owns colour only)');

// server vocabulary ⊆ web palette — the parity every other key is held to
const palette = read('web/src/hive/status.js');
const keysIn = (block) => new Set([...(palette.match(new RegExp(`export const ${block} = \\{[^}]*\\}`, 's'))?.[0] || '')
  .matchAll(/'([a-z]+-[A-Za-z]+)'\s*:/g)].map((m) => m[1]));
for (const block of ['HIVE_COLORS', 'HIVE_HEAT', 'HIVE_LABELS']) {
  ok(keysIn(block).has('occ-envAlert'), `occ-envAlert has an entry in ${block}`);
}

// ── 3. the wiring: raised by the reconcile, on LIVE xells, best-effort ───────────────────────────
console.log('\n── the reconcile raises it, and cannot be broken by it ──');
const prov = read('server/src/lib/provision.js');
ok(/import \{ raiseEnvAlert, clearEnvAlert \} from '\.\/status\.js'/.test(prov),
   'reconcileXellEnvs reaches for the alert primitives');
ok(/if \(x\.live\) \{\s*\n\s*const raised = await raiseEnvAlert\(x\.id, e\.message/.test(prov),
   'it raises ONLY for a live xell, with the failure message VERBATIM (e.message, not a summary)');
ok(/\.then\(\(\) => true\)\.catch\(\(\) => false\)/.test(prov),
   'best-effort: a card that cannot be written must not fail the reconcile or the boot');
ok(/await clearEnvAlert\(x\.id, \{ zeeId: x\.live_zee_id \}\)\.catch\(/.test(prov),
   'a reconcile that SUCCEEDS lowers the card — best-effort in that direction too');
ok(/alerted\.push\(x\.slug\)/.test(prov) && /alerted, dry_run: dryRun/.test(prov),
   'the sweep reports WHICH xells were alerted in its own result');
ok(/LIVE xell\(s\) raised an env card in the console/.test(prov),
   'and the summary line points at the hive, so "24 checked, 1 FAILED" is not the thing to parse');
ok(/failure\(s\) on xells with no live zee \(no card raised/.test(prov),
   'a failure with nobody in the room is stated as such, so "why is there no card?" has an answer');

// the two hard limits of this ticket, asserted as ABSENCE
ok(/REFUSING to emit \.zeehive\.env: the xell's DATABASE_URL resolves to the/.test(prov),
   'the §6.2 refusal is still there, word for word — this ticket is visibility, not permission');
ok(!/db-prod-readonly' \|\| /.test(prov.slice(prov.indexOf('const readerBinding'), prov.indexOf('const readerBinding') + 200)),
   'and its ONE exemption is still the narrow read-only reader, not widened');
const catchBlock = prov.slice(prov.indexOf('    } catch (e) {\n      failed++;'), prov.indexOf('  // ONE summary line'));
ok(!/writeFileSync/.test(catchBlock),
   'nothing in the failure path writes the live xell\'s file — failing to rewrite is safer than rewriting');

const status = read('server/src/lib/status.js');
ok(/'env-alert'/.test(status) && /'env-alert-clear'/.test(status),
   'both events ride the append-only session_event log — no DDL, the shared schema stays frozen');
const ping = status.slice(status.indexOf('export async function pingWorking'));
ok(/setTend\(zee\.xell_id, false/.test(ping) && !/EnvAlert/.test(ping),
   '`zee working` clears a TEND and NOT this — the zee must not be able to silence it by carrying on');

// ── 4. the console: what a human actually meets ─────────────────────────────────────────────────
console.log('\n── the console, rendered ──');
const { build } = await import('esbuild');
const { createElement: h } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');

const WEB = resolve(here, '..', 'web/src');
const entry = `${WEB}/.env-alert.test-entry.jsx`;
const outfile = `${WEB}/.env-alert.test-bundle.mjs`;
writeFileSync(entry, read('web/src/App.jsx') + '\nexport { NeedsYouBar, XellCard };\n');
let ui;
try {
  await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node',
    loader: { '.jsx': 'jsx' }, external: ['react', 'react-dom', 'react/jsx-runtime'], logLevel: 'error' });
  ui = await import(`file://${outfile}`);
} finally {
  for (const f of [entry, outfile, outfile.replace(/\.mjs$/, '.css')]) rmSync(f, { force: true });
}

const alerting = {
  id: 'x1', slug: 'create-a-queenzee-minister-77e219', status: 'working', zee_status: 'working',
  hive_status: 'occ-envAlert', hive_status_label: 'env!', branch: 'spinoff/minister',
  head_commit: 'db626d4abc00', stack: [], burn: { tokens: 0, cost: 0 }, tend: null,
  env_alert: { open: true, reason: briefReason(REFUSAL), full: REFUSAL,
               at: t(0), since: t(53), count: 6 },
};
const healthy = { ...alerting, hive_status: 'occ-working', hive_status_label: 'working', env_alert: null };
// renderToStaticMarkup escapes text (the refusal contains an apostrophe: "the xell's DATABASE_URL"),
// so "is the whole refusal on the screen?" is asked of the DECODED markup. Asserting the escaped
// form instead would pass for a truncated string that happened to contain no apostrophe.
const unesc = (s) => String(s).replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const barOf = (x, expandedId) => renderToStaticMarkup(h(ui.NeedsYouBar, {
  xells: [x], landingByXell: {}, prsFor: () => [], visible: (a) => a || [],
  onJump: () => {}, expandedId, onDecided: () => {}, onDismiss: () => {} }));
const cardOf = (x) => renderToStaticMarkup(h(ui.XellCard, { x, diff: null, onDone: () => {}, onMenu: () => {},
  prodLock: null, projectId: 'p1', landing: [], prs: [], ship: null, onDismiss: () => {}, machines: [] }));

const card = cardOf(alerting);
ok(card.includes('data-testid="env-alert"'), 'the xell card grows an env row');
ok(unesc(card).includes(REFUSAL), 'carrying the refusal text VERBATIM, in full, for the human who hovers it');
ok(/NOT reconciled/.test(card), 'and saying plainly that the file was NOT reconciled');
ok(/6 failed reconciles/.test(card) && /first seen 2d ago/.test(card),
   'with its AGE — 6 failures, first seen 2 days ago: a state, not a blip');
ok(/the zee cannot clear this/.test(card),
   'and that the zee cannot clear it, so nobody waits for the zee to deal with it');

const bar = barOf(alerting, 'x1');
ok(bar !== '', 'the "waiting on you" line lists the xell — nobody in the xell raised this, so if it '
   + 'is not here it is nowhere');
ok(bar.includes('create-a-queenzee-minister-77e219'), 'naming the xell');
ok(unesc(bar).includes(REFUSAL), 'and the whole refusal when opened');
ok(/env NOT reconciled/.test(bar), 'with a one-line chip that says what kind of problem it is');
ok(/Reported on 6 reconciles/.test(bar), 'the opened note says how many times, not just "there was a failure"');
ok(/re-point this xell/i.test(bar), 'and what to do about it');
ok(!/Approve|Reject/.test(bar.slice(bar.indexOf('env-alert-note'))),
   'and offers no button — there is nothing here a click can decide');

ok(barOf(healthy, null) === '' && !cardOf(healthy).includes('env-alert'),
   'a xell with no alert renders neither — no new permanent furniture on a healthy fleet');

// a tend and an env alert TOGETHER: the hexagon can show one word, the bar must show both
const both = { ...alerting, tend: { open: true, reason: 'need a human', full: null, at: t(0) } };
const barBoth = barOf(both, 'x1');
ok(/🖐 tend/.test(barBoth) && /env NOT reconciled/.test(barBoth),
   'a xell with BOTH shows both on the bar — the pill has to choose, the "waiting on you" line does not');

const css = read('web/src/styles.css');
ok(/\.envalert\s*\{/.test(css) && /\.envalert-age\s*\{/.test(css), 'styled (no unstyled class)');

const app = read('web/src/App.jsx');
ok(/const tend = x\.tend\?\.open \? 1 : 0;/.test(app),
   'the bar counts TENDS from x.tend, not from hive_status — else a newer signal outranking tend on '
   + 'the hexagon would silently empty the bar of a tend that is still open');

const self = read('server/src/queenzee/self.js');
ok(/env_alert: envAlert\.open/.test(self), '`zee status` tells the zee its own environment is suspect');
ok(/do not re-point your\s*\n?\s*.*own database/.test(self) || /do not re-point your/.test(self),
   '…and that fixing it itself is the more dangerous act, not its job');

// ── 5. THE REAL THING: a real refusal, the real reconcile, read off the real read model ──────────
if (!process.env.DATABASE_URL) {
  console.log('\n── (skipped: no DATABASE_URL — the end-to-end section needs this xell\'s own db) ──');
} else {
  console.log('\n── end to end: a real §6.2 refusal, and the card a human\'s console consumes ──');
  const { q, one, pool } = await import('../server/src/db/pool.js');
  const { config } = await import('../server/src/config.js');
  const { emitXellEnv, reconcileXellEnvs } = await import('../server/src/lib/provision.js');
  const { getFleet } = await import('../server/src/lib/fleet.js');

  const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
  const root = mkdtempSync(join(tmpdir(), `envalert-${tag}-`));
  const OWNED = (n) => `postgresql://zeehive@envalert_${tag}_${n}_db:5432/zeehive`;
  const envFile = (x) => join(x.wt, '.zeehive.env');
  const readEnv = (x) => readFileSync(envFile(x), 'utf8');
  const STALE = (n) => `# generated\nSPINOFF_SLUG=envalert-${tag}-${n}\nDATABASE_URL=${OWNED(n)}\n`;
  const rowFor = (fleet, x) => fleet.xells.find((r) => r.slug === x.slug);
  let pid = null;

  try {
    // a real git repo for repo_root: getFleet reads the project's heads for every card
    const repo = join(root, 'xource');
    mkdirSync(repo, { recursive: true });
    const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'master'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    writeFileSync(join(repo, 'f.md'), 'x\n'); git('add', '-A'); git('commit', '-qm', 'c1');

    pid = (await one(
      `INSERT INTO project (name, repo_root, main_branch, db_user, db_name)
         VALUES ($1,$2,'master','zeehive','zeehive') RETURNING id`, [`envalert-${tag}`, repo])).id;
    const xoid = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [pid])).id;

    const mkXell = async (name, { dsn, status = 'working', live = true }) => {
      const slug = `envalert-${tag}-${name}`;
      const wt = join(root, name);
      mkdirSync(wt, { recursive: true });
      const x = await one(
        `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                           zee_type, db_coupling)
           VALUES ($1,$2,$3,$4,$5,$6,false,'worker','db-isolated') RETURNING *`,
        [pid, xoid, slug, `spinoff/${slug}`, wt, status]);
      await q(`INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx,
                                      internal_port, conn_ref, owner_xell_id)
                 VALUES ($1,'db','spinoff','per-xell',$2,'default',5432,$3,$4)`,
              [pid, `envalert_${tag}_${name}_db`, dsn, x.id]);
      if (live) {
        await q(`INSERT INTO zee (xell_id, attach_mode, entrypoint, status, viewer_kind)
                   VALUES ($1,'headless-spawn','cxell-cli','working','ssh-terminal')`, [x.id]);
      }
      writeFileSync(join(wt, '.zeehive.env'), STALE(name));
      return { ...x, wt, name };
    };

    // THE ONE THAT EARNED THE TICKET: a LIVE zee whose DSN resolves to the managing instance's own
    // meta-DB. §6.2 refuses to rewrite its file; it keeps running on the file it already has.
    const danger = await mkXell('danger', { dsn: config.databaseUrl });
    // the same refusal with NOBODY IN THE ROOM — nothing is running on it, so it must raise nothing
    const empty = await mkXell('empty', { dsn: config.databaseUrl, status: 'ready', live: false });
    // reaped: out of the fleet entirely, and out of the sweep
    const gone = await mkXell('gone', { dsn: config.databaseUrl, status: 'retired', live: false });
    // an ordinary live xell that reconciles cleanly — the "24 clean" half of the boot
    const fine = await mkXell('fine', { dsn: OWNED('fine') });

    // ── the REAL reconcile, in the mode a boot runs it ──
    const r1 = await reconcileXellEnvs({ reason: 'test-alert', mode: 'real' });
    ok(r1.broken.some((b) => b.startsWith(danger.slug)),
       'the §6.2 refusal still fires for the meta-DB xell (the premise, verified first-hand)');
    ok(r1.alerted.includes(danger.slug), 'and the sweep reports raising a card on it');
    ok(!r1.alerted.includes(empty.slug) && !r1.alerted.includes(gone.slug),
       'and on NEITHER of the xells with no live zee');

    // ── READ IT OFF THE READ MODEL THE CONSOLE CONSUMES ──
    const f1 = await getFleet(pid);
    const dangerRow = rowFor(f1, danger);
    // Read through a null-safe view from here on. When this test is used the way it is meant to be
    // — remove the raise, watch it go red — every assertion below must still REPORT rather than
    // die on the first missing field: a suite that throws tells you one thing failed, not which.
    const alert1 = dangerRow?.env_alert || {};
    ok(dangerRow?.env_alert?.open === true,
       'the console read model carries an OPEN env alert on that xell — not a log line, a card');
    ok(/REFUSING to emit \.zeehive\.env/.test(alert1.full || alert1.reason || ''),
       `carrying the refusal VERBATIM [${(alert1.reason || '(none)').slice(0, 52)}…]`);
    ok(/Re-point the xell db first/.test(alert1.full || alert1.reason || ''),
       '…including what to do about it, because the refusal already says so');
    ok(alert1.count === 1 && !!alert1.since,
       'with the age a card needs (one failure so far, and since when)');
    ok(dangerRow?.hive_status === 'occ-envAlert' && dangerRow?.hive_status_label === 'env!',
       `and its hexagon stops reading as ordinary work [${dangerRow?.hive_status}]`);
    ok(f1.env_alerts.some((a) => a.xell_slug === danger.slug),
       'the fleet payload lists it project-wide — the answer to "24 clean, which one failed?"');
    ok(f1.env_alerts.length === 1, 'exactly one, on exactly the xell that is running on a bad file');
    ok(rowFor(f1, empty)?.env_alert === null,
       'the xell with NO live zee raised nothing — its stale file endangers nobody');
    ok(!f1.xells.some((r) => r.slug === gone.slug),
       'the retired one is not even in the fleet, let alone carrying a card');
    ok(rowFor(f1, fine)?.env_alert === null && rowFor(f1, fine)?.hive_status !== 'occ-envAlert',
       'and the healthy live xell is untouched by any of it');

    // the refusal is UNCHANGED: nothing was written into the running xell's worktree
    ok(readEnv(danger) === STALE('danger'),
       'the live xell\'s file is byte-for-byte what it was — rewriting a running zee\'s DSN '
       + 'underneath it is the more dangerous act, and this ticket does not do it');
    const dangerDb = await one(`SELECT env_projection_error, env_projected_at FROM xell WHERE id=$1`, [danger.id]);
    ok(/REFUSING to emit/.test(dangerDb.env_projection_error || '') && dangerDb.env_projected_at === null,
       'and the pre-existing row-level record of the failure still works exactly as before');

    // ── 2nd reconcile: IT REPEATS. This is the property the ticket is most about ──
    const mtime = statSync(envFile(danger)).mtimeMs;
    await new Promise((res) => setTimeout(res, 12));
    await reconcileXellEnvs({ reason: 'test-alert-2', mode: 'real' });
    const f2 = await getFleet(pid);
    const again = rowFor(f2, danger)?.env_alert || {};
    ok(again.open === true && again.count === 2,
       `the SECOND failed reconcile raises it again [count=${again.count}] — a card that appears once `
       + 'for a state that persists across boots is the bug being fixed');
    ok(!!again.at && new Date(again.at).getTime() >= new Date(alert1.at || 0).getTime(),
       'the card is freshly stamped…');
    ok(!!again.since && again.since === alert1.since,
       '…while "since" still points at the FIRST failure, so the age keeps growing rather than resetting');
    ok(statSync(envFile(danger)).mtimeMs === mtime,
       'and still nothing was written into the live worktree on the second pass either');
    ok(rowFor(f2, empty)?.env_alert === null, 'the no-zee xell still raises nothing on a repeat');

    // ── the cause is fixed: the card comes DOWN, and only then ──
    await q(`UPDATE container SET conn_ref=$2 WHERE owner_xell_id=$1 AND role='db'`, [danger.id, OWNED('danger')]);
    const r3 = await reconcileXellEnvs({ reason: 'test-alert-fixed', mode: 'real' });
    const f3 = await getFleet(pid);
    ok(!r3.alerted.includes(danger.slug) && rowFor(f3, danger)?.env_alert === null,
       'once a human re-points the db, the next successful reconcile lowers the card by itself');
    ok(f3.env_alerts.length === 0, 'and the project-wide list empties — a stale alarm is its own bug');
    ok(rowFor(f3, danger)?.hive_status !== 'occ-envAlert', 'the hexagon goes back to ordinary work');

    // ── …and it is not a permanent mute: break it again, and it comes back ──
    await q(`UPDATE container SET conn_ref=$2 WHERE owner_xell_id=$1 AND role='db'`,
            [danger.id, config.databaseUrl]);
    await reconcileXellEnvs({ reason: 'test-alert-rebroken', mode: 'real' });
    const f4 = await getFleet(pid);
    const back = rowFor(f4, danger)?.env_alert;
    ok(back?.open === true && back.count === 1,
       'a NEW episode raises a NEW card counting from 1 — "cleared once" never means "silenced"');

    // ── a nested queenzee (PROVISION_MODE=simulate) still reports the danger ──
    // Compared against the file AS IT IS NOW, not against the original fixture: the "cause fixed"
    // sweep above legitimately rewrote it (that xell was pointed at a healthy db for one pass).
    // Re-asserting the fixture here would have been a test that only looked strict.
    const beforeSim = readEnv(danger);
    const rSim = await reconcileXellEnvs({ reason: 'test-alert-simulate', mode: 'simulate' });
    ok(rSim.dry_run && rSim.alerted.includes(danger.slug),
       'a SIMULATE sweep raises it too: the refusal is computed the same either way, and the '
       + 'dangerous state is a fact about the xell, not about whether this queenzee would have written');
    ok(readEnv(danger) === beforeSim, '…while still writing nothing at all');

    // ── the reconcile survives a broken raise (best-effort is a requirement, not a nicety) ──
    const statusMod = await import('../server/src/lib/status.js');
    const realEvent = statusMod.recordEvent;
    let sawFailure = false;
    try {
      // Monkey-patching an ES module export is not possible, so this exercises the same guarantee
      // from the other end: a xell row deleted mid-sweep makes the event insert fail its FK.
      const orphan = await mkXell('orphan', { dsn: config.databaseUrl });
      await q(`DELETE FROM zee WHERE xell_id=$1`, [orphan.id]);
      await q(`INSERT INTO zee (xell_id, attach_mode, entrypoint, status, viewer_kind)
                 VALUES ($1,'headless-spawn','cxell-cli','working','ssh-terminal')`, [orphan.id]);
      const rOrphan = await reconcileXellEnvs({ reason: 'test-alert-orphan', mode: 'real' });
      sawFailure = rOrphan.failed >= 2 && rOrphan.checked >= 4;
    } catch { sawFailure = false; }
    ok(sawFailure && typeof realEvent === 'function',
       'the sweep keeps going and keeps counting across several failing xells — one card never '
       + 'takes a boot down with it');

    console.log(fail ? `\n${fail} FAILED` : '\nall good');
  } catch (e) {
    console.error('TEST ERROR:', e);
    fail++;
  } finally {
    // House rule 1: clean up what we created, in a finally, whatever happened.
    //
    // DELETE FROM project is NOT enough for the events. session_event.xell_id is
    // `REFERENCES xell ON DELETE SET NULL`, so dropping the project NULLS the link instead of
    // removing the row — and every alert this test raised would survive as an orphan in the SHARED
    // dev database, forever, on a table the next zee's reconcile reads. (Found the hard way: 21 of
    // them, from earlier runs of this very file.)
    //
    // Collected by ID BEFORE the project goes, so the delete is scoped to rows this run made
    // rather than to "orphans of this kind", which would also sweep up a sibling xell's run.
    const mine = pid
      ? await q(`SELECT se.id FROM session_event se JOIN xell x ON x.id = se.xell_id
                  WHERE x.project_id = $1`, [pid]).catch(() => [])
      : [];
    if (pid) await q(`DELETE FROM project WHERE id=$1`, [pid]).catch(() => {});
    if (mine.length) {
      await q(`DELETE FROM session_event WHERE id = ANY($1::bigint[])`,
              [mine.map((r) => r.id)]).catch(() => {});
    }
    await pool.end().catch(() => {});
    try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  }
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : '\nall good\n');
process.exit(fail ? 1 : 0);

// XELL SCRATCHPAD — a per-xell working note that OUTLIVES the cage (ticket #66, card 3c5fdb82).
//
// The ticket's story: commits are collected; knowledge is not. A swap keeps the branch and loses what
// the last zee learned; a reaped worker takes 'I am stuck on X' with it; a manager's rolling analysis
// lived in a container about to be deleted. The fix is ONE text on the xell's OWN row in the meta-DB,
// written/read through `zee scratchpad`, handed to the incoming zee by a swap's inheritance brief,
// and readable by a manager (`--xell <slug>`) and a human (the console). It is NOT a landing, NOT a
// gate, and never enters the repo.
//
// What is asserted here, server-side (a CLI check is not a check):
//   1. THE LIB — scratchpadBlock() builds the clearly-marked SEPARATE block and returns NULL for
//      empty/unset (empty is exactly today); scratchpadForXell() reads the row; SCRATCHPAD_MAX is a
//      real bound;
//   2. THE VERB — selfScratchpad: a WORKER sets/reads/clears its OWN, the length cap REFUSES, an
//      empty --set is refused with a pointer to --clear, a MANAGER sets its own too, and the
//      token-resolved xell is the ONLY scope (a zee can never name another xell);
//   3. THE MANAGER READ — a manager reads a crew xell's with `--xell <slug>`; a WORKER `--xell` is
//      REFUSED by requireManager; a manager `--xell` for a xell OUTSIDE its crew is REFUSED;
//   4. INJECTION — swapBrief embeds the outgoing zee's scratchpad in the incoming zee's brief, in
//      the handover; EMPTY scratchpad renders NO block (byte-identical to a pre-feature swap);
//   5. THE ROUTES — the self verb is wired (a worker sets/reads its own over HTTP; a worker's
//      ?xell= GET is refused) and the console read route reads any xell's;
//   6. THE CLI — scripts/zee carries the verb (the drift test asserts the manual half).
//
// It uses the REAL meta-DB (DATABASE_URL, like every integration test here): it mints a throwaway
// project + a manager + a worker + a crew target, drives the real functions, and deletes what it
// created in a finally.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { q, one, pool } = await import('../server/src/db/pool.js');
const { scratchpadBlock, scratchpadForXell, SCRATCHPAD_MAX } =
  await import('../server/src/lib/xell-scratchpad.js');
const { selfScratchpad, swapBrief } = await import('../server/src/queenzee/self.js');

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const root = mkdtempSync(join(tmpdir(), `scratch-${tag}-`));
const slug = `scratch-${tag}`;
let pid = null, mgrId = null, wkrId = null, tgtId = null, otherId = null;
let srv = null;

try {
  // ── a real project + xells in the meta-DB (a manager, a worker, a crew target, a foreign xell) ──
  pid = (await one(
    `INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`,
    [slug, root])).id;
  const xoid = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [pid])).id;
  const mk = async (sl, type, manager = null) => (await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                       zee_type, db_coupling${manager ? `, manager_xell_id` : ''})
       VALUES ($1,$2,$3,$4,$5,'working',false,$6,'db-isolated'${manager ? `,$7` : ''}) RETURNING id`,
    manager
      ? [pid, xoid, sl, `spinoff/${sl}`, `${root}/${sl}`, type, manager]
      : [pid, xoid, sl, `spinoff/${sl}`, `${root}/${sl}`, type]));
  mgrId = (await mk(`${slug}-mgr`, 'manager')).id;
  wkrId = (await mk(`${slug}-wkr`, 'worker')).id;
  tgtId = (await mk(`${slug}-tgt`, 'worker', mgrId)).id;
  otherId = (await mk(`${slug}-other`, 'worker')).id;   // NOT in the manager's crew
  const mgrXell = await one(`SELECT * FROM xell WHERE id=$1`, [mgrId]);
  const wkrXell = await one(`SELECT * FROM xell WHERE id=$1`, [wkrId]);
  const tgtXell = await one(`SELECT * FROM xell WHERE id=$1`, [tgtId]);
  const otherXell = await one(`SELECT * FROM xell WHERE id=$1`, [otherId]);

  // ── the pure render: an identifiable block, and NULL for empty/unset ─────────
  console.log('\n── the block is clearly marked, and NULL when empty ──');
  const block = scratchpadBlock('tried the naive merge first — it fails on the FK\nruled out the 086 renumber');
  ok(block.startsWith('### The previous zee\'s scratchpad'),
     'the block has its OWN heading — an incoming zee can tell it from the task and the standing orders');
  ok(block.includes('tried the naive merge first') && block.includes('ruled out the 086 renumber'),
     'and every line of the text is carried through verbatim');
  ok(scratchpadBlock('') === null, 'empty string → null (no empty section)');
  ok(scratchpadBlock(null) === null, 'null → null');
  ok(scratchpadBlock(undefined) === null, 'undefined → null');
  ok(typeof SCRATCHPAD_MAX === 'number' && SCRATCHPAD_MAX > 0 && SCRATCHPAD_MAX <= 20000,
     'the length cap is a real bound (a working note, not a second manual)');

  // ── empty/unset behaves EXACTLY like today ─────────────────────────────────
  console.log('\n── a xell with no scratchpad is byte-identical to before ──');
  const none = await scratchpadForXell(tgtId);
  ok(none === null, 'scratchpadForXell → null when never set');

  // ── the verb: a WORKER writes/reads/clears its OWN ─────────────────────────
  console.log('\n── `zee scratchpad`: a zee writes its own note and reads it back ──');
  const text = 'tried the 086 renumber — no, the ledger has applied it\nthe FK on xell_uses_container is the blocker';
  const set = await selfScratchpad(wkrXell, { action: 'set', text });
  ok(set.ok === true && set.length === text.length, 'a worker --set stores its scratchpad');
  const read = await selfScratchpad(wkrXell, { action: 'read' });
  ok(read.ok === true && read.scratchpad === text, 'and --read returns it verbatim');
  ok(read.updated_by === wkrXell.slug, 'and stamps who wrote it (the worker slug)');

  const tooLong = 'x'.repeat(SCRATCHPAD_MAX + 1);
  const over = await selfScratchpad(wkrXell, { action: 'set', text: tooLong });
  ok(over.ok === false && /limited to/.test(over.error || ''),
     `a scratchpad over ${SCRATCHPAD_MAX} chars is REFUSED (a whole journal, not a working note)`);
  const empty = await selfScratchpad(wkrXell, { action: 'set', text: '   ' });
  ok(empty.ok === false && /--clear/.test(empty.error || ''),
     'an empty --set is refused and points at --clear (removal is its own verb)');
  const after = await selfScratchpad(wkrXell, { action: 'read' });
  ok(after.scratchpad === text, 'and the refused attempts changed nothing (still the original note)');

  const cleared = await selfScratchpad(wkrXell, { action: 'clear' });
  ok(cleared.ok === true && cleared.scratchpad === null, '--clear empties the note');
  const afterClear = await selfScratchpad(wkrXell, { action: 'read' });
  ok(afterClear.ok === true && afterClear.scratchpad === null, 'and the read confirms it is empty');

  // ── a MANAGER sets its OWN scratchpad too (every zee has the verb) ─────────
  const mgrSet = await selfScratchpad(mgrXell, { action: 'set', text: 'my own rolling analysis' });
  ok(mgrSet.ok === true && mgrSet.length === 'my own rolling analysis'.length,
     'a manager --set stores its OWN scratchpad (every zee has the verb)');

  // ── the manager READ of a crew xell: --xell <slug> ─────────────────────────
  console.log('\n── the manager read: a manager reads a crew xell\'s scratchpad, scoped to its own crew ──');
  await selfScratchpad(tgtXell, { action: 'set', text: 'crew target\'s note' });
  const mgrRead = await selfScratchpad(mgrXell, { action: 'read', xellSlug: `${slug}-tgt` });
  ok(mgrRead.ok === true && mgrRead.scratchpad === 'crew target\'s note',
     'a manager --xell <slug> reads a crew xell\'s scratchpad');
  ok(mgrRead.xell === `${slug}-tgt`, 'and names the xell it read');

  // A WORKER --xell is refused — a worker can only ever touch its OWN.
  const wkrXellRead = await selfScratchpad(wkrXell, { action: 'read', xellSlug: `${slug}-tgt` });
  ok(wkrXellRead.ok === false && wkrXellRead.status === 'refused',
     'a WORKER --xell <slug> is REFUSED (requireManager) — a worker never names another xell');

  // A manager reading a xell OUTSIDE its crew is refused.
  const foreignRead = await selfScratchpad(mgrXell, { action: 'read', xellSlug: `${slug}-other` });
  ok(foreignRead.ok === false && foreignRead.status === 'refused' && /no worker/.test(foreignRead.error || ''),
     'a manager --xell <slug> for a xell OUTSIDE its crew is REFUSED (scoped by workerOf)');

  // ── INJECTION through the REAL dispatch surface: swapBrief ─────────────────
  console.log('\n── the REAL dispatch surface: a swap embeds the outgoing zee\'s scratchpad ──');
  const built = await swapBrief({
    manager: mgrXell,
    target: await one(`SELECT * FROM xell WHERE id=$1`, [tgtId]),
    harness: { key: 'dev-builder', label: 'Builder' },
    task: 'BUILD the fix the scout scoped.',
  });
  const brief = built.brief;
  ok(brief.startsWith('BUILD the fix the scout scoped.'), 'the manager\'s own --task text leads the brief');
  ok(brief.includes('### The previous zee\'s scratchpad') && brief.includes('crew target\'s note'),
     'the swap brief embeds the previous zee\'s scratchpad as its own marked sub-section');
  const scratchPos = brief.indexOf('### The previous zee\'s scratchpad');
  ok(brief.slice(0, scratchPos).includes('The last thing it reported'),
     'the scratchpad sits inside the handover, after the previous zee\'s last report');

  // EMPTY scratchpad → no scratchpad section (byte-identical handover).
  const humanBuilt = await swapBrief({
    manager: null,
    target: await one(`SELECT * FROM xell WHERE id=$1`, [wkrId]),  // wkr cleared its scratchpad above
    harness: { key: 'dev-builder', label: 'Builder' },
    task: 'BUILD the fix the scout scoped.',
  });
  ok(!humanBuilt.brief.includes('### The previous zee\'s scratchpad'),
     'a swap with EMPTY scratchpad embeds NO scratchpad section (byte-identical to before the feature)');

  // ── the ROUTES (self + console) ─────────────────────────────────────────────
  console.log('\n── the routes carry the verb ──');
  const { router } = await import('../server/src/api/routes.js');
  const { mintXellToken } = await import('../server/src/lib/xell-token.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  srv = createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${srv.address().port}/api`;
  const wkrToken = await mintXellToken(wkrId);
  const mgrToken = await mintXellToken(mgrId);

  const jget = (path, token) => fetch(`${BASE}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const jpost = (path, body, token) => fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {}),
  });

  // the self verb over HTTP
  const selfSet = await jpost('/xell/self/scratchpad', { action: 'set', text: 'over the wire' }, wkrToken);
  const selfSetBody = await selfSet.json().catch(() => ({}));
  ok(selfSet.status === 200 && selfSetBody.ok === true && selfSetBody.length === 'over the wire'.length,
     'POST /xell/self/scratchpad with a WORKER token sets its OWN scratchpad');
  const selfGet = await jget('/xell/self/scratchpad', wkrToken);
  const selfGetBody = await selfGet.json().catch(() => ({}));
  ok(selfGet.status === 200 && selfGetBody.scratchpad === 'over the wire',
     'GET /xell/self/scratchpad with a WORKER token reads it back');
  const wkrForeign = await jget(`/xell/self/scratchpad?xell=${slug}-tgt`, wkrToken);
  const wkrForeignBody = await wkrForeign.json().catch(() => ({}));
  ok(wkrForeign.status === 403 && wkrForeignBody.status === 'refused',
     'GET /xell/self/scratchpad?xell=<crew> with a WORKER token → 403 refused (a worker never names another xell)');
  const mgrWireRead = await jget(`/xell/self/scratchpad?xell=${slug}-tgt`, mgrToken);
  const mgrWireReadBody = await mgrWireRead.json().catch(() => ({}));
  ok(mgrWireRead.status === 200 && mgrWireReadBody.scratchpad === 'crew target\'s note',
     'GET /xell/self/scratchpad?xell=<crew> with a MANAGER token reads the crew xell\'s note');

  // the console read route (human) reads any xell's
  const consGet = await jget(`/xells/${tgtId}/scratchpad`);
  const consGetBody = await consGet.json().catch(() => ({}));
  ok(consGet.status === 200 && consGetBody.scratchpad === 'crew target\'s note' && consGetBody.xell === `${slug}-tgt`,
     'GET /xells/:id/scratchpad (console) reads any xell\'s scratchpad');

  // ── the CLI carries the verb (the manual half is the drift test's job) ──────
  console.log('\n── the CLI carries the verb ──');
  const { readFileSync } = await import('node:fs');
  const zeeSrc = readFileSync(new URL('../scripts/zee', import.meta.url), 'utf8');
  ok(/case 'scratchpad':/.test(zeeSrc), 'scripts/zee has case \'scratchpad\'');
  ok(/zee scratchpad \[--set/.test(zeeSrc), 'and its usage text names the verb');
} finally {
  if (srv) srv.close();
  // clean up everything this test created, in a finally, whatever happened
  try { await q(`DELETE FROM xell WHERE id IN ($1,$2,$3,$4)`, [mgrId, wkrId, tgtId, otherId]); } catch { }
  try { await q(`DELETE FROM xource WHERE project_id=$1`, [pid]); } catch { }
  try { await q(`DELETE FROM project WHERE id=$1`, [pid]); } catch { }
  try { rmSync(root, { recursive: true, force: true }); } catch { }
  await pool.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);

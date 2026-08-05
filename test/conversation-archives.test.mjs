// CONVERSATION ARCHIVES — the zee's session transcript, archived to the queenzee and reviewed.
//
// The feature (migration 112 + lib/conversations.js + the self verbs):
//   • `zee upload-conversation` — a zee reads its own session transcript inside the cxell and
//     POSTs it; the server parses the JSONL and stores a xell_conversation row (lib/conversations.js).
//   • "upload conversations on done" — a harness checkbox; when a wearer proposes `zee done` the
//     queenzee ALSO archives the conversation (best-effort, never blocking the proposal).
//   • "enable reflection" — a harness checkbox; the ship gate only runs the post-ship reflection
//     pass when the shipping zee's harness has it ON (default ON, preserving the old behaviour).
//   • `zee conversations` (MANAGER only) — review the archives of the crew a manager dispatched,
//     scoped from the token exactly like every other crew verb.
//
// What this file covers:
//   A. parseTranscript — JSONL → events/title/line-count, malformed lines degrade to `raw`.
//   B. upload + scoping — the verb path stores a row; a worker is refused the review verb; a
//      manager sees ONLY the archives of xells it dispatched.
//   C. selfDone's upload-on-done hook — when the harness asks for it, the archive is attempted
//      BEFORE the proposal, and a failed archive (no docker in a nested queenzee) is reported on
//      the done response, never fatal.
//   D. harness settings round-trip through updateHarness / getHarnessFull.
//
// Everything it creates is torn down in a finally (house rule 1: no test data).
import { randomUUID } from 'node:crypto';
import { q, one, pool } from '../server/src/db/pool.js';
import { parseTranscript, uploadConversationArchive, conversationsForManager, harnessArchivalSettings } from '../server/src/lib/conversations.js';
import { selfDone } from '../server/src/queenzee/self.js';
import { updateHarness, getHarnessFull } from '../server/src/lib/harness.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// ── A. parseTranscript ────────────────────────────────────────────────────────
console.log('\n── A. parsing the JSONL transcript ──');
const sample = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
  JSON.stringify({ type: 'custom-title', customTitle: 'My Conv', sessionId: 'abc' }),
  'not-json-line',
].join('\n');
const p = parseTranscript(sample);
ok(p.lineCount === 3, `counts 3 lines (got ${p.lineCount})`);
ok(p.title === 'My Conv', `title parsed from custom-title (got ${p.title})`);
ok(p.events[2]?.type === 'raw', 'a malformed line degrades to a raw event, not a lost archive');
ok(p.byteCount > 0, `byteCount ${p.byteCount}`);

// ── B/C/D fixtures ───────────────────────────────────────────────────────────
const slug = `conv-test-${randomUUID().slice(0, 8)}`;
let proj, harness, xell, mgr;
try {
  proj = await one(`SELECT id FROM project ORDER BY created_at LIMIT 1`);
  harness = await one(
    `INSERT INTO harness (key, label, zee_type, project_id, bundle, upload_conversations_on_done, enable_reflection)
     VALUES ($1, $2, 'worker', $3, '{}'::jsonb, true, true) RETURNING *`,
    [`${slug}-h`, `${slug} h`, proj.id]);
  xell = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status, harness_id)
     SELECT $1, (SELECT id FROM xource WHERE project_id=$1 LIMIT 1), $2, $3, 'claimed', $4
     RETURNING *`, [proj.id, slug, `spinoff/${slug}`, harness.id]);
  mgr = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status, zee_type)
     SELECT $1, (SELECT id FROM xource WHERE project_id=$1 LIMIT 1), $2, $3, 'claimed', 'manager'
     RETURNING *`, [proj.id, `${slug}-mgr`, `spinoff/${slug}-mgr`]);

  // ── B. upload + scoping ────────────────────────────────────────────────────
  console.log('\n── B. upload, and the manager\'s scoped review ──');
  const set = await harnessArchivalSettings(xell);
  ok(set.upload_conversations_on_done === true, `harness settings read upload_on_done=true (got ${set.upload_conversations_on_done})`);
  ok(set.enable_reflection === true, 'harness settings read enable_reflection=true');
  // A xell with NO harness keeps reflection ON (the pre-112 behaviour) and upload OFF (opt-in).
  const bare = await harnessArchivalSettings({ id: xell.id, harness_id: null });
  ok(bare.upload_conversations_on_done === false && bare.enable_reflection === true,
     'no harness → upload off, reflection on (preserves the always-on reflection)');

  const up = await uploadConversationArchive(xell, { content: sample, sessionId: 'abc', title: 'My Conv', uploadedBy: 'verb' });
  ok(up.ok === true && up.line_count === 3, `verb upload stores the row (${JSON.stringify(up).slice(0, 90)})`);

  ok((await conversationsForManager(xell, {})).ok === false, 'a worker is refused the review verb');
  ok((await conversationsForManager(mgr, {})).ok === true, 'a manager may review (its crew)');

  await q(`UPDATE xell SET manager_xell_id=$1 WHERE id=$2`, [mgr.id, xell.id]);
  const listed = await conversationsForManager(mgr, {});
  ok(listed.count === 1 && listed.conversations[0].xell === slug, `manager sees exactly its worker's archive (${listed.count})`);
  const full = await conversationsForManager(mgr, { xell: slug, full: true });
  ok(full.conversations[0]?.content === sample, '--full returns the transcript');

  // ── C. selfDone's upload-on-done hook ──────────────────────────────────────
  console.log('\n── C. upload-on-done (best-effort, never fatal) ──');
  const res = await selfDone(xell, { summary: 'test done' });
  ok(res.status === 'awaiting-done', 'the done proposal still succeeds');
  // In a NESTED queenzee there is no docker, so the cxell read fails — but it is CAUGHT, reported
  // on the response, and never throws. (In production the queenzee has docker and reads the
  // transcript from the cxell; the failure shape is the same — reported, not fatal.)
  ok(res.conversation_upload && res.conversation_upload.ok === false,
     `the archive attempt is reported, not thrown (${res.conversation_upload?.error?.slice(0, 60) || 'n/a'})`);
  await q(`UPDATE xell SET status='claimed' WHERE id=$1`, [xell.id]);

  // ── D. harness settings round-trip ─────────────────────────────────────────
  console.log('\n── D. harness settings round-trip ──');
  const saved = await updateHarness(harness.key, { upload_conversations_on_done: false, enable_reflection: false });
  ok(saved.upload_conversations_on_done === false && saved.enable_reflection === false,
     `updateHarness writes both settings (${saved.upload_conversations_on_done}/${saved.enable_reflection})`);
  // The reflection gate reads the SAME resolved value the ship gate consults.
  const off = await harnessArchivalSettings(xell);
  ok(off.upload_conversations_on_done === false && off.enable_reflection === false,
     'after the save, a wearer resolves upload-off + reflection-off');
  const read = await getHarnessFull(harness.key);
  ok(read.upload_conversations_on_done === false && read.enable_reflection === false,
     'getHarnessFull returns both settings');
} finally {
  // ── cleanup (house rule 1) ─────────────────────────────────────────────────
  if (xell) await q(`DELETE FROM xell_conversation WHERE xell_id=$1`, [xell.id]).catch(() => {});
  if (mgr) await q(`DELETE FROM xell WHERE id=$1`, [mgr.id]).catch(() => {});
  if (xell) await q(`DELETE FROM xell WHERE id=$1`, [xell.id]).catch(() => {});
  if (harness) await q(`DELETE FROM harness WHERE id=$1`, [harness.id]).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);

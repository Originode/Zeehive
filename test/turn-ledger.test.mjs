// TURN LEDGER — the per-turn observability grain behind the xell observability UI
// (server/src/lib/turn-ledger.js, migration 153, GET /xells/:id/observability).
//
// What this file covers:
//   A. lastAssistantText — the pure "what did the turn say" summariser, no DB.
//   A2. classifyAssistantEvent — the pure thinking-vs-conversation classifier the mobile
//      chat's captured conversation rides on (no DB).
//   B. The SQL round-trip — startTurn → endTurn → turnsForXell → eventsForTurn against
//      DATABASE_URL with a throwaway project/xell/zee, torn down in a `finally` whatever
//      happens (house rule 1: no test data).
//   B2. recordFeedEvent → conversationForXell — an assistant event captured via the feed
//      classifier is read back as the zee's conversation/thinking (the /xells/:id/conversation
//      read model the mobile chat renders).
import { randomUUID } from 'node:crypto';
import { q, one, pool } from '../server/src/db/pool.js';
import { startTurn, endTurn, turnsForXell, eventsForTurn, lastAssistantText,
         classifyAssistantEvent, recordFeedEvent, conversationForXell } from '../server/src/lib/turn-ledger.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// ── A. lastAssistantText (pure) ───────────────────────────────────────────────────────────────
console.log('\n── A. lastAssistantText — what a turn said ──');
eq(lastAssistantText(null), null, 'null msg → null');
eq(lastAssistantText('plain'), 'plain', 'a plain string is returned bounded');
eq(lastAssistantText({ result: 'done' }), 'done', 'a result string is returned');
eq(lastAssistantText({ message: { content: [{ type: 'tool_use', name: 'Bash' }] } }), null,
   'a tool_use-only turn has no text summary');
eq(lastAssistantText({ message: { content: [
  { type: 'tool_use', name: 'Bash' },
  { type: 'text', text: 'Implemented the feature' },
] } }), 'Implemented the feature', 'the LAST text block wins');
eq(lastAssistantText({ message: { content: [{ type: 'text', text: 'x'.repeat(800) }] } }).length, 500,
   'the summary is bounded to 500 chars');

// ── A2. classifyAssistantEvent — the thinking vs conversation classifier (pure) ───────────────
console.log('\n── A2. classifyAssistantEvent — conversation vs thinking vs tools ──');
eq(JSON.stringify(classifyAssistantEvent(null)), '{"conversation":[],"thinking":[],"tools":[]}', 'null event → empty buckets');
eq(JSON.stringify(classifyAssistantEvent({ type: 'tool_use', name: 'Bash' })), '{"conversation":[],"thinking":[],"tools":[]}',
   'a non-assistant event → empty buckets');
const cls = classifyAssistantEvent({ type: 'assistant', message: { content: [
  { type: 'thinking', thinking: 'first, reason' },
  { type: 'redacted_thinking', data: '[hidden reasoning]' },
  { type: 'text', text: 'Hello, I will do it.' },
  { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
] } });
eq(cls.conversation.length, 1, 'one conversation text block');
eq(cls.conversation[0], 'Hello, I will do it.', 'the text block IS the conversation');
eq(cls.thinking.length, 2, 'thinking + redacted_thinking both captured');
ok(cls.thinking[1].includes('hidden'), 'redacted thinking captured');
eq(cls.tools.length, 1, 'the tool_use is captured separately');
eq(cls.tools[0].name, 'Bash', 'the tool name is captured');
// A string content (a provider collapsed the blocks) is ALL conversation.
eq(classifyAssistantEvent({ type: 'assistant', message: { content: 'plain text reply' } }).conversation[0],
   'plain text reply', 'a string content block is conversation');
// Whitespace-only blocks are skipped — never empty bubbles.
eq(classifyAssistantEvent({ type: 'assistant', message: { content: [{ type: 'text', text: '  ' }] } }).conversation.length, 0,
   'whitespace-only text is skipped');

// ── B. SQL round-trip ─────────────────────────────────────────────────────────────────────────
console.log('\n── B. the turn ledger round-trip (start → end → read) ──');
let projectId = null, xourceId = null, xellId = null, zeeId = null;
try {
  const name = 'turn-ledger-' + randomUUID().slice(0, 8);
  const proj = await one(
    `INSERT INTO project (name, repo_root) VALUES ($1, $2) RETURNING id`,
    [name, `/tmp/${name}`]);
  projectId = proj.id;
  const xo = await one(
    `INSERT INTO xource (project_id, ref) VALUES ($1, 'refs/heads/main') RETURNING id`,
    [projectId]);
  xourceId = xo.id;
  const xl = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status)
     VALUES ($1, $2, $3, $4, $5, 'claimed') RETURNING id`,
    [projectId, xourceId, name, `spinoff/${name}`, `/tmp/${name}-wt`]);
  xellId = xl.id;
  const z = await one(
    `INSERT INTO zee (xell_id, attach_mode, viewer_kind, status, kind, entrypoint, model)
     VALUES ($1, 'headless-spawn', 'none', 'idle', 'headless', 'cxell-cli', 'opus') RETURNING id`,
    [xellId]);
  zeeId = z.id;

  // start a spawn turn
  const turn = await startTurn({ zee: { id: zeeId, xell_id: xellId }, xell: { id: xellId, project_id: projectId },
                                 kind: 'spawn', model: 'opus', meta: { mode: '5' } });
  ok(!!turn?.id, 'startTurn returns a row');
  eq(turn?.kind, 'spawn', 'kind is spawn');
  eq(turn?.status, 'started', 'new turn is started');
  eq(turn?.xell_id, xellId, 'xell_id rides along');
  eq(turn?.project_id, projectId, 'project_id rides along');

  // end it with a burn
  const ended = await endTurn(turn.id, {
    status: 'ended',
    burn: { cost: 0.0123, input: 100, output: 50, cacheRead: 20, cacheWrite: 5, metered: true },
    stopReason: 'end_turn', summary: 'Implemented the feature',
  });
  eq(ended?.status, 'ended', 'endTurn writes status');
  eq(Number(ended?.cost_usd), 0.0123, 'endTurn writes the turn cost');
  eq(Number(ended?.input_tokens), 100, 'endTurn writes input tokens');
  eq(ended?.summary, 'Implemented the feature', 'endTurn writes the summary');
  ok(!!ended?.ended_at, 'endTurn stamps ended_at');

  // read it back
  const turns = await turnsForXell(xellId);
  eq(turns.length, 1, 'turnsForXell finds the turn');
  eq(turns[0]?.id, turn.id, 'the right turn comes back first');

  // play-by-play attribution
  await q(
    `INSERT INTO session_event (source, hook_event_name, zee_id, xell_id, turn_id, raw)
     VALUES ('cxell-feed', 'assistant', $1, $2, $3, $4)`,
    [zeeId, xellId, turn.id, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } })]);
  const evs = await eventsForTurn(turn.id);
  eq(evs.length, 1, 'eventsForTurn finds the attributed event');
  eq(evs[0]?.turn_id, turn.id, 'the event carries the turn_id');
  eq(evs[0]?.hook_event_name, 'assistant', 'the event type is preserved');

  // ── B2. recordFeedEvent → conversationForXell — the captured conversation read model ─────────
  console.log('\n── B2. recordFeedEvent → conversationForXell (the mobile chat conversation) ──');
  // The event carries BOTH thinking and conversation blocks — recordFeedEvent must classify at
  // CAPTURE time (raw.capture) and conversationForXell must read the classification back.
  const rec = await recordFeedEvent({
    turnId: turn.id, zeeId, xellId,
    event: { type: 'assistant', message: { content: [
      { type: 'thinking', thinking: 'step one internally' },
      { type: 'text', text: 'I deployed the zee.' },
    ] } },
  });
  ok(!!rec, 'recordFeedEvent writes the event');
  const convo = await conversationForXell(xellId, { limit: 20 });
  const convoItem = convo.find((c) => c.text === 'I deployed the zee.');
  const thinkItem = convo.find((c) => c.text === 'step one internally');
  ok(!!convoItem, 'conversationForXell returns the conversation text');
  eq(convoItem?.kind, 'conversation', 'the text block is classified as conversation');
  ok(!!thinkItem, 'conversationForXell returns the thinking stream');
  eq(thinkItem?.kind, 'thinking', 'the thinking block is classified as thinking');
  eq(thinkItem?.turn_id, turn.id, 'the captured item carries the turn attribution');
  // The persisted raw carries the classification (capture-time enrichment).
  const enriched = await one(
    `SELECT raw FROM session_event WHERE xell_id=$1 AND hook_event_name='assistant' ORDER BY ts DESC LIMIT 1`,
    [xellId]);
  eq(enriched?.raw?.capture?.conversation?.[0], 'I deployed the zee.', 'recordFeedEvent enriches raw.capture at write time');
  eq(enriched?.raw?.capture?.thinking?.[0], 'step one internally', 'recordFeedEvent captures the thinking stream');

  // endTurn on a missing id is a no-op, not a throw
  const noop = await endTurn(null, { status: 'ended' });
  eq(noop, null, 'endTurn(null) returns null (never throws)');

  console.log(`\n${fail ? fail + ' FAILED' : 'all good'}`);
} finally {
  if (zeeId) await q(`DELETE FROM zee WHERE id=$1`, [zeeId]).catch(() => {});
  if (xellId) await q(`DELETE FROM xell WHERE id=$1`, [xellId]).catch(() => {});
  if (xourceId) await q(`DELETE FROM xource WHERE id=$1`, [xourceId]).catch(() => {});
  if (projectId) await q(`DELETE FROM project WHERE id=$1`, [projectId]).catch(() => {});
  await pool.end();
}
process.exit(fail ? 1 : 0);

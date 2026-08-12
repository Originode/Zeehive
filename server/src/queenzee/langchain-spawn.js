// THE LANGCHAIN ZEE SPAWN — a real zee driven by the langchain driver (docs/langchain-stateful-zees.md).
//
// This is the "deploy zees via langchain" seam: the dispatch path routes a runtime whose
// agent_runtime.driver='langchain' here instead of to a vendor CLI in a cxell. It creates the zee
// row, claims the xell, starts the turn, drives the langchain agent turn (docs §8.3.1: the tool LOOP
// in-process, bound ONLY to the wave-1 read/report verbs in langchain-tools.js — status/work/
// working/item), persists the conversation (so the NEXT zee on this xell starts warm), ends the
// turn, and returns the same { ok, zee_id, xell_id, session, mode, permission_mode } contract the
// other spawn paths return.
//
// CONFINEMENT. The tool LIST is the confinement, and it is the wave-1 read/report registry only —
// the manager's ruling (2026-08-11): an in-process loop bound to four read-only verbs cannot do
// anything a single in-process model call cannot already do; it just does it more than once.
// Workspace-action tools (bash/file/SQL/docker/git) and the gated asks (land/ship/seed — wave 2,
// after wave 1 is green AND a test shows a bound `land` producing a HELD request) are NOT in the
// registry, so the loop cannot reach them.
import { q, one } from '../db/pool.js';
import { broadcast } from '../lib/events.js';
import { logline } from '../lib/logbus.js';
import { startTurn, endTurn, recordFeedEvent } from '../lib/turn-ledger.js';
import { mintXellToken } from '../lib/xell-token.js';
import { spawnCreds, scrubSecrets } from '../lib/provider-tokens.js';
import { runLangchainAgentTurn } from '../lib/langchain-zee.js';

export async function spawnLangchainZee({ pid, xell, task, rt, model = null, m = null, title = null,
                                          headless = true, provider = 'claude', providerTokenId = null } = {}) {
  // Credentials first — a project with no connected account for this provider must fail cleanly
  // before anything claims the xell (same contract as spawnCxell).
  const { token, accountLabel } = await spawnCreds(pid, provider, { tokenId: providerTokenId });
  if (accountLabel) logline('langchain', `dispatching a langchain zee on the "${accountLabel}" ${provider} account`);

  const ranModel = model;
  const zeeTitle = title || `xell : ${xell.slug}`;
  const zee = await one(
    `INSERT INTO zee (xell_id, attach_mode, runtime_id, viewer_kind, status, kind, entrypoint,
                      model, permission_mode, cwd, title)
     VALUES ($1,'headless-spawn',$2,'none','working','headless','langchain',$3,'bypassPermissions',$4,$5)
     RETURNING *`,
    [xell.id, rt?.id || null, ranModel, '/work/repo', zeeTitle]);
  await one(`UPDATE xell SET status='claimed', is_pooled=false WHERE id=$1`, [xell.id]);
  broadcast('zee', zee);

  // The per-xell identity token for the gateway path (/x/<token>/<provider>). Re-minted here
  // because the server stores only the hash; a langchain zee has no cxell to have been given it.
  const xellToken = await mintXellToken(xell.id);
  const turn = await startTurn({ zee, xell, kind: 'spawn', model: ranModel, meta: { mode: m?.key || null },
                                 executionId: xell.execution_id });
  const sid = String(zee.id).slice(0, 8);

  const feed = (ev) => {
    if (turn?.id) void recordFeedEvent({ turnId: turn.id, zeeId: zee.id, xellId: xell.id, event: ev, sessionId: sid });
    broadcast('zee-output', { zee_id: zee.id, xell_id: xell.id, slug: xell.slug, event: ev });
  };

  try {
    // The init event (what the SSE feed uses to learn the session id), then the assistant + result.
    await q(`UPDATE zee SET claude_session_id=$2, session_name=$2, status='working', attached_at=now() WHERE id=$1`,
            [zee.id, sid]);
    broadcast('zee', await one(`SELECT * FROM zee WHERE id=$1`, [zee.id]));
    feed({ type: 'system', subtype: 'init', session_id: sid });

    const res = await runLangchainAgentTurn({
      xell, task, provider, model: ranModel, apiKey: token, xellToken,
      // Feed the play-by-play: each assistant message (with any tool_calls) as an `assistant` event,
      // each executed tool as a `tool_use` block, and the final response as the `result`. The same
      // SSE/feed contract the CLI path produces — a human replays the loop turn by turn.
      onAssistant: (msg) => {
        const content = [];
        for (const b of msg?.content || []) {
          if (b?.type === 'text' && b.text) content.push({ type: 'text', text: b.text });
          if (b?.type === 'tool_use') content.push({ type: 'tool_use', name: b.name, input: b.input });
        }
        if (content.length) feed({ type: 'assistant', message: { content } });
      },
      onTool: ({ name, args }) => feed({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input: args }] } }),
    });
    const text = res.text || '';
    // A turn that ended because the zee raised a tend (asked a human something) is a REAL stop with
    // its own reason — the zee is waiting to be resumed, not finished. Everything else is end_turn.
    const stopReason = res.endedForHuman ? 'asked-human' : 'end_turn';
    feed({ type: 'result', is_error: false, result: text, usage: res.usage, tool_calls: res.executed, stop_reason: stopReason });

    const b = res.usage || { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, metered: false };
    await q(
      `UPDATE zee SET status='idle', cost_usd=$2, input_tokens=$3, output_tokens=$4,
                      cache_read_tokens=$5, cache_write_tokens=$6, last_stop_reason=$7
        WHERE id=$1`,
      [zee.id, 0, b.input || 0, b.output || 0, b.cacheRead || 0, b.cacheWrite || 0, stopReason]);
    broadcast('zee', await one(`SELECT * FROM zee WHERE id=$1`, [zee.id]));
    await endTurn(turn?.id, { status: 'ended', burn: b, stopReason, summary: text.slice(0, 500) });
    logline('langchain', `langchain zee in ${xell.slug} finished ok (${(b.input || 0) + (b.output || 0)} tok, ${stopReason})`);
    return { ok: true, zee_id: zee.id, xell_id: xell.id, cxell: null, session: sid,
             mode: m?.key, permission_mode: 'bypassPermissions', langchain: true };
  } catch (err) {
    const reason = scrubSecrets(String(err.message)).slice(0, 200);
    await q(`UPDATE zee SET status='errored', last_stop_reason=$2 WHERE id=$1`, [zee.id, reason]);
    broadcast('zee', await one(`SELECT * FROM zee WHERE id=$1`, [zee.id]));
    await endTurn(turn?.id, { status: 'errored', burn: null, stopReason: String(err.message).slice(0, 200) });
    logline('langchain', `langchain zee in ${xell.slug} errored: ${reason}`);
    return { ok: false, zee_id: zee.id, xell_id: xell.id, error: String(err.message).slice(0, 300) };
  }
}

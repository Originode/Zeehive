// THE LANGCHAIN ZEE SPAWN — a real zee driven by the langchain driver (docs/langchain-stateful-zees.md).
//
// This is the "deploy zees via langchain" seam: the dispatch path routes a runtime whose
// agent_runtime.driver='langchain' here instead of to a vendor CLI in a cxell. It creates the zee
// row, claims the xell, starts the turn, runs ONE langchain model call through the gateway, persists
// the conversation (so the NEXT zee on this xell starts warm), ends the turn, and returns the same
// { ok, zee_id, xell_id, session, mode, permission_mode } contract the other spawn paths return.
//
// CONFINEMENT. A single model call with no tools needs no cage, so this runs in the queenzee
// process. Tool execution (the next card) must move the agent loop inside the cxell; the design doc
// names that explicitly. Until then a langchain zee's "work" is exactly one model call.
import { q, one } from '../db/pool.js';
import { broadcast } from '../lib/events.js';
import { logline } from '../lib/logbus.js';
import { startTurn, endTurn, recordFeedEvent } from '../lib/turn-ledger.js';
import { mintXellToken } from '../lib/xell-token.js';
import { spawnCreds, scrubSecrets } from '../lib/provider-tokens.js';
import { runLangchainTurn } from '../lib/langchain-zee.js';

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

    const res = await runLangchainTurn({ xell, task, provider, model: ranModel, apiKey: token, xellToken });
    const text = res.text || '';
    feed({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    feed({ type: 'result', is_error: false, result: text, usage: res.usage });

    const b = res.usage || { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, metered: false };
    await q(
      `UPDATE zee SET status='idle', cost_usd=$2, input_tokens=$3, output_tokens=$4,
                      cache_read_tokens=$5, cache_write_tokens=$6, last_stop_reason='end_turn'
        WHERE id=$1`,
      [zee.id, 0, b.input || 0, b.output || 0, b.cacheRead || 0, b.cacheWrite || 0]);
    broadcast('zee', await one(`SELECT * FROM zee WHERE id=$1`, [zee.id]));
    await endTurn(turn?.id, { status: 'ended', burn: b, stopReason: 'end_turn', summary: text.slice(0, 500) });
    logline('langchain', `langchain zee in ${xell.slug} finished ok (${(b.input || 0) + (b.output || 0)} tok)`);
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

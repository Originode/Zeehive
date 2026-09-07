// THE MEDIC DRIVER — a medic turn, run on the QUEENZEE'S OWN PLANE (docs/medic-meta-plane-plan.md
// §2/§4, DR-7; provision-proof kit stage 4).
//
// The mirror of langchain-spawn.js, minus the environment. A caged spawn claims a xell, mints a
// worktree, starts containers, and briefs a zee inside them; this one does NONE of that — the
// directive, verbatim: "a medic is not to be deployed in a xell." What survives is everything that
// makes an agent ACCOUNTABLE rather than merely confined:
//
//   • a real zee row (245: keyed by medic_id, xell_id NULL) — so the medic has a stop reason, a
//     burn, a status, and shows up in every zee-shaped read model;
//   • a real zee_turn (turn-ledger) — so the turn has a start, an end and a summary;
//   • a real gateway identity token (medics.mintMedicToken) — so every model call lands in
//     llm_gateway_request with medic_id (247), priced like everyone else's;
//   • the same feed events (`zee-output`) the CLI path emits — so the Medic Bay replays the loop
//     turn by turn with the console's existing transcript component.
//
// What is DIFFERENT is the confinement: no cage, so the walls are the MEDIC REGISTRY
// (lib/medic-tools.js — no bash, no file write, no docker), the MEDIC ROLE (lib/medic-role.js —
// postgres refuses what the config surface does not name) and the remaining HUMAN GATES (a host
// mutation is still a card; Zeehive CODE is still a dispatched worker crossing land/ship).
import { q, one } from '../db/pool.js';
import { broadcast } from '../lib/events.js';
import { logline } from '../lib/logbus.js';
import { startTurn, endTurn, recordFeedEvent } from '../lib/turn-ledger.js';
import { spawnCreds, scrubSecrets, dispatchProviderFor } from '../lib/provider-tokens.js';
import { runLangchainAgentTurn } from '../lib/langchain-zee.js';
import { MEDIC_TOOLS, runMedicTool } from '../lib/medic-tools.js';
import { createMedic, mintMedicToken, updateMedicStatus, composeMedicSystemPrompt,
         buildMedicPlaneBrief } from '../lib/medics.js';
import { selfProjectId } from '../lib/infra-medic.js';

// The medic's model calls are billed to the ORCHESTRATOR'S OWN project, never the patient's: a
// medic is Zeehive's organ attending someone else's project, and charging its diagnosis to the
// project that is already broken would be the wrong ledger.
async function medicCreds({ provider = null, model = null } = {}) {
  const pid = await selfProjectId();
  // needsApiKey: the medic loop is langchain against the raw provider API, where a Claude OAuth
  // (Claude Code CLI) account cannot authenticate — the decision must skip those or the medic's
  // first model call 401s and the medic errors before its first tool runs.
  const decided = provider ? { provider } : await dispatchProviderFor(pid, { claudeNeedsNoToken: false, needsApiKey: true });
  const p = decided.provider || 'claude';
  const creds = await spawnCreds(pid, p);
  if (/^sk-ant-oat/.test(String(creds.token || ''))) {
    throw new Error(`the ${p} account "${creds.accountLabel || '?'}" is a Claude OAuth (CLI) token — `
      + 'the medic plane calls the raw API and cannot authenticate with it. Connect an API-key '
      + 'account (sk-ant-api…) or another provider (e.g. DeepSeek) to the orchestrator project.');
  }
  // The model default is per-provider, same rule as cxell-runtimes' deepseekModel: a null model on
  // deepseek's Anthropic-compatible endpoint would send langchain's own claude default, which
  // deepseek does not serve.
  const m = model || (p === 'deepseek' ? (process.env.DEEPSEEK_DEFAULT_MODEL || 'deepseek-chat') : null);
  return { projectId: pid, provider: p, model: m, ...creds };
}

// The medic's own tool budget. The loop's default cap (MAX_TOOL_ITERATIONS = 8) fits a wave-1 zee
// turn (a status call, an item update); a medic turn IS the diagnosis — its own brief orders
// "read the evidence first (readiness, settings, meta_select on the exact rows…), fix, re-prove,
// delete the condition, report", which is easily dozens of tool calls. At 8, every dispatched
// medic stopped mid-diagnosis with a visible capHit that NOTHING resumes (the driver runs turns
// only on dispatch and on a human's answer), i.e. it sat at 'acting' having done nothing — seen
// live on the first sandbox exercise, 2026-09-06. The cap stays a hard, visible stop; it is just
// sized for this plane's work.
export const MEDIC_MAX_TOOL_ITERATIONS = 40;

// Run ONE turn for an EXISTING medic row. Separate from dispatch below because a medic is RESUMED
// the same way it is started — a human answering an `awaiting-human` ask runs another turn against
// the same medic, whose conversation (245: zee_conversation keyed by medic_id) is already warm.
export async function runMedicTurn({ medic, task = null, provider = null, model = null,
                                      kind = 'spawn' } = {}) {
  if (!medic?.id) throw new Error('runMedicTurn needs the medic ROW — the identity comes from the turn');
  const creds = await medicCreds({ provider, model });
  model = creds.model ?? model;   // the per-provider default (medicCreds) — what the turn really runs
  const short = String(medic.id).slice(0, 8);

  // ONE ACTIVE ZEE PER MEDIC (245: one_active_zee_per_medic counts 'idle' as active). The driver
  // mints a fresh zee row per turn, and a finished turn parks its row at 'idle' — so the previous
  // turn's row must be CLOSED here or the insert below violates the index and every RESUME throws
  // before its turn starts (seen live 2026-09-06; it was masked before because the passive poller
  // wrongly stamped the row 'stopped' within a tick — fixed in poller.js the same day).
  await q(
    `UPDATE zee SET status='stopped',
            last_stop_reason=COALESCE(last_stop_reason, 'superseded by the next medic turn')
      WHERE medic_id=$1 AND status IN ('spawning','online','working','idle')`, [medic.id]);
  const zee = await one(
    `INSERT INTO zee (medic_id, attach_mode, runtime_id, viewer_kind, status, kind, entrypoint,
                      model, permission_mode, cwd, title, provider_token_id)
     VALUES ($1,'headless-spawn',NULL,'none','working','headless','medic',$2,'bypassPermissions',$3,$4,$5)
     RETURNING *`,
    [medic.id, model, null, `medic : ${short}`, creds.tokenId || null]);
  broadcast('zee', zee);

  // The gateway identity: re-minted per turn (the row stores only the hash), exactly the discipline
  // the xell token follows.
  const medicToken = await mintMedicToken(medic.id);
  const turn = await startTurn({ zee, xell: { id: null, project_id: medic.target_project_id },
                                 kind, model, meta: { medic_id: medic.id } });
  // The session id is the ZEE row's short id, not the medic's (langchain-spawn.js does the same):
  // zee.claude_session_id is globally UNIQUE, and a medic mints a zee row per turn — the medic's
  // short id repeats on every resume, which made the second turn die on zee_claude_session_id_key.
  const sid = String(zee.id).slice(0, 8);

  const feed = (ev) => {
    if (turn?.id) void recordFeedEvent({ turnId: turn.id, zeeId: zee.id, xellId: null, event: ev, sessionId: sid });
    // The Bay listens on the SAME channel the honeycomb does, with medic_id instead of xell_id —
    // one transcript component, two planes.
    broadcast('zee-output', { zee_id: zee.id, medic_id: medic.id, slug: `medic:${short}`, event: ev });
  };

  try {
    await q(`UPDATE zee SET claude_session_id=$2, session_name=$2, status='working', attached_at=now() WHERE id=$1`,
            [zee.id, sid]);
    broadcast('zee', await one(`SELECT * FROM zee WHERE id=$1`, [zee.id]));
    feed({ type: 'system', subtype: 'init', session_id: sid });

    const system = await composeMedicSystemPrompt();
    const res = await runLangchainAgentTurn({
      // THE SUBJECT IS THE MEDIC ROW — every tool's run() receives it, so the identity comes from
      // the turn and never from the model. The registry + dispatch path are the medic's own, and
      // the conversation is keyed by the medic (245), so a resumed medic starts warm on its own
      // history exactly as a swapped zee does on its xell's.
      xell: medic, task: task || medic.brief, provider: creds.provider, model,
      apiKey: creds.token, xellToken: medicToken, system,
      registry: MEDIC_TOOLS, runToolFn: runMedicTool, convKey: { medicId: medic.id },
      maxIterations: MEDIC_MAX_TOOL_ITERATIONS,
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
    const stopReason = res.endedForHuman ? 'asked-human' : 'end_turn';
    feed({ type: 'result', is_error: false, result: text, usage: res.usage, tool_calls: res.executed, stop_reason: stopReason });

    const b = res.usage || { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, metered: false };
    await q(
      `UPDATE zee SET status='idle', cost_usd=$2, input_tokens=$3, output_tokens=$4,
                      cache_read_tokens=$5, cache_write_tokens=$6, last_stop_reason=$7
        WHERE id=$1`,
      [zee.id, b.cost || 0, b.input || 0, b.output || 0, b.cacheRead || 0, b.cacheWrite || 0, stopReason]);
    broadcast('zee', await one(`SELECT * FROM zee WHERE id=$1`, [zee.id]));
    await endTurn(turn?.id, { status: 'ended', burn: b, stopReason, summary: text.slice(0, 500) });

    // The medic's own status is the MEDIC'S to report (report / need_human / dispatch_worker all
    // set it). The driver only fills the silence: a turn that ended with no status act at all is
    // still 'diagnosing', and leaving it there would show a live medic that nothing is driving.
    const now = await one(`SELECT status FROM medic WHERE id=$1`, [medic.id]);
    if (now?.status === 'diagnosing' && !res.endedForHuman) {
      await updateMedicStatus(medic.id, 'acting');
    }
    logline('medic', `medic ${short} turn ended (${(b.input || 0) + (b.output || 0)} tok, ${stopReason})`);
    return { ok: true, medic_id: medic.id, zee_id: zee.id, session: sid, stop_reason: stopReason,
             text, tool_calls: res.executed };
  } catch (err) {
    const reason = scrubSecrets(String(err.message)).slice(0, 200);
    await q(`UPDATE zee SET status='errored', last_stop_reason=$2 WHERE id=$1`, [zee.id, reason]);
    broadcast('zee', await one(`SELECT * FROM zee WHERE id=$1`, [zee.id]));
    await endTurn(turn?.id, { status: 'errored', burn: null, stopReason: reason });
    await updateMedicStatus(medic.id, 'errored').catch(() => {});
    logline('medic', `medic ${short} errored: ${reason}`);
    return { ok: false, medic_id: medic.id, zee_id: zee.id, error: String(err.message).slice(0, 300) };
  }
}

// THE DISPATCH SEAM'S META-PLANE HALF: create the medic row and run its first turn. Returns as soon
// as the row exists — the turn runs in the BACKGROUND, because the console's ⛑ button must answer
// immediately (the caged path returns the moment the xell is claimed, for the same reason) and a
// medic turn is minutes of model time.
export async function dispatchMedic({ condition = null, targetProjectId = null, task = null,
                                       provider = null, model = null, wait = false } = {}) {
  const projectId = targetProjectId || condition?.project_id;
  if (!projectId) throw new Error('a medic needs a TARGET project — the pair that is broken');
  const brief = task || buildMedicPlaneBrief(condition);
  const medic = await createMedic({ targetProjectId: projectId, conditionId: condition?.id || null, brief });

  const run = runMedicTurn({ medic, task: brief, provider, model })
    .catch((e) => {
      logline('medic', `medic ${String(medic.id).slice(0, 8)} first turn threw: ${String(e.message).slice(0, 200)}`);
      return updateMedicStatus(medic.id, 'errored').catch(() => null);
    });
  if (wait) await run;
  return { ok: true, plane: 'meta', medic_id: medic.id, target_project_id: projectId,
           status: 'dispatched' };
}

// A HUMAN ANSWERS A MEDIC (the Bay's reply box). The answer is simply the next turn's user message:
// the medic's conversation is keyed by the medic row (245), so it resumes warm — it does not need
// to be told again what it already found. The `awaiting-human` flag is cleared HERE, by the driver,
// and not by the medic: an agent that could clear its own "I need a human" could dissolve the
// question, which is the same refusal the caged loop's tend policy makes.
export async function resumeMedic(medicId, { message = null, provider = null, model = null,
                                              wait = false } = {}) {
  const medic = await one(`SELECT * FROM medic WHERE id=$1`, [medicId]);
  if (!medic) throw new Error('no such medic');
  if (medic.status === 'retired') throw new Error('this medic is retired — dispatch a fresh one from the condition');
  const text = String(message || '').trim();
  if (!text) throw new Error('a message is required — it becomes the medic\'s next turn');
  if (medic.status === 'awaiting-human') await updateMedicStatus(medic.id, 'acting');
  const task = `A human answers your ask${medic.needs_human_reason ? ` ("${medic.needs_human_reason}")` : ''}:\n\n${text}`;
  const run = runMedicTurn({ medic, task, provider, model, kind: 'resume' })
    .catch((e) => {
      logline('medic', `medic ${String(medic.id).slice(0, 8)} resume turn threw: ${String(e.message).slice(0, 200)}`);
      return updateMedicStatus(medic.id, 'errored').catch(() => null);
    });
  if (wait) await run;
  return { ok: true, medic_id: medic.id, resumed: true };
}

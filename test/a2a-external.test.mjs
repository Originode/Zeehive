// THE A2A EXTERNAL INTEROP — Phase P4 of the A2A adoption (docs/a2a-protocol-plan.md §3.4/§6,
// DR-6/DR-7) — the ONE-WAY DOOR.
//
// P4 ships the external surface: a project API key (`Bearer zhk_…`, migration 190's scheme) gains
// an `a2a` scope and may call the A2A routes (directory, per-agent card, GetTask/ListTasks/
// SendMessage) — seeing and addressing ONLY the agents its project owns, with task projections
// that are id-scrubbed exactly like the ticketing API's answers (lib/ticket-intake.js externalView:
// no xell ids, no tokens, no internal counts). Plus the outbound `zee a2a <card-url> --message`
// verb: QUEENZEE-mediated and RECORDED at the transport layer (a2a_outbound_request, migration
// 201) like the LLM gateway records its calls.
//
//   A. THE SCOPE (pure): the `a2a` scope exists in the SCOPES constant and is a legal scope.
//
//   B. THE EXTERNAL CALLER, against a throwaway project in DATABASE_URL (skipped when unset, like
//      the DB halves of the other a2a tests):
//      B1 authenticateApiKey admits a key WITH the a2a scope and refuses one without it (403).
//      B2 cardVisibleXellIds/taskVisibleXellIds for an external caller = its project's xells.
//      B3 directoryFor lists the project's agents — no xell ids, no tokens in the answer.
//      B4 agentCardFor serves a project agent's card — no xell ids, no tokens.
//      B5 GetTask/ListTasks through dispatchA2A return id-scrubbed tasks (no xell ids, no tokens).
//      B6 SendMessage from an external caller opens a task whose provenance is the project
//         (`ext:<project name>`), not a fabricated xell — and the message answer is id-scrubbed.
//      B7 a key without the a2a scope is refused 403 by authenticateApiKey.
//
//   C. THE OUTBOUND VERB, against a throwaway project in DATABASE_URL:
//      C1 sendExternalA2AMessage to a LOCAL mock A2A server returns the JSON-RPC result and
//         records the call in a2a_outbound_request (the transport-layer record, migration 201).
//      C2 a card fetch failure records the error on the same ledger row.
//
// The project is deleted in a finally, whatever happens (house rule: tests clean up what they create).
import { SCOPES, SCOPE_KEYS, createProjectApiKey, authenticateApiKey } from '../server/src/lib/project-api-keys.js';
import { createServer } from 'node:http';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const eq = (got, want, msg) => ok(got === want, `${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);

// The id-scrub assertion: a stringified A2A answer must contain NONE of the project's xell UUIDs
// and NONE of the caller's key material. "No xell ids, no tokens" is the whole P4 contract for
// external views (plan §3.4, DR-6) — the same shape as the ticketing API's externalView.
function scrubClean(str, { xellIds = [], keys = [] } = {}) {
  const hasId = xellIds.find((id) => id && str.includes(id));
  const hasKey = keys.find((k) => k && str.includes(k));
  return { hasId, hasKey };
}

console.log('\n── A. the a2a scope exists (pure) ──');
{
  ok(typeof SCOPES['a2a'] === 'string' && SCOPES['a2a'].length > 10,
     'A: the SCOPES constant defines an "a2a" scope with a description');
  ok(SCOPE_KEYS.includes('a2a'), 'A: "a2a" is a legal scope (checkScopes accepts it)');
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.log('\n── B/C. the external caller + outbound verb (SKIPPED — DATABASE_URL not set; use `zee db-sandbox --migrate`) ──');
} else {
  console.log('\n── B/C. against DATABASE_URL ──');
  const { q, one } = await import('../server/src/db/pool.js');
  const { postMessage } = await import('../server/src/lib/managers.js');
  const { externalCaller, cardVisibleXellIds, taskVisibleXellIds, directoryFor, agentCardFor,
          dispatchA2A, getTask } = await import('../server/src/lib/a2a-read.js');
  const { sendExternalA2AMessage, resolveAgentInterface } = await import('../server/src/lib/a2a-outbound.js');

  const tag = `a2ax-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
  let projectId = null;
  let mockServer = null;
  try {
    const proj = await one(
      `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'main') RETURNING id`,
      [`zt-${tag}`, `/tmp/${tag}`]);
    projectId = proj.id;
    const xource = await one(
      `INSERT INTO xource (project_id, ref, head_commit) VALUES ($1,'main','deadbeef') RETURNING id`,
      [projectId]);
    const mkXell = async (slug, zeeType, managerId = null) => (await one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, status, zee_type, manager_xell_id, head_commit)
         VALUES ($1,$2,$3,'spinoff/t','claimed',$4,$5,'abcdef1234567890') RETURNING *`,
      [projectId, xource.id, `${tag}-${slug}`, zeeType, managerId]));
    const manager = await mkXell('mgr', 'manager');
    const worker = await mkXell('wrk', 'worker', manager.id);
    const xellIds = [manager.id, worker.id];

    // The zhk_ key — minted with the a2a scope via the EXISTING API (no seed, no DDL).
    const keyRow = await createProjectApiKey(projectId, { label: 'a2a tester', scopes: ['a2a'] });
    const keyStr = keyRow.key;
    const auth = await authenticateApiKey(keyStr, { scope: 'a2a' });
    ok(auth.ok === true, `B1: a key WITH the a2a scope authenticates (hint ${auth.key?.hint})`);
    eq(auth.project.id, projectId, 'B1: …and resolves to ITS OWN project (never a payload)');
    const caller = externalCaller(auth);

    // A key WITHOUT the a2a scope → 403.
    const ticketKey = await createProjectApiKey(projectId, { label: 'tickets only', scopes: ['tickets:read'] });
    const noScope = await authenticateApiKey(ticketKey.key, { scope: 'a2a' });
    eq(noScope.ok, false, 'B7: a key without the a2a scope is refused');
    eq(noScope.status, 403, 'B7: …with 403 (a live key lacking the scope), not 401');
    ok(String(noScope.reason).includes('a2a'), 'B7: …and the reason names the missing scope');

    // ── B2. visibility = the project's own agents ──
    const cardVis = await cardVisibleXellIds(caller);
    ok(xellIds.every((id) => cardVis.has(id)), 'B2: an external caller may see every agent its project owns');
    const taskVis = await taskVisibleXellIds(caller);
    ok(xellIds.every((id) => taskVis.has(id)), 'B2: an external caller\'s task scope = the same project agents');

    // ── B3. the directory — id-scrubbed ──
    const dir = await directoryFor(caller, 'http://localhost:4800');
    ok(dir.agents.length === 2, `B3: the directory lists the project's 2 agents (got ${dir.agents.length})`);
    const dirText = JSON.stringify(dir);
    const dirLeak = scrubClean(dirText, { xellIds, keys: [keyStr] });
    ok(!dirLeak.hasId && !dirLeak.hasKey,
       `B3: the directory leaks no xell id or key (leak: ${dirLeak.hasId || dirLeak.hasKey || 'none'})`);
    ok(dir.agents.every((a) => typeof a.slug === 'string' && a.url.includes('/a2a/v1/agents/')),
       'B3: each directory entry is { slug, name, url } pointing at its card');

    // ── B4. the per-agent card — id-scrubbed ──
    const card = await agentCardFor(worker, 'http://localhost:4800');
    ok(!!card, 'B4: an external caller gets the card of an agent its project owns');
    const cardText = JSON.stringify(card);
    const cardLeak = scrubClean(cardText, { xellIds, keys: [keyStr] });
    ok(!cardLeak.hasId && !cardLeak.hasKey,
       `B4: the card leaks no xell id or key (leak: ${cardLeak.hasId || cardLeak.hasKey || 'none'})`);
    eq(card.supportedInterfaces[0].tenant, worker.slug, 'B4: the card\'s tenant is the agent\'s slug (DR-4)');

    // ── B5. task projections — id-scrubbed ──
    const d = await postMessage({ from: manager, to: worker, body: 'external-visible task', kind: 'directive', deliver: false });
    const taskId = d.message.meta.a2a.taskId;
    const task = await getTask(caller, taskId);
    eq(task.task.id, taskId, 'B5: GetTask returns the project\'s task to the external caller');
    const taskText = JSON.stringify(task);
    const taskLeak = scrubClean(taskText, { xellIds, keys: [keyStr] });
    ok(!taskLeak.hasId && !taskLeak.hasKey,
       `B5: the task projection leaks no xell id or key (leak: ${taskLeak.hasId || taskLeak.hasKey || 'none'})`);
    const tasks = await dispatchA2A(caller, 'ListTasks', {}, { visible: taskVis });
    ok(tasks.tasks.some((t) => t.id === taskId), 'B5: ListTasks (via dispatch) shows the project\'s task');

    // ── B6. SendMessage from an external caller ──
    const sent = await dispatchA2A(caller, 'SendMessage', {
      message: { role: 'user', parts: [{ text: 'external hello' }] },
    }, { visible: taskVis, agent: worker });
    ok(sent.message?.taskId, 'B6: an external caller may send a message to an agent its project owns');
    const msgText = JSON.stringify(sent);
    const msgLeak = scrubClean(msgText, { xellIds, keys: [keyStr] });
    ok(!msgLeak.hasId && !msgLeak.hasKey,
       `B6: the SendMessage answer leaks no xell id or key (leak: ${msgLeak.hasId || msgLeak.hasKey || 'none'})`);
    const sentRow = await one(`SELECT * FROM zee_message WHERE id=$1`, [sent.message.messageId]);
    eq(sentRow.from_xell_id, null, 'B6: the message row has NO from-xell (the sender is external)');
    ok(String(sentRow.from_slug).startsWith('ext:'), `B6: provenance is ext:<project>, not a fabricated xell (${sentRow.from_slug})`);
    eq(sentRow.project_id, projectId, 'B6: …and the row lands in the key\'s own project');

    // ── C. the outbound verb — queenzee-mediated + recorded ──
    // A LOCAL mock A2A server: serves an AgentCard declaring a JSON-RPC endpoint, and answers
    // SendMessage with a JSON-RPC result. The queenzee makes the HTTP call; the test only asserts
    // the call was made and the ledger recorded it.
    const sentMessages = [];
    let mockPort = null;
    mockServer = await new Promise((res) => {
      const s = createServer((req, rres) => {
        if (req.url === '/agent-card.json') {
          rres.setHeader('Content-Type', 'application/json');
          return rres.end(JSON.stringify({
            name: 'mock-agent', url: 'http://127.0.0.1:1/irrelevant',
            supportedInterfaces: [{ url: `http://127.0.0.1:${mockPort}/jsonrpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
            capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
          }));
        }
        if (req.url === '/jsonrpc') {
          let b = '';
          req.on('data', (c) => (b += c));
          req.on('end', () => {
            const j = JSON.parse(b || '{}');
            sentMessages.push(j);
            rres.setHeader('Content-Type', 'application/json');
            rres.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: { message: { messageId: 'mock-msg-1' } } }));
          });
          return;
        }
        rres.statusCode = 404; rres.end('{}');
      });
      s.listen(0, '127.0.0.1', () => { mockPort = s.address().port; res(s); });
    });
    const mockBase = `http://127.0.0.1:${mockPort}`;

    const out = await sendExternalA2AMessage({ xell: worker, cardUrl: `${mockBase}/agent-card.json`, message: 'hello external world' });
    ok(out.ok === true, `C1: the queenzee-mediated send to the mock agent succeeded (got ${out.error || 'ok'})`);
    eq(out.result?.message?.messageId, 'mock-msg-1', 'C1: the external JSON-RPC result is returned to the zee');
    ok(sentMessages.length === 1 && sentMessages[0].method === 'SendMessage' && sentMessages[0].params.message.parts[0].text === 'hello external world',
       'C1: the queenzee POSTed a v1.0 SendMessage with the zee\'s text to the card\'s JSON-RPC endpoint');
    const rec = await one(`SELECT * FROM a2a_outbound_request WHERE card_url=$1 ORDER BY requested_at DESC LIMIT 1`, [`${mockBase}/agent-card.json`]);
    ok(!!rec, 'C1: the outbound call is RECORDED at the transport layer (a2a_outbound_request)');
    eq(rec.xell_id, worker.id, 'C1: the record attributes the call to the calling xell');
    eq(rec.method, 'SendMessage', 'C1: the record names the method');
    eq(rec.body, 'hello external world', 'C1: the record carries the message text');
    eq(rec.status, 200, 'C1: the record carries the external HTTP verdict');
    ok(rec.response?.result?.message?.messageId === 'mock-msg-1', 'C1: the record carries the external JSON-RPC response');
    eq(rec.agent_url, `${mockBase}/jsonrpc`, 'C1: the record resolves the card to its JSON-RPC endpoint');
    ok(!!rec.completed_at, 'C1: the record was completed (not left in-flight)');

    // C2. a card fetch failure is recorded with the error.
    const bad = await sendExternalA2AMessage({ xell: worker, cardUrl: `${mockBase}/no-such-card`, message: 'should fail' });
    eq(bad.ok, false, 'C2: an unreachable card URL fails loudly');
    const badRec = await one(`SELECT * FROM a2a_outbound_request WHERE card_url=$1 ORDER BY requested_at DESC LIMIT 1`, [`${mockBase}/no-such-card`]);
    ok(!!badRec && !!badRec.error && badRec.status !== 200,
       `C2: the failed call is recorded WITH its error (status ${badRec?.status}, error ${badRec?.error?.slice(0, 60)})`);

    // resolveAgentInterface — pure, unit-asserted here.
    ok(resolveAgentInterface({ supportedInterfaces: [{ protocolBinding: 'JSONRPC', url: '/x' }] })?.url === '/x',
       'C: resolveAgentInterface finds the JSONRPC interface on a card');
    eq(resolveAgentInterface({ supportedInterfaces: [{ protocolBinding: 'HTTP', url: '/x' }] }), null,
       'C: a card with no JSONRPC interface resolves to nothing');

    console.log(`    (project=zt-${tag}, worker=${worker.slug}, key=${keyRow.key_hint}, mock port=${mockPort})`);
  } finally {
    if (mockServer) await new Promise((r) => mockServer.close(r));
    if (projectId) await q(`DELETE FROM project WHERE id=$1`, [projectId]).catch(() => {});
  }
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);

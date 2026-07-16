#!/usr/bin/env node
// ZEEHIVE MCP server — gives an agent structured tools (an alternative to the /xell skills)
// to talk to the queenzee. Stdio transport; wraps the queenzee HTTP API.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API = process.env.ZEEHIVE_API || 'http://localhost:4700';
const SID = () => process.env.CLAUDE_CODE_SESSION_ID || '';

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}
const asText = (r) => ({ content: [{ type: 'text', text: r.text || `HTTP ${r.status}` }], isError: !r.ok });

const server = new McpServer({ name: 'zeehive', version: '0.1.0' });

server.tool('zeehive_get_context',
  'Claim a ready xell for this session and return its binding (worktree, branch, containers, task). Use at the start of work.',
  { task: z.string().optional().describe('what to do in the xell'), cwd: z.string().optional() },
  async ({ task, cwd }) => asText(await call('POST', '/api/xell/claim', { session_id: SID(), cwd: cwd || process.cwd(), task })));

server.tool('zeehive_status',
  "Get this session's xell status — including whether the job is done (human-confirmed) or awaiting confirmation, and the prod-lock holder.",
  { session_id: z.string().optional(), xell_id: z.string().optional() },
  async ({ session_id, xell_id }) => {
    const qs = new URLSearchParams(xell_id ? { xell_id } : { session_id: session_id || SID() });
    return asText(await call('GET', `/api/xell/status?${qs}`));
  });

server.tool('zeehive_report_done',
  'Report that you believe the job is finished. Does NOT tear you down — flags the xell for a HUMAN to confirm via "Mark done". Only call after verifying your work.',
  { note: z.string().optional().describe('one-line summary of what you finished') },
  async ({ note }) => asText(await call('POST', '/api/xell/report-done', { session_id: SID(), note })));

// A zee's ONLY prod verb: ask. It cannot take the lock and cannot run a deploy — the
// acquire/release tools that used to live here are gone on purpose. A zee holding prod and
// deploying by hand is exactly how band-aid deploys happened: live in prod, absent from main,
// silently reverted by the next rebuild. A human approves; the QUEENZEE deploys, from main.
server.tool('zeehive_ooney',
  'The ONE pipeline to get your work into PRODUCTION. Re-measures every gate live (in sync with '
  + 'main → schema identical to prod → your containers built from your current commit → human '
  + 'clearance → queenzee builds prod) and returns the verdict plus the EXACT next step. The '
  + 'response IS the procedure — follow it, then call again. Idempotent; poll until live/deny, or '
  + 'run scripts/xell-ooney.mjs --wait in the background instead.',
  {
    xell_id: z.string().describe('your xell id'),
    targets: z.array(z.enum(['server', 'webapp'])).optional().describe('what you are shipping (default both)'),
    reason: z.string().optional().describe('one line: what this ship changes'),
  },
  async ({ xell_id, targets, reason }) => asText(await call('POST', '/api/ooney/check', { xell_id, targets, reason })));

server.tool('zeehive_ship_request',
  'ASK to ship to PRODUCTION. You do not deploy: a human approves, then the queenzee takes the prod '
  + 'lock and builds from the xource at main, and releases the lock itself. REFUSED unless your work '
  + 'is already landed on main (prod builds from main, so unlanded work would not be in the ship). '
  + 'Poll zeehive_ship_status, or run scripts/xell-ship.mjs --wait in the background.',
  { xell_id: z.string().describe('your xell id'), reason: z.string().optional().describe('what you are shipping') },
  async ({ xell_id, reason }) => asText(await call('POST', '/api/ship/request', { xell_id, reason })));

server.tool('zeehive_ship_status',
  'Status of your xell\'s production ship request (pending → approved → shipping → shipped/failed).',
  { xell_id: z.string() },
  async ({ xell_id }) => asText(await call('GET', `/api/ship/status?xell=${encodeURIComponent(xell_id)}`)));

server.tool('zeehive_prod_lock_status',
  'Who holds the production deploy lock right now? (Read-only. You can never take or release it.)', {},
  async () => asText(await call('GET', '/api/prod-lock')));

await server.connect(new StdioServerTransport());

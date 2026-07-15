#!/usr/bin/env node
// ZEEHIVE MCP server — gives an agent structured tools (an alternative to the /xell skills)
// to talk to the queenzee. Stdio transport; wraps the queenzee HTTP API.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API = process.env.ZEEHIVE_API || process.env.ZEEHIVE_API || 'http://localhost:4700';
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

server.tool('zeehive_prod_lock_acquire',
  'Acquire the PRODUCTION deploy lock before deploying to prod (only one xell may hold it). Returns the current holder if already held.',
  { xell_id: z.string().describe('your xell id'), phase: z.string().optional() },
  async ({ xell_id, phase }) => asText(await call('POST', '/api/prod-lock/acquire', { xell_id, phase })));

server.tool('zeehive_prod_lock_release',
  'Release the PRODUCTION deploy lock your xell holds (after the deploy is verified).',
  { xell_id: z.string() },
  async ({ xell_id }) => asText(await call('POST', '/api/prod-lock/release', { xell_id })));

server.tool('zeehive_prod_lock_status', 'Who holds the production deploy lock right now?', {},
  async () => asText(await call('GET', '/api/prod-lock')));

await server.connect(new StdioServerTransport());

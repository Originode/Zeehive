// Wrappers around the `claude` CLI — the CLI's own authoritative view of what is really
// running (stronger than reading files, and the way to confirm a remote session is live).
import { spawn } from 'node:child_process';

const CLAUDE = process.env.CLAUDE_BIN || 'claude';
// On Windows `claude` is a .cmd shim → spawn needs a shell to resolve it. Args are all
// internally-generated (no free-text in argv; prompts go via stdin), so shell is safe here.
const WIN = process.platform === 'win32';

// ASYNC on purpose. This used to be spawnSync — and the `claude` CLI takes seconds to start on
// Windows, so the 12-second monitor tick froze the WHOLE event loop for most of its life: /fleet
// took 35s, the prod-guard's 5s budget expired (fail-closed DENYs), the dashboard half-rendered.
// One synchronous child process in a periodic loop is how a single-process orchestrator clogs.
function run(args, timeout = 20000) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(CLAUDE, args, { windowsHide: true, shell: WIN }); }
    catch (e) { return resolve({ status: -1, stdout: '', stderr: String(e.message) }); }
    let stdout = '', stderr = '';
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeout);
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', (e) => { clearTimeout(t); resolve({ status: -1, stdout, stderr: stderr + String(e.message) }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ status: code, stdout, stderr }); });
  });
}

// `claude agents --json` → the CLI's list of active sessions (local + background).
// { pid, cwd, kind, startedAt, sessionId, name }. Empty on any failure (never throws).
export async function listActiveAgents({ all = false } = {}) {
  try {
    const r = await run(['agents', '--json', ...(all ? ['--all'] : [])]);
    if (r.status !== 0) return { ok: false, error: r.stderr.slice(-200), agents: [] };
    return { ok: true, agents: JSON.parse(r.stdout.trim() || '[]') };
  } catch (err) {
    return { ok: false, error: err.message, agents: [] };
  }
}

// Set of live sessionIds per the CLI (the "really active" oracle).
export async function activeSessionIds(opts) {
  return new Set((await listActiveAgents(opts)).agents.map((a) => a.sessionId));
}

// Is Remote Control usable at all (claude.ai login present)? `claude remote` errors
// with a login message when not authenticated.
export async function remoteAvailable() {
  const r = await run(['remote', '--help'], 8000);
  const text = `${r.stdout}\n${r.stderr}`;
  if (/must be logged in|Please use `\/login`|not logged in/i.test(text)) {
    return { available: false, reason: 'not logged in to claude.ai (Remote Control requires a subscription)' };
  }
  return { available: r.status === 0 || /Usage|remote/i.test(text), reason: null };
}

// ── Remote Control (`claude remote`) — the literal remote CLI ────────────────
// Remote is claude.ai-login-gated, so we can't introspect exact flags here. The START
// invocation is env-configurable; everything returns the RAW CLI result so callers
// surface real output/errors instead of fabricating success.

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function isLoggedOut(text) {
  return /must be logged in|Please use `\/login`|not logged in/i.test(text);
}

export function remoteStartArgs({ name, model }) {
  const tmpl = process.env.CLAUDE_REMOTE_START_TEMPLATE || 'remote start --name {name}';
  return tmpl.split(/\s+/)
    .map((a) => a.replace('{name}', name || '').replace('{model}', model || ''))
    .filter(Boolean);
}

// Start a remote session via `claude remote` — ASYNC (never blocks the event loop) with a
// hard timeout. Template overridable via CLAUDE_REMOTE_START_TEMPLATE; prompt piped on stdin.
export function remoteStart({ name, prompt, cwd, model }) {
  const args = remoteStartArgs({ name, model });
  const cmd = `${CLAUDE} ${args.join(' ')}`;
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const finish = (status) => {
      if (done) return; done = true;
      const text = `${out}\n${err}`;
      resolve({
        ok: status === 0 && !isLoggedOut(text), loggedOut: isLoggedOut(text), status,
        sessionId: (text.match(UUID) || [])[0] || null,
        url: (text.match(/https:\/\/claude\.ai\/[^\s"']+/) || [])[0] || null,
        stdout: out.slice(-2000), stderr: err.slice(-500), cmd,
      });
    };
    let child;
    try { child = spawn(CLAUDE, args, { cwd, windowsHide: true, shell: WIN }); }
    catch (e) { return resolve({ ok: false, loggedOut: false, status: null, stderr: e.message, cmd }); }
    const to = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(null); },
      Number(process.env.CLAUDE_REMOTE_TIMEOUT_MS) || 25000);
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (err += d));
    if (prompt) { try { child.stdin.write(prompt); child.stdin.end(); } catch {} }
    child.on('close', (code) => { clearTimeout(to); finish(code); });
    child.on('error', (e) => { clearTimeout(to); err += e.message; finish(null); });
  });
}

// List remote sessions (`claude remote list`). Tries --json, falls back to raw text.
export async function remoteList() {
  const r = await run(['remote', 'list', '--json'], 15000);
  const text = `${r.stdout}\n${r.stderr}`;
  if (isLoggedOut(text)) return { ok: false, loggedOut: true, sessions: [] };
  try { return { ok: true, sessions: JSON.parse(r.stdout.trim() || '[]') }; }
  catch { return { ok: r.status === 0, sessions: [], raw: r.stdout.slice(0, 2000) }; }
}

// Status of one remote session (`claude remote status <ref>`).
export async function remoteStatus(ref) {
  const r = await run(['remote', 'status', ref], 12000);
  const text = `${r.stdout}\n${r.stderr}`;
  if (isLoggedOut(text)) return { ok: false, loggedOut: true, active: false };
  const active = /running|active|online|connected/i.test(text);
  return { ok: r.status === 0, active, raw: text.slice(0, 500) };
}

export { run as claudeRun };

// Channel B — passive, model-independent session observability.
// Reads the harness-written files under CLAUDE_HOME with ZERO agent cooperation:
//   sessions/<PID>.json           → PID ↔ sessionId ↔ cwd registry
//   projects/<sanitized cwd>/<sessionId>.jsonl → mtime heartbeat + last stop_reason
// Never reads config.json / .credentials.json / ide/*.lock (secrets).
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { config } from '../config.js';

const sessionsDir = join(config.claudeHome, 'sessions');
const projectsDir = join(config.claudeHome, 'projects');

// A cwd is turned into a projects/ subdir by replacing ':', slashes, and dots with '-'.
// e.g. "D:\Repos\XEEHIVE"                 → "D--Repos-XEEHIVE"
//      "…\omnibiz\.claude\worktrees\foo"    → "…-omnibiz--claude-worktrees-foo"
export function sanitizeCwd(cwd) {
  return String(cwd).replace(/[:\\/.]/g, '-');
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check; throws ESRCH if gone
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but not ours → still alive
  }
}

// Full live-session table from the on-disk registry, gated on real process liveness.
export function liveSessions() {
  const out = [];
  if (!existsSync(sessionsDir)) return out;
  for (const f of readdirSync(sessionsDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(readFileSync(join(sessionsDir, f), 'utf8'));
      if (!rec.sessionId) continue;
      rec.alive = pidAlive(rec.pid);
      out.push(rec);
    } catch { /* skip malformed/partial writes */ }
  }
  return out;
}

// Derive working|idle|unknown + last-activity age from a session's transcript alone.
export function transcriptState(sessionId, cwd) {
  try {
    const dir = join(projectsDir, sanitizeCwd(cwd));
    const file = resolve(dir, `${sessionId}.jsonl`);
    if (!existsSync(file)) return { state: 'unknown', mtime: null, ageMs: null };
    const st = statSync(file);
    const ageMs = Date.now() - st.mtimeMs;
    // Read the tail and find the last meaningful record.
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    let stopReason = null;
    let lastType = null;
    for (let i = lines.length - 1; i >= 0 && i > lines.length - 40; i--) {
      let rec;
      try { rec = JSON.parse(lines[i]); } catch { continue; }
      const t = rec.type || rec.message?.type;
      if (!lastType) lastType = t;
      const sr = rec.message?.stop_reason ?? rec.stop_reason;
      if (sr) { stopReason = sr; break; }
      if (t === 'assistant' || t === 'user' || t === 'tool_result') break;
    }
    // end_turn (and nothing after) = idle/waiting on user; tool_use / trailing user = working
    let state = 'unknown';
    if (stopReason === 'end_turn') state = 'idle';
    else if (stopReason === 'tool_use') state = 'working';
    else if (lastType === 'user' || lastType === 'tool_result') state = 'working';
    return { state, mtime: st.mtimeMs, ageMs, stopReason };
  } catch {
    return { state: 'unknown', mtime: null, ageMs: null };
  }
}

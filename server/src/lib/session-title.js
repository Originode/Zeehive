// Session-title bridge — resolve the human-readable title an AI provider shows for a session
// (Claude Code's sidebar title, e.g. "Fix Map-Account-to-Person…"). Claude Code writes it into
// the session transcript at ~/.claude/projects/<slug>/<session-id>.jsonl as {"title":"…"}; the
// title updates over time, so we take the LAST occurrence. mtime-cached so the monitor can call
// it every tick cheaply. Returns null when unknown (no transcript / no title yet).
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';

const PROJECTS = resolve(homedir(), '.claude', 'projects');
const TITLE_RE = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const cache = new Map(); // path → { mtimeMs, title }

// Find <sessionId>.jsonl under any project slug dir (filename === session id).
function transcriptPath(sessionId) {
  if (!sessionId || !existsSync(PROJECTS)) return null;
  for (const dir of readdirSync(PROJECTS)) {
    const p = resolve(PROJECTS, dir, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

export function sessionTitle(sessionId) {
  const p = transcriptPath(sessionId);
  if (!p) return null;
  try {
    const { mtimeMs } = statSync(p);
    const hit = cache.get(p);
    if (hit && hit.mtimeMs === mtimeMs) return hit.title;
    const text = readFileSync(p, 'utf8');
    let m, last = null;
    while ((m = TITLE_RE.exec(text)) !== null) last = m[1];
    const title = last ? last.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : null;
    cache.set(p, { mtimeMs, title });
    return title;
  } catch {
    return null;
  }
}

// Session-title bridge — resolve the human-readable title an AI provider shows for a session
// (Claude Code's sidebar title, e.g. "Holiday records system for payroll").
//
// Claude Code records it in the session transcript at ~/.claude/projects/<slug>/<session-id>.jsonl
// as its OWN line type:  {"type":"custom-title","customTitle":"…","sessionId":"…"}
// It is re-written when the title changes, so we take the LAST one.
//
// Do NOT scrape generic "title" fields: transcripts are full of them (a spawn_task chip's
// {title,tldr,prompt} input, a WebFetch'd page's <title>, …) and matching those yields nonsense
// like naming a zee after a news headline it happened to fetch.
//
// mtime-cached so the monitor can call it every tick cheaply. null when unknown/untitled.
import { resolve } from 'node:path';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { config } from '../config.js';

// config.claudeHome, NOT homedir(): every other CLAUDE_HOME read honors the env override
// (sessions.js), and a containerized queenzee reaches the host's transcripts only through a
// mounted CLAUDE_HOME — a raw homedir() would silently read an empty in-container dir.
const PROJECTS = resolve(config.claudeHome, 'projects');
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
    let title = null;
    for (const line of text.split('\n')) {
      if (!line.includes('"custom-title"')) continue;   // cheap pre-filter before JSON.parse
      try {
        const j = JSON.parse(line);
        if (j?.type === 'custom-title' && j.customTitle) title = j.customTitle; // last wins
      } catch { /* skip malformed line */ }
    }
    cache.set(p, { mtimeMs, title });
    return title;
  } catch {
    return null;
  }
}

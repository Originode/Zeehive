#!/usr/bin/env node
// Render a caged zee's transcript (the session .jsonl Claude Code writes on disk, which is the
// same content-block stream the queenzee captures for the SSE feed) into a readable LIVE feed
// for the dashboard terminal. zee-attach.sh pipes a `tail -f` of the running session's transcript
// through this while the headless zee is still working, so an attending human sees the workflow —
// prior turns, thinking, tool calls and results — AS IT HAPPENS, then hands off to `claude
// --resume` for the full interactive session once the turn ends. Additive: it only READS the
// transcript, it does not touch the `-p` stdout the SSE feed depends on and starts no `claude`.
const C = { dim:'\x1b[2m', reset:'\x1b[0m', cyan:'\x1b[36m', green:'\x1b[32m', yellow:'\x1b[33m', mag:'\x1b[35m', bold:'\x1b[1m' };
const w = (s) => process.stdout.write(s + '\r\n');
const clip = (s, n = 200) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString(); let nl;
  while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) feed(line); }
});
process.stdin.on('end', () => { if (buf.trim()) feed(buf); });

function feed(line) {
  let e; try { e = JSON.parse(line); } catch { return; } // non-JSON / bookkeeping noise
  // The transcript carries both stream-json events (system/result) and on-disk turns
  // (assistant/user with message.content blocks); render whichever we get.
  if (e.type === 'system' && e.subtype === 'init') { w(`${C.dim}── session ${String(e.session_id || '').slice(0, 8)} ──${C.reset}`); return; }
  if (e.type === 'assistant') {
    for (const b of e.message?.content || []) {
      if (b.type === 'thinking' && b.thinking?.trim()) w(`${C.mag}${C.dim}✱ thinking${C.reset} ${C.dim}${clip(b.thinking)}${C.reset}`);
      if (b.type === 'text' && b.text?.trim()) w(`${C.green}●${C.reset} ${clip(b.text, 400)}`);
      if (b.type === 'tool_use') w(`${C.cyan}⚒ ${b.name}${C.reset} ${C.dim}${clip(JSON.stringify(b.input || {}), 160)}${C.reset}`);
    }
    return;
  }
  if (e.type === 'user') {
    const content = e.message?.content;
    if (typeof content === 'string' && content.trim()) { w(`${C.bold}❯${C.reset} ${clip(content, 300)}`); return; }
    for (const b of content || []) {
      if (b.type === 'tool_result') {
        const t = Array.isArray(b.content) ? b.content.map((x) => x.text || '').join(' ') : (b.content || '');
        w(`${C.yellow}  ↳${C.reset} ${C.dim}${clip(t, 160)}${C.reset}`);
      }
    }
    return;
  }
  if (e.type === 'result') w(`${C.bold}${C.green}── turn complete ──${C.reset} ${C.dim}${clip(e.result || e.subtype, 200)}${C.reset}`);
}

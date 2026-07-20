-- Vendor-native cxell runtimes (Mark, 2026-07-20): a zee dispatched on the OpenAI or Kimi
-- provider runs that vendor's OWN coding CLI inside the same zee-agent cxell — the literal
-- ChatGPT Codex CLI (`codex exec`) and Kimi Code CLI, NOT the claude CLI re-aimed at a
-- compat base URL, and NOT a hand-rolled agent loop. Same driver ('cxell-cli'): the cxell
-- is the confinement boundary regardless of whose model is inside it. viewer is 'none' for
-- the same reason as 028 — the session state lives inside the container; the live feed is
-- the SSE 'zee-output' stream, and the attend door is the cxell's SSH terminal.
INSERT INTO agent_runtime (key,label,vendor,driver,viewer_kind,viewer_url_template,enabled,sort_order)
VALUES ('codex-cxell','ChatGPT Codex (cxell)','openai','cxell-cli','none',NULL,true,160),
       ('kimi-code-cxell','Kimi Code (cxell)','moonshot','cxell-cli','none',NULL,true,170)
ON CONFLICT (key) DO NOTHING;

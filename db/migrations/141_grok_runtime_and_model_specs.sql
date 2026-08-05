-- Grok Build in provider selection: xAI is dispatchable, on its OWN CLI.
--
-- Mark's vendor-native ruling (034) decides the shape: xAI ships a coding-agent CLI of its own —
-- the literal `grok` CLI (@xai-official/grok, `grok -p` headless, lib/cxell-runtimes.js
-- 'grok-cxell') — so a zee dispatched on the grok provider runs THAT inside the same zee-agent
-- cxell. Not the claude CLI re-aimed at api.x.ai's Anthropic-compatible endpoint: that endpoint is
-- real, and it is exactly the shim the ruling forbids where a vendor has its own agent (the
-- deepseek exception, 037, exists only because DeepSeek ships none).
--
-- Same driver ('cxell-cli') — the cxell is the confinement boundary whoever's model is inside it —
-- and viewer 'none' for the same reason as 034/037: the session state lives inside the container,
-- the live feed is the SSE 'zee-output' stream, and the attend door is the cxell's SSH terminal.
INSERT INTO agent_runtime (key,label,vendor,driver,viewer_kind,viewer_url_template,enabled,sort_order)
VALUES ('grok-cxell','Grok Build (cxell)','xai','cxell-cli','none',NULL,true,190)
ON CONFLICT (key) DO NOTHING;

-- grok's models (110's registry; mirrors cxell-runtimes.js VENDOR_MODELS.grok). EXACTLY what
-- `grok models` lists on the CLI, measured on 0.2.118: the CLI validates the id CLIENT-side and
-- ends the turn on one it does not know ("unknown model id"), so an aspirational entry here would
-- be a dead dispatch rather than a fallback.
INSERT INTO ai_model_spec (provider, key, label, note, is_default) VALUES
  ('grok', '',         'Grok default', 'the Grok Build CLI''s own default model', true),
  ('grok', 'grok-4.5', 'Grok 4.5',     'the flagship coding model — configurable reasoning', false)
ON CONFLICT (provider, key) DO UPDATE SET label = EXCLUDED.label, note = EXCLUDED.note, is_default = EXCLUDED.is_default;

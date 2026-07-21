-- DeepSeek zees (Mark, 2026-07-22): DeepSeek ships no coding-agent CLI of its own, but it DOES
-- ship an Anthropic-compatible API (api.deepseek.com/anthropic) built precisely so Claude-Code-
-- style tooling can drive its models. So the DeepSeek runtime is the claude CLI aimed at
-- DeepSeek's own documented door — the sanctioned exception to 034's vendor-native ruling.
-- Same driver ('cxell-cli'), same confinement; only the credential env and base URL differ
-- (lib/cxell-runtimes.js 'deepseek-cxell').
INSERT INTO agent_runtime (key,label,vendor,driver,viewer_kind,viewer_url_template,enabled,sort_order)
VALUES ('deepseek-cxell','DeepSeek (cxell)','deepseek','cxell-cli','none',NULL,true,180)
ON CONFLICT (key) DO NOTHING;

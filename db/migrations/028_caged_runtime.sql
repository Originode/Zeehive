-- The CXELLD runtime: the zee's claude CLI runs INSIDE a per-xell agent container
-- (zeehive/zee-agent) instead of on the host. Confinement is structural — the container's
-- filesystem and its default-DROP egress firewall are the permission system, so mode 5
-- (bypassPermissions) inside the cxell is the safe default rather than the scary one.
-- viewer is 'none' for now: session JSONL lives inside the container, so claude:// deep
-- links cannot attach — live output streams to the dashboard instead (SSE 'zee-output').
INSERT INTO agent_runtime (key,label,vendor,driver,viewer_kind,viewer_url_template,enabled,sort_order)
VALUES ('claude-code-cxell','Claude Code (cxell)','anthropic','cxell-cli','none',NULL,true,150)
ON CONFLICT (key) DO NOTHING;

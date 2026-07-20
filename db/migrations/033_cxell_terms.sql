-- TERMINOLOGY (Mark, 2026-07-20): the container a headless zee runs in is a CXELL — a caged
-- xell. "Cage" as a term is retired everywhere (code, env vars, container names cxell_<slug>,
-- docs); this migration brings DB VALUES minted under the old vocabulary along. Fresh databases
-- never see the old strings (028's inserts were renamed in the same pass), so both worlds
-- converge on the same keys.
UPDATE agent_runtime SET key = 'claude-code-cxell',
       label = REPLACE(label, 'caged', 'cxell')
 WHERE key = 'claude-code-caged';
UPDATE zee SET entrypoint = 'cxell-cli' WHERE entrypoint = 'caged-cli';

-- WHAT A ZEE IS TOLD ABOUT ITS CAGE WAS CLAUDE-ONLY, AND THE FIREWALL PART WAS NO LONGER TRUE.
--
-- Two sentences in the manuals, both read by EVERY zee in every cage whatever vendor it runs on:
--
--   1. "an autonomous agent running `claude --bare` *inside* a per-xell container". A dispatch
--      resolves the provider, and the cage carries claude, codex and kimi (lib/cxell-runtimes.js) —
--      so a Codex or Kimi zee opened its own manual and read that it was something else. The manual
--      is authoritative by its own first paragraph; being wrong in the first line of it is not a
--      cosmetic problem.
--
--   2. "a default-DROP egress firewall. The only things you can reach are: `api.anthropic.com`,
--      your OWN stack's containers … and the queenzee API". That has been false since 2026-07-19,
--      when the egress policy was deliberately simplified: docker/zeehive/cxell-firewall.sh sets
--      `iptables -P OUTPUT ACCEPT` and DROPS exactly one thing — the fleet's live PRODUCTION
--      databases (which Docker's bridge NAT would otherwise expose on the LAN), leaving a
--      prod-bound xell's own db reachable. Locking the rest down bought nothing (the container is
--      the boundary) and broke `npm ci`.
--
--      Left alone, the two faults compound: a zee dispatched on OpenAI reads that its cage allows
--      one vendor's API and that vendor is not its own. The honest reading of that is "my provider
--      is unreachable" — about a cage where it is reachable, on a fleet that has just fixed the
--      real reason those zees were failing (the credential install, 8ac5e85).
--
-- Both manuals carry it, so both are patched: the worker manual (harness `zee-base`) and the
-- manager manual (harness `manager`), which repeats the same claim in its own words.
--
-- FORM: 076's harness_memory_get/_put — anchored, guarded, idempotent, never rebuilding the memory
-- array (house rule 9; test/harness-memory-migrations.test.mjs fails anything that hand-rolls it).
-- An anchor that has moved is a NOTICE and a no-op, never a half-edit.
--
-- The repo's CLAUDE.md carries the same table row and is corrected in the same landing; 116 syncs
-- project_doc.body from it (the row is what generates AGENTS.md and every other provider file).

-- ── WORKER MANUAL (zee-base → cxell-zee-manual.md) ────────────────────────────────────────────
DO $mig$
DECLARE
  txt     text;
  old_cli text := 'You are a **cxell zee**: an autonomous agent running `claude --bare` *inside* a per-xell container';
  new_cli text := 'You are a **cxell zee**: an autonomous agent running your provider''s own coding CLI — `claude`,'
               || E'\n`codex` or `kimi`, whichever the dispatch resolved to — *inside* a per-xell container';
  old_net text := 'The cxell is a wall. You have **no docker CLI, no host filesystem, no skills**, and a default-DROP'
               || E'\negress firewall. The only things you can reach are: `api.anthropic.com`, your OWN stack''s'
               || E'\ncontainers (db/app, by host:port), and the **queenzee API**. That last one is your single door out.';
  new_net text := 'The cxell is a wall, and the wall is the CONTAINER: **no docker CLI, no host filesystem, no host'
               || E'\nmounts, non-root**. You cannot reach the host, the xource, or another xell — not because of a'
               || E'\nnetwork rule, but because none of it exists in here.'
               || E'\n'
               || E'\nEgress is OPEN, deliberately: your provider''s API, your OWN stack''s containers (db/app, by'
               || E'\nhost:port from your binding) and the package registries a build needs all work. Exactly ONE'
               || E'\nthing is dropped — the fleet''s live PRODUCTION databases, unless a human has bound you to one'
               || E'\n(docker/zeehive/cxell-firewall.sh). The **queenzee API** is your single door to anything'
               || E'\nprivileged, and that is what makes the gates below the whole of your reach.';
  -- golden rule 2 names a claude FLAG for a rule that holds on every vendor's CLI. Which entry-point
  -- file a provider reads is a registry in code (lib/agent-docs.js: CLAUDE.md, AGENTS.md, GEMINI.md
  -- …) and the queenzee generates whichever ones this project targets — so the instruction is "read
  -- the entry-point doc", not "read the one claude would have loaded".
  old_doc text := '2. **Read `/work/repo/CLAUDE.md` first.** `--bare` may not auto-load it, so open it with the Read'
               || E'\n   tool.';
  new_doc text := '2. **Read the entry-point doc first** — `/work/repo/CLAUDE.md`, or `AGENTS.md` if that is what'
               || E'\n   your provider is given. Running headless, your CLI may not auto-load it, so open it with the'
               || E'\n   Read tool.';
  -- golden rule 4 WRAPS across two lines in the manual, so the anchor carries the wrap. An anchor
  -- that ignores it matches nothing — the failure this migration's test caught before it shipped.
  old_res text := 'Nothing else on'
               || E'\n   the network resolves — that is by design, not an outage.';
  new_res text := 'Nothing on the host, the'
               || E'\n   xource or another xell is reachable from here — that is by design, not an outage.';
  hits    int := 0;
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'worker manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;

  IF position(old_cli IN txt) > 0 THEN
    txt := replace(txt, old_cli, new_cli); hits := hits + 1;
  ELSIF position(new_cli IN txt) = 0 THEN
    RAISE NOTICE 'worker manual: the "running claude --bare" line has moved — check it by hand';
  END IF;

  IF position(old_net IN txt) > 0 THEN
    txt := replace(txt, old_net, new_net); hits := hits + 1;
  ELSIF position('Egress is OPEN, deliberately' IN txt) = 0 THEN
    RAISE NOTICE 'worker manual: the egress paragraph has moved — check it by hand';
  END IF;

  IF position(old_doc IN txt) > 0 THEN
    txt := replace(txt, old_doc, new_doc); hits := hits + 1;
  END IF;

  IF position(old_res IN txt) > 0 THEN
    txt := replace(txt, old_res, new_res); hits := hits + 1;
  END IF;

  IF hits = 0 THEN
    RAISE NOTICE 'worker manual: already provider-agnostic about the cage — nothing to do';
    RETURN;
  END IF;
  PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
  RAISE NOTICE 'worker manual: % cage claim(s) made provider-agnostic and true', hits;
END $mig$;

-- ── MANAGER MANUAL (manager → manager-zee-manual.md) ──────────────────────────────────────────
DO $mig$
DECLARE
  txt     text;
  old_net text := 'Everything a worker zee is told about the cage still holds for you: no docker CLI, no host'
               || E'\nfilesystem, a default-DROP egress firewall, and the **queenzee API as your only door out**.';
  new_net text := 'Everything a worker zee is told about the cage still holds for you: no docker CLI, no host'
               || E'\nfilesystem, no host mounts, and the **queenzee API as your only door out**. (Egress itself is'
               || E'\nopen — whichever vendor CLI you run reaches its own API — with the fleet''s live production'
               || E'\ndatabases dropped, except the one your read-only binding grants you.)';
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;
  IF position(old_net IN txt) = 0 THEN
    RAISE NOTICE 'manager manual: the cage paragraph has moved or is already corrected — nothing to do';
    RETURN;
  END IF;
  txt := replace(txt, old_net, new_net);
  PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
  RAISE NOTICE 'manager manual: the cage claim is now true (egress is open; prod dbs are what is dropped)';
END $mig$;

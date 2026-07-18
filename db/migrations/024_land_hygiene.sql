-- Landing hygiene: two facts that lived only in a process's memory (or nowhere) become data.
--
-- 'stale': an approval bound to a sha the ref has moved past can NEVER fast-forward — the land
-- reaper knew this and stopped retrying, but only in an in-memory set: the row stayed 'approved'
-- and its "waiting for the zee to re-push" receipt rendered FOREVER (nimble-atlas's sat on the
-- console for a day). Dead is a terminal state; now the row can say so.
ALTER TYPE land_status ADD VALUE IF NOT EXISTS 'stale';

-- Dismissal: hiding a receipt was view-only client state, so every reload and SSE refresh
-- resurrected it — "they keep popping back up". A human saying "seen it, stop showing me" is a
-- server-side fact about the REQUEST's visibility, never its status: a dismissed approval still
-- lands/goes stale on its own schedule, it just does it quietly.
ALTER TABLE land_request
  ADD COLUMN IF NOT EXISTS dismissed_at timestamptz,
  ADD COLUMN IF NOT EXISTS dismissed_by text;

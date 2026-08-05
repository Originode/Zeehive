-- THE REFLECTIONS LEDGER — a post-ship reflection can be FILED as a ticket, once.
--
-- `zee_message` where kind='reflection' is the fleet's only systematic self-feedback: a zee whose
-- work shipped is re-invoked and reports what it now knows (queenzee/shipgate.js). Those rows were
-- readable only through the recipient's own `zee inbox` and the per-xell Directives panel, so a
-- reflection addressed to a manager xell that has since been retired reached nobody at all — 93% of
-- them have never been read, and the findings inside them (an app tier that cannot boot, an endpoint
-- never answered over HTTP) were never acted on.
--
-- The console now lists every reflection in one place and turns any one of them into a TICKET
-- through the existing createTicket path. This column is the LINK that keeps the second half of that
-- promise: once filed, the row shows its ticket code, so the same finding is not filed twice.
--
-- Additive, one nullable column, exactly like the ticket→work_item link (work_item.ticket_id, 057):
-- ON DELETE SET NULL, because deleting a ticket must not delete the message it came from, and a
-- reflection whose ticket was deleted is legitimately fileable again. Partial index because the
-- lookup is always "which reflection produced this ticket" and the column is null on every other
-- message in the table.
ALTER TABLE zee_message ADD COLUMN IF NOT EXISTS ticket_id uuid REFERENCES ticket(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS zee_message_ticket_idx ON zee_message (ticket_id) WHERE ticket_id IS NOT NULL;

COMMENT ON COLUMN zee_message.ticket_id IS
  'The ticket this message was FILED as, from the console''s reflections ledger. NULL = not filed. Set once by lib/reflections.js; ON DELETE SET NULL so deleting the ticket re-opens the reflection for filing.';

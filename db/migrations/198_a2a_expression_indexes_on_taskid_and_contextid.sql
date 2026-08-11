-- A2A EXPRESSION INDEXES — phase P3 of the A2A adoption (docs/a2a-protocol-plan.md §4, DR-3).
--
-- Phase P1 stamps an A2A envelope into zee_message.meta (meta.a2a = { messageId, taskId, contextId,
-- referencedTaskId, state }); phase P2's read side (GetTask/ListTasks/SubscribeToTask) and phase
-- P3's write side (SendMessage/CancelTask) both look tasks up BY ID:
--
--   WHERE meta->'a2a'->>'taskId' = $1          -- GetTask / CancelTask / ListTasks
--   WHERE meta->'a2a'->>'contextId' = $1       -- the thread lookup
--
-- The plan's §4 DDL bullet promised exactly these two expression indexes in phase 3 — a seq scan
-- was acceptable at P2 volumes (the fleet's measured turn count is 520 rows, plan §6), but the
-- write side makes the envelope a first-class query path, so the promised indexes arrive now.
--
-- Forward-only and re-runnable (CREATE INDEX IF NOT EXISTS), like every migration in this folder:
-- the runner skips already-applied files, and IF NOT EXISTS keeps a partial application from
-- failing on a re-run. The two indexes are the WHOLE migration — exactly two expression indexes,
-- on taskId and contextId. referencedTaskId is intentionally NOT indexed: it is a reply's pointer
-- to the task it answers, and replies are always gathered through the task they reference.
CREATE INDEX IF NOT EXISTS zee_message_a2a_task_id_idx
  ON zee_message ((meta->'a2a'->>'taskId'));
CREATE INDEX IF NOT EXISTS zee_message_a2a_context_id_idx
  ON zee_message ((meta->'a2a'->>'contextId'));

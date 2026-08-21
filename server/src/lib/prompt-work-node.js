// ANY NEW PROMPT IS A WORK_NODE — the dispatch half of the honeycomb's work tree.
//
// A console "+ prompt" (and every other free dispatch) used to spawn an ITEMLESS worker: real work
// the board never saw, a hexagon with no card, a work_node tree with a hole where the job actually
// ran. This module closes that: every dispatch that is not already FOR a work item gets a fresh
// task item cut for it, with the xell assigned (work_item.xell_id — the annex's assignment column).
// The item's dual-write (work-items.js → work-node-sync.js) is what creates the work_node, so the
// workflow model and the annex stay in step — this file never touches work_node itself.
//
// WHERE THE NEW NODE HANGS: under `parentWorkItem` — the honeycomb context the human dispatched
// FROM (opening a work-node hexagon makes it the current context, so a prompt written there is a
// child of that node). No context (or a bad one) falls back to the project root, which is what
// createWorkItem does with parent_id NULL. The parent is ADVISORY by design: a stale context id
// must never fail a dispatch whose zee is already spawning.
//
// WHO DOES NOT GET ONE:
//   • a dispatch that already names its card (work_item_id — deployWorkItem / `zee assign`): the
//     assignment that follows the spawn is the caller's, and cutting a second card here would
//     double the very node the board tracks;
//   • a xell that already carries an OPEN item (a re-dispatch / `zee swap`): the card outlives the
//     zee inside the cage, so the existing card is returned instead of a duplicate;
//   • managers (callers skip this module for them): a manager runs a crew, it is not a unit of work.
import { one } from '../db/pool.js';
import { createWorkItem } from './work-items.js';
import { logline } from './logbus.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The first non-empty line of the prompt (markdown headings stripped) — the same naming rule
// dispatch uses for the worktree, applied to the card when the caller had no explicit title.
function firstLine(s) {
  for (const raw of String(s || '').split(/\r?\n/)) {
    const line = raw.replace(/^#+\s*/, '').trim();
    if (line) return line;
  }
  return null;
}

// Ensure the dispatched prompt has a work item (and therefore a work_node) with the xell assigned.
// Returns the item row ({ id, title, parent_id, existing? }) or null when this dispatch is not one
// that takes a card (see the header). Never throws for an advisory problem (bad parent); a caller
// treats a hard failure (createWorkItem refusing) as non-fatal — the zee is already running.
export async function ensurePromptWorkItem({ projectId, xellId, workItemId = null,
                                             parentWorkItem = null, title = null, prompt = '' }) {
  if (!projectId || !xellId) return null;
  if (workItemId) return null;   // the caller owns the card and assigns it itself

  // A re-dispatch / swap into a xell that already carries an open card keeps that card.
  const existing = await one(
    `SELECT id, title, parent_id FROM work_item
      WHERE xell_id=$1 AND status NOT IN ('done','cancelled')
      ORDER BY created_at DESC LIMIT 1`, [xellId]);
  if (existing) return { ...existing, existing: true };

  // The context node the prompt was written under — advisory: unknown or foreign falls back to root.
  let parentId = null;
  if (parentWorkItem) {
    if (UUID_RE.test(String(parentWorkItem))) {
      const parent = await one(`SELECT id, project_id, status FROM work_item WHERE id=$1`, [parentWorkItem]);
      if (parent && parent.project_id === projectId) parentId = parent.id;
      else logline('work', `dispatch context ${parentWorkItem} names no work item in this project — `
        + 'the prompt\'s card hangs under the project root instead');
    } else {
      logline('work', `dispatch context "${parentWorkItem}" is not a work item id — ignored`);
    }
  }

  const itemTitle = String(title || firstLine(prompt) || 'prompt').slice(0, 200);
  const item = await createWorkItem({
    project_id: projectId, parent_id: parentId, kind: 'task', title: itemTitle,
    body: prompt ? String(prompt) : null, xell_id: xellId, status: 'assigned', actor: 'dispatch',
  });
  logline('work', `prompt → work_node: cut "${itemTitle}" ${parentId ? 'under its context node' : 'under the project root'} `
    + `and assigned the dispatched xell`);
  return { id: item.id, title: item.title, parent_id: item.parent_id };
}

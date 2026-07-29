import React, { useCallback, useEffect, useState } from 'react';
import { showConfirm, showPrompt } from '../Dialog.jsx';
import { assignWorkItem, deployWorkItem, getAssignCandidates, unassignWorkItem } from './workApi.js';
import { ZeeChip } from './bits.jsx';

// WORK TRACKER — WHO IS ON THIS ITEM: assign an existing xell, or deploy a new worker onto it.
//
// This fills the seam the drawer left open (WorkItemDrawer.jsx, the `zee` Field). It is its own file
// because the two verbs behind it are of a completely different WEIGHT to everything else in the
// drawer — editing a due date is a PATCH you can undo by typing again; **deploying starts a real
// agent in a real xell that costs real tokens and cannot be un-started**. Keeping that in its own
// module means the difference is visible in the file tree, not buried in a 400-line form.
//
// FOUR RULES THIS COMPONENT EXISTS TO HOLD:
//
// 1. NEVER OFFER A UUID BOX. `GET /api/work-items/:id/candidates` returns a ready-made list of only
//    the xells the server would actually accept, each with a `why` line explaining what it is. So
//    the picker is that list, verbatim — the console does not filter it, rank it, or invent an
//    entry. A free-text id field would let a human type something the server then refuses, which is
//    a worse experience than not offering it.
//
// 2. DEPLOY ASKS, IN PLAIN WORDS, AND ASKS LAST. The confirmation says what actually happens —
//    a zee is spawned and starts working — through `showConfirm`/`showPrompt` from Dialog.jsx, never
//    the native dialogs (they park the browser's event loop and freeze the SSE stream behind this
//    overlay). The task text is collected FIRST and the confirmation comes SECOND, so the final
//    click a human makes is the one that means "yes, start it", not "yes, that is the wording".
//
// 3. REFUSALS ARE SENTENCES, AND THEY GO STRAIGHT UP. Every verb answers 409 with `{error}` written
//    for a human ("that xell already has a zee"). This component never interprets one; it hands the
//    Error to `onError`, which is the drawer's ErrLine, which prints it verbatim.
//
// 4. A DEAD XELL LEAVES PROVENANCE, NOT A GHOST. When the xell is gone the read model lends the item
//    NOTHING — `zee` is null and so is `live_status` — but `work_item.xell_id` SURVIVES on the row as
//    the record that someone was once on it. So an item with an id and no live zee shows "was: …",
//    recovered from the `assigned` events in the ledger (their `detail` carries the slug). That is a
//    fact about history, deliberately styled as a footnote and not as a live chip.
//
// What this component must NOT do: write `status`. The queenzee's own tick projects a live hive
// status onto the card (assigned/working/blocked/review/shipping — never done/cancelled). A UI that
// also wrote status on a timer would fight it, and the two would take turns overwriting a human's
// plan. Assign, unassign, deploy — and let the tick say what the zee is doing.
export default function DeployZee({ item, zee, events = [], busy, onDone, onError }) {
  const [candidates, setCandidates] = useState(null);
  const [picking, setPicking] = useState(false);
  const [working, setWorking] = useState(false);
  const disabled = busy || working;

  // Candidates are fetched when the picker OPENS, never on drawer open: it is a live read of which
  // xells could take this item right now, and a stale one is worse than a slow one.
  useEffect(() => {
    if (!picking || candidates) return;
    let live = true;
    getAssignCandidates(item.id)
      .then((r) => { if (live) setCandidates(Array.isArray(r) ? r : (r?.candidates || [])); })
      .catch((e) => { if (live) onError?.(e); });
    return () => { live = false; };
  }, [picking, candidates, item.id, onError]);

  const run = useCallback(async (fn) => {
    setWorking(true);
    try { await fn(); setCandidates(null); setPicking(false); onDone?.(); }
    catch (e) { onError?.(e); }
    finally { setWorking(false); }
  }, [onDone, onError]);

  const deploy = async () => {
    // FIRST the task, THEN the confirmation — see rule 2.
    const task = await showPrompt(
      `What should the zee do for “${item.title}”?`,
      { okLabel: 'Next', defaultValue: item.title || '', placeholder: 'the brief this worker starts from' });
    if (task === null) return;                       // cancelled at the wording step
    const ok = await showConfirm(
      `Deploy a worker onto “${item.title}”?\n\n`
      + 'This SPAWNS A REAL ZEE: the queenzee claims a xell, starts an agent in it and it begins '
      + 'working immediately. It is not a draft and it cannot be un-started — you would have to '
      + 'stop the zee afterwards.\n\nThe item is assigned to that xell and its card starts moving '
      + 'with the zee.',
      { okLabel: 'Deploy a worker', variant: 'danger' });
    if (!ok) return;
    await run(() => deployWorkItem(item.id, { task: task.trim() || undefined }));
  };

  // ── somebody is on it ──
  if (zee) {
    return (
      <span className="work-zeeslot">
        <ZeeChip zee={zee} />
        <button className="work-mini" disabled={disabled} title="take this xell off the item (the zee keeps running)"
                onClick={() => run(() => unassignWorkItem(item.id))}>unassign</button>
      </span>
    );
  }

  // ── nobody is on it ──
  const wasSlug = item.xell_id ? lastAssignedSlug(events) : null;
  return (
    <span className="work-zeeslot">
      {item.xell_id && (
        <span className="work-was" title={'This item still names the xell it was assigned to, but that xell '
          + 'is gone — so it lends the item no live status. Kept as provenance, from the ledger.'}>
          was: {wasSlug || 'a reaped xell'}
        </span>
      )}
      {!picking && (
        <>
          <button className="work-mini" disabled={disabled} onClick={() => setPicking(true)}>＋ assign</button>
          <button className="work-mini hot" disabled={disabled} onClick={deploy}
                  title="Spawn a NEW zee to work this item — a real agent, started immediately">
            ⇗ deploy a worker
          </button>
        </>
      )}
      {picking && (
        <span className="work-cands">
          {candidates === null && <span className="work-muted">looking for xells…</span>}
          {candidates?.length === 0 && <span className="work-muted">no xell can take this right now</span>}
          {(candidates || []).map((c) => (
            <button key={c.xell_id || c.id} className="work-cand" disabled={disabled}
                    onClick={() => run(() => assignWorkItem(item.id, c.xell_id || c.id))}>
              <b>{c.slug || c.name || c.xell_id}</b>
              {/* the server's OWN 'why' line — the console does not paraphrase it */}
              {c.why && <small>{c.why}</small>}
            </button>
          ))}
          <button className="work-mini" onClick={() => setPicking(false)}>cancel</button>
        </span>
      )}
    </span>
  );
}

// The slug the item was last assigned to, recovered from the ledger — the row itself keeps only the
// xell id, and an id is not something a human recognises.
//
// It keys off the SLUG IN `detail`, not off the event kind: an assignment is the only event that
// records one, so "the last event that named a xell" is exactly the fact wanted, and it keeps this
// working if the ledger ever records a slug under another verb (a deploy, say). Scanning to the last
// match rather than the first means either ordering of `events` gives the most recent answer.
export function lastAssignedSlug(events) {
  let slug = null;
  for (const ev of events || []) {
    const d = ev?.detail;
    if (!d || typeof d === 'string') continue;
    if (d.xell_slug || d.slug) slug = d.xell_slug || d.slug;
  }
  return slug;
}

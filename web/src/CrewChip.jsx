import React from 'react';
import { crewLinks, isManagerXell, relationTag } from './hive/crew.js';

// ── the manager↔crew relation, in a LIST ──────────────────────────────────────
// A card list is a different PROJECTION from the honeycomb, and the cue that works there does not
// transfer. The hexes, the connector wires and the graph's commit dots all mark what is related to the
// thing you are POINTING AT: there is exactly one focus, so a transient dash is the right answer. A
// list has no focus — it is scanned, top to bottom, and "whose crew is this?" is asked of every row at
// once. So here the relation is a PERSISTENT WORD on the row instead of a highlight on some of them:
//
//   a managed worker → ⬡ crew of wise-cove        a manager → ⬢ 3 crew   (⬢ no crew when it runs none)
//
// which also keeps the second rule for free: a word beside a row cannot be mistaken for the row being
// SELECTED, which in these lists is `.active`. The chip deliberately wears the same quiet language as
// the machine/env chips (muted, no accent fill) because a relationship is context, not a status.
//
// The relation itself comes from hive/crew.js like every other layer — LIVE crew only, so a reaped
// worker is not counted and a husk manager is never named as "who this reports to" — and relationTag
// owns the wording, so the list and the canvas say the same words.
//
// `links` is the crewLinks() result, computed ONCE per render by whoever renders the list (App), not
// per row: N rows re-deriving the same grouping is how the drift this whole relation was extracted to
// prevent gets back in.
export default function CrewChip({ x, links }) {
  const l = links || crewLinks([]);
  const crew = l.crewOf[x?.id] || [];
  const mgrId = l.managerOf[x?.id];
  const mgr = mgrId ? (l.byId?.get(mgrId) || null) : null;

  if (isManagerXell(x)) {
    return (
      <span className="crewchip" data-testid="crew-chip" data-crew="manager"
            title={crew.length
              ? `Runs ${crew.length} live crew: ${crew.map((w) => w.slug).join(', ')}`
              : 'A manager zee with no live crew — it has dispatched none, or they have all been reaped'}>
        {relationTag('manager').glyph} {crew.length ? `${crew.length} crew` : 'no crew'}
      </span>
    );
  }
  if (!mgrId) return null;                 // nobody dispatched this one — there is no relation to state
  const tag = relationTag('crew', mgr?.slug || null);
  return (
    <span className="crewchip" data-testid="crew-chip" data-crew="crew"
          title={`Dispatched by the manager zee ${mgr?.slug || mgrId} — this xell is part of its crew`}>
      {tag.glyph} {tag.long}
    </span>
  );
}

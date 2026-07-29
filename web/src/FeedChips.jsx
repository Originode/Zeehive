import React from 'react';

// The ✱ thinking / ⚒ moves toggles in the cxell terminal header — show/hide the two noisy halves
// of a zee's live feed.
//
// They shipped as bare `.term-chip`s and the first thing reported back was "it's too difficult to
// see if the buttons are pressed or not". That was fair, and it was a real defect:
//   • `.term-chip` styles a background and a border but NO colour — the queenzee-log chips it was
//     borrowed from always pass an inline per-scope colour, so these two inherited the browser's
//     default button colour and sat nearly unreadable on a dark panel;
//   • the only on/off signal was `opacity: .35` — one shade, on 11px monospace, on a toggle whose
//     effect you often cannot see in the pane (there may be no feed running to repaint).
//
// So the state is spelled out THREE independent ways, and the one that carries it is TEXT: a
// `shown`/`hidden` word, plus colour (accent vs muted), plus a strike through the label when
// hidden. Two of those three survive a bad screen, a colourblind reader, or a shrunken header —
// which matters more here than elsewhere, because a toggle nobody can read is a toggle that
// "doesn't work". `aria-pressed` says the same thing to a screen reader.
//
// Presentational and side-effect-free ON PURPOSE: no CSS import, no xterm, no websocket — so
// test/terminal-feed-chips.test.mjs can compile it and render the real markup for BOTH states
// instead of trusting a JSX read. Living in its own file is what makes that possible.
export default function FeedChips({ feed, onToggle }) {
  const live = feed.live;
  const chip = (key, glyph, label, what) => {
    const on = feed[key] !== false;
    return (
      <button type="button" data-testid={`feed-${key}`} aria-pressed={on}
              className={`feedchip ${on ? 'on' : 'off'}`}
              onClick={() => onToggle(key)}
              title={`${on ? 'Hide' : 'Show'} ${what} in the zee's live feed`
                     + (live === false
                        ? ' — no feed is streaming right now, so this is the view the next one starts in'
                        : ' (the feed redraws, including what already scrolled past)')}>
        <span className="fc-glyph">{glyph}</span>
        <span className="fc-label">{label}</span>
        {/* the word IS the state — never rely on the shade alone */}
        <span className="fc-state">{on ? 'shown' : 'hidden'}</span>
      </button>
    );
  };
  return (
    <span className="feedchips" data-testid="feed-filters">
      {chip('thinking', '✱', 'thinking', "the zee's thinking (the ✱ lines)")}
      {chip('moves', '⚒', 'moves', 'the detailed moves — every ⚒ tool call and its ↳ result')}
      {/* Say it out loud rather than leaving a click to land on nothing: while no feed is running
          the pane belongs to the interactive session, and a toggle only sets what the NEXT feed
          opens in. */}
      {live === false && (
        <span className="fc-idle" data-testid="feed-idle"
              title="The zee is not streaming a live feed right now (its turn ended, so the interactive session owns this pane). The chips set the view the next feed opens in.">
          no live feed
        </span>
      )}
    </span>
  );
}

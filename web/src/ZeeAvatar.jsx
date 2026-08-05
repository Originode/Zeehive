import React from 'react';
import { providerArtOf, avatarTitle } from './providerArt.js';
import { harnessGear, gearPathD, toneColor, GEAR_EXTENT } from './harnessGear.js';

// ZEE AVATAR (DOM) — the twin of the honeycomb's drawZeeAvatar, in HTML + SVG.
//
// Same rule, same two registries (providerArt.js / harnessGear.js), so a xell's card and its
// hexagon can never disagree: the AI PROVIDER is the coin, and the HARNESS is the COSTUME framed
// around it — wings for a scout, a hammer for a builder, a necktie for a manager, glasses across
// the face for a reviewer. The gear's shapes are ONE command list shared with the canvas; here they
// become an SVG `d`, there they become moveTo/lineTo/quadraticCurveTo.
//
// Two layers, because a costume is not a sticker: parts marked `behind` render in an SVG UNDER the
// coin (wings tuck behind it), the rest in an SVG over it (glasses sit on the face). Both svgs use
// the gear's own unit space — coin radius 1, art out to ±GEAR_EXTENT — so the box is exactly twice
// the art's reach and the coin lands dead centre at 1/GEAR_EXTENT of it.
//
// Give it whatever you have: a fleet xell row (`xell` — runtime_key/runtime_vendor + harness_key/
// harness_label/harness_glyph/harness_gear), or an explicit `provider` (a key, or a provider-token
// row) and/or `harness`. With no provider resolved it draws the harness alone, and with neither it
// renders nothing at all rather than an empty frame that means "some zee".
const VIEW = `${-GEAR_EXTENT} ${-GEAR_EXTENT} ${GEAR_EXTENT * 2} ${GEAR_EXTENT * 2}`;
const COIN_PCT = `${((1 - 1 / GEAR_EXTENT) / 2) * 100}%`;   // inset that leaves the coin radius = 1

function GearLayer({ gear, behind }) {
  const parts = (gear.art?.parts || []).filter((p) => !!p.behind === behind);
  if (!parts.length) return null;
  // a literal, not var(--error): toneColor() shades the hex for depth, and it cannot shade a CSS
  // variable — an EMPTY harness would come out flat where every other costume has tones
  const color = gear.empty ? '#e5554e' : gear.color;
  return (
    <svg className={`zav-gear ${behind ? 'zav-gear-back' : 'zav-gear-front'}`} viewBox={VIEW}
         aria-hidden="true" focusable="false">
      {parts.map((p, i) => (
        <path key={i} d={gearPathD(p)}
              fill={p.fill ? toneColor(color, p.fill) : 'none'}
              stroke={p.stroke ? toneColor(color, p.stroke) : 'none'}
              strokeWidth={p.stroke ? (p.width || 0.12) : undefined}
              strokeLinecap={p.stroke ? (p.cap || 'round') : undefined}
              strokeLinejoin={p.stroke ? 'round' : undefined} />
      ))}
      {/* the fallback ribbon is a nameplate — whatever glyph the harness authored is written on it */}
      {!behind && gear.art?.glyphOn && gear.mark && (
        <text x={gear.art.glyphOn[0]} y={gear.art.glyphOn[1]} className="zav-plate"
              textAnchor="middle" dominantBaseline="central" fontSize="0.62">{gear.mark}</text>
      )}
    </svg>
  );
}

export default function ZeeAvatar({ xell = null, provider = null, harness = null, size = 26,
                                    title = null, className = '', ...rest }) {
  const art = providerArtOf(provider || xell);
  const gear = harnessGear(harness || (xell && (xell.harness_key || xell.harness_label) ? xell : null));
  if (!art && !gear) return null;
  return (
    <span className={`zav${className ? ` ${className}` : ''}`} data-testid="zee-avatar"
          data-provider={art?.key || ''} data-harness={gear?.key || ''} data-gear={gear?.gear || ''}
          style={{ '--zav-size': `${size}px` }}
          title={title || avatarTitle(art, gear)} {...rest}>
      {gear && <GearLayer gear={gear} behind />}
      {/* the coin's inset is DERIVED from GEAR_EXTENT, not typed into the stylesheet: the costume
          reaches GEAR_EXTENT coin-radii, so widening the art's reach must move the coin with it */}
      <span className="zav-coin" style={{ inset: COIN_PCT,
                                          background: art?.coin || 'var(--panel2, #161b24)',
                                          borderColor: art?.color || gear?.color || 'var(--line)' }}>
        {art
          ? <img src={art.logo} alt={art.label} draggable="false" />
          /* no provider resolved → the harness is the face, as its INITIAL: its glyph belongs to the
             costume, and one mark twice reads as two marks (drawZeeAvatar does the same) */
          : <span className="zav-mono">{gear.label[0].toUpperCase()}</span>}
      </span>
      {gear && <GearLayer gear={gear} behind={false} />}
    </span>
  );
}

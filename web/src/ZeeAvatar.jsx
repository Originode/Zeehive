import React from 'react';
import { providerArtOf, avatarTitle } from './providerArt.js';
import { harnessGear, gearPathD, toneColor, GEAR_EXTENT } from './harnessGear.js';

// ZEE AVATAR (DOM) — the twin of the honeycomb's drawZeeAvatar, in HTML + SVG.
//
// Same rule, same two registries (providerArt.js / harnessGear.js), so a xell's card and its
// hexagon can never disagree: the AI PROVIDER is the coin, and the HARNESS is the COSTUME framed
// around it. A harness may wear UP TO THREE accessories (border / hat / equipment); each category
// lands in a different place relative to the coin:
//   • border    — frames the coin, painted UNDER it
//   • equipment — tools and face gear; parts marked `behind` go under the coin, the rest over
//   • hat       — sits on TOP of the coin, always in front
// Custom SVG accessories (pasted in the harness manager) stamp in as images in the same slots.
//
// Give it whatever you have: a fleet xell row (`xell` — runtime_key/runtime_vendor + harness_key/
// harness_label/harness_glyph/harness_gear/harness_accessories), or an explicit `provider` and/or
// `harness`. With no provider resolved it draws the harness alone, and with neither it renders
// nothing at all rather than an empty frame that means "some zee".
const VIEW = `${-GEAR_EXTENT} ${-GEAR_EXTENT} ${GEAR_EXTENT * 2} ${GEAR_EXTENT * 2}`;
const COIN_PCT = `${((1 - 1 / GEAR_EXTENT) / 2) * 100}%`;   // inset that leaves the coin radius = 1

function PathLayer({ items, behind, color }) {
  const paths = [];
  for (const acc of items) {
    const parts = (acc.art?.parts || []).filter((p) => {
      // hats are always front; borders always behind; equipment honours the flag
      if (acc.category === 'hat') return !behind;
      if (acc.category === 'border') return behind;
      return !!p.behind === behind;
    });
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      paths.push(
        <path key={`${acc.key}-${behind ? 'b' : 'f'}-${i}`} d={gearPathD(p)}
              fill={p.fill ? toneColor(color, p.fill) : 'none'}
              stroke={p.stroke ? toneColor(color, p.stroke) : 'none'}
              strokeWidth={p.stroke ? (p.width || 0.12) : undefined}
              strokeLinecap={p.stroke ? (p.cap || 'round') : undefined}
              strokeLinejoin={p.stroke ? 'round' : undefined} />,
      );
    }
    // ribbon nameplate (legacy single-gear fallback still carries glyphOn)
    if (!behind && acc.art?.glyphOn && acc.mark) {
      paths.push(
        <text key={`${acc.key}-mark`} x={acc.art.glyphOn[0]} y={acc.art.glyphOn[1]} className="zav-plate"
              textAnchor="middle" dominantBaseline="central" fontSize="0.62">{acc.mark}</text>,
      );
    }
  }
  if (!paths.length) return null;
  return (
    <svg className={`zav-gear ${behind ? 'zav-gear-back' : 'zav-gear-front'}`} viewBox={VIEW}
         aria-hidden="true" focusable="false">
      {paths}
    </svg>
  );
}

// Custom SVG stamps — positioned by category so a freeform paste lands where a path accessory would.
function CustomStamps({ items, behind }) {
  const stamps = items.filter((a) => a.custom && a.svg).filter((a) => {
    if (a.category === 'hat') return !behind;
    if (a.category === 'border') return behind;
    return !behind; // equipment customs sit in front
  });
  if (!stamps.length) return null;
  return (
    <span className={`zav-custom ${behind ? 'zav-custom-back' : 'zav-custom-front'}`} aria-hidden="true">
      {stamps.map((a) => (
        <img key={a.key}
             className={`zav-custom-img zav-custom-${a.category}`}
             alt="" draggable="false"
             src={`data:image/svg+xml;utf8,${encodeURIComponent(a.svg)}`} />
      ))}
    </span>
  );
}

export default function ZeeAvatar({ xell = null, provider = null, harness = null, size = 26,
                                    title = null, className = '', ...rest }) {
  const art = providerArtOf(provider || xell);
  const src = harness || (xell && (xell.harness_key || xell.harness_label) ? xell : null);
  const gear = harnessGear(src);
  if (!art && !gear) return null;
  const color = gear?.empty ? '#e5554e' : (gear?.color || '#c8d3e8');
  // Attach mark onto the accessory that carries glyphOn (ribbon), so the nameplate still writes.
  const items = (gear?.accessories || []).map((a) => (
    a.art?.glyphOn ? { ...a, mark: gear.mark } : a
  ));
  const accKeys = items.map((a) => a.key).join(',');
  return (
    <span className={`zav${className ? ` ${className}` : ''}`} data-testid="zee-avatar"
          data-provider={art?.key || ''} data-harness={gear?.key || ''} data-gear={gear?.gear || ''}
          data-accessories={accKeys}
          style={{ '--zav-size': `${size}px` }}
          title={title || avatarTitle(art, gear)} {...rest}>
      {gear && <CustomStamps items={items} behind />}
      {gear && <PathLayer items={items} behind color={color} />}
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
      {gear && <PathLayer items={items} behind={false} color={color} />}
      {gear && <CustomStamps items={items} behind={false} />}
    </span>
  );
}

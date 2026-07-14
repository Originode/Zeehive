// Deterministic codename for a WORKING zee. Only working zees are named; the name is
// derived from the zee id so it stays stable while the zee works (no churn per tick).
const NAMES = [
  'Aria', 'Koa', 'Nova', 'Juno', 'Rhea', 'Milo', 'Zara', 'Enzo', 'Lyra', 'Otis',
  'Iris', 'Cato', 'Vera', 'Nico', 'Sage', 'Bran', 'Wren', 'Idris', 'Faye', 'Rune',
  'Dara', 'Quill', 'Onyx', 'Pax', 'Skye', 'Thane', 'Umi', 'Vail', 'Wyn', 'Yara',
  'Zeph', 'Ember', 'Fable', 'Gale', 'Halo', 'Indra', 'Jett', 'Kai', 'Lux', 'Mira',
];

export function codenameFor(id) {
  const s = String(id);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return NAMES[(h >>> 0) % NAMES.length];
}

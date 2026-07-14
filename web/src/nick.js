// Deterministic 3-hex nickname for a container (so we don't render the long full name).
export function nick(name) {
  const s = String(name || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).slice(0, 3).toUpperCase().padStart(3, '0');
}

// PER-XELL IDENTITY TOKEN — the credential a CXELLD zee presents to the queenzee's /api/xell/self/*
// verbs so the server knows WHICH xell is calling and scopes every action to it.
//
// This is IDENTITY, not security: the cxell is the wall (default-DROP egress, no docker, no host fs),
// so the token does not have to be adversary-proof — it only has to name the caller. The queenzee
// stores just the SHA-256 HASH on the xell row (never the plaintext, mirroring provider-tokens.js);
// the plaintext exists only inside the cxell's environment as ZEEHIVE_XELL_TOKEN.
import { randomBytes, createHash } from 'node:crypto';
import { one } from '../db/pool.js';

export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');
export const mintToken = () => randomBytes(32).toString('hex');
// masked form for read models / logs — first/last few chars, like provider-tokens' hint()
export const tokenHint = (t) => (t ? `${String(t).slice(0, 6)}…${String(t).slice(-4)}` : null);

// Mint a fresh token for a xell, store its HASH, return the PLAINTEXT (the one time it leaves here —
// the caller injects it into the cxell env). Overwrites any prior token: a re-cxell xell re-identifies.
export async function mintXellToken(xellId) {
  const token = mintToken();
  await one(`UPDATE xell SET self_token_hash=$2 WHERE id=$1 RETURNING id`, [xellId, hashToken(token)]);
  return token;
}

// Resolve the xell a bearer token identifies, or null when it matches none. A plain hash lookup.
export async function xellForToken(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  return one(`SELECT * FROM xell WHERE self_token_hash=$1`, [hashToken(t)]);
}

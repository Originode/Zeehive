// QUARANTINE A PROVIDER ACCOUNT THAT ANSWERED 401 — pause it, offer its sibling, tell a human
// when none remains.
//
// WHY (ticket #50). tokenForSpawn picks the newest ACTIVE account of a provider deterministically,
// so an expired OAuth token on that account kills every dispatch on the provider until a human
// notices. Six zees died this way and none ever landed. The pause machinery (migration 104) and
// the paused-account skip in tokenForSpawn already exist; this module is the missing wire from
// an auth-terminal death back to the account the zee used (zee.provider_token_id).
//
// WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT:
//   • On a TERMINAL AUTH death (classifyTurnDeath → kind=terminal, signal=auth): PAUSE that
//     account with the vendor's verbatim sentence as the reason and `queenzee` as the actor.
//   • Return the next ACTIVE sibling of the same provider so the spawn path can fail over ONCE.
//   • Never auto-RESUME a quarantined account — that stays a human's click in Project setup.
//   • Never quarantine on a credential-VENDOR mismatch ("we handed the wrong vendor's key") —
//     that is refused before the cage is built (credentialVendorMismatch / TKT-51), and pausing
//     a healthy account because we paired it wrongly would be the exact failure this ticket was
//     held behind. The classifier here only runs on a death AFTER a correctly-paired spawn.
//   • Never quarantine on credit / account / model terminal deaths — those are not "this key is
//     bad"; a pause would hide a balance the human could top up, or an org the human could re-enable.
//
// PURE DECISION first (table-testable, no I/O), then the I/O half that pauses and finds a sibling.
// Same shape as lib/turn-death.js + the I/O that consumes it in queenzee/revive.js.

import { one } from '../db/pool.js';
import { logline } from './logbus.js';
import { setProviderAccountPaused, scrubSecrets } from './provider-tokens.js';

// → { quarantine: bool, failover: bool }
// failover means "a sibling MAY be tried" — the I/O half decides whether one actually exists.
export function decideAccountQuarantine({ kind = null, signal = null } = {}) {
  if (kind === 'terminal' && signal === 'auth') {
    return { quarantine: true, failover: true };
  }
  return { quarantine: false, failover: false };
}

// The next ACTIVE account of the same provider, excluding the one we just paused. Freshest
// first — the same order tokenForSpawn uses — so a failover lands on the account a bare
// dispatch would have picked next. Read-only (no last_used_at write).
export async function findActiveSibling(projectId, provider, excludeAccountId) {
  if (!projectId || !provider) return null;
  return one(
    `SELECT id, label, token_hint FROM provider_token
      WHERE project_id = $1 AND provider = $2 AND paused_at IS NULL
        AND ($3::uuid IS NULL OR id <> $3)
      ORDER BY created_at DESC LIMIT 1`,
    [projectId, provider, excludeAccountId || null]);
}

// PAUSE the account that answered 401 and report whether a healthy sibling remains.
// Best-effort and NEVER throws: it hangs off a death handler, and a zee's turn ending must not
// depend on this bookkeeping succeeding. Returns:
//   { acted:false, reason }                         — not an auth-terminal death, or no account id
//   { acted:true, paused, accountId, accountLabel,
//     siblingId, siblingLabel, noSibling }          — quarantine attempted
export async function quarantineOnAuthDeath({
  projectId,
  accountId = null,
  provider = null,
  reason = '',
  kind = null,
  signal = null,
  by = 'queenzee',
} = {}) {
  const decision = decideAccountQuarantine({ kind, signal });
  if (!decision.quarantine) {
    return { acted: false, reason: 'not an auth-terminal death — left alone' };
  }
  if (!projectId || !accountId) {
    return { acted: false, reason: 'no account to quarantine (zee.provider_token_id was null)' };
  }

  const scrubbed = scrubSecrets(String(reason || '').replace(/\s+/g, ' ')).slice(0, 500);
  const pauseReason = scrubbed
    ? `auth-terminal: ${scrubbed}`
    : 'auth-terminal: the vendor rejected this account\'s credential';

  let paused = false;
  let accountLabel = null;
  try {
    const row = await setProviderAccountPaused(projectId, accountId, true, {
      by, reason: pauseReason,
    });
    paused = !!row?.paused;
    const labelled = await one(
      `SELECT label FROM provider_token WHERE id = $1`, [accountId]).catch(() => null);
    accountLabel = labelled?.label || null;
    logline('quarantine',
      `paused ${provider || 'provider'} account ${accountLabel ? `"${accountLabel}"` : accountId.slice(0, 8)} `
      + `(by ${by}) — ${pauseReason.slice(0, 160)}`);
  } catch (e) {
    logline('quarantine',
      `could not pause account ${String(accountId).slice(0, 8)} (${String(e.message).slice(0, 140)})`);
    return { acted: false, reason: `pause failed: ${String(e.message).slice(0, 160)}`,
             accountId, error: e.message };
  }

  let sibling = null;
  if (decision.failover && provider) {
    sibling = await findActiveSibling(projectId, provider, accountId).catch(() => null);
  }

  return {
    acted: true,
    paused,
    accountId,
    accountLabel,
    provider,
    siblingId: sibling?.id || null,
    siblingLabel: sibling?.label || null,
    noSibling: !sibling?.id,
  };
}

export default {
  decideAccountQuarantine,
  findActiveSibling,
  quarantineOnAuthDeath,
};

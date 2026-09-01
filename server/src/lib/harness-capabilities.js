// HARNESS CAPABILITIES — the effective-chain gate (provision-proof plan §7.2, stage 3).
//
// A harness carries an ALLOWLIST of capability grants in the capabilities COLUMN (237) — never a
// bundle field, because the bundle authoring surface (personality/skills/memory) must stay
// structurally unable to express a grant. The route gate (`/api/xell/self/infra/*`), the dispatch
// bind (intake.js) and the seal-time firewall opening all ask the same question: does the CALLING
// xell's effective harness chain carry a capability? That question lives here, once, so a second
// copy of the walk is never where the answers start to disagree.
//
// The walk mirrors effectiveHarness(): follow parent_id with `AND enabled`, root-first. A harness
// INHERITING the grant counts; a DISABLED ancestor grants nothing. Only the capabilities COLUMN is
// read — the bundle is never consulted (that non-override is load-bearing).
import { one } from '../db/pool.js';

export const INFRA_CAPABILITY = 'infra-troubleshoot';

// The effective capabilities of a xell's worn harness chain. `xellId` must exist (callers gate on
// it). Depends only on pool.js — kept import-light so the seal callers can use it without pulling
// in the whole infra-medic surface.
export async function xellCapabilities(xellId) {
  const x = await one(`SELECT harness_id FROM xell WHERE id=$1`, [xellId]);
  if (!x?.harness_id) return [];
  const out = new Set();
  let cur = await one(`SELECT id, parent_id, capabilities FROM harness WHERE id=$1 AND enabled`, [x.harness_id]);
  let hops = 0;
  while (cur && hops++ < 32) {
    if (Array.isArray(cur.capabilities)) {
      for (const c of cur.capabilities) if (typeof c === 'string' && c) out.add(c);
    }
    if (!cur.parent_id) break;
    cur = await one(`SELECT id, parent_id, capabilities FROM harness WHERE id=$1 AND enabled`, [cur.parent_id]);
  }
  return [...out];
}

export async function hasInfraTroubleshoot(xellId) {
  return (await xellCapabilities(xellId)).includes(INFRA_CAPABILITY);
}

// The gate the routes call. Refuses (403) when the calling xell's effective chain does not carry the
// capability — a plain worker or a manager without the medic's grant can neither read nor raise.
export async function requireInfra(xell) {
  if (!(await hasInfraTroubleshoot(xell.id))) {
    const err = new Error(`the calling xell's effective harness chain does not carry the `
      + `'${INFRA_CAPABILITY}' capability — /infra/* is the infra-medic's surface`);
    err.status = 403;
    throw err;
  }
}

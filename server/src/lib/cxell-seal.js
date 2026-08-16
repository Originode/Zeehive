// WHAT A CXELL'S FIREWALL DROPS — the ONE query, for every caller that seals a cage.
//
// The egress policy itself is docker/zeehive/cxell-firewall.sh: default ALLOW, DROP only the
// host:port pairs it is handed. This module answers WHICH pairs, and it exists because that answer
// was written out twice — in queenzee/intake.js (the spawn seal) and queenzee/self.js (the re-seal
// after a prod bind) — with a comment on the second copy saying "both copies of this query have to
// change together". A third caller arrived (queenzee/cxell-recover.js re-seals a cage the queenzee
// restarts after a host reboot), so the copies became the function they were describing.
//
// ⚠ THIS LIST IS host:port PAIRS ONLY, so a prod db registered ALIAS-ONLY (no host/host_port,
// reachable only by its docker network name — see lib/prod-readonly.js decideReaderAddress) is NOT
// in it. That is currently harmless, but only because TWO conditions hold together:
//   (a) an alias-only row publishes no host port, so there is no bridge-NAT path for a rule to
//       block in the first place — the thing this list exists to close does not exist for it; AND
//   (b) the ONLY container joined to that db's docker network is the prod-read-only MANAGER's cage,
//       joined deliberately by connectCxellToProdNetwork() and only for db-prod-readonly.
// If EITHER stops holding — a host_port is added to an alias-registered row, or anything else is
// joined to that network — the row belongs in the block list for every project except its own
// prod-bound one, and this query must stop filtering on host/host_port to find it.
import { q } from '../db/pool.js';

// The couplings that MEAN "this xell may reach its own project's production database": the human
// grant (db-shared-prod) and a manager's read-only bind (db-prod-readonly, whose SELECT-only role is
// theatre if the cage cannot open the socket at all).
export const PROD_REACHING_COUPLINGS = ['db-shared-prod', 'db-prod-readonly'];

// Every prod db in the fleet as host:port, MINUS this xell's own project's when the xell is bound to
// production. `prodBound` may be passed explicitly (self.js, after the bind is granted, where the
// row it reads is already stale); otherwise it is derived from the coupling.
export async function prodDbBlockList({ projectId, dbCoupling = null, prodBound = null } = {}) {
  const prodDbs = await q(
    `SELECT DISTINCT c.host AS host, c.host_port, c.project_id FROM container c
      WHERE c.tier='prod' AND c.role='db' AND c.host IS NOT NULL AND c.host_port IS NOT NULL`);
  const bound = prodBound === null ? PROD_REACHING_COUPLINGS.includes(dbCoupling) : !!prodBound;
  return prodDbs
    .filter((r) => !(bound && r.project_id === projectId))
    .map((r) => `${r.host}:${r.host_port}`);
}

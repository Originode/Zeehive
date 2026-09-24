// INFRA-PROPOSE MACHINE PRIORITY — the settings verb must be able to express the change that
// decides WHERE a project's next dev xell spawns, and must stop offering the one that does not.
//
// FOUND 2026-09-24 (Infra Medic, xell swift-ember-4a99d7), against the code:
//   * PROPOSE_WHITELIST offered `machines.<key>.dev_priority`, and the applier wrote
//     `UPDATE machine SET dev_priority` — the column migration 038 DEPRECATED with the comment
//     "Unread by current code".
//   * Every picker orders `machine_pool.dev_priority` DESC instead: machines.js listMachines (98),
//     poolMachines (115), devMachines (191) — and provision.js places a fresh spawn through
//     pickDevMachine (machines.js:341) → devMachines; intake.js:120 and build-readiness.js:483/532
//     order by the same column. The only reader of machine.dev_priority in the tree is
//     infra-medic.js's own display ORDER BY.
//   * So a card that read as "raise this machine's priority" was accepted, applied, entered in the
//     receipt as `applied: 1 change(s)`, and moved NO spawn — while the write that matters
//     (machine_pool.dev_priority) could not be expressed at all.
//
// This test pins the OUTCOME BY BEHAVIOUR, never by row contents: a priority change is proposed,
// a human approves it, and the machine the PICKER returns for the next fresh spawn must have
// moved. An assertion that `UPDATE machine SET dev_priority` took effect would pass against the
// bug and prove nothing; and #5 below asserts the inert column did NOT change, so a future
// implementation cannot satisfy this test by making placement read the deprecated one.
//
// REAL postgres against DATABASE_URL (a clone / the db-sandbox, migrated). Fixtures are
// self-namespaced and removed in a finally, whatever happens.
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { q, one, pool } = await import('../server/src/db/pool.js');
const { infraPropose, decideInfraRequest } = await import('../server/src/lib/infra-medic.js');
const { pickDevMachine, devMachines } = await import('../server/src/lib/machines.js');

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const clean = [];
const cleanQ = (sql, p) => () => q(sql, p);

// A machine row as the console's "+ machine" would leave it: the cap is machine-wide, and the
// docker context is unique per machine. The deprecated dev_priority column stays at 0 — exactly
// what the estate's three machines carry.
const insMachine = async (suffix, { maxXells = 5 } = {}) => {
  const key = `impp-${suffix}-${tag}`;
  const row = await one(
    `INSERT INTO machine (key, docker_ctx, can_build, max_xells, enabled)
     VALUES ($1,$2,false,$3,true) RETURNING *`, [key, `impp-ctx-${suffix}-${tag}`, maxXells]);
  clean.push(cleanQ(`DELETE FROM machine WHERE id=$1`, [row.id]));
  return row;
};

try {
  const projectId = (await one(
    `INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`,
    [`impp-p-${tag}`, `/tmp/impp-${tag}`])).id;
  clean.push(cleanQ(`DELETE FROM project WHERE id=$1`, [projectId]));
  const xourceId = (await one(
    `INSERT INTO xource (project_id, ref) VALUES ($1,'main') RETURNING id`, [projectId])).id;
  clean.push(cleanQ(`DELETE FROM xource WHERE id=$1`, [xourceId]));
  // The medic that asks. `decideInfraRequest` is the human's half; the capability gate that gets a
  // xell TO this verb is covered by test/infra-medic.test.mjs.
  const medic = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status)
     VALUES ($1,$2,$3,$4,'working') RETURNING *`,
    [projectId, xourceId, `impp-x-${tag}`, `spinoff/impp-x-${tag}`]);
  clean.push(cleanQ(`DELETE FROM xell WHERE id=$1`, [medic.id]));

  const mA = await insMachine('a');          // the machine the project currently avoids
  const mB = await insMachine('b');          // …and the one it prefers today
  await q(`INSERT INTO machine_pool (machine_id, project_id, pool_size, dev_priority) VALUES
             ($1,$3,1,1), ($2,$3,1,6)`, [mA.id, mB.id, projectId]);

  console.log('\n── baseline: the picker prefers B, on machine_pool priority alone ──');
  const before = await pickDevMachine(projectId);
  ok(before?.id === mB.id, `pickDevMachine → '${before?.key}' (machine_pool dev_priority 6 vs 1)`);
  ok((await one(`SELECT dev_priority FROM machine WHERE id=$1`, [mA.id])).dev_priority === 0,
     'the DEPRECATED machine.dev_priority column is 0 on every machine (as it is on the estate)');
  ok((await devMachines(projectId)).length === 2,
     'both machines are dev spawn targets for this project — so the order is what decides, not presence');

  console.log('\n── the card: raise A above B, the way the medic asked for it ──');
  const card = await infraPropose(medic, {
    change: { machine_pool: { [mA.key]: { dev_priority: 9 } } },
    reason: 'prefer A for this project',
  });
  ok(card.card?.kind === 'propose' && card.card?.status === 'pending',
     'a machine_pool dev_priority patch is EXPRESSIBLE — the card files PENDING, not a whitelist refusal');

  const applied = await decideInfraRequest(card.card.id, 'approve', 'human@test');
  ok(applied.status === 'completed', `the human's approval performs it [${applied.status}]`);
  ok(applied.result?.applied?.[0]?.field === `machine_pool.${mA.key}.dev_priority`,
     `the receipt names the (machine, project) field it changed [${applied.result?.applied?.[0]?.field}]`);

  console.log('\n── THE PIN: the machine a FRESH SPAWN lands on has moved ──');
  const after = await pickDevMachine(projectId);
  ok(after?.id === mA.id,
     `pickDevMachine → '${after?.key}' AFTER the change (was '${before?.key}') — placement moved, not just a row`);
  ok((await one(`SELECT dev_priority FROM machine WHERE id=$1`, [mA.id])).dev_priority === 0,
     "and the inert machine.dev_priority column is UNCHANGED — the picker reads machine_pool, which is the point");

  console.log('\n── the deprecated knob is REFUSED, and the refusal names the right one ──');
  let deprecated = null;
  try {
    await infraPropose(medic, { change: { machines: { [mB.key]: { dev_priority: 99 } } }, reason: 'x' });
  } catch (e) { deprecated = e; }
  ok(!!deprecated && /not on the whitelist/.test(deprecated.message),
     `machines.<key>.dev_priority no longer files a card that cannot move anything${deprecated ? ` [${deprecated.message.split('\n')[0].trim().slice(0, 120)}]` : ' — IT WAS ACCEPTED'}`);
  ok(!!deprecated && /machine_pool/.test(deprecated.message),
     'and the refusal says where the knob actually lives (machine_pool)');

  // The whitelist validates machines/machine_pool as MACHINE-KEYED sections; the applier always did.
  // The two disagreed, so BOTH shapes were dead: keyed was refused by the validator, flat was
  // accepted by it and could only fail at approval ("no machine 'max_xells' on the estate"). The
  // machines section is therefore asserted REACHABLE here, end to end — it is the same defect.
  console.log('\n── a machine-keyed section is reachable in the shape the APPLIER implements ──');
  const flatCard = await infraPropose(medic, {
    change: { machines: { max_xells: 3 } }, reason: 'flat shape',
  }).then(() => null).catch((e) => e);
  ok(!!flatCard && /keyed by MACHINE key/.test(flatCard.message),
     `a flat (setting-keyed) machines patch is refused when FILED, not filed-then-failed${flatCard ? ` [${flatCard.message.split('\n')[0].trim().slice(0, 110)}]` : ' — IT WAS ACCEPTED'}`);

  const capCard = await infraPropose(medic, {
    change: { machines: { [mB.key]: { max_xells: 4 } } }, reason: 'raise the cap on B',
  });
  const capApplied = await decideInfraRequest(capCard.card.id, 'approve', 'human@test');
  ok(capApplied.status === 'completed'
     && (await one(`SELECT max_xells FROM machine WHERE id=$1`, [mB.id])).max_xells === 4,
     'the machines section applies its real (read) field — it was unreachable in BOTH shapes before');

  console.log('\n── a machine with NO machine_pool row yet: the first priority is an INSERT ──');
  const mC = await insMachine('c');
  const firstCard = await infraPropose(medic, {
    change: { machine_pool: { [mC.key]: { dev_priority: 20 } } },
    reason: 'aim this project at C for the first time',
  });
  const firstApplied = await decideInfraRequest(firstCard.card.id, 'approve', 'human@test');
  ok(firstApplied.status === 'completed' && firstApplied.result?.applied?.length === 1,
     'the card completes (a bare UPDATE against a missing row would write zero rows and still say "applied"');
  const afterC = await pickDevMachine(projectId);
  ok(afterC?.id === mC.id,
     `pickDevMachine → '${afterC?.key}' — the project can be aimed at a host it never threw work at [${afterC?.key}]`);

  console.log('\n── invalid values are refused when the card is FILED, not at approval time ──');
  let negative = null;
  try {
    await infraPropose(medic, { change: { machine_pool: { [mC.key]: { dev_priority: -1 } } }, reason: 'x' });
  } catch (e) { negative = e; }
  ok(!!negative && /non-negative/.test(negative.message),
     `a negative dev_priority is refused at file time (machine_pool has CHECK >= 0)${negative ? ` [${negative.message.split('\n')[0].trim().slice(0, 100)}]` : ' — IT WAS ACCEPTED'}`);

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  for (const fn of clean.reverse()) { try { await fn(); } catch { /* */ } }
  await pool.end().catch(() => {});
}
process.exit(fail ? 1 : 0);

// PROD-DIFF REFERENCE SELECTION — the db chip's "Check diff" can now be measured against ANY db in
// the project, with PRODUCTION as the default. This exists to answer the question a chip cannot:
// "is THIS database drifted, or is EVERY database drifted the same way?" — the first thing worth
// asking when a db freshly restored from a prod dump still reports drift, because a difference every
// dev db shares is not a bad restore, it is the probe or the host's postgres/extension build.
//
// The invariant this test defends: `prod_diff` means DRIFT FROM PRODUCTION and nothing else. A
// comparison against a non-prod reference is REPORTED, never persisted — otherwise a curious
// dev↔dev comparison would repaint the chip that the whole fleet's drift colours (and the /ooney
// parity gate) are built on, with a number that has nothing to do with production.
//
// Runs the REAL lib against this xell's isolated postgres with NO docker daemon: the catalog probe
// resolves ok:false, so this asserts the DECISIONS (which db is measured against what, what is
// written, what the candidate list offers) — the part a daemon cannot change — plus diffPayload,
// which is pure and needs no daemon at all.
process.env.PRODDIFF_ENABLED = 'false';   // don't let the interval loop start under the test

const { q, one, pool } = await import('../server/src/db/pool.js');
const pd = await import('../server/src/queenzee/proddiff.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const NIL = '00000000-0000-0000-0000-000000000000';
const mkProject = async (tag) => (await one(
  `INSERT INTO project (name, repo_root, main_branch, db_name, db_user)
     VALUES ($1,$2,'main','zt','zt') RETURNING id`, [`zt-pdref-${tag}-${Date.now()}`, `/tmp/zt-pdref-${tag}`])).id;
const mkDb = async (projId, tier, tag, role = 'db') => (await one(
  `INSERT INTO container (project_id, role, tier, isolation, name)
     VALUES ($1,$4,$2,'shared',$3) RETURNING id`,
  [projId, tier, `zt_${tag}_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`, role])).id;
const diffOf = async (id) => (await one(`SELECT prod_diff FROM container WHERE id=$1`, [id]))?.prod_diff;

let projId, otherProj;
try {
  projId = await mkProject('a');
  otherProj = await mkProject('b');

  const prodDb = await mkDb(projId, 'prod', 'db_prod');
  const devDb = await mkDb(projId, 'dev', 'db_dev');
  const spinDb = await mkDb(projId, 'spinoff', 'db_spin');
  const appSrv = await mkDb(projId, 'dev', 'srv_dev', 'server');   // not a db — never a candidate
  const foreignDb = await mkDb(otherProj, 'dev', 'db_other');

  // ── the candidate list the submenu renders ───────────────────────────────────
  console.log('\n── diffCandidates: which db chips may I compare against? ──');
  const cand = await pd.diffCandidates(devDb);
  const ids = cand.candidates.map((x) => x.id);
  ok(cand.ok === true, 'a db container → { ok:true, candidates:[…] }');
  ok(ids[0] === prodDb, 'PRODUCTION is FIRST — it is the default reference');
  ok(cand.candidates[0].is_prod === true && cand.candidates[0].writes_chip === true,
    'the prod candidate is flagged is_prod + writes_chip (picking it repaints the chip)');
  ok(cand.candidates.slice(1).every((x) => x.writes_chip === false),
    'every NON-prod candidate says writes_chip:false (a report, not a verdict)');
  ok(ids.includes(spinDb), "another xell's db is offered (dev↔dev is the comparison that isolates the probe)");
  ok(!ids.includes(devDb), 'the container itself is NOT offered (nothing to diff)');
  ok(!ids.includes(appSrv), 'a non-db container is not offered');
  ok(!ids.includes(foreignDb), "another project's db is not offered");
  ok(cand.candidates.every((x) => x.name && x.tier && 'health' in x),
    'each candidate carries what a container CHIP renders from (name/tier/health)');
  const badCand = await pd.diffCandidates(NIL);
  ok(badCand.ok === false && /no such db/.test(badCand.error), 'unknown id → { ok:false, no such db }');

  // ── routing: which db is measured against which ──────────────────────────────
  console.log('\n── diffOneContainerAgainstProd(id, against): routing ──');
  const vsProd = await pd.diffOneContainerAgainstProd(devDb);
  ok(vsProd.reference?.id === prodDb && vsProd.reference?.is_prod === true,
    'no reference given → PRODUCTION is the default, and it is echoed back');

  const vsSpin = await pd.diffOneContainerAgainstProd(devDb, spinDb);
  ok(vsSpin.reference?.id === spinDb && vsSpin.reference?.is_prod === false,
    'an explicit reference is used, and echoed back as is_prod:false');
  ok(vsSpin.same_db !== true, 'a dev↔dev comparison is a REAL comparison, not short-circuited');

  const vsSelf = await pd.diffOneContainerAgainstProd(devDb, devDb);
  ok(vsSelf.ok === true && vsSelf.same_db === true && vsSelf.total === 0,
    'a db compared against ITSELF → same_db, total 0 (identical by identity)');

  const vsUnknown = await pd.diffOneContainerAgainstProd(devDb, NIL);
  ok(vsUnknown.ok === false && /no such reference db/.test(vsUnknown.error),
    'an unknown reference id → { ok:false, no such reference db }');

  const vsForeign = await pd.diffOneContainerAgainstProd(devDb, foreignDb);
  ok(vsForeign.ok === false && /another project/.test(vsForeign.error),
    "a reference from ANOTHER project → refused (a project's prod is its own ruler)");

  // Prod stays the ruler BY DEFAULT (measured against nothing), but an explicit reference is a
  // legitimate question — "what does production lack that this dev db has?" — and is answered.
  const prodDefault = await pd.diffOneContainerAgainstProd(prodDb);
  ok(prodDefault.same_db === true, 'PROD with no reference → still the ruler, measured against nothing');
  const prodVsDev = await pd.diffOneContainerAgainstProd(prodDb, devDb);
  ok(prodVsDev.same_db !== true, 'PROD with an explicit reference → a real comparison is made');

  // ── the invariant: only a PROD comparison may write prod_diff ────────────────
  console.log('\n── prod_diff is written by the PROD comparison alone ──');
  const sentinel = { ok: true, error: null, total: 7, kinds: {} };
  const stamp = async (id) => q(
    `UPDATE container SET prod_diff=$2::jsonb, prod_diff_at=now() WHERE id=$1`, [id, JSON.stringify(sentinel)]);

  await stamp(devDb);
  await pd.diffOneContainerAgainstProd(devDb, spinDb);
  ok((await diffOf(devDb))?.total === 7,
    'a dev↔dev comparison leaves the chip verdict UNTOUCHED (it is a report, not drift-from-prod)');

  await stamp(prodDb);
  await pd.diffOneContainerAgainstProd(prodDb, devDb);
  ok((await diffOf(prodDb))?.total === 7,
    'comparing PROD against a dev db never writes prod\'s own verdict (the ruler measures, it is not measured)');

  // ── diffPayload: the pure comparison (no daemon involved) ───────────────────
  console.log('\n── diffPayload: direction, truncation, schema rollup ──');
  const fpOf = (o) => ({ table: new Set(o.table || []), column: new Set(o.column || []), trigger: new Set(o.trigger || []) });
  const ref = fpOf({ table: ['core.a', 'core.b', 'legacy.old'], column: ['core.a.id:bigint'], trigger: [] });
  const mine = fpOf({ table: ['core.a', 'core.new'], column: ['core.a.id:integer'], trigger: [] });
  const p = pd.diffPayload(ref, mine, 60);
  ok(p.kinds.table.missing.includes('core.b') && p.kinds.table.missing.includes('legacy.old'),
    'MISSING = the reference has it, this db does not (the direction that breaks code)');
  ok(p.kinds.table.extra.includes('core.new'), 'EXTRA = this db has it, the reference does not');
  ok(p.kinds.column.missing_count === 1 && p.kinds.column.extra_count === 1,
    'a column whose TYPE differs is one missing + one extra (the fingerprint carries the type)');
  ok(p.total === 5, `total counts both directions across all kinds (${p.total})`);
  const rollup = Object.fromEntries(p.by_schema.map((s) => [s.schema, s]));
  ok(rollup.core.missing === 2 && rollup.core.extra === 2 && rollup.legacy.missing === 1,
    'by_schema rolls the differences up per schema — the line that names the culprit');
  ok(p.by_schema[0].schema === 'core', 'by_schema is ordered by how much drift the schema owns');

  // ── the same thing on a REAL catalog (this xell's postgres, no docker needed) ──
  // The fingerprints above are hand-built sets; these are read by the REAL exported Q probes from a
  // real schema, before and after it is changed. Fingerprint A stands in for the reference database
  // and B for the db being judged — which is exactly what a dev↔dev comparison is, and it proves the
  // probe SQL, the direction and the rollup against catalogs postgres actually produced.
  console.log('\n── a real catalog, before vs after (what the two probes really return) ──');
  const S = `pdref_${Date.now()}`;
  const realFp = async () => {
    const fp = {};
    for (const [kind, sql] of Object.entries(pd.Q)) {
      fp[kind] = new Set((await q(sql)).map((r) => Object.values(r)[0]).filter((x) => String(x).startsWith(`${S}.`)));
    }
    return fp;
  };
  try {
    await q(`CREATE SCHEMA "${S}"`);
    await q(`CREATE TABLE "${S}".location (id bigint, city varchar)`);
    await q(`CREATE TABLE "${S}".kitchen_claim (id bigint)`);        // the object the "dev" db will lack
    await q(`CREATE FUNCTION "${S}".tg() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$`);
    await q(`CREATE TRIGGER trg BEFORE INSERT ON "${S}".location FOR EACH ROW EXECUTE FUNCTION "${S}".tg()`);
    const refFp = await realFp();

    await q(`DROP TABLE "${S}".kitchen_claim`);                       // prod has it, this db does not
    await q(`CREATE TABLE "${S}".scratch (id bigint)`);               // this db has it, prod does not
    await q(`ALTER TABLE "${S}".location ALTER COLUMN id TYPE integer`);   // same column, different type
    await q(`DROP TRIGGER trg ON "${S}".location`);                   // a missing trigger is drift too
    const mineFp = await realFp();

    const real = pd.diffPayload(refFp, mineFp, 60);
    ok(real.kinds.table.missing.includes(`${S}.kitchen_claim`),
      'a table the reference has and this db does not is MISSING (the deployed-code-vs-no-table case)');
    ok(real.kinds.table.extra.includes(`${S}.scratch`), 'a table only this db has is EXTRA');
    ok(real.kinds.column.missing.includes(`${S}.location.id:bigint`)
       && real.kinds.column.extra.includes(`${S}.location.id:integer`),
      'a RETYPED column shows as one missing + one extra (the type is in the fingerprint)');
    ok(real.kinds.trigger.missing.includes(`${S}.location.trg`), 'a dropped TRIGGER is measured');
    ok(real.by_schema.length === 1 && real.by_schema[0].schema === S,
      'the rollup pins every difference to the one schema that owns it');
  } finally {
    await q(`DROP SCHEMA IF EXISTS "${S}" CASCADE`).catch(() => {});
  }

  const many = fpOf({ table: Array.from({ length: 30 }, (_, i) => `s.t${String(i).padStart(2, '0')}`) });
  const none = fpOf({});
  const small = pd.diffPayload(many, none);          // default (persisted) sample
  const big = pd.diffPayload(many, none, 60);        // on-demand detail sample
  ok(small.kinds.table.missing_count === 30 && small.kinds.table.missing.length === 8,
    'the PERSISTED payload keeps exact counts but only 8 names (it rides every SSE frame)');
  ok(small.by_schema === undefined, 'the persisted payload carries no by_schema (chip payloads stay small)');
  ok(big.kinds.table.missing.length === 30 && Array.isArray(big.by_schema),
    'the on-demand payload lists what a human is triaging with, and the schema rollup');
} finally {
  for (const p of [projId, otherProj]) {
    if (!p) continue;
    await q(`DELETE FROM container WHERE project_id=$1`, [p]);
    await q(`DELETE FROM project WHERE id=$1`, [p]);
  }
  await pool.end().catch(() => {});
}
console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);

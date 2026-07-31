// PROD-DIFF EXTENSION NOISE — regression for "a database freshly restored from a prod dump STILL
// shows massive drift". The culprit was `public.spatial_ref_sys` (and its columns): a PostGIS
// EXTENSION-owned table living in an application schema. proddiff's catalog probes excluded engine
// noise by SCHEMA NAME only, so an extension table outside the noise schemas was scored as real
// drift whenever the prod postgis build and the dev/NAS build install their extensions differently
// — which they always do. The fix re-applies the pg_depend deptype='e' rule (the one the file's
// comment always claimed) to relations, columns and triggers.
//
// This runs the REAL exported Q catalog SQL against this xell's live postgres. It builds the exact
// shape of the bug — an extension-OWNED table beside an app table in the same schema — using
// `ALTER EXTENSION plpgsql ADD TABLE`, which writes the identical pg_depend deptype='e' row PostGIS
// writes for spatial_ref_sys. No postgis needed; the marker is what proddiff keys on.
process.env.PRODDIFF_ENABLED = 'false';

const { q, pool } = await import('../server/src/db/pool.js');
const { Q } = await import('../server/src/queenzee/proddiff.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const SCHEMA = `pdext_${Date.now()}`;
const fp = async (kind) => new Set((await q(Q[kind])).map((r) => Object.values(r)[0]));

try {
  await q(`CREATE SCHEMA "${SCHEMA}"`);
  await q(`CREATE FUNCTION "${SCHEMA}".tg() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$`);

  // App-owned table (the core.location analogue) — a migration made it, so it MUST be measured.
  await q(`CREATE TABLE "${SCHEMA}".location (id bigint, city varchar, centroid text)`);
  await q(`CREATE TRIGGER trg_app BEFORE INSERT ON "${SCHEMA}".location FOR EACH ROW EXECUTE FUNCTION "${SCHEMA}".tg()`);

  // Extension-owned table (the public.spatial_ref_sys analogue). Its columns AND any trigger on it
  // are engine noise — implied by the extension set, owned by no migration.
  await q(`CREATE TABLE "${SCHEMA}".ext_srs (srid int, auth_name varchar)`);
  await q(`CREATE TRIGGER trg_on_ext BEFORE INSERT ON "${SCHEMA}".ext_srs FOR EACH ROW EXECUTE FUNCTION "${SCHEMA}".tg()`);
  await q(`ALTER EXTENSION plpgsql ADD TABLE "${SCHEMA}".ext_srs`);

  const tables = await fp('table');
  const columns = await fp('column');
  const triggers = await fp('trigger');

  console.log('\n── extension-owned objects are engine noise, never drift ──');
  ok(!tables.has(`${SCHEMA}.ext_srs`), 'extension-owned TABLE is excluded (the spatial_ref_sys false positive)');
  ok(![...columns].some((c) => c.startsWith(`${SCHEMA}.ext_srs.`)), 'its COLUMNS are excluded too');
  ok(!triggers.has(`${SCHEMA}.ext_srs.trg_on_ext`), 'a TRIGGER on an extension-owned table is excluded');

  console.log('\n── app-owned schema is still measured in full (no over-suppression) ──');
  ok(tables.has(`${SCHEMA}.location`), 'the app TABLE is still measured');
  ok([...columns].some((c) => c.startsWith(`${SCHEMA}.location.`)), 'its COLUMNS are still measured');
  ok(triggers.has(`${SCHEMA}.location.trg_app`), 'an app TRIGGER is still measured');
} finally {
  // Detach the table from the extension FIRST: a deptype='e' member left in place would make
  // DROP SCHEMA ... CASCADE follow the membership edge and drop plpgsql itself. Order matters.
  await q(`ALTER EXTENSION plpgsql DROP TABLE "${SCHEMA}".ext_srs`).catch(() => {});
  await q(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {});
  await pool.end().catch(() => {});
}
console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);

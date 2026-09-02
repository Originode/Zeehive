// THE MEDIC BAY — the medics' SEPARATE UI, checked statically (docs/medic-meta-plane-plan.md §5,
// DR-7; the prod-asks-console model: no browser and no linter in CI, so the wiring is asserted by
// reading the source, the way test/medic-bar-wiring.test.mjs does for the ⛑ button).
//
// The bug this guards is the whole reason stage 4 exists: a medic USED to be a zee in a xell, so it
// had a hexagon in the honeycomb and a human watched it there. On the meta plane it has no xell —
// which means that unless the Bay is mounted, fed and visible, a medic writing config rows into the
// meta-DB is INVISIBLE. Six contracts must hold:
//
//   1. the Bay exists as its own component and App.jsx RENDERS it (an import nothing renders is the
//      old needs-you-bar bug), fed a fleet-wide medics list App refreshes on medic stream events;
//   2. the API seam exists — list / detail / retire / message — and the stream carries 'medic' and
//      'medic-action', so a background loop's ledger grows while a human watches;
//   3. medics stay OUT of the xell surfaces: the honeycomb (hive/) knows nothing about medics, and
//      the Bay hides itself when there are no medic rows (an empty always-on strip trains eyes to
//      skip the one strip that must never be skipped);
//   4. one HEXAGON per medic, reusing hive/hex.js geometry — the fleet's visual language, its own
//      canvas — and every medic status the server can set has art (a status with no colour renders
//      as a lie);
//   5. the ledger and the ask are actually wired: verbatim SQL + REFUSED marks, retire → retireMedic,
//      answer → messageMedic (the only way an awaiting-human medic ever resumes from the console);
//   6. the console COPY tells the meta-plane truth — the ⛑ dispatch no longer says it puts a zee in
//      a xell, because that is precisely the behaviour that was removed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const bay = read('web/src/MedicBay.jsx');
const app = read('web/src/App.jsx');
const api = read('web/src/api.js');
const css = read('web/src/styles.css');
const hexjs = read('web/src/hive/hex.js');
const medics = read('server/src/lib/medics.js');

console.log('\n── 1. the Bay is its own component AND App renders it, fed a live list ──');
ok(/export default function MedicBay/.test(bay), 'MedicBay.jsx default-exports the component');
ok(/import\s+MedicBay\s+from\s+'\.\/MedicBay\.jsx'/.test(app), 'App.jsx imports it');
const mount = app.match(/<MedicBay[\s\S]{0,300}?\/>/);
ok(!!mount, 'App.jsx RENDERS <MedicBay …/> (an import nothing renders is the old bug)');
ok(!!mount && /medics=\{medics\}/.test(mount[0]), '…fed the medics list');
ok(!!mount && /onOpenXell=\{setExpandedId\}/.test(mount[0]),
   '…and a jump seam, so a medic-dispatched WORKER opens its real hexagon (a worker IS a xell)');
ok(/const\s+\[medics,\s*setMedics\]\s*=\s*useState\(\[\]\)/.test(app), 'App owns the medics state');
ok(/listMedics\(\)/.test(app), 'App fills it from the /api/medics seam');
ok(/type === 'medic' \|\| type === 'medic-action'/.test(app),
   "App re-reads the list on 'medic'/'medic-action' stream events (a background loop must be watchable live)");

console.log('\n── 2. the API seam: list / detail / retire / message, and the stream types ──');
ok(/export const listMedics\s*=/.test(api) && /\/api\/medics/.test(api), 'listMedics → /api/medics');
ok(/export const getMedic\s*=[\s\S]{0,160}\/api\/medics\/\$\{id\}/.test(api), 'getMedic → /api/medics/:id (the panel)');
ok(/export const retireMedic\s*=[\s\S]{0,200}\/retire/.test(api), 'retireMedic → …/retire');
ok(/export const messageMedic\s*=[\s\S]{0,220}\/message/.test(api), 'messageMedic → …/message (the human answer)');
const st = api.match(/STREAM_TYPES[\s\S]*?\];/);
ok(!!st && /'medic'/.test(st[0]) && /'medic-action'/.test(st[0]),
   "STREAM_TYPES carries 'medic' and 'medic-action'");

console.log('\n── 3. medics are OUT of the xell surfaces, and the Bay hides when empty ──');
const hive = ['web/src/hive/HiveCanvas.jsx', 'web/src/hive/hex.js', 'web/src/hive/status.js',
              'web/src/hive/crew.js', 'web/src/hive/level.js'].map(read).join('\n');
ok(!/medic/i.test(hive),
   'the honeycomb (hive/*) never mentions a medic — it renders xell rows, and a medic has no xell');
ok(/if\s*\(!medics\.length\)\s*return null;/.test(bay), 'the Bay renders NOTHING when no medic rows exist');

console.log('\n── 4. one hexagon per medic, reusing the fleet geometry, art for every status ──');
ok(/import\s*\{[^}]*hexCorners[^}]*\}\s*from\s*'\.\/hive\/hex\.js'/.test(bay),
   'the Bay reuses hive/hex.js geometry (hexCorners) instead of re-deriving a hexagon');
ok(/export function hexCorners/.test(hexjs), '…and hive/hex.js still exports it');
ok(/medics\.map\(\([\s\S]{0,80}<MedicHex/.test(bay), 'one <MedicHex> per medic row');
ok(/<polygon/.test(bay), '…drawn as a polygon (a hexagon, not a chip)');
const statuses = (medics.match(/export const MEDIC_STATUSES = \[([\s\S]*?)\]/) || [, ''])[1]
  .match(/'([a-z-]+)'/g)?.map((s) => s.slice(1, -1)) || [];
ok(statuses.length >= 7, `the server declares ${statuses.length} medic statuses`);
const missing = statuses.filter((s) => !new RegExp(`'${s}':`).test(bay));
ok(missing.length === 0, `every server status has art in MEDIC_COLORS${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);

console.log('\n── 5. the ledger and the ask are wired ──');
ok(/medic-ledger/.test(bay) && /\{a\.statement\}/.test(bay),
   'the action ledger renders the statement VERBATIM (the driver\'s record of every write)');
ok(/REFUSED/.test(bay), '…and marks refusals (a refused write is the wall doing its job — it must be legible)');
ok(/retireMedic\(/.test(bay), 'retire is wired to retireMedic');
ok(/messageMedic\(/.test(bay), 'the answer box is wired to messageMedic (the only console resume for awaiting-human)');
ok(/needs_human_reason/.test(bay), '…and shows the medic\'s one-line ask');

console.log('\n── 6. the copy tells the meta-plane truth ──');
const toast = app.match(/handleDispatchMedic[\s\S]*?\}, \[/);
ok(!!toast && /no xell/i.test(toast[0]), 'the dispatch toast says the medic gets NO xell');
ok(!/you are an infra medic/i.test(app), 'no console copy briefs a zee as "an infra medic"');
ok(/not a zee in a xell|no xell, no cage|meta plane/i.test(app + bay),
   'the console names the plane a medic actually lives on');

console.log('\n── the Bay is styled (an unstyled strip is a strip nobody reads) ──');
for (const cls of ['.medic-bay ', '.medic-hex', '.medic-panel ', '.medic-ledger', '.medic-asking',
                   '.medic-reply', '.medic-transcript'])
  ok(css.includes(cls), `${cls.trim()} is styled`);

console.log(fail ? `\n${fail} FAILURE(S)\n` : '\nall good\n');
process.exit(fail ? 1 : 0);

// A DB CHIP'S TOOLTIP SAYS WHICH DATABASE IT IS — the URL and port a hovering operator reads.
//
// The chip matrix panel and every xell card render db containers through the SAME ContainerChip, so
// the "which database is this?" answer belongs on the chip — in its TOOLTIP, where a full URL fits
// (the compact box itself stays untouched; a URL is long and there is no room under the nick). The
// row's conn_ref (the URL it answers at) and host/host_port (its published address) travel from the
// fleet read model to the client; the tooltip carries the full URL + port. Absent an address (a
// fixable state — see db-dsn-needs-a-host) there is nothing to say: a GUESSED address would point
// at a silent wrong database.
//
// Renders the REAL ContainerChip with react-dom/server (the proddiff-schema-not-data precedent), so
// the tooltip is asserted where an operator actually reads it.
import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// ── 1. the fleet read model sends the address columns where chips render ───────────────────────
console.log('\n── the server sends the address a chip needs ──');
const fleet = read('server/src/lib/fleet.js');
ok(/c\.host, c\.host_port, c\.conn_ref/.test(fleet),
   'fleet.js ships host/host_port/conn_ref on the xell stack query (the xell db chip)');
ok(/c\.host, c\.host_port, c\.conn_ref/.test(fleet),
   'fleet.js ships host/host_port/conn_ref on the inventory query (the chip matrix panel)');
const proddiff = read('server/src/queenzee/proddiff.js');
ok(/c\.host, c\.host_port, c\.conn_ref/.test(proddiff),
   'the check-diff reference picker (also the REAL ContainerChip) gets the address too');

// ── 2. render the REAL chip ─────────────────────────────────────────────────────────────────────
console.log('\n── the chip a human reads ──');
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const tmp = resolve(here, '..', 'web/src/.db-chip-address.test-build.mjs');
writeFileSync(tmp, transformSync(read('web/src/Container.jsx'), { loader: 'jsx', format: 'esm' }).code
  .replace(/import[^\n]*\.\/(api|Dialog|nick)\.jsx?['"];?/g, (_m, mod) => ({
    api: 'const buildContainer=async()=>{},getDockerContexts=async()=>[],setContainerBuildCtx=async()=>{},'
       + 'decommissionContainer=async()=>{},checkContainerDiff=async()=>({}),duplicateProd=async()=>({});',
    Dialog: 'const showAlert=async()=>{},showConfirm=async()=>true;',
    nick: 'const nick=(n)=>String(n).slice(0,3);',
  }[mod] || '')));
let ContainerChip;
try {
  const mod = await import(`${tmp}?t=${process.pid}`);
  ContainerChip = mod.ContainerChip;
} finally { rmSync(tmp, { force: true }); }
ok(typeof ContainerChip === 'function', 'ContainerChip is exported and bundled');

const chip = (c) => renderToStaticMarkup(React.createElement(ContainerChip, { c }));

// A db with a published address: the TOOLTIP shows the full URL + port; the box stays unadorned.
const addr = chip({ id: 'c1', name: 'zeehive_db_dev_mardale_prod', role: 'db', tier: 'dev', health: 'up',
                    host: '10.2.0.16', host_port: 32768,
                    conn_ref: 'postgresql://zeehive@10.2.0.16:32768/zeehive' });
ok(/database: postgresql:\/\/zeehive@10\.2\.0\.16:32768\/zeehive/.test(addr),
   'the tooltip carries the full database URL (the conn_ref)');
ok(/port: 32768/.test(addr), '…and the port');
ok(!/data-testid="cdbaddr"/.test(addr), 'the chip BOX itself stays unadorned (no address line on the card)');

// A db with ONLY a conn_ref (a network-aliased db like the meta-db): the URL + parsed port.
const alias = chip({ id: 'c2', name: 'zeehive_meta_db', role: 'db', tier: 'prod', health: 'up',
                     conn_ref: 'postgresql://zeehive@meta-db:5432/zeehive' });
ok(/database: postgresql:\/\/zeehive@meta-db:5432\/zeehive/.test(alias),
   'a conn_ref-only db shows the URL in the tooltip');
ok(/port: 5432/.test(alias), 'and the tooltip port comes from the URL when no host_port is recorded');

// A non-db chip never gains a database tooltip.
const srv = chip({ id: 'c3', name: 'zeehive_spin_server_x', role: 'server', tier: 'spinoff', health: 'up' });
ok(!/database:/.test(srv), 'a server chip has no database tooltip line');

// A db with NO address (host/host_port/conn_ref all absent) must not crash and must not guess.
const bare = chip({ id: 'c4', name: 'zeehive_db_spin_x', role: 'db', tier: 'spinoff', health: 'up' });
ok(!/database:/.test(bare), 'a db with no recorded address shows no tooltip line (no guessed DSN)');

// ── 3. the chip's context menu can COPY the URL ────────────────────────────────────────────────
console.log('\n── the menu offers "Copy database URL" ──');
const chipSrc = read('web/src/Container.jsx');
ok(/Copy database URL/.test(chipSrc) && /data-testid="copy-db-url"/.test(chipSrc),
   'the db chip menu offers "Copy database URL" with a stable test id');
ok(/isDb && dbUrl\(c\)/.test(chipSrc),
   'the item appears only on a db that has an address (dbUrl), gated like the other db items');
ok(/dbUrl\(c\)[\s\S]{0,80}toClipboard\(t\)/.test(chipSrc),
   'it copies the SAME dbUrl() the tooltip shows — the menu can never offer a string the chip disagrees with');
ok(/toClipboard/.test(chipSrc) && /navigator\.clipboard/.test(chipSrc)
   && /execCommand\('copy'\)/.test(chipSrc),
   'the copy has the OS-clipboard fallback (textarea + execCommand) for an insecure http origin');
ok(/Copied!/.test(chipSrc) && /setCopied\(true\)[\s\S]{0,120}setTimeout/.test(chipSrc),
   'and a successful copy flips the item to "Copied!" for a moment');

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);

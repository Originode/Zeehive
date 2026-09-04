// DECOMMISSION CONFIRM — a word arms a database decommission, not only the full name.
//
// A database is the one container whose decommission asks for a typed word (its data is
// permanently deleted), and until now that word had to be the container's FULL NAME. On a shared
// dev db the name is `zeehive_db_dev_mardale_prod_ugreen_nas_local`-shaped — long enough that the
// confirmation was a copy-paste chore and a fat-finger trap. The gate exists to prove the click is
// deliberate, and the word "decommission" — the label of the very button being pressed — proves
// that as well as the name. This test pins the new rule: the full name STILL arms it (muscle
// memory), and the word arms it case-insensitively, while a wrong name is still refused.
import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// ── 1. the REAL Container.jsx arms a db decommission on the word or the name ───────────────────
console.log('\n── the decommission gate (bundled from the real Container.jsx) ──');
const tmp = resolve(here, '..', 'web/src/.decommission-word-confirm.test-build.mjs');
writeFileSync(tmp, transformSync(read('web/src/Container.jsx'), { loader: 'jsx', format: 'esm' }).code
  .replace(/import[^\n]*\.\/(api|Dialog|nick)\.jsx?['"];?/g, (_m, mod) => ({
    api: 'const buildContainer=async()=>{},getDockerContexts=async()=>[],setContainerBuildCtx=async()=>{},'
       + 'decommissionContainer=async()=>{},checkContainerDiff=async()=>({}),duplicateProd=async()=>({});',
    Dialog: 'const showAlert=async()=>{},showConfirm=async()=>true;',
    nick: 'const nick=(n)=>String(n).slice(0,3);',
  }[mod] || '')));
let dbDecommissionArmed;
try {
  const mod = await import(`${tmp}?t=${process.pid}`);
  dbDecommissionArmed = mod.dbDecommissionArmed;
} finally { rmSync(tmp, { force: true }); }
ok(typeof dbDecommissionArmed === 'function', 'dbDecommissionArmed is exported so the gate is testable');

const LONG = 'zeehive_db_dev_mardale_prod_ugreen_nas_local';
ok(dbDecommissionArmed('', LONG) === false, 'empty input does NOT arm the button');
ok(dbDecommissionArmed('   ', LONG) === false, 'whitespace-only input does NOT arm it either');
ok(dbDecommissionArmed('decommission', LONG) === true, 'the word "decommission" arms it');
ok(dbDecommissionArmed('Decommission', LONG) === true, '…case-insensitively (button-case "Decommission" works)');
ok(dbDecommissionArmed('  DECOMMISSION  ', LONG) === true, '…and padded with spaces');
ok(dbDecommissionArmed(LONG, LONG) === true, 'the full container name STILL arms it (muscle memory)');
ok(dbDecommissionArmed('some_other_db', LONG) === false, 'a WRONG name is still refused — the gate is not a formality');
ok(dbDecommissionArmed(null, LONG) === false && dbDecommissionArmed(undefined, LONG) === false,
   'absent input never arms it');

// ── 2. the console SAYS so, where the human reads it ────────────────────────────────────────────
console.log('\n── the confirmation panel a human reads ──');
const chip = read('web/src/Container.jsx');
ok(/dbDecommissionArmed\(typed, c\.name\)/.test(chip), 'the canConfirm line calls the armed helper for a db');
ok(/To confirm, type decommission/.test(chip), 'the label tells the human to type the word, not the name');
ok(/placeholder="decommission"/.test(chip), 'and the input placeholder offers the word');

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);

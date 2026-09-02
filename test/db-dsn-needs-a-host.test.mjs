// A DSN WITH NO HOST IS NOT A DSN — it is a poisoned one, and it travels.
//
// Found from inside a cxell (2026-08-03): a dev xell's own server container would not boot, and the
// reason was its DATABASE_URL — `postgresql://zeehive@null:32772/zeehive`. The database was
// listening the whole time; the string named a host called "null". `getaddrinfo ENOTFOUND null` is
// where it surfaces, and it surfaces in the WRONG PLACE every time: in the app tier at build, in a
// test run, inside a cage where the zee cannot see the container row it came from.
//
// It travels because a conn_ref is not read once. lib/machines.js writes it onto the container row
// when it provisions a machine's dev db; lib/provision.js copies that row's conn_ref into every
// xell's .zeehive.env as DATABASE_URL; the cxell driver copies THAT file into the cage. One
// interpolation of a null, and every xell on that database is unusable — with nothing anywhere
// saying which of the three places the address should have come from (machine.host_ip,
// project.dev_host_ip, DEV_HOST_IP).
//
// The rule this pins is the one lib/xell-db.js derivedTcpDsn already documents ("no address is a
// fixable state, a guessed one is a silent wrong database") and lib/prod-readonly.js
// decideReaderAddress already applies to production: NO HOST → NO DSN, and say what to fill in.
// This file holds the dev path to it.
//
// No database is needed: derivedTcpDsn is pure, and the machines.js half is asserted at the source
// (the composition it must NOT go back to is a one-line regression).
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

const { derivedTcpDsn } = await import('../server/src/lib/xell-db.js');

section('derivedTcpDsn — the rule itself');
ok(derivedTcpDsn({ host: '10.1.0.18', host_port: 32772 }, { user: 'zeehive', name: 'zeehive' })
   === 'postgresql://zeehive@10.1.0.18:32772/zeehive',
   'a published address composes the DSN it always did');
for (const [what, row] of [
  ['host null', { host: null, host_port: 32772 }],
  ['host undefined', { host: undefined, host_port: 32772 }],
  ['host empty', { host: '', host_port: 32772 }],
  ['no port', { host: '10.1.0.18', host_port: null }],
]) {
  ok(derivedTcpDsn(row, { user: 'zeehive', name: 'zeehive' }) === null,
     `${what} → null, never a string with "null"/"undefined" in the authority`);
}

section('the dev-db provisioner composes through it, so it cannot mint a hostless conn_ref');
const machines = readFileSync(join(ROOT, 'server', 'src', 'lib', 'machines.js'), 'utf8');
ok(/import \{ derivedTcpDsn \} from '\.\/xell-db\.js'/.test(machines),
   'lib/machines.js uses the shared composer');
ok(/const conn = derivedTcpDsn\(/.test(machines),
   'the dev db conn_ref is composed by it, not by a template literal');
ok(!/postgresql:\/\/\$\{dbUser\}@\$\{host\}/.test(machines),
   'the `postgresql://${dbUser}@${host}:…` interpolation that produced "@null:" is gone');
ok(/if \(!conn\)[\s\S]{0,400}host_ip/.test(machines),
   'a missing address is SAID, naming where the host should come from (machine.host_ip / dev_host_ip / DEV_HOST_IP)');
// the row is still recorded — a db that exists but has no published address is a fixable state,
// and losing the row would lose the container itself
ok(/conn_ref(?:, conn_pw)?, health\)[\s\S]{0,600}\$7/.test(machines),
   'the container row is still written (with a NULL conn_ref), so the db is not lost — only its address is missing');

section('every other DSN composition in the tree is a GUARDED one');
// Not a count — each remaining site is NAMED with the guard that makes it safe, so a guarded one is
// documented rather than merely tolerated, and a new unguarded one in a provisioner fails here.
const DSN_RE = /postgresql:\/\/[^`'"\n]*\$\{[^}]*host[^}]*\}/gi;
const hostDsnsIn = (rel) => [...readFileSync(join(ROOT, rel), 'utf8').matchAll(DSN_RE)].map((m) => m[0].slice(0, 60));
const GUARDED = {
  'server/src/lib/xell-db.js': 'derivedTcpDsn — returns null on a falsy host/port (the rule itself)',
  'server/src/lib/provision.js': "urlHost = devHost || 'localhost' — never falsy by construction",
  'server/src/lib/prod-readonly.js': 'built from decideReaderAddress, which fails closed without row.host',
};
for (const [rel, why] of Object.entries(GUARDED)) {
  ok(hostDsnsIn(rel).length >= 1, `${rel}: composes a DSN, and is safe because ${why}`);
}
const unguarded = ['server/src/lib/machines.js', 'server/src/lib/xell-prod.js', 'server/src/queenzee/intake.js']
  .flatMap((rel) => hostDsnsIn(rel).map((h) => `${rel}: ${h}`));
ok(unguarded.length === 0,
   `the provisioners compose through the guard, never by hand [${JSON.stringify(unguarded)}]`);

console.log(fail ? `\n${fail} FAILURE(S)` : '\nall good');
process.exit(fail ? 1 : 0);

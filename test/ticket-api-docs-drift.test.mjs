// TICKETING API DOC-DRIFT test — the integrator's document must describe the server that exists.
//
// docs/ticketing-api.md is read by somebody who is NOT in this repo: a zee (or a human) wiring
// omnibiz's helpdesk to /api/ext/v1 from another codebase, who cannot check a claim against the
// source. A doc that has drifted is worse than no doc — it sends that person to an endpoint that
// 404s, or tells them a content type is accepted when the server refuses it, and they have no way
// to know which of us is wrong.
//
// So the three facts a client actually codes against are checked against the code that serves them:
//
//   1. EVERY /ext/v1 route registered in api/routes.js appears in the doc's endpoint table, and
//      every endpoint the table claims is really registered (both directions — an endpoint that
//      quietly disappears is exactly as bad as one nobody documented);
//   2. every content type the server accepts (ATTACHMENT_TYPES) is listed, and nothing is listed
//      that the server would refuse;
//   3. the attachment limits printed in the doc are the constants the server enforces.
//
// This is a SOURCE test: no database, no server. It reads two files.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const doc = readFileSync(resolve(ROOT, 'docs/ticketing-api.md'), 'utf8');
const routes = readFileSync(resolve(ROOT, 'server/src/api/routes.js'), 'utf8');
const { ATTACHMENT_TYPES, attachmentLimits } = await import('../server/src/lib/ticket-attachments.js');

console.log('\n1. the endpoint table is the router');
const registered = [...routes.matchAll(/router\.(get|post|patch|delete)\('(\/ext\/v1[^']*)'/g)]
  .map((m) => `${m[1].toUpperCase()} /api${m[2]}`);
ok(registered.length >= 10, `the router registers ${registered.length} external endpoints`);
for (const r of registered) {
  ok(doc.includes(`\`${r}\``), `documented: ${r}`);
}
// …and nothing documented that is not served.
const claimed = [...doc.matchAll(/`(GET|POST|PATCH|DELETE) (\/api\/ext\/v1[^`]*)`/g)]
  .map((m) => `${m[1]} ${m[2]}`);
const unique = [...new Set(claimed)];
ok(unique.length > 0, `the doc names ${unique.length} endpoints`);
for (const c of unique) ok(registered.includes(c), `served: ${c}`);

console.log('\n2. the accepted content types are the allow-list');
for (const type of Object.keys(ATTACHMENT_TYPES)) {
  ok(doc.includes(`\`${type}\``), `listed: ${type}`);
}
// A type the doc offers that the server refuses costs an integrator a debugging session.
const listed = [...doc.matchAll(/`((?:image|text|application)\/[a-z0-9.+-]+)`/g)].map((m) => m[1]);
for (const t of [...new Set(listed)]) {
  ok(ATTACHMENT_TYPES[t] !== undefined, `accepted by the server: ${t}`);
}

console.log('\n3. the limits are the constants');
const lim = attachmentLimits();
const mb = (n) => Math.round(n / 1048576);
ok(doc.includes(`**${mb(lim.max_attachment_bytes)} MB** an attachment`),
  `attachment limit stated as ${mb(lim.max_attachment_bytes)} MB`);
ok(doc.includes(`**${mb(lim.max_ticket_bytes)} MB** and **${lim.max_attachments_per_ticket}** files`),
  `per-ticket limits stated as ${mb(lim.max_ticket_bytes)} MB / ${lim.max_attachments_per_ticket} files`);

console.log('\n4. the doc points at what proves it');
ok(doc.includes('test/ticket-api-external.test.mjs'), 'it names the test that drives the surface');
ok(/db-sandbox/.test(doc), 'and warns that the test writes — sandbox, not a database whose rows matter');

// The doc's header claims a console panel, and the whole key story depends on it: a human has to
// be able to MINT a key without curl, and a zee has to be able to SEE the evidence that arrived
// with a ticket. Both are one import away from silently disappearing in a refactor.
console.log("\n5. the console surface the doc claims");
const setup = readFileSync(resolve(ROOT, "web/src/ProjectSetup.jsx"), "utf8");
const tickets = readFileSync(resolve(ROOT, "web/src/work/Tickets.jsx"), "utf8");
const webApi = readFileSync(resolve(ROOT, "web/src/api.js"), "utf8");
ok(/function ApiKeysSection/.test(setup) && /<ApiKeysSection/.test(setup),
  "ProjectSetup.jsx defines AND renders the ticketing-key panel");
ok(/key: 'ticketapi'/.test(setup), "…on its own setup tab");
ok(/setMinted/.test(setup), "the minted plaintext is held for the human to copy (it is shown once)");
ok(/api-keys/.test(webApi), "web/src/api.js talks to the console key endpoints");
ok(/function Attachments/.test(tickets) && /<Attachments/.test(tickets),
  "the ticket window renders the evidence that arrived with a ticket");
ok(/external_ref/.test(tickets) && /t\.source/.test(tickets),
  "…and says where an externally-filed ticket came from");

console.log(fail ? `\n✗ ${fail} failed` : '\n✓ all good');
process.exit(fail ? 1 : 0);

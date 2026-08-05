// WHAT A ZEE IS TOLD ABOUT ITS CAGE MUST BE TRUE, AND MUST NOT NAME ONE VENDOR.
//
// Two claims sat in every zee's manual, read by every cage whatever CLI it runs:
//
//   • "an autonomous agent running `claude --bare`" — but the provider is chosen at dispatch and the
//     image carries claude, codex and kimi. A Codex zee opened the document its own briefing calls
//     authoritative and read that it was something else.
//   • "a default-DROP egress firewall. The only things you can reach are: `api.anthropic.com` …" —
//     false since 2026-07-19, when cxell-firewall.sh became `iptables -P OUTPUT ACCEPT` plus a DROP
//     for the fleet's live production databases. Together the two compound: a zee on OpenAI reads
//     that its cage admits one vendor's API and that vendor is not its own, and the honest reading
//     of that is "my provider is unreachable".
//
// The manual is a harness memory row (080), so the fix is migration 115 — and the risk of an
// anchored edit is that the anchor has MOVED, which a database this test cannot reach would only
// discover at boot. So the anchors are checked HERE, against the live text, wherever the live text
// is at hand:
//
//   • inside a cxell the queenzee injects the current manual at .zeehive/harness/memory/ — that file
//     IS the meta-DB's copy, so the anchors are asserted against it byte for byte, the replacement is
//     applied in JS, and the result is checked for what it must no longer say;
//   • on a host checkout there is no such file (it is git-ignored by design), so the structural half
//     runs alone and says so, rather than passing quietly on nothing.
//
// The rest is structure that holds anywhere: house rule 9's helpers (never a hand-rolled jsonb_set),
// a guard on every anchor, idempotence, and the repo-side copies of the same sentences — CLAUDE.md's
// network row and the CXELLD briefing intake.js builds, which house rule 8 requires to move with it.
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

const MIG = join(ROOT, 'db', 'migrations', '115_provider_agnostic_manual_egress_text.sql');
ok(existsSync(MIG), 'migration 115 is in the ledger');
const sql = readFileSync(MIG, 'utf8');

// ── the PL/pgSQL string literals, evaluated ─────────────────────────────────────────────────────
// `name text := 'a' || E'\nb' || 'c';` → the text a zee would actually read. Small on purpose: it
// only has to understand the two forms this migration uses, and a form it does not understand is a
// failure rather than a silently empty anchor.
function literal(name) {
  const m = new RegExp(`^\\s*${name}\\s+text\\s*:=\\s*([\\s\\S]*?);\\s*$`, 'm').exec(sql);
  if (!m) return null;
  let out = '';
  for (const rawPart of m[1].split('||')) {
    const part = rawPart.trim();
    let s = /^E'([\s\S]*)'$/.exec(part);
    if (s) { out += s[1].replace(/\\n/g, '\n').replace(/''/g, "'"); continue; }
    s = /^'([\s\S]*)'$/.exec(part);
    if (s) { out += s[1].replace(/''/g, "'"); continue; }
    return { unparsed: part };
  }
  return out;
}

const OLD = ['old_cli', 'old_net', 'old_doc', 'old_res'].map((n) => [n, literal(n)]);
const NEW = ['new_cli', 'new_net', 'new_doc', 'new_res'].map((n) => [n, literal(n)]);

section('the migration reads as an anchored, guarded, idempotent edit');
for (const [n, v] of [...OLD, ...NEW]) {
  ok(typeof v === 'string' && v.length > 20, `${n} is a literal this test can read [${String(v).slice(0, 40)}…]`);
}
ok(/harness_memory_get\('zee-base', 'cxell-zee-manual\.md'\)/.test(sql)
   && /harness_memory_put\('zee-base', 'cxell-zee-manual\.md', txt\)/.test(sql),
   'the worker manual is read and written BY PATH through 076’s helpers (house rule 9)');
ok(/harness_memory_get\('manager', 'memory\/manager-zee-manual\.md'\)/.test(sql)
   && /harness_memory_put\('manager', 'memory\/manager-zee-manual\.md', txt\)/.test(sql),
   '…and so is the manager manual, which repeats the same claim in its own words');
ok(!/jsonb_set/.test(sql),
   'nothing hand-rolls jsonb_set — the six migrations that did deleted a memory file out of a live meta-DB');
ok((sql.match(/RAISE NOTICE/g) || []).length >= 5 && /has moved/.test(sql),
   'every anchor that could have moved raises a NOTICE and leaves the text alone — never a half-edit');
ok(/IF hits = 0 THEN[\s\S]{0,200}RETURN;/.test(sql),
   'a manual that is already correct writes nothing (idempotent: this runs at every boot)');

section('the replacement says something true, and names no vendor');
const newNet = NEW.find(([n]) => n === 'new_net')[1];
const newCli = NEW.find(([n]) => n === 'new_cli')[1];
ok(/claude/.test(newCli) && /codex/.test(newCli) && /kimi/.test(newCli),
   'the opening line names the CLIs the cage actually carries, not one of them');
ok(!/api\.anthropic\.com/.test(newNet) && !/default-DROP/.test(newNet),
   'the egress paragraph no longer claims a default-DROP firewall or one vendor’s API');
ok(/cxell-firewall\.sh/.test(newNet),
   '…and points at the script that decides it, so the next reader can check rather than trust');
ok(/PRODUCTION databases/.test(newNet) && /bound you to one/.test(newNet),
   'it says what IS dropped, and the one binding that changes it');

section('the anchors match the LIVE manual');
const injected = join(ROOT, '.zeehive', 'harness', 'memory', 'cxell-zee-manual.md');
if (existsSync(injected)) {
  let live = readFileSync(injected, 'utf8');
  for (const [n, v] of OLD) {
    ok(live.includes(v), `${n} is present in the injected manual, byte for byte`);
  }
  for (const [i, [, v]] of OLD.entries()) live = live.replace(v, NEW[i][1]);
  ok(!/api\.anthropic\.com/.test(live), 'after the edit no vendor API is named as the cage’s limit');
  ok(!/default-DROP/.test(live), '…and the default-DROP claim is gone');
  ok(!/running `claude --bare`/.test(live), '…and no zee is told it is running a CLI it may not be');
  ok(!/`--bare` may not auto-load/.test(live) && /entry-point doc first/.test(live),
     '…and "read your instructions" no longer turns on a claude-only flag');
  ok(/Egress is OPEN, deliberately/.test(live) && /queenzee API/.test(live),
     'what replaces it still says the cage is a wall and the queenzee API is the one door');
} else {
  console.log('  … no injected manual in this tree (a host checkout) — the anchors are checked '
    + 'inside a cxell, where the queenzee writes the meta-DB’s own copy');
}

section('the repo-side copies of the same sentences moved with it (house rule 8)');
const claudeMd = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
ok(!/default-DROP egress: `api\.anthropic\.com`/.test(claudeMd),
   'CLAUDE.md’s network row no longer names one vendor’s API as the cage’s egress');
ok(/prod DBs\*\* are what is dropped/.test(claudeMd), '…it names what is actually dropped');
const intake = readFileSync(join(ROOT, 'server', 'src', 'queenzee', 'intake.js'), 'utf8');
ok(!/Nothing else on the network resolves/.test(intake),
   'the CXELLD briefing no longer tells a zee that nothing else on the network resolves');
ok(/Egress itself is open/.test(intake) && /prod databases are what is/.test(intake),
   '…and says what is true instead, in the same words as the manual');

section('116 re-syncs project_doc.body from the corrected CLAUDE.md');
const sync = join(ROOT, 'db', 'migrations', '116_project_doc_sync_claude_md.sql');
ok(existsSync(sync), 'the sync migration is in the ledger (the row generates AGENTS.md and 17 others)');
if (existsSync(sync)) {
  const body = /\$doc\$([\s\S]*)\$doc\$/.exec(readFileSync(sync, 'utf8'))?.[1];
  ok(body?.trim() === claudeMd.trim(),
     'what it embeds IS the committed CLAUDE.md — regenerate with scripts/sync-project-doc.mjs if this fails');
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nall good');
process.exit(fail ? 1 : 0);

// LAND THIS XELL'S WORK — push to the xource, wait for the human, push again. One command.
//
//   xell-land.mjs [--wait[=secs]] [--status] [--xell <id>]
//
// WHY THIS EXISTS: the gate declines your push and tells you to "re-run the SAME push once a human
// approves it" — and then gives you no way to know that ever happened. So a zee either sat blind
// until someone poked it, or re-pushed on a guess. The ship gate has had `xell-ship.mjs --wait`
// since 010; landing never got its half. This is that half.
//
// --wait blocks until it lands / is rejected. Run it in the BACKGROUND: its exit is your nudge
// (the harness re-invokes you when a background task finishes). Do NOT sit in a poll loop by hand.
//
// It is the same gated push either way — this is not a way around the gate, it is a way to stop
// staring at it. A human still decides, and nothing lands until they do.
import http from 'node:http';

const api = process.env.ZEEHIVE_API || 'http://localhost:4700';
const sid = process.env.CLAUDE_CODE_SESSION_ID || '';
const argv = process.argv.slice(2);
const waitArg = argv.find((a) => a === '--wait' || a.startsWith('--wait='));
const waitSecs = waitArg?.includes('=') ? Number(waitArg.split('=')[1]) || 3600 : 3600;
const statusOnly = argv.includes('--status');
const xi = argv.indexOf('--xell');
const explicit = xi >= 0 ? argv[xi + 1] : null;

const req = (method, p, obj) => new Promise((res, rej) => {
  const body = obj ? JSON.stringify(obj) : null;
  const r = http.request(`${api}${p}`, {
    method,
    headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
  }, (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res({ code: x.statusCode, body: b })); });
  r.on('error', rej); if (body) r.write(body); r.end();
});
const json = (r) => { try { return JSON.parse(r.body); } catch { return {}; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolveXell() {
  if (explicit) return { id: explicit, slug: explicit };
  if (!sid) { console.log('No CLAUDE_CODE_SESSION_ID and no --xell — cannot tell which xell you mean.'); process.exit(1); }
  const st = await req('GET', `/api/xell/status?session_id=${encodeURIComponent(sid)}`);
  if (st.code >= 400) { console.log(`No xell for this session (HTTP ${st.code}).`); process.exit(1); }
  const s = json(st);
  const id = s.xell?.id || s.xell_id;
  if (!id) { console.log('Could not resolve this session\'s xell.'); process.exit(1); }
  return { id, slug: s.xell?.slug || s.slug || '?' };
}

const x = await resolveXell();

if (statusOnly) {
  const r = await req('GET', `/api/land/status?xell=${encodeURIComponent(x.id)}`);
  const s = json(r);
  console.log(r.code >= 400 ? (s.error || 'no land request') : JSON.stringify(s, null, 2));
  process.exit(0);
}

// The push. Gated exactly as a hand-run `git push . HEAD:<ref>` is — same hook, same answer.
const p = await req('POST', `/api/xells/${x.id}/push`, { by: 'zee@xell-land' });
const r0 = json(p);
if (p.code >= 400) { console.log(`Push failed: ${r0.error || p.code}`); process.exit(1); }

if (r0.landed) {
  console.log(`\n  ✓ LANDED on ${r0.ref} @ ${String(r0.head).slice(0, 8)} — a human had already approved this sha.\n`);
  process.exit(0);
}

console.log(`\n  Push HELD by the gate — raised for a human in the ZEEHIVE console.`);
console.log(`  Your commits are safe on your branch. Nothing is lost; nothing lands until a human agrees.`);
if (!waitArg) {
  console.log('\n  Re-run with --wait (IN THE BACKGROUND) to be told when it lands, instead of');
  console.log('  guessing or polling by hand:  node scripts/xell-land.mjs --wait &\n');
  process.exit(0);
}

console.log(`  Waiting up to ${waitSecs}s. Tell your human it is waiting — nothing you do here speeds it up.\n`);

const deadline = Date.now() + waitSecs * 1000;
let last = '';
while (Date.now() < deadline) {
  await sleep(4000);
  let s;
  try { s = json(await req('GET', `/api/land/status?xell=${encodeURIComponent(x.id)}`)); }
  catch (e) { console.log(`  (status unreadable: ${e.message}) — retrying`); continue; }

  if (s.status !== last) { console.log(`  … ${s.status || 'unknown'}`); last = s.status; }

  if (s.status === 'pending') continue;             // a human has not looked yet

  if (s.status === 'rejected') {
    console.log(`\n  ✗ A human REJECTED this exact commit${s.decided_by ? ` (${s.decided_by})` : ''}.`);
    console.log('    Re-pushing it will not help. Do not amend to a new sha to get around it — talk to them.\n');
    process.exit(1);
  }

  if (s.status === 'landed') {
    console.log(`\n  ✓ LANDED on ${(s.ref || '').replace('refs/heads/', '')} @ ${String(s.new_sha).slice(0, 8)}.\n`);
    process.exit(0);
  }

  if (s.status === 'approved') {
    // Approved = the gate is now holding a decision for THIS exact sha, and it is spent on the
    // next push. So push again — that is the whole "re-run the SAME push" instruction, done for
    // you rather than left as a thing you had no way to time.
    console.log('  approved — re-pushing the same sha…');
    const again = json(await req('POST', `/api/xells/${x.id}/push`, { by: 'zee@xell-land' }));
    if (again.landed) {
      console.log(`\n  ✓ LANDED on ${again.ref} @ ${String(again.head).slice(0, 8)}.\n`);
      process.exit(0);
    }
    console.log(`  re-push did not land: ${(again.output || '').split('\n').filter(Boolean).pop() || 'unknown'}`);
    console.log('  (still waiting — the approval may have been spent, or the ref moved)');
  }
}

console.log(`\n  ✗ TIMEOUT after ${waitSecs}s — still waiting on a human. Your work is safe on the branch.\n`);
process.exit(1);

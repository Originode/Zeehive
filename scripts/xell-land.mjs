// LAND THIS XELL'S WORK — push to the xource, wait for the human, push again. One command.
//
//   xell-land.mjs [--wait[=secs]] [--status] [--withdraw [--reason "…"]] [--xell <id>]
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
const withdraw = argv.includes('--withdraw') || argv.includes('--clear');
const ri = argv.indexOf('--reason');
const reason = ri >= 0 ? argv[ri + 1] : null;
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

// UN-ASK a held landing. The other half of "a zee should never leave a card it no longer means":
// nothing lands, nothing is rejected, no sha is burned and the branch is untouched — the question
// simply stops being asked. Withdraw BEFORE you land again; do not stack requests.
if (withdraw) {
  const cur = json(await req('GET', `/api/land/status?xell=${encodeURIComponent(x.id)}`));
  if (!cur?.id) { console.log('Nothing to withdraw — this xell has no land request on record.'); process.exit(0); }
  // A HOLDING request is un-askable too (066): it is this zee's own ask and nobody has decided it,
  // so leaving the pattern is the zee's to do. A CLEARED one has already left it.
  if (cur.status !== 'pending' && !(cur.status === 'holding' && !cur.cleared)) {
    console.log(`Nothing to withdraw — the latest land request is '${cur.status}', not pending.`);
    console.log(cur.status === 'approved'
      ? '  It is APPROVED: a human decided it and the queenzee is landing it. That is not yours to retract.' : '');
    process.exit(0);
  }
  const w = await req('POST', `/api/land/requests/${cur.id}/withdraw`, { by: 'zee@xell-land', reason });
  const wj = json(w);
  if (w.code >= 400) { console.log(`Withdraw failed: ${wj.error || w.code}`); process.exit(1); }
  console.log(`\n  ✓ WITHDRAWN ${String(wj.new_sha).slice(0, 8)} — the card is off the human's screen and nothing`);
  console.log('    landed, was rejected or was reverted. `xell-land.mjs` again when the work is really ready.\n');
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

// THE HOLDING PATTERN (066) — the push was queued, not held for a human. One runway per ref: while
// another xell's landing is open on main, a second card would be a card that can never land (the
// first approval moves the ref and the second sha stops fast-forwarding). So we print the POSITION
// and exit — there is nothing to poll for, and waiting here would burn the full timeout on a
// decision nobody will ever be asked to make. That is exactly how this script used to fail on 'stale'.
const held0 = json(await req('GET', `/api/land/status?xell=${encodeURIComponent(x.id)}`));
if (held0?.status === 'holding' && !held0.cleared) {
  console.log(`\n  ⏳ HOLDING at position ${held0.holding_position || '?'}`
    + `${held0.holding_behind?.xell_slug ? ` behind ${held0.holding_behind.xell_slug}'s landing` : ''} — the runway takes ONE at a time.`);
  console.log('    Your push was NOT rejected and NOT dropped: it is recorded and queued, and your commits are safe.');
  console.log('    No card was raised for a human, deliberately. When the runway clears the queenzee RESUMES the zee');
  console.log('    and tells it to `zee sync` then `zee land`. Do not poll and do not re-push.\n');
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

  if (s.status === 'stale') {
    // main moved past this sha while we waited, so the request is dead — no approval can make a
    // non-fast-forward land. Do NOT keep waiting (this loop used to burn its full hour on it).
    console.log(`\n  ✗ STALE — ${(s.ref || 'main').replace('refs/heads/', '')} moved past ${String(s.new_sha).slice(0, 8)} while this waited.`);
    console.log('    Nothing is lost: your commits are still on your branch, and nothing was rewritten.');
    console.log('    Catch up onto current main, then land the NEW sha (a new decision is expected):');
    console.log('      zee sync   # merges current main into your branch — resolve any conflict, git add/commit');
    console.log('      zee land   # raises a FRESH request on the synced sha\n');
    process.exit(1);
  }

  if (s.status === 'holding') {
    // Queued behind another xell's landing (or just cleared to take the runway). Either way this is
    // NOT a decision a poll can catch — stop, and say what the next move is.
    if (s.cleared) {
      console.log('\n  ✈ CLEARED — the runway is free and this xell is next. Nothing was approved:');
      console.log('      zee sync   # the xell ahead landed, so main moved — merge it in');
      console.log('      zee land   # raises the FRESH request a human decides on\n');
      process.exit(1);
    }
    console.log(`\n  ⏳ HOLDING at position ${s.holding_position || '?'} — one landing per ref at a time; no card was raised.`);
    console.log('    The queenzee resumes the zee when the runway clears (`zee sync`, then `zee land`). Not waiting.\n');
    process.exit(0);
  }

  if (s.status === 'withdrawn') {
    console.log('\n  ✗ WITHDRAWN — this landing was un-asked; nobody is waiting on it any more.\n');
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

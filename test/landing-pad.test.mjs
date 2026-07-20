import { composePad } from '../server/src/queenzee/landingpad.js';
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const t = (n) => new Date(2026, 6, 20, 10, n).toISOString();  // minute n

// landings + ships interleaved in time, various statuses
const landings = [
  { id: 'l1', xell_id: 'xa', xell_slug: 'alpha', status: 'approved', requested_at: t(1), new_sha: 'aaaa1111', ref: 'refs/heads/main', commits: [1,2] },
  { id: 'l2', xell_id: 'xb', xell_slug: 'bravo', status: 'pending',  requested_at: t(3), new_sha: 'bbbb2222', ref: 'refs/heads/main', commits: [1] },
  { id: 'l3', xell_id: 'xc', xell_slug: 'charlie', status: 'landed', requested_at: t(0), new_sha: 'cccc3333', ref: 'refs/heads/main', commits: [1] },
].map((r) => ({ ...r, sha: r.new_sha }));
const ships = [
  { id: 's1', xell_id: 'xd', xell_slug: 'delta', status: 'shipping', requested_at: t(2), sha: 'dddd4444', reason: 'hot' },
  { id: 's2', xell_id: 'xe', xell_slug: 'echo',  status: 'approved', requested_at: t(4), sha: 'eeee5555', reason: null },
];

const pad = composePad({ landings, ships, merging: new Set() });

// chronological order by requested_at
const order = pad.items.map((i) => i.id);
ok(JSON.stringify(order) === JSON.stringify(['l3','l1','s1','l2','s2']), `chronological FIFO order: ${order.join(',')}`);

// phases
const byId = Object.fromEntries(pad.items.map((i) => [i.id, i]));
ok(byId.l3.phase === 'done', 'landed → done');
ok(byId.l1.phase === 'queued', 'approved landing (not merging) → queued');
ok(byId.s1.phase === 'processing' && byId.s1.processing, 'shipping → processing (spinner)');
ok(byId.l2.phase === 'awaiting-approval', 'pending → awaiting-approval');
ok(byId.s2.phase === 'queued', 'approved ship → queued');

// positions: numbered over in-flight items only (skip the done receipt), in FIFO order
ok(byId.l3.position === null, 'done receipt has no queue position');
ok(byId.l1.position === 1 && byId.s1.position === 2 && byId.l2.position === 3 && byId.s2.position === 4,
   `in-flight positions 1..4 in arrival order (l1=${byId.l1.position} s1=${byId.s1.position} l2=${byId.l2.position} s2=${byId.s2.position})`);

// processing is the shipping one; next is NOT marked while something processes
ok(pad.processing?.id === 's1', 'processing item is s1');
ok(!pad.items.some((i) => i.next), 'no "next up" flagged while something is on the pad');
ok(pad.active === 4, `active count = 4 (${pad.active})`);

// now with nothing processing: oldest queued becomes "next up"
const pad2 = composePad({ landings: [landings[0]], ships: [ships[1]], merging: new Set() });
const next = pad2.items.find((i) => i.next);
ok(pad2.processing === null, 'pad2 has nothing processing');
ok(next && next.id === 'l1', `oldest queued (l1) flagged next-up (${next?.id})`);

// merging set makes an approved landing show as processing (the ref-move flash)
const pad3 = composePad({ landings: [landings[0]], ships: [], merging: new Set(['xa']) });
ok(pad3.items[0].phase === 'processing', 'approved landing holding the merge lock → processing');

console.log(fail === 0 ? '\nALL PASSED ✓' : `\n${fail} FAILURE(S) ✗`);
process.exit(fail ? 1 : 0);

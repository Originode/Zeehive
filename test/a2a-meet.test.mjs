// A2A MEET — group chat rooms for zees (docs/zee-meet-plan.md, DR-1..DR-4).
//
// The human directive: "i want agents to be able to talk to each other via some sort of peer to
// peer a2a chat session like a group chat via a zee meet verb… zees can join and talk."
//
// What this test asserts, against a throwaway project in DATABASE_URL (skipped when unset — the
// same convention as the DB halves of the other a2a tests):
//
//   A. THE PURE SHAPE HELPERS (no database):
//      A1 meetCodeFor — the code is <slug-truncated>/<last-6-hex-of-id>, derived, never stored.
//      A2 parseMeetCode — a code parses to a slug hint + token; a full uuid is accepted.
//
//   B. THE ROOM LIFECYCLE, end to end (the human's flow):
//      B1 create: a founder creates a room; it is the only member (role founder); the code is
//         returned and is stable (derived from the room id).
//      B2 attend: a SECOND worker attends by code — joins as member; the member row is the audit
//         (role 'member', joined_at set). Re-attending is a no-op (joined:false, still a member).
//      B3 say: the founder posts; the transcript row is written and attributed; a non-member is
//         REFUSED (membership is the visibility boundary).
//      B4 read-back: the second worker reads the transcript and sees the founder's post; the
//         read bumps last_read_at (the receipt), so the unread count goes to 0.
//      B5 list: the founder sees the room with the member count and the unread hint.
//      B6 scoping: a xell of ANOTHER project cannot attend by the code (project-scoped, DR-2)
//         WHEN THERE IS NO INVITE — the default refusal sentence is unchanged.
//      B7 attend-by-full-uuid: the code's full uuid also resolves the room.
//
//   C. CROSS-PROJECT INVITE (DR-5) — the widening by explicit consent:
//      C1 founder invites project B → a zee of B attends, reads transcript, says; founder is in
//         the delivery fan-out.
//      C2 a zee of project C (not invited) still gets today's refusal (the assertion that matters).
//      C3 a non-founder member cannot invite.
//      C4 invite withdrawn → B can no longer attend or say; member row + transcript survive;
//         inviting the room's own project is a no-op.
//
// The project is deleted in a finally, whatever happens (house rule: tests clean up what they
// create). The sandbox is the sanctioned verification path — the assigned shared dev db refused
// this xell's credentials (recorded in docs/zee-meet-decision-record.md).
import { randomUUID } from 'node:crypto';

// The pure helpers (a2a-meet.js) are imported regardless of DATABASE_URL; the lifecycle half
// needs the database. The code below mirrors a2a-write.test.mjs's split.
const { meetCodeFor, parseMeetCode } = await import('../server/src/lib/a2a-meet.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const eq = (got, want, msg) => ok(got === want, `${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);

// ── A. the pure shape helpers ──────────────────────────────────────────────────
console.log('\n── A. meetCodeFor / parseMeetCode (pure, no database) ──');
{
  const code = meetCodeFor({ slug: 'i-want-agents-to-be-able-to-talk-to-each-oth-7d6667', id: '12345678-abcd-4ef0-8123-456789abcdef' });
  eq(code, 'i-want-agent/abcdef', 'A1: code = slug (12 chars) + "/" + last 6 hex of the id');
  eq(meetCodeFor({ slug: 'my-xell', id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }), 'my-xell/eeeeee', 'A1: …another id → another token');
  eq(meetCodeFor({ slug: null, id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }), 'meet/eeeeee', 'A1: a missing slug falls back to "meet"');

  const p = parseMeetCode('i-want-agent/abcdef');
  eq(p.slug, 'i-want-agent', 'A2: parseMeetCode extracts the slug hint');
  eq(p.token, 'abcdef', 'A2: …and the token');
  eq(p.fullId, null, 'A2: a code is not a full id');
  const u = parseMeetCode('12345678-abcd-4ef0-8123-456789abcdef');
  eq(u.fullId, '12345678-abcd-4ef0-8123-456789abcdef', 'A2: a full uuid is accepted');
  eq(u.token, 'abcdef', 'A2: …and its token is the last 6 hex');
  eq(parseMeetCode('nonsense'), null, 'A2: a non-code returns null');
  eq(parseMeetCode(''), null, 'A2: an empty input returns null');
}

// ── B. the room lifecycle — against DATABASE_URL ──────────────────────────────
const url = process.env.DATABASE_URL;
if (!url) {
  console.log('\n── B. the room lifecycle (SKIPPED — DATABASE_URL not set; use `zee db-sandbox --migrate`) ──');
} else {
  console.log('\n── B. the room lifecycle against DATABASE_URL ──');
  const { q, one } = await import('../server/src/db/pool.js');
  const { createMeet, attendMeet, sayToMeet, listMeetsFor, transcriptFor, inviteToMeet } =
    await import('../server/src/lib/a2a-meet.js');

  const tag = `a2am-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
  let projectId = null;
  let projectBId = null;
  let projectCId = null;
  try {
    const proj = await one(
      `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'main') RETURNING id, name`,
      [`zt-${tag}`, `/tmp/${tag}`]);
    projectId = proj.id;
    const xource = await one(
      `INSERT INTO xource (project_id, ref, head_commit) VALUES ($1,'main','deadbeef') RETURNING id`,
      [projectId]);
    const mkXell = async (slug, zeeType = 'worker', managerId = null) => (await one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, status, zee_type, manager_xell_id, head_commit)
         VALUES ($1,$2,$3,'spinoff/t','claimed',$4,$5,'abcdef1234567890') RETURNING *`,
      [projectId, xource.id, `${tag}-${slug}`, zeeType, managerId]));
    const founder = await mkXell('founder');
    const peer = await mkXell('peer');

    // B1. create — the human's "initiate a zee meet" → a code.
    const created = await createMeet({ xell: founder, title: 'auth refactor sync' });
    ok(created.ok, 'B1: createMeet returns ok');
    ok(created.code && created.code.includes('/'), `B1: a code was printed (${created.code})`);
    const roomId = created.room.id;
    const memberRows = await q(`SELECT * FROM a2a_meet_member WHERE meet_id=$1`, [roomId]);
    eq(memberRows.length, 1, 'B1: the founder is the only member at create');
    eq(memberRows[0].xell_id, founder.id, 'B1: …and it is the founder');
    eq(memberRows[0].role, 'founder', 'B1: …with role founder');
    const roomRow = await one(`SELECT * FROM a2a_meet WHERE id=$1`, [roomId]);
    eq(roomRow.project_id, projectId, 'B1: the room is project-scoped');
    eq(meetCodeFor({ slug: roomRow.slug, id: roomId }), created.code, 'B1: the code is derived from the room, stable');

    // B2. attend — "when i tell another zee to zee meet attend… zees can join".
    const attended = await attendMeet({ xell: peer, code: created.code });
    ok(attended.ok && attended.joined === true, `B2: the peer joins by code (${attended.code})`);
    eq(attended.members.length, 2, 'B2: the room now has two members');
    const peerMember = await one(
      `SELECT * FROM a2a_meet_member WHERE meet_id=$1 AND xell_id=$2`, [roomId, peer.id]);
    eq(peerMember.role, 'member', 'B2: the attender is role member (the audit)');
    ok(!!peerMember.joined_at, 'B2: joined_at is set (attendance is recorded)');
    const re = await attendMeet({ xell: peer, code: created.code });
    eq(re.joined, false, 'B2: re-attending is a no-op (joined:false)');

    // B3. say — "zees can join and talk". Membership is the visibility boundary.
    const said = await sayToMeet({ xell: founder, code: created.code, message: 'I will take the router' });
    ok(said.ok && said.posted === true, 'B3: the founder posts to the room');
    eq(said.message.from, founder.slug, 'B3: the post is attributed to the founder');
    const msgRows = await q(`SELECT * FROM a2a_meet_message WHERE meet_id=$1`, [roomId]);
    eq(msgRows.length, 1, 'B3: one transcript row is written (the durable record, not a fan-out)');
    eq(msgRows[0].body, 'I will take the router', 'B3: the body is the message');
    const stranger = await mkXell('stranger');
    const refused = await sayToMeet({ xell: stranger, code: created.code, message: 'hi' });
    ok(!refused.ok && /not a member|attend it first/i.test(refused.error || ''),
       `B3: a non-member is refused to post (${refused.error})`);

    // B4. read-back — the peer reads the transcript and the read marks it read.
    const t = await transcriptFor(peer, created.code);
    ok(t.ok, 'B4: the peer reads the transcript');
    eq(t.messages.length, 1, 'B4: the peer sees the founder\'s post');
    eq(t.messages[0].from, founder.slug, 'B4: …from the founder');
    eq(t.members.length, 2, 'B4: the member list is included');
    const afterRead = await one(
      `SELECT last_read_at FROM a2a_meet_member WHERE meet_id=$1 AND xell_id=$2`, [roomId, peer.id]);
    ok(!!afterRead.last_read_at, 'B4: the read bumped last_read_at (the receipt)');

    // B5. list — the rooms a member is in, with the unread hint.
    const founderList = await listMeetsFor(founder);
    eq(founderList.length, 1, 'B5: the founder sees the room in its list');
    eq(founderList[0].title, 'auth refactor sync', 'B5: the title is there');
    eq(founderList[0].member_count, 2, 'B5: the member count is there');
    eq(founderList[0].message_count, 1, 'B5: the message count is there');

    // B6. scoping — another project's xell cannot attend by the code with NO invite (DR-2 default).
    const otherProj = await one(
      `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'main') RETURNING id, name`,
      [`zt-${tag}-other`, `/tmp/${tag}-other`]);
    projectBId = otherProj.id;
    const otherXource = await one(
      `INSERT INTO xource (project_id, ref, head_commit) VALUES ($1,'main','deadbeef') RETURNING id`,
      [otherProj.id]);
    const outsider = await one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, status, zee_type, head_commit)
         VALUES ($1,$2,$3,'spinoff/t','claimed','worker','abcdef1234567890') RETURNING *`,
      [otherProj.id, otherXource.id, `${tag}-outsider`]);
    const cross = await attendMeet({ xell: outsider, code: created.code });
    // Byte-for-byte the ORIGINAL DR-2 refusal (widening by consent must not change this sentence).
    const ORIGINAL_SCOPED_REFUSAL =
      `no meet "${created.code}" in your project — check the code, or have the founder re-print it. `
      + 'A meet is project-scoped: you can only attend rooms your own project created.';
    eq(cross.error, ORIGINAL_SCOPED_REFUSAL,
       'B6: non-invited outsider gets the ORIGINAL refusal sentence, byte for byte');
    const outsiderRows = await q(`SELECT * FROM a2a_meet_member WHERE meet_id=$1 AND xell_id=$2`, [roomId, outsider.id]);
    eq(outsiderRows.length, 0, 'B6: no membership row was written for the outsider');

    // B7. attend-by-full-uuid — the full id also resolves the room.
    const byUuid = await attendMeet({ xell: peer, code: roomId });
    ok(byUuid.ok && byUuid.meet_id === roomId, 'B7: a full uuid resolves the room');

    // ── C. CROSS-PROJECT INVITE (DR-5) ────────────────────────────────────────
    console.log('\n── C. cross-project invite (DR-5) ──');

    // C1. founder invites project B → guest attends, reads, says.
    const invited = await inviteToMeet({ xell: founder, code: created.code, project: otherProj.name });
    ok(invited.ok && invited.invited === true, `C1: founder invites project B (${otherProj.name})`);
    eq(invited.project.id, otherProj.id, 'C1: invite targets project B');
    const inviteRows = await q(`SELECT * FROM a2a_meet_invite WHERE meet_id=$1`, [roomId]);
    eq(inviteRows.length, 1, 'C1: one invite row is the audit');
    eq(inviteRows[0].project_id, otherProj.id, 'C1: …for project B');
    eq(inviteRows[0].invited_by_xell_id, founder.id, 'C1: …by the founder');

    const guestAttend = await attendMeet({ xell: outsider, code: created.code });
    ok(guestAttend.ok && guestAttend.joined === true,
       `C1: invited project's zee attends by code (${guestAttend.error || 'ok'})`);
    const guestMember = await one(
      `SELECT * FROM a2a_meet_member WHERE meet_id=$1 AND xell_id=$2`, [roomId, outsider.id]);
    ok(!!guestMember, 'C1: guest member row exists (the audit)');

    const guestTx = await transcriptFor(outsider, created.code);
    ok(guestTx.ok && guestTx.messages.length >= 1, 'C1: guest reads the transcript');
    eq(guestTx.messages[0].from, founder.slug, 'C1: …and sees the founder\'s earlier post');

    const guestSaid = await sayToMeet({
      xell: outsider, code: created.code, message: 'four questions from the other project',
    });
    ok(guestSaid.ok && guestSaid.posted === true, 'C1: guest posts to the room');
    const guestMsg = await one(
      `SELECT * FROM a2a_meet_message WHERE meet_id=$1 AND from_xell_id=$2`, [roomId, outsider.id]);
    ok(!!guestMsg, 'C1: guest message row exists');
    eq(guestMsg.project_id, projectId,
       'C1: message.project_id is the ROOM\'s project (guest project does not leak onto the row)');
    // Fan-out lists the other live members (founder + peer). Delivery may be dry-run in simulate
    // mode; what we assert is that the attempt set includes the founder — the guest gained the
    // room and only the room.
    ok(Array.isArray(guestSaid.deliveries), 'C1: say returns a deliveries list (fan-out ran)');
    ok(guestSaid.deliveries.some((d) => d.slug === founder.slug),
       'C1: founder is in the fan-out (notified of the guest post)');

    // C2. project C (not invited) still gets today's refusal — THE assertion that matters.
    const projC = await one(
      `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'main') RETURNING id, name`,
      [`zt-${tag}-C`, `/tmp/${tag}-C`]);
    projectCId = projC.id;
    const xourceC = await one(
      `INSERT INTO xource (project_id, ref, head_commit) VALUES ($1,'main','deadbeef') RETURNING id`,
      [projC.id]);
    const zeeC = await one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, status, zee_type, head_commit)
         VALUES ($1,$2,$3,'spinoff/t','claimed','worker','abcdef1234567890') RETURNING *`,
      [projC.id, xourceC.id, `${tag}-C`]);
    const cRefuse = await attendMeet({ xell: zeeC, code: created.code });
    // THE assertion that matters: non-invited project C gets the SAME original sentence, byte for byte.
    eq(cRefuse.error, ORIGINAL_SCOPED_REFUSAL,
       'C2: non-invited project C gets the ORIGINAL refusal sentence, byte for byte');
    const cMembers = await q(
      `SELECT * FROM a2a_meet_member WHERE meet_id=$1 AND xell_id=$2`, [roomId, zeeC.id]);
    eq(cMembers.length, 0, 'C2: no membership row for the non-invited project');

    // C3. a non-founder member cannot invite.
    const peerInvite = await inviteToMeet({ xell: peer, code: created.code, project: projC.name });
    ok(!peerInvite.ok && /founder/i.test(peerInvite.error || ''),
       `C3: non-founder cannot invite (${peerInvite.error})`);
    const guestInvite = await inviteToMeet({ xell: outsider, code: created.code, project: projC.name });
    ok(!guestInvite.ok && (/founder|your project/i.test(guestInvite.error || '')),
       `C3: guest cannot invite either (${guestInvite.error})`);

    // C4. withdraw → B can no longer attend or say; member + transcript survive; own-project no-op.
    const ownNoop = await inviteToMeet({ xell: founder, code: created.code, project: proj.name });
    ok(ownNoop.ok && ownNoop.noop === true, 'C4: inviting the room\'s own project is a no-op');
    const beforeWithdrawMembers = await q(`SELECT * FROM a2a_meet_member WHERE meet_id=$1`, [roomId]);
    const beforeWithdrawMsgs = await q(`SELECT * FROM a2a_meet_message WHERE meet_id=$1`, [roomId]);
    const withdrawn = await inviteToMeet({
      xell: founder, code: created.code, project: otherProj.name, remove: true,
    });
    ok(withdrawn.ok && withdrawn.removed === true, 'C4: founder withdraws project B\'s invite');
    const inviteAfter = await q(
      `SELECT * FROM a2a_meet_invite WHERE meet_id=$1 AND project_id=$2`, [roomId, otherProj.id]);
    eq(inviteAfter.length, 0, 'C4: invite row is gone');
    const membersAfter = await q(`SELECT * FROM a2a_meet_member WHERE meet_id=$1`, [roomId]);
    eq(membersAfter.length, beforeWithdrawMembers.length,
       'C4: member rows survive the withdraw (including the guest)');
    const msgsAfter = await q(`SELECT * FROM a2a_meet_message WHERE meet_id=$1`, [roomId]);
    eq(msgsAfter.length, beforeWithdrawMsgs.length, 'C4: transcript survives the withdraw');

    const reAttend = await attendMeet({ xell: outsider, code: created.code });
    ok(!reAttend.ok && /withdrawn|your project/i.test(reAttend.error || ''),
       `C4: guest can no longer attend after withdraw (${reAttend.error})`);
    const reSay = await sayToMeet({ xell: outsider, code: created.code, message: 'should fail' });
    ok(!reSay.ok && /withdrawn|your project|not a member/i.test(reSay.error || ''),
       `C4: guest can no longer say after withdraw (${reSay.error})`);
    // Former member may still read the transcript (membership is the visibility boundary).
    const stillRead = await transcriptFor(outsider, created.code);
    ok(stillRead.ok, 'C4: former guest member can still read the surviving transcript');

    console.log(`    (code=${created.code}, room=${roomId.slice(0, 8)}…, founder=${founder.slug}, peer=${peer.slug}, guest=${outsider.slug})`);
  } finally {
    // Cascade from project deletes rooms/members/messages/invites for that project. Guest projects
    // first so FK order does not matter; home project last.
    if (projectCId) await q(`DELETE FROM project WHERE id=$1`, [projectCId]).catch(() => {});
    if (projectBId) await q(`DELETE FROM project WHERE id=$1`, [projectBId]).catch(() => {});
    if (projectId) await q(`DELETE FROM project WHERE id=$1`, [projectId]).catch(() => {});
  }
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);

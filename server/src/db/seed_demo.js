// Demo fleet for the web-app e2e: 5 pooled xells, 3 with active zees, 2 of them working.
// Mirrors the mockup so the dashboard has representative data to render.
import { pool, q, one } from './pool.js';
import { provisionXell } from '../lib/provision.js';
import { codenameFor } from '../lib/names.js';
import { gitLog } from '../lib/git.js';
import { listActiveAgents } from '../lib/claude-cli.js';
import { acquireProdLock } from '../queenzee/deploylock.js';

async function seedDemo() {
  const project = await one(`SELECT id FROM project ORDER BY created_at LIMIT 1`);
  const pid = project.id;
  const remote = await one(`SELECT id FROM agent_runtime WHERE key='claude-code-remote'`);
  const local = await one(`SELECT id FROM agent_runtime WHERE key='claude-code-local'`);

  // clean transient state — but PRESERVE the production xell + its links
  await q(`TRUNCATE task, session_event, zee CASCADE`);
  await q(`DELETE FROM xell_uses_container WHERE xell_id IN (SELECT id FROM xell WHERE NOT is_production)`);
  await q(`DELETE FROM container WHERE isolation='per-xell'`);
  await q(`DELETE FROM xell WHERE NOT is_production`);

  // 5 ready xells (simulate — no live NAS mutation)
  const xells = [];
  for (let i = 0; i < 5; i++) xells.push(await provisionXell({ projectId: pid, mode: 'simulate' }));

  // anchor each demo xell to a DISTINCT real commit on main so the timeline connectors
  // fan out to different heights (real branch points share the tip; this is demo spread)
  const proj = await one(`SELECT repo_root, main_branch FROM project WHERE id=$1`, [pid]);
  const commits = gitLog(proj.repo_root, proj.main_branch, 30);
  if (commits.length) {
    const spread = [0, 3, 6, 9, 12];
    for (let i = 0; i < xells.length; i++) {
      const c = commits[Math.min(spread[i] ?? i, commits.length - 1)];
      await q(`UPDATE xell SET head_commit=$2 WHERE id=$1`, [xells[i].id, c.hash]);
    }
  }

  // helper: attach a zee to a xell with a given status
  async function attach(xell, { status, runtime, sid, viewer }) {
    const z = await one(
      `INSERT INTO zee (xell_id, claude_session_id, session_name, attach_mode, runtime_id, viewer_url, viewer_kind,
                        status, kind, entrypoint, model, cwd, attached_at)
       VALUES ($1,$2,$2,'skill-claim',$3,$4,$5,$6,'interactive','claude-desktop','sonnet',$7, now()) RETURNING *`,
      [xell.id, sid, runtime?.id || null, viewer?.url || null, viewer?.kind || 'none', status, xell.worktree_path]);
    if (status === 'working') {
      await q(`UPDATE zee SET name=$2 WHERE id=$1`, [z.id, codenameFor(z.id)]);
    }
    const xstatus = status === 'working' ? 'working' : status === 'idle' ? 'idle' : 'claimed';
    await q(`UPDATE xell SET status=$2, is_pooled=false WHERE id=$1`, [xell.id, xstatus]);
    await q(`INSERT INTO task (project_id, prompt_text, source, status, xell_id, zee_id, assigned_at)
             VALUES ($1,$2,'skill','assigned',$3,$4, now())`,
      [pid, `demo task for ${xell.slug}`, xell.id, z.id]);
    return z;
  }

  // xell 0 — WORKING, remote runtime, claude.ai viewer (clickable)
  await attach(xells[0], {
    status: 'working', runtime: remote, sid: 'sess-remote-1111aaaa',
    viewer: { url: 'https://claude.ai/code/sess-remote-1111aaaa', kind: 'web' },
  });
  // xell 1 — WORKING, local runtime. Pin to a REAL live session (if any) so the monitor
  // can prove it distinguishes really-active from the fabricated sessions on the others.
  // Pin this local "working" zee to a REAL live session so the monitor genuinely shows
  // "● really active" AND the desktop deep-link opens a sensible session. Prefer THIS
  // Zeehive session (when it's live) over an arbitrary borrowed agent, so clicking the card
  // never hijacks an unrelated project's Claude session; fall back to any live agent, then a stub.
  const live = (await listActiveAgents()).agents.map((a) => a.sessionId);
  const self = process.env.CLAUDE_CODE_SESSION_ID;
  const realSid = (self && live.includes(self)) ? self : (live[0] || 'sess-local-2222bbbb');
  await attach(xells[1], {
    status: 'working', runtime: local, sid: realSid,
    // local zee → desktop-protocol deep link into Claude Desktop (the T-Keyboard scheme)
    viewer: { url: `claude://resume?session=${realSid}`, kind: 'desktop-protocol' },
  });
  // xell 2 — IDLE (active but not working), remote runtime
  await attach(xells[2], {
    status: 'idle', runtime: remote, sid: 'sess-remote-3333cccc',
    viewer: { url: 'https://claude.ai/code/sess-remote-3333cccc', kind: 'web' },
  });
  // xells 3 & 4 remain READY (no zee)

  // give the first working xell the PROD deploy lock (padlock in the UI)
  await acquireProdLock({ xell_id: xells[0].id, phase: 'awaiting-verification', task: 'prod deploy demo' });

  const f = await one(
    `SELECT count(*) FILTER (WHERE status='ready') ready,
            count(*) FILTER (WHERE status IN ('working','idle','claimed')) in_use,
            count(*) FILTER (WHERE status='working') working, count(*) total
       FROM xell WHERE project_id=$1 AND status<>'retired'`, [pid]);
  console.log(`Demo fleet: ${f.in_use} of ${f.total} in use (${f.working} working, ${f.ready} ready).`);
  await pool.end();
}

seedDemo().catch((e) => { console.error(e); process.exit(1); });

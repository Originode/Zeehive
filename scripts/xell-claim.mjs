// Called by the /xell skill at load time. Claims the freshest ready xell for THIS
// Claude session and prints the binding JSON, which the skill inlines into the prompt.
// Uses only ambient signals: $CLAUDE_CODE_SESSION_ID and the session cwd.
//
// The cwd is also the PROJECT handover: the queenzee resolves which project you are in from it
// (repo_root / xell worktree) instead of defaulting to the oldest project row. ZEEHIVE_PROJECT
// overrides it when a session runs outside any managed repo.
import http from 'node:http';

const api = process.env.ZEEHIVE_API || 'http://localhost:4700';
// The task is intentionally NOT an argument: the skill interpolates it into a shell line, and real
// task text (backticks, quotes, $) breaks bash before this script ever runs. Claiming doesn't need
// it — the task reaches the queenzee via --task-file on dispatch, or the model just does the work.
const task = process.argv[2] || '';
const body = JSON.stringify({
  session_id: process.env.CLAUDE_CODE_SESSION_ID || '',
  cwd: process.cwd(),
  ...(process.env.ZEEHIVE_PROJECT ? { project: process.env.ZEEHIVE_PROJECT } : {}),
  task,
});

const req = http.request(`${api}/api/xell/claim`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
}, (res) => {
  let b = '';
  res.on('data', (c) => (b += c));
  res.on('end', () => {
    let j; try { j = JSON.parse(b); } catch { /* non-JSON */ }
    if (j && j.status === 'unknown-project') {
      // Refusing beats guessing: the old default silently handed out an OmniBiz xell to a session
      // standing in a different repo.
      const list = (j.projects || []).map((p) => `    • ${p.name}  (${p.repo_root})`).join('\n');
      console.log(
`NOT CLAIMED — the queenzee cannot tell which project this session belongs to.
Your cwd (${j.your_cwd || '?'}) is not inside any managed repo or xell worktree.

Do not start any work. Ask the user which project this is, then re-run with it named:

  ZEEHIVE_PROJECT="<name>" node "${process.env.ZEEHIVE_HOME || 'D:/Repos/Zeehive'}/scripts/xell-claim.mjs"

Known projects:
${list || '    (none configured)'}`);
      process.exit(0);
    }
    if (j && j.status === 'needs-worktree') {
      // Not in a worktree → NOT claimed. Offer the confirmed auto-dispatch path.
      const d = j.dispatch || {};
      const home = process.env.ZEEHIVE_HOME || 'D:/Repos/Zeehive';
      const others = (j.also_ready || []).map((x) => `    • ${x.worktree_path}`).join('\n');
      console.log(
`NOT CLAIMED — this session is in the main repo (${j.your_cwd || '?'}), NOT a xell worktree.
Do not read/edit/write any files here (it is the read-only xource).

RECOMMENDED — dispatch this task to a ready xell. The queenzee will spawn a zee INSIDE its
worktree to do the work. CONFIRM WITH THE USER first, then:

  1. WRITE the full task text to a file using the Write tool (NOT the shell — task text contains
     backticks/quotes/$ that break bash):   <tmp>/xell-task.md
  2. RUN:
     node "${home}/scripts/xell-dispatch.mjs" ${d.xell_id || ''} --task-file "<tmp>/xell-task.md"

    → project     : ${j.project?.name || '?'}   (${j.project?.repo_root || '?'})
    → target xell : ${d.slug || '?'}   (runtime: ${d.runtime_label || 'default'})
    → worktree    : ${d.worktree_path || '?'}

    The project came from your cwd. If it is the WRONG project, stop and tell the user —
    re-run with ZEEHIVE_PROJECT="<name>" rather than dispatching into the wrong repo.

    Autonomy (optional, append --mode N; default 5):
      1 plan   read-only recon — changes nothing      3 shell  edit + run shell
      2 edits  edit files, no shell                   4 auto   all tools, auto-accept edits
      5 bypass no permission prompts at all (default; the only one that never stalls unattended)
    Ask the user which mode they want if the task looks risky.

    Attended? (optional, append --attended)
      default    the zee is told to decide and keep going without asking (fire-and-forget).
      --attended the zee is told a human CAN open its session and reply, so it may stop and ask
                 on a genuinely load-bearing decision instead of guessing.
    The spawned session IS openable either way — this only sets what the zee is TOLD.
    Ask the user which they want when the task has real unknowns.

ALTERNATIVE — open the worktree yourself and run /xell there:
    ${j.open_worktree}   (${j.open_slug})
${others ? `\nOther ready worktrees:\n${others}\n` : ''}`);
      process.exit(0);
    }
    if (res.statusCode >= 400) {
      console.log(`Not claimed (HTTP ${res.statusCode}): ${b}\nDo not start any work.`);
      process.exit(0);
    }
    console.log(b);
  });
});
req.on('error', (e) => { console.log(`queenzee API unreachable at ${api}: ${e.message}`); process.exit(0); });
req.write(body);
req.end();

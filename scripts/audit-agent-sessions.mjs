#!/usr/bin/env node
// AUDIT AGENT SESSIONS — "is any AI session running that the fleet has lost track of?"
//
// Written for the question a human actually asks: *are there rogue claude sessions lingering
// outside my xells, burning tokens, that cleanup missed?* Answering it by hand takes a dozen API
// calls and a cross-reference nobody remembers the shape of, so it lives here as one command.
//
// It is READ-ONLY and needs nothing but HTTP to the queenzee API — no docker CLI, no host
// filesystem, no database credentials — so it runs identically from a host session and from
// inside a cxell (where `docker ps` does not exist). Every fact comes from the queenzee:
//
//   GET /api/projects, /api/xells, /api/zees          the model: what SHOULD exist
//   GET /api/projects/:id/sites → /api/sites/:id/discover
//                                                     the machines: what IS running, per docker
//                                                     context (read-only `docker ps` via the
//                                                     daemon API — lib/discovery.js)
//   GET /api/zees/:id/fs?path=…                        inside a live cxell: the agent's own
//                                                     transcript, sampled TWICE
//
// The transcript sample is the load-bearing part, and it is here because no status field can
// answer the question. `zee.status` is the queenzee's record of the HEADLESS turn it spawned;
// `zee.cli_active` is a pgrep that says "an agent is attached", not "an agent is working" (see
// the long note in queenzee/reaper.js). Neither sees a turn that a terminal attach, an operator
// message or a nudge started INSIDE the cage — the KNOWN GAP — and such a turn burns tokens with
// no usage recorded against the zee. A transcript that GROWS between two samples is an agent
// generating right now, whatever the row says. That is measurement, not inference.
//
// Four findings, and what each one means:
//   ROGUE CAGE    an agent container RUNNING with no live xell to explain it. This is the thing
//                 the question is about. A leftover to kill (nothing legitimate looks like this).
//   DEAD CAGE     an agent container that has EXITED and never been removed. Costs disk, not
//                 tokens. Worth sweeping, never urgent.
//   GHOST ROW     a `zee` row still marked live (decommissioned_at IS NULL) whose xell is retired
//                 or gone. Bookkeeping only — the cage is provably unreachable. It still lies to
//                 anything that counts live agents.
//   OFF-BOOK      a cage whose transcript is GROWING while its row says the turn is over
//                 (errored/idle/stopped). Real tokens, unaccounted, and — because the reap guard
//                 reads the same row — reapable by a human who is told the zee is finished.
//   STALLED       a cage that is alive, generating nothing, and whose row says the turn is over.
//                 Not burning tokens; it is holding a worktree, a database and a cage while
//                 nobody drives it. Resume it or Mark it done.
//   QUIET WHILE 'WORKING'
//                 the row claims a turn but the transcript did not move in the window. Reported
//                 and deliberately NOT counted as a finding: a turn blocked on one long tool call
//                 writes nothing, so this is inconclusive over a short probe.
//
// Usage:
//   node scripts/audit-agent-sessions.mjs [--api URL] [--probe SECONDS] [--no-probe] [--json]
//     --api      queenzee API base (default $ZEEHIVE_API_URL, else the cxell/host localhost pair)
//     --probe    seconds between the two transcript samples (default 45; 0 = one sample only)
//     --no-probe skip the transcript sampling entirely (model + docker cross-check only, fast)
//     --json     emit the whole finding set as JSON instead of the report
//
// Exit code: 1 if anything ACTIONABLE was found (a rogue cage or an off-book burner), else 0 —
// so it can be used as a check. Dead cages, ghost rows and zombie rows are reported but do not
// fail the run: they are hygiene, not a live leak.
//
// It NEVER writes: no POST, no reap, no kill, no file contents read out of another zee's cage
// (directory listings and byte sizes only). Killing a rogue cage is a human's call in the
// console — this tool tells them which one, and why.

import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';

const DEFAULT_APIS = [
  process.env.ZEEHIVE_API_URL,
  'http://host.docker.internal:4700',   // from inside a cxell
  'http://localhost:4700',              // host session
].filter(Boolean);

// The cage naming rule, mirrored from server/src/lib/cxell.js `cxellName()`. Duplicated on
// purpose: importing that module drags in the db pool and ssh2, and this script must run with
// nothing but node + a URL. test/audit-agent-sessions.test.mjs asserts the two agree.
export const cageName = (slug) => `cxell_${String(slug).replace(/[^a-zA-Z0-9_.-]/g, '-')}`;

// Every container name that has ever held an agent session in this repo: the current `cxell_`
// cages and the `zee_cage_`/`zee-cage` generations that preceded them (still on disk on the dev
// machine, which is exactly why a "rogue session" hunt must recognise them).
export const AGENT_CAGE_RE = /^(cxell_|zee_cage_|zee-cage$|zee-ssh-test$)/;

export const isAgentCage = (name) => AGENT_CAGE_RE.test(String(name || ''));

// Where a Claude Code cage keeps its transcripts. One dir per workspace, one <session-id>.jsonl
// per session (lib/session-title.js reads the same tree on the host).
export const CXELL_PROJECTS_DIR = '/home/zee/.claude/projects';

// ── pure classifiers (unit-tested; no network) ───────────────────────────────────────────────

// Cages seen on a docker context vs the xells that could legitimately own one.
// `liveSlugs` = slugs of every non-retired xell.
export function classifyCages(containers, liveSlugs) {
  const legit = new Set([...liveSlugs].map(cageName));
  const rogue = [], dead = [], accounted = [];
  for (const c of containers || []) {
    if (!isAgentCage(c.name)) continue;
    const running = c.state === 'running' || c.state === 'restarting' || c.state === 'paused';
    if (!running) { dead.push(c); continue; }
    (legit.has(c.name) ? accounted : rogue).push(c);
  }
  return { rogue, dead, accounted };
}

// zee rows that still claim to be live but whose xell is retired/absent.
export function ghostRows(zees, liveXellIds) {
  const live = new Set(liveXellIds);
  return (zees || []).filter((z) => !z.decommissioned_at && !live.has(z.xell_id));
}

// Total bytes of transcript in a sample: sum of every *.jsonl the cage holds.
export function transcriptBytes(sample) {
  if (!sample || !Array.isArray(sample.files)) return null;
  return sample.files.reduce((n, f) => n + (Number(f.size) || 0), 0);
}

const MID_TURN_STATUSES = ['spawning', 'online', 'working'];   // mirrors queenzee/reaper.js

// One session's verdict from what the row claims and what the cage actually DID.
//   generating  → the transcript grew between the two samples (positive proof of a live turn)
//   row_live    → the row says a turn is in flight (queenzee/reaper.js MID_TURN_STATUSES)
//
// The asymmetry matters, and the report leans on it:
//   • GROWTH IS PROOF. A transcript only grows when an agent writes a message, so growth with a
//     row that says the turn is over ('off-book') is a fact, not a guess.
//   • ABSENCE OF GROWTH IS NOT. Claude appends per MESSAGE, not per second: a turn blocked on one
//     long tool call (a build, a --wait, a sleep) writes nothing for minutes. So a 'working' row
//     with a flat transcript is INCONCLUSIVE over a short window — never treat it as a dead zee
//     on this evidence alone (this tool measured itself that way on its first run).
export function classifySession({ status, sample1, sample2 }) {
  const a = transcriptBytes(sample1);
  const b = transcriptBytes(sample2);
  const rowLive = MID_TURN_STATUSES.includes(String(status));
  if (a === null) return { verdict: 'unreachable', generating: null, delta: null, row_live: rowLive };
  if (b === null) return { verdict: 'unknown', generating: null, delta: null, row_live: rowLive };
  const delta = b - a;
  const generating = delta > 0;
  if (generating) return { verdict: rowLive ? 'working' : 'off-book', generating, delta, row_live: rowLive };
  // Cage alive, nothing generated: either a row that still claims a turn (inconclusive) or a cage
  // whose turn really is over and which nobody is driving (a stall a human may want to resume).
  return { verdict: rowLive ? 'quiet-while-working' : 'stalled', generating, delta, row_live: rowLive };
}

// ── the API surface it uses (all GET) ────────────────────────────────────────────────────────

async function getJson(base, path, timeoutMs = 45000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}${path}`, { signal: ac.signal });
    if (!r.ok) return { __error: `HTTP ${r.status}` };
    return await r.json();
  } catch (e) {
    return { __error: e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : e.message };
  } finally { clearTimeout(t); }
}

// Everything except /health lives under /api — resolveApi() probes /health on the bare origin.
const apiGet = (api, path, timeoutMs) => getJson(api, `/api${path}`, timeoutMs);

async function resolveApi(candidates) {
  for (const api of candidates) {
    const h = await getJson(api, '/health', 5000);
    if (h && h.ok) return api;
  }
  throw new Error(`no queenzee API reachable (tried ${candidates.join(', ')}) — pass --api URL`);
}

// Every distinct docker context this fleet models, with a site id we can discover it through.
export function contextsToScan(sitesByProject) {
  const seen = new Map();
  for (const [project, sites] of sitesByProject) {
    for (const s of sites || []) {
      const ctx = s.docker_ctx || 'default';
      if (!seen.has(ctx)) seen.set(ctx, { ctx, site_id: s.id, project, site_key: s.key });
    }
  }
  return [...seen.values()];
}

// One transcript sample from inside a live cage: which *.jsonl files it holds and how big they are.
async function sampleTranscripts(api, zeeId) {
  const projects = await apiGet(api, `/zees/${zeeId}/fs?path=${encodeURIComponent(CXELL_PROJECTS_DIR)}`);
  if (projects.__error || projects.error) return { error: projects.__error || projects.error, files: null };
  const files = [];
  for (const d of (projects.entries || []).filter((e) => e.type === 'dir')) {
    const dir = `${CXELL_PROJECTS_DIR}/${d.name}`;
    const ls = await apiGet(api, `/zees/${zeeId}/fs?path=${encodeURIComponent(dir)}`);
    if (ls.__error || ls.error) continue;
    for (const f of (ls.entries || [])) {
      if (f.type === 'file' && f.name.endsWith('.jsonl')) files.push({ name: f.name, size: f.size, dir });
    }
  }
  return { files, at: Date.now() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function audit({ api, probeSeconds = 45, probe = true, log = () => {} } = {}) {
  const projects = await apiGet(api, '/projects');
  if (projects.__error) throw new Error(`/projects failed: ${projects.__error}`);
  const xells = await apiGet(api, '/xells');
  if (xells.__error) throw new Error(`/xells failed: ${xells.__error}`);
  const zees = await apiGet(api, '/zees');
  if (zees.__error) throw new Error(`/zees failed: ${zees.__error}`);

  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const liveSlugs = xells.map((x) => x.slug);
  const xellById = new Map(xells.map((x) => [x.id, x]));

  // ── the machines, per docker context ──
  const sitesByProject = [];
  for (const p of projects) {
    const sites = await apiGet(api, `/projects/${p.id}/sites`);
    sitesByProject.push([p.name, sites.__error ? [] : sites]);
  }
  const contexts = contextsToScan(sitesByProject);
  const cages = { rogue: [], dead: [], accounted: [] };
  const contextErrors = [];
  for (const c of contexts) {
    const d = await apiGet(api, `/sites/${c.site_id}/discover`, 60000);
    if (d.__error || d.ok === false) { contextErrors.push({ ...c, error: d.__error || d.error }); continue; }
    const cls = classifyCages(d.containers, liveSlugs);
    log(`  context ${c.ctx}: ${d.count} container(s) — `
      + `${cls.accounted.length} accounted cage(s), ${cls.rogue.length} rogue, ${cls.dead.length} dead`);
    for (const k of ['rogue', 'dead', 'accounted']) {
      for (const x of cls[k]) cages[k].push({ ...x, ctx: c.ctx });
    }
  }

  // ── the rows ──
  const ghosts = ghostRows(zees, xells.map((x) => x.id)).map((z) => ({
    zee_id: z.id, xell_id: z.xell_id, status: z.status, cli_active: z.cli_active,
    session: z.session_name || z.claude_session_id, last_monitor_at: z.last_monitor_at,
    cost_usd: Number(z.cost_usd || 0),
  }));

  // ── the live probe ──
  const live = zees.filter((z) => !z.decommissioned_at && z.viewer_kind === 'ssh-terminal');
  const sessions = [];
  if (probe && live.length) {
    log(`  probing ${live.length} live cage(s) — sample 1`);
    const s1 = new Map();
    for (const z of live) s1.set(z.id, await sampleTranscripts(api, z.id));
    if (probeSeconds > 0) { log(`  waiting ${probeSeconds}s`); await sleep(probeSeconds * 1000); }
    log('  sample 2');
    for (const z of live) {
      const sample2 = probeSeconds > 0 ? await sampleTranscripts(api, z.id) : s1.get(z.id);
      const sample1 = s1.get(z.id);
      const c = classifySession({ status: z.status,
        sample1: sample1.error ? null : sample1, sample2: sample2.error ? null : sample2 });
      const x = xellById.get(z.xell_id);
      sessions.push({
        zee_id: z.id, xell: x ? x.slug : '(retired/gone)', xell_status: x ? x.status : null,
        project: x ? projectName.get(x.project_id) : null,
        zee_status: z.status, cli_active: z.cli_active, cost_usd: Number(z.cost_usd || 0),
        last_stop_reason: z.last_stop_reason || null,
        bytes: transcriptBytes(sample1), ...c,
        error: sample1.error || sample2.error || null,
      });
    }
  }

  return { api, at: new Date().toISOString(), probe_seconds: probe ? probeSeconds : null,
           projects: projects.map((p) => p.name), contexts, context_errors: contextErrors,
           live_xells: xells.length, cages, ghosts, sessions };
}

// ── report ───────────────────────────────────────────────────────────────────────────────────

const kb = (n) => (n === null || n === undefined ? '—' : `${(n / 1024).toFixed(0)}kB`);

export function report(a) {
  const out = [];
  const say = (s = '') => out.push(s);
  say(`AGENT SESSION AUDIT — ${a.at}`);
  say(`  api ${a.api} · projects ${a.projects.join(', ')} · live xells ${a.live_xells}`
    + ` · docker contexts ${a.contexts.map((c) => c.ctx).join(', ')}`);
  for (const e of a.context_errors) say(`  ! context ${e.ctx} NOT scanned: ${e.error}`);
  say();

  say(`ROGUE CAGES (running agent container, no live xell): ${a.cages.rogue.length}`);
  for (const c of a.cages.rogue) say(`  ✗ ${c.name} [${c.ctx}] ${c.status || c.state}`);
  if (!a.cages.rogue.length) say('  ✓ none — every running agent cage belongs to a live xell');
  say();

  const offBook = a.sessions.filter((s) => s.verdict === 'off-book');
  say(`OFF-BOOK BURN (transcript growing, row says the turn is over): ${offBook.length}`);
  for (const s of offBook) {
    say(`  ✗ ${s.xell} [${s.project}] zee=${s.zee_status} +${kb(s.delta)} in the probe window`
      + ` · recorded spend $${s.cost_usd.toFixed(2)}`);
    if (s.last_stop_reason) say(`      last stop: ${String(s.last_stop_reason).slice(0, 140)}`);
  }
  if (!offBook.length) say('  ✓ none — every generating cage has a row that says so');
  say();

  const stalled = a.sessions.filter((s) => s.verdict === 'stalled');
  say(`STALLED CAGES (cage alive, row says the turn is over, nothing generating): ${stalled.length}`);
  for (const s of stalled) {
    say(`  · ${s.xell} [${s.project}] zee=${s.zee_status} · resume it or Mark done — it holds a worktree, a db and a cage`);
    if (s.last_stop_reason) say(`      last stop: ${String(s.last_stop_reason).slice(0, 140)}`);
  }
  say();

  const quiet = a.sessions.filter((s) => s.verdict === 'quiet-while-working');
  say(`QUIET WHILE 'WORKING' (row claims a turn, transcript flat in the window): ${quiet.length}`);
  say(`  NB inconclusive by construction — a turn blocked on one long tool call writes nothing.`);
  say(`  Re-run with a longer --probe before concluding any of these is dead.`);
  for (const s of quiet) say(`  · ${s.xell} [${s.project}] zee=${s.zee_status} transcript ${kb(s.bytes)} unchanged`);
  say();

  say(`GHOST ROWS (zee row live, xell retired/gone): ${a.ghosts.length}`);
  for (const g of a.ghosts) {
    say(`  · zee ${g.zee_id.slice(0, 8)} status=${g.status} cli_active=${g.cli_active}`
      + ` last monitored ${g.last_monitor_at || 'never'}`);
  }
  say();

  say(`DEAD CAGES (exited, never removed): ${a.cages.dead.length}`);
  for (const c of a.cages.dead) say(`  · ${c.name} [${c.ctx}] ${c.status || c.state}`);
  say();

  say(`ACCOUNTED CAGES: ${a.cages.accounted.length}`);
  for (const s of a.sessions.filter((x) => x.verdict === 'working')) {
    say(`  ✓ ${s.xell} [${s.project}] generating (+${kb(s.delta)}), row says ${s.zee_status}`);
  }
  // Unreachable + no live xell is the GHOST ROW already listed above (the cage is provably gone);
  // unreachable WITH a live xell is worth saying out loud — a cage that should answer and does not.
  for (const s of a.sessions.filter((x) => (x.verdict === 'unreachable' || x.verdict === 'unknown') && x.xell_status)) {
    say(`  ? ${s.xell} [${s.project}] cage did not answer (${String(s.error || '').slice(0, 80)})`);
  }
  return out.join('\n');
}

export const actionable = (a) =>
  a.cages.rogue.length + a.sessions.filter((s) => s.verdict === 'off-book').length;

// ── cli ──────────────────────────────────────────────────────────────────────────────────────

// Run only when INVOKED, never when imported (test/audit-agent-sessions.test.mjs imports the
// classifiers above; a basename comparison here would be one renamed file away from firing a
// 45-second live probe inside a unit test).
const invokedDirectly = process.argv[1]
  && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
  };
  const wantJson = process.argv.includes('--json');
  const noProbe = process.argv.includes('--no-probe');
  const api = await resolveApi([arg('api', null), ...DEFAULT_APIS].filter(Boolean));
  const a = await audit({
    api, probe: !noProbe, probeSeconds: Number(arg('probe', 45)),
    log: (m) => { if (!wantJson) console.error(m); },
  });
  console.log(wantJson ? JSON.stringify(a, null, 2) : report(a));
  process.exit(actionable(a) ? 1 : 0);
}

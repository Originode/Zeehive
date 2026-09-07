// THE MEDIC TOOL REGISTRY — the allowlist that IS the meta-plane confinement (docs/
// medic-meta-plane-plan.md §4, DR-7/DR-8; provision-proof kit stage 4).
//
// A SEPARATE module from langchain-tools.js, never merged: a zee loop must not be able to name a
// medic tool, and test/medic-tools.test.mjs asserts the two registries stay disjoint. The loop
// (runLangchainAgentTurn with registry: MEDIC_TOOLS) binds only what is here and dispatches only
// through runMedicTool — the same structure-as-confinement the zee registry established.
//
// The three walls, restated where they bite:
//   1. THE REGISTRY — no bash, no file write, no docker, no git-mutating tool exists. Absence is
//      the wall (the three classes that actually collapse an in-process boundary are not here).
//   2. THE ROLE — meta_select / meta_write run on the zeehive_medic role's pool (medic-role.js),
//      never the owner pool. Its GRANTs are the config surface; postgres refuses, not a prompt.
//   3. THE GATES — bootstrap_perform files a HUMAN-GATED infra_request card (hosts are not
//      meta-DB); a dispatched worker's output crosses the normal land/ship gates.
//
// THE IDENTITY COMES FROM THE TURN, NEVER FROM THE MODEL: each run() receives the MEDIC ROW
// (resolved by the driver), and the model supplies only args. Every refusal is a tool RESULT
// ({ ok:false, refused:true, reason }) the model can read and recover from — never a thrown turn.
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { logline } from './logbus.js';
import { medicDbPool } from './medic-role.js';
import { recordMedicAction, finishMedicAction, updateMedicStatus } from './medics.js';

const execFileP = promisify(execFile);

const refuse = (reason) => ({ ok: false, refused: true, reason });
export const META_SELECT_ROW_CAP = 200;
export const SOURCE_READ_CAP = 64 * 1024;

// ── the source window: read-only, path-guarded to the ZEEHIVE source ────────────────────────────
// config.repoRoot is the server's OWN tree (docs/repo-root-audit.md) — which for the medic is
// exactly right: the one repo it may SEE is the orchestrator's. The guard resolves symlinks BEFORE
// containment (a symlink escape is a real escape), and a miss is a refusal result, not a throw.
export function guardedSourcePath(rel) {
  const root = fs.realpathSync(path.resolve(config.repoRoot));
  const resolved = path.resolve(root, String(rel || ''));
  let real;
  try { real = fs.realpathSync(resolved); } catch { return { error: `no such path: ${rel}` }; }
  if (real !== root && !real.startsWith(root + path.sep)) {
    return { error: `path escapes the source root: ${rel}` };
  }
  return { root, real };
}

// ── SQL helpers (the medic role's pool) ─────────────────────────────────────────────────────────
// One statement only: the audit records exactly what runs, and a stacked second statement would run
// unrecorded behind the first. Trailing semicolons are fine; an interior one is refused.
export function singleStatement(sql) {
  const s = String(sql || '').trim().replace(/;+\s*$/, '');
  if (!s) return { error: 'an empty statement' };
  if (s.includes(';')) return { error: 'ONE statement per call — the audit records exactly what runs, and a second statement behind a semicolon would run unrecorded' };
  return { sql: s };
}

async function medicQuery(sql, { readOnly = false } = {}) {
  const pool = await medicDbPool();
  const client = await pool.connect();
  try {
    await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    const res = await client.query(sql);
    await client.query('COMMIT');
    return res;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// The medic subject the stage-3 handlers expect (they read .id / .slug / .project_id; infra_request
// tolerates a null xell_id — the zee row carries attribution).
const handlerSubject = (medic) => ({ id: null, slug: `medic:${String(medic.id).slice(0, 8)}`,
                                     project_id: medic.target_project_id });
const targetOf = (medic, args) => args?.project || medic.target_project_id;

// ── the registry ────────────────────────────────────────────────────────────────────────────────
export const MEDIC_TOOLS = {
  meta_select: {
    name: 'meta_select',
    description: 'Run ONE SELECT over the whole orchestrator meta-DB (read-only transaction on the '
      + `medic role; provider_token's secret column is revoked; first ${META_SELECT_ROW_CAP} rows). `
      + 'PURE READ — it writes nothing.',
    schema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
    run: async (medic, args) => {
      const st = singleStatement(args?.sql);
      if (st.error) return refuse(st.error);
      if (!/^select\b|^with\b/i.test(st.sql)) return refuse('meta_select runs SELECT (or WITH…SELECT) only — use meta_write for a write');
      const res = await medicQuery(st.sql, { readOnly: true });
      const rows = (res.rows || []).slice(0, META_SELECT_ROW_CAP);
      return { ok: true, rowCount: res.rowCount, capped: (res.rows || []).length > rows.length, rows };
    },
  },
  meta_write: {
    name: 'meta_write',
    description: 'Run ONE INSERT/UPDATE/DELETE on the meta-DB CONFIG surface, on YOUR role — its '
      + 'GRANTs are the wall (config tables only; lifecycle tables, gates, ledgers and harness '
      + 'refuse at postgres). AUDITED VERBATIM to the medic_action ledger BEFORE it runs; an act '
      + 'whose audit cannot be written is refused. Write the narrowest statement that fixes the '
      + 'named fault.',
    schema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
    run: async (medic, args) => {
      const st = singleStatement(args?.sql);
      if (st.error) return refuse(st.error);
      if (/^select\b/i.test(st.sql)) return refuse('meta_write is for writes — use meta_select to read');
      // Audit FIRST, on the owner pool — a refused write must still leave its row, and an
      // unwritable audit refuses the act (never the reverse).
      let actionId;
      try {
        actionId = await recordMedicAction(medic.id, { tool: 'meta_write', statement: st.sql });
      } catch (e) {
        return refuse(`the audit ledger refused (${e.message}) — no write runs unrecorded`);
      }
      try {
        const res = await medicQuery(st.sql);
        await finishMedicAction(actionId, { rowsAffected: res.rowCount,
          result: { ok: true, command: res.command } });
        return { ok: true, rowCount: res.rowCount, command: res.command };
      } catch (e) {
        await finishMedicAction(actionId, { rowsAffected: 0,
          result: { ok: false, refused: true, reason: e.message } }).catch(() => {});
        return refuse(`postgres refused: ${e.message}`);
      }
    },
  },
  source_read: {
    name: 'source_read',
    description: 'Read ONE file of the Zeehive source, read-only (path-guarded to the repo root, '
      + `first ${SOURCE_READ_CAP} bytes). There is no write or exec sibling — you can see the `
      + 'code, never touch it.',
    schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: async (_medic, args) => {
      const g = guardedSourcePath(args?.path);
      if (g.error) return refuse(g.error);
      if (!fs.statSync(g.real).isFile()) return refuse(`not a file: ${args?.path}`);
      const text = fs.readFileSync(g.real, 'utf8');
      return { ok: true, path: args.path, truncated: text.length > SOURCE_READ_CAP,
               content: text.slice(0, SOURCE_READ_CAP) };
    },
  },
  source_search: {
    name: 'source_search',
    description: 'git grep -n a fixed string (not a regex) across the Zeehive source, read-only. '
      + 'Optional path narrows the search.',
    schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } },
              required: ['pattern'] },
    run: async (_medic, args) => {
      const pattern = String(args?.pattern || '');
      if (!pattern) return refuse('a pattern is required');
      const g = guardedSourcePath(args?.path || '.');
      if (g.error) return refuse(g.error);
      try {
        const { stdout } = await execFileP('git', ['-C', g.root, 'grep', '-nF', '--', pattern,
          ...(args?.path ? ['--', String(args.path)] : [])], { maxBuffer: 512 * 1024 });
        return { ok: true, matches: stdout.split('\n').filter(Boolean).slice(0, 200) };
      } catch (e) {
        if (e.code === 1) return { ok: true, matches: [] };   // git grep: 1 = no match
        return refuse(`git grep failed: ${String(e.message).slice(0, 200)}`);
      }
    },
  },
  source_history: {
    name: 'source_history',
    description: 'git log (one-line, newest first) of the Zeehive source — optionally for one '
      + 'path. Read-only.',
    schema: { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'number' } }, required: [] },
    run: async (_medic, args) => {
      const g = guardedSourcePath(args?.path || '.');
      if (g.error) return refuse(g.error);
      const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 100);
      try {
        const { stdout } = await execFileP('git', ['-C', g.root, 'log', `--max-count=${limit}`,
          '--oneline', '--', args?.path ? String(args.path) : '.'], { maxBuffer: 256 * 1024 });
        return { ok: true, log: stdout.split('\n').filter(Boolean) };
      } catch (e) { return refuse(`git log failed: ${String(e.message).slice(0, 200)}`); }
    },
  },
  readiness: {
    name: 'readiness',
    description: 'Run/read machine×project build readiness for the TARGET project (defaults to '
      + 'the one you were dispatched for). refresh:true runs the probe now. NOT gated.',
    schema: { type: 'object', properties: { project: { type: 'string' }, refresh: { type: 'boolean' } }, required: [] },
    run: async (medic, args) => {
      const { infraReadiness } = await import('./infra-medic.js');
      return infraReadiness(handlerSubject(medic), { refresh: !!args?.refresh, project: targetOf(medic, args) });
    },
  },
  proof: {
    name: 'proof',
    description: 'Burn in a pooled xell of the TARGET project — the real build path on throwaway '
      + 'containers (same class as a zee build). NOT gated.',
    schema: { type: 'object', properties: { project: { type: 'string' }, xell: { type: 'string' } }, required: [] },
    run: async (medic, args) => {
      const { infraProof } = await import('./infra-medic.js');
      return infraProof(handlerSubject(medic), { xellSlug: args?.xell || null, project: targetOf(medic, args) });
    },
  },
  bootstrap_plan: {
    name: 'bootstrap_plan',
    description: 'The dry-run bootstrap plan for a machine of the TARGET project — what would be '
      + 'created, what cannot be. Performs NOTHING. NOT gated.',
    schema: { type: 'object', properties: { project: { type: 'string' }, machine: { type: 'string' } }, required: ['machine'] },
    run: async (medic, args) => {
      const { infraBootstrapPlan } = await import('./infra-medic.js');
      return infraBootstrapPlan(handlerSubject(medic), { machineId: args?.machine, project: targetOf(medic, args) });
    },
  },
  bootstrap_perform: {
    name: 'bootstrap_perform',
    description: 'File the HUMAN-GATED bootstrap card for a machine of the TARGET project. It '
      + 'mutates real docker on real hosts, which your meta-DB access does not cover — it performs '
      + 'NOTHING until a human approves; the queenzee performs and the card is the receipt.',
    schema: { type: 'object', properties: { project: { type: 'string' }, machine: { type: 'string' },
              reason: { type: 'string' } }, required: ['machine', 'reason'] },
    run: async (medic, args) => {
      const { infraBootstrap } = await import('./infra-medic.js');
      const actionId = await recordMedicAction(medic.id, { tool: 'bootstrap_perform',
        statement: JSON.stringify({ machine: args?.machine, reason: args?.reason }) });
      const out = await infraBootstrap(handlerSubject(medic),
        { machineId: args?.machine, reason: args?.reason, project: targetOf(medic, args) });
      await finishMedicAction(actionId, { result: { card: out?.card?.id || null, existing: !!out?.existing } });
      return out;
    },
  },
  docker_repair: {
    name: 'docker_repair',
    description: 'Repair WEDGED docker state on ONE machine (by key or id) — the lever for the '
      + 'stale-leftover fault family: prunes EMPTY *-spin-* networks (the address-pool exhaustion '
      + 'fix), removes RETIRED xells\' husk containers (port squatters), and STARTS stopped dev '
      + 'dbs the meta-DB already models. The queenzee performs it on its own docker contexts; the '
      + 'guards are code (a required external network is never pruned, an unknown container is '
      + 'never touched, nothing is ever stopped). dry_run:true returns the plan and performs '
      + 'NOTHING. Same acts-immediately class as proof (throwaway spin leftovers only). AUDITED.',
    schema: { type: 'object', properties: { machine: { type: 'string' }, dry_run: { type: 'boolean' } },
              required: ['machine'] },
    run: async (medic, args) => {
      const { performDockerRepair } = await import('./docker-repair.js');
      const dryRun = !!args?.dry_run;
      // Audit FIRST, meta_write's discipline: a docker mutation must never run unrecorded.
      let actionId = null;
      if (!dryRun) {
        try {
          actionId = await recordMedicAction(medic.id, { tool: 'docker_repair',
            statement: JSON.stringify({ machine: args?.machine }) });
        } catch (e) {
          return refuse(`the audit ledger refused (${e.message}) — no repair runs unrecorded`);
        }
      }
      try {
        const out = await performDockerRepair(args?.machine, { dryRun,
          actor: `medic:${String(medic.id).slice(0, 8)}` });
        if (actionId) await finishMedicAction(actionId, { result: { status: out.status,
          steps: (out.results || []).map((s) => `${s.kind}:${s.target}=${s.status}`) } });
        return { ok: out.status !== 'refused' && out.status !== 'failed', ...out };
      } catch (e) {
        if (actionId) await finishMedicAction(actionId, { result: { ok: false, reason: e.message } }).catch(() => {});
        return refuse(String(e.message).slice(0, 300));
      }
    },
  },
  settings: {
    name: 'settings',
    description: 'The TARGET project\'s settings projection: project row, pool_config, machines, '
      + 'container rows, deploy sites. PURE READ.',
    schema: { type: 'object', properties: { project: { type: 'string' } }, required: [] },
    run: async (medic, args) => {
      const { infraSettings } = await import('./infra-medic.js');
      return infraSettings(handlerSubject(medic), { project: targetOf(medic, args) });
    },
  },
  manifest_refresh: {
    name: 'manifest_refresh',
    description: 'Re-read the TARGET project\'s manifest from its repo into the manifest cache — '
      + 'the fix for a stale-manifest fault. Audited.',
    schema: { type: 'object', properties: { project: { type: 'string' } }, required: [] },
    run: async (medic, args) => {
      const { refreshProjectManifest } = await import('./projects.js');
      const { one } = await import('../db/pool.js');
      const target = targetOf(medic, args);
      const p = await one(`SELECT id, name FROM project WHERE id::text=$1 OR lower(name)=lower($1)`, [String(target)]);
      if (!p) return refuse(`no project '${target}'`);
      const actionId = await recordMedicAction(medic.id, { tool: 'manifest_refresh',
        statement: `manifest refresh for ${p.name}`, tables: ['project'] });
      const out = await refreshProjectManifest(p.id);
      await finishMedicAction(actionId, { result: { ok: true, project: p.name } });
      return { ok: true, project: p.name, ...out };
    },
  },
  condition_add: {
    name: 'condition_add',
    description: 'Write a dated line onto the TARGET project\'s current-conditions list (the live '
      + 'impediments every briefing carries). Audited.',
    schema: { type: 'object', properties: { project: { type: 'string' }, body: { type: 'string' } }, required: ['body'] },
    run: async (medic, args) => {
      const { addProjectCondition } = await import('./current-conditions.js');
      const { one } = await import('../db/pool.js');
      const target = targetOf(medic, args);
      const p = await one(`SELECT id, name FROM project WHERE id::text=$1 OR lower(name)=lower($1)`, [String(target)]);
      if (!p) return refuse(`no project '${target}'`);
      const actionId = await recordMedicAction(medic.id, { tool: 'condition_add',
        statement: String(args?.body || ''), tables: ['project_condition'] });
      const out = await addProjectCondition(p.id, args?.body, { actor: `medic:${String(medic.id).slice(0, 8)}` });
      await finishMedicAction(actionId, { result: { id: out?.id || null } });
      return { ok: true, condition: out };
    },
  },
  condition_remove: {
    name: 'condition_remove',
    description: 'DELETE a condition line of the TARGET project — the close-the-loop act for a '
      + 'fault you have FIXED and re-proven. Audited.',
    schema: { type: 'object', properties: { project: { type: 'string' }, id: { type: 'string' } }, required: ['id'] },
    run: async (medic, args) => {
      const { removeProjectConditionScoped } = await import('./current-conditions.js');
      const { one } = await import('../db/pool.js');
      const target = targetOf(medic, args);
      const p = await one(`SELECT id, name FROM project WHERE id::text=$1 OR lower(name)=lower($1)`, [String(target)]);
      if (!p) return refuse(`no project '${target}'`);
      const actionId = await recordMedicAction(medic.id, { tool: 'condition_remove',
        statement: String(args?.id || ''), tables: ['project_condition'] });
      const out = await removeProjectConditionScoped(args?.id, p.id);
      await finishMedicAction(actionId, { result: out });
      return out;
    },
  },
  dispatch_worker: {
    name: 'dispatch_worker',
    description: 'Cut a work item and deploy an ordinary ZEEHIVE worker (a real xell, the normal '
      + 'land/ship gates) — for a fault that needs ZEEHIVE CODE. Refused for any other project: '
      + 'another project\'s code is never yours, and config faults are yours to fix directly.',
    schema: { type: 'object', properties: { title: { type: 'string' }, task: { type: 'string' },
              project: { type: 'string' } }, required: ['title', 'task'] },
    run: async (medic, args) => {
      const { selfProjectId } = await import('./infra-medic.js');
      const selfId = await selfProjectId();
      if (args?.project) {
        const { one } = await import('../db/pool.js');
        const p = await one(`SELECT id FROM project WHERE id::text=$1 OR lower(name)=lower($1)`, [String(args.project)]);
        if (!p || p.id !== selfId) {
          return refuse('dispatch_worker deploys ZEEHIVE workers only — a code fault in another '
            + 'project is that project\'s crew\'s, reported with the named check; a config fault is '
            + 'yours to fix with meta_write.');
        }
      }
      const actor = `medic:${String(medic.id).slice(0, 8)}`;
      const actionId = await recordMedicAction(medic.id, { tool: 'dispatch_worker',
        statement: JSON.stringify({ title: args?.title, task: String(args?.task || '').slice(0, 2000) }),
        tables: ['work_item'] });
      try {
        const { createWorkItem } = await import('./work-items.js');
        const { deployWorkItem } = await import('./work-assign.js');
        const item = await createWorkItem({ project_id: selfId, title: String(args.title).slice(0, 200),
          body: String(args.task), actor });
        const out = await deployWorkItem(item.id, { task: String(args.task), actor });
        await finishMedicAction(actionId, { result: { item: item.id, xell: out?.slug || out?.xell_id || null } });
        await updateMedicStatus(medic.id, 'worker-dispatched');
        return { ok: true, item: item.id, ...out };
      } catch (e) {
        await finishMedicAction(actionId, { result: { ok: false, reason: e.message } }).catch(() => {});
        return refuse(`dispatch failed: ${String(e.message).slice(0, 300)}`);
      }
    },
  },
  report: {
    name: 'report',
    description: 'Report your status to the Medic Bay: one of diagnosing | acting | '
      + 'worker-dispatched | converged, with a short note. Opens no gate.',
    schema: { type: 'object', properties: { status: { type: 'string' }, message: { type: 'string' } },
              required: ['message'] },
    run: async (medic, args) => {
      const status = String(args?.status || '').trim();
      if (status && !['diagnosing', 'acting', 'worker-dispatched', 'converged'].includes(status)) {
        return refuse(`"${status}" is not yours to set — retired/errored belong to humans and the driver`);
      }
      await recordMedicAction(medic.id, { tool: 'report',
        statement: `${status ? `[${status}] ` : ''}${String(args?.message || '').slice(0, 2000)}` });
      if (status) await updateMedicStatus(medic.id, status);
      return { ok: true, status: status || undefined };
    },
  },
  need_human: {
    name: 'need_human',
    description: 'Raise "I need a human" with a ONE-LINE reason (it is the whole message a human '
      + 'sees in the Bay). This ENDS your turn — you are resumed when a human answers.',
    schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
    endsTurn: true,
    run: async (medic, args) => {
      const reason = String(args?.reason || '').trim();
      if (!reason) return refuse('the reason is required — it is the whole message a human sees');
      await updateMedicStatus(medic.id, 'awaiting-human', { needsHumanReason: reason.slice(0, 500) });
      await recordMedicAction(medic.id, { tool: 'need_human', statement: reason.slice(0, 2000) });
      return { ok: true, message: reason };
    },
  },
};

export function medicToolList() {
  return Object.values(MEDIC_TOOLS);
}

// The single dispatch path for medic tools — the allowlist refusal, mirroring runTool.
export async function runMedicTool(medic, { name = null, args = {} } = {}) {
  const desc = MEDIC_TOOLS[name];
  if (!desc) {
    return JSON.stringify({ ok: false, error: `"${name}" is not a medic tool — the registry is the `
      + 'confinement and that verb is not on it.' });
  }
  try {
    const out = await desc.run(medic, args || {});
    return typeof out === 'string' ? out : JSON.stringify(out);
  } catch (e) {
    logline('medic', `tool "${name}" error: ${String(e.message).slice(0, 200)}`);
    return JSON.stringify({ ok: false, error: `tool "${name}" error: ${String(e.message).slice(0, 300)}` });
  }
}

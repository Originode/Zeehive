// The container MATRIX — the inventory as role-rows × machine-columns. One column per machine
// (023), so "what runs WHERE" is the shape of the panel instead of a tooltip fact. A container
// chip sits in the column of the context it RUNS on; where it COMPILES is the chip's ⇄ marker
// (a machine that can't build — the NAS — runs images built elsewhere).
//
// The column header is the machine's control surface: dev spawn priority, pool size / max cap,
// can-build, and — when the machine has no shared dev db for this project — the one-click
// provision that makes it able to host xells at all. "+ machine" adds a host as the hive grows.
import React, { useState, useEffect } from 'react';
import { ContainerChip } from './Container.jsx';
import { getDockerContexts, createMachine, updateMachine, deleteMachine, provisionMachineDevDb,
         getSites, createSite } from './api.js';

const ROLE_LABEL = { db: 'DB', server: 'Server', webapp: 'App', other: 'Other' };
const ROLES = ['db', 'server', 'webapp', 'other'];

const fail = (what) => (e) => alert(`${what} failed: ${e?.error || e?.message || e}`);

export default function MachineMatrix({ machines, containers, projectId, onMenu, onChanged }) {
  const ms = machines || [];
  const all = ROLES.flatMap((r) => (containers[r] || []).map((c) => ({ ...c, _role: r })));

  // Where a container lives, for column placement: its own run context — or, for a PROCESS role
  // (docker_ctx NULL, probed by URL: the self-shipped queenzee), its deploy site's context. A
  // process on machine 'local' belongs in local's column, not in limbo.
  const ctxOf = (c) => c.docker_ctx || c.site_docker_ctx || null;

  // Containers whose context matches no machine row (or has none at all) still must be SEEN —
  // an "elsewhere" column appears only when such containers exist, and disappears when the
  // machines fully describe the fleet.
  const known = new Set(ms.map((m) => m.docker_ctx));
  const orphans = all.filter((c) => !known.has(ctxOf(c)));
  const cols = [...ms.map((m) => ({ kind: 'machine', m })),
                ...(orphans.length ? [{ kind: 'elsewhere' }] : [])];

  // No machines yet → the matrix degrades to the old one-row-per-role inventory, plus the
  // "+ machine" affordance that starts the migration to machine-aware placement.
  if (!cols.length) {
    return (
      <section className="inventory" data-testid="matrix">
        {ROLES.map((role) => (
          <div className="invrow" key={role} data-role={role}>
            <span className="invlabel">{ROLE_LABEL[role]}:</span>
            <span className="boxes">
              {(containers[role] || []).map((c) => <ContainerChip key={c.id} c={c} onMenu={onMenu} />)}
              {(!containers[role] || containers[role].length === 0) && <span className="cbox empty">—</span>}
            </span>
          </div>
        ))}
        <AddMachine onChanged={onChanged} />
      </section>
    );
  }

  const cell = (role, col) => {
    const cs = col.kind === 'machine'
      ? all.filter((c) => c._role === role && ctxOf(c) === col.m.docker_ctx)
      : orphans.filter((c) => c._role === role);
    return cs.length
      ? cs.map((c) => <ContainerChip key={c.id} c={c} onMenu={onMenu} />)
      : <span className="cbox empty">—</span>;
  };

  return (
    <section className="matrix" data-testid="matrix"
             style={{ gridTemplateColumns: `max-content repeat(${cols.length}, minmax(120px, 1fr)) max-content` }}>
      {/* header row */}
      <span className="mx-corner" />
      {cols.map((col, i) => col.kind === 'machine'
        ? <MachineHead key={col.m.id} m={col.m} projectId={projectId}
                       hasDevDb={all.some((c) => c._role === 'db' && c.tier === 'dev' && c.isolation === 'shared' && c.docker_ctx === col.m.docker_ctx)}
                       empty={!all.some((c) => ctxOf(c) === col.m.docker_ctx)}
                       onChanged={onChanged} />
        : <div key={`col-${i}`} className="mx-head elsewhere" title="Containers whose docker context matches no machine row — add the machine to claim them into a column">elsewhere</div>)}
      <AddMachine onChanged={onChanged} />
      {/* one row per role */}
      {ROLES.map((role) => (
        <React.Fragment key={role}>
          <span className="invlabel mx-role">{ROLE_LABEL[role]}:</span>
          {cols.map((col, i) => (
            <span className="boxes mx-cell" key={`${role}-${i}`} data-role={role}
                  data-machine={col.kind === 'machine' ? col.m.key : 'elsewhere'}>
              {cell(role, col)}
            </span>
          ))}
          <span className="mx-pad" />
        </React.Fragment>
      ))}
    </section>
  );
}

// A machine's header: identity + the policy knobs, edited in place. Numbers commit on blur/Enter;
// every change PATCHes and refreshes, so what you read is always the server's truth.
function MachineHead({ m, projectId, hasDevDb, empty, onChanged }) {
  const [busy, setBusy] = useState(false);
  const patch = async (p) => {
    setBusy(true);
    try { await updateMachine(m.id, p); onChanged?.(); }
    catch (e) { fail('Machine update')(e); }
    finally { setBusy(false); }
  };

  const provisionDb = async () => {
    if (!confirm(`Provision ${m.key}'s own shared dev DB?\n\nThis stands up a fresh dev postgres ON ${m.key} (${m.docker_ctx}) and restores the latest prod backup into it — additive, touches nothing else. It takes a few minutes; watch the queenzee terminal.\n\nWithout it, ${m.key} cannot host dev xells.`)) return;
    setBusy(true);
    try { await provisionMachineDevDb(m.id, projectId); alert(`Provisioning started on ${m.key} — the DB chip appears in this column when it's ready (watch the terminal).`); }
    catch (e) { fail('Dev DB provision')(e); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!confirm(`Remove machine "${m.key}" from the hive?\n\nOnly the row is deleted — nothing on the host is touched. Refused while containers still run there.`)) return;
    try { await deleteMachine(m.id); onChanged?.(); } catch (e) { fail('Delete machine')(e); }
  };

  // A human placing PRODUCTION on this machine: creates the prod deploy site here, which brings
  // its production xell with it (one per prod site). The first prod site becomes the default ship
  // target; ships offer the choice in the approve dialog once there is more than one.
  const addProd = async () => {
    setBusy(true);
    try {
      const sites = await getSites(projectId);
      const existing = (sites || []).find((s) => s.tier === 'prod' && s.docker_ctx === m.docker_ctx);
      if (existing) { alert(`${m.key} already hosts a production site for this project ("${existing.key}").`); return; }
      const first = !(sites || []).some((s) => s.tier === 'prod');
      const key = `prod-${m.key}`;
      if (!confirm(`Add a PRODUCTION on ${m.key}?\n\nThis creates prod site "${key}" (${m.docker_ctx}${m.host_ip ? ` @ ${m.host_ip}` : ''}) and its production xell${first ? ', and makes it the DEFAULT ship target' : ' — ships can target it from the approve dialog'}.\n\nNothing deploys yet; this only models where production lives.`)) return;
      await createSite(projectId, { key, tier: 'prod', docker_ctx: m.docker_ctx, host: m.host_ip || null, is_default: first });
      onChanged?.();
    } catch (e) { fail('Add production')(e); }
    finally { setBusy(false); }
  };


  const num = (field, v, title, min = 0) => (
    <label className="mx-knob" title={title}>
      <span className="k">{field === 'dev_priority' ? 'prio' : field === 'pool_size' ? 'pool' : 'cap'}</span>
      <input type="number" min={min} defaultValue={v} disabled={busy} data-testid={`mx-${field}-${m.key}`}
             onBlur={(e) => Number(e.target.value) !== v && patch({ [field]: Number(e.target.value) })}
             onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />
    </label>
  );

  return (
    <div className={`mx-head${m.enabled ? '' : ' off'}`} data-testid={`machine-${m.key}`}>
      <div className="mx-name" title={`${m.label || m.key}\ncontext: ${m.docker_ctx}${m.host_ip ? `\nhost: ${m.host_ip}` : ''}${m.notes ? `\n${m.notes}` : ''}`}>
        <b>{m.key}</b>
        <button className="mx-prod" data-testid={`mx-prod-${m.key}`} disabled={busy} onClick={addProd}
                title={`Place a PRODUCTION on ${m.key} — creates the prod site + its production xell here`}>＋prod</button>
        {empty && <button className="mx-del" title="Remove this machine row" onClick={remove}>✕</button>}
      </div>
      <div className="mx-knobs">
        {num('dev_priority', m.dev_priority, 'Dev spawn priority — the highest-priority machine with room gets new dev xells first. 0 = never a dev host.')}
        {num('pool_size', m.pool_size, 'How many READY (pre-warmed) xells the pool keeps on this machine PER PROJECT.')}
        {num('max_xells', m.max_xells, 'Machine-wide cap: total live dev xells here across ALL projects (ready + claimed + working).')}
        <label className={`mx-build${m.can_build ? ' on' : ''}`}
               title={m.can_build ? 'Suitable for compiling images — its xells build here, and it can compile for machines that can\'t.'
                                  : 'NOT a build host — xells that run here compile on the best can-build machine and the image is handed over via the registry.'}>
          <input type="checkbox" checked={!!m.can_build} disabled={busy}
                 onChange={(e) => patch({ can_build: e.target.checked })} />
          🔨
        </label>
      </div>
      {m.dev_priority > 0 && !hasDevDb && (
        <button className="mx-devdb" data-testid={`mx-devdb-${m.key}`} disabled={busy} onClick={provisionDb}
                title={`${m.key} is a dev spawn target but has NO shared dev db for this project — xells cannot spawn here until it does (their db must never live on another machine).`}>
          ⚠ no dev db — provision
        </button>
      )}
    </div>
  );
}

// "+ machine": register another docker host. The context list comes from docker itself, so the
// choice is always a context this queenzee can actually reach.
function AddMachine({ onChanged }) {
  const [open, setOpen] = useState(false);
  const [ctxs, setCtxs] = useState(null);
  const [f, setF] = useState({ key: '', docker_ctx: '', host_ip: '', can_build: false, dev_priority: 0, pool_size: 0, max_xells: 0 });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open || ctxs) return;
    getDockerContexts().then((l) => setCtxs(l || [])).catch(() => setCtxs([]));
  }, [open, ctxs]);

  const save = async () => {
    setBusy(true);
    try {
      await createMachine({ ...f, key: f.key.trim() || f.docker_ctx, host_ip: f.host_ip.trim() || null });
      setOpen(false);
      setF({ key: '', docker_ctx: '', host_ip: '', can_build: false, dev_priority: 0, pool_size: 0, max_xells: 0 });
      onChanged?.();
    } catch (e) { fail('Add machine')(e); }
    finally { setBusy(false); }
  };

  if (!open) {
    return <button className="mx-add" data-testid="add-machine" title="Register another docker host as a machine"
                   onClick={() => setOpen(true)}>＋ machine</button>;
  }
  return (
    <div className="mx-addform" data-testid="add-machine-form">
      <label>context
        <select value={f.docker_ctx} onChange={(e) => setF({ ...f, docker_ctx: e.target.value, key: f.key || e.target.value.replace(/[^a-z0-9-]/gi, '-').toLowerCase() })}>
          <option value="">choose…</option>
          {(ctxs || []).map((k) => <option key={k.name} value={k.name}>{k.name}</option>)}
        </select></label>
      <label>key<input value={f.key} placeholder="local" onChange={(e) => setF({ ...f, key: e.target.value })} /></label>
      <label>host IP<input value={f.host_ip} placeholder="for xell URLs" onChange={(e) => setF({ ...f, host_ip: e.target.value })} /></label>
      <label>prio<input type="number" min="0" value={f.dev_priority} onChange={(e) => setF({ ...f, dev_priority: Number(e.target.value) })} /></label>
      <label>pool<input type="number" min="0" value={f.pool_size} onChange={(e) => setF({ ...f, pool_size: Number(e.target.value) })} /></label>
      <label>cap<input type="number" min="0" value={f.max_xells} onChange={(e) => setF({ ...f, max_xells: Number(e.target.value) })} /></label>
      <label className="mx-cb"><input type="checkbox" checked={f.can_build} onChange={(e) => setF({ ...f, can_build: e.target.checked })} />🔨 builds</label>
      <button disabled={busy || !f.docker_ctx} onClick={save}>Add</button>
      <button className="mx-cancel" onClick={() => setOpen(false)}>✕</button>
    </div>
  );
}

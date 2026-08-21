// The container MATRIX — the inventory as role-rows × machine-columns. One column per machine
// (023), so "what runs WHERE" is the shape of the panel instead of a tooltip fact. A container
// chip sits in the column of the context it RUNS on; where it COMPILES is the chip's ⇄ marker
// (a machine that can't build — the NAS — runs images built elsewhere).
//
// The column header is the machine's control surface: dev spawn priority, pool size / max cap,
// can-build, and — when the machine has no shared dev db for this project — the one-click
// provision that makes it able to host xells at all. "+ machine" adds a host as the hive grows.
import React, { useState, useEffect, useCallback } from 'react';
import { ContainerChip } from './Container.jsx';
import { getDockerContexts, createMachine, updateMachine, deleteMachine, provisionMachineDevDb,
         setMachinePool, setMachinePriority, getSites, createSite,
         registerDevice, provisionAdbHost, getUsbDevices, getAdbDevices, checkMachineConnection,
         getBuildReadiness, planBuildBootstrap, performBuildBootstrap } from './api.js';
import { showAlert, showConfirm, showPrompt } from './Dialog.jsx';

const ROLE_LABEL = { db: 'DB', server: 'Server', webapp: 'App', device: 'Device', other: 'Other' };
const BASE_ROLES = ['db', 'server', 'webapp', 'other'];

const fail = (what) => (e) => showAlert(`${what} failed: ${e?.error || e?.message || e}`, { variant: 'error' });

export default function MachineMatrix({ machines, containers, projectId, spinoffIsProcess, onMenu, onChanged }) {
  const ms = machines || [];
  // The device row is opt-in: shown only when this project actually uses devices (a device chip
  // exists, or a machine is marked can_device), so ordinary projects keep a 4-row matrix.
  const usesDevices = (containers.device || []).length > 0 || ms.some((m) => m.can_device);
  const ROLES = usesDevices ? ['db', 'server', 'webapp', 'device', 'other'] : BASE_ROLES;
  const all = ROLES.flatMap((r) => (containers[r] || []).map((c) => ({ ...c, _role: r })));

  // PROCESS PROJECTS: a remote machine's prio/pool knobs have NO EFFECT — a process xell's
  // worktree, processes and cage all live on the queenzee host, so a remote machine can never
  // host one. The queenzee-host row (is_queenzee_host, computed by the server) is the working
  // knob: its pool_size governs the project (queenzee/pool.js). This used to be a red BANNER
  // that fired on every render as long as any remote knob was >0 — the operator's screenshot
  // said the rest (docs/pooling-dead-config-demotion-decision-record.md): since the
  // default-pooling ship the config is HARMLESS (the host row governs, the runaway is
  // structurally impossible), and harmless config is not an alert. The state now shows at the
  // knobs themselves: remote prio/pool render DIMMED with the reason in their tooltip, and
  // stay editable so an operator can still zero them.
  const poolingDeadFor = (m) => !!spinoffIsProcess && !m.is_queenzee_host;

  // MACHINE × PROJECT BUILD-READINESS (ticket #173): per-machine "can a build actually work
  // HERE?" probe, fetched once on mount and on a badge re-check. Read-only; the verdict is
  // ok | unknown | missing with the failing check named, rendered in each column header.
  const [readiness, setReadiness] = useState(null);          // array of per-machine verdicts
  const [readinessBusy, setReadinessBusy] = useState(false);
  const loadReadiness = useCallback(async () => {
    if (!projectId) { setReadiness(null); return; }
    setReadinessBusy(true);
    try { setReadiness(await getBuildReadiness(projectId)); }
    catch { setReadiness(null); }   // the badge shows an un-checked state; the matrix stays usable
    finally { setReadinessBusy(false); }
  }, [projectId]);
  useEffect(() => { loadReadiness(); }, [loadReadiness]);
  const readinessByMachine = Object.fromEntries(
    (readiness || []).map((r) => [r.machine_id, r]));

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
        <AddMachine projectId={projectId} onChanged={onChanged} />
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
      {cols.map((col, i) => {
        const devDb = (c) => c._role === 'db' && c.tier === 'dev' && c.isolation === 'shared';
        return col.kind === 'machine'
        ? <MachineHead key={col.m.id} m={col.m} projectId={projectId}
                       poolingDead={poolingDeadFor(col.m)}
                       readiness={readinessByMachine[col.m.id]}
                       readinessBusy={readinessBusy}
                       onRecheck={loadReadiness}
                       // Spec: a xell never crosses docker contexts for its database, so every dev
                       // machine wants this project's own dev db. Missing-here-but-exists-elsewhere
                       // is a WARNING (spawns here are being refused); missing-everywhere is the
                       // quiet bootstrap affordance for the project's first one.
                       hasDevDb={all.some((c) => devDb(c) && c.docker_ctx === col.m.docker_ctx)}
                       devDbElsewhere={all.some(devDb)}
                       empty={!all.some((c) => ctxOf(c) === col.m.docker_ctx)}
                       onChanged={onChanged} />
        : <div key={`col-${i}`} className="mx-head elsewhere" title="Containers whose docker context matches no machine row — add the machine to claim them into a column">elsewhere</div>;
      })}
      <AddMachine projectId={projectId} onChanged={onChanged} />
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
function MachineHead({ m, projectId, poolingDead = false, readiness = null, readinessBusy = false,
                       onRecheck = null, hasDevDb, devDbElsewhere, empty, onChanged }) {
  const [busy, setBusy] = useState(false);
  // Connection check state — the Deploy tab's per-machine "can the queenzee reach this host with
  // the settings on its row?" probe. null = not checked yet; { checking:true } = in flight; a
  // checkMachineConnection() result = the verdict (ok + reachable, or ok:false + error).
  const [conn, setConn] = useState(null);
  const check = async () => {
    setConn({ checking: true });
    try { setConn(await checkMachineConnection(m.id)); }
    catch (e) { setConn({ ok: false, reachable: false, error: e?.error || e?.message || String(e) }); }
  };
  const patch = async (p) => {
    setBusy(true);
    try { await updateMachine(m.id, p); onChanged?.(); }
    catch (e) { fail('Machine update')(e); }
    finally { setBusy(false); }
  };

  const provisionDb = async () => {
    if (!(await showConfirm(`Provision ${m.key}'s own shared dev DB?\n\nThis stands up a fresh dev postgres ON ${m.key} (${m.docker_ctx}) and restores the latest prod backup into it — additive, touches nothing else. It takes a few minutes; watch the queenzee terminal.\n\nWithout it, ${m.key} cannot host dev xells.`, { okLabel: 'Provision' }))) return;
    setBusy(true);
    try { await provisionMachineDevDb(m.id, projectId); showAlert(`Provisioning started on ${m.key} — the DB chip appears in this column when it's ready (watch the terminal).`); }
    catch (e) { fail('Dev DB provision')(e); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!(await showConfirm(`Remove machine "${m.key}" from the hive?\n\nOnly the row is deleted — nothing on the host is touched. Refused while containers still run there.`, { variant: 'danger', okLabel: 'Remove' }))) return;
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
      if (existing) { showAlert(`${m.key} already hosts a production site for this project ("${existing.key}").`); return; }
      const first = !(sites || []).some((s) => s.tier === 'prod');
      const key = `prod-${m.key}`;
      if (!(await showConfirm(`Add a PRODUCTION on ${m.key}?\n\nThis creates prod site "${key}" (${m.docker_ctx}${m.host_ip ? ` @ ${m.host_ip}` : ''}) and its production xell${first ? ', and makes it the DEFAULT ship target' : ' — ships can target it from the approve dialog'}.\n\nNothing deploys yet; this only models where production lives.`, { okLabel: 'Add production' }))) return;
      await createSite(projectId, { key, tier: 'prod', docker_ctx: m.docker_ctx, host: m.host_ip || null, is_default: first });
      onChanged?.();
    } catch (e) { fail('Add production')(e); }
    finally { setBusy(false); }
  };


  // pool AND prio are per (machine, PROJECT) — they write machine_pool for the project in view,
  // not the machine row; only cap (max_xells) is the host's own machine-wide fact and PATCHes it.
  const setPool = async (n) => {
    setBusy(true);
    try { await setMachinePool(m.id, projectId, n); onChanged?.(); }
    catch (e) { fail('Pool size')(e); }
    finally { setBusy(false); }
  };
  const setPrio = async (n) => {
    setBusy(true);
    try { await setMachinePriority(m.id, projectId, n); onChanged?.(); }
    catch (e) { fail('Priority')(e); }
    finally { setBusy(false); }
  };
  // `dead` dims the knob without disabling it (the value stays editable so an operator can
  // still zero old numbers) and swaps the tooltip for the reason it has no effect here.
  const num = (field, v, title, onCommit, dead = false, deadTitle = null) => (
    <label className={`mx-knob${dead ? ' dead' : ''}`} {...(dead ? { 'data-pooling-dead': m.key } : {})}
           title={dead ? (deadTitle || title) : title}>
      <span className="k">{field === 'dev_priority' ? 'prio' : field === 'pool_size' ? 'pool' : 'cap'}</span>
      <input type="number" min="0" defaultValue={v} disabled={busy} data-testid={`mx-${field}-${m.key}`}
             onBlur={(e) => Number(e.target.value) !== v
               && (onCommit ? onCommit(Number(e.target.value)) : patch({ [field]: Number(e.target.value) }))}
             onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />
    </label>
  );

  // BUILD-READINESS DEMOTION (ticket #173, same pattern as pooling-dead):
  // when the probe says this machine cannot build the project — or cannot tell — the
  // prio/pool knobs that would place xells here are DIMMED with the reason in the tooltip,
  // not silently green. The knobs stay editable so an operator can still zero them.
  const buildDead = !!readiness && readiness.status !== 'ok'
    && (Number(m.dev_priority) > 0 || Number(m.pool_size) > 0);
  const buildDeadReason = buildDead
    ? `⚠ ${m.key} cannot build this project (readiness ${readiness.status}): ${readiness.error || 'no reason recorded'}\n`
      + 'Xells placed here will fail to build. See the build-ready badge (⚙) for the failing check.'
    : null;
  const poolingDeadReason = 'No effect for this project: the spinoff server is runner:process, so its xells all run on the queenzee host — set the pool on the queenzee-host machine\'s column instead. To place xells on ' + m.key + ', give the server a compose runner in zeehive.yml.';

  return (
    <div className={`mx-head${m.enabled ? '' : ' off'}`} data-testid={`machine-${m.key}`}>
      <div className="mx-name" title={`${m.label || m.key}\ncontext: ${m.docker_ctx}${m.host_ip ? `\nhost: ${m.host_ip}` : ''}${m.notes ? `\n${m.notes}` : ''}`}>
        <b>{m.key}</b>
        <button className="mx-prod" data-testid={`mx-prod-${m.key}`} disabled={busy} onClick={addProd}
                title={`Place a PRODUCTION on ${m.key} — creates the prod site + its production xell here`}>＋prod</button>
        <MachineConn m={m} conn={conn} onCheck={check} />
        <BuildReady m={m} readiness={readiness} busy={readinessBusy} onRecheck={onRecheck} />
        <BootstrapButton m={m} projectId={projectId} readiness={readiness}
                         onDone={onRecheck} onChanged={onChanged} />
        {empty && <button className="mx-del" title="Remove this machine row" onClick={remove}>✕</button>}
      </div>
      <div className="mx-knobs">
        {num('dev_priority', m.dev_priority, 'Dev spawn priority for THIS project — the highest-priority machine with room gets this project\'s new dev xells first. 0 = not a dev host for this project. Per project — one project can prefer this box while another prefers the laptop.', setPrio, poolingDead || buildDead, buildDead ? buildDeadReason : poolingDeadReason)}
        {num('pool_size', m.pool_size, 'How many READY (pre-warmed) xells THIS project keeps on this machine. Per project — a high-load project pools bigger here than a quiet one.', setPool, poolingDead || buildDead, buildDead ? buildDeadReason : poolingDeadReason)}
        {num('max_xells', m.max_xells, 'Machine-wide cap: total live dev xells here across ALL projects (ready + claimed + working).')}
        <label className={`mx-build${m.can_build ? ' on' : ''}`}
               title={m.can_build ? 'Suitable for compiling images — its xells build here, and it can compile for machines that can\'t.'
                                  : 'NOT a build host — xells that run here compile on the best can-build machine and the image is handed over via the registry.'}>
          <input type="checkbox" checked={!!m.can_build} disabled={busy}
                 onChange={(e) => patch({ can_build: e.target.checked })} />
          🔨
        </label>
        {/* can_device (035): this host can run Android emulators (needs a Linux host with /dev/kvm)
            or tether physical phones. A xell's device xhip is REFUSED on a machine that lacks it. */}
        <label className={`mx-build mx-device${m.can_device ? ' on' : ''}`} data-testid={`mx-candevice-${m.key}`}
               title={m.can_device ? 'Device host — can run Android emulators (needs /dev/kvm) and/or share tethered phones over adb. Device xhips can attach here.'
                                   : 'NOT a device host — emulators need a Linux host with /dev/kvm. Tick to allow device xhips (emulators + tethered phones) here.'}>
          <input type="checkbox" checked={!!m.can_device} disabled={busy}
                 onChange={(e) => patch({ can_device: e.target.checked })} />
          📱
        </label>
      </div>
      {m.can_device && <DevicePanel m={m} projectId={projectId} />}
      {m.dev_priority > 0 && !hasDevDb && (
        <button className={`mx-devdb${devDbElsewhere ? '' : ' quiet'}`} data-testid={`mx-devdb-${m.key}`}
                disabled={busy} onClick={provisionDb}
                title={devDbElsewhere
                  ? `${m.key} is a dev spawn target but has NO shared dev db for this project — xells cannot spawn here until it does (their db must never live on another machine).`
                  : `Stand up this project's first shared dev db, here on ${m.key} — from the project's own db image, restoring the latest backup when one exists.`}>
          {devDbElsewhere ? '⚠ no dev db — provision' : '＋ dev db'}
        </button>
      )}
    </div>
  );
}

// The per-machine connection probe — "does the queenzee's stored settings actually reach this
// host's daemon?" One button that is also the verdict: idle → "🔌 check", in flight → spinner,
// resolved → green ✓ / red ✗, with the detail (endpoint, container count, latency, or the exact
// docker error) in the tooltip. Clicking it re-checks live.
function MachineConn({ m, conn, onCheck }) {
  const checking = !!conn?.checking;
  const ok = !checking && conn?.ok;
  const fail = !checking && conn && !conn.ok;
  const cls = `mx-conn${checking ? ' checking' : ok ? ' ok' : fail ? ' fail' : ''}`;
  const title = checking ? 'Checking whether the queenzee can reach this machine…'
    : ok ? `✓ Reachable — the queenzee can connect to ${m.docker_ctx}\n`
        + `endpoint: ${conn.endpoint || 'unknown'}\n`
        + `${conn.container_count ?? 0} container(s) · ${conn.latency_ms ?? '?'}ms\n`
        + 'Click to re-check'
    : fail ? `✗ Not reachable — the stored settings do not allow connecting to ${m.docker_ctx}\n`
        + `${conn.endpoint ? `endpoint: ${conn.endpoint}\n` : ''}`
        + `${conn.error || 'unknown error'}\n`
        + 'Click to re-check'
    : `Check whether the queenzee can connect to ${m.key} (${m.docker_ctx}) with the stored settings —\n`
        + 'probes the docker context and daemon reachability. Read-only.';
  return (
    <button className={cls} data-testid={`mx-conn-${m.key}`} disabled={checking}
            onClick={onCheck} title={title}>
      {checking ? '⏳…' : ok ? '✓ ok' : fail ? '✗ down' : '🔌 check'}
    </button>
  );
}

// The per-(machine, project) BUILD-READINESS badge (ticket #173): "can a build actually work on
// this machine FOR THIS PROJECT?" — the pool knob is set blind today, so this is the fact that
// answers it, right where the knob is. Read-only probe (server-side, bounded docker calls):
//   ✓ build  → ok — every check passed
//   △ ?      → unknown — a check could not be run (context unreachable, docker absent), reason on hover
//   ✗ build  → missing — a named prerequisite is absent; the failing check is in the tooltip
// Clicking re-runs the probe. Same shape as MachineConn: the button IS the verdict.
// Exported so a test can render the badge with a fixture (the matrix fetches readiness in a
// useEffect that SSR cannot run) — same pattern as MachineMatrix itself being exported.
export function BuildReady({ m, readiness, busy = false, onRecheck = null }) {
  const titleFor = () => {
    const checks = (readiness?.checks || []).map((c) => `• ${c.check}: ${c.detail}`).join('\n');
    const failed = (readiness?.checks || []).filter((c) => !c.ok)
      .map((c) => `• ${c.check}${c.unknown ? ' (unknown)' : ''}: ${c.detail}`).join('\n');
    if (readiness?.status === 'ok') {
      return `✓ ${m.key} can build this project\n${checks}\nClick to re-check (read-only).`;
    }
    if (readiness?.status === 'unknown') {
      return `△ Can't tell whether ${m.key} can build this project — a check could not be run:\n${failed || readiness.error || 'unknown reason'}\nClick to re-check (read-only).`;
    }
    if (readiness?.status === 'missing') {
      return `✗ ${m.key} CANNOT build this project — missing:\n${failed || readiness.error || 'no reason recorded'}\nClick to re-check (read-only).`;
    }
    return busy ? 'Checking whether this machine can build this project…'
      : onRecheck ? `Check whether ${m.key} can build this project (read-only probe)\n` +
        'Probes the docker context, the spinoff compose, the declared requires, the shared dev db and the registry handoff.'
      : 'build readiness not checked yet';
  };
  const cls = `mx-br${readiness ? (readiness.status === 'ok' ? ' ok' : readiness.status === 'unknown' ? ' unk' : ' miss') : ''}`;
  return (
    <button className={cls} data-testid={`mx-build-ready-${m.key}`} disabled={busy}
            onClick={onRecheck || undefined} title={titleFor()}>
      {busy ? '⏳…' : readiness?.status === 'ok' ? '✓ build' : readiness?.status === 'unknown' ? '△ ?' : readiness?.status === 'missing' ? '✗ build' : '⚙'}
    </button>
  );
}

// The one-click BUILD BOOTSTRAP (ticket #173 follow-on): "make this machine buildable" — the
// queenzee-performed action that CREATES the dev prerequisites the build-readiness probe names as
// missing. PLAN FIRST: clicking fetches the plan (dry run), shows exactly what will happen, and
// only after a human commits does it perform — then it re-runs the probe so the badge flips to the
// now-true verdict. Enabled only when the probe says something is missing; a refused plan (a name
// the prod tier also declares, an unreachable context) is shown, never half-run. A host that also
// runs this project's PROD stack is DISCLOSED in the plan (the human confirms), not refused — on
// the single-host topology dev and prod share the docker host, so refusing would switch the
// bootstrap off on the most common installation.
function BootstrapButton({ m, projectId, readiness, onDone, onChanged }) {
  const [busy, setBusy] = useState(false);
  const missing = readiness?.status === 'missing';
  if (!missing) return null;

  const stepLine = (s) => {
    if (s.kind === 'disclosure') return `⚠ ${s.detail}`;
    const st = s.status === 'planned' ? 'will create' : s.status;
    const tail = s.stderr ? `\n  stderr: ${s.stderr}` : (s.detail ? ` — ${s.detail}` : '');
    return `• ${st}  ${s.target}${s.action ? `\n    ${s.action}` : ''}${tail}`;
  };

  const run = async () => {
    setBusy(true);
    try {
      const plan = await planBuildBootstrap(projectId, m.id);
      if (plan?.status === 'refused' || plan?.refused) {
        showAlert(`Cannot bootstrap ${m.key}: ${plan?.reason || plan?.refused}`, { variant: 'error' });
        return;
      }
      const steps = plan?.plan || plan?.steps || [];
      if (!steps.length) { showAlert(`${m.key} has nothing the bootstrap can create — the probe says it can build here.`, { variant: 'info' }); return; }
      const planText = steps.map(stepLine).join('\n');
      const performable = steps.filter((s) => s.status === 'planned');
      if (!performable.length) {
        showAlert(`Nothing to perform on ${m.key} — what the probe found missing is not something a bootstrap can create:\n\n${planText}`, { variant: 'info' });
        return;
      }
      if (!(await showConfirm(`Bootstrap ${m.key} for this project?\n\n${performable.length} action(s) — creates DEV prerequisites only, never touches prod or a running container:\n\n${planText}\n\nContinue?`, { okLabel: 'Bootstrap' }))) return;
      const result = await performBuildBootstrap(projectId, m.id);
      const lines = (result?.results || []).map(stepLine);
      const head = result?.status === 'refused' ? `Refused: ${result.reason}`
        : result?.status === 'failed' ? `Bootstrap finished with ${lines.filter((l) => l.startsWith('• failed')).length} failure(s):`
        : `Bootstrap ${result?.status || 'performed'} on ${m.key}:`;
      showAlert(`${head}\n\n${lines.join('\n') || '— nothing to do —'}`, { variant: result?.status === 'failed' ? 'error' : 'info' });
      onDone?.();       // re-run the probe — the badge must reflect what is now true
      onChanged?.();
    } catch (e) { fail('Bootstrap')(e); }
    finally { setBusy(false); }
  };

  return (
    <button className="mx-bs" data-testid={`mx-bootstrap-${m.key}`} disabled={busy} onClick={run}
            title={`One-click: create the DEV prerequisites the build-ready probe says ${m.key} is missing (networks the manifest declares, its shared dev db). Shows the plan first, incl. a disclosure if this host also runs PROD; idempotent; refuses an unreachable context or a name the prod tier declares.`}>
      {busy ? '⏳…' : '🔧 bootstrap'}
    </button>
  );
}

// Device host controls (035), shown under a can_device machine's header. Three actions over the new
// routes: stand up the shared adb-host (so its USB-plugged phones are reachable over TCP), discover +
// auto-register those phones, and register a phone by hand (network-adb or a specific USB serial).
function DevicePanel({ m, projectId }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  // The adb devices this machine can currently see (null = not listed yet), refreshed after any
  // register so a just-added phone flips to "registered ✓" in place.
  const [adb, setAdb] = useState(null);
  const run = (what, fn) => async () => {
    setBusy(true);
    try { return await fn(); }
    catch (e) { fail(what)(e); }
    finally { setBusy(false); }
  };

  const listAdb = run('list adb devices', async () => {
    const r = await getAdbDevices(m.id, projectId);
    if (r.ok === false) { setAdb({ error: r.error, devices: [] }); return; }
    setAdb(r);
  });

  // Register ONE listed adb device — transport inferred from its serial (host:port → net; bare → usb).
  const registerOne = (d) => run('register device', async () => {
    const body = d.kind === 'net'
      ? { project: projectId, machine_id: m.id, transport: 'net', host: d.serial.split(':')[0], adb_port: Number(d.serial.split(':')[1]) }
      : { project: projectId, machine_id: m.id, transport: 'usb', serial: d.serial };
    await registerDevice(body);
    await listAdb();   // refresh so it now reads as registered
  })();

  const adbHost = run('adb-host', async () => {
    if (!(await showConfirm(`Stand up the shared adb-host on ${m.key}?\n\n`
      + `This runs one container on ${m.key} that shares its USB-plugged phones over TCP (adb server on :5037).\n\n`
      + `⚠ An open adb server is UNAUTHENTICATED root on every attached phone — it MUST be firewalled to the trusted LAN.`,
      { okLabel: 'Provision adb-host' }))) return;
    const r = await provisionAdbHost(m.id);
    showAlert(`adb-host up on ${m.key}: ${r.name}\n\nList devices:  ${r.list}\n\n⚠ Firewall ${r.adb_server} to the trusted LAN.`);
  });

  const discover = run('USB discovery', async () => {
    const r = await getUsbDevices(m.id, { register: true, projectId });
    const reg = (r.registered || []).map((d) => d.serial).join(', ') || 'none';
    const skip = (r.skipped || []).map((d) => `${d.serial} (${d.reason})`).join('\n  ') || 'none';
    showAlert(`USB discovery on ${m.key}:\n\nregistered: ${reg}\nskipped:\n  ${skip}`);
  });

  const registerNet = run('register device', async () => {
    // The phone's OWN adb-over-tcp address, host:port (from `adb connect <ip>:<port>` on the handset).
    // A wifi-adb phone lives at its own IP — NOT the machine's — so we ask for the full address and
    // default the host to the machine's IP only when the operator gives a bare port.
    const addr = await showPrompt(`Register a NETWORK device on ${m.key}\n\nThe phone's adb address — host:port (e.g. 10.1.6.205:42005), as you'd \`adb connect\` it. A bare port defaults the host to ${m.host_ip || m.docker_ctx}.`,
      { placeholder: '10.1.6.205:42005', okLabel: 'Register' });
    if (!addr) return;
    const [a, b] = String(addr).trim().split(':');
    const host = b ? a : null;                 // "ip:port" → host a; bare "port" → default host
    const port = Number(b || a);
    if (!Number.isInteger(port) || port <= 0) { showAlert('Enter a valid host:port (or a bare port).', { variant: 'error' }); return; }
    const r = await registerDevice({ project: projectId, machine_id: m.id, transport: 'net', adb_port: port, host });
    showAlert(`Registered ${r.device?.name}\n\nconnect:  ${r.device?.connect}`);
  });

  return (
    <div className="mx-devpanel" data-testid={`mx-devpanel-${m.key}`}>
      <button className="mx-devbtn" disabled={busy} onClick={() => setOpen((o) => !o)}
              title="Device host actions — adb-host, USB discovery, register a phone">📱 devices ▾</button>
      {open && (
        <>
          <div className="mx-devactions">
            <button disabled={busy} onClick={listAdb} title="Run `adb devices` on this machine and list what it sees">list adb devices</button>
            <button disabled={busy} onClick={adbHost} title="Run the shared adb-host container (shares USB phones over TCP)">adb-host</button>
            <button disabled={busy} onClick={discover} title="Scan the adb-host and auto-register every ready USB phone as a device">discover USB</button>
            <button disabled={busy} onClick={registerNet} title="Register a phone reachable over network adb (adb tcpip)">＋ net device</button>
          </div>
          {adb && (
            <div className="mx-adblist" data-testid={`mx-adblist-${m.key}`}>
              {adb.error
                ? <div className="mx-adberr">{adb.error}</div>
                : adb.devices.length === 0
                  ? <div className="mx-adbempty">
                      <b>{`no adb devices seen${adb.source ? ` (via ${adb.source})` : ''}`}</b>
                      {adb.note ? <div className="mx-adbnote">{adb.note}</div> : null}
                    </div>
                  : adb.devices.map((d) => (
                      <div className="mx-adbrow" key={d.serial} data-testid={`adb-${d.serial}`}>
                        <span className={`mx-adbstate s-${d.state}`} title={`adb state: ${d.state}`} />
                        <span className="mx-adbserial" title={`${d.kind} · ${d.state}`}>{d.serial}</span>
                        <span className="mx-adbkind">{d.kind}</span>
                        {d.registered
                          ? <span className="mx-adbreg" title="already a registered device for this project">registered ✓</span>
                          : <button className="mx-adbadd" disabled={busy} onClick={() => registerOne(d)}
                                    title={`Register this ${d.kind === 'net' ? 'network' : 'USB'} device`}>＋ register</button>}
                      </div>
                    ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// "+ machine": register another docker host. The context list comes from docker itself, so the
// choice is always a context this queenzee can actually reach.
function AddMachine({ projectId, onChanged }) {
  const [open, setOpen] = useState(false);
  const [ctxs, setCtxs] = useState(null);
  const [f, setF] = useState({ key: '', docker_ctx: '', host_ip: '', can_build: false, can_device: false, dev_priority: 0, pool_size: 0, max_xells: 0 });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open || ctxs) return;
    getDockerContexts().then((l) => setCtxs(l || [])).catch(() => setCtxs([]));
  }, [open, ctxs]);

  const save = async () => {
    setBusy(true);
    try {
      // pool_size AND dev_priority on create are scoped to the project in view (machine_pool) —
      // other projects start at 0 on this machine and set their own numbers from their own views.
      await createMachine({ ...f, key: f.key.trim() || f.docker_ctx, host_ip: f.host_ip.trim() || null,
                            project_id: projectId });
      setOpen(false);
      setF({ key: '', docker_ctx: '', host_ip: '', can_build: false, can_device: false, dev_priority: 0, pool_size: 0, max_xells: 0 });
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
      <label>host<input value={f.host_ip} placeholder="IP or DNS — for xell URLs" onChange={(e) => setF({ ...f, host_ip: e.target.value })} /></label>
      <label>prio<input type="number" min="0" value={f.dev_priority} onChange={(e) => setF({ ...f, dev_priority: Number(e.target.value) })} /></label>
      <label>pool<input type="number" min="0" value={f.pool_size} onChange={(e) => setF({ ...f, pool_size: Number(e.target.value) })} /></label>
      <label>cap<input type="number" min="0" value={f.max_xells} onChange={(e) => setF({ ...f, max_xells: Number(e.target.value) })} /></label>
      <label className="mx-cb"><input type="checkbox" checked={f.can_build} onChange={(e) => setF({ ...f, can_build: e.target.checked })} />🔨 builds</label>
      <label className="mx-cb"><input type="checkbox" checked={f.can_device} onChange={(e) => setF({ ...f, can_device: e.target.checked })} />📱 devices</label>
      <button disabled={busy || !f.docker_ctx} onClick={save}>Add</button>
      <button className="mx-cancel" onClick={() => setOpen(false)}>✕</button>
    </div>
  );
}

import React, { useCallback, useEffect, useState } from 'react';
import { extractXellEnv, getEnvironments, getXellEnvironment, setXellEnvironment } from './api.js';
import { showAlert, showConfirm } from './Dialog.jsx';

// WHICH ENVIRONMENT A XELL RESOLVED TO — and the one place a human can change it (ticket #20).
//
// The server side of this already existed: `resolveEnvironmentFor` gives a xell its pin, else its
// TIER's default (a prod-coupled or read-only-prod xell gets the PROD environment), `resolvedEnvView`
// reports that with the var NAMES, and `setXellEnvironment` pins/clears and re-projects .zeehive.env.
// None of it was reachable without curl. This is that surface, and nothing more: environments are
// authored in project settings, so this is a PICKER over what is already there, never a second editor.
//
// THE SENTENCE THIS SCREEN EXISTS TO GET RIGHT. On this very project both Zeehive environments hold
// ZERO vars, so a perfectly correct injection writes nothing — and "it changed nothing" is exactly
// what a bug looks like. Ticket #15 lost an afternoon to that. So the three states are three
// different sentences, never one shrug:
//   • no environment resolves at all      → nothing to inject; here is why, and where to make one
//   • an environment with 0 vars          → it resolved, it is EMPTY, and that is why the file is unchanged
//   • an environment with N vars          → it resolved and carries N, named (never valued)
//
// WHAT THIS SCREEN MAY SEE. It is a picker, not a third value door: full values leave the meta-DB
// through exactly two (the .zeehive.env projection and the deploy materializer), and nothing here
// asks for one. What the server sends is what it already sends every masked read — names, flags, and
// for a var explicitly marked SECRET only a hint and a length, never the value. So this lists names.
// Names the PROJECTION owns and will never take from an environment (server/src/lib/provision.js
// builds the authoritative set, which also includes this project's port keys and anything the
// manifest declares). Listed here only to LABEL them: an environment may legitimately hold a
// DATABASE_URL for other purposes, and a human pinning it deserves to know it will not be injected
// rather than discovering it from an unchanged file.
const OWNED_BY_QUEENZEE = ['DATABASE_URL', 'SPINOFF_SLUG', 'ZEEHIVE_SITE', 'ZEEHIVE_DOCKER_CONTEXT'];

export default function XellEnvironment({ xell, onClose, onChanged }) {
  const [view, setView] = useState(null);      // { environment, pinned, reason, vars:[{name,…}] }
  const [envs, setEnvs] = useState(null);      // the project's environments (the pickable set)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(() => {
    setErr(null);
    Promise.all([getXellEnvironment(xell.id), getEnvironments(xell.project_id)])
      .then(([v, list]) => { setView(v || null); setEnvs(Array.isArray(list) ? list : []); })
      .catch((e) => setErr(e?.message || String(e)));
  }, [xell.id, xell.project_id]);
  useEffect(load, [load]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const apply = async (env) => {
    // It rewrites a FILE in a live xell's worktree, so it asks first — the console's habit for
    // anything that changes a running xell. And it says the part people get wrong: the projection is
    // rewritten now, but a process that is already running keeps the environment it started with.
    const ok = await showConfirm(
      `${env ? `Pin "${env.key}" (${env.tier}) to ${xell.slug}?` : `Clear the pinned environment on ${xell.slug}?`}\n\n`
      + `${env
        ? `Its .zeehive.env is rewritten from this environment${Number(env.var_count) === 0
          ? ' — which currently has 0 vars configured, so the file will not gain any (that is empty, not broken).'
          : ` (${env.var_count} var(s)).`}`
        : `It goes back to resolving by tier: ${view?.tier === 'prod' ? 'a production xell takes the PROD environment' : 'a dev/spinoff xell takes the DEV environment'}.`}\n\n`
      + 'A process that is already running keeps the environment it started with — restart the role to pick this up.\n\n'
      + 'DATABASE_URL, the ports, the slug and the site are RESERVED: an environment can never set them, so this cannot re-point a xell at another database.',
      { okLabel: env ? 'Pin it' : 'Clear the pin' });
    if (!ok) return;
    setBusy(true); setErr(null);
    try { await setXellEnvironment(xell.id, env?.id || null); load(); onChanged?.(); }
    catch (e) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const env = view?.environment || null;
  const vars = view?.vars || [];

  return (
    <div className="disp-overlay" onClick={onClose}>
      <div className="disp xenv" role="dialog" aria-label="Xell environment" onClick={(e) => e.stopPropagation()}>
        <div className="disp-head">
          <span className="disp-title">❖ {xell.slug} — environment</span>
          <button className="disp-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="xenv-body">
          {err && <div className="disp-err" data-testid="xenv-err">{err}</div>}
          {!view && !err && <div className="disp-note">reading what this xell resolved to…</div>}

          {view && (
            <div className="xenv-now" data-testid="xenv-resolved">
              {/* THE THREE SENTENCES. Absent, empty and populated must never read the same. */}
              {!env && (
                <>
                  <div className="xenv-head">no environment resolves for this xell</div>
                  <div className="disp-hint">
                    Nothing from the meta-DB is projected into its <code>.zeehive.env</code> — the file still
                    carries its ports and <code>DATABASE_URL</code>, which the queenzee owns. This project has no
                    default <b>{view.tier}</b> environment; create one in Project setup → Environments, or pin one below.
                  </div>
                </>
              )}
              {env && (
                <>
                  <div className="xenv-head">
                    <b data-testid="xenv-key">{env.key}</b> <span className={`envchip env-${env.tier}`}>{env.tier}</span>
                    {view.pinned
                      ? <span className="xenv-why" data-testid="xenv-why">📌 pinned to this xell</span>
                      : <span className="xenv-why" data-testid="xenv-why">resolved by tier — {view.reason}</span>}
                  </div>
                  {vars.length === 0
                    ? (
                      <div className="xenv-empty" data-testid="xenv-empty">
                        <b>0 vars configured.</b> This environment resolved correctly and carries nothing, so a
                        (re)projection writes no vars into <code>.zeehive.env</code> — the file is unchanged because
                        there is nothing to add, NOT because the injection failed. Add vars in Project setup →
                        Environments and they land here.
                      </div>
                    )
                    : (
                      <>
                        <div className="xenv-count" data-testid="xenv-count">{vars.length} var(s) — names; a secret's value never leaves the meta-DB</div>
                        <ul className="xenv-vars">
                          {vars.map((v) => (
                            <li key={v.name}>
                              <code>{v.name}</code>
                              {v.is_secret ? <span className="xenv-secret" title="secret — the value is never sent to this screen"> 🔒</span> : null}
                              {OWNED_BY_QUEENZEE.includes(v.name) && (
                                <span className="xenv-owned" data-testid={`xenv-owned-${v.name}`}
                                      title="The queenzee owns this name in .zeehive.env — the projection will NOT take it from an environment, so pinning this cannot re-point the xell.">
                                  {' '}— not injected (queenzee-owned)
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                </>
              )}
            </div>
          )}

          {/* THE PICKER — over the project's existing environments. No editing here on purpose. */}
          {envs && (
            <div className="xenv-pick">
              <div className="disp-label">Inject one of this project's environments</div>
              {!envs.length && (
                <div className="disp-hint" data-testid="xenv-none">
                  This project has no environments yet — add one in Project setup → Environments.
                </div>
              )}
              {envs.map((e) => (
                <button key={e.id} className={`xenv-opt${env && e.id === env.id && view?.pinned ? ' on' : ''}`}
                        data-testid={`xenv-opt-${e.key}`} disabled={busy} onClick={() => apply(e)}>
                  <b>{e.key}</b>
                  <span className={`envchip env-${e.tier}`}>{e.tier}</span>
                  {e.is_default && <span className="xenv-def">default for {e.tier}</span>}
                  {/* the count is the whole point of the empty-vs-absent distinction — show it HERE too,
                      so a human sees what they are about to inject before they inject it */}
                  <span className={`xenv-n${Number(e.var_count) === 0 ? ' zero' : ''}`}>
                    {Number(e.var_count) === 0 ? '0 vars (empty)' : `${e.var_count} var(s)`}
                  </span>
                </button>
              ))}
              {view?.pinned && (
                <button className="xenv-clear" data-testid="xenv-clear" disabled={busy} onClick={() => apply(null)}>
                  ✕ clear the pin — resolve by tier again
                </button>
              )}
            </div>
          )}
        </div>

        <div className="disp-foot">
          {/* the raw file, which is what the flower's ❖ button used to show on its own. Kept, because
              "what is actually in .zeehive.env right now" is a fair question — it just could never
              answer WHY it looks that way, which is what the rest of this panel is for. */}
          <button className="disp-cancel" data-testid="xenv-extract" onClick={async () => {
            try {
              const r = await extractXellEnv(xell.id);
              await showAlert(
                <pre style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 360, overflow: 'auto', fontFamily: 'monospace', fontSize: 12 }}>{r.text || '(empty)'}</pre>,
                { title: `${xell.slug} — .zeehive.env on disk` });
            } catch (e) { setErr(e?.message || String(e)); }
          }}>view .zeehive.env</button>
          <span className="disp-hint" style={{ flex: 1 }}>
            Environments are authored in Project setup. This picks which one this xell gets.
          </span>
          <button className="disp-cancel" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

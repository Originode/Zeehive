import React, { useEffect, useState, useCallback } from 'react';
import { getHarnesses, getHarnessFull, createHarness, updateHarness, deleteHarness, getModelSpecs } from './api.js';
import { emptyWarning } from './harnessHealth.js';
import ZeeAvatar from './ZeeAvatar.jsx';
import { PROVIDER_ART } from './providerArt.js';
import { GEAR_ART, GEAR_KEYS, gearKeyFor } from './harnessGear.js';

// Author harnesses — the personas an AI assumes as a zee. A harness = personality + skills + memory,
// layered into a zee's briefing beneath the law (the manual + binding rules). Unlimited; the `core`
// law harness is not shown here (it is not editable). This is a DB-owned surface: create/edit/delete
// applies live, no land/ship.
//
// Since migration 080 this is THE authoring surface — the meta-DB owns every harness's text and there
// is no file to edit instead — so it has to be usable for the real thing: a manual is 15k characters,
// not a sentence. Hence full-height monospace editors with character counts, and INHERITED text that
// can actually be read here (it was a char count, while the docs told people to "read it in the
// harness manager"). What a wearer is briefed with is shown as one total, because that is what the
// harness costs on every dispatch.
const blank = () => ({ label: '', glyph: '', gear: '', summary: '', personality: '', avatar_svg: '', parent: null, zee_type: 'worker', scope: 'global', project_id: null, project_name: null, skills: [], memory: [], model_policy: {}, router_policy: {}, enabled: true, upload_conversations_on_done: false, enable_reflection: true, inherited: { skills: [], memory: [], chain: [] } });

const chars = (t) => `${String(t || '').length.toLocaleString()} chars`;
const fileSafe = (s) => String(s || 'note').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'note';
const skillFile = (name) => fileSafe(name || 'skill');
const memFile = (path) => `${fileSafe(String(path || 'memory').split('/').pop()).replace(/\.md$/, '')}.md`;

// Everything a wearer is briefed with: this harness's own text plus the whole inherited chain. The
// number is the point — a harness is tokens spent before the zee has read any code.
export function briefingChars(form) {
  if (!form) return 0;
  const len = (t) => String(t || '').length;
  const sum = (arr, pick) => (arr || []).reduce((n, x) => n + len(pick(x)), 0);
  return len(form.personality)
    + sum(form.skills, (s) => `${s.name}${s.when}${s.body}`)
    + sum(form.memory, (m) => m.text)
    + sum(form.inherited?.skills, (s) => `${s.name}${s.when}${s.body}`)
    + sum(form.inherited?.memory, (m) => m.text);
}

// An inherited skill/memory entry: the line you could always see, plus the TEXT you could not. Closed
// by default (the chain is long), read-only when open — the source is the parent harness.
export function InheritedEntry({ icon, name, note, text }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="hm-inh">
      <button type="button" className="hm-inh-head" onClick={() => setOpen(!open)}
              aria-expanded={open} title={open ? 'collapse' : 'read it'}>
        <span className="hm-inh-caret">{open ? '▾' : '▸'}</span> {icon} <b>{name}</b>
        {note ? <span className="disp-hint"> — {note}</span> : null}
        <span className="disp-hint"> ({chars(text)})</span>
      </button>
      {open && <textarea className="disp-input hm-ta hm-mono" rows={20} value={text || ''} readOnly spellCheck={false} />}
    </div>
  );
}

// The badge editor: paste or load an SVG, see it rendered, clear it. Kept deliberately plain — an SVG
// preview is the only honest check that what you pasted is the art you meant.
export function AvatarField({ svg, onChange }) {
  const [err, setErr] = useState(null);
  const looksSvg = /^<svg[\s>]/i.test(String(svg || '').trim());
  const take = (text) => {
    const t = String(text || '').trim();
    if (t && !/^<svg[\s>]/i.test(t)) { setErr('that is not an SVG document (it must start with <svg …>)'); return; }
    setErr(null); onChange(t);
  };
  return (
    <div className="disp-field" data-testid="harness-avatar-field">
      <label className="disp-label">
        Badge art <span className="disp-hint">SVG, stored in the meta-DB — no repo needed{svg ? `, ${chars(svg)}` : ''}</span>
      </label>
      <div className="hm-avatar-row">
        <div className="hm-avatar-prev" aria-label="badge preview">
          {looksSvg
            ? <img alt="" src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`} width={48} height={48} />
            : <span className="disp-hint">none</span>}
        </div>
        <div className="hm-avatar-acts">
          <input type="file" accept=".svg,image/svg+xml" onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) take(await f.text());
            e.target.value = '';
          }} />
          {svg ? <button type="button" className="hm-del" onClick={() => take('')} title="Remove the badge art">🗑 clear</button> : null}
        </div>
      </div>
      <textarea className="disp-input hm-ta hm-mono" rows={4} value={svg} spellCheck={false}
                placeholder="<svg xmlns=…>  — paste the badge here, or load a file above"
                onChange={(e) => onChange(e.target.value)} onBlur={(e) => take(e.target.value)} />
      {err && <div className="disp-hint hm-avatar-err">{err}</div>}
    </div>
  );
}

// HOW THIS HARNESS WILL BE WORN — the badge art above is only half of what a human sees in the
// console. Everywhere a zee is drawn, the AI PROVIDER is the coin and THIS harness is the COSTUME
// framed around it (web/src/harnessGear.js): wings for a scout, a hammer for a builder, a necktie
// for a manager. So the editor shows exactly that, on three vendors at once — the point being that
// the costume is the part that stays the same — and lets an author PICK it.
//
// The default is derived from the key/label, and that is deliberate: the dev crew already reads as
// job titles (dev-scout, dev-builder, dev-reviewer), so a good default beats a field every author
// has to remember. The picker exists for the harness whose name does not say its job — and it shows
// which costume the NAME would have chosen, so "derive" is never a mystery.
export function WornPreview({ label, glyph, gear, onGear, keys = ['claude', 'openai', 'kimi'] }) {
  const harness = { label: label || 'this harness', glyph, gear };
  const derived = gearKeyFor({ label, glyph });
  return (
    <div className="disp-field" data-testid="harness-worn-preview">
      <label className="disp-label">
        Worn <span className="disp-hint">how a zee wearing it is drawn: the AI provider is the coin,
          this harness is the costume around it</span>
      </label>
      <div className="zav-worn">
        {keys.filter((k) => PROVIDER_ART[k]).map((k) => (
          <span key={k} className="hm-worn-one">
            <ZeeAvatar provider={k} harness={harness} size={62} />
            <span className="disp-hint">{PROVIDER_ART[k].label}</span>
          </span>
        ))}
      </div>
      {onGear && (
        <div className="disp-models hm-gear-pick" role="group" aria-label="Costume">
          <button type="button" className={`disp-seg ${gear ? '' : 'on'}`} data-testid="gear-derive"
                  title={`Choose the costume from the harness's name — this one reads as "${GEAR_ART[derived].label}"`}
                  onClick={() => onGear('')}>from the name · {GEAR_ART[derived].label}</button>
          {GEAR_KEYS.map((k) => (
            <button type="button" key={k} className={`disp-seg ${gear === k ? 'on' : ''}`}
                    data-testid={`gear-${k}`} title={`Always wear the ${GEAR_ART[k].label}`}
                    onClick={() => onGear(k)}>{GEAR_ART[k].label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// order the flat harness list into a parent→child tree (depth for indentation)
function treeRows(list) {
  const byParent = {};
  for (const h of list) (byParent[h.parent || ''] = byParent[h.parent || ''] || []).push(h);
  const rows = [];
  const walk = (pk, depth) => { for (const h of (byParent[pk] || [])) { rows.push({ h, depth }); walk(h.key, depth + 1); } };
  walk('', 0);
  // any orphan whose parent isn't in the list (disabled/removed) still shows at root
  const seen = new Set(rows.map((r) => r.h.key));
  for (const h of list) if (!seen.has(h.key)) rows.push({ h, depth: 0 });
  return rows;
}

// Which harnesses may be this one's PARENT. Two rules, both of them also enforced in the DB, and both
// about text being MERGED into a briefing:
//   • same zee TYPE (054) — a manager parented on Zee Base would be taught `zee land`, the one verb it
//     is refused;
//   • same SCOPE or global (084) — a parent in another project would pour that project's persona,
//     skills and memory into this harness's wearers.
// Exported and pure for the same reason HarnessRow is: a picker that offers a choice the save would
// refuse is a bug, and it should be provable in a test rather than grepped for in this file.
export function parentOptions(list, { key = null, zee_type = 'worker', project_id = null } = {}) {
  return (list || []).filter((h) => h.key !== key
    && (h.zee_type || 'worker') === (zee_type || 'worker')
    && (!h.project_id || h.project_id === project_id));
}

// One row of the harness list. Exported (and prop-driven) so the "does it SAY it carries nothing"
// contract can be rendered and read in a test, instead of grepped for in this file's source.
export function HarnessRow({ h, depth = 0, on = false, onOpen }) {
  const warn = emptyWarning(h);
  return (
    <button className={`hm-item ${on ? 'on' : ''} ${warn ? 'hm-hollow' : ''}`}
            data-testid={`harness-item-${h.key}`} onClick={onOpen}
            style={{ marginLeft: depth * 14 }}
            title={warn ? warn.why : (depth ? `inherits ${h.parent}` : '')}>
      {depth > 0 && <span className="hm-branch">↳</span>}
      <span className="hm-glyph">{h.glyph || (h.label || '?')[0]}</span>
      <span className="hm-name">{h.label}</span>
      {/* SCOPE (084). This list is the UNFILTERED one — every harness in the fleet — so a row that
          belongs to ONE project must say so: editing what looks like a shared persona and finding it
          reaches one project (or the reverse) is the mistake this chip exists to prevent. */}
      {h.scope === 'project' && (
        <span className="hm-scope" data-testid={`harness-scope-${h.key}`}
              title={`Project-scoped: visible only to ${h.project_name || 'its project'}. Created by that project's manager zee (or a human), and deleted with the project.`}>
          ⌂ {h.project_name || 'project'}
        </span>
      )}
      {warn
        ? <span className="hm-warn" data-testid={`harness-empty-${h.key}`}>{warn.chip}</span>
        : <span className="hm-meta">
            {h.zee_type === 'manager' ? '⬢ mgr · ' : ''}{h.skill_count}★
          </span>}
    </button>
  );
}

// The loud version, where an operator is looking straight at the persona: a harness that carries
// nothing is a broken assignment, not a style choice. Renders nothing when the harness is healthy.
export function HarnessEmptyBanner({ h }) {
  const warn = emptyWarning(h);
  if (!warn) return null;
  return (
    <div className="hm-empty" data-testid="harness-empty-banner">
      <b>⚠ this harness carries nothing</b>
      <span>{warn.why}</span>
      <span>
        Its text lives in the meta-DB, so fill it in right here — personality, skills and memory are
        saved to the harness row and injected into every xell that wears it.
      </span>
    </div>
  );
}

// ── MODEL POLICY EDITOR (migration 110) ─────────────────────────────────────────
// The restriction knobs on what a zee wearing this harness may run on. Edited as plain
// jsonb-backed form state; the server normalizes on save (lib/model-policy.js) and the dispatch
// path enforces the effective (inherited) policy before a zee spawns.
//
// The fields:
//   allow_providers   — restrict to these provider keys (empty = all)
//   allow_models      — restrict to these model keys (empty = all)
//   min/max_context   — context-window bounds in tokens (0/blank = unset)
//   min/max_params    — parameter-count bounds in BILLIONS (0/blank = unset)
//   priorities        — deployment priority per model (default 1; higher deploys first)
//   default_model     — what a bare dispatch runs when nothing else is named
const POLICY_FIELDS = [
  ['min_context', 'Min context', 'tokens', 'the smallest context window a model must have'],
  ['max_context', 'Max context', 'tokens', 'the largest context window allowed'],
  ['min_params', 'Min parameters', 'billions', 'the smallest parameter count (B) a model must have'],
  ['max_params', 'Max parameters', 'billions', 'the largest parameter count (B) allowed'],
  // (139) how many LIVE xells may WEAR this harness per project — enforced at assign time, on
  // every path that hands out a persona (dispatch, swap, the console chip). The router ships
  // with 1: "the router" is singular by policy, not by code.
  ['limit', 'Wearer limit', 'live xells/project', 'max LIVE xells that may wear this harness per project (blank = unlimited; min-wins down the chain)'],
];

// The meaningful fields of a policy — what "copy the parent policy for customization" copies.
// Inherited full-shape values are filtered to only the fields that actually restrict, so the
// stored own-policy stays minimal (and matches what normalizePolicy would keep).
function meaningfulPolicy(src) {
  const out = {};
  for (const k of ['allow_providers', 'allow_models']) if ((src?.[k] || []).length) out[k] = [...src[k]];
  for (const k of ['min_context', 'max_context', 'min_params', 'max_params', 'limit']) if (src?.[k] != null) out[k] = src[k];
  if (src?.default_model) out.default_model = src.default_model;
  if (src?.priorities && Object.keys(src.priorities).length) out.priorities = { ...src.priorities };
  return out;
}

export function ModelPolicyEditor({ policy = {}, effective = null, inherited = null, hasParent = false, specs = [], onChange }) {
  const [open, setOpen] = useState(false);
  const p = policy && typeof policy === 'object' ? policy : {};
  // the parent chain's effective policy — the "inherit" baseline this row starts from
  const inh = inherited && typeof inherited === 'object' ? inherited : {};
  // TOP-LEVEL MODE, not per field: a harness either INHERITS ALL (its own policy is empty — the
  // parent chain decides) or CUSTOMIZES (it owns a full copy of the parent's policy, then edits).
  // Root harnesses (no parent) are always customizing — there is nothing to inherit.
  const customizing = !hasParent || Object.keys(p).length > 0;
  const providers = [...new Set(specs.map((s) => s.provider))].sort();
  const set = (k, v) => onChange({ ...p, [k]: v });
  const setNum = (k, v) => {
    const n = String(v || '').trim();
    if (n === '') { const next = { ...p }; delete next[k]; onChange(next); }
    else set(k, Number(n));
  };
  const setArr = (k, v) => onChange({ ...p, [k]: Array.isArray(v) ? v.filter(Boolean) : [] });
  const toggleIn = (arr, x) => setArr('allow_models', (arr || []).includes(x) ? (arr || []).filter((a) => a !== x) : [...(arr || []), x]);
  const priorities = p.priorities && typeof p.priorities === 'object' && !Array.isArray(p.priorities) ? p.priorities : {};
  // EVERY selected provider's models are offered — not just the first one's. With no provider
  // restriction (allow_providers empty) that is every provider's every model. Models are keyed
  // by key alone in the policy (allow_models/priorities/default_model), so a key offered by two
  // providers (e.g. '' — the vendor default) is one checkbox that applies to both; the provider
  // column just says where each key comes from.
  const activeProviders = (p.allow_providers && p.allow_providers.length ? p.allow_providers : providers);
  const grouped = activeProviders
    .map((pr) => ({ provider: pr, models: specs.filter((s) => s.provider === pr) }))
    .filter((g) => g.models.length);

  const fmtList = (v) => (v && v.length ? v.join(', ') : 'all');
  const fmtScalar = (v, unit) => (v != null ? `${v} ${unit}` : 'unset');
  const fmtPrio = (src) => (Object.keys(src?.priorities || {}).length
    ? JSON.stringify(src.priorities) : 'default 1');
  const fmtDef = (src) => (src?.default_model || '(provider default)');

  return (
    <div className="disp-field" data-testid="harness-model-policy">
      <label className="disp-label">
        Model policy <span className="disp-hint">restricts what a wearer may run on — enforced at dispatch (migration 110)</span>
      </label>
      <button type="button" className="hm-add" onClick={() => setOpen(!open)}>
        {open ? '▾ hide model policy' : '▸ edit model policy'}
      </button>
      {effective && (
        <div className="disp-hint" data-testid="effective-model-policy">
          <b>Effective (what a wearer runs on):</b> allow_providers={JSON.stringify(effective.allow_providers || [])}
          {' · '}allow_models={JSON.stringify(effective.allow_models || [])}
          {effective.min_context != null ? ` · min_ctx=${effective.min_context}` : ''}
          {effective.max_context != null ? ` · max_ctx=${effective.max_context}` : ''}
          {effective.min_params != null ? ` · min_params=${effective.min_params}` : ''}
          {effective.max_params != null ? ` · max_params=${effective.max_params}` : ''}
          {effective.limit != null ? ` · wearer limit=${effective.limit}/project` : ''}
          {effective.default_model ? ` · default=${effective.default_model}` : ''}
          {Object.keys(effective.priorities || {}).length ? ` · priorities=${JSON.stringify(effective.priorities)}` : ''}
        </div>
      )}
      {open && (
        <div className="hm-policy">
          {hasParent && (
            <>
              {/* THE ONE MODE SWITCH: inherit all (default) or customize (own copy). */}
              <div className="hm-pf-mode" role="group" aria-label="Model policy mode">
                <button type="button" className={`disp-seg ${!customizing ? 'on' : ''}`}
                        onClick={() => onChange({})} disabled={!customizing}
                        title={customizing ? 'Back to inherit — this harness forgets its own policy and follows its parent again.' : 'Currently inheriting'}>
                  ◍ Inherit all
                </button>
                <button type="button" className={`disp-seg ${customizing ? 'on' : ''}`}
                        onClick={() => onChange(meaningfulPolicy(inh))}
                        disabled={customizing}
                        title={customizing ? 'Already customizing' : 'Copy the parent policy into this harness, then edit it.'}>
                  ✎ Customize
                </button>
              </div>
              {!customizing && (
                <div className="disp-hint hm-pf-inherited" data-testid="model-policy-inherited">
                  <b>Inherits from its parent chain:</b>
                  {' allow_providers='}{fmtList(inh.allow_providers)}
                  {' · allow_models='}{fmtList(inh.allow_models)}
                  {' · '}min_ctx={fmtScalar(inh.min_context, 't')} · max_ctx={fmtScalar(inh.max_context, 't')}
                  {' · '}min_params={fmtScalar(inh.min_params, 'B')} · max_params={fmtScalar(inh.max_params, 'B')}
                  {' · limit='}{inh.limit != null ? `${inh.limit}/project` : 'unlimited'}
                  {' · default='}{fmtDef(inh)}
                  {' · priorities='}{fmtPrio(inh)}
                </div>
              )}
            </>
          )}

          {/* The editable controls — shown when customizing (or always for a root harness). */}
          {(customizing) && (
            <>
              {hasParent && (
                <div className="disp-hint">
                  Customizing — this harness now OWNS a copy of its parent's policy. Every field below is
                  editable. Restriction lists intersect: you can narrow what you inherited but not widen it
                  (dispatch enforces the whole chain).
                </div>
              )}

              <div className="hm-row2">
                <div className="disp-field">
                  <label className="disp-label">Allowed providers</label>
                  <div className="disp-models" role="group" aria-label="Allowed providers">
                    {!hasParent && (
                      <button type="button" className={`disp-seg ${!(p.allow_providers || []).length ? 'on' : ''}`}
                              onClick={() => set('allow_providers', [])}>all</button>
                    )}
                    {providers.map((pr) => (
                      <button key={pr} type="button"
                              className={`disp-seg ${(p.allow_providers || []).includes(pr) ? 'on' : ''}`}
                              onClick={() => setArr('allow_providers', (p.allow_providers || []).includes(pr)
                                ? (p.allow_providers || []).filter((x) => x !== pr) : [...(p.allow_providers || []), pr])}>
                        {pr}
                      </button>
                    ))}
                  </div>
                  <div className="disp-hint">Empty = any connected provider{hasParent ? ' (i.e. the parent restricts, you do not narrow further)' : ''}.</div>
                </div>
              </div>

              <div className="disp-field">
                <label className="disp-label">Allowed models <span className="disp-hint">every model of the selected providers</span></label>
                <div className="hm-policy-models">
                  {grouped.map((g) => (
                    <div key={g.provider} className="hm-model-group">
                      <div className="hm-model-prov">{g.provider}</div>
                      {g.models.map((s) => (
                        <label key={`${g.provider}:${s.key}`} className="hm-check">
                          <input type="checkbox" checked={(p.allow_models || []).includes(s.key)}
                                 onChange={() => toggleIn(p.allow_models, s.key)} />
                          <span>{s.key || '(vendor default)'}</span>
                          <span className="disp-hint">{s.label}</span>
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
                <div className="disp-hint">Empty = any model on the allowed providers. The intersection rule applies here too.</div>
              </div>

              <div className="hm-row2">
                {POLICY_FIELDS.map(([key, label, unit, hint]) => (
                  <div className="disp-field" key={key}>
                    <label className="disp-label">{label} <span className="disp-hint">({unit})</span></label>
                    <input type="number" min="0" className="disp-input"
                           value={p[key] ?? ''} onChange={(e) => setNum(key, e.target.value)}
                           placeholder="unset" />
                    <div className="disp-hint">{hint}</div>
                  </div>
                ))}
              </div>

              <div className="disp-field">
                <label className="disp-label">Default model</label>
                <select className="disp-input" value={p.default_model || ''}
                        onChange={(e) => set('default_model', e.target.value || null)}>
                  <option value="">— none (use the provider default) —</option>
                  {grouped.map((g) => g.models.map((s) => (
                    <option key={`${g.provider}:${s.key}`} value={s.key}>{s.key || '(vendor default)'} · {g.provider}</option>
                  )))}
                </select>
                <div className="disp-hint">What a bare dispatch runs. If set, this wins over the code default (opus for claude).</div>
              </div>

              <div className="disp-field">
                <label className="disp-label">Deployment priorities</label>
                <div className="hm-policy-models">
                  {grouped.map((g) => (
                    <div key={g.provider} className="hm-model-group">
                      <div className="hm-model-prov">{g.provider}</div>
                      {g.models.map((s) => (
                        <label key={`${g.provider}:${s.key}`} className="hm-check">
                          <input type="number" min="1" className="disp-input hm-pri"
                                 value={priorities[s.key] ?? 1}
                                 onChange={(e) => {
                                   const n = Math.max(1, Number(e.target.value) || 1);
                                   set('priorities', { ...priorities, [s.key]: n });
                                 }} />
                          <span>{s.key || '(vendor default)'}</span>
                          <span className="disp-hint">{s.label}</span>
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
                <div className="disp-hint">Higher deploys first (default 1). A bare dispatch picks the highest-priority allowed model. Example: give claude flagship a high priority on a manager harness, deepseek models a high priority on a worker harness.</div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── ROUTER POLICY EDITOR (migration 139) ────────────────────────────────────────
// The ROUTING knobs on the router harness — how the router zee decides each dispatch. Shown only
// on the router chain (key `router`, a child of it, or a row that already carries knobs): every
// other persona has no router behaviour to tune. Edited as jsonb-backed form state exactly like
// the model policy above; the server normalizes on save (lib/router-policy.js) and attaches the
// EFFECTIVE policy to every routing request, so a knob turned here changes the router's very next
// decision without a re-brief or a redeploy.
export function RouterPolicyEditor({ policy = {}, effective = null, providers = [], onChange }) {
  const [open, setOpen] = useState(false);
  const p = policy && typeof policy === 'object' ? policy : {};
  const weights = p.provider_weights && typeof p.provider_weights === 'object' ? p.provider_weights : {};
  const sched = p.provider_schedule && typeof p.provider_schedule === 'object' ? p.provider_schedule : {};
  const set = (k, v) => onChange({ ...p, [k]: v });
  const setNum = (k, v) => {
    const n = String(v ?? '').trim();
    if (n === '') { const next = { ...p }; delete next[k]; onChange(next); }
    else set(k, Number(n));
  };
  const setWeight = (prov, v) => {
    const n = String(v ?? '').trim();
    const next = { ...weights };
    if (n === '') delete next[prov]; else next[prov] = Math.max(0, Number(n) || 0);
    set('provider_weights', next);
  };
  const setHours = (prov, which, v) => {
    const cur = sched[prov] || {};
    const hours = Array.isArray(cur.hours) && cur.hours.length === 2 ? [...cur.hours] : [0, 24];
    hours[which] = Math.min(24, Math.max(0, Number(v) || 0));
    set('provider_schedule', { ...sched, [prov]: { ...cur, hours } });
  };
  const clearSched = (prov) => {
    const next = { ...sched }; delete next[prov];
    set('provider_schedule', next);
  };
  return (
    <div className="disp-field" data-testid="harness-router-policy">
      <label className="disp-label">
        Router policy <span className="disp-hint">how the router decides each dispatch — weights, schedules, rewrite (migration 139)</span>
      </label>
      <button type="button" className="hm-add" onClick={() => setOpen(!open)}>
        {open ? '▾ hide router policy' : '▸ edit router policy'}
      </button>
      {effective && (
        <div className="disp-hint" data-testid="effective-router-policy">
          <b>Effective (what the router obeys):</b>
          {' weights='}{JSON.stringify(effective.provider_weights || {})}
          {Object.keys(effective.provider_schedule || {}).length ? ` · schedule=${JSON.stringify(effective.provider_schedule)}` : ''}
          {effective.max_concurrent != null ? ` · max_concurrent=${effective.max_concurrent}` : ''}
          {effective.default_mode != null ? ` · default_mode=${effective.default_mode}` : ''}
          {effective.rewrite ? ` · rewrite=${effective.rewrite}` : ''}
          {effective.max_task_chars != null ? ` · max_task_chars=${effective.max_task_chars}` : ''}
          {effective.fallback_provider ? ` · fallback=${effective.fallback_provider}` : ''}
        </div>
      )}
      {open && (
        <div className="hm-policy">
          <div className="disp-field">
            <label className="disp-label">Provider weights <span className="disp-hint">relative share of dispatches (0 = never, unless fallback)</span></label>
            <div className="hm-policy-models">
              {(providers.length ? providers : ['claude', 'codex', 'kimi']).map((prov) => (
                <label key={prov} className="hm-check">
                  <input type="number" min="0" step="0.5" className="disp-input hm-pri"
                         data-testid={`router-weight-${prov}`}
                         value={weights[prov] ?? ''} placeholder="—"
                         onChange={(e) => setWeight(prov, e.target.value)} />
                  <span>{prov}</span>
                </label>
              ))}
            </div>
            <div className="disp-hint">The router spreads its dispatches so each provider's share trends toward its weight. All blank = the router's own judgement.</div>
          </div>

          <div className="disp-field">
            <label className="disp-label">Provider schedule <span className="disp-hint">UTC hours a provider may be picked (blank = always)</span></label>
            <div className="hm-policy-models">
              {(providers.length ? providers : ['claude', 'codex', 'kimi']).map((prov) => {
                const win = sched[prov] || null;
                const hours = win && Array.isArray(win.hours) ? win.hours : null;
                return (
                  <label key={prov} className="hm-check" data-testid={`router-sched-${prov}`}>
                    <span>{prov}</span>
                    <input type="number" min="0" max="24" className="disp-input hm-pri" value={hours ? hours[0] : ''}
                           placeholder="from" onChange={(e) => setHours(prov, 0, e.target.value)} />
                    <span>–</span>
                    <input type="number" min="0" max="24" className="disp-input hm-pri" value={hours ? hours[1] : ''}
                           placeholder="to" onChange={(e) => setHours(prov, 1, e.target.value)} />
                    {win ? (
                      <button type="button" className="hm-add" title="Remove this window (always available)"
                              onClick={() => clearSched(prov)}>✕</button>
                    ) : <span className="disp-hint">always</span>}
                  </label>
                );
              })}
            </div>
            <div className="disp-hint">A window may wrap midnight (22–6). Off-window providers are named in every routing request so the router never picks them blind.</div>
          </div>

          <div className="hm-row2">
            <div className="disp-field">
              <label className="disp-label">Max concurrent <span className="disp-hint">(workers)</span></label>
              <input type="number" min="0" className="disp-input" value={p.max_concurrent ?? ''}
                     onChange={(e) => setNum('max_concurrent', e.target.value)} placeholder="unlimited" />
              <div className="disp-hint">At the cap the router HOLDS new requests (visibly) until a worker finishes.</div>
            </div>
            <div className="disp-field">
              <label className="disp-label">Default autonomy <span className="disp-hint">(1–5)</span></label>
              <input type="number" min="1" max="5" className="disp-input" value={p.default_mode ?? ''}
                     onChange={(e) => setNum('default_mode', e.target.value)} placeholder="router's call" />
              <div className="disp-hint">What a routed dispatch runs at unless the prompt demands eyes on it.</div>
            </div>
            <div className="disp-field">
              <label className="disp-label">Max task chars</label>
              <input type="number" min="1" className="disp-input" value={p.max_task_chars ?? ''}
                     onChange={(e) => setNum('max_task_chars', e.target.value)} placeholder="unset" />
              <div className="disp-hint">Target ceiling for the recomposed brief.</div>
            </div>
          </div>

          <div className="hm-row2">
            <div className="disp-field">
              <label className="disp-label">Rewrite style</label>
              <select className="disp-input" value={p.rewrite || ''}
                      onChange={(e) => set('rewrite', e.target.value || null)}>
                <option value="">— router's call —</option>
                <option value="concise">concise — tight prose, no ceremony</option>
                <option value="structured">structured — goal / constraints / verification sections</option>
                <option value="verbatim">verbatim — pass the human's words through untouched</option>
              </select>
            </div>
            <div className="disp-field">
              <label className="disp-label">Fallback provider</label>
              <select className="disp-input" value={p.fallback_provider || ''}
                      onChange={(e) => set('fallback_provider', e.target.value || null)}>
                <option value="">— none —</option>
                {(providers.length ? providers : ['claude', 'codex', 'kimi']).map((prov) => (
                  <option key={prov} value={prov}>{prov}</option>
                ))}
              </select>
              <div className="disp-hint">Where a request lands when weights/schedule exclude everything else.</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function HarnessManager({ onClose }) {
  const [list, setList] = useState([]);
  const [sel, setSel] = useState(null);       // selected key, or '' for a new (unsaved) harness
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState(null);
  // The AI model spec registry (migration 110) — what the model-policy editor offers as known
  // models and reads context/parameter numbers from.
  const [modelSpecs, setModelSpecs] = useState([]);

  const refresh = useCallback(() => getHarnesses().then((hs) => setList(hs.filter((h) => !h.is_law_core))).catch((e) => setErr(e.message)), []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { getModelSpecs().then(setModelSpecs).catch(() => {}); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const open = (key) => {
    setSaved(false); setErr(null);
    getHarnessFull(key).then((h) => { setSel(key); setForm({ ...blank(), ...h }); }).catch((e) => setErr(e.message));
  };
  const startNew = () => { setSel(''); setForm(blank()); setSaved(false); setErr(null); };

  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setSaved(false); };
  const setSkill = (i, k, v) => set('skills', form.skills.map((s, j) => (j === i ? { ...s, [k]: v } : s)));
  const addSkill = () => set('skills', [...form.skills, { name: '', when: '', body: '' }]);
  const rmSkill = (i) => set('skills', form.skills.filter((_, j) => j !== i));
  const setMem = (i, k, v) => set('memory', form.memory.map((m, j) => (j === i ? { ...m, [k]: v } : m)));
  const addMem = () => set('memory', [...form.memory, { path: '', text: '' }]);
  const rmMem = (i) => set('memory', form.memory.filter((_, j) => j !== i));

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (sel === '') {
        if (!form.label.trim()) throw new Error('give the harness a name');
        // The TYPE rides the create, not just the follow-up update: a manager persona that is born a
        // worker and retyped a moment later would be refused the instant anything already wore it.
        const created = await createHarness({ label: form.label, glyph: form.glyph, zee_type: form.zee_type || 'worker' });
        await updateHarness(created.key, form);
        await refresh(); open(created.key);
      } else {
        const h = await updateHarness(sel, form);
        setForm({ ...blank(), ...h }); await refresh();
      }
      setSaved(true);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (sel === '' || !sel) { setSel(null); setForm(null); return; }
    setBusy(true); setErr(null);
    try { await deleteHarness(sel); setSel(null); setForm(null); await refresh(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="disp-overlay" onClick={onClose}>
      <div className="disp hm" role="dialog" aria-label="Harnesses" onClick={(e) => e.stopPropagation()}>
        <div className="disp-head">
          <span className="disp-title">⚙ Harnesses — personas a zee can wear</span>
          <button className="disp-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="hm-body">
          <aside className="hm-list">
            {treeRows(list).map(({ h, depth }) => (
              <HarnessRow key={h.key} h={h} depth={depth} on={sel === h.key} onOpen={() => open(h.key)} />
            ))}
            <button className="hm-new" onClick={startNew}>＋ New harness</button>
          </aside>

          <section className="hm-edit">
            {!form && <div className="disp-note">Select a harness, or create one. A harness is a persona — personality, skills, and memory — that a zee wears when it works a xell. It layers below the law (the manual &amp; your binding rules), never over it.</div>}
            {form && <HarnessEmptyBanner h={form} />}
            {form && (
              <>
                <div className="hm-row2">
                  <div className="disp-field" style={{ flex: 3 }}>
                    <label className="disp-label">Name</label>
                    <input className="disp-input" value={form.label} onChange={(e) => set('label', e.target.value)} placeholder="e.g. Scribe" />
                  </div>
                  <div className="disp-field" style={{ flex: 1 }}>
                    <label className="disp-label">Badge glyph</label>
                    <input className="disp-input" value={form.glyph || ''} onChange={(e) => set('glyph', e.target.value)} placeholder="✒️" maxLength={4} />
                  </div>
                </div>

                {/* The BADGE ART, stored in the meta-DB like everything else (082). It used to be a
                    file in the Zeehive repo, which meant the badge vanished on any queenzee that could
                    not read that repo — so it is editable here, and it travels with the harness. */}
                <AvatarField svg={form.avatar_svg || ''} onChange={(v) => set('avatar_svg', v)} />
                <WornPreview label={form.label} glyph={form.glyph} gear={form.gear || ''}
                             onGear={(v) => set('gear', v)} />

                {/* WHICH ZEE TYPE this persona is for. A harness carries the MANUAL for a type's
                    verbs and refusals, so a xell may only wear one of its own type — a manager
                    persona describes dispatch/say/suggest-done and says landing is refused, which is
                    nonsense (and a trap) for a worker. Retyping is refused while a zee of the other
                    type is wearing it; the server says which ones. */}
                <div className="disp-field">
                  <label className="disp-label">For zee type</label>
                  <div className="disp-models" role="group" aria-label="Zee type">
                    {['worker', 'manager'].map((t) => (
                      <button key={t} className={`disp-seg ${(form.zee_type || 'worker') === t ? 'on' : ''}`}
                              data-testid={`harness-type-${t}`}
                              title={t === 'manager'
                                ? 'A MANAGER zee: dispatches and monitors a crew, holds production read-only, cannot push to the xource.'
                                : 'A WORKER zee: does the job in its own xell and lands its own work.'}
                              onClick={() => { set('zee_type', t); if (form.parent) set('parent', null); }}>
                        {t === 'manager' ? '⬢ manager' : 'worker'}
                      </button>
                    ))}
                  </div>
                  <div className="disp-hint">
                    Only a xell of this type can wear this harness. A worker picker will not offer a
                    manager persona, and assigning one is refused.
                  </div>
                </div>

                {/* WHICH SCOPE this persona is in (084). Stated, not editable: a system-wide harness
                    is the fleet's shared vocabulary, and a project-scoped one is created by that
                    project's manager (`zee harness --new`) or by migration. Moving one across is
                    refused while any xell wears it, so it is not a dropdown here. */}
                {sel !== '' && (
                  <div className="disp-field" data-testid="harness-scope-field">
                    <label className="disp-label">Scope</label>
                    <div className="disp-hint">
                      {form.scope === 'project'
                        ? <><b>⌂ {form.project_name}</b> — visible to that project only, offered in no
                            other project's picker, and deleted with the project.</>
                        : <><b>System-wide</b> — every project sees this persona and any project's xell
                            may wear it.</>}
                    </div>
                  </div>
                )}

                <div className="disp-field">
                  <label className="disp-label">Inherits (parent harness)</label>
                  <select className="disp-input" value={form.parent || ''}
                          onChange={async (e) => {
                            const parent = e.target.value || null;
                            set('parent', parent);
                            // The INHERITED MODEL POLICY depends on the parent — re-fetch it so
                            // the inherit/override editor shows the right baseline for the new chain.
                            // The effective model policy (merged) is recomputed server-side too.
                            try {
                              const h = await getHarnessFull(sel);
                              setForm((f) => ({ ...f, parent, inherited_model_policy: h.inherited_model_policy, effective_model_policy: h.effective_model_policy }));
                            } catch { /* stale inherited display is acceptable; save recomputes */ }
                          }}>
                    <option value="">— none (root) —</option>
                    {/* parentOptions() above holds the two rules (same type, same scope or global)
                        and says why each one exists. */}
                    {parentOptions(list, { key: sel, zee_type: form.zee_type, project_id: form.project_id }).map((h) => (
                      <option key={h.key} value={h.key}>{h.label}{h.scope === 'project' ? ' ⌂' : ''}</option>
                    ))}
                  </select>
                  <div className="disp-hint">This harness merges its parent's persona, skills &amp; memory (root → this), then the law applies on top. The model policy inherits the parent's too — see the Model policy editor.</div>
                </div>

                <div className="disp-field">
                  <label className="disp-label">Summary</label>
                  <input className="disp-input" value={form.summary || ''} onChange={(e) => set('summary', e.target.value)} placeholder="one line — shown on the badge/picker" />
                </div>

                <div className="disp-field">
                  <label className="disp-label">
                    Personality / voice <span className="disp-hint">{chars(form.personality)}</span>
                  </label>
                  <textarea className="disp-input hm-ta hm-mono" rows={12} value={form.personality || ''} onChange={(e) => set('personality', e.target.value)}
                            spellCheck={false} placeholder="How this persona thinks and writes…" />
                </div>

                <div className="disp-field">
                  <label className="disp-label">Skills ({form.skills.length})</label>
                  {form.skills.map((s, i) => (
                    <div key={i} className="hm-sub">
                      <div className="hm-row2">
                        <input className="disp-input" value={s.name} onChange={(e) => setSkill(i, 'name', e.target.value)} placeholder="skill name" />
                        <button className="hm-del" onClick={() => rmSkill(i)} title="Remove skill">🗑</button>
                      </div>
                      <input className="disp-input" value={s.when} onChange={(e) => setSkill(i, 'when', e.target.value)} placeholder="when to use it" />
                      <textarea className="disp-input hm-ta hm-mono" rows={10} value={s.body} onChange={(e) => setSkill(i, 'body', e.target.value)}
                                spellCheck={false} placeholder="the instructions — a procedure the wearer follows" />
                      <div className="disp-hint">{chars(s.body)} · lands in the xell as <code>.claude/skills/{skillFile(s.name)}/SKILL.md</code></div>
                    </div>
                  ))}
                  <button className="hm-add" onClick={addSkill}>＋ Add skill</button>
                </div>

                <div className="disp-field">
                  <label className="disp-label">Memory ({form.memory.length})</label>
                  {form.memory.map((m, i) => (
                    <div key={i} className="hm-sub">
                      <div className="hm-row2">
                        <input className="disp-input" value={m.path} onChange={(e) => setMem(i, 'path', e.target.value)} placeholder="note name" />
                        <button className="hm-del" onClick={() => rmMem(i)} title="Remove memory">🗑</button>
                      </div>
                      <textarea className="disp-input hm-ta hm-mono" rows={18} value={m.text} onChange={(e) => setMem(i, 'text', e.target.value)}
                                spellCheck={false} placeholder="a fact the persona always carries — a manual, a note, a checklist" />
                      <div className="disp-hint">{chars(m.text)} · lands in the xell as <code>.zeehive/harness/memory/{memFile(m.path)}</code>, stamped as generated</div>
                    </div>
                  ))}
                  <button className="hm-add" onClick={addMem}>＋ Add memory</button>
                </div>

                {form.inherited && (form.inherited.skills.length > 0 || form.inherited.memory.length > 0) && (
                  <div className="disp-field">
                    <label className="disp-label">Inherited — from {form.inherited.chain.join(' → ') || 'parent'}</label>
                    {form.inherited.skills.map((s, i) => (
                      <InheritedEntry key={`is${i}`} icon="★" name={s.name} note={s.when} text={s.body} />
                    ))}
                    {form.inherited.memory.map((m, i) => (
                      <InheritedEntry key={`im${i}`} icon="🧠" name={m.path} text={m.text} />
                    ))}
                    <div className="disp-hint">Read-only — carried from the parent chain (the cxell manual comes down from Zee Base this way). Open one to read exactly what a wearer gets; to change it, edit the parent.</div>
                  </div>
                )}

                {/* ROUTER POLICY (139) — only where it means something: the router chain, or a row
                    that already carries knobs (so an operator can always SEE what is set). */}
                {(sel === 'router' || form.parent === 'router'
                  || Object.keys(form.router_policy || {}).length > 0) && (
                  <RouterPolicyEditor policy={form.router_policy}
                                      effective={form.effective_router_policy}
                                      providers={[...new Set(modelSpecs.map((s) => s.provider))].sort()}
                                      onChange={(v) => { set('router_policy', v); }} />
                )}
                <ModelPolicyEditor policy={form.model_policy} effective={form.effective_model_policy}
                                   inherited={form.inherited_model_policy} hasParent={!!form.parent}
                                   specs={modelSpecs}
                                   onChange={(v) => { set('model_policy', v); }} />

                <div className="disp-hint hm-total">
                  A zee wearing this is briefed with <b>{briefingChars(form).toLocaleString()}</b> characters
                  of persona, skills and memory (its own plus everything inherited) — paid on every
                  dispatch, before it has read a line of the project.
                </div>

                <div className="disp-field" data-testid="harness-archival-settings">
                  <label className="disp-label">
                    Conversation &amp; reflection <span className="disp-hint">what happens to a wearer's work after it leaves the xell</span>
                  </label>
                  <label className="hm-check">
                    <input type="checkbox" checked={form.upload_conversations_on_done !== false}
                           onChange={(e) => set('upload_conversations_on_done', e.target.checked)} />
                    <span>Upload conversations on done</span>
                  </label>
                  <div className="disp-hint">
                    When a zee wearing this harness proposes <code>zee done</code>, the queenzee archives
                    its conversation (<code>zee upload-conversation</code>) automatically — best-effort,
                    never blocking the done proposal. A manager can then review it with <code>zee conversations</code>.
                  </div>
                  <label className="hm-check">
                    <input type="checkbox" checked={form.enable_reflection !== false}
                           onChange={(e) => set('enable_reflection', e.target.checked)} />
                    <span>Enable reflection</span>
                  </label>
                  <div className="disp-hint">
                    When a wearer's work SHIPS to production, the queenzee re-invokes it for the post-ship
                    reflection pass (<code>zee report --kind reflection</code>). Off = the zee is not
                    called back after a ship.
                  </div>
                </div>

                <div className="disp-field">
                  <label className="disp-label">Enabled</label>
                  <div className="disp-sup">
                    <button className={`disp-seg ${form.enabled ? 'on' : ''}`} onClick={() => set('enabled', true)}>on</button>
                    <button className={`disp-seg ${!form.enabled ? 'on' : ''}`} onClick={() => set('enabled', false)}>off</button>
                  </div>
                </div>
              </>
            )}
            {err && <div className="disp-err">{err}</div>}
          </section>
        </div>
        <div className="disp-foot">
          {form && sel !== '' && <button className="disp-cancel" onClick={remove} disabled={busy}>Delete</button>}
          <span style={{ flex: 1 }} />
          <button className="disp-cancel" onClick={onClose}>Close</button>
          {form && <button className="disp-submit" onClick={save} disabled={busy}>{saved ? 'Saved ✓' : busy ? 'Saving…' : (sel === '' ? 'Create' : 'Save')}</button>}
        </div>
      </div>
    </div>
  );
}

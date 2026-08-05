// CREDENTIAL INJECTION — a rotated or repaired provider key reaches a LIVE cage without a re-spawn.
//
// A cage is born with the key its provider account held at dispatch time, and nothing in the fleet
// can change it afterwards: /etc/environment (openCxellSsh) and the vendor's auth file
// (~/.codex/auth.json, prepareCxellAuth) are written once, at spawn. When a human rotates an account
// or a zee dies on a 401, every live cage born with the OLD key is stuck with it until it is
// re-dispatched — and the fleet has no mechanism to replace it. This module is that mechanism, with
// the same division of labour as every other irreversible act:
//
//   queenzee → RAISES the request (a human connected/replaced an account → 'rotation'; a zee's turn
//              died on a 401 → 'auth-death'). A zee never asks, and no zee verb touches this table.
//   human    → decides in the console (approve → inject; reject → decline; dismiss → "seen it").
//   queenzee → PERFORMER: recomputes the credential env from the meta-DB (the active adapter's
//              vendor env + everyProviderEnv), rewrites ONLY those lines in each cage's
//              /etc/environment leaving every other line intact, and re-runs prepareCxellAuth so
//              codex's ~/.codex/auth.json is rewritten too. A per-xell receipt (masked hint only —
//              a token never reaches a log, a result row or a card) goes in `result`, and a partial
//              failure is recorded per xell, never thrown away.
//
// The PROVISION_MODE=real guard is load-bearing exactly as it is everywhere else: a NESTED queenzee's
// xell rows are the REAL fleet's (a clone of the meta-DB), so without it a zee booting the server
// inside its own xell could docker-exec into another xell's live cage. See runCredentialInject().
import { q, one } from '../db/pool.js';
import { broadcast } from './events.js';
import { logline } from './logbus.js';
import { PROVIDERS, credentialVendorMismatch, everyProviderEnv, allProviderTokenRows, tokenForSpawn, scrubEnvValue, scrubSecrets, recordXellProviderGrant } from './provider-tokens.js';

// The registry-driven secret scrub lives in provider-tokens.js (where PROVIDERS is); re-export it
// so revive.js and this module read ONE definition.
export { scrubSecrets } from './provider-tokens.js';
import { adapterFor, providerForRuntimeKey, runtimeKeyForProvider } from './cxell-runtimes.js';
import { cxellName, readCxellEnvironment, writeCxellEnvironment, prepareCxellAuth } from './cxell.js';
import { nudgeXellForTurnDeath } from '../queenzee/nudge.js';

// Same switch every other real-side-effect module reads (revive.js, xource-clean.js, landgate, …):
// 'real' touches machines, anything else models. A nested queenzee must never exec into a real cage.
const PROVISION_MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

const MASK_HINT = (t) => {
  const s = String(t ?? '');
  return s.length > 20 ? `${s.slice(0, 13)}…${s.slice(-4)}` : (s ? '…' : null);
};

// ── PURE: WHICH LIVE CAGES HOLD AN OLDER KEY ───────────────────────────────────────────────────
// A live cage holds whatever key the freshest ACTIVE account of its provider held at its last
// dispatch (its `born_at` — the latest non-decommissioned cxell zee's creation). When a human
// connects or replaces an account, the rotation time is the account's `created_at` (setProviderToken
// bumps it on replace, so "when the current key was set" holds for add and replace alike). A cage
// born BEFORE that time was born with the OLD key and needs the new one; a cage born after it already
// holds the new key. Table-tested (test/credential-inject.test.mjs); the I/O half is liveProviderCages.
// → [{ id, slug, born_at, reason }]
export function decideLiveCagesNeedingKey({ cages = [], accountCreatedAt = null } = {}) {
  const at = accountCreatedAt ? Date.parse(accountCreatedAt) : NaN;
  const need = [];
  for (const c of cages || []) {
    const born = c.born_at ? Date.parse(c.born_at) : NaN;
    if (!Number.isFinite(at)) continue;      // no rotation time → nothing to compare
    if (!Number.isFinite(born)) continue;    // an undatable cage cannot be proven stale → skip
    if (born >= at) continue;                // born after the new key → already holds it
    need.push({
      id: c.id, slug: c.slug, born_at: c.born_at,
      reason: `born ${new Date(born).toISOString()} — before the account's current key (${new Date(at).toISOString()})`,
    });
  }
  return need;
}

// ── PURE: THE /etc/environment REWRITE ──────────────────────────────────────────────────────────
// Rewrite a cage's /etc/environment: replace-or-append the lines for the keys in `newEnv`, drop the
// keys in `dropKeys`, and leave every OTHER line byte-for-byte intact — ZEEHIVE_XELL_TOKEN,
// ZEEHIVE_API, ZEE_RUNTIME, PATH, anything a human added. A key that is already present is replaced
// in place; a key that is new (a provider connected since the cage was spawned) is appended; a key
// in `dropKeys` (a provider disconnected since spawn — a revoked key must not live in /etc/
// environment forever) is removed. MANAGED keys (the union of newEnv and dropKeys) are DEDUPED —
// a duplicate line for one of them is dropped, so the rewrite never leaves two keys that disagree
// (a managed key that already appeared is written once). Every VALUE is scrubbed of newlines so a
// pasted label or token cannot inject extra lines (finding [9]). `changed` is the receipt-friendly
// diff: { key, oldHint, newHint, dropped? } with MASKED hints — a token never reaches a log, a
// result row or a card. Table-tested.
// → { text, changed }
export function rewriteCageEnv({ currentText = '', newEnv = {}, dropKeys = [] } = {}) {
  const entries = Object.entries(newEnv || {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => [k, scrubEnvValue(v)]);
  const want = new Map(entries);
  const drop = new Set((dropKeys || []).map((k) => String(k).trim()).filter(Boolean));
  const handled = new Set();                 // managed keys already emitted → dedupe
  const out = [];
  const changed = [];
  for (const line of String(currentText || '').split('\n')) {
    const eq = line.indexOf('=');
    const key = eq > 0 ? line.slice(0, eq).trim() : null;
    if (key && drop.has(key)) {
      if (!handled.has(key)) {
        handled.add(key);
        changed.push({ key, dropped: true, oldHint: MASK_HINT(line.slice(eq + 1)), newHint: null });
      }
      continue;                              // the line is gone
    }
    if (key && want.has(key)) {
      if (!handled.has(key)) {
        handled.add(key);
        const oldVal = line.slice(eq + 1);
        const newVal = want.get(key);
        if (oldVal !== newVal) {
          changed.push({ key, oldHint: MASK_HINT(oldVal), newHint: MASK_HINT(newVal) });
          out.push(`${key}=${newVal}`);
        } else {
          out.push(line);                   // same bytes — leave it untouched
        }
      }
      continue;                              // a duplicate managed line is dropped
    }
    out.push(line);                          // not a managed line — untouched
  }
  for (const [key, val] of entries) {
    if (!handled.has(key)) {
      handled.add(key);
      changed.push({ key, oldHint: null, newHint: MASK_HINT(val) });
      out.push(`${key}=${val}`);
    }
  }
  // ── MANIFEST RECONCILIATION (finding [5] residual) ───────────────────────────
  // The manifest must name EXACTLY the providers whose vars are present in the file. A restricted
  // injection sets only the request provider's vars + drops disconnected ones, so the manifest that
  // was passed in may over-claim a provider whose vars are not in the file. Derive it from the
  // ZEE_PROVIDER_<K>_TOKEN lines that actually survived, then replace-or-append the ZEE_PROVIDERS
  // line (or drop it when no provider vars remain).
  const manifestKeys = manifestFromEnvText(out.join('\n'));
  const manifest = manifestKeys.join(',');
  const mIdx = out.findIndex((l) => /^ZEE_PROVIDERS=/.test(l.trim()));
  if (manifestKeys.length === 0 && mIdx >= 0) {
    changed.push({ key: 'ZEE_PROVIDERS', oldHint: out[mIdx].slice('ZEE_PROVIDERS='.length), newHint: null, manifest: true });
    out.splice(mIdx, 1);
  } else if (manifestKeys.length > 0) {
    const mline = `ZEE_PROVIDERS=${manifest}`;
    if (mIdx >= 0) {
      if (out[mIdx] !== mline) {
        changed.push({ key: 'ZEE_PROVIDERS', oldHint: out[mIdx].slice('ZEE_PROVIDERS='.length), newHint: manifest, manifest: true });
        out[mIdx] = mline;
      }
    } else {
      changed.push({ key: 'ZEE_PROVIDERS', oldHint: null, newHint: manifest, manifest: true });
      out.push(mline);
    }
  }
  return { text: out.join('\n'), changed };
}

// ── PURE: THE ZEE_PROVIDER_<K>_* VAR NAMES FOR A PROVIDER ───────────────────────────────────────
export function providerEnvKeys(provider) {
  const K = String(provider).toUpperCase();
  return [`ZEE_PROVIDER_${K}_TOKEN`, `ZEE_PROVIDER_${K}_LABEL`, `ZEE_PROVIDER_${K}_HINT`];
}

// ── PURE: WHICH DISCONNECTED PROVIDERS' VARS TO DROP ────────────────────────────────────────────
// The every-provider env's manifest (ZEE_PROVIDERS) names the currently-connected set. A
// dispatchable provider ABSENT from it has been disconnected/paused since the cage was spawned, so
// its ZEE_PROVIDER_<K>_* lines in /etc/environment are a revoked key that must not live forever
// (finding [8]). Returns the var names to drop — the injection rewrites only the request's provider
// AND reconciles the manifest, so dropping these keeps the cage's set consistent with what a fresh
// spawn would carry.
export function disconnectedProviderEnvKeys(everyEnv = {}) {
  const connected = new Set(String(everyEnv.ZEE_PROVIDERS || '').split(',').filter(Boolean));
  const drop = [];
  for (const p of Object.values(PROVIDERS)) {
    if (!p.dispatch) continue;
    if (!connected.has(p.key)) drop.push(...providerEnvKeys(p.key));
  }
  return drop;
}

// ── PURE: THE ENV AN INJECTION FOR ONE PROVIDER SETS IN A CAGE ─────────────────────────────────
// Approving ONE provider's rotation must not rewrite the WHOLE every-provider set (finding [5]).
// This builds exactly what a fresh spawn of THIS provider would carry: the vendor env the cage's
// adapter needs (ANTHROPIC_AUTH_TOKEN, …) plus THAT provider's namespaced ZEE_PROVIDER_<K>_* lines,
// plus the recomputed manifest so the cage still reads consistently. Every OTHER provider's lines
// are left untouched by the caller (rewriteCageEnv's dropKeys only touches DISCONNECTED ones, and
// newEnv only sets THIS provider's).
export function providerInjectionEnv({ provider, token, everyEnv = {}, model = null } = {}) {
  const p = PROVIDERS[provider];
  const adapter = adapterFor(runtimeKeyForProvider(provider) || 'claude-code-cxell');
  const env = Object.fromEntries(
    Object.entries(adapter.env({ token, baseUrl: p?.anthropicBaseUrl || null, model }))
      .filter(([, v]) => v !== null && v !== undefined && v !== ''));
  for (const key of providerEnvKeys(provider)) {
    if (everyEnv[key]) env[key] = everyEnv[key];
  }
  env[`ZEE_PROVIDER_${provider.toUpperCase()}_TOKEN`] = token;  // always the fresh token
  // NOTE: the manifest (ZEE_PROVIDERS) is deliberately NOT set here — rewriteCageEnv reconciles it
  // from the provider vars ACTUALLY present in the file, so it never over-claims (finding [5]).
  return env;
}

// ── PURE: THE MANIFEST AS IT MUST NAME THE FILE ────────────────────────────────────────────────
// The manifest (ZEE_PROVIDERS) must name EXACTLY the providers whose ZEE_PROVIDER_<K>_TOKEN lines
// are present in the file — never more. A restricted injection leaves other providers' lines
// untouched, so the manifest derived from the file is the truthful one. rewriteCageEnv calls this
// after its pass; exported for the table test.
export function manifestFromEnvText(text) {
  const present = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = /^ZEE_PROVIDER_([A-Z0-9]+)_TOKEN=/.exec(line.trim());
    if (m) present.push(m[1].toLowerCase());
  }
  return present;
}

// ── THE DOCKER EXEC, INJECTABLE ─────────────────────────────────────────────────────────────────
// A cxell has no docker; the performer therefore takes its `runner` and never imports docker itself.
// The default runner is the real queenzee door (read/write /etc/environment + prepareCxellAuth);
// a test injects a mock and asserts the rewrite text. The runner interface:
//   readEnv({ slug })   → Promise<{ ok:true, text } | { ok:false, error }>
//   writeEnv({ slug, text }) → Promise<{ ok:true } | { ok:false, error }>
//   authSetup({ slug, adapter, token, baseUrl, model }) → Promise<prepareCxellAuth result>
export function defaultInjectRunner({ ctx = 'default' } = {}) {
  return {
    async readEnv({ slug }) {
      try { return { ok: true, text: await readCxellEnvironment({ ctx, slug }) }; }
      catch (e) { return { ok: false, error: String(e.message || e).slice(0, 300) }; }
    },
    async writeEnv({ slug, text }) {
      try { await writeCxellEnvironment({ ctx, slug, text }); return { ok: true }; }
      catch (e) { return { ok: false, error: String(e.message || e).slice(0, 300) }; }
    },
    authSetup: ({ slug, adapter, token, baseUrl, model }) =>
      prepareCxellAuth({ ctx, name: cxellName(slug), adapter, token, baseUrl, model }),
  };
}

// ── THE PER-XELL INJECTION ──────────────────────────────────────────────────────────────────────
// Rewrite ONE live cage's credential env and re-run the adapter's authSetupCmd. Never throws — a
// failure returns a `failed` receipt with a readable reason (the caller records it per xell rather
// than losing it). `token` is the CURRENT fresh account token; `everyEnv` the every-provider set
// (both computed by the caller from the meta-DB at approval time). The rewrite is RESTRICTED to the
// request's provider (finding [5]): only that provider's vendor env + namespaced vars and the
// manifest are set, and only a DISCONNECTED provider's vars are dropped (finding [8]) — every other
// live provider's lines are left byte-for-byte intact.
// → { ok, xell_id, xell_slug, changed, written, auth, error? }
export async function injectIntoLiveCage({ xell, provider, token, everyEnv = {}, model = null, runner }) {
  const xellId = xell.id; const slug = xell.slug;
  const bad = credentialVendorMismatch({ provider, token });
  if (bad) {
    return { ok: false, xell_id: xellId, xell_slug: slug, error: `refusing to inject a ${bad.from} credential: ${bad.sentence}` };
  }
  let adapter;
  try { adapter = adapterFor(xell.runtime_key); }
  catch (e) { return { ok: false, xell_id: xellId, xell_slug: slug, error: `unknown runtime for this cage: ${String(e.message).slice(0, 200)}` }; }

  const cur = await runner.readEnv({ slug });
  if (!cur.ok) {
    return { ok: false, xell_id: xellId, xell_slug: slug, error: `could not read /etc/environment: ${cur.error}` };
  }

  // THE ENV THIS ONE PROVIDER GETS — restricted (finding [5]) plus the manifest, with the dropped
  // keys for disconnected providers (finding [8]).
  const injectionEnv = providerInjectionEnv({ provider, token, everyEnv, model });
  const dropKeys = disconnectedProviderEnvKeys(everyEnv);
  const rewritten = rewriteCageEnv({ currentText: cur.text, newEnv: injectionEnv, dropKeys });

  if (rewritten.changed.length) {
    const w = await runner.writeEnv({ slug, text: rewritten.text });
    if (!w.ok) {
      return { ok: false, xell_id: xellId, xell_slug: slug, error: `could not write /etc/environment: ${w.error}` };
    }
  }

  // Re-run the adapter's authSetupCmd so a codex cage's ~/.codex/auth.json is rewritten with the new
  // key too — the env alone is not enough for `codex exec` (see cxell.js prepareCxellAuth). For the
  // adapters with no authSetupCmd this is a no-op (required:false).
  const auth = await runner.authSetup({ slug, adapter, token, baseUrl: null, model });
  if (auth.required && !auth.ok) {
    return {
      ok: false, xell_id: xellId, xell_slug: slug, written: rewritten.changed.length > 0,
      changed: rewritten.changed, auth: 'AUTH_FAILED',
      error: `the cage's auth setup did not report AUTH_OK: ${auth.said || 'no verdict'}`,
    };
  }

  return {
    ok: true, xell_id: xellId, xell_slug: slug,
    written: rewritten.changed.length > 0,
    changed: rewritten.changed,
    auth: auth.required ? 'AUTH_OK' : null,
  };
}

// ── LIVE CXELL CAGES OF A PROVIDER (the I/O half of decideLiveCagesNeedingKey) ────────────────
// Every non-retired/non-torn-down xell in the project that currently runs a cxell zee on `provider`.
// `born_at` is when the cage last got its key ≈ the latest non-decommissioned cxell zee's creation
// (a revive resumes the SAME zee and does NOT re-inject; a re-crew makes a NEW zee and does). Also
// carries what the performer needs: runtime_key (adapter), model (ranModel), zee_id, revive state.
async function liveProviderCages(projectId, provider) {
  const rows = await q(
    `SELECT x.id, x.slug, x.status, x.ready_at, x.created_at AS xell_created_at,
            z.created_at AS zee_created_at, z.id AS zee_id, z.model, z.status AS zee_status,
            z.revive_next_at, z.revive_attempts, rt.key AS runtime_key
       FROM xell x
       JOIN LATERAL (
         SELECT z.* FROM zee z
          WHERE z.xell_id = x.id AND z.entrypoint = 'cxell-cli' AND z.decommissioned_at IS NULL
          ORDER BY z.created_at DESC LIMIT 1
       ) z ON true
       LEFT JOIN agent_runtime rt ON rt.id = z.runtime_id
      WHERE x.project_id = $1
        AND x.status NOT IN ('retired','tearing-down','husk','error')`,
    [projectId]);
  return rows
    .filter((r) => r.runtime_key && providerForRuntimeKey(r.runtime_key) === provider)
    .map((r) => ({
      id: r.id, slug: r.slug, runtime_key: r.runtime_key, model: r.model,
      zee_id: r.zee_id, zee_status: r.zee_status,
      revive_next_at: r.revive_next_at, revive_attempts: r.revive_attempts,
      born_at: r.zee_created_at || r.ready_at || r.xell_created_at,
    }));
}

// The account a human just connected/replaced — the one the rotation request is about. `accountId`
// is preferred; fall back to the freshest account of the type (the console's POST /tokens response
// does not carry the new row's id).
async function freshestAccount(projectId, provider) {
  return one(
    `SELECT id, created_at, label, token_hint FROM provider_token
      WHERE project_id = $1 AND provider = $2
      ORDER BY created_at DESC LIMIT 1`, [projectId, provider]);
}

// ── TRIGGER (a): a human connected/replaced an account in Project setup ────────────────────────
// The queenzee raises ONE rotation request per (project, provider) when live cages predate the new
// key, naming how many. Called from routes.js after addProviderToken/setProviderToken succeed (and
// from provider-tokens.js when a script drives the same doors). Never throws — a trigger that fails
// must not fail the token save. `accountCreatedAt` defaults to the freshest account's created_at.
export async function raiseRotationRequest({ projectId, provider, accountId = null, accountCreatedAt = null } = {}) {
  try {
    if (!provider || !PROVIDERS[provider]?.dispatch) return { ok: false, status: 'no-cages', reason: `${provider || 'no provider'} is not a dispatchable provider — no cage can run on it` };
    const acct = accountId
      ? await one(`SELECT id, created_at, label FROM provider_token WHERE project_id=$1 AND id=$2`, [projectId, accountId]).catch(() => null)
      : await freshestAccount(projectId, provider);
    const at = accountCreatedAt || acct?.created_at || null;
    const cages = await liveProviderCages(projectId, provider);
    const needing = decideLiveCagesNeedingKey({ cages, accountCreatedAt: at });
    if (!needing.length) return { ok: false, status: 'no-cages', reason: 'no live cage was born before the new key — nothing to inject' };

    const existing = await one(
      `SELECT * FROM credential_inject_request WHERE project_id=$1 AND provider=$2 AND kind='rotation'
         AND status='pending' AND dismissed_at IS NULL`,
      [projectId, provider]);
    if (existing) return { ok: true, request: existing, note: 'a rotation request for this provider is already pending — a human must decide it before another is raised' };

    const label = acct?.label ? ` the "${acct.label}"` : '';
    const reason = `A ${provider} account${label} was connected/replaced in Project setup — ${needing.length} live cage(s) hold an older key for it. Approving injects the current key into them and re-runs the adapter's auth setup.`;
    const row = await one(
      `INSERT INTO credential_inject_request (project_id, provider, account_id, kind, reason, cage_count)
       VALUES ($1,$2,$3,'rotation',$4,$5) RETURNING *`,
      [projectId, provider, acct?.id || accountId || null, reason, needing.length]);
    broadcast('credential-inject', row);
    logline('credential-inject', `rotation request for ${provider} (${String(projectId).slice(0,8)}): ${needing.length} live cage(s) predate the new key`);
    return { ok: true, request: row, cages: needing };
  } catch (e) {
    logline('credential-inject', `could not raise the rotation request (${String(e.message).slice(0, 160)})`);
    return { ok: false, error: String(e.message).slice(0, 200) };
  }
}

// ── TRIGGER (b): a zee's turn died TERMINAL with signal 'auth' ─────────────────────────────────
// Called from revive.js noteTurnDeath on the tend path for an auth death (a 401 / invalid key). A
// new key fixes that; a new key does NOT fix credit/account/model deaths, so those raise no request.
// Scoped to the xell, quoting the vendor's sentence and naming the account (the freshest active one
// the project would dispatch this provider on — the best name available, exactly like revive.js's
// accountFor). Refreshes the quote on an already-open request (one open ask per xell+provider).
export async function raiseAuthDeathRequest({ xellId, projectId, provider, reason, errorQuote, accountId = null } = {}) {
  try {
    if (!provider) return { ok: false, reason: 'no provider' };
    const acct = accountId
      ? await one(`SELECT id, label, token_hint FROM provider_token WHERE project_id=$1 AND id=$2`, [projectId, accountId]).catch(() => null)
      : await freshestAccount(projectId, provider);
    // The vendor's sentence can echo the key back ("your api key: sk-ant-… is invalid") — scrub
    // token-shaped substrings BEFORE the text reaches a row, a card or a log (finding [10]).
    const quote = scrubSecrets(String(errorQuote || reason || '').replace(/\s+/g, ' ').slice(0, 600));
    const label = acct?.label ? `"${acct.label}"` : `this project's ${provider} account`;
    const why = `A zee in this xell died on an AUTH error from ${label} (${provider}). The provider said: "${quote}". Approving injects the current ${provider} key into this cage and re-runs the adapter's auth setup, then may resume the zee on it.`;

    const existing = await one(
      `SELECT * FROM credential_inject_request WHERE xell_id=$1 AND provider=$2 AND kind='auth-death'
         AND status='pending' AND dismissed_at IS NULL`,
      [xellId, provider]);
    if (existing) {
      const updated = await one(
        `UPDATE credential_inject_request SET error_quote=$2, reason=$3, account_id=COALESCE($4, account_id), requested_at=now()
          WHERE id=$1 RETURNING *`,
        [existing.id, quote, why, acct?.id || null]);
      broadcast('credential-inject', updated);
      return { ok: true, request: updated, note: 'this xell already has an open auth-death request — its error quote was refreshed' };
    }

    const row = await one(
      `INSERT INTO credential_inject_request (project_id, provider, account_id, kind, xell_id, reason, error_quote)
       VALUES ($1,$2,$3,'auth-death',$4,$5,$6) RETURNING *`,
      [projectId, provider, acct?.id || accountId || null, xellId, why, quote]);
    broadcast('credential-inject', row);
    broadcast('xell', { id: xellId });
    logline('credential-inject', `auth-death request for ${xellId?.slice?.(0,8) || xellId} (${provider}): a zee died on a 401 — a human must approve the injection`);
    return { ok: true, request: row };
  } catch (e) {
    logline('credential-inject', `could not raise the auth-death request (${String(e.message).slice(0, 160)})`);
    return { ok: false, error: String(e.message).slice(0, 200) };
  }
}

// ── THE READS ───────────────────────────────────────────────────────────────────────────────────
export async function listCredentialInjectRequests(projectId, { open = true } = {}) {
  const select = `SELECT cir.*, x.slug AS live_xell_slug,
                          pt.label AS account_label, pt.token_hint AS account_hint
                     FROM credential_inject_request cir
                     LEFT JOIN xell x ON x.id = cir.xell_id
                     LEFT JOIN provider_token pt ON pt.id = cir.account_id`;
  if (!open) {
    return q(`${select} WHERE cir.project_id=$1 AND cir.dismissed_at IS NULL
              ORDER BY cir.requested_at DESC LIMIT 100`, [projectId]);
  }
  // OPEN view has two halves with DIFFERENT caps: the PENDING half is UNBOUNDED — a pending request
  // may be holding a one-open slot, and a LIMIT must never hide the card that owns the slot (finding
  // [6]); the RECEIPT half is capped to the recent window, exactly like ships/seeds/xource-clean.
  const pending = await q(
    `${select} WHERE cir.project_id=$1 AND cir.dismissed_at IS NULL
      AND cir.status IN ('pending','approved')
      ORDER BY cir.requested_at DESC`, [projectId]);
  const receipts = await q(
    `${select} WHERE cir.project_id=$1 AND cir.dismissed_at IS NULL
      AND cir.status IN ('completed','failed')
      AND COALESCE(cir.finished_at, cir.decided_at, cir.requested_at) > now() - interval '15 minutes'
      ORDER BY cir.requested_at DESC LIMIT 50`, [projectId]);
  return [...pending, ...receipts];
}

// "Seen it — stop showing me." View-only, like every other dismiss.
export async function dismissCredentialInject(id, by = 'human@console') {
  const row = await one(
    `UPDATE credential_inject_request SET dismissed_at=now(), dismissed_by=$2 WHERE id=$1 RETURNING *`, [id, by]);
  if (!row) throw new Error('no such credential-inject request');
  broadcast('credential-inject', row);
  return row;
}

// ── THE HUMAN'S DECISION ────────────────────────────────────────────────────────────────────────
// Approve → the queenzee injects inline and returns the finished row with the per-xell receipts so
// the card reads as a receipt. Reject → nothing is touched. A token never reaches the row.
export async function decideCredentialInject(id, decision, by = 'human@console', { mode = PROVISION_MODE, runner = null } = {}) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error(`bad decision: ${decision}`);
  const row = await one(
    `UPDATE credential_inject_request SET status=$2, decided_at=now(), decided_by=$3
       WHERE id=$1 AND status='pending' RETURNING *`, [id, decision, by]);
  if (!row) throw new Error('no such pending credential-inject request (already decided?)');
  broadcast('credential-inject', row);
  if (decision === 'rejected') {
    logline('credential-inject', `credential-inject request ${String(id).slice(0, 8)} REJECTED by ${by}`);
    if (row.xell_id) broadcast('xell', { id: row.xell_id });
    return row;
  }
  return runCredentialInject(id, { by, mode, runner });
}

// ── EXECUTE AN APPROVED INJECTION ──────────────────────────────────────────────────────────────
// The row is already 'approved'; this injects into every target cage and lands 'completed' (all
// cages ok) or 'failed' (some — or the gate — failed; the per-xell failures are in the receipt, never
// thrown away). Targets are recomputed at approval time so a cage that came alive (or died) since the
// request is treated as of NOW, and the token injected is the CURRENT freshest active account's.
export async function runCredentialInject(id, { by = 'human@console', mode = PROVISION_MODE, runner = null } = {}) {
  const row = await one(
    `UPDATE credential_inject_request SET status='approved' WHERE id=$1 AND status IN ('approved','pending') RETURNING *`, [id]);
  if (!row) throw new Error('no such approved credential-inject request');
  broadcast('credential-inject', row);
  const project = await one(`SELECT * FROM project WHERE id=$1`, [row.project_id]);
  if (!project) {
    const failed = await one(
      `UPDATE credential_inject_request SET status='failed', finished_at=now(), result=$2::jsonb WHERE id=$1 RETURNING *`,
      [id, JSON.stringify({ ok: false, error: 'project row missing' })]);
    broadcast('credential-inject', failed);
    return failed;
  }

  // Recompute the target set at approval time.
  const cages = await liveProviderCages(row.project_id, row.provider);
  let targets;
  if (row.kind === 'rotation') {
    const acct = await one(
      `SELECT created_at FROM provider_token WHERE project_id=$1 AND provider=$2 AND paused_at IS NULL
        ORDER BY created_at DESC LIMIT 1`, [row.project_id, row.provider]).catch(() => null);
    targets = decideLiveCagesNeedingKey({ cages, accountCreatedAt: acct?.created_at || row.requested_at })
      .map((c) => cages.find((x) => x.id === c.id) || c);
  } else {
    targets = cages.filter((c) => c.id === row.xell_id)
      .map((c) => ({ ...c, reason: 'the zee died on a 401 in this cage' }));
  }

  if (!targets.length) {
    const done = await one(
      `UPDATE credential_inject_request SET status='completed', finished_at=now(), result=$2::jsonb WHERE id=$1 RETURNING *`,
      [id, JSON.stringify({ ok: true, dry_run: mode !== 'real', per_xell: [],
        note: 'no live cage needed the key at approval time — nothing was injected' })]);
    broadcast('credential-inject', done);
    if (row.xell_id) broadcast('xell', { id: row.xell_id });
    return done;
  }

  if (mode !== 'real') {
    // A NESTED QUEENZEE must never exec into a real cage — same guard as revive.js. It reports what
    // it WOULD have done and marks the request complete, so an approve on a nested console never
    // reads as "the injection failed".
    const per_xell = targets.map((t) => ({ xell_id: t.id, xell_slug: t.slug, ok: true, dry_run: true,
      note: 'NOT run — PROVISION_MODE=simulate: this queenzee models the fleet, it does not exec into a real cage' }));
    const done = await one(
      `UPDATE credential_inject_request SET status='completed', finished_at=now(), result=$2::jsonb WHERE id=$1 RETURNING *`,
      [id, JSON.stringify({ ok: true, dry_run: true, mode, per_xell })]);
    broadcast('credential-inject', done);
    if (row.xell_id) broadcast('xell', { id: row.xell_id });
    logline('credential-inject', `credential-inject ${String(id).slice(0, 8)} marked completed as DRY-RUN — PROVISION_MODE=simulate`);
    return done;
  }

  const r = runner || defaultInjectRunner();
  // The current fresh token — the one a dispatch would use right now. tokenForSpawn is the ONE
  // full-token read (it bumps last_used_at), and it refuses a provider whose every account is paused.
  let token; let grantedTokenId = null;
  try {
    const spawnAcct = await tokenForSpawn(row.project_id, row.provider);
    token = spawnAcct.token;
    grantedTokenId = spawnAcct.id;
  } catch (e) {
    const failed = await one(
      `UPDATE credential_inject_request SET status='failed', finished_at=now(), result=$2::jsonb WHERE id=$1 RETURNING *`,
      [id, JSON.stringify({ ok: false, error: `no active ${row.provider} token to inject: ${String(e.message).slice(0, 200)}`, per_xell: [] })]);
    broadcast('credential-inject', failed);
    return failed;
  }
  const everyRows = await allProviderTokenRows(row.project_id).catch(() => []);
  const { env: everyEnv } = everyProviderEnv(everyRows);

  const per_xell = [];
  for (const t of targets) {
    const rec = await injectIntoLiveCage({ xell: t, provider: row.provider, token, everyEnv, model: t.model || null, runner: r });
    per_xell.push(rec);
    if (rec.ok) {
      // The injection is the OTHER door that puts a key in a cage — record the grant so the
      // runnable-provider-env door answers from the ledger (finding [1], second attempt).
      await recordXellProviderGrant({ xellId: t.id, provider: row.provider, providerTokenId: grantedTokenId, grantedBy: 'inject' });
      if (row.kind === 'auth-death' && t.zee_id) {
        rec.revive = await scheduleReviveAfterInjection(t.zee_id, t.slug);
      }
    }
  }
  const allOk = per_xell.every((p) => p.ok);
  const status = allOk ? 'completed' : 'failed';
  const done = await one(
    `UPDATE credential_inject_request SET status=$2, finished_at=now(), result=$3::jsonb WHERE id=$1 RETURNING *`,
    [id, status, JSON.stringify({ ok: allOk, mode, per_xell })]);
  broadcast('credential-inject', done);
  if (row.xell_id) broadcast('xell', { id: row.xell_id });
  logline('credential-inject', `credential-inject ${status} for ${row.provider} by ${by}: `
    + `${per_xell.filter((p) => p.ok).length}/${per_xell.length} cage(s) injected`);
  return done;
}

// ── SCHEDULE ONE REVIVE AFTER A REPAIRED AUTH DEATH ────────────────────────────────────────────
// revive.js owns the scheduler columns (migration 125). An auth death took the TEND path, which set
// revive_next_at = NULL; this re-arms it so the revive loop resumes the zee on the fresh key. The
// revive loop's own guards apply (paused fleet, decommissioned zee, retired xell, missing session) —
// if it cannot deliver, it puts the schedule back and nothing is lost. Best-effort, never throws.
async function scheduleReviveAfterInjection(zeeId, slug) {
  try {
    await q(`UPDATE zee SET revive_next_at = now(), revive_class = 'terminal', revive_signal = 'credential-injected'
              WHERE id = $1 AND decommissioned_at IS NULL`, [zeeId]);
    logline('credential-inject', `${slug}: scheduled ONE revive of zee ${String(zeeId).slice(0, 8)} after a repaired auth death`);
    return { ok: true, note: 'one revive scheduled — the zee resumes on the fresh key' };
  } catch (e) {
    logline('credential-inject', `${slug}: could not schedule the post-injection revive (${String(e.message).slice(0, 120)})`);
    return { ok: false, error: String(e.message).slice(0, 200) };
  }
}

// ── THE REVIVE PROMPT FOR AN INJECTION-RESUMED ZEE ─────────────────────────────────────────────
// The standard turn-death revive prompt says "no human involved" and "attempt N of 3" — both wrong
// after a human approved an injection. revive.js calls this when revive_signal is
// 'credential-injected' so the resumed zee is told the truth: its key was repaired under a human
// gate and it is resuming to continue the job.
export function injectedRevivePrompt() {
  return [
    'RESUMED — your last turn did NOT end, it was CUT SHORT BY AN AUTH ERROR (a 401 / invalid key).',
    'A human approved the injection of a fresh provider key into this cage, and the queenzee injected',
    'it (rewriting the credential env and the vendor\'s auth file) before resuming this session.',
    '',
    'Read that carefully before you react: NOTHING OF YOURS FAILED. You were not rejected, no gate moved,',
    'no build broke and nothing was reverted — the API refused your old key mid-turn, which is why your',
    'transcript stops in the middle of a thought. Your commits are exactly where you left them.',
    '',
    'Re-orient BEFORE you act — time has passed and you must not trust your memory of the fleet\'s state:',
    '  1. `zee status` — the authoritative answer to "where do I stand?": your task, and whether a landing,',
    '     a ship or a done proposal of yours is pending a human. A decision may have arrived while you were dead.',
    '  2. `zee work` if you are on a work item — re-read it rather than recalling it.',
    '  3. `git log --oneline -5` and `git status` in your worktree — what you had actually committed before',
    '     the error, which is usually more (or less) than you remember.',
    '',
    'Then CONTINUE the job from there. Do not redo work that is already committed, do not re-raise a request',
    '`zee status` shows is already open, and do not `zee tend` about the auth error — it is handled: the cage',
    'now holds a fresh key, and this session was resumed on it.',
  ].join('\n');
}

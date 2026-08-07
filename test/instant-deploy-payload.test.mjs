// INSTANT DEPLOY — resolved-payload preview, account pin, and runtime payload shape.
//
// Follow-ups on the shipped Instant deploy door (b3d21164): Instant silently fills unpinned
// custom-deployment fields. This suite holds three things true:
//
//   1. resolveInstantDeployment is PURE and is the single source of the resolved payload — so the
//      footer preview and the fire path cannot disagree. Asserted by RUNNING the function (not by
//      regexing the source).
//   2. The composer, mounted through the esbuild seam with stubbed /dispatch/options and
//      /router/status, actually FIRES: Instant → no via_router, pins + silent defaults on the
//      direct payload; Route → via_router: true plus the same custom pins.
//   3. The account picker appears only when the resolved provider has >1 unpaused account, and a
//      picked account rides on Instant as provider_token_id.
//
// No database. No agents. A tiny document shim stands in for the browser (this repo has no jsdom);
// React 18's createRoot + the real Dispatch.jsx are what run. The shim is only enough for mount
// and __reactProps clicks — it is not a browser.
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { build as esbuild } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);
// Bundles land under ROOT so external 'react' resolves via the workspace node_modules.
// (A /tmp outfile cannot see the repo's packages.)
// ── fixture options the stubbed API returns ────────────────────────────────────────────────────
const ACCT_A = 'acct-a-1111-1111-1111-111111111111';
const ACCT_B = 'acct-b-2222-2222-2222-222222222222';
const FIXTURE_OPTIONS = {
  default_provider: 'claude',
  harness: { key: 'dev-builder', label: 'Builder' },
  policy: {},
  modes: [
    { mode: 1, key: 'plan', label: 'plan', enforced: true },
    { mode: 5, key: 'bypass', label: 'bypass', enforced: true },
  ],
  providers: [
    {
      provider: 'claude', label: 'Claude', blocked_reason: null,
      default_model: 'sonnet',
      models: [
        { key: 'opus', label: 'Opus' },
        { key: 'sonnet', label: 'Sonnet', default: true },
      ],
      modes: [
        { mode: 1, key: 'plan', label: 'plan', enforced: true },
        { mode: 5, key: 'bypass', label: 'bypass', enforced: true },
      ],
      accounts: [
        { id: ACCT_A, label: 'Claude A', name: 'Claude A', paused: false, token_hint: 'aaa1' },
        { id: ACCT_B, label: 'Claude B', name: 'Claude B', paused: false, token_hint: 'bbb2' },
      ],
      runtime: { key: 'claude-code-cxell', label: 'Claude Code (cxell)', caged: true },
    },
    {
      provider: 'openai', label: 'ChatGPT Codex', blocked_reason: null,
      default_model: 'gpt-5.6-sol',
      models: [{ key: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', default: true }],
      modes: [{ mode: 5, key: 'bypass', label: 'bypass', enforced: true }],
      accounts: [
        { id: 'acct-o-1', label: 'Codex A', name: 'Codex A', paused: false, token_hint: 'sk01' },
      ],
      runtime: { key: 'codex-cxell', label: 'Codex (cxell)', caged: true },
    },
  ],
};

// ── 1. pure resolver (no DOM) ──────────────────────────────────────────────────────────────────
section('resolveInstantDeployment is pure and fills only what is unpinned');
{
  // Bundle beside the repo so external 'react' resolves via node_modules (a /tmp outfile cannot).
  const dir = mkdtempSync(join(ROOT, '.inst-res-'));
  const out = join(dir, 'resolve.mjs');
  try {
    await esbuild({
      stdin: {
        contents: "export { resolveInstantDeployment, instantPreviewTitle } from './web/src/Dispatch.jsx';\n",
        resolveDir: ROOT, sourcefile: 'resolve-entry.js', loader: 'js',
      },
      bundle: true, format: 'esm', outfile: out, jsx: 'automatic', logLevel: 'silent',
      external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client', 'react-dom/server'],
      // api / harnessHealth / ZeeAvatar are pulled in by the module graph; stub the network ones.
      plugins: [{
        name: 'stub-api',
        setup(b) {
          b.onResolve({ filter: /\/api\.js$/ }, () => ({ path: 'api-stub', namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents: `
              export async function getDispatchOptions() { return null; }
              export async function getHarnesses() { return []; }
              export async function getRouterStatus() { return null; }
              export async function dispatchOverlap() { return null; }
            `,
            loader: 'js',
          }));
        },
      }],
    });
    const { resolveInstantDeployment, instantPreviewTitle } = await import(pathToFileURL(out).href);

    const fullPin = resolveInstantDeployment({
      cProv: 'openai', cModel: 'gpt-5.6-sol', cMode: 1, cHarness: 'dev-reviewer',
      cAcctId: null, harness: 'dev-builder', options: FIXTURE_OPTIONS,
    });
    ok(fullPin.ok === true, 'a fully pinned Instant resolves ok');
    ok(fullPin.provider === 'openai' && fullPin.model === 'gpt-5.6-sol' && fullPin.mode === 1
       && fullPin.harness === 'dev-reviewer',
       'pinned provider/model/mode/harness travel unchanged');
    ok(fullPin.sources.provider === 'pinned' && fullPin.sources.model === 'pinned'
       && fullPin.sources.mode === 'pinned' && fullPin.sources.harness === 'pinned',
       'every pin is marked sources=pinned');
    ok(fullPin.provider_token_id === 'acct-o-1' && fullPin.sources.account === 'default',
       'with one account and no pin, Instant still picks first unpaused and marks it default');

    const silent = resolveInstantDeployment({
      cProv: 'claude', cModel: null, cMode: null, cHarness: null,
      cAcctId: null, harness: undefined, options: FIXTURE_OPTIONS,
    });
    ok(silent.ok && silent.provider === 'claude' && silent.model === 'sonnet' && silent.mode === 5,
       'unpinned model→policy default, mode→5 (bypass)');
    ok(silent.harness === undefined, 'unpinned harness stays undefined (project default on the server)');
    ok(silent.provider_token_id === ACCT_A && silent.sources.account === 'default',
       'unpinned account → first unpaused of the resolved provider');
    ok(silent.sources.model === 'default' && silent.sources.mode === 'default'
       && silent.sources.harness === 'default',
       'silent fills are marked sources=default so the preview can dim them');

    const acctPin = resolveInstantDeployment({
      cProv: 'claude', cModel: null, cMode: 5, cHarness: null,
      cAcctId: ACCT_B, harness: 'dev-builder', options: FIXTURE_OPTIONS,
    });
    ok(acctPin.provider_token_id === ACCT_B && acctPin.sources.account === 'pinned',
       'a pinned account rides as provider_token_id and is marked pinned');

    const noProv = resolveInstantDeployment({
      cProv: null, cModel: null, cMode: 5, cHarness: null,
      options: { ...FIXTURE_OPTIONS, default_provider: null, providers: [] },
    });
    ok(noProv.ok === false && /Pin a provider/.test(noProv.error || ''),
       'no resolved provider refuses with the same sentence Instant used to setErr');

    const blocked = resolveInstantDeployment({
      cProv: 'claude', options: {
        ...FIXTURE_OPTIONS,
        providers: [{ ...FIXTURE_OPTIONS.providers[0], blocked_reason: 'policy forbids claude' }],
      },
    });
    ok(blocked.ok === false && /policy forbids claude/.test(blocked.error || ''),
       'a blocked resolved provider refuses up front, naming the reason');

    // provider is pinned here; model/mode/account/harness are defaults — title marks those.
    const title = instantPreviewTitle(silent);
    ok(/provider=Claude/.test(title) && /Sonnet \(default\)/.test(title)
       && /mode=5 · bypass \(default\)/.test(title),
       `preview title names resolved values and marks defaults ("${title}")`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 2. mount the real composer, fire Instant and Route ─────────────────────────────────────────
section('composer runtime: Instant and Route payloads (esbuild + mount)');

// Minimal document so React 18 createRoot + createPortal can mount. Not a browser — just enough
// for __reactProps clicks and a contentEditable text set.
function installDom() {
  class Node {
    static ELEMENT_NODE = 1; static TEXT_NODE = 3; static COMMENT_NODE = 8;
    static DOCUMENT_NODE = 9; static DOCUMENT_FRAGMENT_NODE = 11;
  }
  class Element extends Node {}
  class HTMLElement extends Element {}
  class HTMLDivElement extends HTMLElement {}
  class HTMLButtonElement extends HTMLElement {}
  class HTMLSpanElement extends HTMLElement {}
  class HTMLInputElement extends HTMLElement {}
  class HTMLTextAreaElement extends HTMLElement {}
  class HTMLIFrameElement extends HTMLElement {}
  class HTMLImageElement extends HTMLElement {}
  class HTMLAnchorElement extends HTMLElement {}
  class HTMLLabelElement extends HTMLElement {}
  class HTMLBRElement extends HTMLElement {}
  class HTMLPreElement extends HTMLElement {}
  class HTMLHeadingElement extends HTMLElement {}
  class SVGElement extends Element {}

  const TAG_MAP = {
    DIV: HTMLDivElement, BUTTON: HTMLButtonElement, SPAN: HTMLSpanElement,
    INPUT: HTMLInputElement, TEXTAREA: HTMLTextAreaElement, IFRAME: HTMLIFrameElement,
    IMG: HTMLImageElement, A: HTMLAnchorElement, LABEL: HTMLLabelElement,
    BR: HTMLBRElement, PRE: HTMLPreElement,
    H1: HTMLHeadingElement, H2: HTMLHeadingElement, H3: HTMLHeadingElement,
    H4: HTMLHeadingElement, H5: HTMLHeadingElement, H6: HTMLHeadingElement,
  };

  function addEv(obj) {
    obj._listeners = Object.create(null);
    obj.addEventListener = function (type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    };
    obj.removeEventListener = function (type, fn) {
      if (!this._listeners[type]) return;
      this._listeners[type] = this._listeners[type].filter((f) => f !== fn);
    };
    obj.dispatchEvent = function (ev) {
      if (!ev.preventDefault) ev.preventDefault = function () { this.defaultPrevented = true; };
      if (!ev.stopPropagation) ev.stopPropagation = function () { this._stopped = true; };
      for (const f of [...(this._listeners[ev.type] || [])]) f.call(this, ev);
      return !ev.defaultPrevented;
    };
    return obj;
  }

  function makeStyle() {
    const store = Object.create(null);
    return {
      setProperty(k, v) { store[k] = String(v ?? ''); this[k] = store[k]; },
      getPropertyValue(k) { return store[k] || this[k] || ''; },
      removeProperty(k) { delete store[k]; delete this[k]; },
      cssText: '',
    };
  }

  function makeEl(tag, doc) {
    const upper = String(tag).toUpperCase();
    const Ctor = TAG_MAP[upper] || HTMLElement;
    const node = addEv(Object.create(Ctor.prototype));
    Object.assign(node, {
      nodeType: 1, nodeName: upper, tagName: upper, ownerDocument: doc,
      parentNode: null, childNodes: [], style: makeStyle(), attributes: Object.create(null),
      className: '', value: '', checked: false, disabled: false, hidden: false, tabIndex: -1,
      namespaceURI: 'http://www.w3.org/1999/xhtml', _text: '',
      setAttribute(k, v) {
        this.attributes[k] = String(v);
        if (k === 'class') this.className = String(v);
        if (k === 'contenteditable') this.contentEditable = String(v);
      },
      getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
      removeAttribute(k) { delete this.attributes[k]; },
      hasAttribute(k) { return k in this.attributes; },
      appendChild(c) {
        if (c.parentNode) c.parentNode.removeChild(c);
        this.childNodes.push(c); c.parentNode = this; return c;
      },
      removeChild(c) {
        const i = this.childNodes.indexOf(c);
        if (i >= 0) { this.childNodes.splice(i, 1); c.parentNode = null; }
        return c;
      },
      insertBefore(c, ref) {
        if (c.parentNode) c.parentNode.removeChild(c);
        if (!ref) return this.appendChild(c);
        const i = this.childNodes.indexOf(ref);
        this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, c);
        c.parentNode = this; return c;
      },
      focus() { doc.activeElement = this; }, blur() {}, click() {},
      contains(other) {
        let n = other;
        while (n) { if (n === this) return true; n = n.parentNode; }
        return false;
      },
      getBoundingClientRect() { return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0 }; },
    });
    Object.defineProperties(node, {
      firstChild: { get() { return this.childNodes[0] || null; } },
      lastChild: { get() { return this.childNodes[this.childNodes.length - 1] || null; } },
      nextSibling: {
        get() {
          if (!this.parentNode) return null;
          const i = this.parentNode.childNodes.indexOf(this);
          return this.parentNode.childNodes[i + 1] || null;
        },
      },
      previousSibling: {
        get() {
          if (!this.parentNode) return null;
          const i = this.parentNode.childNodes.indexOf(this);
          return i > 0 ? this.parentNode.childNodes[i - 1] : null;
        },
      },
      innerHTML: {
        get() {
          return this.childNodes.map((n) => {
            if (n.nodeType === 3) return n.textContent || '';
            const t = (n.tagName || 'div').toLowerCase();
            const a = Object.entries(n.attributes || {}).map(([k, v]) => ` ${k}="${v}"`).join('');
            return `<${t}${a}>${n.innerHTML || ''}</${t}>`;
          }).join('');
        },
        set() { this.childNodes = []; },
      },
      textContent: {
        get() {
          return this.childNodes.length
            ? this.childNodes.map((c) => c.textContent || '').join('')
            : (this._text || '');
        },
        set(v) { this._text = String(v); this.childNodes = []; },
      },
      // Dispatch reads editorRef.current.innerText — mirror textContent.
      innerText: {
        get() { return this.textContent; },
        set(v) { this.textContent = v; },
      },
    });
    return node;
  }

  const doc = addEv({
    nodeType: 9, nodeName: '#document', documentElement: null, body: null,
    activeElement: null, readyState: 'complete',
    createElement(t) { return makeEl(t, doc); },
    createElementNS(ns, t) { const el = makeEl(t, doc); el.namespaceURI = ns; return el; },
    createTextNode(t) {
      return addEv({
        nodeType: 3, nodeName: '#text', textContent: String(t), parentNode: null,
        childNodes: [], ownerDocument: doc,
        setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, hasAttribute() { return false; },
        appendChild() {}, removeChild() {}, insertBefore() {},
        get firstChild() { return null; }, get lastChild() { return null; },
        get nextSibling() {
          if (!this.parentNode) return null;
          const i = this.parentNode.childNodes.indexOf(this);
          return this.parentNode.childNodes[i + 1] || null;
        },
        get previousSibling() {
          if (!this.parentNode) return null;
          const i = this.parentNode.childNodes.indexOf(this);
          return i > 0 ? this.parentNode.childNodes[i - 1] : null;
        },
      });
    },
    createComment(t) {
      return addEv({
        nodeType: 8, nodeName: '#comment', textContent: String(t), parentNode: null,
        childNodes: [], ownerDocument: doc,
        setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, hasAttribute() { return false; },
        appendChild() {}, removeChild() {}, insertBefore() {},
      });
    },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createDocumentFragment() {
      const f = makeEl('FRAGMENT', doc); f.nodeType = 11; f.nodeName = '#document-fragment'; return f;
    },
  });
  doc.body = makeEl('BODY', doc);
  doc.documentElement = makeEl('HTML', doc);
  doc.documentElement.appendChild(doc.body);
  doc.activeElement = doc.body;

  const win = addEv({
    document: doc,
    getComputedStyle: () => new Proxy({}, { get: () => () => '' }),
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    navigator: { userAgent: 'node' },
    location: { href: 'http://localhost/' },
    HTMLElement, Element, Node, HTMLDivElement, HTMLButtonElement, HTMLSpanElement,
    HTMLInputElement, HTMLTextAreaElement, HTMLIFrameElement, HTMLImageElement, SVGElement,
    top: null, self: null, window: null,
  });
  win.top = win; win.self = win; win.window = win;
  doc.defaultView = win;

  Object.defineProperty(globalThis, 'window', { value: win, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true });
  try { Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true }); } catch { /* */ }
  Object.assign(globalThis, {
    HTMLElement, Element, Node, HTMLDivElement, HTMLButtonElement, HTMLSpanElement,
    HTMLInputElement, HTMLTextAreaElement, HTMLIFrameElement, HTMLImageElement, SVGElement,
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return { doc, win };
}

function walk(node, pred, acc = []) {
  if (!node) return acc;
  if (pred(node)) acc.push(node);
  for (const c of node.childNodes || []) walk(c, pred, acc);
  return acc;
}
function byTestId(root, id) {
  return walk(root, (n) => n.getAttribute?.('data-testid') === id)[0] || null;
}
function click(el) {
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps'));
  if (!key || typeof el[key].onClick !== 'function') {
    throw new Error(`no react onClick on ${el.getAttribute?.('data-testid') || el.tagName}`);
  }
  el[key].onClick({ preventDefault() {}, stopPropagation() {}, target: el, currentTarget: el });
}
function htmlOf(root) {
  return root?.innerHTML || '';
}

const outDir = mkdtempSync(join(ROOT, '.inst-mount-'));
try {
  installDom();
  const bundle = join(outDir, 'dispatch.mjs');
  await esbuild({
    stdin: {
      contents: "export { default as Dispatch, resolveInstantDeployment } from './web/src/Dispatch.jsx';\n",
      resolveDir: ROOT, sourcefile: 'mount-entry.js', loader: 'js',
    },
    bundle: true, format: 'esm', outfile: bundle, jsx: 'automatic', logLevel: 'silent',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client', 'react-dom/server'],
    plugins: [{
      name: 'stub-api',
      setup(b) {
        b.onResolve({ filter: /\/api\.js$/ }, () => ({ path: 'api-stub', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: `
            const OPTS = ${JSON.stringify(FIXTURE_OPTIONS)};
            export async function getDispatchOptions() { return OPTS; }
            export async function getHarnesses() {
              return [{ key: 'dev-builder', label: 'Builder', is_law_core: false, scope: 'system' },
                      { key: 'dev-reviewer', label: 'Reviewer', is_law_core: false, scope: 'system' }];
            }
            export async function getRouterStatus() {
              return { harness: { key: 'router', glyph: '⇄' }, present: true,
                       routers: [{ xell_id: 'r1', slug: 'router-zee-1', provider: 'claude',
                                   model: 'sonnet', zee_status: 'working' }] };
            }
            export async function dispatchOverlap() { return null; }
          `,
          loader: 'js',
        }));
      },
    }],
  });

  const { Dispatch } = await import(pathToFileURL(bundle).href + `?t=${Date.now()}`);
  const fired = [];
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  await React.act(async () => {
    root.render(React.createElement(Dispatch, {
      projectId: 'proj-1',
      projectName: 'fixture',
      onClose: () => {},
      onDispatch: (p) => { fired.push(p); },
    }));
  });
  // Let the router-status + options effects settle.
  await React.act(async () => { await new Promise((r) => setTimeout(r, 30)); });

  ok(!!byTestId(document.body, 'dispatch-custom'),
     'with a live router the Custom deployment panel is present');
  ok(!byTestId(document.body, 'dispatch-instant'),
     'Instant is ABSENT until something is pinned (footer unchanged for the common case)');

  // Open custom panel and pin provider=claude + mode=1 + harness=dev-reviewer.
  await React.act(async () => { click(byTestId(document.body, 'dispatch-custom-toggle')); });
  await React.act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  await React.act(async () => { click(byTestId(document.body, 'custom-provider-claude')); });
  await React.act(async () => { click(byTestId(document.body, 'custom-mode-1')); });
  await React.act(async () => { click(byTestId(document.body, 'custom-harness-dev-reviewer')); });
  await React.act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  // Account picker: claude has two unpaused accounts → shown; openai has one → not when switched.
  ok(!!byTestId(document.body, 'custom-account-default'),
     'account picker appears when the resolved provider has >1 unpaused account');
  ok(!!byTestId(document.body, `custom-account-${ACCT_A}`)
     && !!byTestId(document.body, `custom-account-${ACCT_B}`),
     '…and lists both unpaused accounts');

  // Pin the second account so Instant carries it.
  await React.act(async () => { click(byTestId(document.body, `custom-account-${ACCT_B}`)); });

  const preview = byTestId(document.body, 'dispatch-instant-preview');
  ok(!!preview, 'resolved-payload preview renders next to Instant once something is pinned');
  const previewHtml = htmlOf(preview);
  ok(/instant-preview-provider/.test(previewHtml) || byTestId(document.body, 'instant-preview-provider'),
     'preview names provider');
  const provChip = byTestId(document.body, 'instant-preview-provider');
  const modeChip = byTestId(document.body, 'instant-preview-mode');
  const modelChip = byTestId(document.body, 'instant-preview-model');
  const acctChip = byTestId(document.body, 'instant-preview-account');
  ok(provChip?.getAttribute('data-source') === 'pinned', 'provider chip is pinned (human set it)');
  ok(modeChip?.getAttribute('data-source') === 'pinned', 'mode chip is pinned');
  ok(modelChip?.getAttribute('data-source') === 'default',
     'model chip is default (silently filled — the footgun made visible)');
  ok(acctChip?.getAttribute('data-source') === 'pinned', 'account chip is pinned to Claude B');

  const instantBtn = byTestId(document.body, 'dispatch-instant');
  ok(!!instantBtn, 'Instant deploy button is present once pins exist');
  ok(/Claude|sonnet|default/i.test(instantBtn.getAttribute('title') || ''),
     'Instant button title attr carries the resolved payload');

  // Write a prompt into the contentEditable (Dispatch reads innerText).
  const editor = walk(document.body, (n) => n.className === 'disp-editor' || (n.attributes && n.attributes.contenteditable === 'true'))[0]
    || walk(document.body, (n) => n.getAttribute?.('contenteditable') === 'true')[0];
  ok(!!editor, 'the prompt editor mounted');
  editor.innerText = 'rewrite the intake loop';
  // Force empty=false so nothing about the placeholder path interferes (submit checks innerText).

  fired.length = 0;
  await React.act(async () => { click(instantBtn); });
  ok(fired.length === 1, `Instant fired onDispatch once (got ${fired.length})`);
  const inst = fired[0] || {};
  ok(!('via_router' in inst) && inst.via_router !== true,
     'Instant payload has NO via_router — App.jsx takes POST /api/xell/dispatch');
  ok(inst.provider === 'claude' && inst.mode === 1 && inst.model === 'sonnet',
     `Instant carries pins + silent model default (provider=${inst.provider} mode=${inst.mode} model=${inst.model})`);
  ok(inst.harness === 'dev-reviewer', 'Instant carries the pinned harness');
  ok(inst.provider_token_id === ACCT_B, 'Instant carries the pinned account as provider_token_id');
  ok(inst.task === 'rewrite the intake loop' || inst.project === 'proj-1',
     'Instant payload is a direct-dispatch shape (task/project present)');
  ok(inst.project === 'proj-1' && inst.task === 'rewrite the intake loop',
     'Instant payload names the project and the prompt text');

  // Route via router — same pins on the custom block, via_router: true. Account does NOT ride
  // (the routing custom block has no account field; the router picks the credential).
  fired.length = 0;
  const routeBtn = byTestId(document.body, 'dispatch-submit');
  ok(!!routeBtn, 'Route via router button is present');
  await React.act(async () => { click(routeBtn); });
  ok(fired.length === 1, `Route fired onDispatch once (got ${fired.length})`);
  const route = fired[0] || {};
  ok(route.via_router === true, 'Route payload sets via_router: true');
  ok(route.prompt === 'rewrite the intake loop', 'Route carries the raw prompt');
  ok(route.custom?.provider === 'claude' && route.custom?.mode === 1
     && route.custom?.harness === 'dev-reviewer',
     `Route carries the same custom pins (custom=${JSON.stringify(route.custom)})`);
  ok(route.custom?.model == null, 'unpinned model is omitted from Route custom (router decides)');
  ok(!('provider_token_id' in (route.custom || {})) && route.provider_token_id == null,
     'Route does not carry the Instant account pin on the custom block');

  // One account → no picker: switch provider to openai (single account).
  await React.act(async () => { click(byTestId(document.body, 'custom-provider-openai')); });
  await React.act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  ok(!byTestId(document.body, 'custom-account-default'),
     'account picker HIDDEN when the resolved provider has only one unpaused account');

  // Source wiring: Instant must call resolveInstantDeployment (shared with the preview).
  const src = readFileSync(join(ROOT, 'web/src/Dispatch.jsx'), 'utf8');
  ok(/resolveInstantDeployment\(/.test(src)
     && src.includes('const r = resolveInstantDeployment')
     && /instantResolved/.test(src),
     'Dispatch wires Instant fire AND the preview through resolveInstantDeployment');
  ok(/data-testid="dispatch-instant-preview"/.test(src)
     && /data-testid=\{`instant-preview-\$\{k\}`\}/.test(src),
     'preview chips are testable (dispatch-instant-preview + instant-preview-*)');
  ok(/data-testid="custom-account-default"/.test(src)
     && /cAccounts\.length > 1/.test(src),
     'account picker is gated on >1 unpaused account of the resolved provider');

  // Pasted images ride the dispatch body as base64 data URLs, so an oversized attachment fails the
  // whole POST. Dispatch enforces the same 20 MB ceiling as MessageComposer (MAX_BYTES), before
  // the request ever leaves — matching the server's 30mb json limit and the nginx client_max_body_size.
  ok(/const MAX_BYTES = 20 \* 1024 \* 1024/.test(src),
     'Dispatch carries the same 20 MB per-composition ceiling as MessageComposer');
  ok(/total > MAX_BYTES/.test(src) && /Attachments exceed 20 MB/.test(src)
     && /images: images\.map\(\(\{ name, data \}\) => \(\{ name, data \}\)\)/.test(src),
     'addImage refuses an oversized attachment with a named error, and images ride the payload');
} catch (e) {
  console.error('\n✗ FAIL — mount threw:', e.stack || e);
  fail++;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

// ── 3. the existing source contract still holds (router-custom-deployment's Instant half) ──────
section('source contract with router-custom-deployment.test.mjs stays honest');
{
  const disp = readFileSync(join(ROOT, 'web/src/Dispatch.jsx'), 'utf8');
  ok(/data-testid="dispatch-instant"/.test(disp), 'Instant button testid survives');
  ok(/wantsInstant/.test(disp) && /customCount > 0 \|\| prodDb/.test(disp),
     'Instant when live router + (something pinned OR LIVE PROD) — LIVE PROD alone opens the door');
  const instantBody = disp.slice(disp.indexOf('const instantDeploy = () =>'),
                                 disp.indexOf('const submit = () =>'));
  ok(instantBody.length > 80, 'instantDeploy is still its own handler');
  ok(!/via_router\s*:/.test(instantBody), 'instantDeploy still never sets via_router:');
  ok(/instantDispatchOnce\(directPayload\(task,/.test(instantBody), 'instantDeploy still hands a direct payload to onDispatch');
  ok(/\.\.\.\(customCount \? \{ custom \} : \{\}\)/.test(disp) && /via_router:\s*true/.test(disp),
     'Route via router still carries custom pins');
  const css = readFileSync(join(ROOT, 'web/src/styles.css'), 'utf8');
  ok(/\.disp-submit\.disp-instant\b/.test(css) && /\.disp-instant-preview\b/.test(css)
     && /\.disp-instant-chip\.is-default\b/.test(css),
     'Instant button + preview chips have styles (defaults dimmed)');
}

console.log(fail ? `\n✗ ${fail} check(s) failed\n` : '\nAll checks passed\n');
process.exit(fail ? 1 : 0);

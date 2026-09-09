// WEB HOOKS-ORDER test — a React component's hooks must be UNCONDITIONAL and in the SAME ORDER
// on every render. A hook that some renders skip is how the console blanks with React's minified
// #310.
//
// The bug this guard exists for (2026-08, prod hot-patch): App() has an EARLY RETURN for the
// loading state —
//     if (!fleet) return <div className="app"><p className="loading">Connecting…</p></div>;
// and BELOW that guard a "+ hexagon" create-menu action was declared with useCallback. The first
// (loading) render therefore ran fewer hooks than every later render, and React unwound the whole
// tree: "Rendered more hooks than during the previous render" (minified #310) → a blank console
// for every human who opened it. The fix was to make that handler a plain function (a hook below
// the guard can never be made unconditional by hoisting it above — its deps reference `project`,
// which is destructured from `fleet` only AFTER the guard, so the dep array throws a TDZ
// ReferenceError on every render).
//
// WHY a test and not a linter: this repo has no linter, no CI runner and no browser. `vite build`
// does NOT flag a conditional hook — it is legal JavaScript; the failure only happens at runtime,
// in the browser, when the second render calls more hooks than the first. So the build is green,
// the bundle ships, and the screen is blank. A static source check is the only gate that sees it.
//
// HOW: @babel/parser (already here, via @vitejs/plugin-react) parses each file under web/src, and
// the walker below applies rules-of-hooks' two conditional shapes to every component/custom hook:
//   1. a use[A-Z]( call in the component's own render flow that a CONDITIONAL RETURN can skip
//      (the #310 shape above — a return guarded by an if whose other path falls through to hooks);
//   2. a use[A-Z]( call inside an if / loop / switch branch (a hook that only some renders run).
// Hooks inside a nested function (an event handler, a useEffect/useMemo callback) are NOT render
// flow and are deliberately not flagged — that is legal, and it is the other rule's job.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';

const traverse = _traverse.default || _traverse;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'web', 'src');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const HOOK_RE = /^use[A-Z]/;
const isHookCall = (node) =>
  node && node.type === 'CallExpression' && node.callee && node.callee.type === 'Identifier'
  && HOOK_RE.test(node.callee.name);

// ── component/custom-hook detection ────────────────────────────────────────────────────────────
// A function is worth checking when it looks like a React component or a custom hook: a
// capitalized name, a `use*` name, or the default export — AND it actually renders JSX or calls a
// hook. Lower-case helpers are ignored, so a function that merely orchestrates is never a false
// positive.
const containsJSX = (fnNode) => {
  if (!fnNode || !fnNode.body) return false;
  let found = false; const seen = new Set();
  (function walk(n) {
    if (!n || found || seen.has(n)) return;
    seen.add(n);
    if (n.type === 'JSXElement' || n.type === 'JSXFragment') { found = true; return; }
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'start' || key === 'end'
          || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
      const v = n[key];
      if (Array.isArray(v)) { for (const c of v) walk(c); }
      else if (v && typeof v.type === 'string') walk(v);
    }
  })(fnNode.body);
  return found;
};

const fnUsesHook = (fnNode) => {
  if (!fnNode) return false;
  let found = false; const seen = new Set();
  (function walk(n) {
    if (!n || found || seen.has(n)) return;
    seen.add(n);
    if (n !== fnNode
        && (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'FunctionDeclaration')) return;
    if (isHookCall(n)) { found = true; return; }
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'start' || key === 'end'
          || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
      const v = n[key];
      if (Array.isArray(v)) { for (const c of v) walk(c); }
      else if (v && typeof v.type === 'string') walk(v);
    }
  })(fnNode);
  return found;
};

// Hook calls in a statement's RENDER FLOW — a use[A-Z]( whose ancestors up to the component contain
// no nested function (the callback handed to useCallback/useEffect/… is a different function, and
// hooks inside it are that function's business, not the render flow's).
const renderFlowHooks = (node, out) => {
  if (!node) return;
  if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression'
      || node.type === 'FunctionDeclaration') return;
  if (isHookCall(node)) { out.push(node); return; }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end'
        || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) renderFlowHooks(c, out); }
    else if (v && typeof v.type === 'string') renderFlowHooks(v, out);
  }
};

// ── flow analysis: which branches of a component's body always exit? ───────────────────────────
// A hook is conditional when the render can reach it by a path that has ALREADY returned. We walk
// the body statements in order, tracking whether an earlier conditional exit made everything after
// it "may skip". A block whose every path ends in return/throw stops the walk — the rest is dead.
const statementsAlwaysExit = (stmts) => {
  if (!stmts.length) return false;
  const last = stmts[stmts.length - 1];
  if (last.type === 'ReturnStatement' || last.type === 'ThrowStatement') return true;
  if (last.type === 'BlockStatement') return statementsAlwaysExit(last.body);
  if (last.type === 'IfStatement') return branchAlwaysExits(last.consequent) && branchAlwaysExits(last.alternate);
  if (last.type === 'SwitchStatement') {
    if (!last.cases.length) return false;
    for (const cse of last.cases) {
      const body = cse.consequent;
      if (!body.length) return false;
      const lastSt = body[body.length - 1];
      if (!(lastSt.type === 'ReturnStatement' || lastSt.type === 'ThrowStatement')) return false;
    }
    return true;
  }
  if (last.type === 'TryStatement') return branchAlwaysExits(last.block) && branchAlwaysExits(last.handler?.body);
  return false;
};
const branchAlwaysExits = (blockStmt) => {
  if (!blockStmt) return false;
  const arr = blockStmt.type === 'BlockStatement' ? blockStmt.body : [blockStmt];
  return statementsAlwaysExit(arr);
};

const analyzeBlock = (stmts, ctx, report) => {
  let maySkip = ctx.maySkip;
  for (const stmt of stmts) {
    const info = analyzeStmt(stmt, { inConditionalBranch: ctx.inConditionalBranch, maySkip }, report);
    if (info.alwaysExits) return;
    if (info.someExit) maySkip = true;
  }
};

const analyzeStmt = (stmt, ctx, report) => {
  const hooks = [];
  renderFlowHooks(stmt, hooks);
  for (const h of hooks) {
    if (ctx.inConditionalBranch) report(h, 'hook inside a conditional/loop block');
    else if (ctx.maySkip) report(h, 'hook reached only after a conditional return');
  }
  switch (stmt.type) {
    case 'ReturnStatement':
    case 'ThrowStatement':
      return { alwaysExits: true, someExit: false };
    case 'IfStatement': {
      const cBody = stmt.consequent && stmt.consequent.type === 'BlockStatement'
        ? stmt.consequent.body : (stmt.consequent ? [stmt.consequent] : []);
      analyzeBlock(cBody, { inConditionalBranch: true, maySkip: ctx.maySkip }, report);
      if (stmt.alternate) {
        const aBody = stmt.alternate.type === 'BlockStatement' ? stmt.alternate.body : [stmt.alternate];
        analyzeBlock(aBody, { inConditionalBranch: true, maySkip: ctx.maySkip }, report);
      }
      const cExits = branchAlwaysExits(stmt.consequent);
      const aExits = stmt.alternate ? branchAlwaysExits(stmt.alternate) : false;
      const bothExit = cExits && aExits;
      const someExit = cExits || aExits;
      return { alwaysExits: bothExit, someExit: someExit && !bothExit };
    }
    case 'WhileStatement':
    case 'DoWhileStatement':
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement': {
      const body = stmt.body && stmt.body.type === 'BlockStatement' ? stmt.body.body : (stmt.body ? [stmt.body] : []);
      analyzeBlock(body, { inConditionalBranch: true, maySkip: ctx.maySkip }, report);
      return { alwaysExits: false, someExit: false };
    }
    case 'SwitchStatement': {
      for (const cse of stmt.cases) analyzeBlock(cse.consequent, { inConditionalBranch: true, maySkip: ctx.maySkip }, report);
      return { alwaysExits: false, someExit: false };
    }
    case 'TryStatement': {
      analyzeBlock(stmt.block.body, { inConditionalBranch: ctx.inConditionalBranch, maySkip: ctx.maySkip }, report);
      if (stmt.handler) analyzeBlock(stmt.handler.body.body, { inConditionalBranch: true, maySkip: ctx.maySkip }, report);
      if (stmt.finalizer) analyzeBlock(stmt.finalizer.body, { inConditionalBranch: ctx.inConditionalBranch, maySkip: ctx.maySkip }, report);
      return { alwaysExits: false, someExit: false };
    }
    case 'BlockStatement':
      analyzeBlock(stmt.body, ctx, report);
      return { alwaysExits: false, someExit: false };
    case 'LabeledStatement':
      return analyzeStmt(stmt.body, ctx, report);
    default:
      return { alwaysExits: false, someExit: false };
  }
};

const checkComponent = (fnNode, report) => {
  if (!fnNode || !fnNode.body || fnNode.body.type !== 'BlockStatement') return;
  analyzeBlock(fnNode.body.body, { inConditionalBranch: false, maySkip: false }, report);
};

// ── the public check ───────────────────────────────────────────────────────────────────────────
// `checkSource` returns the violations found in one source text: [{ line, name, reason }].
const checkSource = (src) => {
  const ast = parse(src, { sourceType: 'module', plugins: ['jsx'] });
  const violations = [];
  const candidates = [];
  traverse(ast, {
    FunctionDeclaration(path) {
      const name = path.node.id && path.node.id.name;
      if (name && (/^[A-Z]/.test(name) || /^use[A-Z]/.test(name))) candidates.push(path.node);
    },
    VariableDeclarator(path) {
      const idName = path.node.id && path.node.id.name;
      if (typeof idName === 'string' && /^[A-Z]/.test(idName)) {
        const init = path.node.init;
        if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) candidates.push(init);
        else if (init && init.type === 'CallExpression' && /^(memo|forwardRef)$/.test(init.callee.name)) {
          const arg = init.arguments[0];
          if (arg && (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression')) candidates.push(arg);
        }
      }
    },
    ExportDefaultDeclaration(path) {
      const decl = path.node.declaration;
      if (decl && (decl.type === 'FunctionDeclaration' || decl.type === 'FunctionExpression' || decl.type === 'ArrowFunctionExpression')) {
        if (!decl.id || !/^[A-Z]/.test(decl.id.name)) candidates.push(decl);
      }
    },
  });
  for (const fnNode of candidates) {
    if (!containsJSX(fnNode) && !fnUsesHook(fnNode)) continue;
    checkComponent(fnNode, (hookNode, reason) => {
      violations.push({ line: hookNode.loc.start.line, col: hookNode.loc.start.column + 1, name: hookNode.callee.name, reason });
    });
  }
  return violations;
};

// ── the check proves it can FAIL ───────────────────────────────────────────────────────────────
// A green test that cannot go red is decoration. The first is the exact #310 shape, verbatim (a
// hook below the `if (!fleet) return` guard — the one that shipped and blanked the console); the
// second is a hook inside an if branch. The rest are legal shapes that must NOT be flagged.
const preFixApp = `
export default function App() {
  const [x, setX] = useState(1);
  const fleet = null;
  if (!fleet) return <p>Loading</p>;
  const { project } = fleet;
  const handlePlusAction = useCallback(() => project, [project]);
  return <p>{handlePlusAction()}</p>;
}`;
ok(checkSource(preFixApp).some((v) => v.name === 'useCallback' && v.line === 7),
   'a hook below a conditional return is caught (the App #310 shape)');

const hookInsideIf = `
export default function C() {
  const a = 1;
  if (a) { useState(1); }
  return <p>x</p>;
}`;
ok(checkSource(hookInsideIf).some((v) => v.name === 'useState'),
   'a hook inside an if block is caught');

const hookInsideLoop = `
export default function C() {
  for (let i = 0; i < 2; i++) { useMemo(() => i, [i]); }
  return <p>x</p>;
}`;
ok(checkSource(hookInsideLoop).some((v) => v.name === 'useMemo'),
   'a hook inside a loop is caught');

const plainFnAfterGuard = `
export default function App() {
  const [x, setX] = useState(1);
  const fleet = null;
  if (!fleet) return <p>Loading</p>;
  const { project } = fleet;
  const handlePlusAction = async () => project;
  return <p>ok</p>;
}`;
ok(checkSource(plainFnAfterGuard).length === 0,
   'the fix — a plain function below the guard — is not flagged');

const nestedCallbackHook = `
export default function C() {
  const [a, setA] = useState(1);
  useEffect(() => { if (a) setA(2); }, [a]);
  const v = useMemo(() => { if (a > 0) return 'pos'; return 'non'; }, [a]);
  const onClick = () => { const [x] = useState(1); return x; };
  return <p>{v}<button onClick={onClick}>x</button></p>;
}`;
ok(checkSource(nestedCallbackHook).length === 0,
   'hooks inside a callback (useEffect/useMemo/event handler) are not render-flow and are not flagged');

const endConditionalReturn = `
export default function C() {
  const [a] = useState(1);
  if (a) return <p>a</p>;
  return <p>b</p>;
}`;
ok(checkSource(endConditionalReturn).length === 0,
   'a conditional return with no hooks after it is legal');

// ── every source file under web/src ───────────────────────────────────────────────────────────
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(jsx?|mjs)$/.test(e)) files.push(p);
  }
})(SRC);
ok(files.length > 20, `${files.length} source files under web/src to check`);

console.log('\n── web/src ──');
for (const f of files) {
  const rel = relative(ROOT, f).replace(/\\/g, '/');
  let v = null; let why = '';
  try { v = checkSource(readFileSync(f, 'utf8')); }
  catch (e) { why = ` — did not parse: ${String(e.message).split('\n')[0]}`; }
  if (v && v.length) {
    for (const x of v) {
      ok(false, `${rel}:${x.line}:${x.col} — ${x.name} — ${x.reason}`);
    }
  } else {
    ok(v && v.length === 0, `${rel}${why}`);
  }
}

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures ? 1 : 0);

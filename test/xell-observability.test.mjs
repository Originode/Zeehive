// XELL OBSERVABILITY — the per-turn ledger panel (web/src/XellObservability.jsx).
//
// This is a RENDER test, not a behaviour test: it bundles the real component (with its real
// react/react-dom) through esbuild, mocks the read-only API, and renders the two visible
// surfaces to static markup:
//   1. TurnRow — one per-turn ledger row, redesigned as a trace card with a kind/status badge,
//      a model+summary main column, and right-aligned token/cost/duration metrics.
//   2. GatewayCalls — the gateway-call list, whose individual request rows carry the same badge.
// The assertions lock the NEW trace-card shape: the badge span, the main column, the summary
// line, and the status-coloured badge class are all present in the rendered output.
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// The transformed file lives in web/src (not /tmp) so its imports — react, react-dom, and the
// API mock below — resolve from the repo's own node_modules. The temp bundle is deleted after.
const src = readFileSync(resolve(ROOT, 'web/src/XellObservability.jsx'), 'utf8');
// Mock the read-only API: TurnRow fetches events on expand, GatewayCallRow fetches bodies.
const mocked = transformSync(src, { loader: 'jsx', format: 'esm' }).code.replace(
  /import \{[^}]*getXellObservability[^}]*\} from ['"]\.\/api\.js['"];?/,
  `const getXellObservability = async () => ({ turns: [], workflow: [] });
     const getTurnEvents = async () => ({ events: [] });
     const getXellGatewayRequests = async () => ({ requests: [] });
     const getGatewayRequestBody = async () => null;`);

const tmpJsx = resolve(ROOT, 'web/src/.xob-verify.jsx');
const tmpOut = resolve(ROOT, 'web/src/.xob-verify.cjs');
writeFileSync(tmpJsx, mocked);
try {
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [tmpJsx],
    bundle: true, format: 'cjs', platform: 'node', jsx: 'automatic',
    outfile: tmpOut, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"development"' },
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    absWorkingDir: ROOT,
  });
  const { renderToStaticMarkup } = await import('react-dom/server');
  const React = (await import('react')).default;
  const mod = createRequire(tmpOut)(tmpOut);
  const { TurnRow, GatewayCalls } = mod;

  // ── 1. TurnRow renders as a trace card with a badge ──────────────────────────────────────
  console.log('\n── TurnRow: the per-turn ledger row as a trace card ──');
  const turn = {
    id: 't1', kind: 'resume', status: 'ended', model: 'claude-3-5-sonnet',
    input_tokens: 1200, output_tokens: 800, cache_read_tokens: 100, cache_write_tokens: 50,
    cost_usd: 0.0423, started_at: '2026-01-01T10:00:00Z', ended_at: '2026-01-01T10:05:00Z',
    summary: 'Implemented the landing gate', session_id: 'sess-1', metered: true,
  };
  const html = renderToStaticMarkup(React.createElement(TurnRow, { turn, open: false, onToggle: () => {} }));
  ok(/class="ob-badge ended"/.test(html), 'the turn row opens with a status-coloured badge (ended)');
  ok(/↻/.test(html), 'the badge shows the kind icon (resume = ↻)');
  ok(/claude-3-5-sonnet/.test(html), 'the model name is the primary line');
  ok(/✓ done/.test(html), 'the status label renders beside the model');
  ok(/resume/.test(html), 'the kind label renders beside the model');
  ok(/Implemented the landing gate/.test(html), 'the turn summary is the second line of the main column');
  ok(/2\.1k tok/.test(html), 'the token total renders (1200+800+100+50 = 2150 → 2.1k)');
  ok(/\$0\.0423/.test(html), 'the cost renders');
  ok(/5m/.test(html), 'the duration renders (10:00→10:05 = 5m)');

  // ── 2. TurnRow status badge colour follows the status ────────────────────────────────────
  console.log('\n── TurnRow: badge colour tracks the turn status ──');
  const errTurn = { ...turn, id: 't2', kind: 'spawn', status: 'errored', cost_usd: null, summary: null };
  const errHtml = renderToStaticMarkup(React.createElement(TurnRow, { turn: errTurn, open: false, onToggle: () => {} }));
  ok(/class="ob-badge errored"/.test(errHtml), 'an errored turn gets the errored badge colour');
  ok(/class="ob-turn-status errored"/.test(errHtml), 'and the status label is coloured errored too');
  ok(/🚀/.test(errHtml), 'a spawn turn shows the spawn kind icon');

  // ── 3. GatewayCalls renders request rows with the same badge ────────────────────────────
  console.log('\n── GatewayCalls: the gateway-call list rows ──');
  const reqs = [{
    id: 'r1', turn_id: null, kind: 'messages', status: 200, provider: 'anthropic',
    model: 'claude-3-5-sonnet', total_tokens: 500, cost_usd: 0.0123, duration_ms: 1500,
    requested_at: '2026-01-01T10:00:00Z', zee_name: 'test-zee', session_id: 'sess-1',
  }];
  const gwHtml = renderToStaticMarkup(React.createElement(GatewayCalls, { requests: reqs, xellId: 'x1' }));
  ok(/ob-badge ended/.test(gwHtml), 'a 200-status gateway call gets the green (ended) badge');
  ok(/📨/.test(gwHtml), 'a messages call shows the messages icon in the badge');
  ok(/anthropic · claude-3-5-sonnet/.test(gwHtml), 'the provider · model line renders');
  ok(/500 tok/.test(gwHtml), 'the request token count renders');
  ok(/1500ms/.test(gwHtml), 'the request duration renders');

  // ── 4. GatewayCalls empty state ─────────────────────────────────────────────────────────
  console.log('\n── GatewayCalls: empty state ──');
  const emptyHtml = renderToStaticMarkup(React.createElement(GatewayCalls, { requests: [], xellId: 'x1' }));
  ok(/No gateway calls recorded yet/.test(emptyHtml), 'the empty state reads clearly');
} finally {
  rmSync(tmpJsx, { force: true });
  rmSync(tmpOut, { force: true });
}

console.log(fail === 0 ? '\nALL PASSED ✓' : `\n${fail} FAILURE(S) ✗`);
process.exit(fail ? 1 : 0);

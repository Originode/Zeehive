import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// A xell worktree carries its parameters in the generated .zeehive.env projection (spec §6.1):
// ZEEHIVE_WEB_PORT is this dev server's port, PORT is its own API's. Parse it here (vite does
// not run dotenv over the repo root) so `npm run web` works unchanged in a worktree; the live
// checkout has no .zeehive.env and keeps today's 5180 → :4700 shape. Real env vars still win.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let proj = {};
try {
  proj = Object.fromEntries(
    readFileSync(resolve(root, '.zeehive.env'), 'utf8').split('\n')
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
} catch { /* no projection — the live checkout */ }
const env = (k) => process.env[k] ?? proj[k];

// Xell webapps are reached DIRECTLY on their own port now (docs/visual-verification-diagnosis.md
// §7): http://<console-hostname>:<ZEEHIVE_WEB_PORT>/. No path prefix — base stays '/' everywhere,
// in a xell worktree and the live checkout alike. (The /xell-web/<slug>/ prefix era is over; the
// old route 302s to the port.)
const base = '/';

// wterm is VENDORED under web/vendor/wterm (not an npm install) so a process-runner spinoff
// whose host node_modules pre-dates the dep still resolves it — the fleet's start-xell-process
// only re-runs npm ci when the tree is empty, and a lockfile-only change used to leave the
// role unable to import @wterm/*. Alias the package names the vendored sources still use.
const wtermVendor = resolve(dirname(fileURLToPath(import.meta.url)), 'vendor/wterm');

// Proxy /api → this checkout's OWN queenzee API so the app can use relative URLs (incl. SSE).
export default defineConfig({
  plugins: [react()],
  base,
  resolve: {
    alias: [
      // More-specific css subpath first. Point at the files themselves — aliasing the package
      // directory alone left vite 5 unable to resolve `import('@wterm/dom')` on a process-runner
      // spinoff even when the vendor tree was present.
      { find: '@wterm/dom/css', replacement: resolve(wtermVendor, 'dom/src/terminal.css') },
      { find: '@wterm/dom', replacement: resolve(wtermVendor, 'dom/dist/index.js') },
      { find: '@wterm/core', replacement: resolve(wtermVendor, 'core/dist/index.js') },
      { find: '@wterm/ghostty', replacement: resolve(wtermVendor, 'ghostty/dist/index.js') },
    ],
  },
  server: {
    port: Number(env('ZEEHIVE_WEB_PORT')) || 5180,
    host: true,
    // A xell webapp is reached through the queenzee proxy AND, in review, opened directly. Vite's
    // dev server 403s any Host it does not know (verified: 403 on a foreign Host, 200 on
    // localhost). The proxy forwards the browser's real Host, so an allow-list would need every
    // install's console origin — the exact per-install config this feature exists to avoid.
    // allowedHosts:true is acceptable because a xell webapp is a throwaway dev server in a
    // sandboxed container with no credentials; revisit if one ever holds real secrets.
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.ZEEHIVE_API || `http://localhost:${Number(env('PORT')) || 4700}`,
        changeOrigin: true,
        ws: true, // the cxell-zee terminal is a websocket under /api/zees/:id/terminal
      },
    },
  },
});

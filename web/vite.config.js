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

// Proxy /api → this checkout's OWN queenzee API so the app can use relative URLs (incl. SSE).
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(env('ZEEHIVE_WEB_PORT')) || 5180,
    host: true,
    proxy: {
      '/api': {
        target: process.env.ZEEHIVE_API || `http://localhost:${Number(env('PORT')) || 4700}`,
        changeOrigin: true,
      },
    },
  },
});

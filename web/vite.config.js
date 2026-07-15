import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxy /api → the queenzee Node API so the app can use relative URLs (incl. SSE).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      '/api': {
        target: process.env.ZEEHIVE_API || 'http://localhost:4700',
        changeOrigin: true,
      },
    },
  },
});

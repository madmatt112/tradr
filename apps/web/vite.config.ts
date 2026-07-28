import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev and the e2e suite both serve the SPA same-origin and proxy /api to the
// API. `preview` (used by the e2e built-SPA server) must mirror `server` so a
// static production build routes /api identically to the dev server.
const apiProxy = { '/api': 'http://localhost:3100' };

export default defineConfig({
  plugins: [TanStackRouterVite(), react(), tailwindcss()],
  build: {
    manifest: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: apiProxy,
  },
  preview: {
    proxy: apiProxy,
  },
  test: {
    setupFiles: ['./vitest.setup.ts', './src/test/setup.ts'],
  },
});

import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    setupFiles: ['src/test-setup.ts'],
    env: {
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5433/tradr_test',
      SESSION_SECRET: 'test-secret-that-is-at-least-32-characters-long',
      NODE_ENV: 'test',
      PORT: '3001',
      TRUSTED_PROXIES: '127.0.0.1',
      // Test-only deterministic key (64 hex chars). MUST NOT be used in production.
      ENCRYPTION_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
      // Affirmative pin-off of every backend telemetry surface (REQ-1.5) — a stray
      // dev/CI env var must not silently arm a surface in CI. '' reads falsy via
      // the predicates; POSTHOG_HOST='' resolves to its default via the preprocess.
      POSTHOG_API_KEY: '',
      POSTHOG_HOST: '',
    },
  },
});

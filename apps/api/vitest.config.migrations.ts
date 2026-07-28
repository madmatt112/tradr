import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    setupFiles: [],
    include: ['src/db/migrate.test.ts'],
    env: {
      DATABASE_URL:
        process.env.MIGRATE_TEST_DATABASE_URL ||
        'postgresql://postgres:postgres@localhost:5433/tradr_test_migrate',
      SESSION_SECRET: 'test-secret-that-is-at-least-32-characters-long',
      NODE_ENV: 'test',
      PORT: '3102',
      TRUSTED_PROXIES: '127.0.0.1',
      ENCRYPTION_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
    },
  },
});

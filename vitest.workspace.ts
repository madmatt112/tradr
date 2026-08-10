import path from 'node:path';

import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'shared',
      root: './packages/shared',
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'api',
      root: './apps/api',
      environment: 'node',
      pool: 'forks',
      include: ['src/**/*.test.ts'],
      exclude: [
        'src/db/migrate.test.ts',
        'src/db/accounting.migration.test.ts',
        'src/db/expenses.migration.test.ts',
      ],
      setupFiles: ['./src/test-setup.ts'],
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
        // Affirmative pin-off of every gated hosted-platform capability (REQ-1.6) — a
        // stray ambient REDIS_URL / OBJECT_STORAGE_* / CORS / pooler / FEATURE_GATING var
        // must NOT silently arm object storage, Redis, split-origin, pooler-mode or plan
        // gating in CI. '' reads falsy / preprocesses to undefined via the isXConfigured
        // predicates. The three enum vars (DB_TRANSACTION_POOLER,
        // OBJECT_STORAGE_FORCE_PATH_STYLE, FEATURE_GATING) are pinned 'false', NOT '':
        // z.enum().default() only fires on `undefined`, so '' fails the enum and would
        // boot-crash envSchema.parse — 'false' is the genuine deactivated (off) value.
        REDIS_URL: '',
        DIRECT_DATABASE_URL: '',
        DB_TRANSACTION_POOLER: 'false',
        OBJECT_STORAGE_ENDPOINT: '',
        OBJECT_STORAGE_BUCKET: '',
        OBJECT_STORAGE_REGION: '',
        OBJECT_STORAGE_ACCESS_KEY_ID: '',
        OBJECT_STORAGE_SECRET_ACCESS_KEY: '',
        OBJECT_STORAGE_FORCE_PATH_STYLE: 'false',
        CORS_ALLOWED_ORIGINS: '',
        // Plan gating is the premise the onboarding parity block states and then leans
        // on (app.self-host-parity.test.ts): with it off there is no account cap, so the
        // demo/real refusal proved there is the exclusion guard firing unaided. Left to
        // the ambient environment that premise is only a hope, and the suites that DO
        // exercise gating set config.FEATURE_GATING themselves and restore it after.
        FEATURE_GATING: 'false',
        // Affirmative pin-off of the transactional-email surface (REQ-7.6) — a stray
        // ambient SMTP_HOST must not silently arm email in CI. '' ≡ absent for ALL
        // seven vars: preprocess vars map '' → undefined and the plain optional
        // strings read falsy; SMTP_PORT/SMTP_TLS_MODE are preprocess-empty-tolerant
        // too (unlike the enum vars above, '' resolves to their defaults, not a boot
        // crash). isEmailConfigured() false; the coherence assert stays silent.
        SMTP_HOST: '',
        SMTP_PORT: '',
        SMTP_TLS_MODE: '',
        SMTP_USER: '',
        SMTP_PASS: '',
        EMAIL_FROM: '',
        EMAIL_FROM_NAME: '',
        WEB_BASE_URL: '',
        // Affirmative pin-off of the Prometheus exposition surface (REQ-1.8) — a
        // stray ambient METRICS_* must not arm the surface or red the REQ-1.7
        // parity assertion. All three are pinned to their REAL values, never '':
        // METRICS_ENABLED is an enum, so '' fails it and boot-crashes
        // envSchema.parse (the rule recorded on the gated-capability block above);
        // METRICS_PORT is a bare z.coerce.number() with NO empty-tolerant
        // preprocess (unlike SMTP_PORT), so '' would coerce to the valid number 0;
        // METRICS_HOST's .default() fires only on `undefined`, so '' would yield
        // an empty host.
        METRICS_ENABLED: 'false',
        METRICS_PORT: '9464',
        METRICS_HOST: '0.0.0.0',
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'apps/api/src'),
      },
    },
  },
  {
    test: {
      name: 'migrations',
      root: './apps/api',
      environment: 'node',
      include: [
        'src/db/migrate.test.ts',
        'src/db/accounting.migration.test.ts',
        'src/db/expenses.migration.test.ts',
      ],
      setupFiles: [],
      env: {
        DATABASE_URL:
          process.env.MIGRATE_TEST_DATABASE_URL ||
          'postgresql://postgres:postgres@localhost:5433/tradr_test_migrate',
        SESSION_SECRET: 'test-secret-that-is-at-least-32-characters-long',
        NODE_ENV: 'test',
        PORT: '3102',
        TRUSTED_PROXIES: '127.0.0.1',
        ENCRYPTION_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
        // Pin every gated hosted-platform capability off for the migration tests too
        // (REQ-1.6) — a stray ambient DIRECT_DATABASE_URL / DB_TRANSACTION_POOLER must not
        // silently route migrations over a direct/pooler connection in CI. '' reads
        // falsy/undefined via the predicates; the two enum vars are pinned 'false', not ''
        // (z.enum().default() fires only on `undefined`; '' fails the enum and boot-crashes
        // envSchema.parse). Migrations stay on DATABASE_URL with prepared statements on.
        REDIS_URL: '',
        DIRECT_DATABASE_URL: '',
        DB_TRANSACTION_POOLER: 'false',
        OBJECT_STORAGE_ENDPOINT: '',
        OBJECT_STORAGE_BUCKET: '',
        OBJECT_STORAGE_REGION: '',
        OBJECT_STORAGE_ACCESS_KEY_ID: '',
        OBJECT_STORAGE_SECRET_ACCESS_KEY: '',
        OBJECT_STORAGE_FORCE_PATH_STYLE: 'false',
        CORS_ALLOWED_ORIGINS: '',
        // Pin the transactional-email surface off for the migration tests too
        // (REQ-7.6) — '' ≡ absent for all seven vars (every schema is ''-tolerant
        // by design), so the predicate reads false and the coherence assert stays
        // silent.
        SMTP_HOST: '',
        SMTP_PORT: '',
        SMTP_TLS_MODE: '',
        SMTP_USER: '',
        SMTP_PASS: '',
        EMAIL_FROM: '',
        EMAIL_FROM_NAME: '',
        WEB_BASE_URL: '',
        // Pin the Prometheus exposition surface off for the migration tests too
        // (REQ-1.8). Real values, never '': METRICS_ENABLED is an enum ('' fails
        // it and boot-crashes envSchema.parse), METRICS_PORT is a bare
        // z.coerce.number() with no empty-tolerant preprocess ('' → 0), and
        // METRICS_HOST's .default() fires only on `undefined` ('' → empty host).
        METRICS_ENABLED: 'false',
        METRICS_PORT: '9464',
        METRICS_HOST: '0.0.0.0',
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'apps/api/src'),
      },
    },
  },
  {
    test: {
      name: 'web',
      root: './apps/web',
      environment: 'jsdom',
      pool: 'forks',
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      setupFiles: ['./vitest.setup.ts', './src/test/setup.ts'],
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'apps/web/src'),
      },
    },
  },
  {
    test: {
      name: 'web-scripts',
      root: './apps/web/scripts',
      environment: 'node',
      include: ['**/*.test.ts', '**/*.test.mjs'],
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'apps/web/src'),
      },
    },
  },
]);

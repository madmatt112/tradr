import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';

const processEnvSelector = {
  selector: "MemberExpression[object.name='process'][property.name='env']",
  message: "Use config from '@/lib/config.ts' instead of process.env",
};

const positionsInsertMessage =
  "Direct db.insert(positions) bypasses the positions feature's audit/invariant layer — use the positions service or a feature-local query helper. Performance-charts §8.2: exposing `draft`/`closed` rows to downstream readers can violate the status/closed_at CHECK constraint.";

const positionsInsertSelectors = [
  {
    selector:
      "CallExpression[callee.object.name='db'][callee.property.name='insert'][arguments.0.name='positions']",
    message: positionsInsertMessage,
  },
  {
    selector:
      "CallExpression[callee.object.name='tx'][callee.property.name='insert'][arguments.0.name='positions']",
    message: positionsInsertMessage,
  },
];

const webSharedLibPath = {
  name: '@tradr/shared/lib/performance',
  message:
    'apps/web must not import from @tradr/shared/lib/* — performance computation primitives live in @tradr/shared/schemas/* or are backend-only.',
};

const webSharedLibPattern = {
  group: ['@tradr/shared/lib/*'],
  message:
    'apps/web must not import from @tradr/shared/lib/* — import schemas or expose a new api entry in @tradr/shared/src/index.ts instead.',
};

const driverJsPattern = {
  group: ['driver.js', 'driver.js/**'],
  message:
    'apps/web/src/features/onboarding/lib/tour-engine.ts is the only module permitted to import driver.js — go through that wrapper so no driver.js type crosses the boundary.',
};

export default tseslint.config(
  {
    // `.astro/` is a generated type-output cache — not source.
    // `.astro/` holds the types Astro generates from the content collections.
    // It is build output, not source, and it does not satisfy this config's
    // rules (it uses `any` and a triple-slash reference).
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/.astro/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      'import-x': importX,
    },
    rules: {
      'no-restricted-syntax': ['error', processEnvSelector, ...positionsInsertSelectors],
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          pathGroups: [
            {
              pattern: '@tradr/**',
              group: 'internal',
              position: 'before',
            },
            {
              pattern: '@/**',
              group: 'internal',
              position: 'after',
            },
          ],
          pathGroupsExcludedImportTypes: ['builtin'],
          'newlines-between': 'always',
          alphabetize: {
            order: 'asc',
            caseInsensitive: true,
          },
        },
      ],
    },
  },
  {
    files: ['apps/api/src/features/positions/**/*.ts', 'apps/api/src/features/positions/**/*.tsx'],
    rules: {
      'no-restricted-syntax': ['error', processEnvSelector],
    },
  },
  {
    files: [
      'apps/api/src/lib/config.ts',
      '**/*.test.ts',
      '**/test-setup.ts',
      '**/vitest.config*.ts',
      'vitest.workspace.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...positionsInsertSelectors],
    },
  },
  {
    files: ['apps/api/src/db/seed/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', processEnvSelector],
    },
  },
  {
    files: ['apps/api/src/features/accounting/ledger-hook.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/db',
              message:
                'ledger-hook must receive db access via tx; do not import the global db handle.',
            },
          ],
          patterns: [
            {
              group: ['**/db/index', '**/db'],
              message: 'ledger-hook must not import a global db handle.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [webSharedLibPath],
          patterns: [webSharedLibPattern, driverJsPattern],
        },
      ],
    },
  },
  {
    // The tour engine is the wrapper the rule above points at, so it is the one
    // module in apps/web allowed to import driver.js.
    files: ['apps/web/src/features/onboarding/lib/tour-engine.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [webSharedLibPath],
          patterns: [webSharedLibPattern],
        },
      ],
    },
  },
  {
    files: [
      'apps/web/src/components/layout/SideDrawer.tsx',
      'apps/web/src/components/layout/DrawerToggle.tsx',
      'apps/web/src/features/drawer/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/stores/event-bus.store',
              message:
                'drawer code MUST NOT subscribe to the event bus (REQ-8.1). Use mutation-hook invalidations.',
            },
            {
              name: '@/stores/EventBusBridge',
              message:
                'drawer code MUST NOT subscribe to the event bus (REQ-8.1). Use mutation-hook invalidations.',
            },
          ],
          patterns: [
            {
              regex: '^@/stores(?:/index(?:\\..+)?)?$',
              message:
                'drawer code MUST NOT import from @/stores barrels (REQ-8.1). Barrel imports from the stores module are blocked; import the specific store module directly (e.g. @/stores/drawer.store).',
            },
            driverJsPattern,
          ],
        },
      ],
    },
  },
);

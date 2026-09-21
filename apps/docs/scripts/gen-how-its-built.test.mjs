import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';

import {
  PROJECTS,
  checkWorkspaceSync,
  parseCiJobs,
  countDockerSmokeAssertions,
  collectFigures,
  renderFigures,
} from './gen-how-its-built.mjs';

// The three migration test files the `api` project excludes and the `migrations`
// project counts (vitest.workspace.ts).
const MIGRATION_TESTS = [
  'src/db/migrate.test.ts',
  'src/db/accounting.migration.test.ts',
  'src/db/expenses.migration.test.ts',
];

// A workspace text carrying all six project names and the three excluded paths
// verbatim, so checkWorkspaceSync passes over a good fixture.
const WORKSPACE = `import { defineWorkspace } from 'vitest/config';
export default defineWorkspace([
  { test: { name: 'shared' } },
  { test: { name: 'api', exclude: [
    '${MIGRATION_TESTS[0]}',
    '${MIGRATION_TESTS[1]}',
    '${MIGRATION_TESTS[2]}',
  ] } },
  { test: { name: 'migrations', include: [
    '${MIGRATION_TESTS[0]}',
    '${MIGRATION_TESTS[1]}',
    '${MIGRATION_TESTS[2]}',
  ] } },
  { test: { name: 'web' } },
  { test: { name: 'web-scripts' } },
  { test: { name: 'docs-scripts' } },
]);
`;

// A ci.yml with the five gate jobs and two docker-smoke Assert steps. `push:`
// under `on:` sits before `jobs:` and must not be read as a job.
const CI = `name: CI
on:
  push:
    branches: [main]
jobs:
  checks:
    steps:
      - run: echo checks
  test-api:
    steps:
      - run: echo test-api
  test-web:
    steps:
      - run: echo test-web
  e2e:
    steps:
      - run: echo e2e
  docker-smoke:
    steps:
      - name: Assert something (a)
        run: echo a
      - name: Assert another thing (b)
        run: echo b
`;

const tmpDirs = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function write(root, relPath, contents = '') {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

// Build a throwaway repository tree that collectFigures reads cleanly: one
// matching file per walked project, the three migration tests (excluded from
// `api`, counted by `migrations`), one e2e spec, one migration SQL, plus the
// workspace and ci.yml fixtures above.
function makeRepo({ omitE2e = false, emptyMigrations = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gen-hib-'));
  tmpDirs.push(root);

  write(root, 'packages/shared/src/one.test.ts');
  write(root, 'apps/api/src/one.test.ts');
  for (const f of MIGRATION_TESTS) write(root, join('apps/api', f));
  write(root, 'apps/web/src/one.test.tsx');
  write(root, 'apps/web/scripts/one.test.mjs');
  write(root, 'apps/docs/scripts/one.test.mjs');

  if (!omitE2e) write(root, 'e2e/tests/one.spec.ts');
  if (!emptyMigrations) write(root, 'apps/api/src/db/migrations/0001_init.sql');
  else mkdirSync(join(root, 'apps/api/src/db/migrations'), { recursive: true });

  write(root, 'vitest.workspace.ts', WORKSPACE);
  write(root, '.github/workflows/ci.yml', CI);
  return root;
}

describe('parseCiJobs', () => {
  it('returns the five gate jobs and ignores keys before `jobs:`', () => {
    expect(parseCiJobs(CI)).toEqual(['checks', 'test-api', 'test-web', 'e2e', 'docker-smoke']);
  });

  it('throws without a `jobs:` line', () => {
    expect(() => parseCiJobs('name: CI\n')).toThrow(/jobs:/);
  });
});

describe('countDockerSmokeAssertions', () => {
  it('counts the Assert steps inside the docker-smoke job', () => {
    expect(countDockerSmokeAssertions(CI)).toBe(2);
  });

  it('throws without a docker-smoke job', () => {
    expect(() => countDockerSmokeAssertions('jobs:\n  checks:\n')).toThrow(/docker-smoke/);
  });
});

describe('checkWorkspaceSync', () => {
  it('passes when the names and paths line up', () => {
    expect(() => checkWorkspaceSync(WORKSPACE, PROJECTS)).not.toThrow();
  });

  it('throws when a project name is missing from the workspace text', () => {
    const missingWeb = WORKSPACE.replace("name: 'web' ", "name: 'renamed-web' ");
    expect(() => checkWorkspaceSync(missingWeb, PROJECTS)).toThrow(/drift/);
  });

  it('throws when an excluded path is absent verbatim', () => {
    // The path appears in both the api exclude and the migrations include, so
    // replace every copy — otherwise the second one keeps the check passing.
    const noExclude = WORKSPACE.replaceAll(MIGRATION_TESTS[0], 'src/db/other.test.ts');
    expect(() => checkWorkspaceSync(noExclude, PROJECTS)).toThrow(/verbatim/);
  });
});

describe('collectFigures', () => {
  it('counts every figure over a good fixture', () => {
    const figures = collectFigures(makeRepo());

    expect(figures.generator).toBe('apps/docs/scripts/gen-how-its-built.mjs');
    expect(figures.vitestProjects).toHaveLength(6);

    const byName = Object.fromEntries(figures.vitestProjects.map((p) => [p.name, p.testFiles]));
    expect(byName).toEqual({
      shared: 1,
      api: 1,
      migrations: 3,
      web: 1,
      'web-scripts': 1,
      'docs-scripts': 1,
    });
    expect(figures.testFilesTotal).toBe(8);
    expect(figures.e2eSpecFiles).toBe(1);
    expect(figures.migrations).toBe(1);
    expect(figures.ciJobs).toEqual(['checks', 'test-api', 'test-web', 'e2e', 'docker-smoke']);
    expect(figures.dockerSmokeAssertions).toBe(2);
  });

  it('throws when e2e/tests is missing', () => {
    expect(() => collectFigures(makeRepo({ omitE2e: true }))).toThrow();
  });

  it('throws when the migrations directory is empty', () => {
    expect(() => collectFigures(makeRepo({ emptyMigrations: true }))).toThrow();
  });

  it('throws when a workspace project name has drifted', () => {
    const root = makeRepo();
    write(root, 'vitest.workspace.ts', WORKSPACE.replace("name: 'web' ", "name: 'renamed-web' "));
    expect(() => collectFigures(root)).toThrow(/drift/);
  });
});

describe('renderFigures', () => {
  it('is byte-identical on a repeat and ends in a newline', () => {
    const figures = collectFigures(makeRepo());
    const first = renderFigures(figures);
    const second = renderFigures(figures);
    expect(first).toBe(second);
    expect(first.endsWith('}\n')).toBe(true);
  });

  it('orders keys as the data model specifies', () => {
    const rendered = renderFigures(collectFigures(makeRepo()));
    expect(Object.keys(JSON.parse(rendered))).toEqual([
      'generator',
      'vitestProjects',
      'testFilesTotal',
      'e2eSpecFiles',
      'migrations',
      'ciJobs',
      'dockerSmokeAssertions',
    ]);
  });
});

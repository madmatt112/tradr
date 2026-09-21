#!/usr/bin/env node
// Generates the figures the "How it's built" page shows, from the repository
// itself rather than from prose typed by hand.
//
// Every number on that page — the test-file counts per vitest project, the
// Playwright spec count, the migration count, the CI jobs that block a merge and
// the docker-smoke assertions — is read here and written to a JSON the page
// imports. A figure quoted in prose drifts the moment the code changes; a figure
// read from the tree cannot.
//
// The generator fails loud on a stale parse: a missing root or file, any count
// of zero, a CI job list missing one of the merge gates, or a vitest.workspace.ts
// that no longer matches the PROJECTS table below. The CI drift gate
// (regenerate, then `git diff --exit-code`) then catches the change.
//
// Usage: node scripts/gen-how-its-built.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The vitest projects, in workspace order. Each entry names one project this
 * generator counts test files for. A directory-walk entry names a `root` and a
 * `suffixes` list (and, for `api`, an `exclude` array); the fixed-list
 * `migrations` entry names `files` instead, so the three excluded files are
 * counted once, under `migrations`, and never again under `api`.
 *
 * The `api` entry's `exclude` array and the `migrations` entry's `files` array
 * are the same three paths the real workspace config carries (vitest.workspace.ts
 * — the `api` project's `exclude` and the `migrations` project's `include`).
 * `checkWorkspaceSync` fails if that stops being true.
 */
export const PROJECTS = [
  { name: 'shared', root: 'packages/shared/src', suffixes: ['.test.ts'] },
  {
    name: 'api',
    root: 'apps/api',
    suffixes: ['.test.ts'],
    exclude: [
      'src/db/migrate.test.ts',
      'src/db/accounting.migration.test.ts',
      'src/db/expenses.migration.test.ts',
    ],
  },
  {
    name: 'migrations',
    root: 'apps/api',
    files: [
      'src/db/migrate.test.ts',
      'src/db/accounting.migration.test.ts',
      'src/db/expenses.migration.test.ts',
    ],
  },
  { name: 'web', root: 'apps/web/src', suffixes: ['.test.ts', '.test.tsx'] },
  { name: 'web-scripts', root: 'apps/web/scripts', suffixes: ['.test.ts', '.test.mjs'] },
  { name: 'docs-scripts', root: 'apps/docs/scripts', suffixes: ['.test.mjs'] },
];

/** The CI jobs that must gate a merge; a missing one is a stale parse. */
export const REQUIRED_JOBS = ['checks', 'test-api', 'test-web', 'e2e', 'docker-smoke'];

/**
 * Throw unless the set of `name: '...'` values in vitest.workspace.ts equals the
 * PROJECTS names and every `exclude`/`files` path appears verbatim in the file.
 * A rename or an added/removed project must be reflected in PROJECTS and the page
 * in the same change.
 */
export function checkWorkspaceSync(workspaceText, projects) {
  const found = new Set();
  for (const [, name] of workspaceText.matchAll(/name:\s*'([^']+)'/g)) found.add(name);
  const expected = new Set(projects.map((p) => p.name));
  const missing = [...expected].filter((n) => !found.has(n));
  const unexpected = [...found].filter((n) => !expected.has(n));
  if (missing.length || unexpected.length) {
    throw new Error(
      `gen-how-its-built: vitest.workspace.ts project drift — missing [${missing.join(', ')}], ` +
        `unexpected [${unexpected.join(', ')}]. Update PROJECTS and the "How it's built" page together.`,
    );
  }
  for (const p of projects) {
    for (const path of p.exclude ?? p.files ?? []) {
      if (!workspaceText.includes(path)) {
        throw new Error(
          `gen-how-its-built: "${path}" from project "${p.name}" is not in vitest.workspace.ts verbatim`,
        );
      }
    }
  }
}

/** The two-space job keys after the `jobs:` line in a workflow file. */
export function parseCiJobs(ciText) {
  const lines = ciText.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start === -1) throw new Error('gen-how-its-built: no `jobs:` line in ci.yml');
  const jobs = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^  ([a-z][a-z0-9-]*):$/);
    if (m) jobs.push(m[1]);
  }
  return jobs;
}

/** Count the `Assert … (x)` step names inside the docker-smoke job. */
export function countDockerSmokeAssertions(ciText) {
  const lines = ciText.split('\n');
  const start = lines.findIndex((l) => /^  docker-smoke:\s*$/.test(l));
  if (start === -1) throw new Error('gen-how-its-built: no `docker-smoke:` job in ci.yml');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [a-z][a-z0-9-]*:$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  let count = 0;
  for (let i = start + 1; i < end; i++) {
    if (/^\s+- name: Assert .*\([a-z]\)$/.test(lines[i])) count++;
  }
  return count;
}

/** Count matching test files under a directory-walk project's root. */
function countWalkedFiles(root, project) {
  if (!existsSync(root)) throw new Error(`gen-how-its-built: root missing: ${root}`);
  const exclude = new Set(project.exclude ?? []);
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const parent = entry.parentPath ?? entry.path;
    const rel = relative(root, join(parent, entry.name)).split('\\').join('/');
    const segments = rel.split('/');
    if (segments.includes('node_modules') || segments.includes('dist')) continue;
    if (!project.suffixes.some((s) => entry.name.endsWith(s))) continue;
    if (exclude.has(rel)) continue;
    count++;
  }
  return count;
}

/** The fixed-list `migrations` project: verify each file exists, count them. */
function countFixedFiles(root, project) {
  for (const f of project.files) {
    const full = join(root, f);
    if (!existsSync(full)) throw new Error(`gen-how-its-built: file missing: ${full}`);
  }
  return project.files.length;
}

/** Count files matching a suffix directly under a directory (not recursive). */
function countDirectFiles(dir, suffix) {
  if (!existsSync(dir)) throw new Error(`gen-how-its-built: root missing: ${dir}`);
  return readdirSync(dir, { withFileTypes: true }).filter(
    (e) => e.isFile() && e.name.endsWith(suffix),
  ).length;
}

/** Read every figure the page shows from the tree rooted at `repoRoot`. */
export function collectFigures(repoRoot) {
  const vitestProjects = PROJECTS.map((project) => {
    const root = join(repoRoot, project.root);
    const testFiles = project.files
      ? countFixedFiles(root, project)
      : countWalkedFiles(root, project);
    if (testFiles === 0) {
      throw new Error(
        `gen-how-its-built: project "${project.name}" matched no test files under ${root}`,
      );
    }
    return { name: project.name, testFiles };
  });
  const testFilesTotal = vitestProjects.reduce((sum, p) => sum + p.testFiles, 0);

  const e2eSpecFiles = countDirectFiles(join(repoRoot, 'e2e/tests'), '.spec.ts');
  if (e2eSpecFiles === 0) throw new Error('gen-how-its-built: no *.spec.ts under e2e/tests');

  const migrations = countDirectFiles(join(repoRoot, 'apps/api/src/db/migrations'), '.sql');
  if (migrations === 0)
    throw new Error('gen-how-its-built: no *.sql under apps/api/src/db/migrations');

  const workspaceText = readFileSync(join(repoRoot, 'vitest.workspace.ts'), 'utf8');
  checkWorkspaceSync(workspaceText, PROJECTS);

  const ciText = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const ciJobs = parseCiJobs(ciText);
  for (const job of REQUIRED_JOBS) {
    if (!ciJobs.includes(job))
      throw new Error(`gen-how-its-built: ci.yml is missing the "${job}" job`);
  }
  const dockerSmokeAssertions = countDockerSmokeAssertions(ciText);
  if (dockerSmokeAssertions === 0) {
    throw new Error('gen-how-its-built: no docker-smoke Assert steps found in ci.yml');
  }

  return {
    generator: 'apps/docs/scripts/gen-how-its-built.mjs',
    vitestProjects,
    testFilesTotal,
    e2eSpecFiles,
    migrations,
    ciJobs,
    dockerSmokeAssertions,
  };
}

/** Serialize the figures with a fixed key order and no timestamp. */
export function renderFigures(figures) {
  const ordered = {
    generator: figures.generator,
    vitestProjects: figures.vitestProjects,
    testFilesTotal: figures.testFilesTotal,
    e2eSpecFiles: figures.e2eSpecFiles,
    migrations: figures.migrations,
    ciJobs: figures.ciJobs,
    dockerSmokeAssertions: figures.dockerSmokeAssertions,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '../../..');
const OUT = join(scriptDir, '../src/content/docs/self-hosting/explanation/_how-its-built.json');

function main() {
  const figures = collectFigures(repoRoot);
  writeFileSync(OUT, renderFigures(figures));
  console.log(
    `gen-how-its-built: wrote ${OUT} (${figures.vitestProjects.length} projects, ${figures.testFilesTotal} test files).`,
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

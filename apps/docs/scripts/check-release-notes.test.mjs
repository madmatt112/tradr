// Release-notes gate tests (trust-pages Component 6, requirement 4.6).
//
// The gate script lives at the repo root (dependency-free ESM); import it by
// relative path, the precedent being apps/api/src/db/backup-restore-check.test.ts
// importing scripts/backup-restore-check.mjs. Each case builds a throwaway git
// repository under a mkdtemp directory with execFileSync('git', ...) — the tests
// never read the real history — copies the real TEMPLATE.md into the fixture's
// docs/release-notes, and runs runCheck against it. CI runners carry no git
// identity, so every commit sets its own author and committer env.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { runCheck, validateNotes } from '../../../scripts/check-release-notes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const TEMPLATE = readFileSync(join(REPO_ROOT, 'docs/release-notes/TEMPLATE.md'), 'utf8');

// A committer identity for a runner that has none (design R1-2).
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Release Test',
  GIT_AUTHOR_EMAIL: 'release-test@example.com',
  GIT_COMMITTER_NAME: 'Release Test',
  GIT_COMMITTER_EMAIL: 'release-test@example.com',
};

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' });
}

/** A fresh repo with TEMPLATE.md copied into docs/release-notes. */
function newRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'check-release-notes-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'docs/release-notes'), { recursive: true });
  writeFileSync(join(dir, 'docs/release-notes/TEMPLATE.md'), TEMPLATE);
  return dir;
}

// A monotonic counter so each commit touches a distinct file — a commit with no
// staged change would make `git commit` fail with "nothing to commit".
let seq = 0;

/** Touch a unique file, stage everything, and commit (subject + optional body). */
function commit(dir, subject, body) {
  writeFileSync(join(dir, `change-${(seq += 1)}.txt`), `${subject}\n`);
  git(dir, 'add', '-A');
  const args = ['-c', 'commit.gpgsign=false', 'commit', '-m', subject];
  if (body) args.push('-m', body);
  git(dir, ...args);
}

function tag(dir, name) {
  git(dir, '-c', 'tag.gpgsign=false', 'tag', name);
}

describe('runCheck — minor tags', () => {
  it('passes a minor with a valid notes file', () => {
    const dir = newRepo();
    writeFileSync(
      join(dir, 'docs/release-notes/v0.16.0.md'),
      'Tradr v0.16.0 tidies up the ledger.\n\nA short paragraph of prose that a reader would understand.\n',
    );
    commit(dir, 'chore(release): v0.16.0');
    tag(dir, 'v0.16.0');
    const result = runCheck({ tag: 'v0.16.0', repoRoot: dir });
    expect(result.kind).toBe('minor');
    expect(result.reasons).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('fails a minor with no notes file', () => {
    const dir = newRepo();
    commit(dir, 'feat: something');
    tag(dir, 'v0.16.0');
    const result = runCheck({ tag: 'v0.16.0', repoRoot: dir });
    expect(result.ok).toBe(false);
    expect(result.reasons.join('\n')).toContain('docs/release-notes/v0.16.0.md');
  });

  it('fails a minor whose notes file is the unedited template', () => {
    const dir = newRepo();
    writeFileSync(join(dir, 'docs/release-notes/v0.16.0.md'), TEMPLATE);
    commit(dir, 'chore(release): v0.16.0');
    tag(dir, 'v0.16.0');
    const result = runCheck({ tag: 'v0.16.0', repoRoot: dir });
    expect(result.ok).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});

describe('runCheck — patch tags', () => {
  it('passes a patch with no notes file and no breaking marker', () => {
    const dir = newRepo();
    commit(dir, 'chore(release): v0.15.0');
    tag(dir, 'v0.15.0');
    commit(dir, 'fix: a small bug');
    tag(dir, 'v0.15.1');
    const result = runCheck({ tag: 'v0.15.1', repoRoot: dir });
    expect(result.kind).toBe('patch');
    expect(result.ok).toBe(true);
  });

  it('fails a patch whose range carries a feat!: subject', () => {
    const dir = newRepo();
    commit(dir, 'chore(release): v0.15.0');
    tag(dir, 'v0.15.0');
    commit(dir, 'feat!: drop the legacy endpoint');
    tag(dir, 'v0.15.1');
    const result = runCheck({ tag: 'v0.15.1', repoRoot: dir });
    expect(result.ok).toBe(false);
    expect(result.reasons.join('\n')).toContain('drop the legacy endpoint');
  });

  it('fails a patch whose range carries a BREAKING CHANGE: footer', () => {
    const dir = newRepo();
    commit(dir, 'chore(release): v0.15.0');
    tag(dir, 'v0.15.0');
    commit(dir, 'feat: rename a config key', 'BREAKING CHANGE: FOO is now BAR; set the new key.');
    tag(dir, 'v0.15.1');
    const result = runCheck({ tag: 'v0.15.1', repoRoot: dir });
    expect(result.ok).toBe(false);
    expect(result.reasons.join('\n')).toContain('breaking marker');
  });
});

describe('validateNotes', () => {
  it('accepts the real v0.15.0 notes', () => {
    const notes = readFileSync(join(REPO_ROOT, 'docs/release-notes/v0.15.0.md'), 'utf8');
    expect(validateNotes(notes, TEMPLATE)).toEqual({ ok: true, reasons: [] });
  });
});

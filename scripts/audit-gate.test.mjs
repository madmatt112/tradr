// Red-phase tests for the dependency audit gate (security-hardening, task 23).
//
// Seam: the gate is a standalone CLI (design C13), so every test spawns
// `node scripts/audit-gate.mjs <args>` and observes only its exit code and
// stdout — nothing inside the module is mocked or imported directly.
//
// Fixtures (scripts/audit-gate/fixtures/{vulnerable,clean}/) were recorded
// once, outside this repo, with the real `pnpm audit --prod --json` against a
// throwaway project pinning only `tar`:
//   - vulnerable/ pins tar@6.2.1 (deps: chownr, fs-minipass, minipass,
//     minizlib, mkdirp, yallist) and its audit-report.json carries 9 real
//     high/critical advisories for that pin, including GHSA-34x7-hfp2-rc4v
//     (design C13's named example).
//   - clean/ pins tar@7.5.22 and its audit-report.json carries zero
//     advisories (verified empty when recorded).
// Both pnpm-lock.yaml files are real pnpm 9 lockfileVersion '9.0' output;
// they are test input only and are never installed.
//
// Contract (one block per success criterion the task cites):
//
// 1) Req 8.1 — fails on a high/critical production advisory.
//    Pre-condition: the vulnerable fixture's report carries
//      GHSA-34x7-hfp2-rc4v at severity "high", matching its lockfile.
//    Call: run the gate with --report/--lockfile pointed at the vulnerable
//      fixture, no --allowlist.
//    Observable result: exit code 1; stdout names GHSA-34x7-hfp2-rc4v.
//    Source of expected value: design C13 ("exits 1 naming each unlisted
//      advisory") and the fixture's own audit-report.json.
//
// 2) Req 8.3 — passes on a clean fixture.
//    Pre-condition: the clean fixture's report carries zero advisories.
//    Call: run the gate with --report/--lockfile pointed at the clean
//      fixture.
//    Observable result: exit code 0.
//    Source of expected value: requirements.md 8.3 ("passing on a clean
//      fixture").
//
// 3) Req 8.2 — a listed advisory, not yet due, does not fail the job.
//    Pre-condition: every high/critical id in the vulnerable fixture's
//      report is allow-listed with a reviewBy after --today.
//    Call: run the gate on the vulnerable fixture with that --allowlist and
//      --today 2026-10-11.
//    Observable result: exit code 0.
//    Source of expected value: requirements.md 8.2 ("a listed advisory
//      SHALL fail the job once its date passes" — the converse holds before
//      it passes) and design C13's `--allowlist`/`--today` interface.
//
// 4) Req 8.2 — a listed advisory past its reviewBy still fails the job.
//    Pre-condition: same allow-list as (3), except GHSA-34x7-hfp2-rc4v's
//      reviewBy is before --today.
//    Call: run the gate on the vulnerable fixture with that --allowlist and
//      --today 2026-10-11.
//    Observable result: exit code 1; stdout names GHSA-34x7-hfp2-rc4v.
//    Source of expected value: requirements.md 8.2, verbatim.
//
// 5) Req 8.1 — the gate reads the lockfile, not just the report.
//    Pre-condition: the vulnerable fixture's report names tar@6.2.1, which
//      is absent from the clean fixture's lockfile (it pins tar@7.5.22).
//    Call: run the gate with --report from the vulnerable fixture and
//      --lockfile from the clean fixture.
//    Observable result: exit code 2.
//    Source of expected value: design C13 ("2 on unparsable input or, with
//      --report, a finding name@version absent from the lockfile").
//
// Fold note: requirements.md 8.3's offline clause ("a live advisory-database
// change cannot alter its result") has no separate case here. Every case
// above passes --report and --lockfile, which design C13 states is the only
// path that skips `pnpm audit`/live lookup entirely; there is no way to
// assert "no network call" at this seam without mocking a node: builtin the
// gate has not been built to use yet, which the brief forbids. Recorded as a
// fold onto cases (1)-(5): they are already incapable of reaching a network
// call because they never omit --report.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(scriptsDir, 'audit-gate.mjs');
const fixturesDir = join(scriptsDir, 'audit-gate', 'fixtures');

const vulnerable = {
  report: join(fixturesDir, 'vulnerable', 'audit-report.json'),
  lockfile: join(fixturesDir, 'vulnerable', 'pnpm-lock.yaml'),
};
const clean = {
  report: join(fixturesDir, 'clean', 'audit-report.json'),
  lockfile: join(fixturesDir, 'clean', 'pnpm-lock.yaml'),
};

const TODAY = '2026-10-11';
const HEADLINE_ID = 'GHSA-34x7-hfp2-rc4v';

/** Every github_advisory_id in the vulnerable fixture's report at high or
 * critical severity, read from the fixture itself so the allow-list in
 * cases (3) and (4) always covers exactly what the fixture reports. */
function vulnerableHighCriticalIds() {
  const report = JSON.parse(readFileSync(vulnerable.report, 'utf8'));
  return Object.values(report.advisories)
    .filter((a) => a.severity === 'high' || a.severity === 'critical')
    .map((a) => a.github_advisory_id);
}

function runGate(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
  });
}

/** Writes a temporary allow-list file and returns its path. `pastDueId`, if
 * given, gets a reviewBy before TODAY; every other id gets one after it. */
function writeAllowlist(ids, pastDueId) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-gate-allowlist-'));
  const path = join(dir, 'audit-allowlist.json');
  const entries = ids.map((id) => ({
    id,
    reason: 'fixture entry for the audit-gate red tests',
    reviewBy: id === pastDueId ? '2020-01-01' : '2099-01-01',
  }));
  writeFileSync(path, JSON.stringify(entries, null, 2));
  return { path, dir };
}

test('vulnerable fixture, no allow-list: exits 1 naming the GHSA (Req 8.1)', () => {
  const result = runGate(['--report', vulnerable.report, '--lockfile', vulnerable.lockfile]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, new RegExp(HEADLINE_ID));
});

test('clean fixture: exits 0 (Req 8.3)', () => {
  const result = runGate(['--report', clean.report, '--lockfile', clean.lockfile]);
  assert.equal(result.status, 0);
});

test('vulnerable fixture, every advisory allow-listed with a future reviewBy: exits 0 (Req 8.2)', () => {
  const { path, dir } = writeAllowlist(vulnerableHighCriticalIds(), null);
  try {
    const result = runGate([
      '--report',
      vulnerable.report,
      '--lockfile',
      vulnerable.lockfile,
      '--allowlist',
      path,
      '--today',
      TODAY,
    ]);
    assert.equal(result.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vulnerable fixture, the allow-listed GHSA is past its reviewBy: exits 1 naming it (Req 8.2)', () => {
  const { path, dir } = writeAllowlist(vulnerableHighCriticalIds(), HEADLINE_ID);
  try {
    const result = runGate([
      '--report',
      vulnerable.report,
      '--lockfile',
      vulnerable.lockfile,
      '--allowlist',
      path,
      '--today',
      TODAY,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, new RegExp(HEADLINE_ID));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('report finding absent from the given lockfile: exits 2 (Req 8.1)', () => {
  const result = runGate(['--report', vulnerable.report, '--lockfile', clean.lockfile]);
  assert.equal(result.status, 2);
});

#!/usr/bin/env node
// Dependency audit gate (security-hardening, design C13, requirement 8).
//
// A dated allow-list gate over pnpm's own advisory report. It keeps only
// `high` and `critical` production advisories, matches each one's
// `github_advisory_id` against a committed allow-list, and fails CI on any
// advisory that is neither upgraded away nor listed with a future review-by
// date.
//
//   node scripts/audit-gate.mjs [--report FILE --lockfile FILE] \
//                               [--allowlist FILE] [--today YYYY-MM-DD]
//
// Without `--report` it runs `pnpm audit --prod --json` and parses stdout,
// ignoring pnpm's own (non-zero) exit code. With `--report` it reads the
// report from the file instead, so the test suite runs offline against a
// pinned snapshot (requirement 8.3).
//
// Allow-list (`audit-allowlist.json` at the repo root):
//   [{ "id": "GHSA-…", "reason": "…", "reviewBy": "YYYY-MM-DD" }]
// A listed advisory stops failing the job until its `reviewBy` date passes;
// on and after that date it fails again (requirement 8.2). `--today` pins the
// comparison date (default: the system date) so the behaviour is testable.
//
// Exit codes:
//   0  no blocking high/critical production advisory
//   1  one or more blocking advisories (each named on stdout): an advisory not
//      in the allow-list, or a listed advisory whose reviewBy has passed
//   2  unparsable input, bad usage, or — with --report and --lockfile — a
//      report finding `name@version` that is absent from the lockfile (the
//      report does not match the lockfile it was paired with)
//
// Dependency-free ESM (Node builtins only, design D9/D10) so it runs from the
// repo root with no workspace module resolution.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Extract the `name@version` package keys from a pnpm v9 lockfile without a
 * YAML dependency. Reads only the top-level `packages:` block; each entry key
 * is at two-space indent and ends with a colon, optionally quoted (scoped
 * packages) and optionally carrying a `(peer@ver)` suffix that is dropped.
 */
export function parseLockfilePackages(text) {
  const packages = new Set();
  let inPackages = false;
  for (const line of text.split('\n')) {
    // A top-level section header: no indent, ends with a bare colon.
    if (/^[^\s].*:\s*$/.test(line)) {
      inPackages = line.trimEnd() === 'packages:';
      continue;
    }
    if (!inPackages) continue;
    const m = /^ {2}('[^']+'|[^\s:][^:]*):\s*$/.exec(line);
    if (!m) continue;
    let key = m[1];
    if (key.startsWith("'") && key.endsWith("'")) key = key.slice(1, -1);
    const paren = key.indexOf('(');
    if (paren !== -1) key = key.slice(0, paren);
    packages.add(key);
  }
  return packages;
}

/**
 * True when a listed advisory no longer protects the build: its `reviewBy`
 * date has passed relative to `today`, or the date is missing/malformed.
 * ISO `YYYY-MM-DD` strings compare correctly with `<`.
 */
export function reviewByPassed(reviewBy, today) {
  if (typeof reviewBy !== 'string' || !ISO_DATE.test(reviewBy)) return true;
  return reviewBy < today;
}

/** Read and JSON-parse the audit report, or run `pnpm audit` for a live one. */
function loadReport(reportPath) {
  let raw;
  if (reportPath) {
    raw = readFileSync(reportPath, 'utf8');
  } else {
    const res = spawnSync('pnpm', ['audit', '--prod', '--json'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    // pnpm exits non-zero whenever it finds advisories; the report is the
    // source of truth, so its exit code is deliberately ignored.
    raw = res.stdout ?? '';
  }
  const report = JSON.parse(raw);
  if (
    !report ||
    typeof report !== 'object' ||
    !report.advisories ||
    typeof report.advisories !== 'object'
  ) {
    throw new Error('report is missing an advisories object');
  }
  return report;
}

function fail2(message) {
  process.stderr.write(`audit-gate: ${message}\n`);
  return 2;
}

function run(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        report: { type: 'string' },
        lockfile: { type: 'string' },
        allowlist: { type: 'string' },
        today: { type: 'string' },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    return fail2(err.message);
  }

  const today = values.today ?? new Date().toISOString().slice(0, 10);
  if (!ISO_DATE.test(today)) return fail2(`--today must be YYYY-MM-DD, got "${today}"`);

  let report;
  try {
    report = loadReport(values.report);
  } catch (err) {
    return fail2(`could not parse the audit report: ${err.message}`);
  }

  // Keep only production high/critical advisories — the gate's whole concern.
  const serious = Object.values(report.advisories).filter(
    (a) => a && (a.severity === 'high' || a.severity === 'critical'),
  );

  // With --report and --lockfile, confirm every serious finding's name@version
  // is actually in the paired lockfile; a mismatch means the report does not
  // describe this lockfile and the result would be meaningless.
  if (values.report && values.lockfile) {
    let pkgs;
    try {
      pkgs = parseLockfilePackages(readFileSync(values.lockfile, 'utf8'));
    } catch (err) {
      return fail2(`could not read the lockfile: ${err.message}`);
    }
    for (const a of serious) {
      for (const finding of a.findings ?? []) {
        const nv = `${a.module_name}@${finding.version}`;
        if (!pkgs.has(nv)) {
          return fail2(
            `${nv} (advisory ${a.github_advisory_id}) is absent from ${values.lockfile}`,
          );
        }
      }
    }
  }

  // Load the allow-list.
  let allowlist = [];
  if (values.allowlist) {
    try {
      allowlist = JSON.parse(readFileSync(values.allowlist, 'utf8'));
    } catch (err) {
      return fail2(`could not parse the allow-list: ${err.message}`);
    }
    if (!Array.isArray(allowlist)) return fail2('allow-list must be a JSON array');
  }
  const byId = new Map(allowlist.map((e) => [e.id, e]));

  const failures = [];
  for (const a of serious) {
    const id = a.github_advisory_id;
    const where = `${a.module_name}@${a.findings?.[0]?.version ?? '?'}`;
    const entry = byId.get(id);
    if (!entry) {
      failures.push(
        `FAIL ${id} (${a.severity}) ${where} — not in the allow-list — ${a.title ?? ''}`.trimEnd(),
      );
    } else if (reviewByPassed(entry.reviewBy, today)) {
      failures.push(
        `FAIL ${id} (${a.severity}) ${where} — allow-list entry past reviewBy ${entry.reviewBy}`,
      );
    }
  }

  // Allow-list entries that match no current serious advisory: a warning, not
  // a failure, so stale entries surface without breaking the build.
  const seriousIds = new Set(serious.map((a) => a.github_advisory_id));
  for (const entry of allowlist) {
    if (!seriousIds.has(entry.id)) {
      process.stdout.write(
        `WARN allow-list entry ${entry.id} matches no current high/critical advisory\n`,
      );
    }
  }

  if (failures.length > 0) {
    for (const line of failures) process.stdout.write(`${line}\n`);
    process.stdout.write(
      `audit-gate: ${failures.length} blocking high/critical advisor${failures.length === 1 ? 'y' : 'ies'}\n`,
    );
    return 1;
  }
  process.stdout.write('audit-gate: no blocking high/critical production advisories\n');
  return 0;
}

process.exit(run(process.argv.slice(2)));

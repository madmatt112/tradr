#!/usr/bin/env node
// Release-notes gate (trust-pages Component 6, requirement 4).
//
// Given a version tag, refuses a MINOR release (`vX.Y.0`) that has no
// hand-written notes at `docs/release-notes/<tag>.md`, and refuses a PATCH
// release (`vX.Y.Z`, Z != 0) that carries an undeclared breaking change in its
// commit range. A minor with a valid notes file passes; a patch needs no file.
//
//   node scripts/check-release-notes.mjs <tag> [--pre-flight]
//
// Without `--pre-flight` the tag must already be a ref (the release.yml gate runs
// on a tag push); the endpoint of the scanned range is the tag. With
// `--pre-flight` the tag must NOT yet exist (the `make release` pre-check, before
// it commits and tags); the endpoint is HEAD, the tip the release commit builds
// on. Pre-flight is an explicit flag, never auto-detected (design D10), so a
// stale local tag can never make the check scan the wrong range silently.
//
// Exit 0 pass, 1 fail (one reason per line), 2 usage.
//
// Dependency-free ESM (Node builtins only) so it runs from the repo root without
// workspace module resolution; the placeholder tokens are read from TEMPLATE.md
// at check time (design D11) so a template edit tracks itself.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Classify a tag by its patch component: `'minor'` for `vX.Y.0`, `'patch'` for
 * any other `vX.Y.Z`, `null` for anything that is not a `vMAJOR.MINOR.PATCH` tag.
 */
export function classifyTag(tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag ?? '');
  if (!m) return null;
  return Number(m[3]) === 0 ? 'minor' : 'patch';
}

/**
 * Validate notes `content` against the `templateContent` it was copied from.
 * Returns `{ ok, reasons }`. Valid when the trimmed content is non-empty, its
 * first non-blank line is prose (not a `#` heading), and it contains none of:
 * any `/<[^<>]+>/g` run from the template (its placeholders), the literal
 * `vX.Y.Z`, or the string `<!--` (an HTML comment). No section is required.
 */
export function validateNotes(content, templateContent) {
  const reasons = [];
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    reasons.push('the notes file is empty');
    return { ok: false, reasons };
  }
  const firstLine = trimmed.split('\n')[0].trim();
  if (firstLine.startsWith('#')) {
    reasons.push('the first line is a Markdown heading; write prose, not a heading');
  }
  const leftovers = [];
  for (const token of templateContent.match(/<[^<>]+>/g) ?? []) {
    if (content.includes(token)) leftovers.push(token);
  }
  if (content.includes('vX.Y.Z')) leftovers.push('vX.Y.Z');
  if (content.includes('<!--')) leftovers.push('<!--');
  if (leftovers.length > 0) {
    reasons.push(`the notes still contain unfilled template text: ${leftovers.join(', ')}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** Parse a `vMAJOR.MINOR.PATCH` tag into a numeric `[major, minor, patch]`, or null. */
function parseSemver(tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Numeric semver comparison of two `[major, minor, patch]` tuples. */
function cmpSemver(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * The highest `vMAJOR.MINOR.PATCH` tag in `tags` strictly below `tag` by numeric
 * semver; `null` when none. Non-semver tags are ignored.
 */
export function previousTag(tags, tag) {
  const target = parseSemver(tag);
  if (!target) return null;
  let best = null;
  let bestV = null;
  for (const t of tags) {
    const v = parseSemver(t);
    if (!v || cmpSemver(v, target) >= 0) continue;
    if (bestV === null || cmpSemver(v, bestV) > 0) {
      best = t;
      bestV = v;
    }
  }
  return best;
}

/**
 * The breaking commits among `{ sha, subject, body }` records: a subject with the
 * Conventional-Commit `!` marker before its colon, or a body containing
 * `BREAKING CHANGE:` (docs/versioning.md).
 */
export function findBreakingMarkers(commits) {
  const bangSubject = /^[a-z]+(\([^)]*\))?!:/;
  return commits.filter(
    (c) => bangSubject.test(c.subject) || (c.body ?? '').includes('BREAKING CHANGE:'),
  );
}

/**
 * Parse `git log --format=%H%x00%s%x00%b%x1e` output into `{ sha, subject, body }`
 * records. Fields are NUL-separated; records are RS-separated (`\x1e`), each
 * followed by the newline git prints, which the leading-whitespace strip removes.
 */
function parseCommits(stdout) {
  return String(stdout)
    .split('\x1e')
    .map((r) => r.replace(/^\s+/, ''))
    .filter((r) => r.length > 0)
    .map((record) => {
      const [sha = '', subject = '', body = ''] = record.split('\x00');
      return { sha: sha.trim(), subject, body };
    });
}

/** True when `refs/tags/<tag>` resolves in the repository at `repoRoot`. */
function tagExists(repoRoot, tag) {
  const res = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return res.status === 0;
}

/** Every tag name in the repository at `repoRoot`. */
function listTags(repoRoot) {
  const res = spawnSync('git', ['tag', '--list'], { cwd: repoRoot, encoding: 'utf8' });
  if (res.status !== 0) return [];
  return res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `git log` over `range` in NUL/RS record format; throws on a git failure. */
function gitLog(repoRoot, range) {
  const args = ['log', '--format=%H%x00%s%x00%b%x1e'];
  if (range) args.push(range);
  const res = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git log ${range} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

/**
 * Run the gate for one `tag` against the repository at `repoRoot`.
 * Returns `{ ok, kind, range, reasons }`.
 */
export function runCheck({ tag, repoRoot, preFlight = false }) {
  const kind = classifyTag(tag);
  if (kind === null) {
    return { ok: false, kind: null, range: '', reasons: [`"${tag}" is not a vX.Y.Z tag`] };
  }

  let endpoint;
  if (preFlight) {
    if (tagExists(repoRoot, tag)) {
      return {
        ok: false,
        kind,
        range: '',
        reasons: [`tag ${tag} already exists — make release will not re-tag an existing version`],
      };
    }
    endpoint = 'HEAD';
  } else {
    if (!tagExists(repoRoot, tag)) {
      return {
        ok: false,
        kind,
        range: '',
        reasons: [
          `tag ${tag} is not a ref in this checkout — the release-notes gate needs actions/checkout with fetch-depth: 0 and fetch-tags: true`,
        ],
      };
    }
    endpoint = tag;
  }

  const prev = previousTag(listTags(repoRoot), tag);
  const range = prev ? `${prev}..${endpoint}` : endpoint;
  const reasons = [];

  if (kind === 'minor') {
    const notesPath = join(repoRoot, 'docs/release-notes', `${tag}.md`);
    if (!existsSync(notesPath)) {
      reasons.push(
        `docs/release-notes/${tag}.md is missing — a minor release needs hand-written notes`,
      );
    } else {
      const templateContent = readFileSync(
        join(repoRoot, 'docs/release-notes/TEMPLATE.md'),
        'utf8',
      );
      const result = validateNotes(readFileSync(notesPath, 'utf8'), templateContent);
      for (const r of result.reasons) reasons.push(`docs/release-notes/${tag}.md: ${r}`);
    }
  } else {
    const commits = parseCommits(gitLog(repoRoot, range));
    for (const c of findBreakingMarkers(commits)) {
      reasons.push(
        `breaking marker in ${c.sha.slice(0, 8)} ${c.subject} — re-cut this as a minor tag with a notes file`,
      );
    }
  }

  return { ok: reasons.length === 0, kind, range, reasons };
}

// --- Entry point ------------------------------------------------------------

const USAGE = 'Usage: node scripts/check-release-notes.mjs <tag> [--pre-flight]';

function main(argv, repoRoot) {
  const args = argv.slice(2);
  const positionals = args.filter((a) => !a.startsWith('-'));
  const unknownFlags = args.filter((a) => a.startsWith('-') && a !== '--pre-flight');
  if (positionals.length !== 1 || unknownFlags.length > 0) {
    console.error(USAGE);
    return 2;
  }
  const tag = positionals[0];
  if (classifyTag(tag) === null) {
    console.error(`${USAGE}\n"${tag}" is not a vX.Y.Z tag.`);
    return 2;
  }
  const result = runCheck({ tag, repoRoot, preFlight: args.includes('--pre-flight') });
  if (!result.ok) {
    for (const r of result.reasons) console.error(r);
    return 1;
  }
  console.log(
    `release-notes gate: ${tag} (${result.kind}) OK${result.range ? ` over ${result.range}` : ''}`,
  );
  return 0;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(main(process.argv, resolve(scriptDir, '..')));
}

#!/usr/bin/env node
// Generates the environment-variable reference from `.env.example`.
//
// `.env.example` is the only place the full configuration surface is written
// down, and it is the file operators actually copy. Transcribing it into a docs
// page by hand guarantees the two drift — the page this replaced documented
// roughly half the keys. So the page is generated and a CI drift gate keeps it
// honest, the same pattern as the OpenAPI reference.
//
// TWO SYNTAXES, both load-bearing:
//
//   KEY=value        a key the template ships active, with its default
//   # KEY=value      an OPTIONAL key, shipped commented out
//
// The commented form is not decoration — it is how every all-or-nothing
// integration (SMTP, object storage) is presented, and half the surface uses it.
// A generator that only reads the first form documents half the product.
//
// Structure is taken from the file itself: `# ─── Name ───` starts a section,
// and the comment lines immediately above a key are that key's documentation.
//
// Usage: node scripts/gen-env-vars.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '../../..');
const ENV_EXAMPLE = join(repoRoot, '.env.example');
const QUICKSTART = join(repoRoot, 'docker/quickstart.sh');
const OUT = join(scriptDir, '../src/content/docs/self-hosting/reference/env-vars.mdx');

const SECTION_RE = /^#\s*─+\s*(.*?)\s*─+$/;
const LIVE_KEY_RE = /^([A-Z_][A-Z0-9_]*)=(.*)$/;
const COMMENTED_KEY_RE = /^#\s?([A-Z_][A-Z0-9_]*)=(.*)$/;
const COMMENT_RE = /^#\s?(.*)$/;

/**
 * A second `KEY=` on the same line means this is an inline example, not a
 * declaration — e.g.
 *
 *   # SMTP_TLS_MODE=none EMAIL_FROM=dev@tradr.local WEB_BASE_URL=http://…
 *
 * which is a dev-loop recipe. Read as a declaration it produced a duplicate
 * SMTP_TLS_MODE row whose "default" was the rest of the command line.
 */
const INLINE_EXAMPLE_RE = /\s[A-Z_][A-Z0-9_]*=/;

/**
 * The required secrets, derived from `docker/quickstart.sh` rather than guessed.
 *
 * That script generates exactly the values an instance cannot boot without, and
 * the `docker-smoke` CI job runs it, so a fourth required secret cannot be added
 * without this list following. "Uncommented but blank" is NOT the signal — plenty
 * of optional keys (ANTHROPIC_API_KEY, STRIPE_SECRET_KEY) ship that way too.
 */
function requiredSecrets() {
  const src = readFileSync(QUICKSTART, 'utf8');
  const keys = [...src.matchAll(/^\s*([A-Z_][A-Z0-9_]*)="\$\{\1:-\$\(openssl/gm)].map((m) => m[1]);
  if (keys.length === 0) {
    throw new Error('gen-env-vars: found no generated secrets in quickstart.sh — parser is stale');
  }
  return new Set(keys);
}

function parse(source) {
  const sections = [];
  let section = { name: 'General', keys: [] };
  let comment = [];

  for (const raw of source.split('\n')) {
    const line = raw.trimEnd();

    const sectionMatch = line.match(SECTION_RE);
    if (sectionMatch) {
      if (section.keys.length > 0) sections.push(section);
      section = { name: sectionMatch[1], keys: [] };
      comment = [];
      continue;
    }

    const live = line.match(LIVE_KEY_RE);
    if (live) {
      section.keys.push({ name: live[1], value: live[2], commented: false, doc: comment });
      comment = [];
      continue;
    }

    // Must be tested BEFORE the generic comment rule, or `# KEY=value` is read
    // as prose and the optional half of the surface disappears.
    const commented = line.match(COMMENTED_KEY_RE);
    if (commented && !INLINE_EXAMPLE_RE.test(commented[2])) {
      section.keys.push({
        name: commented[1],
        value: commented[2],
        commented: true,
        doc: comment,
      });
      comment = [];
      continue;
    }

    const prose = line.match(COMMENT_RE);
    if (prose) {
      comment.push(prose[1]);
      continue;
    }

    // A blank line ends the comment block it was attached to.
    if (line === '') comment = [];
  }
  if (section.keys.length > 0) sections.push(section);
  return sections;
}

/**
 * Escape a value for a markdown table cell.
 *
 * Backslash FIRST, then the pipe — escaping the pipe first would leave the
 * backslash it introduced to be escaped again, turning `a|b` into `a\\|b` and
 * breaking the column. Newlines would break the row outright, so they collapse
 * to a space.
 */
function cell(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Collapse a key's comment block into one cell, keeping shell recipes as code. */
function describe(doc) {
  const parts = [];
  let recipe = [];
  const flush = () => {
    if (recipe.length > 0) {
      parts.push('`' + recipe.join(' && ') + '`');
      recipe = [];
    }
  };
  for (const line of doc) {
    // Indented lines in this file are always commands to run.
    if (/^\s{2,}\S/.test(line)) {
      recipe.push(line.trim());
      continue;
    }
    flush();
    if (line.trim() !== '') parts.push(line.trim());
  }
  flush();
  return cell(parts.join(' '));
}

function statusOf(key, required) {
  if (required.has(key.name)) return '**Required**';
  if (key.commented) return 'Optional';
  if (key.value === '') return 'Optional';
  return `\`${cell(key.value)}\``;
}

function render(sections, required) {
  const total = sections.reduce((n, s) => n + s.keys.length, 0);
  const optional = sections.reduce(
    (n, s) => n + s.keys.filter((k) => k.commented || k.value === '').length,
    0,
  );

  const out = [];
  out.push('---');
  out.push('title: Environment variables');
  out.push(
    'description: Every environment variable Tradr reads, its default, and what it does — generated from .env.example so it cannot drift from the template you copy.',
  );
  out.push('---');
  out.push('');
  out.push('{/* GENERATED FILE — do not edit.');
  out.push('    Source: .env.example · Generator: apps/docs/scripts/gen-env-vars.mjs');
  out.push('    Run `pnpm --filter @tradr/docs env-vars:generate` after changing .env.example. */}');
  out.push('');
  out.push(
    `Tradr reads **${total} environment variables**, of which **${required.size} are required** —`,
  );
  out.push('everything else has a working default or turns a feature off when unset.');
  out.push('');
  out.push('This page is generated from [`.env.example`](https://github.com/madmatt112/tradr/blob/main/.env.example),');
  out.push('the file you copy to `.env`. CI regenerates it and fails if the two disagree, so it');
  out.push('cannot fall behind the template.');
  out.push('');
  out.push('## Required');
  out.push('');
  out.push('An instance does not start without these three. `docker/quickstart.sh` generates all');
  out.push('of them for you — see [Install with Docker Compose](/self-hosting/docker-compose/).');
  out.push('');
  out.push('| Variable | How to generate one |');
  out.push('| --- | --- |');
  out.push('| `POSTGRES_PASSWORD` | `openssl rand -hex 24` — hex avoids the URL-reserved characters that would corrupt the connection string |');
  out.push('| `SESSION_SECRET` | `openssl rand -base64 24` — signs session cookies, minimum 32 characters |');
  out.push('| `ENCRYPTION_KEY` | `openssl rand -hex 32` — a 32-byte key that encrypts stored provider API keys |');
  out.push('');
  out.push(':::danger[Keep `ENCRYPTION_KEY` with your backups]');
  out.push('A restored database still holds the provider API keys it encrypted. Without the');
  out.push('original `ENCRYPTION_KEY` nothing can decrypt them. See');
  out.push('[Back up and restore](/self-hosting/backup-restore/).');
  out.push(':::');
  out.push('');
  out.push('## Reading the tables');
  out.push('');
  out.push(`Of the ${total} variables, **${optional} ship unset** — either commented out in the`);
  out.push('template or present with an empty value. An unset optional variable means the feature');
  out.push('is **absent, not broken**: nothing logs an error and no outbound call is made.');
  out.push('');
  out.push('| Default column | Meaning |');
  out.push('| --- | --- |');
  out.push('| **Required** | No default. Supply a value or the instance will not start. |');
  out.push('| Optional | Ships unset. The capability it controls is off. |');
  out.push('| A value | The template ships this default; override it only if you need to. |');
  out.push('');

  for (const section of sections) {
    out.push(`## ${section.name}`);
    out.push('');
    out.push('| Variable | Default | Notes |');
    out.push('| --- | --- | --- |');
    for (const key of section.keys) {
      out.push(`| \`${key.name}\` | ${statusOf(key, required)} | ${describe(key.doc) || '—'} |`);
    }
    out.push('');
  }

  out.push('## Next steps');
  out.push('');
  out.push('- [Install with Docker Compose](/self-hosting/docker-compose/) — where these are set.');
  out.push('- [Configure email, Stripe, and LLM keys](/self-hosting/optional-integrations/) — the opt-in integrations.');
  out.push('- [Upgrade an instance](/self-hosting/upgrades/) — what changes between releases.');
  out.push('');
  return out.join('\n');
}

const required = requiredSecrets();
// The advisor is withdrawn while it is reworked (DISABLE_ADVISOR defaults to
// true) and the docs no longer describe it, so its settings are left out of the
// reference: every key named ADVISOR (the switch itself included — it is
// documented inline in .env.example for an operator who opts back in) and the
// section that exists only for it. They are still read by the api. Drop this
// filter when the advisor returns.
const HIDDEN_KEY = /ADVISOR|^(ANTHROPIC|OPENAI)_API_KEY$/;
const HIDDEN_SECTION = /^Advisor\b/;
const sections = parse(readFileSync(ENV_EXAMPLE, 'utf8'))
  .filter((s) => !HIDDEN_SECTION.test(s.name))
  .map((s) => ({ ...s, keys: s.keys.filter((k) => !HIDDEN_KEY.test(k.name)) }))
  .filter((s) => s.keys.length > 0);
const keyCount = sections.reduce((n, s) => n + s.keys.length, 0);

// Guard against a silently-broken parse: the file has never had fewer than 70
// keys, and a regex that stops matching would otherwise emit a plausible,
// mostly-empty page that the drift gate would then happily pin in place.
if (keyCount < 70) {
  throw new Error(`gen-env-vars: parsed only ${keyCount} keys from .env.example — parser is stale`);
}

// A variable declared twice means the parser swallowed an inline example as a
// declaration. The drift gate cannot catch that on its own — a wrong-but-stable
// artifact matches itself on every run — so fail here instead.
const seen = new Set();
const duplicates = [];
for (const section of sections) {
  for (const key of section.keys) {
    if (seen.has(key.name)) duplicates.push(key.name);
    seen.add(key.name);
  }
}
if (duplicates.length > 0) {
  throw new Error(`gen-env-vars: duplicate variables parsed: ${duplicates.join(', ')}`);
}

writeFileSync(OUT, render(sections, required));
console.log(
  `gen-env-vars: wrote ${OUT} (${keyCount} variables, ${sections.length} sections, ${required.size} required).`,
);

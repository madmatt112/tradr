#!/usr/bin/env node
// Generates the plan-limits reference from the enforcement code.
//
// Source: `getTierLimits()` in apps/api/src/features/billing/tier-limits.constants.ts
// — the cap table every enforcement point imports. Documenting limits by hand
// means the published numbers and the enforced numbers are two independent
// facts, and only one of them stops a request.
//
// The cap table also carries the advisor allowances (`platformTurns`, `images`).
// They are deliberately NOT documented here: the advisor is withdrawn from the
// hosted app (DISABLE_ADVISOR) and the user guide no longer describes it. Add
// the rows back when it returns.
//
// Usage: node scripts/gen-plan-limits.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '../../..');
const LIMITS = join(repoRoot, 'apps/api/src/features/billing/tier-limits.constants.ts');
const OUT = join(scriptDir, '../src/content/docs/user-guide/reference/plan-limits.mdx');

/** Human wording for each cap, in the order the page presents them. */
const ROWS = [
  ['accounts', 'Accounts', 'Brokerage accounts you can track at once.'],
  ['positions', 'Positions', 'Stored positions across every account.'],
  ['lookbackMonths', 'History window', 'How far back the performance charts can read.', 'months'],
  ['csvImports', 'CSV imports / month', 'Import runs, not rows.'],
];

/** Pull one object literal out of the source and read its numeric/null fields. */
function readLimits(source, marker) {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`gen-plan-limits: marker not found: ${marker}`);
  const open = source.indexOf('{', start);
  const close = source.indexOf('};', open);
  if (open === -1 || close === -1) {
    throw new Error(`gen-plan-limits: could not bound the object after ${marker}`);
  }
  const block = source.slice(open, close);
  const limits = {};
  for (const [, key, value] of block.matchAll(/(\w+):\s*([^,\n]+),/g)) {
    limits[key] = value.trim();
  }
  return limits;
}

function format(raw, unit) {
  if (raw === undefined) return '—';
  if (raw === 'null') return 'Unlimited';
  if (/^\d+$/.test(raw)) {
    const n = Number(raw).toLocaleString('en-US');
    return unit ? `${n} ${unit}` : n;
  }
  return raw;
}

const source = readFileSync(LIMITS, 'utf8');
// `pro` is the early return inside the `tier === 'pro'` branch; the free tier is
// the fallback return that follows it.
const pro = readLimits(source, "if (tier === 'pro')");
const free = readLimits(source, '  return {\n    accounts: 1');

for (const [key] of ROWS) {
  if (free[key] === undefined || pro[key] === undefined) {
    throw new Error(`gen-plan-limits: no value parsed for "${key}" — generator is stale`);
  }
}

const out = [];
out.push('---');
out.push('title: Plan limits');
out.push(
  'description: What the Free and Pro plans allow on the hosted app — accounts, positions, history window, and CSV imports. Self-hosted instances have no limits.',
);
out.push('---');
out.push('');
out.push('import SelfHosted from "@/components/SelfHosted.astro";');
out.push('');
out.push('{/* GENERATED FILE — do not edit.');
out.push('    Source: apps/api/src/features/billing/tier-limits.constants.ts');
out.push('    Generator: apps/docs/scripts/gen-plan-limits.mjs */}');
out.push('');
out.push('<SelfHosted>');
out.push('  **None of this applies to a self-hosted instance.** Plan limits are enforced only');
out.push('  when `FEATURE_GATING` is on, and it ships off. An instance you run yourself has no');
out.push('  tiers and no caps — see');
out.push('  [Hosted vs self-hosted](/user-guide/explanation/hosted-vs-self-hosted/).');
out.push('</SelfHosted>');
out.push('');
out.push('These are the caps on the hosted app. They come from the same table the server');
out.push('checks against, so what is published here is what is enforced.');
out.push('');
out.push('| | Free | Pro |');
out.push('| --- | --- | --- |');
for (const [key, label, , unit] of ROWS) {
  out.push(`| **${label}** | ${format(free[key], unit)} | ${format(pro[key], unit)} |`);
}
out.push('');
out.push('## What each limit means');
out.push('');
for (const [, label, meaning] of ROWS) {
  out.push(`- **${label}** — ${meaning}`);
}
out.push('');
out.push('Monthly counters reset at the start of each calendar month, measured in UTC.');
out.push('');
out.push('## Next steps');
out.push('');
out.push("- [Hosted vs self-hosted](/user-guide/explanation/hosted-vs-self-hosted/) — what's different.");
out.push('');

writeFileSync(OUT, out.join('\n'));
console.log(`gen-plan-limits: wrote ${OUT} (${ROWS.length} limits).`);

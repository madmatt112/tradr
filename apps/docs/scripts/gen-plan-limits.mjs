#!/usr/bin/env node
// Generates the plan-limits reference from the enforcement code.
//
// Source: `getTierLimits()` in apps/api/src/features/billing/tier-limits.constants.ts
// — the cap table every enforcement point imports. Documenting limits by hand
// means the published numbers and the enforced numbers are two independent
// facts, and only one of them stops a request.
//
// The Pro platform-turn allowance is the exception: it reads
// `FEATURE_GATING_ADVISOR_TURNS_PER_MONTH` at check time rather than being a
// literal, so its shipped value comes from the compose default instead. That is
// also read rather than typed.
//
// Usage: node scripts/gen-plan-limits.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '../../..');
const LIMITS = join(repoRoot, 'apps/api/src/features/billing/tier-limits.constants.ts');
const COMPOSE = join(repoRoot, 'docker-compose.yml');
const OUT = join(scriptDir, '../src/content/docs/user-guide/reference/plan-limits.mdx');

/** Human wording for each cap, in the order the page presents them. */
const ROWS = [
  ['accounts', 'Accounts', 'Brokerage accounts you can track at once.'],
  ['positions', 'Positions', 'Stored positions across every account.'],
  ['lookbackMonths', 'History window', 'How far back the performance charts and the advisor can read.', 'months'],
  ['platformTurns', 'Advisor turns / month', 'Advisor replies using the platform key. Turns on your own key are never capped.'],
  ['images', 'Advisor images / month', 'Charts and screenshots you can attach to an advisor conversation.'],
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

// The Pro allowance is env-fed. Read the shipped default from compose rather
// than restating it.
const composeDefault = readFileSync(COMPOSE, 'utf8').match(
  /FEATURE_GATING_ADVISOR_TURNS_PER_MONTH:\s*\$\{FEATURE_GATING_ADVISOR_TURNS_PER_MONTH:-(\d+)\}/,
);
if (!composeDefault) {
  throw new Error('gen-plan-limits: could not read the advisor-turn default from docker-compose.yml');
}
pro.platformTurns = composeDefault[1];

for (const [key] of ROWS) {
  if (free[key] === undefined || pro[key] === undefined) {
    throw new Error(`gen-plan-limits: no value parsed for "${key}" — generator is stale`);
  }
}

const out = [];
out.push('---');
out.push('title: Plan limits');
out.push(
  'description: What the Free and Pro plans allow on the hosted app — accounts, positions, history window, advisor turns, images, and CSV imports. Self-hosted instances have no limits.',
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
out.push('## Bringing your own key');
out.push('');
out.push('The advisor-turn cap applies to turns that run on the platform key. Add your own');
out.push('provider key in **Settings** and those turns are uncapped on either plan — you are');
out.push('paying the provider directly. See [Use the AI advisor](/user-guide/ai-advisor/).');
out.push('');
out.push('## Next steps');
out.push('');
out.push("- [Hosted vs self-hosted](/user-guide/explanation/hosted-vs-self-hosted/) — what's different.");
out.push('- [Use the AI advisor](/user-guide/ai-advisor/) — platform key versus your own.');
out.push('');

writeFileSync(OUT, out.join('\n'));
console.log(
  `gen-plan-limits: wrote ${OUT} (${ROWS.length} limits; Pro advisor turns from the compose default).`,
);

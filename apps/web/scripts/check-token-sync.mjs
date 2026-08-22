// Cross-file design-token drift gate.
//
// `apps/web/src/index.css` is the design-token SOURCE; the docs stylesheet
// `apps/docs/src/styles/tokens.css` is a MIRROR of the shared brand roles.
// The two files use different substrates by design — the app declares
// `--color-*` roles in a Tailwind v4 `@theme` block (light canonical) with a
// `.dark` re-valuing block; the mirror declares bare `--*` roles on `:root`
// (dark canonical) with a `:root[data-theme='light']` parity block — so
// byte-comparison is impossible and equality is checked over an explicit role
// map, per theme, on alias-resolved, whitespace-normalized value strings.
//
// Deliberately NOT compared (divergence is documented, not drift):
// - font stacks (the mirror carries different fallback chains)
// - the type scale (`--text-body` etc. — marketing/docs run larger)
// - `--color-accent`/`--color-input`/`--color-ring` and the non-primary
//   `-foreground` pairs (app-only shadcn roles with no mirror analogue)
// - mirror-only extras (`--accent-text`, `--danger-text`, the spacing ladder,
//   marketing gradients) — they have no app-side source to drift from
//
// The marketing site holds a third copy of the mirror in a separate
// repository; that one is covered by the documented sync ritual, not by this
// gate.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractBlockBody, parseDeclarations, resolveAliases } from './check-contrast.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(here, '..', 'src', 'index.css');
const mirrorPath = resolve(here, '..', '..', 'docs', 'src', 'styles', 'tokens.css');

// [app role, mirror role] — compared in BOTH themes.
export const ROLE_MAP = [
  ['--color-background', '--bg'],
  ['--color-card', '--card'],
  ['--color-popover', '--popover'],
  ['--color-secondary', '--secondary'],
  ['--color-muted', '--muted'],
  ['--color-border', '--border'],
  ['--color-hairline', '--hairline'],
  ['--color-foreground', '--fg'],
  ['--color-muted-foreground', '--muted-fg'],
  ['--color-primary', '--primary'],
  ['--color-primary-foreground', '--primary-fg'],
  ['--color-focus', '--focus'],
  ['--color-gain', '--gain'],
  ['--color-loss', '--loss'],
  ['--color-flat', '--flat'],
  ['--color-success', '--success'],
  ['--color-warning', '--warning'],
  ['--color-info', '--info'],
  ['--color-destructive', '--danger'],
];

// Theme-independent roles: declared once per file (app `@theme`, mirror
// `:root`), never re-valued per theme.
export const THEME_INDEPENDENT = [
  ['--radius-sm', '--radius-sm'],
  ['--radius-md', '--radius-md'],
  ['--radius-lg', '--radius-lg'],
  ['--radius-xl', '--radius-xl'],
];

function normalize(value) {
  return value === undefined ? undefined : value.replace(/\s+/g, ' ').trim();
}

// Pure comparison over parsed maps; returns findings so tests can drive it
// with synthetic fixtures. `raw` maps gate presence (a role must be DECLARED
// in its theme block, not merely inherited); `resolved` maps gate equality.
export function compareTokenMaps({ app, mirror }) {
  const findings = [];
  const oks = [];

  const themes = [
    {
      theme: 'light',
      appRaw: app.lightRaw,
      appValues: app.lightResolved,
      mirrorRaw: mirror.lightRaw,
      mirrorValues: mirror.lightResolved,
    },
    {
      theme: 'dark',
      appRaw: app.darkRaw,
      appValues: app.darkResolved,
      mirrorRaw: mirror.darkRaw,
      mirrorValues: mirror.darkResolved,
    },
  ];

  for (const { theme, appRaw, appValues, mirrorRaw, mirrorValues } of themes) {
    for (const [appRole, mirrorRole] of ROLE_MAP) {
      if (!appRaw.has(appRole)) {
        findings.push(`[${theme}] MISSING ${appRole} in the web source`);
        continue;
      }
      if (!mirrorRaw.has(mirrorRole)) {
        findings.push(`[${theme}] MISSING ${mirrorRole} in the docs mirror (source ${appRole})`);
        continue;
      }
      const a = normalize(appValues.get(appRole));
      const b = normalize(mirrorValues.get(mirrorRole));
      if (a !== b) {
        findings.push(`[${theme}] DRIFT ${appRole} = ${a} but mirror ${mirrorRole} = ${b}`);
      } else {
        oks.push(`[${theme}] OK ${appRole} == ${mirrorRole} (${a})`);
      }
    }
  }

  for (const [appRole, mirrorRole] of THEME_INDEPENDENT) {
    if (!app.lightRaw.has(appRole)) {
      findings.push(`[shared] MISSING ${appRole} in the web source`);
      continue;
    }
    if (!mirror.darkRaw.has(mirrorRole)) {
      findings.push(`[shared] MISSING ${mirrorRole} in the docs mirror (source ${appRole})`);
      continue;
    }
    const a = normalize(app.lightResolved.get(appRole));
    const b = normalize(mirror.darkResolved.get(mirrorRole));
    if (a !== b) {
      findings.push(`[shared] DRIFT ${appRole} = ${a} but mirror ${mirrorRole} = ${b}`);
    } else {
      oks.push(`[shared] OK ${appRole} == ${mirrorRole} (${a})`);
    }
  }

  return { findings, oks };
}

// Parse both files into the per-theme raw + resolved maps compareTokenMaps
// expects. The app's `.dark` and the mirror's light block are partial
// re-valuings, so each is merged over its base before alias resolution —
// mirroring how the cascade resolves a token used under that theme.
export function loadTokenMaps(sourceCss, mirrorCss) {
  const appTheme = extractBlockBody(sourceCss, '@theme');
  const appDark = extractBlockBody(sourceCss, '.dark');
  if (appTheme === null) throw new Error('could not locate @theme block in index.css');
  if (appDark === null) throw new Error('could not locate .dark block in index.css');

  const mirrorRoot = extractBlockBody(mirrorCss, ':root');
  const mirrorLight = extractBlockBody(mirrorCss, ":root[data-theme='light']");
  if (mirrorRoot === null) throw new Error('could not locate :root block in tokens.css');
  if (mirrorLight === null) {
    throw new Error("could not locate :root[data-theme='light'] block in tokens.css");
  }

  const appLightRaw = parseDeclarations(appTheme);
  const appDarkRaw = parseDeclarations(appDark);
  const appDarkMerged = new Map(appLightRaw);
  for (const [k, v] of appDarkRaw) appDarkMerged.set(k, v);

  const mirrorDarkRaw = parseDeclarations(mirrorRoot);
  const mirrorLightRaw = parseDeclarations(mirrorLight);
  const mirrorLightMerged = new Map(mirrorDarkRaw);
  for (const [k, v] of mirrorLightRaw) mirrorLightMerged.set(k, v);

  return {
    app: {
      lightRaw: appLightRaw,
      darkRaw: appDarkRaw,
      lightResolved: resolveAliases(appLightRaw),
      darkResolved: resolveAliases(appDarkMerged),
    },
    mirror: {
      lightRaw: mirrorLightRaw,
      darkRaw: mirrorDarkRaw,
      lightResolved: resolveAliases(mirrorLightMerged),
      darkResolved: resolveAliases(mirrorDarkRaw),
    },
  };
}

function main() {
  let sourceCss;
  let mirrorCss;
  try {
    sourceCss = readFileSync(sourcePath, 'utf8');
    mirrorCss = readFileSync(mirrorPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`::error::token file missing: ${err.path}`);
      process.exit(1);
    }
    throw err;
  }

  let result;
  try {
    result = compareTokenMaps(loadTokenMaps(sourceCss, mirrorCss));
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }

  for (const line of result.oks) console.log(`[sync] ${line}`);

  if (result.findings.length === 0) {
    console.log(`\ntoken-sync gate OK — ${result.oks.length} roles matched, 0 findings`);
    process.exit(0);
  }
  console.log(`\ntoken-sync findings (${result.findings.length}):`);
  for (const f of result.findings) console.error(`::error::[sync] ${f}`);
  process.exit(1);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import {
  ROLE_MAP,
  THEME_INDEPENDENT,
  compareTokenMaps,
  loadTokenMaps,
} from '../check-token-sync.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Build a fully-populated synthetic pair (source + mirror CSS) where every
// mapped role gets a distinct per-theme placeholder value, so a test can
// perturb exactly one thing and assert exactly one finding.
function makeCssPair({ appOverrides = {}, mirrorOverrides = {} } = {}) {
  const value = (role, theme) => `oklch(0.5 0.1 ${theme === 'light' ? 100 : 200}) /*${role}*/`;

  const decl = (role, v) => `  ${role}: ${v};`;
  const pick = (overrides, role, fallback) =>
    Object.prototype.hasOwnProperty.call(overrides, role) ? overrides[role] : fallback;

  const appLight = [];
  const appDark = [];
  const mirrorDark = [];
  const mirrorLight = [];

  for (const [appRole, mirrorRole] of ROLE_MAP) {
    const light = value(appRole, 'light');
    const dark = value(appRole, 'dark');
    const al = pick(appOverrides, `light:${appRole}`, light);
    const ad = pick(appOverrides, `dark:${appRole}`, dark);
    const ml = pick(mirrorOverrides, `light:${mirrorRole}`, light);
    const md = pick(mirrorOverrides, `dark:${mirrorRole}`, dark);
    if (al !== null) appLight.push(decl(appRole, al));
    if (ad !== null) appDark.push(decl(appRole, ad));
    if (ml !== null) mirrorLight.push(decl(mirrorRole, ml));
    if (md !== null) mirrorDark.push(decl(mirrorRole, md));
  }
  for (const [appRole, mirrorRole] of THEME_INDEPENDENT) {
    const v = '0.25rem';
    const av = pick(appOverrides, `shared:${appRole}`, v);
    const mv = pick(mirrorOverrides, `shared:${mirrorRole}`, v);
    if (av !== null) appLight.push(decl(appRole, av));
    if (mv !== null) mirrorDark.push(decl(mirrorRole, mv));
  }

  const sourceCss = `@theme {\n${appLight.join('\n')}\n}\n.dark {\n${appDark.join('\n')}\n}\n`;
  const mirrorCss = `:root {\n${mirrorDark.join('\n')}\n}\n:root[data-theme='light'] {\n${mirrorLight.join('\n')}\n}\n`;
  return { sourceCss, mirrorCss };
}

function run(pair) {
  return compareTokenMaps(loadTokenMaps(pair.sourceCss, pair.mirrorCss));
}

describe('compareTokenMaps over synthetic fixtures', () => {
  it('a fully-synced pair yields zero findings and one OK per mapped role per theme', () => {
    const result = run(makeCssPair());
    expect(result.findings).toEqual([]);
    expect(result.oks).toHaveLength(ROLE_MAP.length * 2 + THEME_INDEPENDENT.length);
  });

  it('flags a value drift with both role names and both values', () => {
    const result = run(
      makeCssPair({ mirrorOverrides: { 'dark:--primary': 'oklch(0.9 0.2 78)' } }),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toContain('DRIFT');
    expect(result.findings[0]).toContain('--color-primary');
    expect(result.findings[0]).toContain('--primary');
    expect(result.findings[0]).toContain('oklch(0.9 0.2 78)');
  });

  it('flags a role missing from the mirror', () => {
    const result = run(makeCssPair({ mirrorOverrides: { 'dark:--hairline': null } }));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatch(/\[dark\] MISSING --hairline in the docs mirror/);
  });

  it('flags a role missing from the web source', () => {
    const result = run(
      makeCssPair({ appOverrides: { 'light:--color-gain': null } }),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatch(/\[light\] MISSING --color-gain in the web source/);
  });

  it('treats whitespace-only differences as equal', () => {
    const result = run(
      makeCssPair({
        appOverrides: { 'shared:--radius-sm': '0.25rem' },
        mirrorOverrides: { 'shared:--radius-sm': ' 0.25rem ' },
      }),
    );
    expect(result.findings).toEqual([]);
  });

  it('resolves var() aliases before comparing', () => {
    const base = makeCssPair();
    // Point the mirror's dark --danger through an alias to the same value the
    // app declares literally; the alias target lives in the same block.
    const literal = 'oklch(0.5 0.1 200) /*--color-destructive*/';
    const mirrorCss = base.mirrorCss.replace(
      `  --danger: ${literal};`,
      `  --danger-base: ${literal};\n  --danger: var(--danger-base);`,
    );
    expect(mirrorCss).not.toEqual(base.mirrorCss);
    const result = compareTokenMaps(loadTokenMaps(base.sourceCss, mirrorCss));
    expect(result.findings).toEqual([]);
  });
});

describe('the real files stay in sync', () => {
  it('index.css and the docs tokens.css mirror agree on every mapped role', () => {
    const sourceCss = readFileSync(resolve(here, '..', '..', 'src', 'index.css'), 'utf8');
    const mirrorCss = readFileSync(
      resolve(here, '..', '..', '..', 'docs', 'src', 'styles', 'tokens.css'),
      'utf8',
    );
    const result = compareTokenMaps(loadTokenMaps(sourceCss, mirrorCss));
    expect(result.findings).toEqual([]);
  });
});

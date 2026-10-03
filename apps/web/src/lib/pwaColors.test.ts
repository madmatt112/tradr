// @vitest-environment node
//
// Contract (Requirement 1.4, design C1/D10):
// Pre-condition: the `--color-background` tokens in index.css (light in the
// `@theme` block at :47, dark in `.dark` at :149) are the source of truth for
// the two `theme-color` metas and the boot-script branch's hex literals.
// Call: `formatHex(parse(token))` on each token (culori 4.0.2, the API the
// task prompt and design C1 name; verified `oklch(1 0 0)` -> `#ffffff` and
// `oklch(0.16 0.005 265)` -> `#0c0d0f` with the installed package).
// Observable result: the computed hexes equal the values baked into
// index.html's `theme-color` metas and into
// `theme-bootstrap.ts`'s `INLINE_BOOT_SCRIPT_SOURCE`.
// Expected value source: design C1's "Hex values" note and D10.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { INLINE_BOOT_SCRIPT_SOURCE } from './theme-bootstrap';

// culori 4.0.2 ships no TypeScript declarations (verified: no .d.ts under
// node_modules/culori@4.0.2 and no @types/culori installed), so a static
// `import { formatHex, parse } from 'culori'` fails `tsc --noEmit` with
// TS7016. `createRequire` resolves the package's CJS `exports.require`
// entry (`bundled/culori.cjs`), which is typed here by hand instead.
const culori = createRequire(import.meta.url)('culori') as {
  formatHex: (color: unknown) => string;
  parse: (input: string) => unknown;
};
const { formatHex, parse } = culori;

function readIndexCss(): string {
  return readFileSync(path.resolve(__dirname, '../index.css'), 'utf8');
}

function readIndexHtml(): string {
  return readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
}

function readManifest(): { theme_color: string; background_color: string } {
  const raw = readFileSync(path.resolve(__dirname, '../../public/manifest.webmanifest'), 'utf8');
  return JSON.parse(raw) as { theme_color: string; background_color: string };
}

// The `@theme` (light) block declares --color-background before the `.dark`
// block re-values it, so the first match is light and the second is dark.
function extractBackgroundTokens(css: string): [string, string] {
  const matches = [...css.matchAll(/--color-background:\s*([^;]+);/g)];
  if (matches.length < 2) {
    throw new Error('expected two --color-background declarations in index.css');
  }
  return [matches[0][1].trim(), matches[1][1].trim()];
}

function extractThemeColorMetas(html: string): Array<{ media: string; content: string }> {
  const tags = html.match(/<meta[^>]*>/g) ?? [];
  return tags
    .filter((tag) => /name=["']theme-color["']/.test(tag))
    .map((tag) => {
      const media = tag.match(/media=["']([^"']+)["']/)?.[1] ?? '';
      const content = tag.match(/content=["']([^"']+)["']/)?.[1] ?? '';
      return { media, content };
    });
}

const [lightToken, darkToken] = extractBackgroundTokens(readIndexCss());
const lightHex = formatHex(parse(lightToken));
const darkHex = formatHex(parse(darkToken));

describe('PWA theme colours track the background tokens (culori guard, Req 1.4, D10)', () => {
  it('index.html carries a light-media and a dark-media theme-color meta whose content equals the culori hex of the matching background token', () => {
    const metas = extractThemeColorMetas(readIndexHtml());
    const light = metas.find((m) => m.media.includes('light'));
    const dark = metas.find((m) => m.media.includes('dark'));

    expect(light?.content).toBe(lightHex);
    expect(dark?.content).toBe(darkHex);
  });

  it('INLINE_BOOT_SCRIPT_SOURCE carries the culori hex of both background tokens (the boot-script branch literals, Req 1.5/D10)', () => {
    expect(INLINE_BOOT_SCRIPT_SOURCE).toContain(lightHex);
    expect(INLINE_BOOT_SCRIPT_SOURCE).toContain(darkHex);
  });

  it('manifest.webmanifest theme_color and background_color equal the culori hex of the light background token (Req 1.1, D10)', () => {
    const manifest = readManifest();
    expect(manifest.theme_color).toBe(lightHex);
    expect(manifest.background_color).toBe(lightHex);
  });
});

// Content-presence gate for the CSV import guide (broker-csv-presets, Requirement 9).
//
// The astro build only proves the MDX compiles, not that the required content is
// present. Requirement 9.1 says the presets paragraph names every shipped preset
// and that each new preset's subsection states its export source, date/timezone
// handling, whether fees are present, and which rows are skipped or refused;
// Requirement 9.2 says the asset-type caution names the preset whose descriptor
// rule supplies the asset type. This test reads the source MDX and asserts each
// required string is present, so the content is gate-proven, not eyeballed.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUIDE = join(HERE, '../src/content/docs/user-guide/import-history.mdx');
const doc = readFileSync(GUIDE, 'utf8');

/** Text of a `### <heading>` subsection, up to the next `##`/`###` heading. */
function subsection(heading) {
  const marker = `### ${heading}`;
  const start = doc.indexOf(marker);
  if (start === -1) return '';
  const rest = doc.slice(start + marker.length);
  const end = rest.search(/\n#{2,3} /);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Text of a `:::caution[<title>]` admonition, up to its closing `:::`. */
function caution(title) {
  const start = doc.indexOf(`:::caution[${title}]`);
  if (start === -1) return '';
  const rest = doc.slice(start);
  const end = rest.indexOf('\n:::');
  return end === -1 ? rest : rest.slice(0, end);
}

describe('import guide names every shipped preset (Requirement 9.1)', () => {
  // Each CSV_IMPORT_PRESETS id, by the name the guide gives it.
  for (const preset of ['Interactive Brokers', 'TradeZella', 'Tradervue', 'generic', 'tastytrade']) {
    it(`names the ${preset} preset`, () => {
      expect(doc).toContain(preset);
    });
  }
});

describe('tastytrade subsection states each required point (Requirement 9.1)', () => {
  const sub = subsection('tastytrade');

  it('has a tastytrade subsection', () => {
    expect(sub).not.toBe('');
  });

  // export source, date + timezone handling, fees present, rows skipped/refused.
  const points = [
    'Activity › Transactions',
    'offset',
    'Timezone',
    'Commissions',
    'Fees',
    'skipped',
    'Future',
  ];
  for (const point of points) {
    it(`states "${point}"`, () => {
      expect(sub).toContain(point);
    });
  }
});

describe('asset-type caution names the descriptor preset (Requirement 9.2)', () => {
  it('names Tradervue as the preset whose descriptor supplies the asset type', () => {
    expect(caution('Asset type has to be a column')).toContain('Tradervue');
  });
});

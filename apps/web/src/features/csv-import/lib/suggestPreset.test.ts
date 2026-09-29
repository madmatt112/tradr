// suggestPreset — names the one preset whose columns a file's headers contain,
// without applying it (design C9; Req 7.1, 7.2).
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CSV_IMPORT_PRESETS, mappingColumns } from '@tradr/shared';
import {
  CSV_IMPORT_SAMPLE_FILES,
  csvImportSamplePath,
} from '@tradr/shared/node/csv-import-samples';

import { suggestPreset } from './suggestPreset';

function headerRow(presetId: string): string[] {
  const contents = readFileSync(csvImportSamplePath(presetId), 'utf8');
  return contents.split('\n')[0].split(',');
}

describe('suggestPreset', () => {
  // Contract: for each id in CSV_IMPORT_SAMPLE_FILES (every fixture-backed
  // preset), the fixture's own committed header line is the pre-condition.
  // Test: suggestPreset(headers, CSV_IMPORT_PRESETS). Observable: the result's
  // id equals the fixture's own preset id. Source: Req 7.1 ("the import page
  // SHALL name that preset as a suggestion") and CSV_IMPORT_SAMPLE_FILES
  // (`@tradr/shared/node/csv-import-samples`), which names each fixture's own
  // preset id.
  it.each(Object.keys(CSV_IMPORT_SAMPLE_FILES))(
    "suggests %s's own preset from its committed fixture's header line",
    (presetId) => {
      const headers = headerRow(presetId);

      const result = suggestPreset(headers, CSV_IMPORT_PRESETS);

      expect(result?.id).toBe(presetId);
    },
  );

  // Contract: pre-condition: headers that contain no preset's full mapped
  // column set. Test: suggestPreset(headers, CSV_IMPORT_PRESETS). Observable:
  // null. Source: Req 7.2 ("WHEN zero or several presets match THEN no
  // suggestion SHALL show").
  it('returns null when zero presets match', () => {
    const headers = ['Not', 'A', 'Known', 'Header', 'Set'];

    expect(suggestPreset(headers, CSV_IMPORT_PRESETS)).toBeNull();
  });

  // Contract: pre-condition: headers that are a superset of two real presets'
  // full mapped column sets at once (tradezella and generic-execution, whose
  // mapped columns share no name, so both are simultaneously satisfiable).
  // Test: suggestPreset(headers, CSV_IMPORT_PRESETS). Observable: null.
  // Source: Req 7.2, same clause, "several presets match".
  it('returns null when two presets match', () => {
    const tradezella = CSV_IMPORT_PRESETS.find((p) => p.id === 'tradezella')!;
    const genericExecution = CSV_IMPORT_PRESETS.find((p) => p.id === 'generic-execution')!;
    const headers = [
      ...mappingColumns(tradezella.mapping),
      ...mappingColumns(genericExecution.mapping),
    ];

    expect(suggestPreset(headers, CSV_IMPORT_PRESETS)).toBeNull();
  });

  // Contract: pre-condition: an empty header list, which vacuously contains
  // `generic-manual`'s empty mapped-column set (its `mapping.columns` is `{}`)
  // and no other preset's non-empty set. Test: suggestPreset([],
  // CSV_IMPORT_PRESETS). Observable: null, not the `generic-manual` preset.
  // Source: Req 7.2 ("`generic-manual` SHALL never be suggested") and design
  // C9 ("excludes `generic-manual` and any preset for which `mappingColumns`
  // returns nothing").
  it('never suggests generic-manual, even when its empty column set is vacuously satisfied', () => {
    expect(suggestPreset([], CSV_IMPORT_PRESETS)).toBeNull();
  });
});

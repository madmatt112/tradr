import { CSV_IMPORT_PRESETS, mappingColumns } from '@tradr/shared';
import type { CsvPreset } from '@tradr/shared';

/**
 * Name the one preset whose mapped columns a file's `headers` contain, without
 * applying it (design C9; Requirement 7). Browser-only: the server never selects
 * a preset (Req 7.3).
 *
 * Excludes `generic-manual` and any preset for which `mappingColumns` returns
 * nothing (its empty column set is vacuously satisfied by any headers). Returns
 * the single preset whose `mappingColumns` are all present in `headers`, and
 * `null` for zero or several matches (Req 7.2).
 */
export function suggestPreset(
  headers: string[],
  presets: CsvPreset[] = CSV_IMPORT_PRESETS,
): CsvPreset | null {
  const headerSet = new Set(headers);
  const matches = presets.filter((preset) => {
    if (preset.id === 'generic-manual') return false;
    const columns = mappingColumns(preset.mapping);
    if (columns.length === 0) return false;
    return columns.every((column) => headerSet.has(column));
  });
  return matches.length === 1 ? matches[0] : null;
}

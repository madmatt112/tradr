import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Node-only accessors for the committed CSV import sample fixtures (REQ-3.3).
 *
 * These read files from disk, so they live under `@tradr/shared/node/*` and are
 * deliberately NOT re-exported from `index.ts` (the barrel is web-bundled). Only
 * server/test code (e.g. the `apps/api` preset conformance test) imports them.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.resolve(__dirname, '../constants/__fixtures__/csv-import-samples');

/** Named preset id -> its committed real-export sample file name. */
export const CSV_IMPORT_SAMPLE_FILES: Record<string, string> = {
  'interactive-brokers': 'interactive-brokers.csv',
  tradezella: 'tradezella.csv',
  tradervue: 'tradervue.csv',
  'generic-execution': 'generic-execution.csv',
};

/** Absolute path to a preset's sample fixture. Throws for an unknown id. */
export function csvImportSamplePath(presetId: string): string {
  const file = CSV_IMPORT_SAMPLE_FILES[presetId];
  if (!file) {
    throw new Error(`No CSV import sample fixture for preset id "${presetId}"`);
  }
  return path.join(SAMPLES_DIR, file);
}

/** Raw bytes of a preset's sample fixture. Throws for an unknown id. */
export function readCsvImportSample(presetId: string): Uint8Array {
  return readFileSync(csvImportSamplePath(presetId));
}

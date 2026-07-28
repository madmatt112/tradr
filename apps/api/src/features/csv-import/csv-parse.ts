import { parse as parseSync } from 'csv-parse/sync';

import { ValidationError } from '@/lib/errors';

/**
 * CSV parser — pure leaf module (no HTTP, no DB).
 *
 * Operates over an already byte-capped buffer (the captured request body is
 * never allowed to grow past `CSV_IMPORT_MAX_FILE_BYTES`, enforced upstream),
 * so a synchronous parse over it is bounded. RFC 4180: quoted delimiters,
 * embedded newlines, `""` escapes. Implements design Component 1.
 */

export type Delimiter = ',' | ';' | '\t';

export interface ParseOptions {
  /** Override delimiter detection. Supported set: comma, semicolon, tab. */
  delimiter?: Delimiter;
  /** First non-empty line is the header row (default true). */
  hasHeader?: boolean;
}

export interface ParsedCsv {
  /** Display column names (disambiguated; synthetic when headerless). */
  headers: string[];
  /** Data rows (header row excluded). */
  rows: string[][];
  /** Number of data rows. */
  rowCount: number;
}

const SUPPORTED_DELIMITERS: Delimiter[] = [',', ';', '\t'];

/**
 * Decode UTF-8 and strip a leading BOM. Undecodable bytes throw
 * `CSV_NOT_UTF8` rather than producing garbled column names (REQ-1.3).
 */
function decodeUtf8(bytes: Uint8Array): string {
  let text: string;
  try {
    // `fatal: true` rejects malformed byte sequences instead of replacing
    // them with U+FFFD.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ValidationError('CSV file is not valid UTF-8 text', {
      code: 'CSV_NOT_UTF8',
    });
  }
  // Strip a leading BOM (U+FEFF) — the 0xEF 0xBB 0xBF byte sequence decodes
  // to this code point. csv-parse's `bom` option also handles this, but we
  // strip here too so header-line delimiter sniffing sees clean text.
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  return text;
}

/**
 * Sniff the delimiter from the header line by counting unquoted occurrences
 * of each candidate and choosing the max. Ties resolve to comma (REQ-1.2).
 */
function sniffDelimiter(text: string): Delimiter {
  const newline = text.indexOf('\n');
  const headerLine = newline === -1 ? text : text.slice(0, newline);

  let inQuotes = false;
  const counts = new Map<Delimiter, number>(SUPPORTED_DELIMITERS.map((d) => [d, 0]));
  for (const ch of headerLine) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (ch === ',' || ch === ';' || ch === '\t') {
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
  }

  // Iterate in supported order (comma first) so ties resolve to comma.
  let best: Delimiter = ',';
  let bestCount = -1;
  for (const d of SUPPORTED_DELIMITERS) {
    const c = counts.get(d) ?? 0;
    if (c > bestCount) {
      best = d;
      bestCount = c;
    }
  }
  return best;
}

/**
 * Disambiguate duplicate header names: the k-th repeat of a name `X` (k >= 2)
 * becomes `X__k` (e.g. second `Price` -> `Price__2`). Mappings target the
 * suffixed name (REQ-1.4).
 */
function disambiguateHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((name) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name}__${count}`;
  });
}

export function parseCsv(bytes: Uint8Array, opts: ParseOptions = {}): ParsedCsv {
  const text = decodeUtf8(bytes);
  const delimiter = opts.delimiter ?? sniffDelimiter(text);
  const hasHeader = opts.hasHeader ?? true;

  // csv-parse v5 sync API. `columns: false` (default) yields string[][].
  const records = parseSync(text, {
    delimiter,
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true,
  }) as string[][];

  if (records.length === 0) {
    return { headers: [], rows: [], rowCount: 0 };
  }

  if (hasHeader) {
    const headers = disambiguateHeaders(records[0]);
    const rows = records.slice(1);
    return { headers, rows, rowCount: rows.length };
  }

  // Headerless: synthetic 1-based display names referenced positionally.
  const width = records.reduce((max, r) => Math.max(max, r.length), 0);
  const headers = Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  return { headers, rows: records, rowCount: records.length };
}

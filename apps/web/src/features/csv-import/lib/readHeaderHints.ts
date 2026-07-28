/**
 * Read ONLY the header line of a CSV to populate the mapper's column dropdowns.
 *
 * This is deliberately NOT a CSV parse of the data: it reads the first text line
 * and splits on the delimiter to surface candidate column names for mapping. The
 * authoritative parse (RFC 4180 quoting, BOM, encoding, every data row) happens
 * on the server (REQ-12 / tech.md "server parses the file"). If the header line
 * can't be read, the mapper falls back to an empty list and the user can still
 * proceed (the server validates the mapping against the real headers).
 */
export async function readHeaderHints(file: File, delimiter = ','): Promise<string[]> {
  try {
    const slice = await file.slice(0, 64 * 1024).text();
    const firstLine = slice.split(/\r\n|\n|\r/)[0] ?? '';
    if (!firstLine) return [];
    return firstLine
      .replace(/^﻿/, '')
      .split(delimiter)
      .map((h) => h.trim().replace(/^"|"$/g, ''))
      .filter((h) => h.length > 0);
  } catch {
    return [];
  }
}

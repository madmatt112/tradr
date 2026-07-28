import { describe, expect, it } from 'vitest';

import { ValidationError } from '@/lib/errors';

import { parseCsv } from './csv-parse';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('parseCsv', () => {
  describe('RFC 4180 quoting', () => {
    it('parses quoted fields containing the delimiter', () => {
      const r = parseCsv(enc('a,b\n"x,y",z'));
      expect(r.headers).toEqual(['a', 'b']);
      expect(r.rows).toEqual([['x,y', 'z']]);
    });

    it('parses escaped double-quotes ("")', () => {
      const r = parseCsv(enc('a,b\n"he said ""hi""",z'));
      expect(r.rows).toEqual([['he said "hi"', 'z']]);
    });

    it('parses embedded newlines inside quotes', () => {
      const r = parseCsv(enc('a,b\n"line1\nline2",z'));
      expect(r.rows).toEqual([['line1\nline2', 'z']]);
      expect(r.rowCount).toBe(1);
    });
  });

  describe('delimiter sniffing', () => {
    it('detects semicolon', () => {
      const r = parseCsv(enc('a;b;c\n1;2;3'));
      expect(r.headers).toEqual(['a', 'b', 'c']);
      expect(r.rows).toEqual([['1', '2', '3']]);
    });

    it('detects tab', () => {
      const r = parseCsv(enc('a\tb\tc\n1\t2\t3'));
      expect(r.headers).toEqual(['a', 'b', 'c']);
      expect(r.rows).toEqual([['1', '2', '3']]);
    });

    it('detects comma', () => {
      const r = parseCsv(enc('a,b,c\n1,2,3'));
      expect(r.headers).toEqual(['a', 'b', 'c']);
    });

    it('resolves ties to comma', () => {
      // One comma and one semicolon in the header -> tie -> comma wins.
      const r = parseCsv(enc('a,b;c\n1,2;3'));
      expect(r.headers).toEqual(['a', 'b;c']);
      expect(r.rows).toEqual([['1', '2;3']]);
    });

    it('ignores delimiters inside quoted header cells when sniffing', () => {
      // Header has quoted semicolons but unquoted commas -> comma.
      const r = parseCsv(enc('"a;b",c\n1,2'));
      expect(r.headers).toEqual(['a;b', 'c']);
      expect(r.rows).toEqual([['1', '2']]);
    });

    it('honors an explicit delimiter override', () => {
      const r = parseCsv(enc('a;b\n1;2'), { delimiter: ';' });
      expect(r.headers).toEqual(['a', 'b']);
      expect(r.rows).toEqual([['1', '2']]);
    });
  });

  describe('BOM handling', () => {
    it('strips a leading UTF-8 BOM from the first header', () => {
      const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
      const body = enc('sym,price\nAAPL,10');
      const bytes = new Uint8Array(bom.length + body.length);
      bytes.set(bom, 0);
      bytes.set(body, bom.length);
      const r = parseCsv(bytes);
      expect(r.headers).toEqual(['sym', 'price']);
      expect(r.rows).toEqual([['AAPL', '10']]);
    });
  });

  describe('header modes', () => {
    it('uses the first non-empty line as header by default', () => {
      const r = parseCsv(enc('a,b\n1,2\n3,4'));
      expect(r.headers).toEqual(['a', 'b']);
      expect(r.rowCount).toBe(2);
    });

    it('generates synthetic Column N names when hasHeader=false', () => {
      const r = parseCsv(enc('1,2,3\n4,5,6'), { hasHeader: false });
      expect(r.headers).toEqual(['Column 1', 'Column 2', 'Column 3']);
      expect(r.rows).toEqual([
        ['1', '2', '3'],
        ['4', '5', '6'],
      ]);
      expect(r.rowCount).toBe(2);
    });

    it('disambiguates duplicate header names with __k suffix', () => {
      const r = parseCsv(enc('Price,Price,Qty,Price\n1,2,3,4'));
      expect(r.headers).toEqual(['Price', 'Price__2', 'Qty', 'Price__3']);
      expect(r.rows).toEqual([['1', '2', '3', '4']]);
    });
  });

  describe('empty / ragged input', () => {
    it('returns empty result for empty input', () => {
      const r = parseCsv(enc(''));
      expect(r.headers).toEqual([]);
      expect(r.rows).toEqual([]);
      expect(r.rowCount).toBe(0);
    });

    it('skips empty lines', () => {
      const r = parseCsv(enc('a,b\n1,2\n\n3,4\n'));
      expect(r.rowCount).toBe(2);
      expect(r.rows).toEqual([
        ['1', '2'],
        ['3', '4'],
      ]);
    });

    it('tolerates ragged column counts (relax_column_count)', () => {
      const r = parseCsv(enc('a,b,c\n1,2\n3,4,5,6'));
      expect(r.headers).toEqual(['a', 'b', 'c']);
      expect(r.rows).toEqual([
        ['1', '2'],
        ['3', '4', '5', '6'],
      ]);
    });
  });

  describe('encoding', () => {
    it('throws CSV_NOT_UTF8 on undecodable bytes', () => {
      // 0xFF is invalid as a standalone UTF-8 byte.
      const bytes = new Uint8Array([0x61, 0x2c, 0x62, 0x0a, 0xff, 0xfe]);
      try {
        parseCsv(bytes);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).details).toEqual({ code: 'CSV_NOT_UTF8' });
      }
    });

    it('accepts valid multibyte UTF-8 content', () => {
      const r = parseCsv(enc('name,note\nAAPL,café ☕'));
      expect(r.rows).toEqual([['AAPL', 'café ☕']]);
    });
  });
});

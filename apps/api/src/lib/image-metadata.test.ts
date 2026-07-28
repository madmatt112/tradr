import { describe, expect, it } from 'vitest';

import { stripImageMetadata } from './image-metadata';

// ---------------------------------------------------------------------------
// Fixture helpers — minimal valid containers with embedded EXIF carrying a
// known GPS tag (GPSLatitude, IFD0 GPSInfo) and a camera-identifying tag
// (Make / Model). We do NOT use an image library; the bytes are hand-built.
// ---------------------------------------------------------------------------

// Distinctive markers we can search for in output to prove removal.
const GPS_MARKER = Buffer.from('GPS_FIXTURE_LAT', 'latin1');
const CAMERA_MARKER = Buffer.from('CAMERA_MAKE_ACME', 'latin1');
const EXIF_IDENT = Buffer.from('Exif\x00\x00', 'latin1');

/** A blob of fake "pixel" bytes we assert is preserved verbatim. */
const PIXELS = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04, 0xfa, 0xce]);

/** EXIF payload (without the leading "Exif\0\0"), containing our markers. */
const EXIF_BODY = Buffer.concat([
  EXIF_IDENT,
  GPS_MARKER,
  CAMERA_MARKER,
  Buffer.from('II*\x00rest'),
]);

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const len = payload.length + 2;
  const head = Buffer.from([0xff, marker, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([head, payload]);
}

/** Minimal JPEG: SOI, APP1(EXIF w/ GPS), DQT (kept), SOS + scan, EOI. */
function buildJpegWithGps(): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app1 = jpegSegment(0xe1, EXIF_BODY); // APP1 = EXIF/XMP
  const dqt = jpegSegment(0xdb, Buffer.from([0x00, 0x01, 0x02, 0x03])); // kept marker
  const sos = Buffer.concat([Buffer.from([0xff, 0xda, 0x00, 0x03, 0x01]), PIXELS]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app1, dqt, sos, eoi]);
}

/** Minimal JPEG with no metadata segments — for the no-op test. */
function buildCleanJpeg(): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const dqt = jpegSegment(0xdb, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  const sos = Buffer.concat([Buffer.from([0xff, 0xda, 0x00, 0x03, 0x01]), PIXELS]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, dqt, sos, eoi]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  // CRC value is irrelevant to the strip logic; use a fixed placeholder.
  const crc = Buffer.from([0x00, 0x00, 0x00, 0x00]);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Minimal PNG: sig, IHDR (kept), eXIf (GPS), tEXt (camera), IDAT, IEND. */
function buildPngWithGps(): Buffer {
  const ihdr = pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
  const exif = pngChunk('eXIf', Buffer.concat([GPS_MARKER, Buffer.from('exifdata')]));
  const text = pngChunk('tEXt', Buffer.concat([Buffer.from('Make\x00'), CAMERA_MARKER]));
  const idat = pngChunk('IDAT', PIXELS);
  const iend = pngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([PNG_SIG, ihdr, exif, text, idat, iend]);
}

function buildCleanPng(): Buffer {
  const ihdr = pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
  const idat = pngChunk('IDAT', PIXELS);
  const iend = pngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([PNG_SIG, ihdr, idat, iend]);
}

function webpChunk(fourcc: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'latin1');
  head.writeUInt32LE(payload.length, 4);
  const padded = payload.length & 1 ? Buffer.concat([payload, Buffer.from([0x00])]) : payload;
  return Buffer.concat([head, padded]);
}

function buildRiff(chunks: Buffer): Buffer {
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + chunks.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, chunks]);
}

/** Extended (VP8X) WebP with EXIF (GPS) + XMP (camera) chunks. */
function buildWebpWithGps(): Buffer {
  // VP8X flags byte: EXIF (0x08) + XMP (0x04) set. 10-byte payload.
  const vp8xPayload = Buffer.from([0x08 | 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const vp8x = webpChunk('VP8X', vp8xPayload);
  const vp8 = webpChunk('VP8 ', PIXELS); // "pixel" data
  const exif = webpChunk('EXIF', Buffer.concat([GPS_MARKER, Buffer.from('exif')]));
  const xmp = webpChunk('XMP ', CAMERA_MARKER);
  return buildRiff(Buffer.concat([vp8x, vp8, exif, xmp]));
}

/** Simple (lossy) WebP with no metadata — no-op fixture. */
function buildCleanWebp(): Buffer {
  const vp8 = webpChunk('VP8 ', PIXELS);
  return buildRiff(vp8);
}

// ---------------------------------------------------------------------------

describe('stripImageMetadata', () => {
  describe('JPEG', () => {
    it('removes APP1 EXIF carrying GPS and camera tags', () => {
      const input = buildJpegWithGps();
      const out = stripImageMetadata('jpeg', input);

      expect(out.includes(GPS_MARKER)).toBe(false);
      expect(out.includes(CAMERA_MARKER)).toBe(false);
      expect(out.includes(EXIF_IDENT)).toBe(false);
    });

    it('preserves pixels and structural segments (format byte-stable)', () => {
      const out = stripImageMetadata('jpeg', buildJpegWithGps());

      // Still a JPEG (SOI / EOI intact), pixels unchanged.
      expect(out.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);
      expect(out.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
      expect(out.includes(PIXELS)).toBe(true);
      // DQT (0xFFDB) segment retained.
      expect(out.includes(Buffer.from([0xff, 0xdb]))).toBe(true);
    });

    it('is a no-op (byte-identical) for a clean JPEG', () => {
      const clean = buildCleanJpeg();
      const out = stripImageMetadata('jpeg', clean);
      expect(out.equals(clean)).toBe(true);
    });
  });

  describe('PNG', () => {
    it('removes eXIf/tEXt metadata chunks (GPS + camera)', () => {
      const out = stripImageMetadata('png', buildPngWithGps());

      expect(out.includes(GPS_MARKER)).toBe(false);
      expect(out.includes(CAMERA_MARKER)).toBe(false);
      expect(out.includes(Buffer.from('eXIf', 'latin1'))).toBe(false);
      expect(out.includes(Buffer.from('tEXt', 'latin1'))).toBe(false);
    });

    it('preserves signature, IHDR, IDAT pixels and IEND', () => {
      const out = stripImageMetadata('png', buildPngWithGps());

      expect(out.subarray(0, 8).equals(PNG_SIG)).toBe(true);
      expect(out.includes(Buffer.from('IHDR', 'latin1'))).toBe(true);
      expect(out.includes(Buffer.from('IDAT', 'latin1'))).toBe(true);
      expect(out.includes(Buffer.from('IEND', 'latin1'))).toBe(true);
      expect(out.includes(PIXELS)).toBe(true);
    });

    it('is a no-op (byte-identical) for a clean PNG', () => {
      const clean = buildCleanPng();
      const out = stripImageMetadata('png', clean);
      expect(out.equals(clean)).toBe(true);
    });
  });

  describe('WebP', () => {
    it('removes EXIF/XMP chunks (GPS + camera)', () => {
      const out = stripImageMetadata('webp', buildWebpWithGps());

      expect(out.includes(GPS_MARKER)).toBe(false);
      expect(out.includes(CAMERA_MARKER)).toBe(false);
      expect(out.includes(Buffer.from('EXIF', 'latin1'))).toBe(false);
      expect(out.includes(Buffer.from('XMP ', 'latin1'))).toBe(false);
    });

    it('preserves RIFF/WEBP header and pixel chunk, fixes RIFF size', () => {
      const out = stripImageMetadata('webp', buildWebpWithGps());

      expect(out.toString('latin1', 0, 4)).toBe('RIFF');
      expect(out.toString('latin1', 8, 12)).toBe('WEBP');
      expect(out.includes(Buffer.from('VP8 ', 'latin1'))).toBe(true);
      expect(out.includes(PIXELS)).toBe(true);
      // RIFF size field equals remaining bytes after the 8-byte RIFF header.
      expect(out.readUInt32LE(4)).toBe(out.length - 8);
    });

    it('losslessly clears EXIF/XMP flag bits in the VP8X header', () => {
      const out = stripImageMetadata('webp', buildWebpWithGps());

      // Locate VP8X chunk and read its flags byte (payload offset 0 => +8).
      const idx = out.indexOf(Buffer.from('VP8X', 'latin1'));
      expect(idx).toBeGreaterThan(-1);
      const flags = out[idx + 8];
      expect(flags & 0x08).toBe(0); // EXIF flag cleared
      expect(flags & 0x04).toBe(0); // XMP flag cleared
    });

    it('is a no-op (byte-identical) for a clean WebP', () => {
      const clean = buildCleanWebp();
      const out = stripImageMetadata('webp', clean);
      expect(out.equals(clean)).toBe(true);
    });
  });

  describe('edge / non-image input', () => {
    it('returns empty buffer unchanged', () => {
      const empty = Buffer.alloc(0);
      expect(stripImageMetadata('jpeg', empty)).toBe(empty);
    });

    it('does not throw or corrupt on garbage bytes (each format)', () => {
      const garbage = Buffer.from('not an image at all, just text', 'latin1');
      for (const fmt of ['jpeg', 'png', 'webp'] as const) {
        const out = stripImageMetadata(fmt, garbage);
        expect(out.equals(garbage)).toBe(true);
      }
    });

    it('does not throw on a truncated JPEG and preserves prefix bytes', () => {
      const truncated = buildJpegWithGps().subarray(0, 6);
      const out = stripImageMetadata('jpeg', truncated);
      expect(Buffer.isBuffer(out)).toBe(true);
      expect(out.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);
    });

    it('does not throw on a truncated PNG/WebP', () => {
      const png = buildPngWithGps().subarray(0, 20);
      const webp = buildWebpWithGps().subarray(0, 16);
      expect(() => stripImageMetadata('png', png)).not.toThrow();
      expect(() => stripImageMetadata('webp', webp)).not.toThrow();
    });
  });
});

/**
 * Container-level image metadata stripping (REQ-8.2 / REQ-8.3).
 *
 * Pure, format-aware byte transform that removes metadata segments/chunks
 * carrying EXIF/XMP (GPS, camera-identifying, etc.) without re-encoding pixels.
 * No image-processing library — `sharp` is rejected (heavy native dep that
 * re-encodes pixels, risking quality/format change).
 *
 * Supported formats: 'png' | 'jpeg' | 'webp' (the advisor image part schema
 * `format` enum, packages/shared/src/schemas/advisor.ts).
 *
 * Contract:
 *  - Pixels are never re-encoded; the stored `format` is byte-stable.
 *  - A clean image (no metadata) returns byte-identical output.
 *  - Malformed / truncated / non-matching input is returned unchanged
 *    (never throws destructively, never corrupts).
 */

export type SupportedImageFormat = 'png' | 'jpeg' | 'webp';

/**
 * Strip container-level metadata from an image, preserving pixels and format.
 *
 * @param format - the declared image format ('png' | 'jpeg' | 'webp')
 * @param bytes  - the raw image bytes
 * @returns the stripped bytes (a new Buffer), or the input bytes unchanged
 *          when nothing could be safely stripped.
 */
export function stripImageMetadata(format: SupportedImageFormat, bytes: Buffer): Buffer {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return bytes;

  try {
    switch (format) {
      case 'jpeg':
        return stripJpeg(bytes);
      case 'png':
        return stripPng(bytes);
      case 'webp':
        return stripWebp(bytes);
      default:
        return bytes;
    }
  } catch {
    // Edge/non-image input must not corrupt or throw destructively.
    return bytes;
  }
}

// --- JPEG -------------------------------------------------------------------
// Structure: 0xFFD8 (SOI), then a sequence of markers. APPn markers
// (0xFFE0..0xFFEF) and the COM marker (0xFFFE) carry metadata (EXIF in APP1,
// XMP in APP1, ICC/JFIF in APP0/APP2, etc.). We drop all APPn + COM segments.
// Once we hit SOS (0xFFDA) the compressed scan data follows — we copy the rest
// verbatim. Pixels (entropy-coded data) are never touched.

const JPEG_SOI = 0xd8;
const JPEG_SOS = 0xda;
const JPEG_EOI = 0xd9;

function stripJpeg(bytes: Buffer): Buffer {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== JPEG_SOI) {
    return bytes; // not a JPEG — leave untouched
  }

  const out: Buffer[] = [bytes.subarray(0, 2)]; // SOI
  let i = 2;

  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) {
      // Not at a marker boundary — bail out and copy the remainder verbatim
      // rather than risk corrupting the stream.
      out.push(bytes.subarray(i));
      i = bytes.length;
      break;
    }

    const marker = bytes[i + 1];

    // Padding fill bytes (0xFF runs) — copy one byte and continue.
    if (marker === 0xff) {
      out.push(bytes.subarray(i, i + 1));
      i += 1;
      continue;
    }

    // Standalone markers without a length payload: RSTn (0xD0..0xD7), EOI, TEM.
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === JPEG_EOI || marker === 0x01) {
      out.push(bytes.subarray(i, i + 2));
      i += 2;
      if (marker === JPEG_EOI) break;
      continue;
    }

    // Start of scan: copy SOS marker + the rest (scan data) verbatim.
    if (marker === JPEG_SOS) {
      out.push(bytes.subarray(i));
      i = bytes.length;
      break;
    }

    // Segment with a 2-byte length (includes the length bytes themselves).
    if (i + 4 > bytes.length) {
      out.push(bytes.subarray(i));
      i = bytes.length;
      break;
    }
    const segLen = bytes.readUInt16BE(i + 2);
    const segEnd = i + 2 + segLen;
    if (segLen < 2 || segEnd > bytes.length) {
      // Malformed length — copy remainder verbatim to avoid corruption.
      out.push(bytes.subarray(i));
      i = bytes.length;
      break;
    }

    const isAppn = marker >= 0xe0 && marker <= 0xef;
    const isComment = marker === 0xfe;
    if (isAppn || isComment) {
      // Drop this metadata segment (APP0..APP15 / COM).
      i = segEnd;
      continue;
    }

    // Keep all other segments (DQT, DHT, SOF, DRI, etc.).
    out.push(bytes.subarray(i, segEnd));
    i = segEnd;
  }

  return Buffer.concat(out);
}

// --- PNG --------------------------------------------------------------------
// Structure: 8-byte signature, then a sequence of chunks:
//   [length:4][type:4][data:length][crc:4]
// We drop the metadata ancillary chunks: eXIf, tEXt, iTXt, zTXt.
// IDAT (pixel data), IHDR, PLTE, IEND, etc. are preserved byte-for-byte.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_METADATA_CHUNKS = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt']);

function stripPng(bytes: Buffer): Buffer {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return bytes; // not a PNG
  }

  const out: Buffer[] = [bytes.subarray(0, 8)];
  let i = 8;

  while (i + 8 <= bytes.length) {
    const dataLen = bytes.readUInt32BE(i);
    const type = bytes.toString('latin1', i + 4, i + 8);
    const chunkEnd = i + 12 + dataLen; // length + type + data + crc

    if (dataLen > bytes.length || chunkEnd > bytes.length) {
      // Truncated/malformed chunk — copy remainder verbatim.
      out.push(bytes.subarray(i));
      i = bytes.length;
      break;
    }

    if (!PNG_METADATA_CHUNKS.has(type)) {
      out.push(bytes.subarray(i, chunkEnd));
    }

    i = chunkEnd;
    if (type === 'IEND') break;
  }

  if (i < bytes.length) out.push(bytes.subarray(i));

  return Buffer.concat(out);
}

// --- WebP -------------------------------------------------------------------
// RIFF container: "RIFF"[size:4]"WEBP" then a sequence of chunks:
//   [fourcc:4][size:4][payload:size][pad to even]
// Metadata lives in EXIF / XMP chunks. We drop those. If the file is an
// extended (VP8X) WebP and no remaining chunk requires the extended header
// (i.e. no ANIM/ANMF and no remaining metadata flags needed), we losslessly
// clear the EXIF/XMP flag bits in the VP8X header. We do NOT touch pixel
// chunks (VP8 / VP8L / ALPH / ANIM / ANMF).

const WEBP_METADATA_CHUNKS = new Set(['EXIF', 'XMP ']);
const VP8X_FLAG_XMP = 0x04; // bit 2
const VP8X_FLAG_EXIF = 0x08; // bit 3

function stripWebp(bytes: Buffer): Buffer {
  if (
    bytes.length < 12 ||
    bytes.toString('latin1', 0, 4) !== 'RIFF' ||
    bytes.toString('latin1', 8, 12) !== 'WEBP'
  ) {
    return bytes; // not a WebP
  }

  const header = Buffer.from(bytes.subarray(0, 12)); // RIFF + size + WEBP (size fixed up later)
  const kept: Buffer[] = [];
  let vp8xChunk: Buffer | null = null;
  let removedMetadata = false;

  let i = 12;
  while (i + 8 <= bytes.length) {
    const fourcc = bytes.toString('latin1', i, i + 4);
    const size = bytes.readUInt32LE(i + 4);
    const payloadEnd = i + 8 + size;
    const padded = payloadEnd + (size & 1); // chunks are padded to even length

    if (size > bytes.length || payloadEnd > bytes.length) {
      // Truncated — keep remainder verbatim and stop structured parsing.
      kept.push(bytes.subarray(i));
      i = bytes.length;
      break;
    }

    const chunk = bytes.subarray(i, Math.min(padded, bytes.length));

    if (WEBP_METADATA_CHUNKS.has(fourcc)) {
      removedMetadata = true; // drop it
    } else if (fourcc === 'VP8X') {
      vp8xChunk = Buffer.from(chunk);
      kept.push(vp8xChunk); // placeholder; flags fixed after the loop
    } else {
      kept.push(chunk);
    }

    i = padded;
  }

  if (i < bytes.length) kept.push(bytes.subarray(i));

  // Losslessly clear the EXIF/XMP flag bits in VP8X now that those chunks are
  // gone. The VP8X flags byte is the first byte of its 10-byte payload (offset
  // 8 within the chunk). We only clear metadata flags; ANIM/ALPH/etc. untouched.
  if (vp8xChunk && removedMetadata && vp8xChunk.length >= 9) {
    vp8xChunk[8] &= ~(VP8X_FLAG_EXIF | VP8X_FLAG_XMP);
  }

  if (!removedMetadata) {
    return bytes; // nothing dropped — byte-identical no-op
  }

  const body = Buffer.concat(kept);
  // RIFF size = everything after the first 8 bytes ("RIFF" + size field),
  // i.e. "WEBP" (4) + all chunk bytes.
  header.writeUInt32LE(4 + body.length, 4);

  return Buffer.concat([header, body]);
}

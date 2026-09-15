import { describe, expect, it } from 'vitest';

import { MAX_IMAGE_BYTES_DEFAULT } from './advisor';
import {
  POSITION_IMAGE_MAX_BYTES,
  POSITION_IMAGE_MAX_COUNT,
  PositionImageFormatSchema,
  PositionImageSchema,
  UploadPositionImageSchema,
} from './position-image';

describe('PositionImageFormatSchema', () => {
  it.each(['png', 'jpeg', 'webp'])('accepts %s', (format) => {
    expect(PositionImageFormatSchema.safeParse(format).success).toBe(true);
  });

  it('rejects an unknown format', () => {
    expect(PositionImageFormatSchema.safeParse('gif').success).toBe(false);
  });
});

describe('POSITION_IMAGE caps', () => {
  it('reuses the advisor per-image byte cap', () => {
    expect(POSITION_IMAGE_MAX_BYTES).toBe(MAX_IMAGE_BYTES_DEFAULT);
  });

  it('caps the count at 10', () => {
    expect(POSITION_IMAGE_MAX_COUNT).toBe(10);
  });
});

describe('UploadPositionImageSchema', () => {
  it('accepts a body at the byte cap', () => {
    const result = UploadPositionImageSchema.safeParse({
      format: 'png',
      dataBase64: 'a'.repeat(POSITION_IMAGE_MAX_BYTES),
    });
    expect(result.success).toBe(true);
  });

  it('rejects a body one byte over the cap with the IMAGE_TOO_LARGE message', () => {
    const result = UploadPositionImageSchema.safeParse({
      format: 'png',
      dataBase64: 'a'.repeat(POSITION_IMAGE_MAX_BYTES + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message === 'IMAGE_TOO_LARGE')).toBe(true);
    }
  });

  it('rejects an empty dataBase64', () => {
    expect(UploadPositionImageSchema.safeParse({ format: 'png', dataBase64: '' }).success).toBe(
      false,
    );
  });
});

describe('PositionImageSchema', () => {
  const id = '11111111-1111-1111-1111-111111111111';
  const createdAt = '2026-09-14T00:00:00.000Z';

  it('accepts a record without unavailable', () => {
    expect(PositionImageSchema.safeParse({ id, format: 'jpeg', createdAt }).success).toBe(true);
  });

  it('accepts unavailable: true', () => {
    expect(
      PositionImageSchema.safeParse({ id, format: 'webp', createdAt, unavailable: true }).success,
    ).toBe(true);
  });

  it('rejects unavailable: false (literal true only)', () => {
    expect(
      PositionImageSchema.safeParse({ id, format: 'png', createdAt, unavailable: false }).success,
    ).toBe(false);
  });
});

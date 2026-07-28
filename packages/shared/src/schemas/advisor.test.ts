import { describe, expect, it } from 'vitest';

import {
  ADVISOR_MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES_DEFAULT,
  MessageContentPartSchema,
  MessageSchema,
  ResponseMessageContentPartSchema,
  StoredContentPartSchema,
  StreamRequestSchema,
  makeStreamRequestSchema,
} from './advisor';

const UUID = '00000000-0000-4000-8000-000000000000';

// The cap validates the ENCODED `dataBase64` STRING length (what Zod sees); the
// bytes are never decoded during validation, so a filler string of the exact
// length is a faithful fixture for the length bound.
function imagePart(encodedLen: number) {
  return { type: 'image' as const, format: 'png' as const, dataBase64: 'a'.repeat(encodedLen) };
}

function bodyWith(attachments: unknown[]) {
  return { clientMessageId: UUID, text: 'hello', attachments };
}

function hasImageTooLarge(error: { issues: { message: string }[] }): boolean {
  return error.issues.some((i) => i.message === 'IMAGE_TOO_LARGE');
}

describe('makeStreamRequestSchema per-image byte cap (REQ-4)', () => {
  const cap = 100;
  const schema = makeStreamRequestSchema(cap);

  it('accepts an image whose encoded dataBase64 length equals the cap (boundary)', () => {
    expect(schema.safeParse(bodyWith([imagePart(cap)])).success).toBe(true);
  });

  it('rejects an image one byte over the cap with IMAGE_TOO_LARGE (before any decode)', () => {
    const res = schema.safeParse(bodyWith([imagePart(cap + 1)]));
    expect(res.success).toBe(false);
    if (res.success) throw new Error('expected failure');
    expect(hasImageTooLarge(res.error)).toBe(true);
  });

  it('still rejects an empty dataBase64 (min(1) retained)', () => {
    expect(schema.safeParse(bodyWith([imagePart(0)])).success).toBe(false);
  });

  it('is operator-overridable: a larger cap admits a payload the default would reject', () => {
    const big = makeStreamRequestSchema(MAX_IMAGE_BYTES_DEFAULT + 10);
    expect(big.safeParse(bodyWith([imagePart(MAX_IMAGE_BYTES_DEFAULT + 5)])).success).toBe(true);
  });
});

describe('StreamRequestSchema default cap = MAX_IMAGE_BYTES_DEFAULT', () => {
  it('accepts an image at exactly the default cap', () => {
    expect(
      StreamRequestSchema.safeParse(bodyWith([imagePart(MAX_IMAGE_BYTES_DEFAULT)])).success,
    ).toBe(true);
  });

  it('rejects an image one byte over the default cap with IMAGE_TOO_LARGE', () => {
    const res = StreamRequestSchema.safeParse(bodyWith([imagePart(MAX_IMAGE_BYTES_DEFAULT + 1)]));
    expect(res.success).toBe(false);
    if (res.success) throw new Error('expected failure');
    expect(hasImageTooLarge(res.error)).toBe(true);
  });
});

describe('StreamRequestSchema attachment count cap (ADVISOR_MAX_IMAGES_PER_MESSAGE)', () => {
  it('accepts the maximum number of images', () => {
    const atts = Array.from({ length: ADVISOR_MAX_IMAGES_PER_MESSAGE }, () => imagePart(8));
    expect(StreamRequestSchema.safeParse(bodyWith(atts)).success).toBe(true);
  });

  it('rejects one more than the maximum number of images', () => {
    const atts = Array.from({ length: ADVISOR_MAX_IMAGES_PER_MESSAGE + 1 }, () => imagePart(8));
    expect(StreamRequestSchema.safeParse(bodyWith(atts)).success).toBe(false);
  });
});

describe('the persisted/read path is NOT capped (REQ-2.2 forward-only)', () => {
  // A legacy oversized inline image row must still validate on read: the cap is a
  // wire/upload constraint on StreamRequestSchema only, never on the shared union
  // that backs MessageSchema.contentParts.
  const oversized = 'a'.repeat(MAX_IMAGE_BYTES_DEFAULT + 1_000);

  it('MessageContentPartSchema accepts an oversized inline image part', () => {
    const res = MessageContentPartSchema.safeParse({
      type: 'image',
      format: 'png',
      dataBase64: oversized,
    });
    expect(res.success).toBe(true);
  });

  it('MessageSchema.contentParts accepts an oversized inline image row', () => {
    const res = MessageSchema.safeParse({
      id: UUID,
      conversationId: UUID,
      role: 'user',
      contentParts: [{ type: 'image', format: 'png', dataBase64: oversized }],
      promptTokens: null,
      completionTokens: null,
      clientMessageId: UUID,
      createdAt: '2026-07-01T00:00:00Z',
    });
    expect(res.success).toBe(true);
  });
});

const inlineImage = { type: 'image' as const, format: 'png' as const, dataBase64: 'abc' };
const storedPointer = {
  type: 'image' as const,
  format: 'jpeg' as const,
  storage: { kind: 'object' as const, key: 'advisor/u/abc' },
};
const storedUnrecoverable = {
  type: 'image' as const,
  format: 'webp' as const,
  storage: { kind: 'unrecoverable' as const },
};
const responsePointer = {
  type: 'image' as const,
  format: 'jpeg' as const,
  storage: 'object' as const,
};
const responseUnrecoverable = {
  type: 'image' as const,
  format: 'webp' as const,
  storage: 'unrecoverable' as const,
};

describe('StoredContentPartSchema (REQ-2.2 persisted shape)', () => {
  it('round-trips an inline (legacy, no marker) image part', () => {
    const res = StoredContentPartSchema.safeParse(inlineImage);
    expect(res.success).toBe(true);
    if (res.success) expect(res.data).toEqual(inlineImage);
  });

  it('round-trips a pointer part (storage.kind=object, keeps the key)', () => {
    const res = StoredContentPartSchema.safeParse(storedPointer);
    expect(res.success).toBe(true);
    if (res.success) expect(res.data).toEqual(storedPointer);
  });

  it('round-trips an unrecoverable part (storage.kind=unrecoverable)', () => {
    const res = StoredContentPartSchema.safeParse(storedUnrecoverable);
    expect(res.success).toBe(true);
    if (res.success) expect(res.data).toEqual(storedUnrecoverable);
  });

  it('is a genuine superset: every CanonicalPart arm parses through', () => {
    const canonical = [
      { type: 'text', text: 'hi' },
      inlineImage,
      { type: 'tool_call', id: 't1', name: 'x', arguments: {} },
      { type: 'tool_result', toolCallId: 't1', status: 'ok', content: {} },
    ];
    for (const part of canonical) {
      expect(StoredContentPartSchema.safeParse(part).success).toBe(true);
    }
  });
});

describe('ResponseMessageContentPartSchema (REQ-2.2/2.4 client shape)', () => {
  it('round-trips an inline (legacy, no marker) image part', () => {
    const res = ResponseMessageContentPartSchema.safeParse(inlineImage);
    expect(res.success).toBe(true);
    if (res.success) expect(res.data).toEqual(inlineImage);
  });

  it('round-trips a pointer part as storage:object with NO key (REQ-2.4)', () => {
    const res = ResponseMessageContentPartSchema.safeParse(responsePointer);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data).toEqual(responsePointer);
      expect(res.data).not.toHaveProperty('storage.key');
    }
  });

  it('round-trips an unrecoverable part as storage:unrecoverable', () => {
    const res = ResponseMessageContentPartSchema.safeParse(responseUnrecoverable);
    expect(res.success).toBe(true);
    if (res.success) expect(res.data).toEqual(responseUnrecoverable);
  });

  it('rejects a response part that leaks the object key (REQ-2.4)', () => {
    const res = ResponseMessageContentPartSchema.safeParse(storedPointer);
    expect(res.success).toBe(false);
  });
});

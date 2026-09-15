// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { ACCEPTED_IMAGE_FORMATS, fileToBase64, imageFilesFromClipboard } from './image-file';

describe('ACCEPTED_IMAGE_FORMATS', () => {
  it('maps the supported image MIME types to their format', () => {
    expect(ACCEPTED_IMAGE_FORMATS['image/png']).toBe('png');
    expect(ACCEPTED_IMAGE_FORMATS['image/jpeg']).toBe('jpeg');
    expect(ACCEPTED_IMAGE_FORMATS['image/webp']).toBe('webp');
  });

  it('has no entry for an unsupported MIME type', () => {
    expect(ACCEPTED_IMAGE_FORMATS['image/gif']).toBeUndefined();
  });
});

describe('fileToBase64', () => {
  it('reads a File and returns the base64 payload without the data-URL prefix', async () => {
    // base64 of "hello" is "aGVsbG8=".
    const file = new File(['hello'], 'shot.png', { type: 'image/png' });
    await expect(fileToBase64(file)).resolves.toBe('aGVsbG8=');
  });
});

describe('imageFilesFromClipboard', () => {
  it('keeps only files whose type starts with image/', () => {
    const png = new File(['x'], 'a.png', { type: 'image/png' });
    const text = new File(['y'], 'b.txt', { type: 'text/plain' });
    const event = { clipboardData: { files: [png, text] } } as unknown as ClipboardEvent;
    expect(imageFilesFromClipboard(event)).toEqual([png]);
  });

  it('returns an empty array when there is no clipboard data', () => {
    const event = { clipboardData: null } as unknown as ClipboardEvent;
    expect(imageFilesFromClipboard(event)).toEqual([]);
  });
});

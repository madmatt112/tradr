// Shared browser-side image helpers: the accepted-format MIME map, the base64
// reader, and the clipboard image filter. Lifted out of the advisor Composer so
// the position screenshots section can reuse them instead of copying (design
// D26).

import type { ClipboardEvent as ReactClipboardEvent } from 'react';

export type ImageFormat = 'png' | 'jpeg' | 'webp';

export const ACCEPTED_IMAGE_FORMATS: Record<string, ImageFormat> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
};

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // strip the `data:<mime>;base64,` prefix — only the payload is persisted.
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// The clipboard image filter the composer's `onPaste` does inline; lifted so the
// position screenshots section can share it (design Component 14).
export function imageFilesFromClipboard(event: ClipboardEvent | ReactClipboardEvent): File[] {
  const data = event.clipboardData;
  if (!data) return [];
  return Array.from(data.files).filter((f) => f.type.startsWith('image/'));
}

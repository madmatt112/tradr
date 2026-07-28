/**
 * UUID v4 helpers with a Math.random fallback for environments where
 * `globalThis.crypto.randomUUID` is unavailable (e.g. HTTP self-host
 * scenarios per design §J).
 *
 * Do NOT introduce a UUID library — `fallbackUuidV4` is intentionally a
 * tiny Math.random implementation.
 */

export function fallbackUuidV4(): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else if (i === 19) out += hex[(Math.floor(Math.random() * 4) + 8) | 0];
    else out += hex[Math.floor(Math.random() * 16) | 0];
  }
  return out;
}

export function newWidgetId(): string {
  return globalThis.crypto?.randomUUID?.() ?? fallbackUuidV4();
}

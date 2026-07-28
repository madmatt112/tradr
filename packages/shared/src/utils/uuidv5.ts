export const WIDGET_DEFAULT_NAMESPACE = '7b91c2a4-1f6c-4e8f-b3d1-9a4f7e2b8c5d';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function parseNamespace(namespace: string): Uint8Array {
  if (!UUID_RE.test(namespace)) {
    throw new Error(`Invalid namespace UUID: ${namespace}`);
  }
  const hex = namespace.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function toHex(byte: number): string {
  return byte.toString(16).padStart(2, '0');
}

function formatUuid(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (let i = 0; i < 16; i += 1) {
    hex.push(toHex(bytes[i]));
  }
  return (
    `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-` +
    `${hex[4]}${hex[5]}-` +
    `${hex[6]}${hex[7]}-` +
    `${hex[8]}${hex[9]}-` +
    `${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`
  );
}

export async function uuidv5(name: string, namespace: string): Promise<string> {
  const namespaceBytes = parseNamespace(namespace);
  const nameBytes = new TextEncoder().encode(name);

  const buf = new Uint8Array(namespaceBytes.length + nameBytes.length);
  buf.set(namespaceBytes, 0);
  buf.set(nameBytes, namespaceBytes.length);

  const digest = await globalThis.crypto.subtle.digest('SHA-1', buf);
  const out = new Uint8Array(digest).slice(0, 16);

  out[6] = (out[6] & 0x0f) | 0x50;
  out[8] = (out[8] & 0x3f) | 0x80;

  return formatUuid(out);
}

export async function uuidv5Batch(names: string[], namespace: string): Promise<string[]> {
  return Promise.all(names.map((n) => uuidv5(n, namespace)));
}

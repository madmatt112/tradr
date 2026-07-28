import { describe, expect, it } from 'vitest';

import { uuidv5, uuidv5Batch, WIDGET_DEFAULT_NAMESPACE } from './uuidv5';

const CANONICAL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('uuidv5', () => {
  // 1. RFC 4122 DNS-namespace vector
  it('returns the RFC 4122 DNS-namespace test vector', async () => {
    const result = await uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8');
    expect(result).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  // 2. Synthetic vector under WIDGET_DEFAULT_NAMESPACE — canonical format
  it('produces canonical-format output under WIDGET_DEFAULT_NAMESPACE', async () => {
    const result = await uuidv5('test-user-id:stats-summary', WIDGET_DEFAULT_NAMESPACE);
    expect(result).toHaveLength(36);
    expect(result).toMatch(CANONICAL_RE);
    // version nibble (char 14) must be '5'
    expect(result.charAt(14)).toBe('5');
    // variant nibble (char 19) must be in 8|9|a|b
    expect('89ab').toContain(result.charAt(19));
  });

  // 3. Idempotence
  it('returns byte-identical strings on repeated calls with same inputs', async () => {
    const a = await uuidv5('test-user-id:stats-summary', WIDGET_DEFAULT_NAMESPACE);
    const b = await uuidv5('test-user-id:stats-summary', WIDGET_DEFAULT_NAMESPACE);
    expect(a).toBe(b);
  });

  // 4. uuidv5Batch preserves input order
  it('preserves input order in uuidv5Batch (zipped over index)', async () => {
    const names = ['a:one', 'b:two', 'c:three', 'd:four'];
    const batch = await uuidv5Batch(names, WIDGET_DEFAULT_NAMESPACE);
    const expected = await Promise.all(names.map((n) => uuidv5(n, WIDGET_DEFAULT_NAMESPACE)));
    expect(batch).toEqual(expected);
  });

  // 5. Malformed namespace throws
  it('throws when the namespace is malformed', async () => {
    await expect(uuidv5('anything', 'not-a-uuid')).rejects.toThrow();
  });
});

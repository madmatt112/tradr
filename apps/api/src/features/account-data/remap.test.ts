import { describe, expect, it } from 'vitest';

import { createCoveredThroughResolver, newSalt, orderedMessageIds, remapId } from './remap';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newSalt', () => {
  it('draws 32 fresh bytes each call', () => {
    const a = newSalt();
    const b = newSalt();
    expect(a).toHaveLength(32);
    expect(b).toHaveLength(32);
    expect(a.equals(b)).toBe(false);
  });
});

describe('remapId', () => {
  const salt = newSalt();

  it('is deterministic per salt', () => {
    expect(remapId(salt, 'source-1')).toBe(remapId(salt, 'source-1'));
  });

  it('differs across salts for the same id', () => {
    const other = newSalt();
    expect(remapId(salt, 'source-1')).not.toBe(remapId(other, 'source-1'));
  });

  it('sets the version-4 and variant nibbles', () => {
    const id = remapId(salt, 'source-1');
    expect(id).toMatch(UUID_V4_RE);
    expect(id[14]).toBe('4'); // version
    expect('89ab').toContain(id[19]); // variant 10xx
  });

  it('does not collide over 250,000 ids', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 250_000; i += 1) {
      seen.add(remapId(salt, `source-${i}`));
    }
    expect(seen.size).toBe(250_000);
  });
});

describe('orderedMessageIds', () => {
  const salt = newSalt();

  it('is deterministic per salt and differs across salts', () => {
    const a = orderedMessageIds(salt, 'conv-1', 5);
    expect(orderedMessageIds(salt, 'conv-1', 5)).toEqual(a);
    expect(orderedMessageIds(newSalt(), 'conv-1', 5)).not.toEqual(a);
  });

  it('returns distinct canonical v4 uuids', () => {
    const ids = orderedMessageIds(salt, 'conv-1', 100);
    expect(ids).toHaveLength(100);
    expect(new Set(ids).size).toBe(100);
    for (const id of ids) {
      expect(id).toMatch(UUID_V4_RE);
    }
  });

  it('assigns ids in archive order when every created_at ties', () => {
    // With tied timestamps, archive order is the message index order. The i-th
    // message takes the i-th entry, so a later read `ORDER BY (created_at, id)`
    // reproduces archive order iff the entries are sorted ascending (design P5).
    const ids = orderedMessageIds(salt, 'conv-1', 200);
    expect(ids).toEqual([...ids].sort());
  });
});

describe('createCoveredThroughResolver', () => {
  const salt = newSalt();

  it('resolves a covered id inside the recorded set to its ordered message id', () => {
    const covered = new Set(['m2']);
    const resolver = createCoveredThroughResolver(salt, covered);

    // Five messages stream past in archive order.
    for (let i = 0; i < 5; i += 1) {
      resolver.record(`m${i}`, 'conv-1');
    }

    // m2 is the third message (index 2) of a five-message conversation.
    const expected = orderedMessageIds(salt, 'conv-1', 5)[2];
    expect(resolver.resolve('m2')).toBe(expected);
  });

  it('returns null for a pointer that names no archived message', () => {
    const resolver = createCoveredThroughResolver(salt, new Set(['m0']));
    resolver.record('m0', 'conv-1');
    expect(resolver.resolve('missing')).toBeNull();
  });

  it('returns null for a real message id that fell past the cap', () => {
    // The validator stopped seeding ids at the cap, so this real message id is
    // absent from the seed set and never recorded — the advisory pointer is lost.
    const seededUpToCap = new Set(['m0', 'm1']);
    const resolver = createCoveredThroughResolver(salt, seededUpToCap);
    resolver.record('m0', 'conv-1');
    resolver.record('m1', 'conv-1');
    resolver.record('m2', 'conv-1'); // past the cap, not seeded
    expect(resolver.resolve('m2')).toBeNull();
  });
});

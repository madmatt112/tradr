import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderModel } from '@tradr/shared';

import { ListModelsCache } from './list-models-cache';

const models = (id: string): ProviderModel[] => [
  { id, displayName: id, contextWindow: 200_000, vision: true, toolUse: false },
];

describe('ListModelsCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches once and serves subsequent calls from cache', async () => {
    const cache = new ListModelsCache();
    const fetchFn = vi.fn().mockResolvedValue(models('claude-opus-4-7'));

    const first = await cache.get('claude', 'sk-secret', fetchFn);
    const second = await cache.get('claude', 'sk-secret', fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(first).toEqual(models('claude-opus-4-7'));
    expect(second).toBe(first);
  });

  it('keys on provider + apiKey so different keys do not collide', async () => {
    const cache = new ListModelsCache();
    const claudeFetch = vi.fn().mockResolvedValue(models('claude'));
    const openaiFetch = vi.fn().mockResolvedValue(models('gpt-4o'));
    const otherKeyFetch = vi.fn().mockResolvedValue(models('other'));

    await cache.get('claude', 'key-a', claudeFetch);
    await cache.get('openai', 'key-a', openaiFetch);
    await cache.get('claude', 'key-b', otherKeyFetch);

    expect(claudeFetch).toHaveBeenCalledTimes(1);
    expect(openaiFetch).toHaveBeenCalledTimes(1);
    expect(otherKeyFetch).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after the TTL expires', async () => {
    const cache = new ListModelsCache(2000, 600_000);
    const fetchFn = vi.fn().mockResolvedValue(models('claude'));

    await cache.get('claude', 'sk', fetchFn);
    vi.advanceTimersByTime(600_001);
    await cache.get('claude', 'sk', fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('evicts the least-recently-used entry when at capacity', async () => {
    const cache = new ListModelsCache(2);
    const fetchFn = vi.fn().mockResolvedValue(models('m'));

    await cache.get('claude', 'a', fetchFn); // a
    await cache.get('claude', 'b', fetchFn); // a, b
    await cache.get('claude', 'a', fetchFn); // refreshes a -> b is now oldest
    await cache.get('claude', 'c', fetchFn); // evicts b

    expect(fetchFn).toHaveBeenCalledTimes(3);

    await cache.get('claude', 'a', fetchFn); // still cached
    expect(fetchFn).toHaveBeenCalledTimes(3);

    await cache.get('claude', 'b', fetchFn); // evicted -> re-fetch
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });
});

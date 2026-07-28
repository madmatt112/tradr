import { createHash } from 'node:crypto';

import type { ProviderModel } from '@tradr/shared';

type ProviderId = 'claude' | 'openai' | 'gemini' | 'openrouter';

interface CacheEntry {
  models: ProviderModel[];
  expiresAt: number;
}

/**
 * Per-(provider, apiKey) cache for `listModels` results.
 *
 * Keyed on `${providerId}:${sha256(apiKey).slice(0, 16)}` so the raw API key is
 * never stored or logged (REQ-6.11 / REQ-12.1). Backed by a plain `Map`, whose
 * insertion-order iteration gives LRU eviction semantics: on a full cache the
 * oldest key is evicted; on read of an expired entry it is evicted and the value
 * re-fetched. No stale-while-revalidate — `fetchFn` is awaited synchronously on a
 * miss.
 */
export class ListModelsCache {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly maxEntries = 2000,
    private readonly ttlMs = 600_000,
  ) {}

  async get(
    providerId: ProviderId,
    apiKey: string,
    fetchFn: () => Promise<ProviderModel[]>,
  ): Promise<ProviderModel[]> {
    const key = this.keyFor(providerId, apiKey);
    const existing = this.cache.get(key);

    if (existing) {
      if (existing.expiresAt > Date.now()) {
        // Refresh recency: re-insert so the entry moves to the most-recent end.
        this.cache.delete(key);
        this.cache.set(key, existing);
        return existing.models;
      }
      // Expired: evict and fall through to re-fetch.
      this.cache.delete(key);
    }

    const models = await fetchFn();
    this.set(key, models);
    return models;
  }

  private set(key: string, models: ProviderModel[]): void {
    if (!this.cache.has(key) && this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(key, { models, expiresAt: Date.now() + this.ttlMs });
  }

  private keyFor(providerId: ProviderId, apiKey: string): string {
    const hash = createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
    return `${providerId}:${hash}`;
  }
}

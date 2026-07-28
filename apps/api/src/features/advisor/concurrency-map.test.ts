import { describe, expect, it } from 'vitest';

import { StreamInProgressError } from './advisor.errors';
import { ConcurrencyMap } from './concurrency-map';

describe('ConcurrencyMap', () => {
  it('acquires a slot and returns a non-aborted combinedSignal', () => {
    const map = new ConcurrencyMap();
    const { combinedSignal } = map.acquire('user-1', new AbortController().signal);
    expect(combinedSignal.aborted).toBe(false);
  });

  it('throws StreamInProgressError on double-acquire for the same user', () => {
    const map = new ConcurrencyMap();
    map.acquire('user-1', new AbortController().signal);
    expect(() => map.acquire('user-1', new AbortController().signal)).toThrow(
      StreamInProgressError,
    );
  });

  it('release frees the slot synchronously so the user can re-acquire', () => {
    const map = new ConcurrencyMap();
    const { release } = map.acquire('user-1', new AbortController().signal);
    release();
    // No setTimeout: a fresh acquire must succeed immediately.
    expect(() => map.acquire('user-1', new AbortController().signal)).not.toThrow();
  });

  it('aborts combinedSignal when the external signal aborts', () => {
    const map = new ConcurrencyMap();
    const external = new AbortController();
    const { combinedSignal } = map.acquire('user-1', external.signal);
    external.abort();
    expect(combinedSignal.aborted).toBe(true);
  });
});

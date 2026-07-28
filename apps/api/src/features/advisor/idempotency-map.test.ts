import { afterEach, describe, expect, it, vi } from 'vitest';

import { IdempotencyMap } from './idempotency-map';

const U = 'user-1';
const C = 'conv-1';
const M = 'msg-1';

describe('IdempotencyMap', () => {
  afterEach(() => {
    // Defensive: ensure no test leaves fake timers installed for the global
    // DB-transaction test harness (this module is pure — fake timers are scoped
    // to the single TTL test below).
    vi.useRealTimers();
  });

  it('peek returns miss for an unknown key, hit-in-progress after reserve', () => {
    const map = new IdempotencyMap();
    expect(map.peek(U, C, M)).toEqual({ kind: 'miss' });

    map.reserve(U, C, M, new AbortController());
    expect(map.peek(U, C, M)).toEqual({ kind: 'hit-in-progress' });
  });

  it('markDone transitions in-progress → done and does NOT delete the entry', () => {
    const map = new IdempotencyMap();
    map.reserve(U, C, M, new AbortController());

    map.markDone(U, C, M, 'assistant-99');

    // Entry persists as done (Layer-2 hit reachable) — not removed.
    expect(map.peek(U, C, M)).toEqual({
      kind: 'hit-done',
      assistantMessageId: 'assistant-99',
    });
  });

  it('removeIdempotencyEntry clears the entry (error/cleanup path only)', () => {
    const map = new IdempotencyMap();
    map.reserve(U, C, M, new AbortController());

    map.removeIdempotencyEntry(U, C, M);

    expect(map.peek(U, C, M)).toEqual({ kind: 'miss' });
  });

  it('keys distinguish conversationId from clientMessageId for the same user', () => {
    const map = new IdempotencyMap();
    map.reserve(U, 'conv-a', 'msg-x', new AbortController());

    expect(map.peek(U, 'conv-a', 'msg-x')).toEqual({ kind: 'hit-in-progress' });
    expect(map.peek(U, 'conv-b', 'msg-x')).toEqual({ kind: 'miss' });
    expect(map.peek(U, 'conv-a', 'msg-y')).toEqual({ kind: 'miss' });
  });

  it('evicts the oldest per-user entry once the 256 cap is exceeded', () => {
    const map = new IdempotencyMap();
    // Insert 257 entries: the first (oldest) is evicted, the rest survive.
    for (let i = 0; i < 257; i += 1) {
      map.reserve(U, C, `msg-${i}`, new AbortController());
    }

    expect(map.peek(U, C, 'msg-0')).toEqual({ kind: 'miss' });
    expect(map.peek(U, C, 'msg-1')).toEqual({ kind: 'hit-in-progress' });
    expect(map.peek(U, C, 'msg-256')).toEqual({ kind: 'hit-in-progress' });
  });

  it('evicts across users once the global cap (100,000) is exceeded', () => {
    const map = new IdempotencyMap();
    // 100,000 entries spread one-per-user fills the global cap exactly; the
    // 100,001st entry (new user) pushes globalCount over and evicts user-0's.
    for (let i = 0; i < 100_000; i += 1) {
      map.reserve(`u-${i}`, C, M, new AbortController());
    }
    expect(map.peek('u-0', C, M)).toEqual({ kind: 'hit-in-progress' });

    map.reserve('u-100000', C, M, new AbortController());

    expect(map.peek('u-0', C, M)).toEqual({ kind: 'miss' });
    expect(map.peek('u-100000', C, M)).toEqual({ kind: 'hit-in-progress' });
  });

  it('expires entries after the 1-hour TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T00:00:00.000Z'));
    const map = new IdempotencyMap();
    map.reserve(U, C, M, new AbortController());
    expect(map.peek(U, C, M)).toEqual({ kind: 'hit-in-progress' });

    // Just under 1 hour: still present.
    vi.advanceTimersByTime(60 * 60 * 1000 - 1);
    expect(map.peek(U, C, M)).toEqual({ kind: 'hit-in-progress' });

    // At/after 1 hour: expired and evicted.
    vi.advanceTimersByTime(1);
    expect(map.peek(U, C, M)).toEqual({ kind: 'miss' });
  });
});

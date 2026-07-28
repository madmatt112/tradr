import { afterEach, describe, expect, it, vi } from 'vitest';

import { asyncLocalStorage, logger, setLogUser } from './logger';

/** Spy on console.log and parse each emitted JSON line into an entry array. */
function captureStdout() {
  const entries: Record<string, unknown>[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => {
    entries.push(JSON.parse(line));
  });
  return entries;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logger field standardization', () => {
  it('emits level/message/timestamp/requestId for an unconfigured request (additive fields permitted)', () => {
    const entries = captureStdout();

    asyncLocalStorage.run({ requestId: 'req-1' }, () => {
      logger.info('hello');
    });

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    // REQ-5.3: assert presence (NOT byte-identity) — additive fields are allowed.
    expect(entry.level).toBe('info');
    expect(entry.message).toBe('hello');
    expect(typeof entry.timestamp).toBe('string');
    expect(entry.requestId).toBe('req-1');
    // No auth/feature context ⇒ those optional fields are absent.
    expect(entry.userId).toBeUndefined();
    expect(entry.feature).toBeUndefined();
  });

  it('spreads userId/feature into the entry only when present in the store', () => {
    const entries = captureStdout();

    asyncLocalStorage.run({ requestId: 'req-2', userId: 'u-9', feature: 'positions' }, () => {
      logger.info('with context');
    });

    expect(entries[0].userId).toBe('u-9');
    expect(entries[0].feature).toBe('positions');
  });

  it('setLogUser mutates the current store; no-op (no throw) without a store', () => {
    const entries = captureStdout();

    asyncLocalStorage.run({ requestId: 'req-3' }, () => {
      setLogUser('u-42');
      logger.info('after setLogUser');
    });
    expect(entries[0].userId).toBe('u-42');

    // Outside any ALS scope: safe no-op.
    expect(() => setLogUser('ignored')).not.toThrow();
    logger.info('no store');
    expect(entries[1].userId).toBeUndefined();
  });
});

// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal sessionStorage polyfill for node environment. We deliberately avoid
// pulling in jsdom/happy-dom for a single hook unit test — the production
// behavior we exercise is the read/write/exception flow, not the DOM.
class MemoryStorage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  key(i: number): string | null {
    return Array.from(this.store.keys())[i] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

// Install the polyfill so the hook's `sessionStorage.getItem/setItem` calls resolve.
const storage = new MemoryStorage();
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: storage,
});
// Also expose Storage so vi.spyOn(Storage.prototype, ...) works.
Object.defineProperty(globalThis, 'Storage', {
  configurable: true,
  value: MemoryStorage,
});

import {
  __resetInvalidTimezoneState,
  clearRejectedTimezone,
  isTimezoneRejected,
  readRejectedTimezone,
  recordRejectedTimezone,
} from '@/lib/invalidTimezone';

import {
  __resetUsePerformanceModuleState,
  handlePerformanceQueryError,
  isInvalidTimezoneError,
  performanceRetry,
} from './usePerformance';

const BAD_TZ = 'Foo/Bar';

beforeEach(() => {
  storage.clear();
  __resetUsePerformanceModuleState();
  __resetInvalidTimezoneState();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isInvalidTimezoneError', () => {
  it('detects service-level INVALID_TIMEZONE code', () => {
    expect(
      isInvalidTimezoneError({ error: { code: 'INVALID_TIMEZONE', message: 'Invalid timezone' } }),
    ).toBe(true);
  });

  it('detects Zod VALIDATION_ERROR with invalid-timezone tz detail', () => {
    expect(
      isInvalidTimezoneError({
        error: { code: 'VALIDATION_ERROR', details: { tz: 'Invalid timezone: Foo/Bar' } },
      }),
    ).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isInvalidTimezoneError({ error: { code: 'CONFLICT' } })).toBe(false);
    expect(
      isInvalidTimezoneError({
        error: { code: 'VALIDATION_ERROR', details: { start: 'Invalid date' } },
      }),
    ).toBe(false);
    expect(isInvalidTimezoneError(null)).toBe(false);
    expect(isInvalidTimezoneError('nope')).toBe(false);
  });
});

describe('performanceRetry — at-most-one INVALID_TIMEZONE retry per rejected zone', () => {
  it('two INVALID_TIMEZONE failures for the same zone yield exactly ONE retry total', () => {
    const err = { error: { code: 'INVALID_TIMEZONE' } };

    // Failure #1: this zone has not been rejected before → retry once.
    expect(performanceRetry(0, err, BAD_TZ)).toBe(true);
    expect(sessionStorage.getItem('perf.invalid_tz')).toBe(BAD_TZ);

    // The retried request fails again with INVALID_TIMEZONE: TanStack would
    // call the retry decision with failureCount=1. Either branch (>=1 OR
    // already-rejected) must refuse.
    expect(performanceRetry(1, err, BAD_TZ)).toBe(false);

    // A *separate* mount asking for the same zone also refuses.
    expect(performanceRetry(0, err, BAD_TZ)).toBe(false);
  });

  it('a DIFFERENT zone still gets its own retry — the record is not session-wide', () => {
    const err = { error: { code: 'INVALID_TIMEZONE' } };
    expect(performanceRetry(0, err, BAD_TZ)).toBe(true);

    // The user corrected the preference and the new zone is also rejected: it
    // must get its own single retry rather than inheriting the old zone's.
    expect(performanceRetry(0, err, 'Baz/Qux')).toBe(true);
    expect(readRejectedTimezone()).toBe('Baz/Qux');
  });

  it('refuses when the failing request carried no zone (the server rejected its own default)', () => {
    const err = { error: { code: 'INVALID_TIMEZONE' } };
    expect(performanceRetry(0, err, undefined)).toBe(false);
    expect(performanceRetry(0, err, null)).toBe(false);
    expect(readRejectedTimezone()).toBeNull();
  });

  it('does not retry non-INVALID_TIMEZONE errors', () => {
    expect(performanceRetry(0, { error: { code: 'INTERNAL' } }, BAD_TZ)).toBe(false);
    expect(performanceRetry(0, { status: 500 }, BAD_TZ)).toBe(false);
    expect(performanceRetry(0, new Error('network down'), BAD_TZ)).toBe(false);
  });

  it('Safari private-mode: sessionStorage.setItem throws → fallback prevents retry storm', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setItemSpy = vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    const err = { error: { code: 'INVALID_TIMEZONE' } };

    // First failure consumes the one allowed retry; zone kept in the module-local fallback.
    expect(performanceRetry(0, err, BAD_TZ)).toBe(true);
    // Subsequent failures must refuse — even though sessionStorage cannot
    // record the zone, the in-memory fallback does.
    expect(performanceRetry(0, err, BAD_TZ)).toBe(false);
    expect(performanceRetry(0, err, BAD_TZ)).toBe(false);

    expect(setItemSpy).toHaveBeenCalled();
    // Warned exactly once across the storm.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('Safari private-mode: sessionStorage.getItem throws → fallback path still works', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    const err = { error: { code: 'INVALID_TIMEZONE' } };
    expect(performanceRetry(0, err, BAD_TZ)).toBe(true);
    expect(performanceRetry(0, err, BAD_TZ)).toBe(false);
    // Reads and writes must AGREE in this mode, or the banner describes a
    // fallback the request did not make.
    expect(isTimezoneRejected(BAD_TZ)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});

describe('rejected-timezone record — lifecycle', () => {
  it('clearRejectedTimezone re-arms the retry for the zone that was rejected', () => {
    const err = { error: { code: 'INVALID_TIMEZONE' } };
    recordRejectedTimezone(BAD_TZ);
    expect(performanceRetry(0, err, BAD_TZ)).toBe(false);

    // What a reporting-timezone change does.
    clearRejectedTimezone();
    expect(readRejectedTimezone()).toBeNull();
    expect(isTimezoneRejected(BAD_TZ)).toBe(false);
    expect(performanceRetry(0, err, BAD_TZ)).toBe(true);
  });

  it('only the recorded zone is treated as rejected', () => {
    recordRejectedTimezone(BAD_TZ);
    expect(isTimezoneRejected(BAD_TZ)).toBe(true);
    expect(isTimezoneRejected('Europe/London')).toBe(false);
    expect(isTimezoneRejected(undefined)).toBe(false);
  });

  it('clearRejectedTimezone wins when removeItem throws but reads still succeed', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    recordRejectedTimezone(BAD_TZ);
    // Only the write side fails here. Reads keep working and prefer
    // sessionStorage, which still holds the zone the clear could not remove —
    // so without the staleness guard the clear is silently a no-op and the tab
    // stays pinned to the tz-omitted fallback for the rest of the session.
    vi.spyOn(storage, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    clearRejectedTimezone();

    expect(storage.getItem('perf.invalid_tz')).toBe(BAD_TZ);
    expect(readRejectedTimezone()).toBeNull();
    expect(isTimezoneRejected(BAD_TZ)).toBe(false);
  });

  it('clearRejectedTimezone survives a storage that throws on removeItem', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    recordRejectedTimezone(BAD_TZ);
    vi.spyOn(storage, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    clearRejectedTimezone();
    // The in-memory fallback is what the Safari-private path reads, so it must
    // be cleared even when the storage write cannot be.
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(isTimezoneRejected(BAD_TZ)).toBe(false);
  });
});

describe('handlePerformanceQueryError — 401 guard via shared isUnauthorized', () => {
  it('does NOT invalidate ["performance"] when error.status === 401', () => {
    const qc = { invalidateQueries: vi.fn() };
    handlePerformanceQueryError({ status: 401, error: { code: 'OTHER' } }, qc);
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
  });

  it('does NOT invalidate ["performance"] when error.code === "UNAUTHORIZED"', () => {
    const qc = { invalidateQueries: vi.fn() };
    handlePerformanceQueryError({ error: { code: 'UNAUTHORIZED', message: 'expired' } }, qc);
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
  });

  it('does NOT invalidate ["performance"] when message === "Unauthorized" (api.ts thrown shape)', () => {
    const qc = { invalidateQueries: vi.fn() };
    const err = new Error('Unauthorized') as Error & { status?: number };
    err.status = 401;
    handlePerformanceQueryError(err, qc);
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
  });

  it('invalidates ["performance"] for transient non-4xx errors (e.g., 500)', () => {
    const qc = { invalidateQueries: vi.fn() };
    handlePerformanceQueryError({ status: 500, error: { code: 'INTERNAL' } }, qc);
    expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['performance'] });
  });

  it('does NOT invalidate ["performance"] for a 400 VALIDATION_ERROR (no refetch loop)', () => {
    const qc = { invalidateQueries: vi.fn() };
    handlePerformanceQueryError(
      { status: 400, error: { code: 'VALIDATION_ERROR', details: { end: 'end too large' } } },
      qc,
    );
    // A refetch returns the same 400 → invalidating here would loop forever.
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
  });

  it('does NOT invalidate ["performance"] for any other 4xx (e.g., 404)', () => {
    const qc = { invalidateQueries: vi.fn() };
    handlePerformanceQueryError({ status: 404, error: { code: 'NOT_FOUND' } }, qc);
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
  });
});

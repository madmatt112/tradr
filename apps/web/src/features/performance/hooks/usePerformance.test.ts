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
  __resetUsePerformanceModuleState,
  handlePerformanceQueryError,
  isInvalidTimezoneError,
  performanceRetry,
} from './usePerformance';

beforeEach(() => {
  storage.clear();
  __resetUsePerformanceModuleState();
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

describe('performanceRetry — at-most-one INVALID_TIMEZONE retry per session', () => {
  it('two INVALID_TIMEZONE failures in one session yield exactly ONE retry total', () => {
    const err = { error: { code: 'INVALID_TIMEZONE' } };

    // Failure #1: first time the session has seen INVALID_TIMEZONE → retry once.
    expect(performanceRetry(0, err)).toBe(true);
    expect(sessionStorage.getItem('perf.invalid_tz_seen')).toBe('true');

    // The retried request fails again with INVALID_TIMEZONE: TanStack would
    // call the retry decision with failureCount=1. Either branch (>=1 OR
    // session-flag) must refuse.
    expect(performanceRetry(1, err)).toBe(false);

    // A *separate* mount in the same session also refuses (session flag).
    expect(performanceRetry(0, err)).toBe(false);
  });

  it('does not retry non-INVALID_TIMEZONE errors', () => {
    expect(performanceRetry(0, { error: { code: 'INTERNAL' } })).toBe(false);
    expect(performanceRetry(0, { status: 500 })).toBe(false);
    expect(performanceRetry(0, new Error('network down'))).toBe(false);
  });

  it('Safari private-mode: sessionStorage.setItem throws → fallback prevents retry storm', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setItemSpy = vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    const err = { error: { code: 'INVALID_TIMEZONE' } };

    // First failure consumes the one allowed retry; flag set in module-local fallback.
    expect(performanceRetry(0, err)).toBe(true);
    // Subsequent failures must refuse — even though sessionStorage cannot
    // record the flag, the in-memory fallback does.
    expect(performanceRetry(0, err)).toBe(false);
    expect(performanceRetry(0, err)).toBe(false);

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
    expect(performanceRetry(0, err)).toBe(true);
    expect(performanceRetry(0, err)).toBe(false);
    expect(warn).toHaveBeenCalled();
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

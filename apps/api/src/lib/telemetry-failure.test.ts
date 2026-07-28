import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { logger } from './logger';
import { logTelemetryFailureOnce, WARN_WINDOW_MS } from './telemetry-failure';

// The guard keeps a module-local Map of last-logged timestamps that persists
// across the tests in this file. Start each test an hour past the previous one
// so no prior entry can sit inside the current test's suppression window.
let base = new Date('2026-06-16T00:00:00Z').getTime();

describe('logTelemetryFailureOnce', () => {
  let warnSpy: MockInstance;

  beforeEach(() => {
    vi.useFakeTimers();
    base += 60 * 60 * 1000; // 1h after the previous test's base
    vi.setSystemTime(base);
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it('logs once on the first failure for a surface', () => {
    logTelemetryFailureOnce('posthog', new Error('boom'));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('telemetry failure', {
      surface: 'posthog',
      error: 'boom',
    });
  });

  it('suppresses a second failure within the 5-minute window', () => {
    logTelemetryFailureOnce('posthog', new Error('first'));
    vi.advanceTimersByTime(WARN_WINDOW_MS - 1);
    logTelemetryFailureOnce('posthog', new Error('second'));
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('re-logs after the window has elapsed', () => {
    logTelemetryFailureOnce('posthog', new Error('first'));
    vi.advanceTimersByTime(WARN_WINDOW_MS);
    logTelemetryFailureOnce('posthog', new Error('second'));
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('logs a string reason, never a vendor response body', () => {
    // A non-Error thrown value carrying a sensitive "response body".
    logTelemetryFailureOnce('posthog', { status: 401, body: { secret: 'leak' } });
    const extra = warnSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(typeof extra.error).toBe('string');
    // String(object) -> '[object Object]'; the body is NOT serialized/attached.
    expect(extra.error).toBe('[object Object]');
    expect(JSON.stringify(extra)).not.toContain('leak');
  });
});

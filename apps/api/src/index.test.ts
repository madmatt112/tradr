import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the batching PostHog client so we control flush timing without a live
// vendor. initPostHog/captureServerEvent are stubbed to no-ops because importing
// index.ts pulls them in; only the flush fn is exercised.
const h = vi.hoisted(() => ({
  shutdownPostHog: vi.fn<() => Promise<void>>(),
}));

vi.mock('@/lib/posthog', () => ({
  initPostHog: vi.fn(),
  captureServerEvent: vi.fn(),
  shutdownPostHog: h.shutdownPostHog,
}));

import { flushTelemetry, TELEMETRY_FLUSH_TIMEOUT_MS } from './index';

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the client resolves immediately (the unconfigured no-op path).
  h.shutdownPostHog.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('flushTelemetry', () => {
  it('resolves instantly when the client is unconfigured (no timer advance)', async () => {
    vi.useFakeTimers();

    // allSettled resolves on the microtask queue; the timeout race never has to
    // fire, so awaiting resolves without advancing fake timers (zero added
    // latency vs today).
    await expect(flushTelemetry()).resolves.toBeUndefined();
    expect(h.shutdownPostHog).toHaveBeenCalledTimes(1);
  });

  it('is bounded by TELEMETRY_FLUSH_TIMEOUT_MS when a flush hangs', async () => {
    vi.useFakeTimers();
    h.shutdownPostHog.mockReturnValueOnce(new Promise<void>(() => {})); // never resolves

    const p = flushTelemetry();
    await vi.advanceTimersByTimeAsync(TELEMETRY_FLUSH_TIMEOUT_MS);

    await expect(p).resolves.toBeUndefined();
  });

  it('is idempotent under double-invoke (does not throw)', async () => {
    vi.useFakeTimers();

    await expect(flushTelemetry()).resolves.toBeUndefined();
    await expect(flushTelemetry()).resolves.toBeUndefined();
    expect(h.shutdownPostHog).toHaveBeenCalledTimes(2);
  });

  it('does not reject when the flush fn rejects (goes through allSettled)', async () => {
    vi.useFakeTimers();
    h.shutdownPostHog.mockRejectedValueOnce(new Error('flush down'));

    await expect(flushTelemetry()).resolves.toBeUndefined();
  });
});

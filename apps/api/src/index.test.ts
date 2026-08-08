import fs from 'node:fs';
import path from 'node:path';

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

// ---------------------------------------------------------------------------
// Shutdown-ordering tripwire (metrics-instrumentation REQ-2.8).
//
// `main()` runs only under `NODE_ENV !== 'test'` and its `shutdown` closure is
// not exported, so no behavioural test reaches the ordering at all — moving
// `metricsServer?.close()` past `sql.end()` currently reds nothing. Rather than
// restructure the bootstrap to make a signal handler drivable, this asserts the
// order over the SOURCE, the `ledger-hook.ts` tripwire precedent in
// accounting.service.test.ts (which likewise checks a property whose real
// enforcement lives elsewhere). It cannot prove the handler behaves; it can and
// does prove the one line whose position is the requirement.
//
// Kept deliberately narrow — three tokens, nothing else. Anything the
// requirement does not pin (statement wrapping, comments, the order of the two
// concurrent `Promise.all` drains) must be free to change without reddening it.
// ---------------------------------------------------------------------------

describe('shutdown ordering in index.ts (REQ-2.8) — source tripwire', () => {
  it('closes the metrics listener after server.close() and before sql.end()', () => {
    const source = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf-8');

    // Comments are stripped first, BOTH line-leading and trailing: the shutdown
    // block's own prose NAMES `sql.end()` above the line being located, and
    // index.ts already carries trailing comments on the shutdown statements, so
    // an index taken over the raw text would order the comments rather than the
    // code. Stripping can only ever remove text, so the worst it can do is turn
    // a token unfindable — which fails loudly on the "not found" assertion.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '') // block and JSDoc comments
      .replace(/\/\/.*$/gm, ''); // line comments, leading or trailing

    // Scoped to the shutdown closure, because `flushTelemetry` is also DECLARED
    // earlier in the file and a whole-file search would find that declaration
    // instead of the call.
    const start = code.indexOf('const shutdown = async');
    expect(start, 'the shutdown closure was not found in index.ts').toBeGreaterThanOrEqual(0);
    const shutdownBody = code.slice(start);

    // Only the three tokens the requirement is actually about. The drains are
    // deliberately NOT pinned: they sit inside a `Promise.all`, so swapping them
    // is a semantic no-op that must not red this test.
    //
    // `server.close()` does not match inside `metricsServer?.close()` — that
    // reads `Server?.close()`, capitalised and with the optional chain.
    const ORDER = ['server.close()', 'metricsServer?.close()', 'sql.end()'];

    const positions = ORDER.map((token) => ({ token, at: shutdownBody.indexOf(token) }));
    for (const { token, at } of positions) {
      expect(at, `not found in shutdown(): ${token}`).toBeGreaterThanOrEqual(0);
    }

    for (let i = 1; i < positions.length; i++) {
      const before = positions[i - 1]!;
      const after = positions[i]!;
      expect(
        before.at,
        `${before.token} must come before ${after.token} in shutdown() — REQ-2.8 requires ${ORDER.join(' → ')}, because the collectors probe the database on every scrape: the listener has to stop after the server stops accepting connections and before the pool is torn down`,
      ).toBeLessThan(after.at);
    }
  });
});

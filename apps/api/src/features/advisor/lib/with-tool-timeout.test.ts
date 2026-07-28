import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TOOL_RESULT_CODES } from '../tools/error-codes';
import type { ToolResult } from '../tools/types';

import { PER_TOOL_TIMEOUT_MS, withToolTimeout } from './with-tool-timeout';

describe('withToolTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns the handler result unchanged when it resolves before the timeout', async () => {
    const ok: ToolResult = { status: 'ok', content: { hits: 3 } };
    const controller = new AbortController();

    const result = await withToolTimeout(async () => ok, PER_TOOL_TIMEOUT_MS, controller);

    expect(result).toEqual(ok);
    expect(controller.signal.aborted).toBe(false);
  });

  it('yields TOOL_TIMEOUT (tool_result bucket) and aborts the controller on a slow tool', async () => {
    const controller = new AbortController();
    let observedAbort = false;

    // A handler that honors ctx.signal: it only settles when aborted, modelling
    // an in-flight tool the timeout must cancel.
    const run = (signal: AbortSignal): Promise<ToolResult> =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          observedAbort = true;
          resolve({ status: 'ok', content: 'late' });
        });
      });

    const promise = withToolTimeout(run, PER_TOOL_TIMEOUT_MS, controller);

    await vi.advanceTimersByTimeAsync(PER_TOOL_TIMEOUT_MS);
    const result = await promise;

    expect(result).toEqual({
      status: 'error',
      code: TOOL_RESULT_CODES.TOOL_TIMEOUT,
      message: expect.stringContaining(`${PER_TOOL_TIMEOUT_MS}ms`),
    });
    // The handler observed its ctx.signal abort (handler + UW socket cancelled).
    expect(controller.signal.aborted).toBe(true);
    expect(observedAbort).toBe(true);
  });

  it('passes the controller signal into run so the handler reads ctx.signal', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;

    await withToolTimeout(
      async (signal) => {
        seen = signal;
        return { status: 'ok', content: null };
      },
      PER_TOOL_TIMEOUT_MS,
      controller,
    );

    expect(seen).toBe(controller.signal);
  });

  it('creates and owns a controller when the loop does not supply one', async () => {
    let seen: AbortSignal | undefined;

    const result = await withToolTimeout(async (signal) => {
      seen = signal;
      return { status: 'ok', content: 'self-owned' };
    });

    expect(seen).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({ status: 'ok', content: 'self-owned' });
  });

  it('clears the timer on success — no leaked timer fires afterward', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const controller = new AbortController();

    await withToolTimeout(
      async () => ({ status: 'ok', content: 1 }),
      PER_TOOL_TIMEOUT_MS,
      controller,
    );

    expect(clearSpy).toHaveBeenCalledTimes(1);
    // No pending timers remain, so the controller is never aborted later.
    await vi.advanceTimersByTimeAsync(PER_TOOL_TIMEOUT_MS * 2);
    expect(controller.signal.aborted).toBe(false);
  });

  it('clears the timer when the handler rejects', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const controller = new AbortController();
    const boom = new Error('handler blew up');

    await expect(
      withToolTimeout(async () => Promise.reject(boom), PER_TOOL_TIMEOUT_MS, controller),
    ).rejects.toBe(boom);

    expect(clearSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PER_TOOL_TIMEOUT_MS * 2);
    expect(controller.signal.aborted).toBe(false);
  });
});

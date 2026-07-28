import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger, setLogUser } from '@/lib/logger';

import { loggingMiddleware } from './logging.middleware';

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

describe('loggingMiddleware field standardization', () => {
  it('authed /api/<feature>/… logs (incl. the moved request line) carry feature + userId', async () => {
    const entries = captureStdout();

    const app = new Hono();
    app.use(loggingMiddleware);
    app.get('/api/positions/:id', (c) => {
      setLogUser('user-abc'); // simulates auth.middleware after c.set('userId', …)
      logger.info('handler ran');
      return c.json({ ok: true });
    });

    await app.request('/api/positions/123');

    const handlerLine = entries.find((e) => e.message === 'handler ran');
    const requestLine = entries.find((e) => e.message === 'request');

    expect(handlerLine?.feature).toBe('positions');
    expect(handlerLine?.userId).toBe('user-abc');

    // The moved 'request' line fires inside the ALS scope ⇒ correlated.
    expect(requestLine).toBeDefined();
    expect(requestLine?.feature).toBe('positions');
    expect(requestLine?.userId).toBe('user-abc');
    expect(typeof requestLine?.requestId).toBe('string');
    expect(requestLine?.status).toBe(200);
  });

  it('a non-/api path yields feature: undefined', async () => {
    const entries = captureStdout();

    const app = new Hono();
    app.use(loggingMiddleware);
    app.get('/health', (c) => {
      logger.info('handler ran');
      return c.json({ ok: true });
    });

    await app.request('/health');

    const handlerLine = entries.find((e) => e.message === 'handler ran');
    const requestLine = entries.find((e) => e.message === 'request');

    expect(handlerLine?.feature).toBeUndefined();
    expect(requestLine?.feature).toBeUndefined();
    expect(requestLine?.userId).toBeUndefined();
  });
});

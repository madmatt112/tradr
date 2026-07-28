// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { eventBus } from './event-bus.store';

describe('event-bus.store', () => {
  afterEach(() => {
    eventBus.__resetForTests();
  });

  it('publish without subscriber is a silent no-op', () => {
    expect(() =>
      eventBus.publish('positions:cache-invalidate', { reason: 'created' }),
    ).not.toThrow();
  });

  it('single subscriber receives the payload', () => {
    const handler = vi.fn();
    eventBus.subscribe('positions:cache-invalidate', handler);
    eventBus.publish('positions:cache-invalidate', { reason: 'updated', positionId: 'p1' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ reason: 'updated', positionId: 'p1' });
  });

  it('multiple subscribers all receive', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    const h3 = vi.fn();
    eventBus.subscribe('positions:cache-invalidate', h1);
    eventBus.subscribe('positions:cache-invalidate', h2);
    eventBus.subscribe('positions:cache-invalidate', h3);
    eventBus.publish('positions:cache-invalidate', { reason: 'opened' });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
    expect(h3).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops the handler', () => {
    const handler = vi.fn();
    const unsubscribe = eventBus.subscribe('positions:cache-invalidate', handler);
    unsubscribe();
    eventBus.publish('positions:cache-invalidate', { reason: 'closed' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('throwing handler does not crash the publisher and logs to console.error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const thrower = vi.fn(() => {
      throw new Error('boom');
    });
    const next = vi.fn();
    eventBus.subscribe('positions:cache-invalidate', thrower);
    eventBus.subscribe('positions:cache-invalidate', next);
    expect(() =>
      eventBus.publish('positions:cache-invalidate', { reason: 'deleted' }),
    ).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain('positions:cache-invalidate');
    errorSpy.mockRestore();
  });

  it('reentrant subscribe during publish does not fire the newly-added handler this round', () => {
    const late = vi.fn();
    const first = vi.fn(() => {
      eventBus.subscribe('positions:cache-invalidate', late);
    });
    eventBus.subscribe('positions:cache-invalidate', first);
    eventBus.publish('positions:cache-invalidate', { reason: 'fill-added' });
    expect(first).toHaveBeenCalledTimes(1);
    expect(late).not.toHaveBeenCalled();
    eventBus.publish('positions:cache-invalidate', { reason: 'fill-updated' });
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('__resetForTests clears all subscribers', () => {
    const handler = vi.fn();
    eventBus.subscribe('positions:cache-invalidate', handler);
    eventBus.__resetForTests();
    eventBus.publish('positions:cache-invalidate', { reason: 'fill-deleted' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('source file does not import zustand', () => {
    const source = readFileSync(
      path.resolve(__dirname, 'event-bus.store.ts'),
      'utf8',
    );
    expect(source.includes('zustand')).toBe(false);
  });
});

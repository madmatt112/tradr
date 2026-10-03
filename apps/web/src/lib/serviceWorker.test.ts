// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { registerServiceWorker, type RegisterDeps } from './serviceWorker';

// --- fakes for the injected side effects ------------------------------------

function makeContainer(registerImpl?: (...args: unknown[]) => Promise<unknown>) {
  return {
    register: vi.fn(registerImpl ?? (() => Promise.resolve({}))),
    addEventListener: vi.fn(),
  };
}

function makeWin() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener: vi.fn((type: string, fn: () => void) => {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(fn);
    }),
    fire(type: string) {
      for (const fn of Array.from(listeners.get(type) ?? [])) fn();
    },
  };
}

/*
 * Contract: registerServiceWorker(deps)
 *
 * 1. does not register when not in production (Requirement 2.2)
 *    Pre-condition: isProd deps flag is false; a container is supplied.
 *    Call: registerServiceWorker({ isProd: false, container, win, readyState }).
 *    Observable result: container.register is never called.
 *    Source: design C3 post-conditions — "returns at once when isProd is false".
 *
 * 2. does not register when no service worker container is available (Requirement 2.3)
 *    Pre-condition: isProd is true; container is undefined (no SW support).
 *    Call: registerServiceWorker({ isProd: true, container: undefined, win, readyState }).
 *    Observable result: no throw, and no listener is added to win (nothing to wait for).
 *    Source: design C3 post-conditions — "returns at once when ... container is undefined";
 *    Requirement 2.3 — no service worker support continues with no error.
 *
 * 3. defers registration until the window load event when the document is still loading
 *    (Requirement 2.1, 2.2)
 *    Pre-condition: isProd true, container present, readyState() returns 'loading'.
 *    Call: registerServiceWorker({ isProd: true, container, win, readyState }), then win.fire('load').
 *    Observable result: container.register is not called before 'load' fires, and is called
 *    with ('/sw.js', { scope: '/' }) exactly once after it fires.
 *    Source: design C3 post-conditions — register on window 'load', path '/sw.js' scope '/'.
 *
 * 4. registers immediately when the document is already complete (Requirement 2.1, 2.2)
 *    Pre-condition: isProd true, container present, readyState() returns 'complete'.
 *    Call: registerServiceWorker({ isProd: true, container, win, readyState }).
 *    Observable result: container.register is called at once, with no listener added to win,
 *    with the same ('/sw.js', { scope: '/' }) arguments.
 *    Source: design C3 post-conditions — "or at once when document.readyState is complete".
 *
 * 5. swallows a registration rejection without throwing (Requirement 2.3)
 *    Pre-condition: isProd true, container present and readyState 'complete'; container.register
 *    returns a rejected promise.
 *    Call: registerServiceWorker({ isProd: true, container, win, readyState }).
 *    Observable result: the call returns without throwing synchronously, and the rejection does
 *    not surface as an unhandled rejection by the time a microtask flush completes.
 *    Source: design C3 post-conditions — "swallows a rejection"; Requirement 2.3 — registration
 *    failure continues with no error shown.
 *
 * 6. adds no controllerchange listener on the container (Requirement 2.7)
 *    Pre-condition: isProd true, container present (with an addEventListener spy) and readyState
 *    'complete'.
 *    Call: registerServiceWorker({ isProd: true, container, win, readyState }).
 *    Observable result: container.addEventListener is never called.
 *    Source: design C3 post-conditions — "adds no controllerchange listener"; Requirement 2.7 —
 *    no listener on controller change shall reload the page.
 */

describe('registerServiceWorker', () => {
  it('does not register when not in production', () => {
    const container = makeContainer();
    const win = makeWin();

    registerServiceWorker({
      isProd: false,
      container: container as unknown as RegisterDeps['container'],
      win: win as unknown as RegisterDeps['win'],
      readyState: () => 'complete',
    });

    expect(container.register).not.toHaveBeenCalled();
  });

  it('does not register when no service worker container is available', () => {
    const win = makeWin();

    expect(() =>
      registerServiceWorker({
        isProd: true,
        container: undefined,
        win: win as unknown as RegisterDeps['win'],
        readyState: () => 'complete',
      }),
    ).not.toThrow();

    expect(win.addEventListener).not.toHaveBeenCalled();
  });

  it('defers registration until the window load event when the document is still loading', () => {
    const container = makeContainer();
    const win = makeWin();

    registerServiceWorker({
      isProd: true,
      container: container as unknown as RegisterDeps['container'],
      win: win as unknown as RegisterDeps['win'],
      readyState: () => 'loading',
    });

    expect(container.register).not.toHaveBeenCalled();

    win.fire('load');

    expect(container.register).toHaveBeenCalledTimes(1);
    expect(container.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('registers immediately when the document is already complete', () => {
    const container = makeContainer();
    const win = makeWin();

    registerServiceWorker({
      isProd: true,
      container: container as unknown as RegisterDeps['container'],
      win: win as unknown as RegisterDeps['win'],
      readyState: () => 'complete',
    });

    expect(container.register).toHaveBeenCalledTimes(1);
    expect(container.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(win.addEventListener).not.toHaveBeenCalled();
  });

  it('swallows a registration rejection without throwing', async () => {
    const container = makeContainer(() => Promise.reject(new Error('boom')));
    const win = makeWin();
    const onUnhandledRejection = vi.fn();
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      expect(() =>
        registerServiceWorker({
          isProd: true,
          container: container as unknown as RegisterDeps['container'],
          win: win as unknown as RegisterDeps['win'],
          readyState: () => 'complete',
        }),
      ).not.toThrow();

      // Flush the microtask queue so an unhandled rejection would have surfaced.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(onUnhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('adds no controllerchange listener on the container', () => {
    const container = makeContainer();
    const win = makeWin();

    registerServiceWorker({
      isProd: true,
      container: container as unknown as RegisterDeps['container'],
      win: win as unknown as RegisterDeps['win'],
      readyState: () => 'complete',
    });

    expect(container.addEventListener).not.toHaveBeenCalled();
  });
});

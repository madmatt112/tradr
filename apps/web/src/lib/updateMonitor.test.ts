// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOCALDEV } from './api';
import {
  CHECK_INTERVAL_MS,
  createUpdateMonitor,
  fetchServedVersion,
  getUpdateMonitor,
  parseServedVersion,
  UPDATE_CHANNEL,
  VERSION_SHAPE,
  __resetUpdateMonitorForTests,
  type MonitorDeps,
  type RouterLike,
} from './updateMonitor';

// A response-like object for the injected fetch — avoids depending on a global
// Response constructor while covering the `.ok` / `.status` / `.text()` surface
// fetchServedVersion reads.
function makeResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

// --- stubs for the injected side effects ------------------------------------

function makeDoc(initial: DocumentVisibilityState = 'visible') {
  const listeners = new Map<string, Set<() => void>>();
  const doc = {
    visibilityState: initial,
    addEventListener: vi.fn((type: string, fn: () => void) => {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn);
    }),
    fire(type: string) {
      for (const fn of Array.from(listeners.get(type) ?? [])) fn();
    },
    setVisibility(v: DocumentVisibilityState) {
      doc.visibilityState = v;
      doc.fire('visibilitychange');
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
  return doc;
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
    removeEventListener: vi.fn((type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn);
    }),
    fire(type: string) {
      for (const fn of Array.from(listeners.get(type) ?? [])) fn();
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

function makeChannelStub() {
  let messageListener: ((ev: MessageEvent) => void) | null = null;
  const postMessage = vi.fn();
  const close = vi.fn();
  const addEventListener = vi.fn((type: string, fn: (ev: MessageEvent) => void) => {
    if (type === 'message') messageListener = fn;
  });
  const removeEventListener = vi.fn(() => {
    messageListener = null;
  });
  const channel = {
    name: UPDATE_CHANNEL,
    addEventListener,
    removeEventListener,
    postMessage,
    close,
  } as unknown as BroadcastChannel;
  return {
    channel,
    postMessage,
    close,
    addEventListener,
    removeEventListener,
    inbound(data: unknown) {
      messageListener?.({ data } as MessageEvent);
    },
    hasListener() {
      return messageListener !== null;
    },
  };
}

function makeRouter() {
  let onResolved: (() => void) | null = null;
  const unsub = vi.fn(() => {
    onResolved = null;
  });
  const subscribe = vi.fn((_event: 'onResolved', cb: () => void) => {
    onResolved = cb;
    return unsub;
  });
  return {
    router: { subscribe } as unknown as RouterLike,
    fireNavigation() {
      onResolved?.();
    },
    unsub,
    subscribe,
  };
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function setup(opts?: {
  boot?: string;
  served?: string | undefined;
  visibility?: DocumentVisibilityState;
  withChannel?: boolean;
  withRouter?: boolean;
}) {
  const boot = opts?.boot ?? 'v1.0.0';
  const doc = makeDoc(opts?.visibility ?? 'visible');
  const win = makeWin();
  const chan = opts?.withChannel === false ? null : makeChannelStub();
  const fetchServed = vi.fn(async () => opts?.served);
  const reload = vi.fn();
  const router = makeRouter();
  const nowRef = { value: 0 };

  const monitor = createUpdateMonitor({
    bootVersion: boot,
    fetchServed,
    now: () => nowRef.value,
    doc: doc as unknown as MonitorDeps['doc'],
    win: win as unknown as MonitorDeps['win'],
    channel: () => (chan ? chan.channel : undefined),
    reload,
  });

  async function advance(ms: number) {
    nowRef.value += ms;
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
  }

  function startMonitor() {
    monitor.start(opts?.withRouter ? { router: router.router } : {});
  }

  return { monitor, doc, win, chan, fetchServed, reload, router, advance, startMonitor };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('parseServedVersion', () => {
  it('reads the production printf shape', () => {
    const text = 'window.__TRADR_CONFIG__={"advisorImageMaxBytes":4500000,"appVersion":"v0.13.0"};';
    expect(parseServedVersion(text)).toBe('v0.13.0');
  });

  it('returns undefined for the entrypoint all-unset literal', () => {
    const text = 'window.__TRADR_CONFIG__={"advisorImageMaxBytes":4500000};';
    expect(parseServedVersion(text)).toBeUndefined();
  });

  it('is not confused by json_str-escaped quotes in another field', () => {
    const text = 'window.__TRADR_CONFIG__={"note":"a\\"b","appVersion":"v0.13.0"};';
    expect(parseServedVersion(text)).toBe('v0.13.0');
  });

  it('decodes escaped quotes in the value, then charset-gates it away', () => {
    // json_str escapes are honoured (JSON.parse decodes `v1\"2` → `v1"2`), and
    // the decoded value fails VERSION_SHAPE because it contains a quote.
    const text = 'window.__TRADR_CONFIG__={"appVersion":"v1\\"2"};';
    expect(parseServedVersion(text)).toBeUndefined();
  });

  it('returns undefined for the single-quoted dev object shape', () => {
    const text = "window.__TRADR_CONFIG__ = { appVersion: 'v9.9.9' };";
    expect(parseServedVersion(text)).toBeUndefined();
  });

  it('accepts a 64-char value but rejects a 65-char value', () => {
    const ok = 'v' + '0'.repeat(63); // 64 chars
    const tooLong = 'v' + '0'.repeat(64); // 65 chars
    expect(parseServedVersion(`x={"appVersion":"${ok}"};`)).toBe(ok);
    expect(parseServedVersion(`x={"appVersion":"${tooLong}"};`)).toBeUndefined();
  });

  it('returns undefined for an empty value', () => {
    expect(parseServedVersion('x={"appVersion":""};')).toBeUndefined();
  });

  it('returns undefined for a value with a space (v1 2)', () => {
    expect(parseServedVersion('x={"appVersion":"v1 2"};')).toBeUndefined();
  });

  it('returns undefined for a value with a slash (../x)', () => {
    expect(parseServedVersion('x={"appVersion":"../x"};')).toBeUndefined();
  });
});

describe('fetchServedVersion', () => {
  it('returns the parsed version on a 200 with a config body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResponse('window.__TRADR_CONFIG__={"appVersion":"v1.2.3"};'));
    await expect(fetchServedVersion({ fetch: fetchMock as unknown as typeof fetch })).resolves.toBe(
      'v1.2.3',
    );
  });

  it('returns undefined on 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse('', 404));
    await expect(
      fetchServedVersion({ fetch: fetchMock as unknown as typeof fetch }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined on 500', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse('', 500));
    await expect(
      fetchServedVersion({ fetch: fetchMock as unknown as typeof fetch }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined on a network reject', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network'));
    await expect(
      fetchServedVersion({ fetch: fetchMock as unknown as typeof fetch }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when the fetch aborts on timeout', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const promise = fetchServedVersion({
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 10_000,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toBeUndefined();
  });

  it('requests GET /config.js with cache no-store, credentials omit — not via resolveApiUrl', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResponse('window.__TRADR_CONFIG__={"appVersion":"v1.2.3"};'));
    await fetchServedVersion({ fetch: fetchMock as unknown as typeof fetch });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/config.js');
    expect(url).not.toContain('/api');
    expect(init.cache).toBe('no-store');
    expect(init.credentials).toBe('omit');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.method).toBeUndefined(); // default GET
  });
});

describe('state machine', () => {
  it('starts idle and check() before start() makes no fetch', async () => {
    const { monitor, fetchServed } = setup();
    expect(monitor.getSnapshot().phase).toBe('idle');
    await monitor.check('chunk-failure');
    expect(fetchServed).not.toHaveBeenCalled();
  });

  it('start() moves idle → polling', () => {
    const { monitor, startMonitor } = setup();
    startMonitor();
    expect(monitor.getSnapshot().phase).toBe('polling');
  });

  it('a newer served version enters update-available and broadcasts once', async () => {
    const { monitor, startMonitor, chan } = setup({ boot: 'v1.0.0', served: 'v1.0.1' });
    startMonitor();
    await monitor.check('chunk-failure');
    const snap = monitor.getSnapshot();
    expect(snap.phase).toBe('update-available');
    expect(snap.servedVersion).toBe('v1.0.1');
    expect(snap.learnedVia).toBe('poll');
    expect(snap.promptVisible).toBe(true);
    expect(chan?.postMessage).toHaveBeenCalledTimes(1);
    expect(chan?.postMessage).toHaveBeenCalledWith({
      type: 'update-available',
      servedVersion: 'v1.0.1',
    });
  });

  it('an OLDER served version (rollback) also enters update-available', async () => {
    const { monitor, startMonitor } = setup({ boot: 'v2.0.0', served: 'v1.0.0' });
    startMonitor();
    await monitor.check('chunk-failure');
    const snap = monitor.getSnapshot();
    expect(snap.phase).toBe('update-available');
    expect(snap.servedVersion).toBe('v1.0.0');
  });

  it('an equal served version stays polling and never broadcasts', async () => {
    const { monitor, startMonitor, chan } = setup({ boot: 'v1.0.0', served: 'v1.0.0' });
    startMonitor();
    await monitor.check('chunk-failure');
    expect(monitor.getSnapshot().phase).toBe('polling');
    expect(chan?.postMessage).not.toHaveBeenCalled();
  });

  it('an unknown (undefined) served version stays polling', async () => {
    const { monitor, startMonitor } = setup({ boot: 'v1.0.0', served: undefined });
    startMonitor();
    await monitor.check('chunk-failure');
    expect(monitor.getSnapshot().phase).toBe('polling');
  });

  it('a localdev boot is inert: zero fetches across 30 fake minutes and any triggers', async () => {
    const { monitor, startMonitor, fetchServed, doc, win, advance } = setup({
      boot: LOCALDEV,
      served: 'v1.0.1',
    });
    expect(monitor.getSnapshot().phase).toBe('inert');
    startMonitor();
    expect(monitor.getSnapshot().phase).toBe('inert');
    doc.setVisibility('hidden');
    doc.setVisibility('visible');
    win.fire('focus');
    await monitor.check('chunk-failure');
    await advance(30 * 60_000);
    expect(fetchServed).not.toHaveBeenCalled();
  });

  it("check('chunk-failure') after update-available makes no fetch and no postMessage", async () => {
    const { monitor, startMonitor, fetchServed, chan } = setup({
      boot: 'v1.0.0',
      served: 'v1.0.1',
    });
    startMonitor();
    await monitor.check('chunk-failure');
    expect(fetchServed).toHaveBeenCalledTimes(1);
    expect(chan?.postMessage).toHaveBeenCalledTimes(1);
    await monitor.check('chunk-failure');
    expect(fetchServed).toHaveBeenCalledTimes(1);
    expect(chan?.postMessage).toHaveBeenCalledTimes(1);
  });
});

describe('scheduling', () => {
  it('makes no fetch while hidden across 30 fake minutes', async () => {
    const { startMonitor, fetchServed, advance } = setup({ visibility: 'hidden' });
    startMonitor();
    await advance(30 * 60_000);
    expect(fetchServed).not.toHaveBeenCalled();
  });

  it('fetches once when the tab becomes visible', async () => {
    const { startMonitor, fetchServed, doc, advance } = setup({ visibility: 'hidden' });
    startMonitor();
    await advance(31_000); // past spacing, still hidden so no interval
    doc.setVisibility('visible');
    await flush();
    expect(fetchServed).toHaveBeenCalledTimes(1);
  });

  it('drops a focus check within 30 s of boot and fetches after', async () => {
    const { startMonitor, fetchServed, win, advance } = setup();
    startMonitor();
    await advance(10_000);
    win.fire('focus');
    await flush();
    expect(fetchServed).not.toHaveBeenCalled();
    await advance(31_000); // now 41 s
    win.fire('focus');
    await flush();
    expect(fetchServed).toHaveBeenCalledTimes(1);
  });

  it('drops a navigation check within 30 s of boot and fetches after', async () => {
    const { startMonitor, fetchServed, router, advance } = setup({ withRouter: true });
    startMonitor();
    await advance(10_000);
    router.fireNavigation();
    await flush();
    expect(fetchServed).not.toHaveBeenCalled();
    await advance(31_000);
    router.fireNavigation();
    await flush();
    expect(fetchServed).toHaveBeenCalledTimes(1);
  });

  it('a chunk-failure check bypasses the 30 s spacing', async () => {
    const { monitor, startMonitor, fetchServed, advance } = setup();
    startMonitor();
    await advance(5_000); // within spacing
    await monitor.check('chunk-failure');
    expect(fetchServed).toHaveBeenCalledTimes(1);
  });

  it('the interval fires at 5, 10 and 15 minutes while visible', async () => {
    const { startMonitor, fetchServed, advance } = setup();
    startMonitor();
    await advance(CHECK_INTERVAL_MS);
    expect(fetchServed).toHaveBeenCalledTimes(1);
    await advance(CHECK_INTERVAL_MS);
    expect(fetchServed).toHaveBeenCalledTimes(2);
    await advance(CHECK_INTERVAL_MS);
    expect(fetchServed).toHaveBeenCalledTimes(3);
  });

  it('makes no further fetch after update-available (interval cleared)', async () => {
    const { monitor, startMonitor, fetchServed, advance } = setup({
      boot: 'v1.0.0',
      served: 'v1.0.1',
    });
    startMonitor();
    await advance(CHECK_INTERVAL_MS);
    expect(fetchServed).toHaveBeenCalledTimes(1);
    expect(monitor.getSnapshot().phase).toBe('update-available');
    await advance(CHECK_INTERVAL_MS * 3);
    expect(fetchServed).toHaveBeenCalledTimes(1);
  });
});

describe('cross-tab broadcast', () => {
  it('enters update-available from a valid inbound message without re-posting', () => {
    const { monitor, startMonitor, chan } = setup({ boot: 'v1.0.0' });
    startMonitor();
    chan?.inbound({ type: 'update-available', servedVersion: 'v1.0.1' });
    const snap = monitor.getSnapshot();
    expect(snap.phase).toBe('update-available');
    expect(snap.servedVersion).toBe('v1.0.1');
    expect(snap.learnedVia).toBe('broadcast');
    expect(snap.promptVisible).toBe(true);
    expect(chan?.postMessage).not.toHaveBeenCalled();
  });

  it('ignores an inbound message equal to the boot version', () => {
    const { monitor, startMonitor, chan } = setup({ boot: 'v1.0.0' });
    startMonitor();
    chan?.inbound({ type: 'update-available', servedVersion: 'v1.0.0' });
    expect(monitor.getSnapshot().phase).toBe('polling');
  });

  it('ignores malformed inbound shapes', () => {
    const { monitor, startMonitor, chan } = setup({ boot: 'v1.0.0' });
    startMonitor();
    chan?.inbound({ servedVersion: 'v1.0.1' }); // missing type
    chan?.inbound({ type: 'update-available', servedVersion: 123 }); // not a string
    chan?.inbound({ type: 'update-available', servedVersion: 'a'.repeat(65) }); // too long
    chan?.inbound({ type: 'update-available', servedVersion: 'v1 2' }); // bad char
    chan?.inbound('not an object');
    chan?.inbound(null);
    expect(monitor.getSnapshot().phase).toBe('polling');
  });

  it('a different inbound version replaces the served version and re-arms after a dismissal', () => {
    const { monitor, startMonitor, chan } = setup({ boot: 'v1.0.0' });
    startMonitor();
    chan?.inbound({ type: 'update-available', servedVersion: 'v1.0.1' });
    monitor.dismiss();
    expect(monitor.getSnapshot().promptVisible).toBe(false);
    chan?.inbound({ type: 'update-available', servedVersion: 'v1.0.2' });
    const snap = monitor.getSnapshot();
    expect(snap.servedVersion).toBe('v1.0.2');
    expect(snap.promptVisible).toBe(true);
    expect(chan?.postMessage).not.toHaveBeenCalled();
  });

  it('still detects an update with no BroadcastChannel available', async () => {
    const { monitor, startMonitor } = setup({
      boot: 'v1.0.0',
      served: 'v1.0.1',
      withChannel: false,
    });
    startMonitor();
    await monitor.check('chunk-failure');
    const snap = monitor.getSnapshot();
    expect(snap.phase).toBe('update-available');
    expect(snap.promptVisible).toBe(true);
  });
});

describe('dismiss / accept / stop', () => {
  it('dismiss() is tab-local (no broadcast) and hides the prompt', async () => {
    const { monitor, startMonitor, chan } = setup({ boot: 'v1.0.0', served: 'v1.0.1' });
    startMonitor();
    await monitor.check('chunk-failure');
    const postsBefore = chan?.postMessage.mock.calls.length ?? 0;
    monitor.dismiss();
    expect(monitor.getSnapshot().promptVisible).toBe(false);
    expect(monitor.getSnapshot().phase).toBe('update-available');
    expect(chan?.postMessage.mock.calls.length).toBe(postsBefore);
  });

  it('accept() calls the injected reload exactly once', async () => {
    const { monitor, startMonitor, reload } = setup({ boot: 'v1.0.0', served: 'v1.0.1' });
    startMonitor();
    await monitor.check('chunk-failure');
    monitor.accept();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('stop() removes every listener and closes the channel', () => {
    const { monitor, startMonitor, doc, win, chan, router } = setup({ withRouter: true });
    startMonitor();
    expect(doc.listenerCount('visibilitychange')).toBe(1);
    expect(win.listenerCount('focus')).toBe(1);
    expect(chan?.hasListener()).toBe(true);
    monitor.stop();
    expect(doc.listenerCount('visibilitychange')).toBe(0);
    expect(win.listenerCount('focus')).toBe(0);
    expect(router.unsub).toHaveBeenCalledTimes(1);
    expect(chan?.close).toHaveBeenCalledTimes(1);
    expect(chan?.removeEventListener).toHaveBeenCalled();
    expect(monitor.getSnapshot().phase).toBe('idle');
  });

  it('stop() is idempotent', () => {
    const { monitor, startMonitor } = setup();
    startMonitor();
    monitor.stop();
    expect(() => monitor.stop()).not.toThrow();
    expect(monitor.getSnapshot().phase).toBe('idle');
  });
});

describe('snapshot and subscription', () => {
  it('getSnapshot() is referentially stable until state changes', () => {
    const { monitor, startMonitor } = setup();
    const first = monitor.getSnapshot();
    expect(monitor.getSnapshot()).toBe(first);
    startMonitor();
    expect(monitor.getSnapshot()).not.toBe(first);
  });

  it('notifies subscribers on a state change and stops after unsubscribe', async () => {
    const { monitor, startMonitor } = setup({ boot: 'v1.0.0', served: 'v1.0.1' });
    const listener = vi.fn();
    const unsubscribe = monitor.subscribe(listener);
    startMonitor();
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    listener.mockClear();
    await monitor.check('chunk-failure');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('getUpdateMonitor singleton', () => {
  afterEach(() => {
    __resetUpdateMonitorForTests();
  });

  it('lazily creates one instance (localdev boot ⇒ inert) and returns the same reference', () => {
    const a = getUpdateMonitor();
    const b = getUpdateMonitor();
    expect(a).toBe(b);
    expect(a.getSnapshot().phase).toBe('inert');
    expect(a.getSnapshot().bootVersion).toBe(LOCALDEV);
  });

  it('__resetUpdateMonitorForTests forgets the singleton', () => {
    const a = getUpdateMonitor();
    __resetUpdateMonitorForTests();
    const b = getUpdateMonitor();
    expect(a).not.toBe(b);
  });
});

describe('VERSION_SHAPE', () => {
  it('accepts real version strings and rejects unsafe ones', () => {
    expect(VERSION_SHAPE.test('v0.13.0')).toBe(true);
    expect(VERSION_SHAPE.test('v0.13.0-abc1234')).toBe(true);
    expect(VERSION_SHAPE.test('')).toBe(false);
    expect(VERSION_SHAPE.test('v1 2')).toBe(false);
    expect(VERSION_SHAPE.test('a'.repeat(65))).toBe(false);
  });
});

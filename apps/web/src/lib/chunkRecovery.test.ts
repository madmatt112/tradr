// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHUNK_LOAD_REGEX,
  RELOAD_GUARD_PREFIX,
  attemptAutomaticReload,
  installChunkRecovery,
  isChunkLoadError,
  reloadAfterChunkFailure,
  __resetChunkRecoveryForTests,
  type RecoveryDeps,
} from './chunkRecovery';
import { __resetUpdateMonitorForTests } from './updateMonitor';

// --- fakes for the injected side effects ------------------------------------

function makeStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  const storage = {
    getItem: vi.fn((k: string) => (map.has(k) ? (map.get(k) as string) : null)),
    setItem: vi.fn((k: string, v: string) => {
      map.set(k, v);
    }),
    removeItem: vi.fn((k: string) => {
      map.delete(k);
    }),
    key: vi.fn((i: number) => Array.from(map.keys())[i] ?? null),
    get length() {
      return map.size;
    },
    map,
  };
  return storage as unknown as RecoveryDeps['storage'] & typeof storage;
}

// A window stub with a fixed origin so same-/cross-origin cases are deterministic.
function makeWin(origin = 'https://app.example') {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    location: { origin } as Location,
  } as unknown as RecoveryDeps['win'];
}

// Set the boot version appVersion() reads, restoring the previous config after.
function withBootVersion(version: string | undefined, fn: () => void) {
  const prev = window.__TRADR_CONFIG__;
  window.__TRADR_CONFIG__ = version === undefined ? undefined : { appVersion: version };
  try {
    fn();
  } finally {
    window.__TRADR_CONFIG__ = prev;
  }
}

beforeEach(() => {
  __resetUpdateMonitorForTests();
  __resetChunkRecoveryForTests();
});

afterEach(() => {
  __resetChunkRecoveryForTests();
  __resetUpdateMonitorForTests();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('the vite:preloadError listener', () => {
  function dispatch(payload: unknown) {
    const event = new Event('vite:preloadError');
    (event as { payload?: unknown }).payload = payload;
    window.dispatchEvent(event);
    return event;
  }

  it('tags the payload so it is a chunk error by identity, even with an unrelated message', () => {
    const capture = vi.fn();
    installChunkRecovery({ capture, nudge: vi.fn(), storage: makeStorage() });
    const payload = new Error('unrelated');
    expect(isChunkLoadError(payload)).toBe(false);
    dispatch(payload);
    expect(isChunkLoadError(payload)).toBe(true);
  });

  it('captures chunk_load_failed with reloadPermitted true, then false once the guard is spent', () => {
    const capture = vi.fn();
    installChunkRecovery({ capture, nudge: vi.fn(), storage: makeStorage() });
    dispatch(new Error('boom'));
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][0]).toBe('chunk_load_failed');
    expect(capture.mock.calls[0][1]).toMatchObject({
      servedVersion: 'unknown',
      reloadPermitted: true,
      errorName: 'Error',
    });
    // Spend the one reload, then a second failure reports the guard as unavailable.
    expect(attemptAutomaticReload()).toBe(true);
    dispatch(new Error('boom again'));
    expect(capture.mock.calls[1][1]).toMatchObject({ reloadPermitted: false });
  });

  it('nudges the monitor with a chunk-failure check', () => {
    const nudge = vi.fn();
    installChunkRecovery({ capture: vi.fn(), nudge, storage: makeStorage() });
    dispatch(new Error('boom'));
    expect(nudge).toHaveBeenCalledTimes(1);
  });

  it('never calls preventDefault (deviation 1)', () => {
    installChunkRecovery({ capture: vi.fn(), nudge: vi.fn(), storage: makeStorage() });
    const event = dispatch(new Error('boom'));
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('attemptAutomaticReload guard', () => {
  it('returns true the first time and false the second (same document latch)', () => {
    installChunkRecovery({ nudge: vi.fn(), storage: makeStorage() });
    expect(attemptAutomaticReload()).toBe(true);
    expect(attemptAutomaticReload()).toBe(false);
  });

  it('returns false when the key is already set', () => {
    withBootVersion('v1.0.0', () => {
      installChunkRecovery({
        nudge: vi.fn(),
        storage: makeStorage({ 'tradr.chunk-reload.v1.0.0': '1' }),
      });
      expect(attemptAutomaticReload()).toBe(false);
    });
  });

  it('returns false when getItem throws (Safari private mode)', () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error('denied');
      }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      key: vi.fn(() => null),
      length: 0,
    } as unknown as RecoveryDeps['storage'];
    installChunkRecovery({ nudge: vi.fn(), storage });
    expect(attemptAutomaticReload()).toBe(false);
  });

  it('returns false when setItem throws', () => {
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error('quota');
      }),
      removeItem: vi.fn(),
      key: vi.fn(() => null),
      length: 0,
    } as unknown as RecoveryDeps['storage'];
    installChunkRecovery({ nudge: vi.fn(), storage });
    expect(attemptAutomaticReload()).toBe(false);
  });

  it('writes the key named for the boot version', () => {
    withBootVersion('v9.9.9', () => {
      const storage = makeStorage();
      installChunkRecovery({ nudge: vi.fn(), storage });
      expect(attemptAutomaticReload()).toBe(true);
      const set = (storage as unknown as { setItem: ReturnType<typeof vi.fn> }).setItem;
      expect(set.mock.calls[0][0]).toBe('tradr.chunk-reload.v9.9.9');
    });
  });

  it('uses the localdev key when no version is set', () => {
    withBootVersion(undefined, () => {
      const storage = makeStorage();
      installChunkRecovery({ nudge: vi.fn(), storage });
      expect(attemptAutomaticReload()).toBe(true);
      const set = (storage as unknown as { setItem: ReturnType<typeof vi.fn> }).setItem;
      expect(set.mock.calls[0][0]).toBe(`${RELOAD_GUARD_PREFIX}localdev`);
    });
  });

  it('prunes other tradr.chunk-reload.* keys on install', () => {
    withBootVersion('v2.0.0', () => {
      const storage = makeStorage({
        'tradr.chunk-reload.v1.0.0': '1',
        'tradr.chunk-reload.v2.0.0': '2',
        'other.key': 'keep',
      });
      installChunkRecovery({ nudge: vi.fn(), storage });
      const map = (storage as unknown as { map: Map<string, string> }).map;
      expect(map.has('tradr.chunk-reload.v1.0.0')).toBe(false); // stale, removed
      expect(map.has('tradr.chunk-reload.v2.0.0')).toBe(true); // current, kept
      expect(map.has('other.key')).toBe(true); // unrelated, kept
    });
  });
});

describe('reloadAfterChunkFailure', () => {
  const ORIGIN = 'https://app.example';

  function install(fetchImpl: typeof fetch, reload: () => void) {
    installChunkRecovery({
      nudge: vi.fn(),
      storage: makeStorage(),
      win: makeWin(ORIGIN),
      fetch: fetchImpl,
      reload,
    });
  }

  it.each([
    ['Chromium', `Failed to fetch dynamically imported module: ${ORIGIN}/assets/Foo-abc123.js`],
    ['Firefox', `error loading dynamically imported module: ${ORIGIN}/assets/Foo-abc123.js`],
    ['Vite CSS', `Unable to preload CSS for ${ORIGIN}/assets/Foo-abc123.css`],
  ])('refreshes the same-origin asset then reloads (%s message)', async (_label, message) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    const reload = vi.fn();
    install(fetchMock as unknown as typeof fetch, reload);
    await reloadAfterChunkFailure(new Error(message));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/assets/');
    expect(init.cache).toBe('reload');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads without a fetch when the message names no asset URL (Safari)', async () => {
    const fetchMock = vi.fn();
    const reload = vi.fn();
    install(fetchMock as unknown as typeof fetch, reload);
    await reloadAfterChunkFailure(new Error('Importing a module script failed.'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('still reloads when the refresh fetch rejects', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network'));
    const reload = vi.fn();
    install(fetchMock as unknown as typeof fetch, reload);
    await reloadAfterChunkFailure(
      new Error(`Failed to fetch dynamically imported module: ${ORIGIN}/assets/Foo.js`),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('never fetches a foreign-origin URL — plain reload only', async () => {
    const fetchMock = vi.fn();
    const reload = vi.fn();
    install(fetchMock as unknown as typeof fetch, reload);
    await reloadAfterChunkFailure(
      new Error('Failed to fetch dynamically imported module: https://evil.example/assets/x.js'),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('never fetches a protocol-relative cross-origin URL — plain reload only', async () => {
    const fetchMock = vi.fn();
    const reload = vi.fn();
    install(fetchMock as unknown as typeof fetch, reload);
    await reloadAfterChunkFailure(
      new Error('Failed to fetch dynamically imported module: //evil.example/assets/x.js'),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('CHUNK_LOAD_REGEX / isChunkLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module',
    'Importing a module script failed',
    'error loading dynamically imported module',
    'Unable to preload CSS',
  ])('matches the wording: %s', (wording) => {
    expect(CHUNK_LOAD_REGEX.test(wording)).toBe(true);
    expect(isChunkLoadError(new Error(`${wording} for /assets/x.js`))).toBe(true);
  });

  it('does not match an unrelated, untagged error', () => {
    expect(isChunkLoadError(new Error('something else entirely'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

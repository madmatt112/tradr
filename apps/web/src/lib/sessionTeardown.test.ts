// @vitest-environment jsdom
//
// The shared teardown itself, tested where it lives rather than through the four
// callers that run it (login, register, logout, expiry). Each of those is tested
// for CALLING it; this file is what says what "it" is.
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient as singletonQueryClient } from '@/lib/queryClient';
import { DRAWER_STORAGE_KEY, useDrawerStore, writeDrawerState } from '@/stores/drawer.store';
import { eventBus } from '@/stores/event-bus.store';

import { clearClientSessionState } from './sessionTeardown';

function aClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** User A's tab, mid-session: cached rows, a stored drawer, a live drawer. */
function seedPreviousSession(client: QueryClient) {
  client.setQueryData(['auth', 'me'], { id: 'u-1', email: 'a@example.com' });
  client.setQueryData(['positions'], [{ id: 'p-1', symbol: 'AAPL' }]);
  localStorage.setItem(
    DRAWER_STORAGE_KEY,
    JSON.stringify({ isOpen: true, activeTab: 'quick-stats', version: 1 }),
  );
  useDrawerStore.setState({ isOpen: true, activeTab: 'quick-stats', legacyDetected: false });
}

beforeEach(() => {
  localStorage.clear();
  useDrawerStore.getState().reset();
});

afterEach(() => {
  eventBus.__resetForTests();
  localStorage.clear();
  useDrawerStore.getState().reset();
  singletonQueryClient.clear();
  vi.restoreAllMocks();
});

describe('clearClientSessionState', () => {
  it('drops the server state in the client it is given', () => {
    const client = aClient();
    seedPreviousSession(client);

    clearClientSessionState(client);

    expect(client.getQueryData(['auth', 'me'])).toBeUndefined();
    expect(client.getQueryData(['positions'])).toBeUndefined();
  });

  it('falls back to the singleton client — the expiry path has no context to hand it one', () => {
    seedPreviousSession(singletonQueryClient);

    clearClientSessionState();

    expect(singletonQueryClient.getQueryData(['auth', 'me'])).toBeUndefined();
  });

  it('announces auth:logout AFTER the cache is cleared, so a listener reads it empty', () => {
    const client = aClient();
    seedPreviousSession(client);
    const seen: string[] = [];
    vi.spyOn(client, 'clear').mockImplementation(() => {
      seen.push('cache-cleared');
    });
    eventBus.subscribe('auth:logout', () => {
      seen.push('auth:logout');
    });

    clearClientSessionState(client);

    expect(seen).toEqual(['cache-cleared', 'auth:logout']);
  });

  // THE STORED KEY IS ONLY HALF OF THE DRAWER. `useDrawerStore` hydrates from it
  // once, when the module is imported, and a login is a client-side navigation
  // rather than a page load — so removing the key alone leaves the departing
  // user's drawer open, on the arriving user's screen, ready to be persisted
  // back the first time they touch it.
  it('resets the LIVE drawer store, not only the stored key', () => {
    const client = aClient();
    seedPreviousSession(client);

    clearClientSessionState(client);

    expect(localStorage.getItem(DRAWER_STORAGE_KEY)).toBeNull();
    expect(useDrawerStore.getState()).toMatchObject({
      isOpen: false,
      activeTab: 'open-positions',
      legacyDetected: false,
    });
  });

  // ...and the two halves have to happen in that order. SideDrawer persists
  // every store change it sees, and on the logout path it is still on screen
  // when this runs, so the reset itself writes the defaults back into the key.
  it('leaves no stored key behind even when a mounted drawer persists the reset', () => {
    const client = aClient();
    seedPreviousSession(client);
    // SideDrawer's write subscription, as it is written there (effect 2).
    const unsubscribe = useDrawerStore.subscribe((state, prev) => {
      if (state.legacyDetected) return;
      if (state.isOpen === prev.isOpen && state.activeTab === prev.activeTab) return;
      writeDrawerState({ isOpen: state.isOpen, activeTab: state.activeTab });
    });

    try {
      clearClientSessionState(client);
    } finally {
      unsubscribe();
    }

    expect(localStorage.getItem(DRAWER_STORAGE_KEY)).toBeNull();
  });

  it('tears the rest down even when storage is unavailable', () => {
    const client = aClient();
    seedPreviousSession(client);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    const onLogout = vi.fn();
    eventBus.subscribe('auth:logout', onLogout);

    expect(() => clearClientSessionState(client)).not.toThrow();

    expect(client.getQueryData(['positions'])).toBeUndefined();
    expect(useDrawerStore.getState().isOpen).toBe(false);
    expect(onLogout).toHaveBeenCalledOnce();
  });
});

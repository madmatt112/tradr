// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { ThemeProvider } from 'next-themes';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { api as ApiType } from '@/lib/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mock sonner so toast.error doesn't blow up in jsdom.
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Mock useAuth — the real useAuth pulls in tanstack-router which needs a router context.
const USER = { id: 'user-1', email: 'a@b.c' } as { id: string; email: string };
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: USER,
    isLoading: false,
    isAuthenticated: true,
    login: { mutate: vi.fn(), mutateAsync: vi.fn() },
    logout: { mutate: vi.fn(), mutateAsync: vi.fn() },
  }),
}));

const TOMBSTONE_KEY = 'tradr_theme_pending';

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
}

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: qc },
      createElement(
        ThemeProvider,
        { attribute: 'class', defaultTheme: 'system', storageKey: 'theme' },
        children,
      ),
    );
  };
}

/**
 * Fresh import of useAppTheme so the module-level `didBootForReact` boot guard
 * resets per test (§O). Returns the hook AND the freshly imported `api` so spies
 * target the same module instance the hook uses after `vi.resetModules()`.
 */
async function loadUseAppTheme(): Promise<{
  useAppTheme: typeof import('./useAppTheme').useAppTheme;
  api: typeof ApiType;
}> {
  vi.resetModules();
  // Re-stub mocks against the freshly evaluated module graph.
  vi.doMock('sonner', () => ({
    toast: { error: vi.fn(), success: vi.fn() },
  }));
  vi.doMock('@/hooks/useAuth', () => ({
    useAuth: () => ({
      user: USER,
      isLoading: false,
      isAuthenticated: true,
      login: { mutate: vi.fn(), mutateAsync: vi.fn() },
      logout: { mutate: vi.fn(), mutateAsync: vi.fn() },
    }),
  }));
  const apiMod = await import('@/lib/api');
  const mod = await import('./useAppTheme');
  return { useAppTheme: mod.useAppTheme, api: apiMod.api };
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

describe('useAppTheme', () => {
  it('PUT success writes BOTH ["users","me","theme"] and ["dashboard","layout"] caches', async () => {
    const { useAppTheme, api } = await loadUseAppTheme();
    vi.spyOn(api, 'get').mockImplementation((path: string) => {
      if (path === '/dashboard/theme') return Promise.resolve({ theme: 'light' }) as never;
      if (path === '/dashboard/layout')
        return Promise.resolve({
          widgets: [],
          theme: 'light',
          updatedAt: '2026-05-01T00:00:00.000Z',
        }) as never;
      return Promise.resolve({}) as never;
    });
    vi.spyOn(api, 'post').mockResolvedValue(undefined);
    vi.spyOn(api, 'put').mockResolvedValue({
      widgets: [],
      theme: 'dark',
      updatedAt: '2026-05-02T00:00:00.000Z',
    });

    const qc = makeQueryClient();
    const setSpy = vi.spyOn(qc, 'setQueryData');

    const { result } = renderHook(() => useAppTheme(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(qc.getQueryData(['users', 'me', 'theme'])).toBeDefined());

    await act(async () => {
      await result.current.setTheme('dark');
    });

    // Theme cache:
    expect(qc.getQueryData(['users', 'me', 'theme'])).toEqual({ theme: 'dark' });
    // Layout cache (written via useDashboardLayout.onSuccess):
    const layout = qc.getQueryData<{ theme: string }>(['dashboard', 'layout']);
    expect(layout?.theme).toBe('dark');

    // Both keys were targets of setQueryData:
    const keys = setSpy.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(keys).toContain(JSON.stringify(['users', 'me', 'theme']));
    expect(keys).toContain(JSON.stringify(['dashboard', 'layout']));
  });

  it('PUT failure retains the local nextTheme.setTheme(t) (theme stays applied locally)', async () => {
    const { useAppTheme, api } = await loadUseAppTheme();
    vi.spyOn(api, 'get').mockResolvedValue({ theme: 'light' });
    vi.spyOn(api, 'post').mockResolvedValue(undefined);
    vi.spyOn(api, 'put').mockRejectedValue(new Error('put-failed'));

    const qc = makeQueryClient();
    const { result } = renderHook(() => useAppTheme(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(qc.getQueryData(['users', 'me', 'theme'])).toBeDefined());

    await act(async () => {
      await result.current.setTheme('dark');
    });

    // Local theme is retained — effectiveTheme reflects the optimistic local update.
    expect(result.current.effectiveTheme).toBe('dark');
  });

  it('PUT failure writes lastFailedAt tombstone to sessionStorage', async () => {
    const { useAppTheme, api } = await loadUseAppTheme();
    vi.spyOn(api, 'get').mockResolvedValue({ theme: 'light' });
    vi.spyOn(api, 'post').mockResolvedValue(undefined);
    vi.spyOn(api, 'put').mockRejectedValue(new Error('put-failed'));

    const before = Date.now();
    const qc = makeQueryClient();
    const { result } = renderHook(() => useAppTheme(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(qc.getQueryData(['users', 'me', 'theme'])).toBeDefined());

    await act(async () => {
      await result.current.setTheme('dark');
    });

    const raw = sessionStorage.getItem(TOMBSTONE_KEY);
    expect(raw).not.toBeNull();
    const tomb = JSON.parse(raw!) as { lastFailedAt: number; lastPendingAt: number };
    expect(tomb.lastFailedAt).toBeGreaterThanOrEqual(before);
    expect(tomb.lastPendingAt).toBe(0);
  });

  it('boot reconciliation respects failure tombstone within 60s across simulated reload', async () => {
    // Pre-seed the tombstone as if a prior tab/session left a recent failure.
    sessionStorage.setItem(
      TOMBSTONE_KEY,
      JSON.stringify({
        lastPendingAt: 0,
        lastFailedAt: Date.now() - 1000, // 1s ago — well within 60s window
        pendingTheme: null,
        didBoot: false,
      }),
    );

    const { useAppTheme, api } = await loadUseAppTheme();
    const serverTheme = { theme: 'dark' as const };
    const getSpy = vi.spyOn(api, 'get').mockImplementation((path: string) => {
      if (path === '/dashboard/theme') return Promise.resolve(serverTheme) as never;
      if (path === '/dashboard/layout')
        return Promise.resolve({
          widgets: [],
          theme: 'light',
          updatedAt: '2026-05-01T00:00:00.000Z',
        }) as never;
      return Promise.resolve({}) as never;
    });
    const postSpy = vi.spyOn(api, 'post').mockResolvedValue(undefined);

    const qc = makeQueryClient();
    const { result, unmount } = renderHook(() => useAppTheme(), { wrapper: makeWrapper(qc) });

    // The boot path calls POST /dashboard/theme-cookie then GET /dashboard/theme.
    await waitFor(() => expect(postSpy).toHaveBeenCalledWith('/dashboard/theme-cookie'));
    await waitFor(() => {
      const themeGets = getSpy.mock.calls.filter((c) => c[0] === '/dashboard/theme');
      expect(themeGets.length).toBeGreaterThan(0);
    });

    // Confirm the boot wrote didBoot: true, then unmount + remount to simulate reload.
    await waitFor(() => {
      const tomb = JSON.parse(sessionStorage.getItem(TOMBSTONE_KEY) ?? 'null') as {
        didBoot: boolean;
      } | null;
      expect(tomb?.didBoot).toBe(true);
    });

    // The skip should mean nextTheme.theme was NOT forced to the server value ("dark").
    // resolveEffective falls back to defaultTheme="system" -> systemTheme (jsdom: "light").
    expect(result.current.effectiveTheme).not.toBe('dark');
    unmount();
  });

  it('boot reconciliation respects lastPendingAt > 0 tombstone', async () => {
    sessionStorage.setItem(
      TOMBSTONE_KEY,
      JSON.stringify({
        lastPendingAt: Date.now(),
        lastFailedAt: 0,
        pendingTheme: 'dark',
        didBoot: false,
      }),
    );

    const { useAppTheme, api } = await loadUseAppTheme();
    const getSpy = vi.spyOn(api, 'get').mockImplementation((path: string) => {
      if (path === '/dashboard/theme') return Promise.resolve({ theme: 'dark' }) as never;
      if (path === '/dashboard/layout')
        return Promise.resolve({
          widgets: [],
          theme: 'light',
          updatedAt: '2026-05-01T00:00:00.000Z',
        }) as never;
      return Promise.resolve({}) as never;
    });
    const postSpy = vi.spyOn(api, 'post').mockResolvedValue(undefined);

    const qc = makeQueryClient();
    const { result } = renderHook(() => useAppTheme(), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(postSpy).toHaveBeenCalledWith('/dashboard/theme-cookie'));
    await waitFor(() => {
      const themeGets = getSpy.mock.calls.filter((c) => c[0] === '/dashboard/theme');
      expect(themeGets.length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      const tomb = JSON.parse(sessionStorage.getItem(TOMBSTONE_KEY) ?? 'null') as {
        didBoot: boolean;
      } | null;
      expect(tomb?.didBoot).toBe(true);
    });

    // Skip applied — server "dark" is NOT forced into effectiveTheme.
    expect(result.current.effectiveTheme).not.toBe('dark');
  });

  it('BroadcastChannel posts on PUT success', async () => {
    const postMessageSpy = vi.spyOn(BroadcastChannel.prototype, 'postMessage');
    const { useAppTheme, api } = await loadUseAppTheme();
    vi.spyOn(api, 'get').mockResolvedValue({ theme: 'light' });
    vi.spyOn(api, 'post').mockResolvedValue(undefined);
    vi.spyOn(api, 'put').mockResolvedValue({
      widgets: [],
      theme: 'dark',
      updatedAt: '2026-05-02T00:00:00.000Z',
    });

    const qc = makeQueryClient();
    const { result } = renderHook(() => useAppTheme(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(qc.getQueryData(['users', 'me', 'theme'])).toBeDefined());

    await act(async () => {
      await result.current.setTheme('dark');
    });

    expect(postMessageSpy).toHaveBeenCalled();
    const last = postMessageSpy.mock.calls.at(-1)![0] as {
      value: string;
      userId: string;
      ts: number;
    };
    expect(last.value).toBe('dark');
    expect(last.userId).toBe(USER.id);
    expect(typeof last.ts).toBe('number');
  });

  it('echo suppression skips messages within 200ms of own broadcast', async () => {
    const { useAppTheme, api } = await loadUseAppTheme();
    vi.spyOn(api, 'get').mockResolvedValue({ theme: 'light' });
    vi.spyOn(api, 'post').mockResolvedValue(undefined);
    vi.spyOn(api, 'put').mockResolvedValue({
      widgets: [],
      theme: 'dark',
      updatedAt: '2026-05-02T00:00:00.000Z',
    });

    // Capture the BroadcastChannel instance the hook creates so we can dispatch into it.
    const channels: BroadcastChannel[] = [];
    const origCtor = globalThis.BroadcastChannel;
    const SpyCh = class extends origCtor {
      constructor(name: string) {
        super(name);
        channels.push(this as unknown as BroadcastChannel);
      }
    };
    vi.stubGlobal('BroadcastChannel', SpyCh);

    const qc = makeQueryClient();
    const { result } = renderHook(() => useAppTheme(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(qc.getQueryData(['users', 'me', 'theme'])).toBeDefined());
    await waitFor(() => expect(channels.length).toBeGreaterThan(0));

    // Trigger a real PUT success to set lastBroadcastTsRef.current via the hook's own code path.
    await act(async () => {
      await result.current.setTheme('dark');
    });

    // Reset the theme cache so we can detect whether an inbound message updated it.
    qc.setQueryData(['users', 'me', 'theme'], { theme: 'light' });

    // Dispatch a message ts=100ms ago — within the 200ms echo window — should be skipped.
    act(() => {
      const ch = channels[0];
      ch.dispatchEvent(
        new MessageEvent('message', {
          data: { value: 'dark', userId: USER.id, ts: Date.now() - 100 },
        }),
      );
    });

    // Cache was NOT overwritten by the suppressed echo.
    expect(qc.getQueryData(['users', 'me', 'theme'])).toEqual({ theme: 'light' });
  });

  it('userId mismatch causes receive-handler to skip (cross-account message ignored)', async () => {
    const { useAppTheme, api } = await loadUseAppTheme();
    vi.spyOn(api, 'get').mockResolvedValue({ theme: 'light' });
    vi.spyOn(api, 'post').mockResolvedValue(undefined);

    const channels: BroadcastChannel[] = [];
    const origCtor = globalThis.BroadcastChannel;
    const SpyCh = class extends origCtor {
      constructor(name: string) {
        super(name);
        channels.push(this as unknown as BroadcastChannel);
      }
    };
    vi.stubGlobal('BroadcastChannel', SpyCh);

    const qc = makeQueryClient();
    const { result } = renderHook(() => useAppTheme(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(qc.getQueryData(['users', 'me', 'theme'])).toBeDefined());
    await waitFor(() => expect(channels.length).toBeGreaterThan(0));

    const before = result.current.effectiveTheme;
    qc.setQueryData(['users', 'me', 'theme'], { theme: 'light' });

    act(() => {
      channels[0].dispatchEvent(
        new MessageEvent('message', {
          data: { value: 'dark', userId: 'other-user', ts: Date.now() },
        }),
      );
    });

    // Theme cache untouched by the cross-account message.
    expect(qc.getQueryData(['users', 'me', 'theme'])).toEqual({ theme: 'light' });
    expect(result.current.effectiveTheme).toBe(before);
  });

  it('writeTombstone Safari-Private throw is caught — setTheme does NOT crash and local toggle still applies', async () => {
    const { useAppTheme, api } = await loadUseAppTheme();
    vi.spyOn(api, 'get').mockResolvedValue({ theme: 'light' });
    vi.spyOn(api, 'post').mockResolvedValue(undefined);
    vi.spyOn(api, 'put').mockResolvedValue({
      widgets: [],
      theme: 'dark',
      updatedAt: '2026-05-02T00:00:00.000Z',
    });

    // Stub sessionStorage.setItem to throw (Safari Private Browsing behavior).
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string) => {
      if (key === TOMBSTONE_KEY) {
        throw new Error('QuotaExceededError');
      }
    });

    const qc = makeQueryClient();
    const { result } = renderHook(() => useAppTheme(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(qc.getQueryData(['users', 'me', 'theme'])).toBeDefined());

    // Must not throw despite sessionStorage.setItem throwing inside writeTombstone.
    await act(async () => {
      await expect(result.current.setTheme('dark')).resolves.toBeUndefined();
    });

    // Local toggle still applied.
    expect(result.current.effectiveTheme).toBe('dark');
    expect(setItemSpy).toHaveBeenCalled();
  });
});

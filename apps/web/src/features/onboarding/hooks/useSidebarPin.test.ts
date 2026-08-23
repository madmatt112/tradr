// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OnboardingState } from '@tradr/shared';

import { api } from '@/lib/api';

import { LEGACY_COLLAPSED_KEY, SIDEBAR_PIN_MIRROR_KEY, useSidebarPin } from './useSidebarPin';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
}

function wrapperFor(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

/** Stub the preference GET (and PATCH echoing the merged state back). */
function mockServer(preference: OnboardingState) {
  const stored = { ...preference };
  vi.spyOn(api, 'get').mockImplementation(() => Promise.resolve({ ...stored }));
  const patchSpy = vi.spyOn(api, 'patch').mockImplementation((_path: string, body?: unknown) => {
    Object.assign(stored, body as Partial<OnboardingState>);
    return Promise.resolve({ ...stored });
  });
  return { patchSpy };
}

const BASE: OnboardingState = { status: 'pending', coachMarksSeen: [] };

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useSidebarPin', () => {
  it('paints from the device mirror before the preference query lands', () => {
    localStorage.setItem(SIDEBAR_PIN_MIRROR_KEY, 'true');
    // A GET that never resolves reproduces the in-flight window.
    vi.spyOn(api, 'get').mockImplementation(() => new Promise(() => {}));
    vi.spyOn(api, 'patch').mockResolvedValue(BASE);

    const { result } = renderHook(() => useSidebarPin(), {
      wrapper: wrapperFor(makeQueryClient()),
    });
    expect(result.current.pinned).toBe(true);
  });

  it('lets the server record overwrite a stale mirror once it lands', async () => {
    localStorage.setItem(SIDEBAR_PIN_MIRROR_KEY, 'true');
    mockServer({ ...BASE, sidebarPinned: false });

    const { result } = renderHook(() => useSidebarPin(), {
      wrapper: wrapperFor(makeQueryClient()),
    });
    await waitFor(() => expect(result.current.pinned).toBe(false));
    expect(localStorage.getItem(SIDEBAR_PIN_MIRROR_KEY)).toBe('false');
  });

  it('seeds the server once from the legacy sidebar-collapsed value, inverted', async () => {
    // The old sidebar stored collapsed=true; the equivalent pin is false.
    localStorage.setItem(LEGACY_COLLAPSED_KEY, 'true');
    const { patchSpy } = mockServer(BASE);

    const { result } = renderHook(() => useSidebarPin(), {
      wrapper: wrapperFor(makeQueryClient()),
    });
    await waitFor(() =>
      expect(patchSpy).toHaveBeenCalledWith('/users/me/onboarding', { sidebarPinned: false }),
    );
    expect(result.current.pinned).toBe(false);
    // The legacy key is consumed — the seed can never run twice off it.
    expect(localStorage.getItem(LEGACY_COLLAPSED_KEY)).toBeNull();
  });

  it('seeds pinned=true from a legacy expanded sidebar', async () => {
    localStorage.setItem(LEGACY_COLLAPSED_KEY, 'false');
    const { patchSpy } = mockServer(BASE);

    const { result } = renderHook(() => useSidebarPin(), {
      wrapper: wrapperFor(makeQueryClient()),
    });
    await waitFor(() =>
      expect(patchSpy).toHaveBeenCalledWith('/users/me/onboarding', { sidebarPinned: true }),
    );
    expect(result.current.pinned).toBe(true);
  });

  it('does not write anything when neither the server nor a legacy value exists', async () => {
    const { patchSpy } = mockServer(BASE);

    const { result } = renderHook(() => useSidebarPin(), {
      wrapper: wrapperFor(makeQueryClient()),
    });
    // Give the effect a beat to run after the query resolves.
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(result.current.pinned).toBe(false);
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('setPinned updates the mirror and persists through the preference PATCH', async () => {
    const { patchSpy } = mockServer(BASE);

    const { result } = renderHook(() => useSidebarPin(), {
      wrapper: wrapperFor(makeQueryClient()),
    });
    act(() => {
      result.current.setPinned(true);
    });
    expect(result.current.pinned).toBe(true);
    expect(localStorage.getItem(SIDEBAR_PIN_MIRROR_KEY)).toBe('true');
    await waitFor(() =>
      expect(patchSpy).toHaveBeenCalledWith('/users/me/onboarding', { sidebarPinned: true }),
    );
  });
});

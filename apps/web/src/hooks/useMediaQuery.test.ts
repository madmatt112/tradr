// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useMediaQuery } from './useMediaQuery';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useMediaQuery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true when matchMedia reports matches: true', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    const { result } = renderHook(() => useMediaQuery('(min-width: 768px)'));
    expect(result.current).toBe(true);
  });

  it('flips returned value when the change listener fires', () => {
    const mql = {
      matches: true,
      listeners: [] as Array<() => void>,
      addEventListener: (_event: string, cb: () => void) => {
        mql.listeners.push(cb);
      },
      removeEventListener: (_event: string, cb: () => void) => {
        mql.listeners = mql.listeners.filter((l) => l !== cb);
      },
    };
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mql));

    const { result } = renderHook(() => useMediaQuery('(min-width: 768px)'));
    expect(result.current).toBe(true);

    act(() => {
      mql.matches = false;
      mql.listeners.forEach((l) => l());
    });

    expect(result.current).toBe(false);
  });
});

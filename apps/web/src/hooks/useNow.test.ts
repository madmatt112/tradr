// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useNow } from './useNow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useNow', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns a Date instance on initial render', () => {
    const { result } = renderHook(() => useNow());
    expect(result.current).toBeInstanceOf(Date);
  });

  it('returns a later Date after advancing timers by the interval', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { result } = renderHook(() => useNow(60_000));
    const initial = result.current;
    act(() => {
      vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.getTime()).toBeGreaterThan(initial.getTime());
  });

  it('clears the interval on unmount', () => {
    const { unmount } = renderHook(() => useNow());
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the hook module so the banner subscribes through a controllable seam.
// We expose `__emitFlip` from the mock so the test can drive the listener.
vi.mock('../hooks/usePerformance', () => {
  const listeners = new Set<(v: 0 | 1) => void>();
  return {
    onWeekStartFlip: (listener: (v: 0 | 1) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    __emitFlip: (v: 0 | 1) => {
      for (const l of listeners) l(v);
    },
    __clearListeners: () => listeners.clear(),
  };
});

import * as hookMock from '../hooks/usePerformance';

import {
  __resetWeekStartChangedBannerState,
  WeekStartChangedBanner,
} from './WeekStartChangedBanner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Helpers from the mock — tolerate type-erasure.
const emit = (v: 0 | 1) =>
  (hookMock as unknown as { __emitFlip: (v: 0 | 1) => void }).__emitFlip(v);
const clearListeners = () =>
  (hookMock as unknown as { __clearListeners: () => void }).__clearListeners();

beforeEach(() => {
  sessionStorage.clear();
  __resetWeekStartChangedBannerState();
  clearListeners();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WeekStartChangedBanner — initial render', () => {
  it('renders nothing before any flip is emitted', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<WeekStartChangedBanner />);
    });
    expect(container.querySelector('[data-testid="week-start-changed-banner"]')).toBeNull();

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});

describe('WeekStartChangedBanner — appears on flip, dismissible', () => {
  it('renders after a flip signal and uses aria-live="polite"', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<WeekStartChangedBanner />);
    });

    act(() => {
      emit(1);
    });

    const banner = container.querySelector('[data-testid="week-start-changed-banner"]');
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute('aria-live')).toBe('polite');

    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="week-start-changed-banner-dismiss"]',
    );
    expect(btn).not.toBeNull();
    expect(btn!.className).toContain('cursor-pointer');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('clicking dismiss writes session flag and hides the banner', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<WeekStartChangedBanner />);
    });
    act(() => {
      emit(0);
    });

    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="week-start-changed-banner-dismiss"]',
    );
    act(() => {
      btn!.click();
    });

    expect(container.querySelector('[data-testid="week-start-changed-banner"]')).toBeNull();
    expect(sessionStorage.getItem('perf.week_start_flip_dismissed')).toBe('true');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('once dismissed, a subsequent flip does NOT re-show the banner this session', () => {
    sessionStorage.setItem('perf.week_start_flip_dismissed', 'true');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<WeekStartChangedBanner />);
    });
    act(() => {
      emit(1);
    });

    expect(container.querySelector('[data-testid="week-start-changed-banner"]')).toBeNull();

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});

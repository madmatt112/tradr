import { vi } from 'vitest';

// jsdom does NOT implement matchMedia; install a no-op shim so any production
// code path calling `useMediaQuery` (or similar) does not throw under tests.
// Tests that need a specific `matches` value override via vi.stubGlobal in
// their own beforeEach. Guarded so this file is safe to load under the node
// environment (where `window` is undefined).
if (typeof window !== 'undefined') {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
}

// jsdom does not implement ResizeObserver either, and several Radix primitives
// (Switch, Select, Popover) construct one on mount — without this any test
// rendering them dies with "ResizeObserver is not defined". A no-op observer is
// enough: nothing under test asserts on resize callbacks. `DashboardGrid.test`
// installs its own instrumented double over the top and restores this one.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

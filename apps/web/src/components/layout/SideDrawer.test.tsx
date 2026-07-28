// @vitest-environment jsdom
/* eslint-disable import-x/order */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React, { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMediaQuery } from '@/hooks/useMediaQuery';
import { DRAWER_STORAGE_KEY, useDrawerStore } from '@/stores/drawer.store';

import { DrawerToggleRefContext, DrawerToggleRefProvider } from './DrawerToggleRefContext';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the 4 tab components to avoid pulling their query/data dependencies.
vi.mock('@/features/drawer/components/OpenPositionsTab', () => ({
  OpenPositionsTab: () => <div data-testid="open-positions-tab" />,
}));
vi.mock('@/features/drawer/components/QuickStatsTab', () => ({
  QuickStatsTab: () => <div data-testid="quick-stats-tab" />,
}));
vi.mock('@/features/drawer/components/OptionsPricingTab', () => ({
  OptionsPricingTab: () => <div data-testid="options-pricing-tab" />,
}));
vi.mock('@/features/drawer/components/RecentlyCreatedTab', () => ({
  RecentlyCreatedTab: () => <div data-testid="recently-created-tab" />,
}));

// Controllable useMediaQuery: default both queries → false (desktop).
vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: vi.fn(() => false),
}));

import { SideDrawer } from './SideDrawer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function configureMediaQuery(opts: { mobile?: boolean; tablet?: boolean } = {}) {
  const mobile = opts.mobile ?? false;
  const tablet = opts.tablet ?? false;
  vi.mocked(useMediaQuery).mockImplementation((q: string) => {
    if (q === '(max-width: 767px)') return mobile;
    if (q === '(max-width: 1023px)') return tablet || mobile;
    return false;
  });
}

function renderDrawer() {
  return render(
    <DrawerToggleRefProvider>
      <SideDrawer />
    </DrawerToggleRefProvider>,
  );
}

beforeEach(() => {
  vi.mocked(useMediaQuery).mockReset();
  vi.mocked(useMediaQuery).mockImplementation(() => false);
  useDrawerStore.setState({
    isOpen: false,
    activeTab: 'open-positions',
    legacyDetected: false,
  });
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SideDrawer', () => {
  it('renders closed state with translate-x-full and hidden backdrop (<1024)', () => {
    configureMediaQuery({ tablet: true });
    const { getByTestId } = renderDrawer();
    const aside = getByTestId('side-drawer');
    expect(aside.getAttribute('data-state')).toBe('closed');
    expect(aside.className).toContain('translate-x-full');
    const backdrop = getByTestId('drawer-backdrop');
    expect(backdrop.className).toContain('opacity-0');
    expect(backdrop.className).toContain('pointer-events-none');
  });

  it('renders open state with translate-x-0 and visible backdrop (<1024)', () => {
    configureMediaQuery({ tablet: true });
    useDrawerStore.setState({ isOpen: true });
    const { getByTestId } = renderDrawer();
    const aside = getByTestId('side-drawer');
    expect(aside.getAttribute('data-state')).toBe('open');
    expect(aside.className).toContain('translate-x-0');
    const backdrop = getByTestId('drawer-backdrop');
    expect(backdrop.className).toContain('opacity-100');
  });

  it('closes the drawer when the mobile backdrop is clicked', () => {
    configureMediaQuery({ mobile: true });
    useDrawerStore.setState({ isOpen: true });
    const { getByTestId } = renderDrawer();
    fireEvent.click(getByTestId('drawer-backdrop'));
    expect(useDrawerStore.getState().isOpen).toBe(false);
  });

  it('does not render a backdrop on desktop (>=1024)', () => {
    configureMediaQuery({ mobile: false, tablet: false });
    useDrawerStore.setState({ isOpen: true });
    const { queryByTestId } = renderDrawer();
    expect(queryByTestId('drawer-backdrop')).toBeNull();
  });

  it('closes the drawer when Escape is pressed on mobile', () => {
    configureMediaQuery({ mobile: true });
    useDrawerStore.setState({ isOpen: true });
    renderDrawer();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useDrawerStore.getState().isOpen).toBe(false);
  });

  it('keeps the drawer open when Escape is pressed on desktop', () => {
    configureMediaQuery({ mobile: false, tablet: false });
    useDrawerStore.setState({ isOpen: true });
    renderDrawer();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useDrawerStore.getState().isOpen).toBe(true);
  });

  it('moves focus to the active tab trigger on open', async () => {
    configureMediaQuery({ mobile: false, tablet: false });
    const { rerender } = render(
      <DrawerToggleRefProvider>
        <SideDrawer />
      </DrawerToggleRefProvider>,
    );
    useDrawerStore.setState({ isOpen: true });
    rerender(
      <DrawerToggleRefProvider>
        <SideDrawer />
      </DrawerToggleRefProvider>,
    );
    await waitFor(
      () => {
        expect(document.activeElement).not.toBeNull();
        expect(document.activeElement?.getAttribute('role')).toBe('tab');
        expect(document.activeElement?.getAttribute('data-state')).toBe('active');
      },
      { timeout: 1000 },
    );
  });

  it('returns focus to the toggle ref element on close', async () => {
    configureMediaQuery({ mobile: false, tablet: false });

    function Wrapper() {
      const ref = useRef<HTMLButtonElement | null>(null);
      return (
        <DrawerToggleRefContext.Provider value={ref}>
          <button ref={ref} data-testid="toggle-stub">
            toggle
          </button>
          <SideDrawer />
        </DrawerToggleRefContext.Provider>
      );
    }

    useDrawerStore.setState({ isOpen: true });
    const { getByTestId } = render(<Wrapper />);
    // Now close
    useDrawerStore.setState({ isOpen: false });
    await waitFor(() => {
      expect(document.activeElement).toBe(getByTestId('toggle-stub'));
    });
  });

  it('always renders the reduced-motion utility class on the aside', () => {
    configureMediaQuery();
    const { getByTestId } = renderDrawer();
    const aside = getByTestId('side-drawer');
    expect(aside.className).toContain('motion-reduce:duration-0');
  });

  it('reconciles via storage event (version 1, isOpen=true)', async () => {
    configureMediaQuery({ tablet: true });
    const { getByTestId } = renderDrawer();
    expect(useDrawerStore.getState().isOpen).toBe(false);

    fireEvent(
      window,
      new StorageEvent('storage', {
        key: DRAWER_STORAGE_KEY,
        newValue: JSON.stringify({
          isOpen: true,
          activeTab: 'open-positions',
          version: 1,
        }),
      }),
    );

    expect(useDrawerStore.getState().isOpen).toBe(true);
    const aside = getByTestId('side-drawer');
    expect(aside.getAttribute('data-storage-event-count')).toBe('1');
    // skip-transition is set synchronously and cleared on the next RAF.
    expect(aside.getAttribute('data-skip-transition')).toBe('true');
  });

  it('increments storage-event-count but does not close on newValue:null', () => {
    configureMediaQuery({ tablet: true });
    useDrawerStore.setState({ isOpen: true });
    const { getByTestId } = renderDrawer();

    fireEvent(
      window,
      new StorageEvent('storage', {
        key: DRAWER_STORAGE_KEY,
        newValue: null,
      }),
    );

    expect(useDrawerStore.getState().isOpen).toBe(true);
    const aside = getByTestId('side-drawer');
    expect(aside.getAttribute('data-storage-event-count')).toBe('1');
  });

  it('marks legacyDetected on version:2 storage event and skips writes', () => {
    configureMediaQuery({ tablet: true });
    renderDrawer();

    fireEvent(
      window,
      new StorageEvent('storage', {
        key: DRAWER_STORAGE_KEY,
        newValue: JSON.stringify({
          isOpen: false,
          activeTab: 'open-positions',
          version: 2,
        }),
      }),
    );

    expect(useDrawerStore.getState().legacyDetected).toBe(true);

    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    useDrawerStore.getState().setActiveTab('quick-stats');
    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it('attaches and removes the same storage listener under StrictMode double-mount', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    render(
      <React.StrictMode>
        <DrawerToggleRefProvider>
          <SideDrawer />
        </DrawerToggleRefProvider>
      </React.StrictMode>,
    );

    const storageAdds = addSpy.mock.calls.filter((c) => c[0] === 'storage');
    const storageRemoves = removeSpy.mock.calls.filter((c) => c[0] === 'storage');
    expect(storageAdds).toHaveLength(2);
    expect(storageRemoves).toHaveLength(1);
    // Catches the inline-arrow regression: removed listener must equal first added.
    expect(storageAdds[0][1]).toBe(storageRemoves[0][1]);
  });
});

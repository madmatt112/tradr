// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { useRef, type MutableRefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useDrawerStore } from '@/stores/drawer.store';

import { DrawerToggle } from './DrawerToggle';
import { DrawerToggleRefContext } from './DrawerToggleRefContext';

describe('DrawerToggle', () => {
  beforeEach(() => {
    useDrawerStore.setState({
      isOpen: false,
      activeTab: 'open-positions',
      legacyDetected: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders top-bar with h-12 and a button with correct aria attributes when isOpen is false', () => {
    render(<DrawerToggle />);
    const topbar = screen.getByTestId('drawer-topbar');
    expect(topbar.className).toContain('h-12');
    const button = screen.getByRole('button', { name: /open side drawer/i });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe('side-drawer');
  });

  it('invokes useDrawerStore.open() when the button is clicked', () => {
    render(<DrawerToggle />);
    const button = screen.getByRole('button', { name: /open side drawer/i });
    fireEvent.click(button);
    expect(useDrawerStore.getState().isOpen).toBe(true);
  });

  it('collapses the top-bar to h-0 border-b-0 and removes the button when isOpen is true', () => {
    useDrawerStore.setState({ isOpen: true });
    render(<DrawerToggle />);
    const topbar = screen.getByTestId('drawer-topbar');
    expect(topbar.className).toContain('h-0');
    expect(topbar.className).toContain('border-b-0');
    expect(
      screen.queryByRole('button', { name: /open side drawer/i }),
    ).toBeNull();
  });

  it('attaches the button to the ref provided via DrawerToggleRefContext', () => {
    let capturedRef: MutableRefObject<HTMLButtonElement | null> | null = null;
    function Wrapper() {
      const ref = useRef<HTMLButtonElement | null>(null);
      capturedRef = ref;
      return (
        <DrawerToggleRefContext.Provider value={ref}>
          <DrawerToggle />
        </DrawerToggleRefContext.Provider>
      );
    }
    render(<Wrapper />);
    const button = screen.getByRole('button', { name: /open side drawer/i });
    expect(capturedRef).not.toBeNull();
    expect(capturedRef!.current).toBe(button);
  });
});

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

  it('renders the inline toggle with a button carrying the aria contract when isOpen is false', () => {
    render(<DrawerToggle />);
    const wrapper = screen.getByTestId('drawer-toggle');
    // An inline control at the end of the PageHeader strip — never a layout
    // band of its own (the old h-12 top bar is gone).
    expect(wrapper.className).not.toContain('h-12');
    expect(wrapper.className).not.toContain('fixed');
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

  it('hides the toggle and removes the button when isOpen is true', () => {
    useDrawerStore.setState({ isOpen: true });
    render(<DrawerToggle />);
    const wrapper = screen.getByTestId('drawer-toggle');
    expect(wrapper.className).toContain('opacity-0');
    expect(wrapper.className).toContain('pointer-events-none');
    expect(wrapper.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('button', { name: /open side drawer/i })).toBeNull();
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

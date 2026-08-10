// @vitest-environment jsdom
//
// `useDemoAccount` is faked wholesale — it has its own tests — so this file is
// only about what the banner does with the answer: says the figures are sample
// data, carries the control that removes them, and stays out of the way
// entirely for everybody else.
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDemoAccount, type UseDemoAccountResult } from '../hooks/useDemoAccount';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../hooks/useDemoAccount', () => ({ useDemoAccount: vi.fn() }));

import { DemoBanner } from './DemoBanner';

const mockUseDemoAccount = vi.mocked(useDemoAccount);

function useHook(over: Partial<UseDemoAccountResult> = {}): UseDemoAccountResult {
  const value: UseDemoAccountResult = {
    isDemoPresent: true,
    demoAccount: undefined,
    seed: vi.fn(),
    teardown: vi.fn(),
    isPending: false,
    ...over,
  };
  mockUseDemoAccount.mockReturnValue(value);
  return value;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DemoBanner', () => {
  it('renders nothing at all when there is no sample data', () => {
    useHook({ isDemoPresent: false });
    const { container } = render(<DemoBanner />);

    // Not a placeholder, not an empty box — the majority of users must not pay
    // a pixel for a notice about data they do not have.
    expect(container.innerHTML).toBe('');
  });

  it('says the figures are sample data and carries the control that removes them', () => {
    useHook();
    render(<DemoBanner />);

    const banner = screen.getByTestId('demo-banner');
    expect(banner.textContent).toContain('sample data');
    // The notice and the way out are the same control.
    expect(screen.getByTestId('demo-banner-remove')).toBeTruthy();
  });

  it('removes the sample data on one click, with no confirmation step', async () => {
    const hook = useHook();
    render(<DemoBanner />);

    await userEvent.click(screen.getByTestId('demo-banner-remove'));

    expect(hook.teardown).toHaveBeenCalledTimes(1);
  });

  it('does not fire a second teardown while one is in flight', async () => {
    const hook = useHook({ isPending: true });
    render(<DemoBanner />);

    const remove = screen.getByTestId('demo-banner-remove');
    await userEvent.click(remove);
    // The guard, not the attribute, is what makes it inert: an `aria-disabled`
    // control is still clickable and still activates on Enter.
    expect(hook.teardown).not.toHaveBeenCalled();
  });

  it('stays focusable and keeps its focus while the teardown runs, and says why', async () => {
    // `disabled` is the banned pattern here — it drops the button out of the tab
    // order mid-action and blurs the focus the user just placed on it, throwing a
    // keyboard user back to the top of the document by the very click they made.
    useHook({ isPending: true });
    render(<DemoBanner />);

    const remove = screen.getByTestId('demo-banner-remove');
    expect(remove.hasAttribute('disabled')).toBe(false);
    expect(remove.getAttribute('aria-disabled')).toBe('true');

    remove.focus();
    expect(document.activeElement).toBe(remove);
    await userEvent.tab();
    // Still in the tab order at all — a `disabled` button cannot be tabbed TO,
    // which is the property this asserts the absence of.
    remove.focus();
    expect(document.activeElement).toBe(remove);

    // Inert states state their reason, and the control points at it.
    const note = screen.getByTestId('demo-banner-removal-note');
    expect(note.getAttribute('role')).toBe('status');
    expect(remove.getAttribute('aria-describedby')).toBe(note.id);
  });

  it('carries no in-flight note and no inert attribute when idle', () => {
    useHook({ isPending: false });
    render(<DemoBanner />);

    const remove = screen.getByTestId('demo-banner-remove');
    expect(remove.hasAttribute('aria-disabled')).toBe(false);
    expect(remove.hasAttribute('aria-describedby')).toBe(false);
    expect(screen.queryByTestId('demo-banner-removal-note')).toBeNull();
  });

  it('uses the info status role and never the financial-semantic tokens', () => {
    useHook();
    render(<DemoBanner />);

    const banner = screen.getByTestId('demo-banner');
    expect(banner.className).toContain('border-info/20');
    expect(banner.className).toContain('bg-info/10');
    // Provenance is a system-status statement, not a statement about money
    // direction. Borrowing gain/loss here would colour a neutral notice as a P&L.
    expect(banner.outerHTML).not.toMatch(/\b(text|bg|border)-(gain|loss|flat)\b/);
    // Nor any literal colour, which would only be right in one theme.
    expect(banner.outerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('announces itself politely rather than interrupting', () => {
    useHook();
    render(<DemoBanner />);

    // It mounts on every navigation; assertive would re-announce it each time.
    expect(screen.getByTestId('demo-banner').getAttribute('aria-live')).toBe('polite');
  });

  it('stacks below `sm`, sits in a row above it, and sets no fixed width', () => {
    useHook();
    render(<DemoBanner />);

    const banner = screen.getByTestId('demo-banner');
    expect(banner.className).toContain('flex-col');
    expect(banner.className).toContain('sm:flex-row');

    const remove = screen.getByTestId('demo-banner-remove');
    expect(remove.className).toContain('w-full');
    expect(remove.className).toContain('sm:w-auto');
    expect(banner.outerHTML).not.toMatch(/\bmin-w-\[/);
    expect(banner.outerHTML).not.toMatch(/\bw-\[\d/);
  });

  it('gives its button the pointer cursor and holds its transitions still', () => {
    useHook();
    render(<DemoBanner />);

    const remove = screen.getByTestId('demo-banner-remove');
    expect(remove.className).toContain('cursor-pointer');
    expect(remove.className).toContain('motion-reduce:transition-none');
  });
});

// @vitest-environment jsdom
//
// `useDemoAccount` is faked wholesale — it has its own tests — so this file is
// only about what the banner does with the answer: says the figures are sample
// data, carries the control that removes them (R9.4), and stays out of the way
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
    // R9.4: the notice and the way out are the same control.
    expect(screen.getByTestId('demo-banner-remove')).toBeTruthy();
  });

  it('removes the sample data on one click, with no confirmation step (R9.5)', async () => {
    const hook = useHook();
    render(<DemoBanner />);

    await userEvent.click(screen.getByTestId('demo-banner-remove'));

    expect(hook.teardown).toHaveBeenCalledTimes(1);
  });

  it('does not fire a second teardown while one is in flight', async () => {
    const hook = useHook({ isPending: true });
    render(<DemoBanner />);

    const remove = screen.getByTestId('demo-banner-remove');
    expect(remove.hasAttribute('disabled')).toBe(true);
    await userEvent.click(remove);
    expect(hook.teardown).not.toHaveBeenCalled();
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

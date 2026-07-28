// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mock BlackScholesCard so this test stays focused on the tab wrapper and
// avoids booting react-hook-form / the full pricing card.
vi.mock('@/features/options/components/BlackScholesCard', () => ({
  BlackScholesCard: vi.fn((props: { density?: string }) => (
    <div data-testid="bs-card" data-density={props.density} />
  )),
}));

import { BlackScholesCard } from '@/features/options/components/BlackScholesCard';

import { OptionsPricingTab } from './OptionsPricingTab';

describe('OptionsPricingTab', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(BlackScholesCard).mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders the BlackScholesCard with compact density', () => {
    act(() => {
      root.render(<OptionsPricingTab />);
    });
    const card = container.querySelector('[data-testid="bs-card"]');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('data-density')).toBe('compact');
    expect(vi.mocked(BlackScholesCard).mock.calls[0]?.[0]).toMatchObject({
      density: 'compact',
    });
  });

  it('shows the reset notice copy', () => {
    act(() => {
      root.render(<OptionsPricingTab />);
    });
    expect(container.textContent).toContain('Inputs reset when you leave this tab.');
  });
});

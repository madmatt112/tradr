// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makePosition } from '@/features/positions/__fixtures__/position-fixtures';
import { usePositions } from '@/features/positions/hooks/usePositions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Stub the router <Link> with a plain anchor — no router context needed.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));

vi.mock('@/features/accounts/hooks/useAccounts', () => ({
  useAccounts: () => ({ data: [{ id: 'a1' }] }),
}));

vi.mock('@/features/positions/hooks/usePositions', () => ({
  usePositions: vi.fn(),
}));

vi.mock('@/lib/telemetry/posthog', () => ({
  captureClientEvent: vi.fn(),
}));

vi.mock('./CreatePositionDialog', () => ({
  CreatePositionDialog: () => null,
}));

import { PositionList } from './PositionList';

type PositionsResult = ReturnType<typeof usePositions>;

function mountWith(ui: React.ReactElement): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return { container, root };
}

function unmount(container: HTMLElement, root: Root): void {
  act(() => {
    root.unmount();
  });
  container.remove();
}

afterEach(() => {
  vi.clearAllMocks();
});

function mockNetPnl(netPnl: number | null) {
  vi.mocked(usePositions).mockReturnValue({
    data: [makePosition({ netPnl, accountCurrency: 'USD', brokerageFees: 0 })],
    isLoading: false,
  } as unknown as PositionsResult);
}

describe('PositionList — P&L renders via <Numeric>', () => {
  it('gain: leading +, text-gain, no arrow glyph', () => {
    mockNetPnl(125.5);
    const { container, root } = mountWith(<PositionList />);
    const n = container.querySelector('[data-testid="position-pnl"] [data-testid="numeric"]')!;
    expect(n.getAttribute('data-state')).toBe('gain');
    expect(n.className).toContain('text-gain');
    expect(n.textContent).toContain('+');
    expect(n.querySelector('svg')).toBeNull();
    unmount(container, root);
  });

  it('loss: leading −, text-loss, no arrow glyph', () => {
    mockNetPnl(-40);
    const { container, root } = mountWith(<PositionList />);
    const n = container.querySelector('[data-testid="position-pnl"] [data-testid="numeric"]')!;
    expect(n.getAttribute('data-state')).toBe('loss');
    expect(n.className).toContain('text-loss');
    expect(n.textContent).toContain('−'); // U+2212
    expect(n.querySelector('svg')).toBeNull();
    unmount(container, root);
  });

  it('flat: literal 0.00, no marker, never em-dash', () => {
    mockNetPnl(0);
    const { container, root } = mountWith(<PositionList />);
    const n = container.querySelector('[data-testid="position-pnl"] [data-testid="numeric"]')!;
    expect(n.getAttribute('data-state')).toBe('flat');
    expect(n.textContent).toContain('0.00');
    expect(n.textContent).not.toContain('—');
    unmount(container, root);
  });

  it('absent (null): em-dash, no glyph', () => {
    mockNetPnl(null);
    const { container, root } = mountWith(<PositionList />);
    const n = container.querySelector('[data-testid="position-pnl"] [data-testid="numeric"]')!;
    expect(n.getAttribute('data-state')).toBe('absent');
    expect(n.textContent).toContain('—');
    expect(n.querySelector('svg')).toBeNull();
    unmount(container, root);
  });
});

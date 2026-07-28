// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProposedPosition } from '@tradr/shared';

import { ProposedPositions } from './ProposedPositions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

afterEach(() => {});

function makeProposed(overrides: Partial<ProposedPosition> = {}): ProposedPosition {
  return {
    scope: { symbol: 'AAPL', assetType: 'stock' },
    side: 'long',
    closes: true,
    fills: [
      { type: 'entry', price: '150', quantity: '10', fees: '0', filledAt: '2026-05-01', sourceRow: 2 },
    ],
    proposedPnl: 0,
    ...overrides,
  };
}

function renderWith(pos: ProposedPosition) {
  return mountWith(
    <ProposedPositions positions={[pos]} errors={[]} warnings={[]} currencyCode="USD" />,
  );
}

describe('ProposedPositions — proposed P&L renders via <Numeric>', () => {
  it('gain: leading +, text-gain, no arrow glyph', () => {
    const { container, root } = renderWith(makeProposed({ proposedPnl: 320.5 }));
    const n = container.querySelector('[data-testid="numeric"]')!;
    expect(n.getAttribute('data-state')).toBe('gain');
    expect(n.className).toContain('text-gain');
    expect(n.textContent).toContain('+');
    expect(n.querySelector('svg')).toBeNull();
    unmount(container, root);
  });

  it('loss: leading −, text-loss, no arrow glyph', () => {
    const { container, root } = renderWith(makeProposed({ proposedPnl: -75 }));
    const n = container.querySelector('[data-testid="numeric"]')!;
    expect(n.getAttribute('data-state')).toBe('loss');
    expect(n.className).toContain('text-loss');
    expect(n.textContent).toContain('−'); // U+2212
    expect(n.querySelector('svg')).toBeNull();
    unmount(container, root);
  });

  it('flat: literal 0.00, no marker, never em-dash', () => {
    const { container, root } = renderWith(makeProposed({ proposedPnl: 0 }));
    const n = container.querySelector('[data-testid="numeric"]')!;
    expect(n.getAttribute('data-state')).toBe('flat');
    expect(n.textContent).toContain('0.00');
    expect(n.textContent).not.toContain('—');
    unmount(container, root);
  });

  it('not-applicable (open position): the muted em-dash, no <Numeric>', () => {
    const { container, root } = renderWith(makeProposed({ closes: false, proposedPnl: undefined }));
    expect(container.querySelector('[data-testid="numeric"]')).toBeNull();
    expect(container.textContent).toContain('—');
    unmount(container, root);
  });
});

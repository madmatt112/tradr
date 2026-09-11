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
      {
        type: 'entry',
        price: '150',
        quantity: '10',
        fees: '0',
        filledAt: '2026-05-01',
        sourceRow: 2,
      },
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

describe('ProposedPositions — decoded contract label', () => {
  it('option: renders the contract in words with the compact symbol beside it', () => {
    const { container, root } = renderWith(
      makeProposed({ scope: { symbol: 'AAPL260320C250', assetType: 'option' } }),
    );
    expect(container.textContent).toContain('AAPL 20 Mar 2026 $250 Call');
    const mono = container.querySelector('.font-mono');
    expect(mono).not.toBeNull();
    expect(mono!.textContent).toBe('AAPL260320C250');
    unmount(container, root);
  });

  it('stock: renders the raw symbol and no font-mono span', () => {
    const { container, root } = renderWith(
      makeProposed({ scope: { symbol: 'AAPL', assetType: 'stock' } }),
    );
    expect(container.textContent).toContain('AAPL');
    expect(container.querySelector('.font-mono')).toBeNull();
    unmount(container, root);
  });

  it('option with an unparseable symbol: falls back to the raw symbol', () => {
    const { container, root } = renderWith(
      makeProposed({ scope: { symbol: 'AAPL-LEGACY', assetType: 'option' } }),
    );
    expect(container.textContent).toContain('AAPL-LEGACY');
    expect(container.querySelector('.font-mono')).toBeNull();
    unmount(container, root);
  });
});

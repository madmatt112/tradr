// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { WidgetPlacement, WidgetType } from '@tradr/shared';

import { newWidgetId } from '@/lib/uuid-fallback';

import { AddWidgetPopover, findFirstSlot } from './AddWidgetPopover';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: { container: HTMLElement; root: Root } | null = null;

function mountIntoBody(): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = { container, root };
  return { container, root };
}

afterEach(() => {
  if (mounted) {
    act(() => {
      mounted!.root.unmount();
    });
    mounted.container.remove();
    mounted = null;
  }
});

function listedTypes(): string[] {
  // Radix Popover renders into a portal under document.body; query globally.
  const items = document.querySelectorAll<HTMLElement>('[data-slot="add-widget-item"]');
  return Array.from(items).map((el) => el.getAttribute('data-widget-type') ?? '');
}

function listedLabels(): string[] {
  const items = document.querySelectorAll<HTMLElement>('[data-slot="add-widget-item"]');
  return Array.from(items).map((el) => el.textContent?.trim() ?? '');
}

function emptyVisible(): boolean {
  return document.querySelector('[data-slot="add-widget-empty"]') !== null;
}

describe('AddWidgetPopover', () => {
  it('findFirstSlot returns {x:0, y:2} for {w:4,h:2} given two pre-placed (0,0,6,2) and (6,0,6,2)', () => {
    const existing: WidgetPlacement[] = [
      { id: '00000000-0000-4000-8000-000000000001', type: 'stats-summary', x: 0, y: 0, w: 6, h: 2 },
      { id: '00000000-0000-4000-8000-000000000002', type: 'open-positions', x: 6, y: 0, w: 6, h: 2 },
    ];
    const slot = findFirstSlot(existing, { w: 4, h: 2 });
    expect(slot).toEqual({ x: 0, y: 2 });
  });

  it('excludes placedTypes from the list and renders remaining four sorted by displayName', () => {
    const { root } = mountIntoBody();
    act(() => {
      root.render(
        <AddWidgetPopover
          placedTypes={['stats-summary', 'open-positions']}
          onAdd={() => undefined}
          defaultOpen
        />,
      );
    });
    const labels = listedLabels();
    const types = listedTypes();
    // Excluded types absent.
    expect(types).not.toContain('stats-summary');
    expect(types).not.toContain('open-positions');
    // Other four present, sorted by displayName ascending:
    // 'Account Balances', 'Equity Curve', 'Performance Chart', 'Position Sizing'.
    expect(labels).toEqual([
      'Account Balances',
      'Equity Curve',
      'Performance Chart',
      'Position Sizing',
    ]);
  });

  it('newWidgetId falls back to Math.random v4 when globalThis.crypto.randomUUID is undefined', () => {
    const originalCrypto = globalThis.crypto;
    // Replace crypto with one whose randomUUID is undefined; preserves other surface.
    const stub: Partial<Crypto> = {
      ...(originalCrypto as unknown as Record<string, unknown>),
      randomUUID: undefined as unknown as Crypto['randomUUID'],
    };
    Object.defineProperty(globalThis, 'crypto', {
      value: stub,
      configurable: true,
      writable: true,
    });
    try {
      const id = newWidgetId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: originalCrypto,
        configurable: true,
        writable: true,
      });
    }
  });

  it('transitions from 5-placed (one entry, no empty copy) to 6-placed (empty copy, no entries) via rerender', () => {
    const fiveTypes: WidgetType[] = [
      'stats-summary',
      'open-positions',
      'performance-chart',
      'account-balances',
      'position-sizing',
    ];
    const sixTypes: WidgetType[] = [...fiveTypes, 'equity-curve'];

    const { root } = mountIntoBody();
    // First render: 5 placed → "All widgets added." NOT visible AND ONE entry.
    act(() => {
      root.render(
        <AddWidgetPopover
          placedTypes={fiveTypes}
          onAdd={() => undefined}
          defaultOpen
        />,
      );
    });
    expect(emptyVisible()).toBe(false);
    expect(listedTypes()).toEqual(['equity-curve']);

    // Re-render SAME instance: 6 placed → "All widgets added." IS visible AND no entries.
    act(() => {
      root.render(
        <AddWidgetPopover
          placedTypes={sixTypes}
          onAdd={() => undefined}
          defaultOpen
        />,
      );
    });
    expect(emptyVisible()).toBe(true);
    expect(listedTypes()).toEqual([]);
  });
});

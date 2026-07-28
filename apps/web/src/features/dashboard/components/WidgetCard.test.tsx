// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

import type { WidgetPlacement } from '@tradr/shared';

import { WidgetCard, clampResize } from './WidgetCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeWidget(over: Partial<WidgetPlacement> = {}): WidgetPlacement {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    type: 'stats-summary',
    x: 0,
    y: 0,
    w: 4,
    h: 2,
    ...over,
  } as WidgetPlacement;
}

describe('clampResize', () => {
  it('shrinks request when it would overlap an east neighbor at x = self.x + self.w + 1', () => {
    const self = { x: 0, y: 0, w: 4, h: 2 };
    const east: WidgetPlacement = makeWidget({
      id: '00000000-0000-4000-8000-00000000000e',
      type: 'open-positions',
      x: self.x + self.w + 1, // 5
      y: 0,
      w: 4,
      h: 2,
    });
    // Cell-domain input: cellPx=1, gapPx=0, hysteresisPx=0 → request in cells.
    const result = clampResize({ w: self.w, h: self.h }, { w: 10, h: 2 }, [east], 0, 1, 0, {
      x: self.x,
      y: self.y,
    });
    // Neighbor occupies col 5+. Self at x=0 can be at most w = neighbor.x - self.x = 5.
    expect(result.w).toBe(5);
  });

  it('shrinks request when it would overlap a south neighbor at y = self.y + self.h + 1', () => {
    const self = { x: 0, y: 0, w: 4, h: 2 };
    const south: WidgetPlacement = makeWidget({
      id: '00000000-0000-4000-8000-00000000000a',
      type: 'open-positions',
      x: 0,
      y: self.y + self.h + 1, // 3
      w: 4,
      h: 2,
    });
    const result = clampResize({ w: self.w, h: self.h }, { w: 4, h: 10 }, [south], 0, 1, 0, {
      x: self.x,
      y: self.y,
    });
    // Neighbor at y=3 → self at y=0 max h = 3.
    expect(result.h).toBe(3);
  });

  it('applies floor + ½-cell hysteresis snap: < ½-cell stays, ≥ ½-cell snaps up', () => {
    // cellPx=100, gapPx=0 → span=100; halfCell=50; hysteresisPx=1 → deadband 49..51px.
    const current = { w: 2, h: 2 };
    const selfPos = { x: 0, y: 0 };
    // Case A: request 240px → 40px past 2-cell boundary; inside deadband → stays at current (2).
    const stays = clampResize(current, { w: 240, h: 200 }, [], 1, 100, 0, selfPos);
    expect(stays.w).toBe(2);
    // Case B: request 260px → 60px past 2-cell boundary; past deadband → snaps to 3.
    const snaps = clampResize(current, { w: 260, h: 200 }, [], 1, 100, 0, selfPos);
    expect(snaps.w).toBe(3);
  });

  it('with no neighbors clamps only to the 12-column / 6-row bound', () => {
    const selfPos = { x: 2, y: 0 };
    const result = clampResize({ w: 4, h: 2 }, { w: 15, h: 2 }, [], 0, 1, 0, selfPos);
    // No neighbors → only grid bound: 12 - x = 12 - 2 = 10.
    expect(result.w).toBe(12 - selfPos.x);
  });
});

describe('WidgetCard — focus management', () => {
  it('focuses the section element on mount when focusOnMount is true', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <WidgetCard widget={makeWidget()} neighbors={[]} onRemove={() => undefined} focusOnMount />,
      );
    });
    const section = container.querySelector('section[role="region"]');
    expect(section).not.toBeNull();
    expect(document.activeElement).toBe(section);
    act(() => {
      root.unmount();
    });
    container.remove();
  });
});

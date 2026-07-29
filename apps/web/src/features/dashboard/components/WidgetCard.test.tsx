// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import type { WidgetPlacement } from '@tradr/shared';

import type { GridRect } from '../resize';

import { WidgetCard } from './WidgetCard';

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

function mount(): { container: HTMLElement; root: ReturnType<typeof createRoot> } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, root: createRoot(container) };
}

function fire(
  el: Element,
  type: string,
  init: { pointerId: number; clientX: number; clientY: number },
): void {
  // jsdom has no PointerEvent constructor; MouseEvent carries the same
  // clientX/clientY React reads. Those are getters, so they go through the
  // constructor and only pointerId is defined on top.
  const event = new MouseEvent(type, {
    bubbles: true,
    clientX: init.clientX,
    clientY: init.clientY,
  });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId });
  el.dispatchEvent(event);
}

describe('WidgetCard — resize handles', () => {
  it('renders the three edges and four corners when resize is enabled', () => {
    const { container, root } = mount();
    act(() => {
      root.render(
        <WidgetCard widget={makeWidget()} onRemove={() => undefined} onResize={() => undefined} />,
      );
    });
    const edges = Array.from(container.querySelectorAll('[data-resize-handle="true"]')).map((el) =>
      el.getAttribute('data-resize-edge'),
    );
    expect(edges).toEqual([
      'left',
      'right',
      'bottom',
      'top-left',
      'top-right',
      'bottom-left',
      'bottom-right',
    ]);
    // No TOP edge strip — the header owns that band as the drag zone.
    expect(edges).not.toContain('top');
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('omits every handle when resize is disabled', () => {
    const { container, root } = mount();
    act(() => {
      root.render(<WidgetCard widget={makeWidget()} onRemove={() => undefined} />);
    });
    expect(container.querySelectorAll('[data-resize-handle="true"]')).toHaveLength(0);
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('converts a bottom-right drag into a larger rect with the origin anchored', () => {
    const { container, root } = mount();
    const rects: GridRect[] = [];
    act(() => {
      root.render(
        <WidgetCard
          widget={makeWidget({ x: 0, y: 0, w: 4, h: 2 })}
          onRemove={() => undefined}
          gapPx={0}
          onResize={(rect) => rects.push(rect)}
        />,
      );
    });
    const section = container.querySelector('section[role="region"]') as HTMLElement;
    // 4 columns × 100px, 2 rows × 80px, gap 0.
    section.getBoundingClientRect = () => ({ width: 400, height: 160 }) as DOMRect;
    const handle = container.querySelector('[data-resize-edge="bottom-right"]')!;

    act(() => {
      fire(handle, 'pointerdown', { pointerId: 1, clientX: 400, clientY: 160 });
    });
    act(() => {
      // +200px → +2 columns; +160px → +2 rows.
      fire(handle, 'pointermove', { pointerId: 1, clientX: 600, clientY: 320 });
    });
    act(() => {
      fire(handle, 'pointerup', { pointerId: 1, clientX: 600, clientY: 320 });
    });

    expect(rects.at(-1)).toEqual({ x: 0, y: 0, w: 6, h: 4 });

    // After pointerup the gesture is over — further movement is ignored.
    const settled = rects.length;
    act(() => {
      fire(handle, 'pointermove', { pointerId: 1, clientX: 900, clientY: 600 });
    });
    expect(rects.length).toBe(settled);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('moves the origin when the left edge is dragged, holding the right edge', () => {
    const { container, root } = mount();
    const rects: GridRect[] = [];
    act(() => {
      root.render(
        <WidgetCard
          widget={makeWidget({ x: 4, y: 1, w: 4, h: 2 })}
          onRemove={() => undefined}
          gapPx={0}
          onResize={(rect) => rects.push(rect)}
        />,
      );
    });
    const section = container.querySelector('section[role="region"]') as HTMLElement;
    section.getBoundingClientRect = () => ({ width: 400, height: 160 }) as DOMRect;
    const handle = container.querySelector('[data-resize-edge="left"]')!;

    act(() => {
      fire(handle, 'pointerdown', { pointerId: 1, clientX: 400, clientY: 200 });
    });
    act(() => {
      // Drag 200px left → 2 columns; right edge (x + w = 8) must not move.
      fire(handle, 'pointermove', { pointerId: 1, clientX: 200, clientY: 200 });
    });
    expect(rects.at(-1)).toEqual({ x: 2, y: 1, w: 6, h: 2 });
    act(() => {
      fire(handle, 'pointerup', { pointerId: 1, clientX: 200, clientY: 200 });
    });

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('reports gesture start and end so the grid can show its backdrop', () => {
    const { container, root } = mount();
    const onResizeStart = vi.fn();
    const onResizeEnd = vi.fn();
    act(() => {
      root.render(
        <WidgetCard
          widget={makeWidget()}
          onRemove={() => undefined}
          onResize={() => undefined}
          onResizeStart={onResizeStart}
          onResizeEnd={onResizeEnd}
        />,
      );
    });
    const handle = container.querySelector('[data-resize-edge="bottom"]')!;
    act(() => {
      fire(handle, 'pointerdown', { pointerId: 1, clientX: 0, clientY: 0 });
    });
    expect(onResizeStart).toHaveBeenCalledTimes(1);
    expect(onResizeEnd).not.toHaveBeenCalled();
    act(() => {
      fire(handle, 'pointerup', { pointerId: 1, clientX: 0, clientY: 0 });
    });
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
    act(() => {
      root.unmount();
    });
    container.remove();
  });
});

describe('WidgetCard — header drag zone', () => {
  it('routes header pointerdown to the dnd-kit activator', () => {
    const { container, root } = mount();
    const onPointerDown = vi.fn();
    act(() => {
      root.render(
        <WidgetCard
          widget={makeWidget()}
          onRemove={() => undefined}
          dragHandleProps={{ onPointerDown }}
        />,
      );
    });
    const header = container.querySelector('[data-drag-zone="true"]');
    expect(header).not.toBeNull();
    act(() => {
      fire(header!, 'pointerdown', { pointerId: 1, clientX: 0, clientY: 0 });
    });
    expect(onPointerDown).toHaveBeenCalledTimes(1);
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('does not arm a drag when the overflow menu is pressed', () => {
    // The menu sits inside the drag zone; without the stopPropagation guard
    // opening it would also start a drag.
    const { container, root } = mount();
    const onPointerDown = vi.fn();
    act(() => {
      root.render(
        <WidgetCard
          widget={makeWidget()}
          onRemove={() => undefined}
          dragHandleProps={{ onPointerDown }}
        />,
      );
    });
    const menu = container.querySelector('[aria-label="Stats Summary menu"]')!;
    act(() => {
      fire(menu, 'pointerdown', { pointerId: 1, clientX: 0, clientY: 0 });
    });
    expect(onPointerDown).not.toHaveBeenCalled();
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('leaves the header inert when drag is disabled', () => {
    const { container, root } = mount();
    act(() => {
      root.render(<WidgetCard widget={makeWidget()} onRemove={() => undefined} />);
    });
    expect(container.querySelector('[data-drag-zone="true"]')).toBeNull();
    act(() => {
      root.unmount();
    });
    container.remove();
  });
});

describe('WidgetCard — focus management', () => {
  it('focuses the section element on mount when focusOnMount is true', () => {
    const { container, root } = mount();
    act(() => {
      root.render(<WidgetCard widget={makeWidget()} onRemove={() => undefined} focusOnMount />);
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

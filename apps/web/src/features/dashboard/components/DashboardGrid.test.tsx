// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WidgetPlacement } from '@tradr/shared';

import { applyDragEnd, applyResize, buildAnnouncements, DashboardGrid } from './DashboardGrid';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const W = (over: Partial<WidgetPlacement>): WidgetPlacement =>
  ({
    id: '00000000-0000-4000-8000-000000000001',
    type: 'stats-summary',
    x: 0,
    y: 0,
    w: 4,
    h: 2,
    ...over,
  }) as WidgetPlacement;

function mountIntoBody(): { container: HTMLElement; root: ReturnType<typeof createRoot> } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

// matchMedia spy. Tests set the active query → match map before rendering.
let matchMediaSpy: { mockRestore: () => void } | null = null;
function installMatchMediaSpy(matches: Record<string, boolean>): void {
  const spy = vi.spyOn(window, 'matchMedia');
  spy.mockImplementation(((q: string) => ({
    matches: matches[q] ?? false,
    media: q,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as (query: string) => MediaQueryList);
  matchMediaSpy = spy;
}

afterEach(() => {
  matchMediaSpy?.mockRestore();
  matchMediaSpy = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DashboardGrid — mobile fallback ordering', () => {
  it('renders widgets in (y, x) ascending order when below md', () => {
    installMatchMediaSpy({ '(max-width: 767px)': true });
    const shuffled: WidgetPlacement[] = [
      W({ id: 'c', type: 'open-positions', x: 0, y: 2 }),
      W({ id: 'a', type: 'stats-summary', x: 0, y: 0 }),
      W({ id: 'd', type: 'account-balances', x: 4, y: 2 }),
      W({ id: 'b', type: 'performance-chart', x: 6, y: 0 }),
    ];
    const { container, root } = mountIntoBody();
    act(() => {
      root.render(
        <DashboardGrid
          widgets={shuffled}
          onRemove={() => undefined}
          scheduleLayoutWrite={() => undefined}
        />,
      );
    });
    const wrapper = container.querySelector('[data-grid-mode="mobile"]');
    expect(wrapper).not.toBeNull();
    // Only inspect direct-child slot wrappers — WidgetCard internally also
    // stamps a data-widget-id on its <section>, which would double-count.
    const order = Array.from(wrapper!.children)
      .map((el) => el.getAttribute('data-widget-id'))
      .filter((id): id is string => id !== null);
    expect(order).toEqual(['a', 'b', 'c', 'd']);
    act(() => {
      root.unmount();
    });
    container.remove();
  });
});

describe('DashboardGrid — dnd-kit announcements (Req 4.11.1 verbatim)', () => {
  it('emits the four announcement strings verbatim', () => {
    const widgets: WidgetPlacement[] = [
      W({ id: 'a', type: 'stats-summary', x: 3, y: 1 }),
      W({ id: 'b', type: 'open-positions', x: 6, y: 4 }),
    ];
    const ann = buildAnnouncements(widgets, (type) => {
      if (type === 'stats-summary') return 'Stats Summary';
      if (type === 'open-positions') return 'Open Positions';
      return '';
    });
    const startStr = ann.onDragStart!({ active: { id: 'a' } } as never);
    const overStr = ann.onDragOver!({ active: { id: 'a' }, over: { id: 'b' } } as never);
    const endStr = ann.onDragEnd!({ active: { id: 'a' }, over: { id: 'b' } } as never);
    const cancelStr = ann.onDragCancel!({ active: { id: 'a' } } as never);
    expect(startStr).toBe('Picked up Stats Summary at column 3, row 1.');
    expect(overStr).toBe('Stats Summary is over column 6, row 4.');
    expect(endStr).toBe('Stats Summary dropped at column 6, row 4.');
    expect(cancelStr).toBe('Picking up Stats Summary was cancelled.');
  });
});

describe('DashboardGrid — DragOverlay mounts for active state', () => {
  it('renders DragOverlay snapshot of the active widget after onDragStart fires (keyboard or pointer)', async () => {
    installMatchMediaSpy({});
    const widgets: WidgetPlacement[] = [
      W({ id: 'a', type: 'stats-summary', x: 0, y: 0 }),
      W({ id: 'b', type: 'open-positions', x: 6, y: 0 }),
    ];
    // Capture the onDragStart handler dnd-kit's DndContext receives so we can
    // invoke it directly (the KeyboardSensor activator → onDragStart pipeline
    // is what we want to assert on, without simulating jsdom keydown timing).
    let capturedOnDragStart: ((e: { active: { id: string } }) => void) | null = null;
    vi.resetModules();
    vi.doMock('@dnd-kit/core', async () => {
      const actual = await vi.importActual<typeof import('@dnd-kit/core')>('@dnd-kit/core');
      return {
        ...actual,
        DndContext: ({
          children,
          onDragStart,
        }: {
          children: React.ReactNode;
          onDragStart?: (e: { active: { id: string } }) => void;
        }) => {
          capturedOnDragStart = onDragStart ?? null;
          return <div data-testid="dnd-context-mock">{children}</div>;
        },
        // Passthrough so the active snapshot renders whenever children exist
        // (DragOverlay's real impl needs DndContext's context, which our mock
        // strips out).
        DragOverlay: ({ children }: { children?: React.ReactNode }) => (
          <div data-testid="drag-overlay-mock">{children}</div>
        ),
      };
    });
    // Re-import after mocking so the mocked DndContext is used.
    const mod = await import('./DashboardGrid');
    const { container, root } = mountIntoBody();
    act(() => {
      root.render(
        <mod.DashboardGrid
          widgets={widgets}
          onRemove={() => undefined}
          scheduleLayoutWrite={() => undefined}
        />,
      );
    });
    // Before drag starts, DragOverlay has no active snapshot.
    expect(container.querySelector('[data-drag-overlay="true"]')).toBeNull();
    // Simulate KeyboardSensor activation: invoke onDragStart with active id 'a'.
    expect(capturedOnDragStart).not.toBeNull();
    act(() => {
      capturedOnDragStart!({ active: { id: 'a' } });
    });
    const overlay = container.querySelector('[data-drag-overlay="true"]');
    expect(overlay).not.toBeNull();
    expect(overlay!.getAttribute('data-active-widget-id')).toBe('a');
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.doUnmock('@dnd-kit/core');
  });
});

describe('DashboardGrid — cell backdrop during a gesture', () => {
  function firePointer(el: Element, type: string): void {
    const event = new MouseEvent(type, { bubbles: true, clientX: 0, clientY: 0 });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    el.dispatchEvent(event);
  }

  it('appears the moment a drag zone is pressed, before any movement', () => {
    // dnd-kit withholds onDragStart until its 4px activation distance is met,
    // so keying the edit state off the drag alone made the grid appear late.
    installMatchMediaSpy({});
    const widgets: WidgetPlacement[] = [
      W({ id: 'a', type: 'stats-summary', x: 0, y: 0, w: 12, h: 1 }),
    ];
    const { container, root } = mountIntoBody();
    act(() => {
      root.render(
        <DashboardGrid
          widgets={widgets}
          onRemove={() => undefined}
          scheduleLayoutWrite={() => undefined}
        />,
      );
    });
    const editing = (): string | null =>
      container.querySelector('[data-grid-mode="grid"]')?.getAttribute('data-editing') ?? null;

    expect(editing()).toBeNull();

    const zone = container.querySelector('[data-drag-zone="true"]')!;
    act(() => {
      firePointer(zone, 'pointerdown');
    });
    // No pointermove at all — the press alone is enough.
    expect(editing()).toBe('true');
    expect(container.querySelectorAll('[data-grid-backdrop-cell="true"]').length).toBeGreaterThan(
      0,
    );

    // Releasing without ever dragging clears it, even though the release
    // lands on the window rather than the pressed element.
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    });
    expect(editing()).toBeNull();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('is hidden at rest, covers the occupied rows during a resize, and clears after', () => {
    installMatchMediaSpy({});
    const widgets: WidgetPlacement[] = [
      W({ id: 'a', type: 'stats-summary', x: 0, y: 0, w: 12, h: 1 }),
      W({ id: 'b', type: 'open-positions', x: 0, y: 1, w: 12, h: 2 }),
    ];
    const { container, root } = mountIntoBody();
    act(() => {
      root.render(
        <DashboardGrid
          widgets={widgets}
          onRemove={() => undefined}
          scheduleLayoutWrite={() => undefined}
        />,
      );
    });
    const backdrop = (): number =>
      container.querySelectorAll('[data-grid-backdrop-cell="true"]').length;

    expect(backdrop()).toBe(0);

    const handle = container.querySelector('[data-resize-handle="true"]');
    expect(handle).not.toBeNull();
    act(() => {
      firePointer(handle!, 'pointerdown');
    });
    // Occupied rows = max(y + h) = 3 → 3 rows × 12 columns.
    expect(backdrop()).toBe(36);
    expect(container.querySelector('[data-grid-mode="grid"]')?.getAttribute('data-editing')).toBe(
      'true',
    );

    act(() => {
      firePointer(handle!, 'pointerup');
    });
    expect(backdrop()).toBe(0);

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});

describe('DashboardGrid — ResizeObserver lifecycle', () => {
  let observeSpy: ReturnType<typeof vi.fn>;
  let disconnectSpy: ReturnType<typeof vi.fn>;
  let originalRO: typeof ResizeObserver | undefined;

  beforeEach(() => {
    observeSpy = vi.fn();
    disconnectSpy = vi.fn();
    originalRO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    class RO {
      observe = observeSpy;
      disconnect = disconnectSpy;
      unobserve = vi.fn();
      constructor(_cb: ResizeObserverCallback) {
        void _cb;
      }
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
      RO as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    if (originalRO) {
      (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = originalRO;
    } else {
      delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    }
  });

  it('calls observe on mount and disconnect on unmount', () => {
    // Use mobile mode so dnd-kit (which spawns its own internal observers) is
    // not mounted — only the grid's own ResizeObserver runs.
    installMatchMediaSpy({ '(max-width: 767px)': true });
    const widgets: WidgetPlacement[] = [W({ id: 'a', type: 'stats-summary' })];
    const { container, root } = mountIntoBody();
    act(() => {
      root.render(
        <DashboardGrid
          widgets={widgets}
          onRemove={() => undefined}
          scheduleLayoutWrite={() => undefined}
        />,
      );
    });
    expect(observeSpy).toHaveBeenCalledTimes(1);
    act(() => {
      root.unmount();
    });
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    container.remove();
  });
});

describe('applyDragEnd — drag-end merge (v3-7 / v4-4)', () => {
  it('swaps the dragged widget into the over-widget slot and shifts the displaced one', () => {
    const prev: WidgetPlacement[] = [
      W({ id: 'a', type: 'stats-summary', x: 0, y: 0, w: 6, h: 2 }),
      W({ id: 'b', type: 'open-positions', x: 6, y: 0, w: 6, h: 2 }),
    ];
    const next = applyDragEnd(prev, 'a', 'b');
    const a = next.find((w) => w.id === 'a')!;
    const b = next.find((w) => w.id === 'b')!;
    expect({ x: a.x, y: a.y }).toEqual({ x: 6, y: 0 });
    expect({ x: b.x, y: b.y }).toEqual({ x: 0, y: 0 });
    // Sizes preserved.
    expect({ w: a.w, h: a.h }).toEqual({ w: 6, h: 2 });
    expect({ w: b.w, h: b.h }).toEqual({ w: 6, h: 2 });
  });

  it('does not produce an overlapping layout when the two widgets are different sizes', () => {
    // A bare (x, y) swap of a 12×1 and a 6×2 overlaps, and the server rejects
    // overlapping layouts (`checkNoOverlap`), so the write would 400 and roll
    // back. Re-packing keeps the result valid.
    const prev: WidgetPlacement[] = [
      W({ id: 'stats', type: 'stats-summary', x: 0, y: 0, w: 12, h: 1 }),
      W({ id: 'perf', type: 'performance-chart', x: 0, y: 1, w: 6, h: 2 }),
      W({ id: 'bal', type: 'account-balances', x: 6, y: 1, w: 6, h: 2 }),
    ];
    const next = applyDragEnd(prev, 'stats', 'perf');
    for (let i = 0; i < next.length; i++) {
      for (let j = i + 1; j < next.length; j++) {
        const a = next[i];
        const b = next[j];
        const overlaps = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlaps).toBe(false);
      }
    }
    // The dragged widget really moved — it is no longer first in reading order.
    const byReadingOrder = [...next].sort((p, q) => p.y - q.y || p.x - q.x);
    expect(byReadingOrder[0].id).not.toBe('stats');
  });
});

describe('applyResize — growing reflows neighbours instead of stopping', () => {
  const layout: WidgetPlacement[] = [
    W({ id: 'stats', type: 'stats-summary', x: 0, y: 0, w: 12, h: 1 }),
    W({ id: 'perf', type: 'performance-chart', x: 0, y: 1, w: 8, h: 3 }),
    W({ id: 'bal', type: 'account-balances', x: 8, y: 1, w: 4, h: 3 }),
  ];

  function overlapping(widgets: WidgetPlacement[]): boolean {
    for (let i = 0; i < widgets.length; i++) {
      for (let j = i + 1; j < widgets.length; j++) {
        const a = widgets[i];
        const b = widgets[j];
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
          return true;
        }
      }
    }
    return false;
  }

  it('pushes a blocking neighbour aside and keeps the layout overlap-free', () => {
    // 'perf' is boxed in by 'bal' to its east. A clamp-only rule would refuse
    // to grow it at all — which is what made the corner handle look dead.
    const next = applyResize(layout, 'perf', { x: 0, y: 1, w: 12, h: 3 });
    const perf = next.find((w) => w.id === 'perf')!;
    const bal = next.find((w) => w.id === 'bal')!;
    expect({ w: perf.w, h: perf.h }).toEqual({ w: 12, h: 3 });
    // The resized widget stays where it was; the neighbour is the one that moves.
    expect({ x: perf.x, y: perf.y }).toEqual({ x: 0, y: 1 });
    expect(bal.y).toBeGreaterThanOrEqual(perf.y + perf.h);
    expect(overlapping(next)).toBe(false);
  });

  it('lets neighbours close the gap when a widget shrinks', () => {
    const grown = applyResize(layout, 'perf', { x: 0, y: 1, w: 12, h: 3 });
    const shrunk = applyResize(grown, 'perf', { x: 0, y: 1, w: 8, h: 3 });
    const bal = shrunk.find((w) => w.id === 'bal')!;
    // Back beside 'perf' rather than stranded on its own row band.
    expect(bal.y).toBe(1);
    expect(bal.x).toBe(8);
    expect(overlapping(shrunk)).toBe(false);
  });

  it('honours a moved origin from a left-edge or top-corner drag', () => {
    // Dragging 'bal' by its left edge widens it leftward into 'perf'.
    const next = applyResize(layout, 'bal', { x: 6, y: 1, w: 6, h: 3 });
    const bal = next.find((w) => w.id === 'bal')!;
    expect({ x: bal.x, y: bal.y, w: bal.w, h: bal.h }).toEqual({
      x: 6,
      y: 1,
      w: 6,
      h: 3,
    });
    expect(overlapping(next)).toBe(false);
  });

  it('is a no-op when the rect is unchanged or the id is unknown', () => {
    expect(applyResize(layout, 'perf', { x: 0, y: 1, w: 8, h: 3 })).toBe(layout);
    expect(applyResize(layout, 'nope', { x: 0, y: 0, w: 4, h: 4 })).toBe(layout);
  });
});

describe('DashboardGrid — drag handle is wired to dnd-kit', () => {
  it('threads useSortable activator props onto the drag handle button', () => {
    // Regression guard: the grid previously rendered SortableContext without
    // ever calling useSortable, so the handle was inert and no widget could
    // be dragged. dnd-kit stamps aria-roledescription="sortable" onto the
    // activator attributes, so its presence proves the wiring exists.
    installMatchMediaSpy({});
    const widgets: WidgetPlacement[] = [
      W({ id: 'a', type: 'stats-summary', x: 0, y: 0 }),
      W({ id: 'b', type: 'open-positions', x: 6, y: 0 }),
    ];
    const { container, root } = mountIntoBody();
    act(() => {
      root.render(
        <DashboardGrid
          widgets={widgets}
          onRemove={() => undefined}
          scheduleLayoutWrite={() => undefined}
        />,
      );
    });
    const handles = container.querySelectorAll('button[data-drag-handle="true"]');
    expect(handles).toHaveLength(2);
    for (const handle of handles) {
      expect(handle.getAttribute('aria-roledescription')).toBe('sortable');
      // Must not be marked disabled — that is the mobile-only shape.
      expect(handle.getAttribute('aria-disabled')).toBeNull();
    }
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('marks the handle aria-disabled and drops the resize handle in the mobile stack', () => {
    installMatchMediaSpy({ '(pointer: coarse)': true });
    const widgets: WidgetPlacement[] = [W({ id: 'a', type: 'stats-summary' })];
    const { container, root } = mountIntoBody();
    act(() => {
      root.render(
        <DashboardGrid
          widgets={widgets}
          onRemove={() => undefined}
          scheduleLayoutWrite={() => undefined}
        />,
      );
    });
    const handle = container.querySelector('button[data-drag-handle="true"]');
    expect(handle?.getAttribute('aria-disabled')).toBe('true');
    expect(container.querySelector('[data-resize-handle="true"]')).toBeNull();
    act(() => {
      root.unmount();
    });
    container.remove();
  });
});

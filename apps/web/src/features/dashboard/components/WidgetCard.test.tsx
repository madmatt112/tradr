// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

import type { WidgetPlacement } from '@tradr/shared';

import { WidgetCard, WIDGET_DRAG_CANCEL_CLASS, WIDGET_DRAG_HANDLE_CLASS } from './WidgetCard';

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

describe('WidgetCard — drag zone', () => {
  it('puts the drag-handle class on the header so gridstack can target it', () => {
    const { container, root } = mount();
    act(() => {
      root.render(<WidgetCard widget={makeWidget()} onRemove={() => undefined} draggable />);
    });
    const header = container.querySelector('[data-drag-zone="true"]');
    expect(header).not.toBeNull();
    expect(header!.classList.contains(WIDGET_DRAG_HANDLE_CLASS)).toBe(true);
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('wraps the overflow menu in the cancel class so opening it cannot arm a drag', () => {
    const { container, root } = mount();
    act(() => {
      root.render(<WidgetCard widget={makeWidget()} onRemove={() => undefined} draggable />);
    });
    const menu = container.querySelector('[aria-label="Stats Summary menu"]')!;
    expect(menu.closest(`.${WIDGET_DRAG_CANCEL_CLASS}`)).not.toBeNull();
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
    expect(container.querySelector(`.${WIDGET_DRAG_HANDLE_CLASS}`)).toBeNull();
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('exposes no focusable drag control — keyboard grid operation is out of scope', () => {
    const { container, root } = mount();
    act(() => {
      root.render(<WidgetCard widget={makeWidget()} onRemove={() => undefined} draggable />);
    });
    const grip = container.querySelector('[data-drag-handle="true"]')!;
    expect(grip.tagName).toBe('SPAN');
    expect(grip.getAttribute('tabindex')).toBeNull();
    act(() => {
      root.unmount();
    });
    container.remove();
  });
});

describe('WidgetCard — chrome', () => {
  it('renders a labelled region with the widget title', () => {
    const { container, root } = mount();
    act(() => {
      root.render(<WidgetCard widget={makeWidget()} onRemove={() => undefined} />);
    });
    const section = container.querySelector('section[role="region"]')!;
    const titleId = section.getAttribute('aria-labelledby')!;
    expect(container.querySelector(`#${titleId}`)?.textContent).toBe('Stats Summary');
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders the overflow menu trigger', () => {
    const { container, root } = mount();
    act(() => {
      root.render(<WidgetCard widget={makeWidget()} onRemove={() => undefined} />);
    });
    expect(container.querySelector('[aria-label="Stats Summary menu"]')).not.toBeNull();
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

// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PositionImage } from '@tradr/shared';

import { PositionImageLightbox } from './PositionImageLightbox';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: { container: HTMLElement; root: Root } | null = null;

function mount(ui: React.ReactElement): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = { container, root };
  act(() => {
    root.render(ui);
  });
}

afterEach(() => {
  if (mounted) {
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
  vi.clearAllMocks();
});

function image(id: string, unavailable?: true): PositionImage {
  return {
    id,
    format: 'png',
    createdAt: '2026-05-01T00:00:00.000Z',
    ...(unavailable ? { unavailable } : {}),
  };
}

// Radix Dialog renders into a portal under document.body — query globally.
function content(): HTMLElement | null {
  return document.querySelector('[data-slot="dialog-content"]');
}
function title(): string | undefined {
  return document.querySelector('[data-slot="dialog-title"]')?.textContent ?? undefined;
}
function press(key: string): void {
  act(() => {
    content()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

// A stateful host so the controlled `index` prop updates on navigation, the way
// the screenshots section will drive it. `onChange` lets a test observe the
// value the lightbox reports.
function Harness({
  images,
  startIndex,
  onChange,
}: {
  images: PositionImage[];
  startIndex: number;
  onChange?: (index: number | null) => void;
}) {
  const [index, setIndex] = useState<number | null>(startIndex);
  return (
    <PositionImageLightbox
      images={images}
      positionId="p1"
      symbol="AAPL"
      index={index}
      onIndexChange={(next) => {
        onChange?.(next);
        setIndex(next);
      }}
    />
  );
}

describe('PositionImageLightbox', () => {
  it('closes through Radix on Escape', () => {
    const onChange = vi.fn();
    mount(<Harness images={[image('a'), image('b')]} startIndex={0} onChange={onChange} />);
    expect(content()).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith(null);
    expect(content()).toBeNull();
  });

  it('moves and wraps with the arrow keys', () => {
    mount(<Harness images={[image('a'), image('b'), image('c')]} startIndex={2} />);
    expect(title()).toBe('Screenshot 3 of 3');

    press('ArrowRight'); // wraps 3 -> 1
    expect(title()).toBe('Screenshot 1 of 3');

    press('ArrowLeft'); // wraps 1 -> 3
    expect(title()).toBe('Screenshot 3 of 3');

    press('ArrowLeft'); // 3 -> 2
    expect(title()).toBe('Screenshot 2 of 3');
  });

  it('skips unavailable images when navigating', () => {
    mount(<Harness images={[image('a'), image('b', true), image('c')]} startIndex={0} />);
    expect(title()).toBe('Screenshot 1 of 3');

    press('ArrowRight'); // skips the unavailable index 1 -> 2
    expect(title()).toBe('Screenshot 3 of 3');

    press('ArrowRight'); // wraps back to 0 (index 1 still skipped)
    expect(title()).toBe('Screenshot 1 of 3');

    press('ArrowLeft'); // wraps to 2, again skipping index 1
    expect(title()).toBe('Screenshot 3 of 3');
  });
});

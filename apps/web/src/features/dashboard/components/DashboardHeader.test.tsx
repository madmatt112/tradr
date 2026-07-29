// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { DashboardHeader } from './DashboardHeader';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(): { container: HTMLElement; root: ReturnType<typeof createRoot> } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, root: createRoot(container) };
}

describe('DashboardHeader', () => {
  it('does not render the keyboard-reorder help affordance', () => {
    // It described a Tab → Space → arrows → Space flow that does not work.
    const { container, root } = mount();
    act(() => {
      root.render(<DashboardHeader placedTypes={[]} onAdd={() => undefined} />);
    });
    expect(container.querySelector('[data-slot="dashboard-keyboard-help"]')).toBeNull();
    expect(container.textContent).not.toContain('Keyboard reorder');
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('offers Reset layout only when a reset handler is supplied', () => {
    const { container, root } = mount();
    act(() => {
      root.render(<DashboardHeader placedTypes={[]} onAdd={() => undefined} />);
    });
    expect(container.querySelector('[data-slot="dashboard-reset-layout"]')).toBeNull();
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('confirms before resetting, and only fires on confirm', () => {
    const onResetLayout = vi.fn();
    const { container, root } = mount();
    act(() => {
      root.render(
        <DashboardHeader placedTypes={[]} onAdd={() => undefined} onResetLayout={onResetLayout} />,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-slot="dashboard-reset-layout"]',
    );
    expect(trigger).not.toBeNull();

    act(() => {
      trigger!.click();
    });
    // Opening the dialog must not itself reset anything.
    expect(onResetLayout).not.toHaveBeenCalled();

    // AlertDialog portals to the body, so query from there.
    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-slot="dashboard-reset-confirm"]',
    );
    expect(confirm).not.toBeNull();
    act(() => {
      confirm!.click();
    });
    expect(onResetLayout).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
